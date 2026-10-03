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