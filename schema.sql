-- Rotation database
create table if not exists public.albums (
  id text primary key,
  title text not null,
  artist text not null,
  release_date text,
  cover_url text,
  tracks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  album_id text not null references public.albums(id) on delete cascade,
  score int not null check (score between 1 and 10),
  standout_tracks text[] not null default '{}',
  thoughts text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, album_id)
);

alter table public.albums enable row level security;
alter table public.ratings enable row level security;

create policy "Albums are readable by everyone" on public.albums for select to anon, authenticated using (true);
create policy "Signed-in users can add albums" on public.albums for insert to authenticated with check (true);
create policy "Signed-in users can refresh albums" on public.albums for update to authenticated using (true) with check (true);

create policy "Users read their own ratings" on public.ratings for select to authenticated using (auth.uid() = user_id);
create policy "Users add their own ratings" on public.ratings for insert to authenticated with check (auth.uid() = user_id);
create policy "Users edit their own ratings" on public.ratings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users delete their own ratings" on public.ratings for delete to authenticated using (auth.uid() = user_id);

-- Community averages (scores only; thoughts stay private)
create or replace view public.album_stats as
select a.id as album_id, a.title, a.artist, a.cover_url, a.release_date,
       round(avg(r.score)::numeric, 1) as avg_score,
       count(r.id)::int as rating_count
from public.albums a
join public.ratings r on r.album_id = a.id
group by a.id;

grant select on public.album_stats to anon, authenticated;

-- v2: genres on albums (for genre links and recommendations)
alter table public.albums add column if not exists genres text[] not null default '{}';

-- v3: discovery (homepage Trending and Recently Reviewed). Run this in the Supabase SQL editor.
-- Like album_stats, these views expose aggregates and scores only. No user ids, no notes.
create index if not exists ratings_created_at_idx on public.ratings (created_at desc);
create index if not exists ratings_updated_at_idx on public.ratings (updated_at desc);

create or replace view public.album_activity as
select a.id as album_id, a.title, a.artist, a.cover_url, a.release_date,
       count(r.id)::int as recent_count,
       round(avg(r.score)::numeric, 1) as recent_avg
from public.albums a
join public.ratings r on r.album_id = a.id
where r.created_at >= now() - interval '7 days'
group by a.id;

create or replace view public.recent_ratings as
select r.id, r.album_id, a.title, a.artist, a.cover_url, r.score, r.updated_at as rated_at
from public.ratings r
join public.albums a on a.id = r.album_id
order by r.updated_at desc
limit 100;

grant select on public.album_activity, public.recent_ratings to anon, authenticated;
-- v4: album detail pages (run in the Supabase SQL editor)
-- Album facts, so artist links and the album type work from the cache.
alter table public.albums add column if not exists artist_id text;
alter table public.albums add column if not exists album_type text;

-- Reviews stay private unless the writer opts in. display_name is what they choose to show (never their email).
alter table public.ratings add column if not exists is_public boolean not null default false;
alter table public.ratings add column if not exists display_name text check (display_name is null or char_length(display_name) <= 40);

-- Save-to-library: albums a user wants to come back to, separate from rating them.
create table if not exists public.library (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  album_id text not null references public.albums(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, album_id)
);
create index if not exists library_user_created_idx on public.library (user_id, created_at desc);
alter table public.library enable row level security;
create policy "Users read their own library" on public.library for select to authenticated using (auth.uid() = user_id);
create policy "Users add to their own library" on public.library for insert to authenticated with check (auth.uid() = user_id);
create policy "Users remove from their own library" on public.library for delete to authenticated using (auth.uid() = user_id);

-- Rating distribution: counts per score only.
create or replace view public.album_score_counts as
select album_id, score, count(*)::int as n
from public.ratings
group by album_id, score;

-- Community reviews: only reviews whose writer chose to share them. No user ids; is_mine lets the page hide your own.
create or replace view public.album_reviews as
select r.id, r.album_id,
       coalesce(nullif(btrim(r.display_name), ''), 'Anonymous listener') as author,
       r.score, r.thoughts as body, r.standout_tracks, r.updated_at,
       (r.user_id = auth.uid()) as is_mine
from public.ratings r
where r.is_public and nullif(btrim(r.thoughts), '') is not null;

grant select on public.album_score_counts, public.album_reviews to anon, authenticated;
-- v5: reliable ratings, listening status, ranking and abuse protection (run in the Supabase SQL editor)

