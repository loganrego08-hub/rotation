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