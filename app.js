/* Rotation — rate and rank albums */
const cfg = window.ROTATION_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
const sb = configured ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const MB = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org/release-group";
const CHART = (slug) => `/api/chart?slug=${slug}`;

// Every genre tile is one of Billboard's weekly album charts
const GENRES = [
  { slug: "hip-hop", name: "Hip-hop & R&B", chart: "r-b-hip-hop-albums", tags: ["hip hop", "rap", "trap", "r&b", "rnb", "soul", "neo soul", "contemporary r&b"], color: "#E07A1F" },
  { slug: "rap", name: "Rap", chart: "rap-albums", tags: ["rap", "hip hop", "trap", "conscious hip hop", "gangsta rap"], color: "#B8532A" },
  { slug: "country", name: "Country", chart: "top-country-albums", tags: ["country", "country pop", "contemporary country", "bro-country"], color: "#B78A2E" },
  { slug: "rock", name: "Rock", chart: "top-rock-albums", tags: ["rock", "classic rock", "pop rock", "punk", "pop punk"], color: "#C93A2B" },
  { slug: "alternative", name: "Alternative", chart: "alternative-albums", tags: ["alternative", "indie", "indie rock", "alternative rock", "indie pop", "shoegaze", "emo"], color: "#2A9483" },
  { slug: "hard-rock", name: "Hard rock & metal", chart: "hard-rock-albums", tags: ["metal", "heavy metal", "hard rock", "metalcore", "death metal", "nu metal"], color: "#454A55" },
  { slug: "electronic", name: "Dance & electronic", chart: "dance-electronic-albums", tags: ["electronic", "house", "techno", "edm", "dance", "dubstep", "synth-pop"], color: "#3570E0" },
  { slug: "latin", name: "Latin", chart: "latin-albums", tags: ["latin", "reggaeton", "latin pop", "regional mexican", "corridos"], color: "#D9593A" },
  { slug: "americana", name: "Americana & folk", chart: "americana-folk-albums", tags: ["americana", "folk", "indie folk", "singer-songwriter", "bluegrass"], color: "#7E6A3A" },
  { slug: "christian", name: "Christian", chart: "christian-albums", tags: ["christian", "worship", "ccm", "contemporary christian", "gospel"], color: "#6E9634" },
  { slug: "jazz", name: "Jazz", chart: "jazz-albums", tags: ["jazz", "vocal jazz", "smooth jazz"], color: "#4F6185" },
  { slug: "soundtracks", name: "Soundtracks", chart: "soundtracks", tags: ["soundtrack", "film score", "musical", "show tunes"], color: "#86684F" },
];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+(ep|single)$/i, "").replace(/[^a-z0-9]/g, "");
let user = null;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}
const coverUrl = (id, size = 500) => `${CAA}/${id}/front-${size}`;
const artistName = (credit) => (credit || []).map((c) => c.name + (c.joinphrase || "")).join("");
const fmtLen = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : "");
function fmtDate(d) {
  if (!d) return "Release date unknown";
  const parts = d.split("-");
  if (parts.length === 1) return parts[0];
  const dt = new Date(Date.UTC(+parts[0], +parts[1] - 1, +(parts[2] || 1)));
  return dt.toLocaleDateString("en-US", parts.length === 3 ? { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" });
}
function img(src, alt) {
  return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'No cover'}))">`;
}

/* ---------- Data sources ---------- */
const cache = new Map();
function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
const bigArt = (u) => (u || "").replace(/\/\d+x\d+(bb)?\.(jpg|png)$/, "/600x600bb.jpg");

/* Keep kids, sleep/background, karaoke, tribute and AI-filler records off the
   curated shelves. They can still be searched and rated like anything else. */
const BLOCK_GENRES = /children|kids|lullab|fitness|workout|karaoke|meditation|sleep|white noise|asmr|ai[- ]generated|artificial intelligence/i;
const BLOCK_TEXT = /kidz bop|cocomelon|super simple|pinkfong|baby ?shark|lullab|rockabye baby|for kids|kids'? songs|nursery|toddler|bedtime|sleep music|white noise|rain sounds|karaoke|8-bit|music box|tribute to|in the style of|\bai (generated|music|cover)/i;
const keep = (it) => !BLOCK_GENRES.test(it.genre || "") && !BLOCK_TEXT.test(`${it.title} ${it.artist}`);