-- Listening status. Replaces the short-lived v4 "library" table (it was empty).
create table if not exists public.album_status (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  album_id text not null references public.albums(id) on delete cascade,
  listened boolean not null default false,
  want boolean not null default false,
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, album_id),
  check (not (listened and want)),          -- you can't both have heard it and want to hear it
  check (not favorite or listened)          -- a favorite has been listened to
);
create index if not exists album_status_user_idx on public.album_status (user_id, updated_at desc);
alter table public.album_status enable row level security;
create policy "Users read their own status" on public.album_status for select to authenticated using (auth.uid() = user_id);
create policy "Users add their own status" on public.album_status for insert to authenticated with check (auth.uid() = user_id);
create policy "Users edit their own status" on public.album_status for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users delete their own status" on public.album_status for delete to authenticated using (auth.uid() = user_id);

insert into public.album_status (user_id, album_id, want, created_at)
select user_id, album_id, true, created_at from public.library on conflict do nothing;
drop table if exists public.library;

-- Keep the states consistent no matter which client writes them.
create or replace function public.normalize_album_status() returns trigger language plpgsql as $$
begin
  if new.favorite then new.listened := true; end if;
  if exists (select 1 from public.ratings r where r.user_id = new.user_id and r.album_id = new.album_id) then new.listened := true; end if;
  if new.listened then new.want := false; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists album_status_normalize on public.album_status;
create trigger album_status_normalize before insert or update on public.album_status for each row execute function public.normalize_album_status();

-- Rating an album means you've listened to it.
create or replace function public.rating_marks_listened() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.album_status (user_id, album_id, listened) values (new.user_id, new.album_id, true)
  on conflict (user_id, album_id) do update set listened = true;
  return new;
end $$;
drop trigger if exists ratings_mark_listened on public.ratings;
create trigger ratings_mark_listened after insert on public.ratings for each row execute function public.rating_marks_listened();

insert into public.album_status (user_id, album_id, listened)
select user_id, album_id, true from public.ratings
on conflict (user_id, album_id) do update set listened = true;

-- Abuse guards on ratings: server-owned timestamps, a cap on new ratings per hour, a pause between edits to one album.
alter table public.ratings add constraint ratings_review_length check (char_length(coalesce(thoughts, '')) <= 2000);
alter table public.ratings add constraint ratings_standouts_size check (cardinality(standout_tracks) <= 200);
create or replace function public.guard_ratings() returns trigger language plpgsql as $$
declare recent int;
begin
  if tg_op = 'INSERT' then
    select count(*) into recent from public.ratings where user_id = new.user_id and created_at > now() - interval '1 hour';
    if recent >= 100 then raise exception 'Too many new ratings in the last hour. Try again later.'; end if;
    new.created_at := now();
  else
    if old.updated_at > now() - interval '300 milliseconds' then raise exception 'Slow down a little and try again.'; end if;
    new.user_id := old.user_id; new.album_id := old.album_id; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ratings_guard on public.ratings;
create trigger ratings_guard before insert or update on public.ratings for each row execute function public.guard_ratings();

