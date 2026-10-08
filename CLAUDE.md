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
- Home layout: hero (headline, search, genre tags) with a crate of the top three Billboard covers and a mono caption (#mosaic, real chart week; the community line shows only past `HERO_STAT_MIN_RATINGS`);
  then the lead feature (loadLead: Billboard #1 with its real movement/weeks/peak, and your own score in vermilion if you've rated it); `Highest rated` is a chart sheet
  (sheetHTML: big #1 cover beside six ranked rows, no cover in the Billboard fallback because the lead already shows #1); `Hidden gems` is a rail with larger covers (`row--big`);
  genres and decades are typographic indexes (`genreIndex`, `decadeIndex`). Chart-sheet rows are scoped to `.grid > .album-card__ranked` so rails keep normal ranked cards.
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
- Search (`#/search/<term>?type=&from=&to=&genre=&artist=`): candidates come from `api/search.js` (MusicBrainz with a real User-Agent, queued 1.1 s apart, edge-cached 1 h),
  plus Rotation's own albums via RPC `search_albums` (schema v10: pg_trgm + unaccent + `albums.search_text` trigram index; missing RPC = no extra hits).
  Ranking is `RL.rankAlbums` in lib.js: text match (exact > prefix > all words > word prefix > typo), Rotation ratings, Billboard-200 presence, MusicBrainz edition/tag counts,
  release type, noise/obscurity penalties, duplicate collapse (same artist + base title + kind). ALL weights live in `RL.SEARCH_WEIGHTS`; change them there and run tests/index.html.
  Every typed word must be in the artist OR the title (`searchPlan`), so "artist album" works in either order; a fuzzy retry runs on weak results and a tagged-albums sweep runs when
  nothing established matches ("dark side"). The browser falls back to calling MusicBrainz directly if `/api/search` is down. The type filter is remembered in localStorage but the URL always carries it.
  Autocomplete is an ARIA combobox on every search box; "/" opens an overlay on pages without one. Don't show raw MusicBrainz match counts (they are fuzzy noise).
- Stats dashboard (`#/stats`, `renderStats`; linked from the account menu and the shelf header): listening-diary heatmap (12 months, counted by `first_rated_at`,
  never called listening time), decades (from `albums.release_date`), top-5 genre donut, top 3 artists of the current year, and "You might like" (same `buildRecs`
  engine and sessionStorage cache as the home page). Pure logic is `RL.statsOf` / `heatmapOf` / `heatLevel` (tested). Charts are hand-rolled SVG/CSS: no chart library,
  no React/Tailwind (the app has no build step). `#/stats/sample` is a clearly labeled demo built from fake rows (`sampleRows`, `SAMPLE_RECS`); it is the only place
  made-up data may appear, and the page must say so. Signed-out visitors to `#/stats` see the sample.
- Recommendations (`buildRecs` + `mergeRecLists` + `getRecs`, shared by the home page and the stats page; cache key `recs7:`): explainable rules interleaved round-robin: similar listeners (schema v9 `recs_from_similar_listeners`, aggregates only, 2+ people),
  Rotation-catalog albums by artists you rate highly, the best-known albums by those artists from MusicBrainz (`recsFromDiscographies`, artists interleaved, ranked by popularity), community albums in your genres, and this week's Billboard genre charts.
  Never includes rated albums. Taste is strict (2+ albums per genre, artists averaging 8+) and relaxes (1 album, 7+) only when strict finds nothing (`RL.tasteProfile` options). A row under `REC_FULL` picks is topped up with labeled NOT-personalized
  picks (community favorites, then the Billboard 200) and the note under the heading says so; with zero personalized picks it says nothing matched yet. The row shows quickly from the fast sources, then grows when MusicBrainz answers. Under 3 ratings: general discovery, labeled.
- Quality rules: every page gets a title + description via `setPageMeta` (hash URLs mean non-script crawlers only see index.html defaults; real SEO
  would need path routing plus server-rendered pages, a bigger change), a top-level h1 (a MutationObserver adds a hidden one when missing), and an
  error boundary (`route` wraps `routeInner`). Touch targets are at least 44px on touch devices. The album page stacks below 960px.
- Sources and rights: MusicBrainz metadata is CC0. Cover art is hot-linked from the Cover Art Archive and Apple for identification only, never downloaded,
  re-hosted or put into exported images. Apple's Search API terms limit artwork to promoting Apple store content, so treat Apple art as the riskiest
  source; Billboard genre charts are read from billboard.com pages, which may not be permitted by Billboard's terms. Both are flagged for the owner to decide.
- Streaming service (Listen): each person picks a service (Settings at `#/settings`, the sign-up form, or the prompt when they first tap Listen). It is saved in Supabase auth user metadata (`streaming_service`,
  no migration, works without a profile) and in localStorage `rotation:streaming` for signed-out visitors; the account's choice wins after sign-in, else the device's choice is uploaded (`syncStreamPref`).
  The album page has a `Listen` button (inked, not vermilion) and a play icon on every song (`.track__listen`). Links start as the service's search page (always correct) and are upgraded to direct album/song links by
  `api/listen.js`: Apple via the public iTunes lookup, Deezer via its public API, any service via the streaming links stored on the release in MusicBrainz, and Spotify via its Web API only if `SPOTIFY_CLIENT_ID` and
  `SPOTIFY_CLIENT_SECRET` are set in Vercel. Odesli/song.link was tried and now needs an API key. Service list, search URLs and name matching live in lib.js (`STREAMING_SERVICES`, tested). Don't use `data-t` on listen links (it's the star hook).
- Chart covers: `api/chart.js` matches Apple art by artist AND title (`sameArtist`/`sameTitle`; never "any album by this artist", which once put a single's cover on American Heartbreak). No confident match = no art.
  The app then fills the gap itself (`healCovers`/`resolveCover` in app.js): any card linking to `#/find/artist/title` with no picture is looked up on MusicBrainz + Cover Art Archive,
  the same source as the album page, one request at a time, remembered per session. Chart responses are edge-cached (6 h, plus a day while revalidating), so fixes to matching take up to that long to show.
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
- Album page layout: `.ahero` header (sleeve = cover + `vinyl` record peeking out, big Fraunces title, `.figures` = record-label stamps for community/your score),
  then `.album-body` (main column + sticky community aside; stacks below 960px). Classes are `.ahero*`, NOT `.hero*` (that is the home page).
  Element ids (#yourRating, #picker, #save, #communityBody, #heroFigures, ...) are relied on by `tests/client-flows.js`; keep them.
- Album page (`renderAlbum`): community rating + distribution (`album_score_counts`) are shown apart from "Your rating".
  Reviews are private by default; a writer opts in with "Share this review" and it appears via view `album_reviews`
  (author is a chosen display name, never the email). Save-to-library uses table `library` (own rows only), listed on the profile "Saved" tab.
  Schema v4 added `albums.artist_id/album_type`, `ratings.is_public/display_name`. Missing metadata is omitted, never invented.
  Links are hash URLs (`#/album/<musicbrainz id>`), so direct opens and refreshes work; the Share button copies/shares `location.href`.
- Decade pages mix community-rated albums with a curated `DECADES` seed list (artwork via Apple, then Cover Art Archive).

## Design system (styles.css): "liner notes / record store"
- Paper and ink. Light "paper" (`--bg` #F1EBDD) is the default and signature look; dark "after hours" is `:root[data-theme="dark"]`. A script in `<head>` picks the saved choice
  (localStorage `rotation:theme`) else prefers-color-scheme; the footer toggle (`#themeToggle`, app.js `themeToggle`) switches it. Design and QA the light theme first.
- All values come from tokens in `:root`; never hard-code colors, fonts, radii or shadows. The only literals are the token definitions, the `@font-face` rules, the `theme-color` meta
  (kept in step with `--bg` by app.js) and the grain SVG. Old token names (`--surface-3`, `--text-muted`, `--on-accent`, `--danger`, ...) are aliases.
- Color is rationed: covers supply it. Vermilion (`--accent`, small text `--accent-strong`, text on it `--accent-ink`) appears ONLY for: your score, your starred tracks, your bar in the
  histogram, the primary action, 9-10 scores, "New this week", and focus rings. Everything else is ink on paper. No gradients, glows, glassmorphism, drop shadows, pills or emoji/sparkle icons.
  Floating layers get a 1px ink rule (`--shadow-pop`), not a shadow. Radii are 0-2px (`--r-*`); covers are square. The only circles are the record-label stamp and the vinyl.
- Print logic: 1px hairlines (`--border`), 2px ink rules (`--rule`) above major sections, mono uppercase labels (`--label-track`), tabular numerals only where numbers align
  (applied by a selector list at the end of styles.css, not on body, because Schibsted widens punctuation under tnum).
- Type (self-hosted WOFF2 in `fonts/`, Latin subset, `font-display: swap`, measured size-adjusted fallbacks, 237 KB total): Fraunces (variable opsz/wght/SOFT/WONK; display, ranks, big scores,
  review text; large sizes use SOFT 0 + WONK 1), Schibsted Grotesk (UI and body, 16px minimum), IBM Plex Mono (metadata, labels, durations, counts). No Google Fonts requests.
- Scores: numerals are ink; 9 and 10 (averages round first) are vermilion; your own score is always vermilion; there is NO color ramp. The one mapping is `RL.scoreTone(n)` in lib.js
  (`RL.toneAttr` for HTML strings, `setTone` for live updates, CSS `[data-tone="top"]`). The number is always printed. Histogram bars are `--text-2`, your own bar is `--accent`.
- Components are built by the HTML-string helpers in app.js (albumCard, artistCard, listCard, reviewCard, profileHeader, sectionHead, emptyState, errorState, skCards/skList, toast, tabs,
  button, scoreChip); reuse them. Stage blocks at the end of styles.css (marked "LINER NOTES, stage N") hold the identity: nav and forms, cards and the vinyl hover (hover+fine pointer
  only, 9px slide, off under reduced motion), chart sheet rows (`.grid:has(> .album-card__ranked)`, `.list-card`), the album page (stamps, segmented 1-10, tracklist table with dotted
  leaders, Fraunces reviews, flat ink histogram), artist page, loading wells (flat `--surface-1`, no shimmer), grain (`--grain: none` removes it; body only).
- Ambient tint: `applyAlbumTint` takes the cover's dominant color on a 32px canvas (`RL.tintFromPixels`, saturation/lightness clamped, none for greyscale or CORS-blocked covers, cached per
  session) and sets `--album-tint`; `.album2::after` is a FLAT fixed wash at `--tint-strength` (8-12%), `multiply` on paper and `screen` in the dark theme, fading in (not under reduced motion).
- Contrast is audited in the browser against computed tokens in both themes (38 pairs: text 4.5:1 on all four surfaces, accent-strong 4.5:1, ring/UI 3:1, accent-ink on accent 4.5:1,
  worst-case tint). Re-run it after any token change; the adjusted values (`--text-3`, `--accent-strong`, `--accent-ink`, `--surface-3`) are commented where they are defined.
- Copy voice: dry and specific, like a record-store clerk. No hype words (discover, unlock, elevate, seamless, curated, journey), no exclamation marks, sentence case. Never edit data,
  album titles or user content.
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