/* Listener counts from ListenBrainz, used to rank picks and drop obscure ones */
let chartWeek = null;
function movement(x) {
  if (x.weeks == null && x.lastWeek == null) return "";
  if (x.lastWeek == null) return x.weeks > 1 ? "Back on the chart" : "New this week";
  if (x.lastWeek > x.rank) return `Up ${x.lastWeek - x.rank}`;
  if (x.lastWeek < x.rank) return `Down ${x.rank - x.lastWeek}`;
  return "Holding steady";
}
// Billboard charts through our cached /api/chart endpoint. Official ranks are kept as-is.
async function billboard(slug) {
  const j = await getJSON(CHART(slug));
  if (!j.items?.length) throw new Error(j.error || "Chart unavailable");
  return { name: j.name, week: j.week, items: j.items.filter(keep).map((x) => ({ ...x, why: movement(x) })) };
}
async function topChart() {
  const c = await billboard("billboard-200");
  chartWeek = c.week;
  return c.items;
}
const genreChart = (g) => billboard(g.chart);
function matchGenre(name) {
  const n = String(name || "").toLowerCase();
  return GENRES.find((g) => g.tags.includes(n)) || GENRES.find((g) => g.tags.some((t) => n.includes(t)));
}
const itemHref = (it) => it.id ? `#/album/${it.id}` : `#/find/${encodeURIComponent(it.artist)}/${encodeURIComponent(it.title)}`;

/* ---------- Auth ---------- */
let signingUp = false;
function renderAccount() {
  const el = $("#account");
  if (!sb) { el.innerHTML = ""; return; }
  el.innerHTML = user
    ? `<span class="muted who">${esc(user.email)}</span><button class="btn ghost" id="signOut">Sign out</button>`
    : `<button class="btn primary" id="signIn">Sign in</button>`;
  $("#signIn")?.addEventListener("click", openAuth);
  $("#signOut")?.addEventListener("click", async () => { await sb.auth.signOut(); toast("Signed out"); });
}
function openAuth() {
  setAuthMode(false);
  $("#authError").hidden = true;
  $("#authDialog").showModal();
}
function setAuthMode(up) {
  signingUp = up;
  $("#authTitle").textContent = up ? "Create your account" : "Sign in";
  $("#authSubmit").textContent = up ? "Create account" : "Sign in";
  $("#authToggle").textContent = up ? "I already have an account" : "Create an account instead";
  $("#authPass").autocomplete = up ? "new-password" : "current-password";
}
$("#authToggle").addEventListener("click", () => setAuthMode(!signingUp));
$("#authClose").addEventListener("click", () => $("#authDialog").close());
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#authEmail").value.trim();
  const password = $("#authPass").value;
  const err = $("#authError");
  err.hidden = true;
  $("#authSubmit").disabled = true;
  const { data, error } = signingUp
    ? await sb.auth.signUp({ email, password })
    : await sb.auth.signInWithPassword({ email, password });
  $("#authSubmit").disabled = false;
  if (error) { err.textContent = error.message; err.hidden = false; return; }
  if (signingUp && !data.session) { err.textContent = "Check your email to confirm your account, then sign in."; err.hidden = false; return; }
  $("#authDialog").close();
  toast(signingUp ? "Account created" : "Signed in");
});

/* ---------- Search ---------- */
let searchTimer, searchSeq = 0;
$("#q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $("#results").hidden = true; return; }
  searchTimer = setTimeout(() => search(q), 350);
});
$("#q").addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#results").hidden = true; e.target.blur(); } });
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) $("#results").hidden = true; });

async function search(q) {
  const seq = ++searchSeq;
  const box = $("#results");
  box.hidden = false;
  box.innerHTML = `<p class="muted pad">Searching…</p>`;
  try {
    const data = await getJSON(`${MB}/release-group?query=${encodeURIComponent(`${q} AND primarytype:album`)}&fmt=json&limit=12`);
    if (seq !== searchSeq) return;
    const groups = data["release-groups"] || [];
    if (!groups.length) { box.innerHTML = `<p class="muted pad">No albums match “${esc(q)}”. Try adding the artist name.</p>`; return; }
    box.innerHTML = groups.map((g) => `
      <a class="result" href="#/album/${g.id}">
        ${img(coverUrl(g.id, 250), g.title)}
        <div><strong>${esc(g.title)}</strong><span>${esc(artistName(g["artist-credit"]))}${g["first-release-date"] ? ", " + esc(g["first-release-date"].slice(0, 4)) : ""}</span></div>
      </a>`).join("");
    box.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => { box.hidden = true; $("#q").value = ""; }));
  } catch {
    box.innerHTML = `<p class="error pad">Search is unavailable right now. Try again in a moment.</p>`;
  }
}