-- Album rows are shared. Anyone signed in can add one, but nobody can overwrite facts that are already there.
alter table public.albums add constraint albums_id_is_mbid check (id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table public.albums add constraint albums_text_size check (char_length(title) between 1 and 300 and char_length(artist) between 1 and 300 and pg_column_size(tracks) <= 200000);
create or replace function public.protect_album_facts() returns trigger language plpgsql as $$
begin
  new.id := old.id; new.title := old.title; new.artist := old.artist; new.created_at := old.created_at;
  new.release_date := coalesce(old.release_date, new.release_date);
  new.cover_url := coalesce(old.cover_url, new.cover_url);
  new.artist_id := coalesce(old.artist_id, new.artist_id);
  new.album_type := coalesce(old.album_type, new.album_type);
  if jsonb_array_length(old.tracks) > 0 then new.tracks := old.tracks; end if;
  if coalesce(array_length(old.genres, 1), 0) > 0 then new.genres := old.genres; end if;
  return new;
end $$;
drop trigger if exists albums_protect on public.albums;
create trigger albums_protect before update on public.albums for each row execute function public.protect_album_facts();

-- Discovery ranking. weighted_score is a Bayesian average: albums with few ratings are pulled toward the overall mean
-- (prior strength 5). It is used only for ordering. The UI shows avg_score and rating_count unchanged.
create or replace view public.album_rankings as
with g as (select coalesce(avg(score), 7)::numeric as c from public.ratings),
s as (select album_id, avg(score)::numeric as avg_score, count(*)::int as rating_count from public.ratings group by album_id)
select a.id as album_id, a.title, a.artist, a.cover_url, a.release_date,
       round(s.avg_score, 1) as avg_score, s.rating_count,
       round((s.rating_count / (s.rating_count + 5.0)) * s.avg_score + (5.0 / (s.rating_count + 5.0)) * g.c, 2) as weighted_score
from s join public.albums a on a.id = s.album_id cross join g;
grant select on public.album_rankings to anon, authenticated;
-- v6: profiles, follows, pinned favorites and lists (run in the Supabase SQL editor)
-- Privacy model: base tables are readable only by their owner. Everything another person can see goes through the
-- public_* views below, which only return rows for profiles whose owner chose to make them public. No view exposes
-- an email address or auth user id.

alter table public.ratings add column if not exists credit_profile boolean not null default false;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create table if not exists public.profiles (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text,
  bio text,
  avatar_album_id text references public.albums(id) on delete set null,
  is_public boolean not null default false,       -- private until the owner opts in
  show_ratings boolean not null default true,     -- only matters when the profile is public
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'
    and username not in ('me','admin','rotation','support','root','null','undefined','api','settings','new','edit')),
  constraint profiles_display_name_len check (display_name is null or char_length(btrim(display_name)) between 1 and 40),
  constraint profiles_bio_len check (bio is null or char_length(bio) <= 280)
);
alter table public.profiles enable row level security;
create policy "Users read their own profile" on public.profiles for select to authenticated using (auth.uid() = user_id);
create policy "Users create their own profile" on public.profiles for insert to authenticated with check (auth.uid() = user_id);
create policy "Users edit their own profile" on public.profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users delete their own profile" on public.profiles for delete to authenticated using (auth.uid() = user_id);
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- Up to six pinned favorite albums.
create table if not exists public.profile_pins (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  album_id text not null references public.albums(id) on delete cascade,
  position int not null check (position between 1 and 6),
  created_at timestamptz not null default now(),
  primary key (user_id, album_id),
  unique (user_id, position) deferrable initially deferred
);
alter table public.profile_pins enable row level security;
create policy "Users manage their own pins" on public.profile_pins for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Follows are created only through follow_user(), which checks that the target profile is public.
create table if not exists public.follows (
  follower_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
alter table public.follows enable row level security;
create policy "Users see who they follow" on public.follows for select to authenticated using (auth.uid() = follower_id);
create policy "Users unfollow" on public.follows for delete to authenticated using (auth.uid() = follower_id);

create or replace function public.follow_user(p_username text) returns void language plpgsql security definer set search_path = public as $$
declare target uuid; n int;
begin
  if auth.uid() is null then raise exception 'Sign in to follow people.'; end if;
  select user_id into target from public.profiles where username = lower(p_username) and is_public;
  if target is null then raise exception 'That profile is not available.'; end if;
  if target = auth.uid() then raise exception 'You can''t follow yourself.'; end if;
  select count(*) into n from public.follows where follower_id = auth.uid();
  if n >= 1000 then raise exception 'You are following the maximum number of people.'; end if;
  insert into public.follows (follower_id, followee_id) values (auth.uid(), target) on conflict do nothing;
end $$;
create or replace function public.unfollow_user(p_username text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  delete from public.follows where follower_id = auth.uid()
    and followee_id = (select user_id from public.profiles where username = lower(p_username));
end $$;
create or replace function public.is_following(p_username text) returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.follows f join public.profiles p on p.user_id = f.followee_id
                 where f.follower_id = auth.uid() and p.username = lower(p_username));
$$;
revoke all on function public.follow_user(text), public.unfollow_user(text), public.is_following(text) from public, anon;
grant execute on function public.follow_user(text), public.unfollow_user(text), public.is_following(text) to authenticated;

-- Lists
create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lists_user_idx on public.lists (user_id, updated_at desc);
alter table public.lists enable row level security;
create policy "Users manage their own lists" on public.lists for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop trigger if exists lists_touch on public.lists;
create trigger lists_touch before update on public.lists for each row execute function public.touch_updated_at();
create or replace function public.guard_lists() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.lists where user_id = new.user_id) >= 50 then raise exception 'You can have up to 50 lists.'; end if;
  return new;
