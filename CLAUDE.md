# Rotation

Album rating app: score albums 1-10, star standout tracks, private notes, community averages.
Live: https://rotation-ten.vercel.app (Vercel auto-deploys every push to `main`).

## Stack
- Static front end, no build step: `index.html`, `styles.css`, `app.js` (vanilla JS, hash router).
- `config.js`: Supabase URL + publishable key (public by design; never put a secret key here).
- `api/chart.js`: Vercel serverless function. Billboard charts as JSON, cached 6h at the edge.
  Billboard 200 from github.com/utdata/rwd-billboard-data; genre charts read from billboard.com.
  Cover art from Apple (iTunes RSS + Search), Billboard thumbnail as fallback.
  `api/billboard.js` is legacy; the app uses `api/chart.js`.
- Supabase: tables `albums`, `ratings` (RLS: users only see their own ratings), view `album_stats`
  (community averages). Schema in `schema.sql`. Email confirmation is off.
- MusicBrainz for search, album pages, tracklists, artist pages (1 req/sec limit; see `mbSlow`).
  Cover Art Archive for MusicBrainz covers (slow but reliable).

## Routes and discovery
- Hash routes: `#/` Discover, `#/explore`, `#/genre/:slug`, `#/decade/:start`, `#/lists/:tab` (charts, community, mine),
  `#/search/:term`, `#/me`, `#/album/:mbid`, `#/artist/:mbid`. Main nav is Discover, Explore, Lists, Search; phones get a bottom tab bar.
- Home sections are built with `homeSection` + `runSection` (lazy-loaded below the fold). Each loader returns real data only:
  community stats from Supabase, else a clearly labeled Billboard fallback. Never invent community activity.
- `MIN_RATINGS` (3) gates "Highest rated"; "Under the radar" is 8+ with fewer than that.
- `schema.sql` v3 adds views `album_activity` (7-day counts) and `recent_ratings` (scores only, no notes or user ids).
  The app treats missing views as empty, so run v3 in the Supabase SQL editor to switch Trending and Recently Reviewed to live data.
- Decade pages mix community-rated albums with a curated `DECADES` seed list (artwork via Apple, then Cover Art Archive).

## Design system (styles.css)
- All values come from tokens in `:root`. Use tokens, never hard-coded colors or sizes.
- Dark charcoal UI (#171717). Album artwork is the color; lime accent (#B9F36B) only for the
  user's own actions and scores. Status colors always paired with an icon or label.
- Type: Newsreader (display serif) + Geist (UI). Keep headings restrained.
- No gradients, glassmorphism, heavy shadows or neon. Respect reduced motion.
- Components are HTML-string helpers in app.js: albumCard, artistCard, listCard, reviewCard,
  profileHeader, emptyState, errorState, skCards/skList, toast, tabs, button, scoreChip.
  Reuse them instead of writing new markup.
- Artwork is always square (`.art`, aspect-ratio 1, object-fit cover).

## Content rules
- Curated shelves (charts, recommendations) filter kids, sleep, karaoke, tribute and AI-filler
  albums via `keep()`. Search and rating still allow everything.
- Recommendations come only from Billboard charts matched to genres the user rates 7+.

## Working conventions
- Check mobile (390px wide) as well as desktop for any UI change; no horizontal page scroll.
- Grid children need `min-width: 0` / `minmax(0, 1fr)` to avoid overflow.
- Commit with a short descriptive message and push to `main` to deploy.
- Hobby (free) Vercel plan: personal, non-commercial use only.