/* ---------- Album data ---------- */
async function getAlbum(id) {
  if (sb) {
    const { data } = await sb.from("albums").select("*").eq("id", id).maybeSingle();
    if (data && data.tracks?.length && data.genres?.length) return data;
  }
  const rgRes = await fetch(`${MB}/release-group/${id}?inc=artist-credits+genres&fmt=json`);
  if (!rgRes.ok) throw new Error("Album not found");
  const rg = await rgRes.json();
  const relRes = await fetch(`${MB}/release?release-group=${id}&inc=recordings&status=official&fmt=json&limit=50`);
  const rel = relRes.ok ? await relRes.json() : { releases: [] };
  const releases = (rel.releases || []).filter((r) => r.media?.some((m) => m.tracks?.length));
  releases.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  const pick = releases.find((r) => ["US", "XW", "GB"].includes(r.country)) || releases[0];
  const tracks = [];
  (pick?.media || []).forEach((m, mi) => (m.tracks || []).forEach((t) => tracks.push({
    pos: (pick.media.length > 1 ? `${mi + 1}.` : "") + (t.number || t.position),
    title: t.title, length: t.length || t.recording?.length || null,
  })));
  const genres = (rg.genres || []).sort((a, b) => b.count - a.count).slice(0, 4).map((g) => g.name);
  return {
    id, title: rg.title, artist: artistName(rg["artist-credit"]),
    release_date: rg["first-release-date"] || null, cover_url: coverUrl(id, 500), tracks, genres,
  };
}

/* ---------- Pieces ---------- */
const skeleton = (n, cls = "card") => Array.from({ length: n }, () => `<div class="${cls} sk"><div class="cover"></div><span></span><span></span></div>`).join("");
function card(it, { ranked = false, badge } = {}) {
  return `<a class="card${ranked ? " ranked" : ""}" href="${itemHref(it)}">
    ${ranked ? `<span class="rank" aria-hidden="true">${it.rank}</span>` : ""}
    <div class="cover">${img((it.art || "").replace("/front-500", "/front-250"), `${it.title} cover`)}${badge != null ? `<span class="badge">${badge}</span>` : ""}</div>
    <h3>${ranked ? `<span class="sr">#${it.rank} </span>` : ""}${esc(it.title)}</h3><p>${esc(it.sub || it.artist)}</p>${it.why ? `<p class="why">${esc(it.why)}</p>` : ""}</a>`;
}
const genreTile = (g) => `<a class="genre" href="#/genre/${g.slug}" style="--g:${g.color}"><span>${esc(g.name)}</span></a>`;
function failNote(el, msg) { el.classList.add("note"); el.innerHTML = `<p class="muted">${msg}</p>`; }

/* ---------- Home ---------- */
async function renderHome() {
  document.title = "Rotation";
  $("#view").innerHTML = `
    <section class="hero">
      <h1>What's in rotation.</h1>
      <p>Score every album out of 10, star the standout tracks, and see where everyone else lands.</p>
    </section>

    <section class="shelf">
      <div class="shelf-head"><h2>On the charts</h2><p id="chartsSub">The top albums in the US right now</p></div>
      <div class="row" id="charts">${skeleton(8)}</div>
    </section>

    <section class="shelf" id="recShelf" hidden>
      <div class="shelf-head"><h2>Recommended for you</h2><p id="recWhy"></p></div>
      <div class="row" id="recs">${skeleton(6)}</div>
    </section>

    <section class="shelf">
      <div class="shelf-head"><h2>Browse by genre</h2><p>Billboard's weekly genre album charts</p></div>
      <div class="genres">${GENRES.map(genreTile).join("")}</div>
    </section>

    <section class="shelf">
      <div class="shelf-head"><h2>Top rated on Rotation</h2><p>Highest average scores from everyone using the app</p></div>
      <div class="row" id="community">${skeleton(6)}</div>
    </section>

    <section class="shelf">
      <div class="shelf-head"><h2>Your rankings</h2><p>Everything you've scored, best first</p></div>
      <div id="mine"></div>
    </section>`;
  loadCharts(); loadCommunity(); loadMine(); loadRecs();
}