end $$;
drop trigger if exists lists_guard on public.lists;
create trigger lists_guard before insert on public.lists for each row execute function public.guard_lists();

create table if not exists public.list_items (
  list_id uuid not null references public.lists(id) on delete cascade,
  album_id text not null references public.albums(id) on delete cascade,
  position int not null,
  added_at timestamptz not null default now(),
  primary key (list_id, album_id)
);
alter table public.list_items enable row level security;
create policy "Users manage items in their own lists" on public.list_items for all to authenticated
  using (exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid()))
  with check (exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid()));
create or replace function public.guard_list_items() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.list_items where list_id = new.list_id) >= 200 then raise exception 'A list can hold up to 200 albums.'; end if;
  if new.position is null then
    select coalesce(max(position), 0) + 1 into new.position from public.list_items where list_id = new.list_id;
  end if;
  return new;
end $$;
drop trigger if exists list_items_guard on public.list_items;
create trigger list_items_guard before insert on public.list_items for each row execute function public.guard_list_items();

-- Public views (profile must be public). Usernames identify people; user ids and emails are never exposed.
create or replace view public.public_profiles as
select p.username, p.display_name, p.bio, p.show_ratings, p.created_at, p.avatar_album_id, av.cover_url as avatar_cover,
  (select count(*) from public.follows f where f.followee_id = p.user_id)::int as followers,
  (select count(*) from public.follows f where f.follower_id = p.user_id)::int as following,
  case when p.show_ratings then (select count(*) from public.ratings r where r.user_id = p.user_id)::int end as rating_count,
  case when p.show_ratings then (select round(avg(r.score), 1) from public.ratings r where r.user_id = p.user_id) end as avg_score,
  (select count(*) from public.ratings r where r.user_id = p.user_id and r.credit_profile and r.is_public and nullif(btrim(r.thoughts), '') is not null)::int as review_count
from public.profiles p left join public.albums av on av.id = p.avatar_album_id
where p.is_public;

create or replace view public.public_pins as
select p.username, n.position, a.id as album_id, a.title, a.artist, a.cover_url
from public.profile_pins n join public.profiles p on p.user_id = n.user_id and p.is_public join public.albums a on a.id = n.album_id;

create or replace view public.public_ratings as
select p.username, a.id as album_id, a.title, a.artist, a.cover_url, a.genres, r.score, r.updated_at as rated_at,
  (r.credit_profile and r.is_public and nullif(btrim(r.thoughts), '') is not null) as has_review
from public.ratings r join public.profiles p on p.user_id = r.user_id and p.is_public and p.show_ratings join public.albums a on a.id = r.album_id;

create or replace view public.public_reviews as
select p.username, a.id as album_id, a.title, a.artist, a.cover_url,
  case when p.show_ratings then r.score end as score, r.thoughts as body, r.updated_at
from public.ratings r join public.profiles p on p.user_id = r.user_id and p.is_public join public.albums a on a.id = r.album_id
where r.credit_profile and r.is_public and nullif(btrim(r.thoughts), '') is not null;

create or replace view public.public_lists as
select l.id, p.username, l.title, l.description, l.created_at, l.updated_at,
  (select count(*) from public.list_items i where i.list_id = l.id)::int as item_count,
  (select array_agg(a.cover_url order by i.position) from (select album_id, position from public.list_items where list_id = l.id order by position limit 4) i
     join public.albums a on a.id = i.album_id) as covers
from public.lists l join public.profiles p on p.user_id = l.user_id and p.is_public where l.is_public;

create or replace view public.public_list_items as
select i.list_id, i.position, p.username, a.id as album_id, a.title, a.artist, a.cover_url
from public.list_items i join public.lists l on l.id = i.list_id and l.is_public
join public.profiles p on p.user_id = l.user_id and p.is_public join public.albums a on a.id = i.album_id;

-- Shared reviews: credited to a profile only when the writer ticked "Credit this review to my profile".
create or replace view public.album_reviews as
select r.id, r.album_id,
       case when r.credit_profile and p.is_public then coalesce(nullif(btrim(p.display_name), ''), p.username)
            else coalesce(nullif(btrim(r.display_name), ''), 'Anonymous listener') end as author,
       r.score, r.thoughts as body, r.standout_tracks, r.updated_at,
       (r.user_id = auth.uid()) as is_mine,
       case when r.credit_profile and p.is_public then p.username end as author_username
