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
- Profiles (schema v6): `#/u/<username>` public profile, `#/me/edit` create/edit, `#/me` is the private shelf/history, `#/list/<uuid>` lists.
  PRIVACY RULE: base tables (profiles, profile_pins, follows, lists, list_items, ratings, album_status) are owner-only via RLS.
  Anything another person sees must come from a `public_*` view, which only returns rows for profiles with `is_public`.
  Never add user_id or email to a public view. Profiles start private; ratings can be hidden with `show_ratings`; a shared review
  appears on a profile only if the writer ticked "credit to profile" (`ratings.credit_profile`). Follow/unfollow go through RPCs only.
  Avatars are the cover of a chosen pinned album (or an initial); there is no file upload.
- Social (schema v7): `#/feed` (RPC `get_feed`, keyset paged by (time, key), only public profiles you follow), `#/notifications`.
  Review likes go through `toggle_review_like`, reports through `report_content`, notifications through `my_notifications` + `mark_notifications_read`.
  Notify only on new followers and likes (grouped per review), both switchable in `notification_prefs`. No comments yet: they need moderation tooling first.
  MODERATION: reports are not readable through the API. Review them in the Supabase dashboard (table `reports`); a review or list with 3+ open reports
  is hidden from public views and the feed until you set those reports to `dismissed` (restore) or `actioned`.
  Gotcha: views call functions as the CALLER, so any function used inside a public view needs EXECUTE for anon. `report_count` lives in the
  unexposed `private` schema for that reason (so it isn't callable as an RPC). Don't move it back to `public`.
- Discovery (schema v8): `album_catalog` view feeds `#/browse` (genre, decade, year range, min average, min rating count, album type, sort),
  Hidden gems (3-20 ratings averaging 8+), and Divisive albums (10+ ratings, sd >= 2.5, 20%+ at 8+ AND 20%+ at 4 or lower; same rule in `spreadNote`).
  Every home section carries a source badge: "Community ranking" (calculated), "Billboard chart", or "Editorial picks" (hand-picked decade landmarks).
  Never mix those up; editorial lists must not be presented as rankings.
  `#/surprise` draws from Rotation's catalog + this week's charts + a random MusicBrainz page, excluding anything you rated/saved/listed/pinned and
  anything already shown this session. MusicBrainz returns HTTP 400 if a search's offset + limit passes 500 (`MB_WINDOW`) and 503s on bursts (`getJSON` retries once; `mbSlow` throttles).
  Search (`#/search/<term>?type=&from=&to=&genre=&artist=`) escapes Lucene input and dedupes identical title+artist release groups.
  Related albums on the album page always say why: same artist, shared genres (names shown), or listeners who rated both 8+ (`related_by_ratings`, 3+ people).
- Pure logic lives in `lib.js` (taste comparison, yearly recap, recommendation merging) with unit tests in `tests/index.html`
  (open it through any static server; it prints PASS/FAIL per test). Add tests there when changing lib.js.
- Taste comparison (`#/compare/<user>`) needs 10+ shared ratings before any similarity % is shown; genre overlap needs 8+ rated albums with genres each.
- Year in Rotation (`#/year/<y>`, `#/u/<name>/year/<y>`) uses `first_rated_at` (not edit time), only real ratings, and says it is not listening time.
  The PNG export is drawn on a canvas as text and charts only: album artwork is never copied into exported files (rights holders' artwork).
- Stats dashboard (`#/stats`, `renderStats`; linked from the account menu and the shelf header): listening-diary heatmap (12 months, counted by `first_rated_at`,
  never called listening time), decades (from `albums.release_date`), top-5 genre donut, top 3 artists of the current year, and "You might like" (same `buildRecs`
  engine and sessionStorage cache as the home page). Pure logic is `RL.statsOf` / `heatmapOf` / `heatLevel` (tested). Charts are hand-rolled SVG/CSS: no chart library,
  no React/Tailwind (the app has no build step). `#/stats/sample` is a clearly labeled demo built from fake rows (`sampleRows`, `SAMPLE_RECS`); it is the only place
  made-up data may appear, and the page must say so. Signed-out visitors to `#/stats` see the sample.
- Recommendations (`buildRecs`): explainable rules (similar listeners, artists, genres, charts), never includes rated albums; under 3 ratings it shows
  general discovery labeled as such. `recs_from_similar_listeners` (schema v9) returns aggregates only, needs 2+ similar listeners.
- Quality rules: every page gets a title + description via `setPageMeta` (hash URLs mean non-script crawlers only see index.html defaults; real SEO
  would need path routing plus server-rendered pages, a bigger change), a top-level h1 (a MutationObserver adds a hidden one when missing), and an
  error boundary (`route` wraps `routeInner`). Touch targets are at least 44px on touch devices. The album page stacks below 960px.
- Sources and rights: MusicBrainz metadata is CC0. Cover art is hot-linked from the Cover Art Archive and Apple for identification only, never downloaded,
  re-hosted or put into exported images. Apple's Search API terms limit artwork to promoting Apple store content, so treat Apple art as the riskiest
  source; Billboard genre charts are read from billboard.com pages, which may not be permitted by Billboard's terms. Both are flagged for the owner to decide.
- Apple artwork can be switched off: `APPLE_ART: false` in config.js and env var `APPLE_ART=off` in Vercel (api/chart.js); art then comes from the Cover Art Archive.
  `vercel.json` sets basic security headers (no CSP yet: the app uses inline `onerror` handlers, so a strict CSP would need those moved first).
- Password reset: Forgot password sends a Supabase reset email (`resetPasswordForEmail`, redirect = this site); the PASSWORD_RECOVERY event opens `openRecovery`.
  The Supabase dashboard (Authentication > URL Configuration) must list the live site as Site URL / redirect URL or the email link points elsewhere.
- Your data (`#/me/edit`): Download my data (client-side JSON of the person's own rows) and Delete my account (`api/delete-account.js`: verifies the caller's token with Supabase,\r\n  then deletes only that user via the admin API; cascading foreign keys remove their data). Needs `SUPABASE_SERVICE_ROLE_KEY` in Vercel env vars only; never commit it.
- See `tests/README.md` for the unit, database, API-security and manual test layers and which of the 12 flows have actually been run.
- Library (`#/me`): `LIB_VIEWS` (All rated, Recently rated, Highest, Lowest, Favorites, Want to listen, Listened, With notes) x `LIB_SORTS`
  (date, rating, artist, title, release year; missing values always sort last; rating sorts hidden for Want to listen) + title/artist filter.
  Public lists are browsed at `#/lists/browse` from the `public_lists` view; list cards come from `listTile` (adaptive cover collage).
- Rating scale: whole scores 1-10 (not stars); this is the established convention (DB check, charts, recommendations all use it).
  Tapping a score saves immediately (score only, so reviews are never clobbered); the review/standouts have their own Save.
  Never put `updated_at` in client writes; triggers own timestamps. Duplicates are impossible (unique user_id+album_id upsert).
- Listening status lives in `album_status` (listened / want / favorite). Rated implies listened, favorite implies listened,
  listened and want are exclusive. Enforced by checks + triggers in the DB (schema v5), mirrored in `applyStatus`.
- Ranking: `album_rankings.weighted_score` (Bayesian average, prior strength 5) only orders Highest rated / Top rated lists
  (3+ ratings). The UI always shows the plain average and the count. Never display the weighted score.
- Abuse guards (v5): 100 new ratings/hour/user, 300ms between edits of one rating, review length cap, album facts can't be overwritten.
- Album page layout (editorial redesign): `.ahero` header (sleeve = cover + `vinyl` record peeking out, big serif title, ruled `.figures` for community/your score),
  then `.album-body` (main column + sticky community aside; stacks below 960px). Classes are `.ahero*`, NOT `.hero*` (that is the home page).
  The blurred cover backdrop (`.ahero__bg`, fixed, masked, fades on scroll) is a deliberate, scoped exception to "no gradients"; don't reuse it elsewhere.
  Element ids (#yourRating, #picker, #save, #communityBody, #heroFigures, ...) are relied on by `tests/client-flows.js`; keep them.
- Album page (`renderAlbum`): community rating + distribution (`album_score_counts`) are shown apart from "Your rating".
  Reviews are private by default; a writer opts in with "Share this review" and it appears via view `album_reviews`
  (author is a chosen display name, never the email). Save-to-library uses table `library` (own rows only), listed on the profile "Saved" tab.
  Schema v4 added `albums.artist_id/album_type`, `ratings.is_public/display_name`. Missing metadata is omitted, never invented.
  Links are hash URLs (`#/album/<musicbrainz id>`), so direct opens and refreshes work; the Share button copies/shares `location.href`.
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