async function loadCharts() {
  const el = $("#charts");
  try {
    const items = (await topChart()).slice(0, 24);
    if (chartWeek && $("#chartsSub")) $("#chartsSub").textContent = `Billboard 200 for the week of ${fmtDate(chartWeek)}`;
    el.innerHTML = items.map((it) => card(it, { ranked: true })).join("");
  } catch { failNote(el, "Charts couldn't load right now. Refresh to try again."); }
}

async function loadCommunity() {
  const el = $("#community");
  if (!sb) return failNote(el, "Ratings turn on once the app is connected to its database.");
  const { data, error } = await sb.from("album_stats").select("*").order("avg_score", { ascending: false }).order("rating_count", { ascending: false }).limit(24);
  if (error) return failNote(el, esc(error.message));
  if (!data.length) return failNote(el, "No one has rated an album yet. Search for one above and be the first.");
  el.innerHTML = data.map((s) => card({ id: s.album_id, title: s.title, art: s.cover_url, sub: `${s.rating_count} rating${s.rating_count === 1 ? "" : "s"}` }, { badge: s.avg_score })).join("");
}

async function loadMine() {
  const el = $("#mine");
  if (!sb) return;
  if (!user) {
    el.className = "empty";
    el.innerHTML = `Sign in to start ranking your albums.<br><br><button class="btn primary" id="emptySignIn">Sign in</button>`;
    $("#emptySignIn").addEventListener("click", openAuth);
    return;
  }
  const { data, error } = await sb.from("ratings").select("score, album:albums(id,title,artist,cover_url)").order("score", { ascending: false }).order("updated_at", { ascending: false });
  if (error) { el.className = "empty"; el.textContent = error.message; return; }
  if (!data.length) { el.className = "empty"; el.textContent = "You haven't rated anything yet. Pick something from the charts or search above."; return; }
  el.className = "grid";
  el.innerHTML = data.map((r) => card({ id: r.album.id, title: r.album.title, artist: r.album.artist, art: r.album.cover_url }, { badge: r.score })).join("");
}