from public.ratings r left join public.profiles p on p.user_id = r.user_id
where r.is_public and nullif(btrim(r.thoughts), '') is not null;

grant select on public.public_profiles, public.public_pins, public.public_ratings, public.public_reviews,
  public.public_lists, public.public_list_items, public.album_reviews to anon, authenticated;
-- v7: social layer (run in the Supabase SQL editor)
-- Activity feed, review likes, reports with auto-hide, and notifications with preferences.
-- Everything people can see about other people still passes the same public-profile rules as v6.
-- Comments are deliberately not included: they need a moderation queue and filtering first.

create table if not exists public.review_likes (
  rating_id uuid not null references public.ratings(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (rating_id, user_id)
);
create index if not exists review_likes_user_idx on public.review_likes (user_id, created_at desc);
alter table public.review_likes enable row level security;
create policy "Users see their own likes" on public.review_likes for select to authenticated using (auth.uid() = user_id);
-- likes are written only by toggle_review_like()

-- Reports. Nobody reads this table through the API: review it in the Supabase dashboard
-- (set status to 'dismissed' to restore hidden content, 'actioned' once handled).
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('review', 'list', 'profile')),
  target_id text not null,
  reason text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);
create index if not exists reports_target_idx on public.reports (target_type, target_id, status);
alter table public.reports enable row level security;

-- Content with 3 or more open reports from different people is hidden from public views until reviewed.
-- Lives in a schema the API does not expose. Views run functions as the caller, so anon and authenticated need execute here.
create schema if not exists private;
grant usage on schema private to anon, authenticated;
create or replace function private.report_count(p_type text, p_id text) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.reports where target_type = p_type and target_id = p_id and status = 'open';
$$;
revoke all on function private.report_count(text, text) from public;
grant execute on function private.report_count(text, text) to anon, authenticated;

create table if not exists public.notification_prefs (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  follows boolean not null default true,   -- someone started following you
  likes boolean not null default true,     -- people liked your review (grouped: one notification per review)
  updated_at timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
create policy "Users manage their own notification prefs" on public.notification_prefs for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Notifications are written only by the functions below and read through my_notifications.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('follow', 'like')),
  actor_id uuid references auth.users(id) on delete cascade,
  rating_id uuid references public.ratings(id) on delete cascade,
  album_id text,
  album_title text,
  total int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  read_at timestamptz
);
create unique index if not exists notifications_like_uidx on public.notifications (user_id, rating_id) where kind = 'like';
create unique index if not exists notifications_follow_uidx on public.notifications (user_id, actor_id) where kind = 'follow';
create index if not exists notifications_user_idx on public.notifications (user_id, updated_at desc);
alter table public.notifications enable row level security;

create or replace view public.my_notifications as
select n.id, n.kind, n.total, n.album_id, n.album_title, n.created_at, n.updated_at, n.read_at, p.username as actor_username
from public.notifications n left join public.profiles p on p.user_id = n.actor_id and p.is_public
where n.user_id = auth.uid();
grant select on public.my_notifications to authenticated;

create or replace function public.mark_notifications_read() returns void language sql security definer set search_path = public as $$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null;
$$;

-- Following now also creates one (never repeated) notification, if the person wants those.
create or replace function public.follow_user(p_username text) returns void language plpgsql security definer set search_path = public as $$
declare target uuid; n int; m int;
begin
  if auth.uid() is null then raise exception 'Sign in to follow people.'; end if;
  select user_id into target from public.profiles where username = lower(p_username) and is_public;
  if target is null then raise exception 'That profile is not available.'; end if;
  if target = auth.uid() then raise exception 'You can''t follow yourself.'; end if;
  select count(*) into n from public.follows where follower_id = auth.uid();
  if n >= 1000 then raise exception 'You are following the maximum number of people.'; end if;
  insert into public.follows (follower_id, followee_id) values (auth.uid(), target) on conflict do nothing;
  get diagnostics m = row_count;
  if m > 0 and coalesce((select follows from public.notification_prefs where user_id = target), true) then
    insert into public.notifications (user_id, kind, actor_id) values (target, 'follow', auth.uid())
    on conflict (user_id, actor_id) where kind = 'follow' do nothing;
  end if;
end $$;

