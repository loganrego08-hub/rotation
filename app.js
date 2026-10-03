/* Rotation — rate and rank albums */
const cfg = window.ROTATION_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
const sb = configured ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const MB = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org/release-group";
const APPLE_TOP = "https://rss.applemarketingtools.com/api/v2/us/music/most-played/50/albums.json";
const ITUNES = (genre, n = 50) => `https://itunes.apple.com/us/rss/topalbums/limit=${n}/${genre ? `genre=${genre}/` : ""}json`;

const GENRES = [
  { slug: "pop", name: "Pop", apple: 14, tags: ["pop", "dance-pop", "synth-pop", "electropop"], color: "#D9467E" },
  { slug: "hip-hop", name: "Hip-hop & rap", apple: 18, tags: ["hip hop", "rap", "trap", "conscious hip hop"], color: "#E07A1F" },
  { slug: "rnb", name: "R&B & soul", apple: 15, tags: ["r&b", "rnb", "soul", "contemporary r&b", "neo soul"], color: "#9B45C9" },
  { slug: "alternative", name: "Alternative", apple: 20, tags: ["alternative", "indie", "indie rock", "alternative rock", "indie pop", "shoegaze"], color: "#2A9483" },
  { slug: "rock", name: "Rock", apple: 21, tags: ["rock", "hard rock", "classic rock", "punk"], color: "#C93A2B" },
  { slug: "country", name: "Country", apple: 6, tags: ["country", "americana", "folk"], color: "#B78A2E" },
  { slug: "electronic", name: "Electronic", apple: 7, tags: ["electronic", "house", "techno", "edm", "ambient", "dance"], color: "#3570E0" },
  { slug: "jazz", name: "Jazz", apple: 11, tags: ["jazz"], color: "#4F6185" },
  { slug: "christian", name: "Christian & gospel", apple: 22, tags: ["christian", "gospel", "worship", "ccm"], color: "#6E9634" },
  { slug: "latin", name: "Latin", apple: 12, tags: ["latin", "reggaeton", "latin pop"], color: "#D9593A" },
  { slug: "metal", name: "Metal", apple: 1153, tags: ["metal", "heavy metal", "metalcore", "death metal"], color: "#454A55" },
  { slug: "classical", name: "Classical", apple: 5, tags: ["classical", "orchestral"], color: "#86684F" },
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

async function itunesChart(genreId, n = 50) {
  const j = await getJSON(ITUNES(genreId, n));
  let e = j.feed?.entry || [];
  if (!Array.isArray(e)) e = [e];
  return e.map((x, i) => ({
    rank: i + 1, title: x["im:name"].label, artist: x["im:artist"].label,
    art: bigArt(x["im:image"]?.at(-1)?.label), genre: x.category?.attributes?.label || "",
  }));
}
async function mbGenreChart(g) {
  const q = `tag:"${g.tags[0]}" AND primarytype:album AND status:official`;
  const j = await getJSON(`${MB}/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=40`);
  return (j["release-groups"] || []).map((x, i) => ({ rank: i + 1, id: x.id, title: x.title, artist: artistName(x["artist-credit"]), art: coverUrl(x.id, 250) }));
}
async function topChart() {
  try {
    const j = await getJSON(APPLE_TOP);
    return j.feed.results.map((x, i) => ({ rank: i + 1, title: x.name, artist: x.artistName, art: bigArt(x.artworkUrl100), genre: x.genres?.[0]?.name || "" }));
  } catch {
    return itunesChart(null);
  }
}
async function genreChart(g) {
  try { const r = await itunesChart(g.apple); if (r.length) return r; } catch {}
  return mbGenreChart(g);
}
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
    <div class="cover">${img(it.art, `${it.title} cover`)}${badge != null ? `<span class="badge">${badge}</span>` : ""}</div>
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
      <div class="shelf-head"><h2>On the charts</h2><p>The most played albums in the US right now</p></div>
      <div class="row" id="charts">${skeleton(8)}</div>
    </section>

    <section class="shelf" id="recShelf" hidden>
      <div class="shelf-head"><h2>Recommended for you</h2><p id="recWhy"></p></div>
      <div class="row" id="recs">${skeleton(6)}</div>
    </section>

    <section class="shelf">
      <div class="shelf-head"><h2>Browse by genre</h2><p>Top albums in each genre, updated daily</p></div>
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
const tagNames = (x) => [...(x.genres || []), ...(x.tags || [])]
  .filter((t) => t.count > 0).sort((a, b) => b.count - a.count).map((t) => t.name.toLowerCase());
const isStudioAlbum = (rg) => (rg["primary-type"] || "Album") === "Album" && !(rg["secondary-types"] || []).length;

async function buildRecs(ratings) {
  const ratedIds = new Set(ratings.map((r) => r.album?.id));
  const ratedKeys = new Set(ratings.map((r) => norm(r.album?.title) + "|" + norm(r.album?.artist)));
  const seeds = ratings.filter((r) => r.album && r.score >= 7).slice(0, 6);
  if (!seeds.length) seeds.push(...ratings.filter((r) => r.album).slice(0, 3));

  const artistWeight = new Map(); // mbid -> {name, w}
  const genreWeight = new Map();  // genre -> weight
  for (const r of seeds) {
    let rg;
    try { rg = await mbSlow(`${MB}/release-group/${r.album.id}?inc=artist-credits+genres+tags&fmt=json`); } catch { continue; }
    (rg["artist-credit"] || []).slice(0, 2).forEach((c) => {
      const a = artistWeight.get(c.artist.id) || { name: c.artist.name, w: 0 };
      a.w += r.score; artistWeight.set(c.artist.id, a);
    });
    let tags = tagNames(rg);
    if (tags.length < 2 && rg["artist-credit"]?.[0]) {
      try { tags = tags.concat(tagNames(await mbSlow(`${MB}/artist/${rg["artist-credit"][0].artist.id}?inc=genres+tags&fmt=json`))); } catch {}
    }
    tags.slice(0, 5).forEach((t, i) => genreWeight.set(t, (genreWeight.get(t) || 0) + r.score * (5 - i)));
    // Fill in genres for albums saved before genres were tracked
    const g = (rg.genres || []).sort((a, b) => b.count - a.count).slice(0, 4).map((x) => x.name);
    if (g.length && !(r.album.genres || []).length) sb.from("albums").update({ genres: g }).eq("id", r.album.id).then(() => {});
  }

  const byArtist = [], byTag = [], byChart = [];
  const topArtists = [...artistWeight.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, 3);
  for (const [mbid, a] of topArtists) {
    try {
      const j = await mbSlow(`${MB}/release-group?artist=${mbid}&type=album&limit=50&fmt=json`);
      (j["release-groups"] || []).filter(isStudioAlbum)
        .sort((x, y) => (y["first-release-date"] || "").localeCompare(x["first-release-date"] || ""))
        .slice(0, 4)
        .forEach((x) => byArtist.push({ id: x.id, title: x.title, artist: a.name, art: coverUrl(x.id, 250), why: `More from ${a.name}` }));
    } catch {}
  }
  const generic = new Set(["rock", "pop", "electronic", "hip hop", "rap", "jazz", "soul", "alternative", "indie", "american", "british", "english"]);
  const topTags = [...genreWeight.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
    .sort((a, b) => generic.has(a) - generic.has(b)).slice(0, 3);
  for (const t of topTags) {
    try {
      const q = `tag:"${t.replace(/["\\]/g, "")}" AND primarytype:album AND status:official`;
      const j = await mbSlow(`${MB}/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=25`);
      (j["release-groups"] || []).filter(isStudioAlbum).slice(0, 8)
        .forEach((x) => byTag.push({ id: x.id, title: x.title, artist: artistName(x["artist-credit"]), art: coverUrl(x.id, 250), why: `Because you like ${t}` }));
    } catch {}
  }
  const broad = [...new Set(topTags.concat([...genreWeight.keys()]).map(matchGenre).filter(Boolean))].slice(0, 2);
  for (const g of broad) {
    try { (await itunesChart(g.apple, 25)).forEach((x) => byChart.push({ ...x, why: `Popular in ${g.name.toLowerCase()}` })); } catch {}
  }

  const out = [], seen = new Set();
  const take = (it) => {
    if (!it) return;
    const k = norm(it.title) + "|" + norm(it.artist);
    if ((it.id && ratedIds.has(it.id)) || ratedKeys.has(k) || seen.has(k)) return;
    seen.add(k); out.push(it);
  };
  const max = Math.max(byArtist.length, byTag.length, byChart.length);
  for (let i = 0; i < max && out.length < 18; i++) { take(byArtist[i]); take(byTag[i]); take(byChart[i]); }
  return { items: out, artists: topArtists.map(([, a]) => a.name), tags: topTags };
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
  try { recs = JSON.parse(sessionStorage.getItem("recs:" + sig) || "null"); } catch {}
  if (!recs) {
    try { recs = await buildRecs(ratings); } catch { recs = { items: [] }; }
    try { sessionStorage.setItem("recs:" + sig, JSON.stringify(recs)); } catch {}
  }
  if (!$("#recs")) return; // navigated away
  const bits = [];
  if (recs.artists?.length) bits.push(recs.artists.slice(0, 2).join(" and "));
  if (recs.tags?.length) bits.push(recs.tags.slice(0, 2).join(" and "));
  $("#recWhy").textContent = bits.length ? `Based on your love of ${bits.join(", plus ")}` : "Based on what you've rated highly";
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
      <p>The top albums in ${esc(g.name.toLowerCase())} right now</p>
    </section>
    <div class="chips">${GENRES.filter((x) => x !== g).map((x) => `<a href="#/genre/${x.slug}" style="--g:${x.color}">${esc(x.name)}</a>`).join("")}</div>
    <div class="grid ranked-grid" id="glist">${skeleton(12)}</div>`;
  const el = $("#glist");
  try {
    const items = await genreChart(g);
    if (!items.length) throw new Error();
    el.innerHTML = items.map((it) => card(it, { ranked: true })).join("");
  } catch { el.className = ""; failNote(el, "This genre's chart couldn't load right now. Refresh to try again."); }
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