/* ---------- Recommendations ----------
   Seeds are the albums you rated 7+. For each seed we look up its artists and
   its fine-grained genres on MusicBrainz, then mix three kinds of picks:
   more albums by artists you rate highly, well-tagged albums in the specific
   genres you like, and current chart albums in the broader matching genres. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mbLast = 0;
async function mbSlow(url) {
  // MusicBrainz allows about one request per second
  const key = "mb:" + url;
  try { const hit = sessionStorage.getItem(key); if (hit) return JSON.parse(hit); } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    mbLast = Date.now();
    const r = await fetch(url);
    if (r.status === 503) { await sleep(1500); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    try { sessionStorage.setItem(key, JSON.stringify(j)); } catch {}
    return j;
  }
  throw new Error("MusicBrainz is busy");
}
// Curated MusicBrainz genres first; free-form tags only as backup, minus chart/date/junk tags
const JUNK_TAG = /\d|woche|chart|favou?rite|seen live|owned|wishlist|album|best of|^.{1,2}$/i;
const tagNames = (x) => {
  const rank = (list) => (list || []).filter((t) => t.count > 0).sort((a, b) => b.count - a.count).map((t) => t.name.toLowerCase());
  const g = rank(x.genres);
  const t = rank(x.tags).filter((n) => !JUNK_TAG.test(n) && !g.includes(n));
  return g.length >= 2 ? g : g.concat(t);
};
const isStudioAlbum = (rg) => (rg["primary-type"] || "Album") === "Album" && !(rg["secondary-types"] || []).length;

async function buildRecs(ratings) {
  const ratedKeys = new Set(ratings.map((r) => norm(r.album?.title) + "|" + norm(r.album?.artist)));
  const seeds = ratings.filter((r) => r.album && r.score >= 7).slice(0, 8);
  if (!seeds.length) seeds.push(...ratings.filter((r) => r.album).slice(0, 3));

  // Work out which Billboard genre charts fit your taste
  const weight = new Map(), loved = new Set();
  for (const r of seeds) {
    loved.add(norm(r.album.artist));
    let names = r.album.genres || [];
    if (!names.length) {
      try {
        const rg = await mbSlow(`${MB}/release-group/${r.album.id}?inc=genres+tags&fmt=json`);
        names = tagNames(rg).slice(0, 5);
        const g = (rg.genres || []).sort((a, b) => b.count - a.count).slice(0, 4).map((x) => x.name);
        if (g.length) sb.from("albums").update({ genres: g }).eq("id", r.album.id).then(() => {});
      } catch {}
    }
    names.slice(0, 5).forEach((n, i) => { const g = matchGenre(n); if (g) weight.set(g, (weight.get(g) || 0) + r.score * (5 - i)); });
  }
  const picks = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);

  // Pull those charts plus the Billboard 200
  const lists = await Promise.all(picks.map((g) => genreChart(g)
    .then((c) => c.items.map((x) => ({ ...x, why: `#${x.rank} on ${g.name} albums` }))).catch(() => [])));
  const b200 = await topChart().then((l) => l.map((x) => ({ ...x, why: `#${x.rank} on the Billboard 200` }))).catch(() => []);

  const pool = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) lists.forEach((l) => l[i] && pool.push(l[i]));
  pool.push(...b200);

  const out = [], seen = new Set();
  for (const it of pool) {
    const k = norm(it.title) + "|" + norm(it.artist);
    if (ratedKeys.has(k) || seen.has(k) || !keep(it)) continue;
    seen.add(k);
    if (loved.has(norm(it.artist))) it.why = "From an artist you rate highly";
    out.push(it);
  }
  // Artists you already love first, then by chart position
  out.sort((a, b) => (loved.has(norm(b.artist)) - loved.has(norm(a.artist))));
  return { items: out.slice(0, 18), genres: picks.map((g) => g.name) };
}

async function loadRecs() {
  if (!sb || !user) return;
  const shelf = $("#recShelf");
  if (!shelf) return;
  shelf.hidden = false;
  const el = $("#recs");
  const { data } = await sb.from("ratings").select("score, updated_at, album:albums(id,title,artist,genres)").order("score", { ascending: false }).order("updated_at", { ascending: false });
  const ratings = data || [];
  if (!ratings.length) {
    $("#recWhy").textContent = "Rate a few albums and this fills with picks tuned to your taste";
    try { el.innerHTML = (await topChart()).slice(0, 12).map((it) => card(it)).join(""); } catch { failNote(el, "Recommendations couldn't load right now."); }
    return;
  }
  $("#recWhy").textContent = "Tuning picks to what you've rated highly…";
  const sig = user.id + ":" + ratings.map((r) => r.album?.id + r.score).join(",");
  let recs;
  try { recs = JSON.parse(sessionStorage.getItem("recs4:" + sig) || "null"); } catch {}
  if (!recs) {
    try { recs = await buildRecs(ratings); } catch { recs = { items: [] }; }
    try { sessionStorage.setItem("recs4:" + sig, JSON.stringify(recs)); } catch {}
  }
  if (!$("#recs")) return; // navigated away
  $("#recWhy").textContent = recs.genres?.length
    ? `From this week's Billboard ${recs.genres.join(", ").toLowerCase()} charts, matched to what you rate highly`
    : "From this week's Billboard 200, minus what you've already rated";
  if (!recs.items.length) return failNote(el, "Couldn't find recommendations right now. Refresh to try again.");
  el.innerHTML = recs.items.map((it) => card(it)).join("");
}

/* ---------- Genre page ---------- */
async function renderGenre(slug) {
  const g = GENRES.find((x) => x.slug === slug);
  if (!g) return renderHome();
  document.title = `${g.name} on Rotation`;
  $("#view").innerHTML = `
    <section class="genre-head" style="--g:${g.color}">
      <a href="#/" class="back">All genres</a>
      <h1>${esc(g.name)}</h1>
      <p id="gsub">This week's Billboard chart</p>
    </section>
    <div class="chips">${GENRES.filter((x) => x !== g).map((x) => `<a href="#/genre/${x.slug}" style="--g:${x.color}">${esc(x.name)}</a>`).join("")}</div>
    <div class="grid ranked-grid" id="glist">${skeleton(12)}</div>`;
  const el = $("#glist");
  try {
    const c = await genreChart(g);
    if ($("#gsub")) $("#gsub").textContent = `Billboard ${c.name.replace(/^Billboard\s*/i, "")}${c.week ? `, week of ${fmtDate(c.week)}` : ""}`;
    el.innerHTML = c.items.map((it) => card(it, { ranked: true })).join("");
  } catch { el.className = ""; failNote(el, "This Billboard chart couldn't load right now. Refresh to try again."); }
}

