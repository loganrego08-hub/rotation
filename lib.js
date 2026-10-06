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
  function tasteProfile(rows) {
    const liked = rows.filter((r) => r.score >= 7);
    const g = new Map(), a = new Map();
    liked.forEach((r) => {
      (r.genres || []).slice(0, 3).forEach((n) => { const x = g.get(n) || { name: n, n: 0, sum: 0 }; x.n++; x.sum += r.score; g.set(n, x); });
      const x = a.get(r.artist) || { name: r.artist, n: 0, sum: 0 }; x.n++; x.sum += r.score; a.set(r.artist, x);
    });
    const rank = (m, min) => [...m.values()].filter((x) => x.n >= min).sort((p, q) => q.sum - p.sum).map((x) => ({ name: x.name, n: x.n, avg: round1(x.sum / x.n) }));
    return { genres: rank(g, 2), artists: rank(a, 1).filter((x) => x.avg >= 8) };
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

  root.RotationLib = { lucene, albumQuery, typeLabel, spreadNote, randomPageOffset, MB_WINDOW, mean, round1, norm, compareTaste, genreOverlap, genreCounts, recapOf, yearsWithRatings, heatmapOf, heatLevel, statsOf, mergeRecs, tasteProfile, MIN_SHARED_FOR_SCORE, MIN_GENRE_ALBUMS };
})(typeof window !== "undefined" ? window : globalThis);