-- Like or unlike a public review. One notification per review, updated with the running total.
create or replace function public.toggle_review_like(p_rating uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; had boolean; total int;
begin
  if auth.uid() is null then raise exception 'Sign in to like reviews.'; end if;
  select id, user_id, album_id into r from public.ratings
   where id = p_rating and is_public and nullif(btrim(thoughts), '') is not null and private.report_count('review', id::text) < 3;
  if r.id is null then raise exception 'That review is not available.'; end if;
  if r.user_id = auth.uid() then raise exception 'You can''t like your own review.'; end if;
  delete from public.review_likes where rating_id = p_rating and user_id = auth.uid() returning true into had;
  if had is null then
    if (select count(*) from public.review_likes where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 200 then
      raise exception 'Slow down a little and try again.';
    end if;
    insert into public.review_likes (rating_id, user_id) values (p_rating, auth.uid());
    select count(*)::int into total from public.review_likes where rating_id = p_rating;
    if coalesce((select likes from public.notification_prefs where user_id = r.user_id), true) then
      insert into public.notifications (user_id, kind, rating_id, album_id, album_title, total)
      select r.user_id, 'like', p_rating, a.id, a.title, total from public.albums a where a.id = r.album_id
      on conflict (user_id, rating_id) where kind = 'like' do update
        set total = excluded.total, updated_at = now(),
            read_at = case when excluded.total > public.notifications.total then null else public.notifications.read_at end;
    end if;
  end if;
  return jsonb_build_object('liked', had is null, 'count', (select count(*)::int from public.review_likes where rating_id = p_rating));
end $$;

create or replace function public.report_content(p_type text, p_id text, p_reason text, p_details text default null) returns void language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to report content.'; end if;
  if p_reason not in ('spam', 'harassment', 'inappropriate', 'other') then raise exception 'Pick a reason.'; end if;
  if p_type = 'review' then
    select user_id into owner from public.ratings where id::text = p_id and is_public and nullif(btrim(thoughts), '') is not null;
  elsif p_type = 'list' then
    select user_id into owner from public.lists where id::text = p_id and is_public;
  elsif p_type = 'profile' then
    select user_id into owner from public.profiles where username = lower(p_id) and is_public;
  else raise exception 'Unknown content type.'; end if;
  if owner is null then raise exception 'That content is not available.'; end if;
  if owner = auth.uid() then raise exception 'You can''t report your own content.'; end if;
  if (select count(*) from public.reports where reporter_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'You''ve reached today''s report limit.';
  end if;
  insert into public.reports (reporter_id, target_type, target_id, reason, details)
  values (auth.uid(), p_type, case when p_type = 'profile' then lower(p_id) else p_id end, p_reason, nullif(btrim(p_details), ''))
  on conflict (reporter_id, target_type, target_id) do nothing;
end $$;

-- Activity from people you follow, newest first, paged with a (time, key) cursor. Only public profiles appear.
-- Ratings need show_ratings; reviews need the writer to have credited them to their profile; favorites are the pinned albums.
create or replace function public.get_feed(p_ts timestamptz default null, p_key text default null, p_limit int default 20)
returns table (kind text, event_key text, happened_at timestamptz, actor_username text, actor_name text, actor_avatar text,
  album_id text, album_title text, album_artist text, cover_url text, score int, body text, rating_id uuid,
  list_id uuid, list_title text, list_count int, covers text[])
language sql stable security definer set search_path = public as $$
  with actors as (
    select p.user_id, p.username, coalesce(nullif(btrim(p.display_name), ''), p.username) as name, av.cover_url as avatar, p.show_ratings
    from public.profiles p join public.follows f on f.followee_id = p.user_id and f.follower_id = auth.uid()
    left join public.albums av on av.id = p.avatar_album_id
    where p.is_public
  ), raw as (
    select (case when x.rev then 'review' else 'rating' end)::text as kind, ('r:' || r.id::text)::text as event_key,
           (case when x.rev then r.updated_at else r.created_at end) as happened_at,
           a.username, a.name, a.avatar, al.id as album_id, al.title as album_title, al.artist as album_artist, al.cover_url,
           (case when a.show_ratings then r.score end)::int as score, (case when x.rev then r.thoughts end) as body,
           (case when x.rev then r.id end) as rating_id,
           null::uuid as list_id, null::text as list_title, null::int as list_count, null::text[] as covers
    from public.ratings r join actors a on a.user_id = r.user_id join public.albums al on al.id = r.album_id
    cross join lateral (select (r.credit_profile and r.is_public and nullif(btrim(r.thoughts), '') is not null and private.report_count('review', r.id::text) < 3) as rev) x
    where a.show_ratings or x.rev
    union all
    select 'list', 'l:' || l.id::text, l.created_at, a.username, a.name, a.avatar, null, null, null, null, null::int, l.description, null::uuid,
           l.id, l.title,
           (select count(*)::int from public.list_items i where i.list_id = l.id),
           (select array_agg(al.cover_url order by i.position) from (select album_id, position from public.list_items where list_id = l.id order by position limit 4) i join public.albums al on al.id = i.album_id)
    from public.lists l join actors a on a.user_id = l.user_id
    where l.is_public and private.report_count('list', l.id::text) < 3 and exists (select 1 from public.list_items i where i.list_id = l.id)
    union all
    select 'pin', 'p:' || n.user_id::text || ':' || n.album_id, n.created_at, a.username, a.name, a.avatar, al.id, al.title, al.artist, al.cover_url, null::int, null, null::uuid,
           null::uuid, null, null::int, null::text[]
    from public.profile_pins n join actors a on a.user_id = n.user_id join public.albums al on al.id = n.album_id
  )
  select * from raw
  where p_ts is null or (raw.happened_at, raw.event_key) < (p_ts, coalesce(p_key, 'zzzz'))
  order by raw.happened_at desc, raw.event_key desc
  limit least(greatest(p_limit, 1), 50);
$$;

revoke all on function public.follow_user(text), public.toggle_review_like(uuid), public.report_content(text, text, text, text),
  public.get_feed(timestamptz, text, int), public.mark_notifications_read() from public, anon;
grant execute on function public.follow_user(text), public.toggle_review_like(uuid), public.report_content(text, text, text, text),
  public.get_feed(timestamptz, text, int), public.mark_notifications_read() to authenticated;

-- Reviews now carry like counts and hide once reported. New columns go at the end of each view.
create or replace view public.album_reviews as
select r.id, r.album_id,
       case when r.credit_profile and p.is_public then coalesce(nullif(btrim(p.display_name), ''), p.username)
            else coalesce(nullif(btrim(r.display_name), ''), 'Anonymous listener') end as author,
       r.score, r.thoughts as body, r.standout_tracks, r.updated_at,
       (r.user_id = auth.uid()) as is_mine,
       case when r.credit_profile and p.is_public then p.username end as author_username,
       (select count(*) from public.review_likes l where l.rating_id = r.id)::int as like_count,
       exists (select 1 from public.review_likes l where l.rating_id = r.id and l.user_id = auth.uid()) as liked_by_me
from public.ratings r left join public.profiles p on p.user_id = r.user_id
where r.is_public and nullif(btrim(r.thoughts), '') is not null and private.report_count('review', r.id::text) < 3;

create or replace view public.public_reviews as
select p.username, a.id as album_id, a.title, a.artist, a.cover_url,
  case when p.show_ratings then r.score end as score, r.thoughts as body, r.updated_at
from public.ratings r join public.profiles p on p.user_id = r.user_id and p.is_public join public.albums a on a.id = r.album_id
where r.credit_profile and r.is_public and nullif(btrim(r.thoughts), '') is not null and private.report_count('review', r.id::text) < 3;

create or replace view public.public_lists as
select l.id, p.username, l.title, l.description, l.created_at, l.updated_at,
  (select count(*) from public.list_items i where i.list_id = l.id)::int as item_count,
  (select array_agg(a.cover_url order by i.position) from (select album_id, position from public.list_items where list_id = l.id order by position limit 4) i
     join public.albums a on a.id = i.album_id) as covers
from public.lists l join public.profiles p on p.user_id = l.user_id and p.is_public
where l.is_public and private.report_count('list', l.id::text) < 3;

create or replace view public.public_list_items as
select i.list_id, i.position, p.username, a.id as album_id, a.title, a.artist, a.cover_url
from public.list_items i join public.lists l on l.id = i.list_id and l.is_public and private.report_count('list', l.id::text) < 3
join public.profiles p on p.user_id = l.user_id and p.is_public join public.albums a on a.id = i.album_id;

grant select on public.album_reviews, public.public_reviews, public.public_lists, public.public_list_items to anon, authenticated;