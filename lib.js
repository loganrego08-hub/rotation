/* Rotation: pure logic with no DOM or network access, so it can be unit tested (see tests/index.html).
   Everything here works only on the ratings it is given; nothing is invented or estimated. */
(function (root) {
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
  const norm = (s) => String(s || "").toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+(ep|single)$/i, "").replace(/[^a-z0-9]/g, "");

  /* ---------- Taste comparison ---------- */
  const MIN_SHARED_FOR_SCORE = 10;   // shared ratings before any similarity percentage is shown
  const MIN_GENRE_ALBUMS = 8;        // rated albums with genre data each person needs before genre overlap is shown

  function genreCounts(rows) {
    const m = new Map();
    rows.forEach((r) => (r.genres || []).slice(0, 2).forEach((g) => m.set(g, (m.get(g) || 0) + 1)));
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }));
  }
  function genreOverlap(a, b) {
    const withGenres = (rows) => rows.filter((r) => (r.genres || []).length);
    const ga = withGenres(a), gb = withGenres(b);
    if (ga.length < MIN_GENRE_ALBUMS || gb.length < MIN_GENRE_ALBUMS) return { sufficient: false, needed: MIN_GENRE_ALBUMS, a: ga.length, b: gb.length, shared: [] };
    const ta = genreCounts(ga).slice(0, 5), tb = genreCounts(gb).slice(0, 5);
    const setB = new Set(tb.map((x) => x.name));
    return { sufficient: true, shared: ta.filter((x) => setB.has(x.name)).map((x) => x.name), topA: ta.map((x) => x.name), topB: tb.map((x) => x.name) };
  }
  // a, b: [{ album_id, title, artist, cover_url, genres, score }]
  function compareTaste(a, b) {
    const bm = new Map(b.map((r) => [r.album_id, r]));
    const shared = a.filter((r) => bm.has(r.album_id)).map((r) => ({ ...r, a: r.score, b: bm.get(r.album_id).score, diff: r.score - bm.get(r.album_id).score }));
    const n = shared.length;
    const mad = n ? mean(shared.map((s) => Math.abs(s.diff))) : null;
    return {
      n, enough: n >= MIN_SHARED_FOR_SCORE, needed: MIN_SHARED_FOR_SCORE,
      avgGap: round1(mad), avgA: round1(mean(shared.map((s) => s.a))), avgB: round1(mean(shared.map((s) => s.b))),
      // Similarity is a rough guide: 100% = identical scores on every shared album, 0% = a nine point gap on average
      similarity: n >= MIN_SHARED_FOR_SCORE ? Math.round((1 - mad / 9) * 100) : null,
      love: shared.filter((s) => s.a >= 8 && s.b >= 8).sort((x, y) => y.a + y.b - (x.a + x.b)),
      differ: shared.filter((s) => Math.abs(s.diff) >= 4).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)),
      shared: shared.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff) || (y.a + y.b) - (x.a + x.b)),
      genres: genreOverlap(a, b),
    };
  }

  /* ---------- Year in Rotation ---------- */
  // rows: [{ album_id, title, artist, cover_url, genres, score, first_rated_at }]; counts: Map(album_id -> community rating count)
  function recapOf(rows, year, counts = new Map()) {
    const y = String(year);
    const mine = rows.filter((r) => String(r.first_rated_at || "").slice(0, 4) === y);
    const n = mine.length;
    const byMonth = Array.from({ length: 12 }, (_, i) => {
      const m = mine.filter((r) => +String(r.first_rated_at).slice(5, 7) === i + 1);
      return { month: i + 1, n: m.length, avg: round1(mean(m.map((r) => r.score))) };
    });
    const groupBy = (keyFn) => { const g = new Map(); mine.forEach((r) => keyFn(r).forEach((k) => { const x = g.get(k) || { name: k, n: 0, sum: 0 }; x.n++; x.sum += r.score; g.set(k, x); })); return [...g.values()]; };
    const genres = groupBy((r) => (r.genres || []).slice(0, 2)).filter((g) => g.n >= 2).sort((a, b) => b.n - a.n || b.sum / b.n - a.sum / a.n).slice(0, 5).map((g) => ({ name: g.name, n: g.n, avg: round1(g.sum / g.n) }));
    const artists = groupBy((r) => [r.artist]).filter((g) => g.n >= 2).sort((a, b) => b.sum / b.n - a.sum / a.n || b.n - a.n).slice(0, 5).map((g) => ({ name: g.name, n: g.n, avg: round1(g.sum / g.n) }));
    const byScore = [...mine].sort((a, b) => b.score - a.score || String(a.first_rated_at).localeCompare(String(b.first_rated_at)));
    const topRated = byScore.filter((r) => r.score >= 8).slice(0, 5);
    // "Discoveries": albums you loved that few others on Rotation have rated (10 ratings or fewer in total)
    const discoveries = byScore.filter((r) => r.score >= 8 && (counts.get(r.album_id) ?? 0) <= 10).slice(0, 5);
    // "Most-rated": the albums you rated that the most people on Rotation have rated
    const mostRated = [...mine].filter((r) => (counts.get(r.album_id) ?? 0) >= 1).sort((a, b) => (counts.get(b.album_id) || 0) - (counts.get(a.album_id) || 0) || b.score - a.score).slice(0, 5)
      .map((r) => ({ ...r, community_count: counts.get(r.album_id) || 0 }));
    // Trend: only with enough ratings, and only a plain first-half vs second-half comparison
    let trend = null;
    if (n >= 10) {
      const ordered = [...mine].sort((a, b) => String(a.first_rated_at).localeCompare(String(b.first_rated_at)));
      const half = Math.floor(n / 2), first = mean(ordered.slice(0, half).map((r) => r.score)), second = mean(ordered.slice(half).map((r) => r.score));
      trend = { first: round1(first), second: round1(second), direction: Math.abs(second - first) < 0.5 ? "steady" : second > first ? "up" : "down" };
    }
    return { year: +year, n, avg: round1(mean(mine.map((r) => r.score))), byMonth, genres, artists, topRated, discoveries, mostRated, trend,
      busiestMonth: n ? byMonth.reduce((best, m) => (m.n > best.n ? m : best), byMonth[0]).month : null };
  }
  const yearsWithRatings = (rows) => [...new Set(rows.map((r) => String(r.first_rated_at || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort().reverse();

  /* ---------- Score formatting ----------
     The ONE place a score gets its look. Numerals are ink; scores of 9 and 10 (averages round, so 8.5 and up) are vermilion.
     There is no ramp. The number is always printed, so color is never the only signal. Whole scores and averages both work. */
  function scoreTone(n) {
    const v = Math.round(Number(n));
    return v >= 9 ? "top" : "";
  }
  const scoreVar = (n) => (scoreTone(n) ? "var(--accent-strong)" : "var(--text)");   // for canvas / inline use
  const toneAttr = (n) => (scoreTone(n) ? ` data-tone="${scoreTone(n)}"` : "");      // for HTML strings
  /* ---------- Ambient album tint ----------
     pixels: RGBA bytes from a small canvas. Returns { h, s, l, css } (hue 0-360, s/l 0-1) or null when the cover has no real color
     (greyscale, near black, near white). Pixels vote for a hue bucket weighted by how colorful and mid-tone they are, so a big
     white border or black background can't win. Saturation and lightness are then clamped, so a neon or near-white cover can't
     produce a tint that hurts contrast with the text above it. */
  const TINT_CLAMP = { sMin: 0.22, sMax: 0.55, lMin: 0.32, lMax: 0.5 };
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s, l };
  }
  function tintFromPixels(pixels) {
    const BUCKETS = 12, bins = Array.from({ length: BUCKETS }, () => ({ w: 0, s: 0, l: 0, hx: 0, hy: 0 }));
    let total = 0;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      if (pixels[i + 3] < 200) continue;                               // transparent
      const { h, s, l } = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
      const w = s * (1 - Math.abs(2 * l - 1)) ** 2;                    // colorful and mid-tone pixels count; greys, blacks and whites don't
      if (w < 0.02) continue;
      const b = bins[Math.floor(h / (360 / BUCKETS)) % BUCKETS];
      b.w += w; b.s += s * w; b.l += l * w; b.hx += Math.cos((h * Math.PI) / 180) * w; b.hy += Math.sin((h * Math.PI) / 180) * w; total += w;
    }
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a), bins[0]);
    if (total < 3 || best.w < total * 0.2) return null;                // nothing dominant: no tint is better than a muddy one
    const hue = ((Math.atan2(best.hy, best.hx) * 180) / Math.PI + 360) % 360;
    const C = TINT_CLAMP, clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const s = clamp(best.s / best.w, C.sMin, C.sMax), l = clamp(best.l / best.w, C.lMin, C.lMax);
    return { h: Math.round(hue), s: Math.round(s * 100) / 100, l: Math.round(l * 100) / 100, css: `hsl(${Math.round(hue)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)` };
  }

  /* ---------- Stats dashboard ---------- */
  // Dates are plain YYYY-MM-DD strings, compared as text, so time zones never shift a day.
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Seven rows (Sun..Sat) x up to 53 week columns ending at `today`. A cell is { date, n } or null (outside the 12-month window).
  function heatmapOf(rows, today = new Date()) {
    const counts = new Map();
    rows.forEach((r) => { const d = String(r.first_rated_at || "").slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) counts.set(d, (counts.get(d) || 0) + 1); });
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end); start.setFullYear(start.getFullYear() - 1); start.setDate(start.getDate() + 1);
    const first = new Date(start); first.setDate(first.getDate() - first.getDay());   // back up to the Sunday
    const weeks = []; let total = 0, active = 0, max = 0, run = 0, longest = 0;
    const cursor = new Date(first);
    while (cursor <= end) {
      const col = [];
      for (let i = 0; i < 7; i++) {
        if (cursor < start || cursor > end) col.push(null);
        else {
          const date = ymd(cursor), n = counts.get(date) || 0;
          col.push({ date, n }); total += n; max = Math.max(max, n);
          if (n) { active++; run++; longest = Math.max(longest, run); } else run = 0;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(col);
    }
    return { weeks, total, active, max, longestStreak: longest, from: ymd(start), to: ymd(end) };
  }
  // Level 0-4 for a day. Scales to the busiest day so a light logger still sees contrast.
  const heatLevel = (n, max) => (!n ? 0 : max <= 1 ? 4 : Math.min(4, Math.max(1, Math.ceil((n / max) * 4))));
  // rows also carry release_date ("1991-09-24" or "1991") for the decade chart
  function statsOf(rows, today = new Date()) {
    const year = String(today.getFullYear());
    const decades = new Map();
    rows.forEach((r) => { const y = +String(r.release_date || "").slice(0, 4); if (y >= 1900 && y <= today.getFullYear()) { const d = Math.floor(y / 10) * 10; decades.set(d, (decades.get(d) || 0) + 1); } });
    const decadeList = [...decades].sort((a, b) => a[0] - b[0]).map(([start, n]) => ({ start, n, label: start >= 2000 ? `${start}s` : `${String(start).slice(2)}s` }));
    const gc = genreCounts(rows.filter((r) => (r.genres || []).length)), withGenre = rows.filter((r) => (r.genres || []).length).length;
    const genres = gc.slice(0, 5).map((g) => ({ ...g, share: Math.round((g.n / Math.max(1, gc.reduce((s, x) => s + x.n, 0))) * 100) }));
    const mine = rows.filter((r) => String(r.first_rated_at || "").slice(0, 4) === year), a = new Map();
    mine.forEach((r) => { const x = a.get(r.artist) || { name: r.artist, n: 0, sum: 0, cover_url: r.cover_url }; x.n++; x.sum += r.score; a.set(r.artist, x); });
    const artists = [...a.values()].sort((p, q) => q.n - p.n || q.sum / q.n - p.sum / p.n || p.name.localeCompare(q.name)).slice(0, 3).map((x) => ({ name: x.name, n: x.n, avg: round1(x.sum / x.n), cover_url: x.cover_url }));
    return { n: rows.length, avg: round1(mean(rows.map((r) => r.score))), year: +year, decades: decadeList, decadeCount: decadeList.reduce((s, d) => s + d.n, 0),
      genres, withGenre, artists, heat: heatmapOf(rows, today) };
  }

  /* ---------- Recommendations ---------- */
  // groups: [{ rule, items: [{ id?, title, artist, ... , why }] }] in priority order.
  // Removes anything already rated (by id or by title+artist), de-duplicates, keeps priority order.
  function mergeRecs(groups, rated, limit = 18) {
    const ids = new Set(rated.map((r) => r.id || r.album_id).filter(Boolean)), keys = new Set(rated.map((r) => norm(r.title) + "|" + norm(r.artist)));
    const seen = new Set(), out = [];
    for (const g of groups) for (const it of g.items) {
      const k = norm(it.title) + "|" + norm(it.artist);
      if ((it.id && ids.has(it.id)) || keys.has(k) || seen.has(k)) continue;
      seen.add(k); out.push({ ...it, rule: g.rule });
      if (out.length >= limit) return out;
    }
    return out;
  }
  // Genres and artists a person rates highly: 7 or higher, weighted by how high. Needs repeat evidence.
  // Defaults are strict (2+ albums per genre, artists averaging 8+). Callers with thin data can relax them: { genreMin: 1, artistAvg: 7 }.
  function tasteProfile(rows, { genreMin = 2, artistAvg = 8 } = {}) {
    const liked = rows.filter((r) => r.score >= 7);
    const g = new Map(), a = new Map();
    liked.forEach((r) => {
      (r.genres || []).slice(0, 3).forEach((n) => { const x = g.get(n) || { name: n, n: 0, sum: 0 }; x.n++; x.sum += r.score; g.set(n, x); });
      const x = a.get(r.artist) || { name: r.artist, n: 0, sum: 0 }; x.n++; x.sum += r.score; a.set(r.artist, x);
    });
    const rank = (m, min) => [...m.values()].filter((x) => x.n >= min).sort((p, q) => q.sum - p.sum).map((x) => ({ name: x.name, n: x.n, avg: round1(x.sum / x.n) }));
    return { genres: rank(g, genreMin), artists: rank(a, 1).filter((x) => x.avg >= artistAvg) };
  }

  /* ---------- Search and album labels ---------- */
  // MusicBrainz is case-insensitive. User text is escaped so characters like : ( or " can't break the query.
  const lucene = (s) => String(s).replace(/([+\-&|!(){}\[\]^"~*?:\\\/])/g, "\\$1").trim();
  function albumQuery(term, f = {}) {
    const parts = [];
    if (term) parts.push(`(${lucene(term)})`);
    const t = f.type || "album";
    if (["album", "ep", "single"].includes(t)) parts.push(`primarytype:${t}`);
    else if (t !== "any") parts.push(`primarytype:album AND secondarytype:${t}`);
    if (f.from || f.to) parts.push(`firstreleasedate:[${f.from || "0000"} TO ${f.to || "9999"}]`);
    if (f.genre) parts.push(`tag:"${lucene(f.genre)}"`);
    if (f.artist) parts.push(`artist:"${lucene(f.artist)}"`);
    return parts.join(" AND ");
  }
  // "Studio album", "EP", "Compilation album", "Live album"... only what MusicBrainz actually lists
  function typeLabel(rg) {
    const p = rg["primary-type"], s = rg["secondary-types"] || [];
    return s.length ? `${s.join(" + ")}${p ? " " + p.toLowerCase() : ""}` : p === "Album" ? "Studio album" : p || "";
  }
  // Same rule as the album_catalog view: 10+ ratings, a wide spread, and real camps on both sides
  function spreadNote(counts) {
    const n = counts.reduce((a, b) => a + b, 0);
    if (n < 10) return "";
    const m = counts.reduce((s, c, i) => s + c * (i + 1), 0) / n;
    const sd = Math.sqrt(counts.reduce((s, c, i) => s + c * (i + 1 - m) ** 2, 0) / n);
    const high = counts.slice(7).reduce((a, b) => a + b, 0) / n, low = counts.slice(0, 4).reduce((a, b) => a + b, 0) / n;
    if (sd >= 2.5 && high >= 0.2 && low >= 0.2) return `Divisive: ${Math.round(high * 100)}% scored 8 or higher and ${Math.round(low * 100)}% scored 4 or lower.`;
    return sd <= 1.4 ? "Broad agreement: most scores sit close together." : "";
  }
  // MusicBrainz rejects a search page when offset + limit passes 500, so a random page must start at or below 500 - limit
  const MB_WINDOW = 500;
  function randomPageOffset(count, limit, rand = Math.random) {
    const reachable = Math.min(count || 0, MB_WINDOW);
    return Math.floor(rand() * Math.max(1, reachable - limit + 1));
  }

  /* ---------- Search ranking ----------
     MusicBrainz orders by its own text score, so a famous album and a 2024 TikTok single with the same title tie at 100.
     Everything here re-ranks MusicBrainz candidates using the words typed AND how real the release is. It is pure (no network),
     so the browser and api/search.js share it and tests/index.html can pin its behavior with fixtures. */

  // ALL TUNING LIVES HERE. Final relevance = text * text + popularity points + type points - penalties.
  // Points are on a rough 0-100 scale: a perfect text match alone is worth `text`, a very popular album can add up to ~55 more.
  const SEARCH_WEIGHTS = {
    text: 60,             // how well the typed words match title/artist (0..1 * this). Highest single factor so the right words always lead.
    minText: 0.28,        // candidates matching worse than this are dropped as noise instead of ranked last
    ratings: 7,           // * log10(1 + ratings on Rotation): albums people here actually rated beat unknown entries
    inRotation: 8,        // flat boost for any album already in Rotation's catalog (rated or saved by someone)
    billboard: 14,        // on this week's Billboard chart; scaled so #1 is worth full points and #50 about half
    editions: 3,          // * log2(1 + releases in the MusicBrainz group): widely issued albums are better known (28 editions vs 1)
    tags: 1.6,            // * log2(1 + total genre/tag votes): a rough listener-interest signal from MusicBrainz
    artistAlbums: 2,      // artist results: * log2(1 + albums by this artist in the candidates)
    type: { album: 14, ep: 6, live: 3, single: 2, soundtrack: 2, compilation: 2, other: 0 },   // studio albums first; singles and covers behind
    typeChosen: 6,        // when the person picked a type filter, every result already has that type, so they are all scored equally at this
    noise: 40,            // tribute / karaoke / piano-covers / "made famous by" records. Can still be found, just never first.
    obscure: 12,          // one edition, no tags, not rated here, not charting: almost certainly a self-released or auto-generated entry
    undated: 4,           // no release date at all
    fuzzyCap: 0.6,        // a typo-tolerant match can never score above this, so exact words always win over near-misses
    topShare: 0.55,       // results page "Top results": candidates within this share of the best score (at most topMax)
    topMax: 10,
    artistCardShare: 0.7, // artist card is shown when its score is at least this share of the best album score
  };
  const NOISE_RE = /karaoke|tribute|piano (version|rendition|cover)s?|instrumental (version|cover)s?|lullaby|made famous|originally performed|in the style of|as made|cover versions?|workout|8-bit|music box|\bai (generated|music|cover)/i;
  // Cover/background-music records. Weaker evidence than NOISE_RE (a real album can be called "Covers"), so they only lose points and never reach "Top results".
  const NOISE2_RE = /\b(covers?|instrumentals?|lo-?fi|study|string quartet|performs|renditions?|mash-?ups?|mashed|a cappella|re-?imagined|sleep|relaxing|meditation)\b/i;
  const STOP = new Set(["the", "a", "an", "of", "and"]);

  // Lowercase, strip accents and punctuation, "&" -> "and", drop a leading The/A/An ("The Weeknd" -> "weeknd", "Beyoncé" -> "beyonce")
  const normText = (s) => String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/^(the|a|an) (?=.)/, "");
  const words = (s) => normText(s).split(" ").filter(Boolean);
  // Title key for collapsing duplicates: "Fearless (Deluxe Edition)" and "Fearless - Remastered" are the same album as "Fearless"
  const EDITION = "deluxe|remaster(?:ed)?|expanded|anniversary|edition|bonus|special|collector'?s|reissue|\\d{4} version|super deluxe";
  const baseTitle = (s) => normText(String(s || "").replace(new RegExp(`\\s*[\\(\\[][^)\\]]*(?:${EDITION})[^)\\]]*[\\)\\]]`, "ig"), "").replace(new RegExp(`\\s+-\\s+[^-]*(?:${EDITION}).*$`, "i"), ""));

  function editDistance(a, b) {   // Damerau-Levenshtein (a swap of two neighbors costs 1, so "swfit" is 1 away from "swift")
    const m = a.length, n = b.length;
    if (!m || !n) return Math.max(m, n);
    const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[m][n];
  }
  const closeness = (a, b) => (a === b ? 1 : 1 - editDistance(a, b) / Math.max(a.length, b.length));

  // How well does the typed `query` match `target`? 0..1. exact title > prefix > all words > word prefixes > typo-tolerant.
  function textScore(query, target) {
    const nq = normText(query), nt = normText(target);
    if (!nq || !nt) return 0;
    if (nq === nt) return 1;
    const qw = nq.split(" "), tw = nt.split(" "), lenRatio = Math.min(1, nq.length / nt.length);
    if (nt.startsWith(nq + " ") || nt.startsWith(nq)) return 0.84 + 0.1 * lenRatio;                 // "stick season" in "stick season live"
    if (qw.every((w) => tw.includes(w))) return 0.68 + 0.14 * lenRatio;                              // every word, any order
    if (qw.every((w, i) => (i < qw.length - 1 ? tw.includes(w) : tw.some((t) => t.startsWith(w))))) return 0.58 + 0.12 * lenRatio;   // "dark sid" -> "dark side of the moon"
    // typo tolerant: every typed word must be close to some target word (short words must match exactly)
    let sum = 0;
    for (const w of qw) {
      let best = 0;
      for (const t of tw) { const c = w.length <= 3 || t.length <= 3 ? (w === t ? 1 : 0) : closeness(w, t); if (c > best) best = c; }
      if (best < 0.7) return Math.min(SEARCH_WEIGHTS.fuzzyCap * closeness(nq, nt), 0.25);
      sum += best;
    }
    return Math.min(SEARCH_WEIGHTS.fuzzyCap, (sum / qw.length) * 0.62 * (0.8 + 0.2 * lenRatio));
  }
  // The query may be "artist album" or "album artist": try every split of its words in both orders.
  function matchText(query, { title, artist }) {
    if (!normText(query)) return { score: 1, kind: "filter" };   // filters only, no typed words: everything matches, popularity orders it
    let best = { score: textScore(query, title), kind: "title" };
    const a = textScore(query, artist) * 0.82;      // an artist-only query matches all their albums, but below an exactly titled album
    if (a > best.score) best = { score: a, kind: "artist" };
    const qw = normText(query).split(" ");
    for (let i = 1; i < qw.length; i++) {
      const left = qw.slice(0, i).join(" "), right = qw.slice(i).join(" ");
      for (const [pa, pt] of [[left, right], [right, left]]) {
        const sa = textScore(pa, artist), st = textScore(pt, title);
        if (sa < 0.5 || st < 0.5) continue;
        const s = Math.sqrt(sa * st) * 0.99;
        if (s > best.score) best = { score: s, kind: "artist+title" };
      }
    }
    return best;
  }

  // Release-group types as MusicBrainz reports them -> one simple kind
  function kindOf(c) {
    const p = String(c.type || c.primary || "").toLowerCase(), s = (c.secondary || []).map((x) => String(x).toLowerCase());
    if (s.includes("soundtrack")) return "soundtrack";
    if (s.includes("compilation")) return "compilation";
    if (s.includes("live")) return "live";
    if (s.length) return "other";
    return p === "album" ? "album" : p === "ep" ? "ep" : p === "single" ? "single" : "other";
  }
  // MusicBrainz release-group (search result) -> candidate
  const candidateOf = (g) => ({ id: g.id, title: g.title, artist: g.artist || (g["artist-credit"] || []).map((c) => c.name + (c.joinphrase || "")).join(""),
    artistId: g.artistId || (g["artist-credit"] || [])[0]?.artist?.id || null, date: g.date || g["first-release-date"] || "", type: g.type || g["primary-type"] || "", secondary: g.secondary || g["secondary-types"] || [],
    releases: g.releases == null ? 0 : Array.isArray(g.releases) ? g.releases.length : g.releases, tags: g.tags == null ? 0 : Array.isArray(g.tags) ? g.tags.reduce((s, t) => s + (t.count || 0), 0) : g.tags,
    disambiguation: g.disambiguation || "" });

  // signals: { ratings: Map(id -> count on Rotation), rotation: Set(id), billboard: Map(baseTitle|artist -> rank) }; opts: { typeChosen, weights }
  function scoreCandidate(query, c, signals = {}, opts = {}) {
    const W = opts.weights || SEARCH_WEIGHTS, m = matchText(query, c), kind = c.kind || kindOf(c);
    const n = (signals.ratings && signals.ratings.get(c.id)) || c.rating_count || 0;
    const known = n > 0 || (signals.rotation && signals.rotation.has(c.id)) || !!c.inRotation;
    const bb = signals.billboard && signals.billboard.get(baseTitle(c.title) + "|" + normText(c.artist));
    let s = m.score * W.text;
    s += W.ratings * Math.log10(1 + n) + (known ? W.inRotation : 0);
    if (bb) s += W.billboard * (1 - ((bb - 1) / 200));
    s += W.editions * Math.log2(1 + (c.releases || 0)) + W.tags * Math.log2(1 + (c.tags || 0));
    s += opts.typeChosen ? W.typeChosen : (W.type[kind] ?? 0);
    const noisy = NOISE_RE.test(`${c.title} ${c.artist}`) && !NOISE_RE.test(query);
    const soft = !noisy && NOISE2_RE.test(`${c.title} ${c.artist}`) && !NOISE2_RE.test(query);
    if (noisy) s -= W.noise;
    if (soft) s -= W.noise * 0.6;
    // Nothing says this record is real: not rated here, not charting, almost no editions, no tag votes
    const obscure = !known && !bb && (c.releases || 0) <= 2 && (c.tags || 0) <= 1;
    if (obscure) s -= W.obscure;
    if (!c.date) s -= W.undated;
    return { relevance: Math.round(s * 10) / 10, text: m.score, textKind: m.kind, kind, noisy: noisy || soft, obscure, known, billboard: bb || null };
  }
  // Same artist + same base title + same kind (album, single, EP...) is one release: keep the original (known to Rotation first,
  // then earliest release, then best score). A single and the album that share a name stay separate, ranked by type.
  function collapseDuplicates(list) {
    const groups = new Map();
    for (const r of list) {
      const k = normText(r.artist) + "|" + baseTitle(r.title) + "|" + r.kind;
      const g = groups.get(k);
      if (!g) { groups.set(k, r); continue; }
      const better = (x, y) => (x.known !== y.known ? x.known : (x.date || "9999") !== (y.date || "9999") ? (x.date || "9999") < (y.date || "9999") : x.relevance >= y.relevance);
      const keep = better(r, g) ? r : g;
      groups.set(k, { ...keep, releases: Math.max(r.releases || 0, g.releases || 0), tags: Math.max(r.tags || 0, g.tags || 0), relevance: Math.max(r.relevance, g.relevance) });
    }
    return [...groups.values()];
  }
  function rankAlbums(query, candidates, signals = {}, opts = {}) {
    const W = opts.weights || SEARCH_WEIGHTS;
    const scored = candidates.filter((c) => c && c.title).map((c) => ({ ...c, ...scoreCandidate(query, c, signals, opts) })).filter((r) => r.text >= W.minText);
    return collapseDuplicates(scored).sort((a, b) => b.relevance - a.relevance || (b.releases || 0) - (a.releases || 0) || String(a.date).localeCompare(String(b.date)));
  }
  // Artists come from the albums themselves, so a tiny namesake with one obscure single can't outrank a famous album.
  function rankArtists(query, ranked, signals = {}, opts = {}) {
    const W = opts.weights || SEARCH_WEIGHTS, by = new Map();
    for (const r of ranked) {
      const k = normText(r.artist); if (!k) continue;
      const x = by.get(k) || { name: r.artist, id: r.artistId, albums: 0, best: 0, tags: 0, known: false };
      x.albums++; x.best = Math.max(x.best, r.relevance); x.tags = Math.max(x.tags, r.tags || 0); x.known = x.known || r.known || !!r.billboard;
      if (!x.id && r.artistId) x.id = r.artistId;
      by.set(k, x);
    }
    const nq = normText(query);
    return [...by.values()].map((x) => {
      // a typo in a name ("taylor swfit") is still that artist when the whole name is nearly identical
      const near = closeness(nq, normText(x.name)), text = Math.max(textScore(query, x.name), near >= 0.85 ? near * 0.95 : 0);
      const pop = W.artistAlbums * Math.log2(1 + x.albums) + W.tags * Math.log2(1 + x.tags) + (x.known ? W.inRotation : 0);
      return { ...x, text, relevance: Math.round((text * W.text + pop) * 10) / 10 };
    }).filter((x) => x.text >= 0.6 && x.id).sort((a, b) => b.relevance - a.relevance);
  }
  // The artist card above the albums, only when the artist is about as strong as the best album
  function artistCard(query, ranked, signals = {}, opts = {}) {
    const W = opts.weights || SEARCH_WEIGHTS, a = rankArtists(query, ranked, signals, opts)[0];
    if (!a || a.text < 0.85) return null;
    const top = ranked[0];
    return !top || a.relevance >= top.relevance * W.artistCardShare ? a : null;
  }
  // Results page split: "Top results" (clearly relevant) then the rest
  function splitTop(ranked, weights = SEARCH_WEIGHTS) {
    if (!ranked.length) return { top: [], more: [] };
    // "Top" needs evidence the record is real: obscure and cover-style records go to "More results" however well their title matches
    const floor = ranked[0].relevance * weights.topShare;
    let top = ranked.filter((r) => r.relevance >= floor && !r.obscure && !r.noisy).slice(0, weights.topMax);
    if (!top.length) top = ranked.slice(0, 3);   // nothing established matched (a rare band, a very new album): still show the best few
    const inTop = new Set(top);
    return { top, more: ranked.filter((r) => !inTop.has(r)) };
  }
  // "Did you mean": the best result's artist or title when the query only matched it through typo tolerance
  function didYouMean(query, ranked) {
    const top = ranked[0], nq = normText(query);
    if (!top || top.text >= 0.9 || !nq) return null;
    const options = [top.artist, top.title].filter((o) => normText(o) !== nq);
    const cands = options.map((o) => ({ o, s: Math.max(closeness(nq, normText(o)), textScore(query, o)) })).sort((a, b) => b.s - a.s);
    return cands[0] && cands[0].s >= 0.45 ? cands[0].o : null;
  }

  // Query plan for MusicBrainz. Every typed word must appear in the ARTIST or the TITLE, so "kendrick gnx" and "gnx kendrick" both work.
  // `strict` is exact words (last word as a prefix while typing); `fuzzy` adds ~ to words of 4+ letters to survive typos.
  function searchPlan(term, f = {}, { prefix = false } = {}) {
    const ws = String(term || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
    const core = ws.filter((w) => !STOP.has(w.toLowerCase()));
    const use = core.length ? core : ws;
    const clause = (fuzzy) => use.map((w, i) => {
      const t = fuzzy && w.length >= 4 ? `${w}~` : prefix && i === use.length - 1 && w.length >= 2 ? `${w}*` : w;
      return `(artist:${t} OR releasegroup:${t})`;
    }).join(" AND ");
    const filters = filterClauses(f);
    const wrap = (c) => [c ? `(${c})` : "", ...filters].filter(Boolean).join(" AND ");
    const phrase = ws.length > 1 ? ` OR releasegroup:"${lucene(ws.join(" "))}"^4` : "";
    // `tagged` only returns albums people have tagged with a mainstream genre, which drops the thousands of untagged, auto-generated entries
    const tagged = wrap(use.length ? `${clause(false)} AND ${TAGGED}` : "");
    return { strict: wrap(use.length ? clause(false) + phrase : ""), fuzzy: wrap(use.length ? clause(true) : ""), tagged, words: use };
  }
  const TAGGED = '(tag:rock OR tag:pop OR tag:electronic OR tag:jazz OR tag:"hip hop" OR tag:metal OR tag:folk OR tag:indie OR tag:soul OR tag:punk OR tag:alternative OR tag:classical OR tag:country OR tag:blues OR tag:funk OR tag:reggae)';
  // MusicBrainz orders by text only, so for a short ambiguous query ("dark side") the famous album can sit past the first 50 hits.
  // When nothing in the first page looks established, the caller runs a second pass over tagged albums (2 pages of 100).
  // "Established" = 12+ editions (tag votes alone are easy to inflate on obscure entries) AND the title/artist really matches the words typed.
  // Typing both an artist and an album that matches exactly ("mac miller swimming") is unambiguous, so no sweep is needed either.
  function isWeakPool(groups, query = "") {
    if (groups.some((g) => (g.releases || 0) >= 12 && matchText(query, g).score >= 0.7)) return false;
    return !groups.some((g) => { const m = matchText(query, g); return m.kind === "artist+title" && m.score >= 0.95; });
  }
  // A first page whose best match isn't a near-exact one usually means a typo: worth one typo-tolerant retry
  // (an exact artist name scores 0.82 on its own, so the bar sits just below that; typo matches never exceed 0.6)
  const needsFuzzy = (ranked) => !ranked.length || ranked[0].text < 0.78;
  function filterClauses(f = {}) {
    const parts = [], t = f.type || "album";
    if (["album", "ep", "single"].includes(t)) parts.push(`primarytype:${t}`);
    else if (t !== "any") parts.push(`primarytype:album AND secondarytype:${t}`);
    // "Albums" means studio albums: live recordings (a long tail of bootlegs), compilations, soundtracks and remixes have their own types
    if (t === "album") parts.push("NOT secondarytype:(live OR compilation OR soundtrack OR remix OR demo OR spokenword OR interview OR audiobook OR mixtape)");
    if (f.from || f.to) parts.push(`firstreleasedate:[${f.from || "0000"} TO ${f.to || "9999"}]`);
    if (f.genre) parts.push(`tag:"${lucene(f.genre)}"`);
    if (f.artist) parts.push(`artist:"${lucene(f.artist)}"`);
    return parts;
  }

  /* ---------- Streaming services ----------
     Every service gets a search URL that always works (the graceful fallback). Direct album and track links are found by api/listen.js.
     Web URLs, not custom schemes: on a phone with the app installed they open in the app, otherwise in the browser. */
  const enc = encodeURIComponent;
  const STREAMING_SERVICES = [
    { id: "spotify", label: "Spotify", search: (q) => `https://open.spotify.com/search/${enc(q)}` },
    { id: "apple", label: "Apple Music", search: (q) => `https://music.apple.com/us/search?term=${enc(q)}` },
    { id: "youtube", label: "YouTube Music", search: (q) => `https://music.youtube.com/search?q=${enc(q)}` },
    { id: "tidal", label: "Tidal", search: (q) => `https://tidal.com/search?q=${enc(q)}` },
    { id: "amazon", label: "Amazon Music", search: (q) => `https://music.amazon.com/search/${enc(q)}` },
    { id: "deezer", label: "Deezer", search: (q) => `https://www.deezer.com/search/${enc(q)}` },
    { id: "pandora", label: "Pandora", search: (q) => `https://www.pandora.com/search/${enc(q)}/all` },
    { id: "soundcloud", label: "SoundCloud", search: (q, kind) => `https://soundcloud.com/search/${kind === "track" ? "sounds" : "albums"}?q=${enc(q)}` },
    { id: "bandcamp", label: "Bandcamp", search: (q, kind) => `https://bandcamp.com/search?q=${enc(q)}&item_type=${kind === "track" ? "t" : "a"}` },
    { id: "qobuz", label: "Qobuz", search: (q) => `https://www.qobuz.com/us-en/search?q=${enc(q)}` },
  ];
  const streamingService = (id) => STREAMING_SERVICES.find((s) => s.id === id) || null;
  const streamingSearchUrl = (id, query, kind = "album") => { const s = streamingService(id); return s ? s.search(String(query || "").trim(), kind) : null; };
  // "artist album" or "artist track", the words a streaming search wants
  const listenQuery = (artist, title, track) => `${artist || ""} ${track || title || ""}`.replace(/\s+/g, " ").trim();
  // Which service a URL belongs to, with the URL cleaned up (MusicBrainz stores streaming links on releases). null when it's not an album link we know.
  function streamingFromUrl(raw) {
    let u; try { u = new URL(raw); } catch { return null; }
    const h = u.hostname.replace(/^www\./, ""), p = u.pathname, list = u.searchParams.get("list") || "";
    if (h === "open.spotify.com" && /\/album\/\w+/.test(p)) return { service: "spotify", url: `https://open.spotify.com${p.match(/\/album\/\w+/)[0]}` };
    if ((h === "music.apple.com" || h === "itunes.apple.com") && /\/album\//.test(p)) return { service: "apple", url: `https://music.apple.com${p}` };
    if ((h === "tidal.com" || h === "listen.tidal.com") && /\/album\/\d+/.test(p)) return { service: "tidal", url: `https://tidal.com${p.match(/\/album\/\d+/)[0]}` };
    if (h === "deezer.com" && /\/album\/\d+/.test(p)) return { service: "deezer", url: `https://www.deezer.com${p.match(/\/album\/\d+/)[0]}` };
    if (h === "music.youtube.com" && list) return { service: "youtube", url: `https://music.youtube.com/playlist?list=${list}` };
    if ((h === "youtube.com" || h === "m.youtube.com") && /^OLAK5uy/.test(list)) return { service: "youtube", url: `https://music.youtube.com/playlist?list=${list}` };
    if (/^music\.amazon\./.test(h) && /\/albums\/\w+/.test(p)) return { service: "amazon", url: `https://${h}${p.match(/\/albums\/\w+/)[0]}` };
    if (/\.bandcamp\.com$/.test(h) && /^\/album\//.test(p)) return { service: "bandcamp", url: `https://${h}${p}` };
    if (h === "soundcloud.com" && /\/sets\//.test(p)) return { service: "soundcloud", url: `https://soundcloud.com${p}` };
    if (h === "pandora.com" && /^\/artist\//.test(p)) return { service: "pandora", url: `https://www.pandora.com${p}` };
    if (h === "qobuz.com" && /\/album\//.test(p)) return { service: "qobuz", url: `https://www.qobuz.com${p}` };
    return null;
  }
  // Name matching for picking the right album or track out of a service's results
  const stripBrackets = (s) => normText(String(s || "").replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+(single|ep)\s*$/i, ""));
  const sameArtistName = (a, b) => { a = normText(a); b = normText(b); return a.length >= 2 && b.length >= 2 && (a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))); };
  const sameTitleName = (a, b) => { a = stripBrackets(a); b = stripBrackets(b); if (!a || !b) return false; if (a === b) return true; const [s, l] = a.length <= b.length ? [a, b] : [b, a]; return s.length >= 6 && l.startsWith(s) && s.length / l.length >= 0.8; };   // 0.8: "Swimming" must not match "Swimming Pool"

  /* ---------- Share previews (Open Graph / Twitter) ----------
     api/page.js looks the page up, builds a meta object with these helpers and injects it into index.html, so crawlers that don't run JavaScript
     (link unfurlers, search engines) see real titles, descriptions and cover art. Nothing is invented: a score appears only when there are ratings. */
  const SITE = "Rotation";
  const SITE_DESC = "Score albums out of 10, star standout tracks, keep lists, and see where everyone else lands.";
  const plainText = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
  // row: { title, artist, cover_url?, release_date?, rating_count?, avg_score? }
  function albumMeta(row, { origin, id }) {
    const year = String(row.release_date || "").slice(0, 4), n = Number(row.rating_count) || 0;
    const score = n > 0 && row.avg_score != null ? `Community score: ${row.avg_score}/10 from ${n} ${n === 1 ? "rating" : "ratings"}.` : "Not rated yet. Be the first to score it.";
    return { title: `${plainText(row.title)} by ${plainText(row.artist)} · ${SITE}`, description: clip(`${plainText(row.artist)}${/^\d{4}$/.test(year) ? ` · ${year}` : ""}. ${score}`, 200),
      url: `${origin}/album/${id}`, image: row.cover_url || `https://coverartarchive.org/release-group/${id}/front-500`, imageAlt: `${plainText(row.title)} by ${plainText(row.artist)}`, type: "music.album" };
  }
  // row: { title, description?, username?, item_count?, covers? } from the public_lists view (private lists never appear there)
  function listMeta(row, { origin, id }) {
    const n = Number(row.item_count) || 0, by = row.username ? ` by @${row.username}` : "";
    return { title: `${plainText(row.title)} · a list on ${SITE}`, description: clip(plainText(row.description) || `${n} ${n === 1 ? "album" : "albums"}${by}. Ranked and shared on ${SITE}.`, 200),
      url: `${origin}/list/${id}`, image: (row.covers || []).find(Boolean) || null, imageAlt: `Cover of ${plainText(row.title)}`, type: "website" };
  }
  function artistMeta(row, { origin, id }) {
    const bits = [row.type, row.area].filter(Boolean).join(", ");
    return { title: `${plainText(row.name)} · ${SITE}`, description: clip(`${plainText(row.name)}${bits ? ` (${bits})` : ""}. Albums, scores and what the community thinks on ${SITE}.`, 200), url: `${origin}/artist/${id}`, image: null, type: "profile" };
  }
  // Static pages: a sensible title and description each; pages that are personal are marked noindex
  const ROUTE_META = [
    [/^\/$/, { title: `${SITE}: rate every album out of 10`, description: SITE_DESC }],
    [/^\/explore/, { title: `Explore · ${SITE}`, description: "Browse albums by genre and decade, from the charts and from what people on Rotation are rating." }],
    [/^\/genre\//, { title: `Genre charts · ${SITE}`, description: "This week's Billboard album chart for the genre, with scores from the Rotation community." }],
    [/^\/decade\//, { title: `Albums by decade · ${SITE}`, description: "Landmark albums from the decade, plus what people on Rotation have rated." }],
    [/^\/lists/, { title: `Lists · ${SITE}`, description: "Charts, the community's top-rated albums and public lists from people on Rotation." }],
    [/^\/search/, { title: `Search · ${SITE}`, description: "Find any album or artist, then give it a score." }],
    [/^\/browse/, { title: `Browse with filters · ${SITE}`, description: "Filter albums by genre, decade, average score and number of ratings." }],
    [/^\/privacy/, { title: `Privacy · ${SITE}`, description: "What Rotation stores about you, who can see it, and how to download or delete it." }],
    [/^\/stats\/sample/, { title: `Sample stats · ${SITE}`, description: "A made-up example of the listening stats page, clearly labeled as sample data." }],
    [/^\/(me|settings|notifications|feed|stats|year)/, { title: `${SITE}`, description: SITE_DESC, noindex: true }],
  ];
  function routeMeta(pathname, { origin }) {
    const hit = ROUTE_META.find(([re]) => re.test(pathname));
    return { ...(hit ? hit[1] : { title: `${SITE}`, description: SITE_DESC }), url: `${origin}${pathname === "/" ? "/" : pathname.replace(/\/+$/, "")}`, image: null, type: "website" };
  }
  const attr = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Replaces the shell's own title and share tags with the page's, once each
  function injectMeta(html, m) {
    const image = m.image || null;
    const tags = [
      `<title>${attr(m.title)}</title>`,
      `<meta name="description" content="${attr(m.description)}">`,
      m.noindex ? '<meta name="robots" content="noindex, follow">' : '<meta name="robots" content="index, follow">',
      `<link rel="canonical" href="${attr(m.url)}">`,
      `<meta property="og:site_name" content="${SITE}">`,
      `<meta property="og:type" content="${attr(m.type || "website")}">`,
      `<meta property="og:title" content="${attr(m.title)}">`,
      `<meta property="og:description" content="${attr(m.description)}">`,
      `<meta property="og:url" content="${attr(m.url)}">`,
      image ? `<meta property="og:image" content="${attr(image)}">` : "",
      image && m.imageAlt ? `<meta property="og:image:alt" content="${attr(m.imageAlt)}">` : "",
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${attr(m.title)}">`,
      `<meta name="twitter:description" content="${attr(m.description)}">`,
      image ? `<meta name="twitter:image" content="${attr(image)}">` : "",
    ].filter(Boolean);
    const stripped = html.replace(/<title>[\s\S]*?<\/title>\s*/gi, "").replace(/<meta\s+(?:name|property)="(?:description|robots|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi, "").replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "");
    return stripped.replace(/<\/head>/i, `${tags.join("\n")}\n</head>`);
  }

  /* ---------- Sign-in return errors ----------
     After Google/Apple sign-in or a magic link, Supabase sends the person back to the site and puts any failure in the URL
     (error, error_code, error_description). This turns that into one clear sentence. Expired is checked first because an expired
     magic link arrives as error=access_denied AND error_code=otp_expired, and "denied" would be the wrong message for it. */
  function authReturnMessage(r) {
    if (!r || !(r.error || r.code || r.description)) return null;
    const text = `${r.code || ""} ${r.error || ""} ${r.description || ""}`.replace(/\+/g, " ").toLowerCase();
    if (/otp_expired|expired|already used|invalid or has expired/.test(text)) return "That sign-in link has expired or was already used. Request a new one.";
    if (/provider.*(not enabled|disabled)|unsupported provider|provider_disabled/.test(text)) return "That sign-in method isn't available yet.";
    if (/identity_already_exists|already registered|already (has|exists)|email_exists/.test(text)) return "That email already has an account. Sign in with your password, or with the method you used before.";
    if (/access_denied|cancel|user_denied|denied/.test(text)) return "Sign-in was cancelled. You can try again any time.";
    const d = String(r.description || "").replace(/\+/g, " ").trim();
    return d ? `Sign-in didn't complete: ${d}` : "Sign-in didn't complete. Please try again.";
  }

  root.RotationLib = { authReturnMessage, albumMeta, listMeta, artistMeta, routeMeta, injectMeta, STREAMING_SERVICES, streamingService, streamingSearchUrl, listenQuery, streamingFromUrl, sameArtistName, sameTitleName, stripBrackets, tintFromPixels, rgbToHsl, TINT_CLAMP, scoreTone, scoreVar, toneAttr, SEARCH_WEIGHTS, normText, baseTitle, textScore, matchText, kindOf, candidateOf, scoreCandidate, rankAlbums, rankArtists, artistCard, splitTop, didYouMean, searchPlan, isWeakPool, needsFuzzy, editDistance, lucene, albumQuery, typeLabel, spreadNote, randomPageOffset, MB_WINDOW, mean, round1, norm, compareTaste, genreOverlap, genreCounts, recapOf, yearsWithRatings, heatmapOf, heatLevel, statsOf, mergeRecs, tasteProfile, MIN_SHARED_FOR_SCORE, MIN_GENRE_ALBUMS };
})(typeof window !== "undefined" ? window : globalThis);
// api/search.js shares the same ranking code as the browser
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.RotationLib;