/* ---------- Chart item → album page ---------- */
async function resolveFind(artist, title) {
  $("#view").innerHTML = `<p class="loading">Finding the record…</p>`;
  const clean = title.replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+(EP|Single)$/i, "").trim();
  const q = (s) => s.replace(/["\\]/g, "\\$&");
  try {
    let j = await getJSON(`${MB}/release-group?query=${encodeURIComponent(`releasegroup:"${q(clean)}" AND artist:"${q(artist)}"`)}&fmt=json&limit=5`);
    let rg = (j["release-groups"] || [])[0];
    if (!rg) {
      j = await getJSON(`${MB}/release-group?query=${encodeURIComponent(`${clean} ${artist}`)}&fmt=json&limit=5`);
      rg = (j["release-groups"] || [])[0];
    }
    if (rg) return location.replace(`#/album/${rg.id}`);
  } catch {}
  $("#view").innerHTML = `<div class="empty">Couldn't match “${esc(title)}” by ${esc(artist)} to an album page yet. Try searching for it above.</div>`;
}

/* ---------- Album page ---------- */
function recordSvg(score) {
  const rings = Array.from({ length: 10 }, (_, i) => {
    const r = 80 - i * 4.6;
    return `<circle class="groove ${score && 10 - i <= score ? "on" : ""}" cx="84" cy="84" r="${r}"/>`;
  }).join("");
  return `<svg class="record" viewBox="0 0 168 168" role="img" aria-label="${score ? `Your score: ${score} out of 10` : "Not rated yet"}">
    ${rings}<circle class="label" cx="84" cy="84" r="30"/>
    <text class="num" x="84" y="84" text-anchor="middle" dominant-baseline="central">${score || "–"}</text></svg>`;
}
function tintFrom(src) {
  const im = new Image();
  im.crossOrigin = "anonymous";
  im.onload = () => {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 12;
      const x = c.getContext("2d"); x.drawImage(im, 0, 0, 12, 12);
      const d = x.getImageData(0, 0, 12, 12).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const w = 1 + (mx - mn) / 32; // favor saturated pixels
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
      }
      const page = $(".album-page");
      if (page) page.style.setProperty("--tint", `rgb(${Math.round(r / n)} ${Math.round(g / n)} ${Math.round(b / n)})`);
    } catch {}
  };
  im.src = src;
}

async function renderAlbum(id) {
  const v = $("#view");
  v.innerHTML = `<p class="loading">Pulling up the record…</p>`;
  let album;
  try { album = await getAlbum(id); } catch { v.innerHTML = `<div class="empty">That album couldn't be found. Try searching for it again.</div>`; return; }
  document.title = `${album.title} by ${album.artist} on Rotation`;

  let mine = null, stats = null;
  if (sb) {
    const [{ data: s }, r] = await Promise.all([
      sb.from("album_stats").select("avg_score, rating_count").eq("album_id", id).maybeSingle(),
      user ? sb.from("ratings").select("*").eq("album_id", id).eq("user_id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    stats = s; mine = r.data;
  }
  const state = { score: mine?.score || 0, standouts: new Set(mine?.standout_tracks || []) };
  const genreLinks = [...new Map((album.genres || []).map((n) => [n, matchGenre(n)])).entries()];

  v.innerHTML = `
    <article class="album-page">
      <div class="album">
        <div class="art">${img(album.cover_url, `${album.title} cover`)}</div>
        <div>
          <h1>${esc(album.title)}</h1>
          <p class="artist">${esc(album.artist)}</p>
          <p class="date">${esc(fmtDate(album.release_date))}</p>
          ${genreLinks.length ? `<div class="chips small">${genreLinks.map(([n, g]) => g ? `<a href="#/genre/${g.slug}" style="--g:${g.color}">${esc(n)}</a>` : `<span>${esc(n)}</span>`).join("")}</div>` : ""}

          <div class="scores">
            <div id="rec">${recordSvg(state.score)}</div>
            <div>
              <p class="picker-title">Your score</p>
              <div class="picker" id="picker">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-s="${i + 1}" aria-pressed="${state.score === i + 1}">${i + 1}</button>`).join("")}</div>
              <p class="community">${stats ? `<strong>${stats.avg_score}</strong> average from ${stats.rating_count} rating${stats.rating_count === 1 ? "" : "s"}` : "No ratings from anyone yet."}</p>
            </div>
          </div>

          <h2 class="section-title">Tracklist</h2>
          <p class="muted hint">Star the standout tracks.</p>
          ${album.tracks?.length ? `<ol class="tracks" id="tracks">${album.tracks.map((t) => `
            <li class="${state.standouts.has(t.title) ? "standout" : ""}">
              <span class="pos">${esc(t.pos)}</span><span class="title">${esc(t.title)}</span>
              <span class="len">${fmtLen(t.length)}</span>
              <button type="button" class="star" data-t="${esc(t.title)}" aria-pressed="${state.standouts.has(t.title)}" aria-label="Mark ${esc(t.title)} as a standout">★</button>
            </li>`).join("")}</ol>` : `<p class="muted">No tracklist is listed for this album.</p>`}

          <h2 class="section-title">Your thoughts</h2>
          <textarea id="thoughts" placeholder="What stuck with you? Favorite moments, how it holds up, where it fits in your rotation.">${esc(mine?.thoughts || "")}</textarea>

          <div class="save-row">
            <button class="btn primary" id="save">${mine ? "Update rating" : "Save rating"}</button>
            ${mine ? `<button class="btn ghost" id="remove">Remove rating</button>` : ""}
          </div>
        </div>
      </div>
    </article>`;
  tintFrom(album.cover_url);

  $("#picker").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.score = +b.dataset.s;
    $("#picker").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    $("#rec").innerHTML = recordSvg(state.score);
  });
  $("#tracks")?.addEventListener("click", (e) => {
    const b = e.target.closest(".star"); if (!b) return;
    const t = b.dataset.t, on = !state.standouts.has(t);
    on ? state.standouts.add(t) : state.standouts.delete(t);
    b.setAttribute("aria-pressed", on);
    b.closest("li").classList.toggle("standout", on);
  });
  $("#save").addEventListener("click", async () => {
    if (!sb) return toast("Ratings turn on once the database is connected");
    if (!user) return openAuth();
    if (!state.score) return toast("Pick a score from 1 to 10 first");
    $("#save").disabled = true;
    const { error: aErr } = await sb.from("albums").upsert({
      id: album.id, title: album.title, artist: album.artist, release_date: album.release_date,
      cover_url: album.cover_url, tracks: album.tracks, genres: album.genres || [],
    });
    const { error } = aErr ? { error: aErr } : await sb.from("ratings").upsert({
      user_id: user.id, album_id: album.id, score: state.score,
      standout_tracks: [...state.standouts], thoughts: $("#thoughts").value.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,album_id" });
    $("#save").disabled = false;
    if (error) return toast(error.message);
    toast(mine ? "Rating updated" : "Rating saved");
    renderAlbum(id);
  });
  $("#remove")?.addEventListener("click", async () => {
    if (!confirm("Remove your rating for this album?")) return;
    const { error } = await sb.from("ratings").delete().eq("id", mine.id);
    if (error) return toast(error.message);
    toast("Rating removed");
    renderAlbum(id);
  });
}

/* ---------- Router ---------- */
function route() {
  const h = location.hash;
  window.scrollTo(0, 0);
  let m;
  if ((m = h.match(/^#\/album\/([0-9a-f-]{36})/i))) return renderAlbum(m[1]);
  if ((m = h.match(/^#\/genre\/([a-z-]+)/))) return renderGenre(m[1]);
  if ((m = h.match(/^#\/find\/([^/]+)\/(.+)$/))) return resolveFind(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  renderHome();
}
window.addEventListener("hashchange", route);

/* On phones, tuck the header away while scrolling down and bring it back on scroll up */
let lastY = 0;
window.addEventListener("scroll", () => {
  const y = window.scrollY, bar = $(".bar");
  if (!window.matchMedia("(max-width: 760px)").matches) return bar.classList.remove("tucked");
  if (!$("#results").hidden) return;
  bar.classList.toggle("tucked", y > lastY && y > 120);
  lastY = y;
}, { passive: true });

(async function start() {
  if (sb) {
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    sb.auth.onAuthStateChange((_e, session) => {
      const changed = (session?.user?.id || null) !== (user?.id || null);
      user = session?.user || null;
      renderAccount();
      if (changed) route();
    });
  }
  renderAccount();
  route();
})();
