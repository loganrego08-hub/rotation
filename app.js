/* Rotation: rate and rank albums */
const cfg = window.ROTATION_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
const sb = configured ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const MB = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org/release-group";
const CHART = (slug) => `/api/chart?slug=${slug}`;

// Every genre is one of Billboard's weekly album charts
const GENRES = [
  { slug: "hip-hop", name: "Hip-hop & R&B", chart: "r-b-hip-hop-albums", tags: ["hip hop", "rap", "trap", "r&b", "rnb", "soul", "neo soul", "contemporary r&b"] },
  { slug: "rap", name: "Rap", chart: "rap-albums", tags: ["rap", "hip hop", "trap", "conscious hip hop", "gangsta rap"] },
  { slug: "country", name: "Country", chart: "top-country-albums", tags: ["country", "country pop", "contemporary country", "bro-country"] },
  { slug: "rock", name: "Rock", chart: "top-rock-albums", tags: ["rock", "classic rock", "pop rock", "punk", "pop punk"] },
  { slug: "alternative", name: "Alternative", chart: "alternative-albums", tags: ["alternative", "indie", "indie rock", "alternative rock", "indie pop", "shoegaze", "emo"] },
  { slug: "hard-rock", name: "Hard rock & metal", chart: "hard-rock-albums", tags: ["metal", "heavy metal", "hard rock", "metalcore", "death metal", "nu metal"] },
  { slug: "electronic", name: "Dance & electronic", chart: "dance-electronic-albums", tags: ["electronic", "house", "techno", "edm", "dance", "dubstep", "synth-pop"] },
  { slug: "latin", name: "Latin", chart: "latin-albums", tags: ["latin", "reggaeton", "latin pop", "regional mexican", "corridos"] },
  { slug: "americana", name: "Americana & folk", chart: "americana-folk-albums", tags: ["americana", "folk", "indie folk", "singer-songwriter", "bluegrass"] },
  { slug: "christian", name: "Christian", chart: "christian-albums", tags: ["christian", "worship", "ccm", "contemporary christian", "gospel"] },
  { slug: "jazz", name: "Jazz", chart: "jazz-albums", tags: ["jazz", "vocal jazz", "smooth jazz"] },
  { slug: "soundtracks", name: "Soundtracks", chart: "soundtracks", tags: ["soundtrack", "film score", "musical", "show tunes"] },
];

/* ==========================================================================
   Utilities
   ========================================================================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+(ep|single)$/i, "").replace(/[^a-z0-9]/g, "");
const coverUrl = (id, size = 500) => `${CAA}/${id}/front-${size}`;
const artistName = (credit) => (credit || []).map((c) => c.name + (c.joinphrase || "")).join("");
const fmtLen = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const year = (d) => (d ? String(d).slice(0, 4) : "");
let user = null;

function fmtDate(d, style = "long") {
  if (!d) return "";
  const parts = String(d).slice(0, 10).split("-");
  if (parts.length === 1) return parts[0];
  const dt = new Date(Date.UTC(+parts[0], +parts[1] - 1, +(parts[2] || 1)));
  const opts = parts.length === 3 ? { month: style, day: "numeric", year: "numeric", timeZone: "UTC" } : { month: style, year: "numeric", timeZone: "UTC" };
  return dt.toLocaleDateString("en-US", opts);
}

/* ==========================================================================
   Data sources
   ========================================================================== */
const cache = new Map();
function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

/* Keep kids, sleep/background, karaoke, tribute and AI-filler records off the
   curated shelves. They can still be searched and rated like anything else. */
const BLOCK_GENRES = /children|kids|lullab|fitness|workout|karaoke|meditation|sleep|white noise|asmr|ai[- ]generated|artificial intelligence/i;
const BLOCK_TEXT = /kidz bop|cocomelon|super simple|pinkfong|baby ?shark|lullab|rockabye baby|for kids|kids'? songs|nursery|toddler|bedtime|sleep music|white noise|rain sounds|karaoke|8-bit|music box|tribute to|in the style of|\bai (generated|music|cover)/i;
const keep = (it) => !BLOCK_GENRES.test(it.genre || "") && !BLOCK_TEXT.test(`${it.title} ${it.artist}`);

function movement(x) {
  if (x.weeks == null && x.lastWeek == null) return null;
  if (x.lastWeek == null) return x.weeks > 1 ? { kind: "re", text: "Re-entry" } : { kind: "new", text: "New this week" };
  if (x.lastWeek > x.rank) return { kind: "up", text: `Up ${x.lastWeek - x.rank}` };
  if (x.lastWeek < x.rank) return { kind: "down", text: `Down ${x.rank - x.lastWeek}` };
  return { kind: "same", text: x.weeks ? `${plural(x.weeks, "week")} on chart` : "Holding steady" };
}
async function billboard(slug) {
  const j = await getJSON(CHART(slug));
  if (!j.items?.length) throw new Error(j.error || "Chart unavailable");
  return { name: j.name, week: j.week, items: j.items.filter(keep).map((x) => ({ ...x, move: movement(x) })) };
}
const genreChart = (g) => billboard(g.chart);
function matchGenre(name) {
  const n = String(name || "").toLowerCase();
  return GENRES.find((g) => g.tags.includes(n)) || GENRES.find((g) => g.tags.some((t) => n.includes(t)));
}
const albumHref = (it) => it.id ? `#/album/${it.id}` : `#/find/${encodeURIComponent(it.artist)}/${encodeURIComponent(it.title)}`;

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
const JUNK_TAG = /\d|woche|chart|favou?rite|seen live|owned|wishlist|album|best of|^.{1,2}$/i;
const tagNames = (x) => {
  const rank = (list) => (list || []).filter((t) => t.count > 0).sort((a, b) => b.count - a.count).map((t) => t.name.toLowerCase());
  const g = rank(x.genres);
  const t = rank(x.tags).filter((n) => !JUNK_TAG.test(n) && !g.includes(n));
  return g.length >= 2 ? g : g.concat(t);
};
const isStudioAlbum = (rg) => (rg["primary-type"] || "Album") === "Album" && !(rg["secondary-types"] || []).length;

async function getAlbum(id) {
  if (sb) {
    const { data } = await sb.from("albums").select("*").eq("id", id).maybeSingle();
    if (data && data.tracks?.length && data.genres?.length) return data;
  }
  const rgRes = await fetch(`${MB}/release-group/${id}?inc=artist-credits+genres&fmt=json`);
  if (!rgRes.ok) throw new Error(rgRes.status === 404 ? "notfound" : "unavailable");
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
  return {
    id, title: rg.title, artist: artistName(rg["artist-credit"]), artist_id: rg["artist-credit"]?.[0]?.artist?.id,
    release_date: rg["first-release-date"] || null, cover_url: coverUrl(id, 500), tracks,
    genres: (rg.genres || []).sort((a, b) => b.count - a.count).slice(0, 4).map((g) => g.name),
    album_type: typeLabel(rg) || null,
  };
}
// "Studio album", "EP", "Compilation album", "Live album"... only what MusicBrainz actually lists
function typeLabel(rg) {
  const p = rg["primary-type"], s = rg["secondary-types"] || [];
  return s.length ? `${s.join(" + ")}${p ? " " + p.toLowerCase() : ""}` : p === "Album" ? "Studio album" : p || "";
}

/* ==========================================================================
   Components
   Each returns an HTML string so views stay declarative.
   ========================================================================== */
const ICONS = {
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  spark: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  note: '<path d="M6 4h9l3 3v13H6z"/><path d="M9 11h6M9 15h4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  bookmark: '<path d="M7 4h10v16l-5-3.5L7 20z"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  pin: '<path d="M12 17v5M8 3h8l-1 6 3 3H6l3-3z"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/>',
};
const icon = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

function button(label, { variant = "secondary", size, id, href, iconName, attrs = "" } = {}) {
  const cls = `btn btn--${variant}${size ? ` btn--${size}` : ""}`;
  const inner = `${iconName ? icon(iconName) : ""}<span>${esc(label)}</span>`;
  return href ? `<a class="${cls}" href="${href}" ${id ? `id="${id}"` : ""} ${attrs}>${inner}</a>`
              : `<button type="button" class="${cls}" ${id ? `id="${id}"` : ""} ${attrs}>${inner}</button>`;
}

function artwork(src, alt, cls = "") {
  const fallback = `<div class="art__fallback">${icon("disc")}</div>`;
  if (!src) return `<div class="art ${cls}" role="img" aria-label="${esc(alt)}">${fallback}</div>`;
  return `<div class="art ${cls}"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async"
    onerror="this.parentNode.insertAdjacentHTML('beforeend', this.dataset.fb); this.remove()" data-fb="${esc(fallback)}"></div>`;
}
const smallArt = (u) => (u || "").replace("/front-500", "/front-250");

function scoreChip(value, { mine = false, count, label } = {}) {
  if (value == null) return "";
  const title = label || (mine ? "Your score" : count != null ? `Average of ${plural(count, "rating")}` : "Average score");
  return `<span class="score${mine ? " score--mine" : ""}" title="${title}"><span class="sr">${title}: </span>${value}<small>/10</small></span>`;
}

function metaLine(text, kind) {
  if (!text) return "";
  const ic = { up: "up", down: "down", new: "spark" }[kind];
  return `<span class="meta${kind ? ` meta--${kind}` : ""}">${ic ? icon(ic) : ""}<span>${esc(text)}</span></span>`;
}

function albumCard(it, { rank, score, mine = false, count, scoreLabel, meta, metaKind } = {}) {
  const m = meta != null ? { text: meta, kind: metaKind } : it.move ? { text: it.move.text, kind: it.move.kind } : it.why ? { text: it.why } : null;
  const foot = (m || score != null) ? `<div class="album-card__foot">${m ? metaLine(m.text, m.kind) : "<span></span>"}${scoreChip(score, { mine, count, label: scoreLabel })}</div>` : "";
  return `<a class="album-card${rank ? " album-card__ranked" : ""}" href="${albumHref(it)}">
    ${artwork(smallArt(it.art), `${it.title} by ${it.artist || "unknown artist"}`)}
    <div class="album-card__body">
      <div class="album-card__top">${rank ? `<span class="album-card__rank"><span class="sr">Number </span>${rank}</span>` : ""}<span class="album-card__title">${esc(it.title)}</span></div>
      ${it.artist ? `<span class="album-card__artist">${esc(it.artist)}</span>` : ""}
      ${foot}
    </div></a>`;
}

function artistCard(a) {
  return `<a class="artist-card" href="#/artist/${a.id}">
    <div class="artist-card__img" aria-hidden="true">${esc((a.name || "?").trim().charAt(0).toUpperCase())}</div>
    <div><div class="artist-card__name">${esc(a.name)}</div>${a.sub ? `<div class="t-meta">${esc(a.sub)}</div>` : ""}</div></a>`;
}

function listCard(r, rank) {
  const a = r.album;
  return `<a class="list-card" href="#/album/${a.id}">
    <span class="list-card__rank">${rank}</span>
    ${artwork(smallArt(a.cover_url), `${a.title} by ${a.artist}`, "thumb")}
    <span class="list-card__text"><span class="list-card__title">${esc(a.title)}</span><span class="list-card__sub">${esc(a.artist)}${r.thoughts ? " · has notes" : ""}</span></span>
    ${scoreChip(r.score, { mine: true })}</a>`;
}

function reviewCard({ name, date, score, body, standouts = [], mine = false, href }) {
  return `<article class="review-card">
    <header class="review-card__head">
      <span class="avatar" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>
      <span class="review-card__who">${href ? `<a href="${href}"><strong>${esc(name)}</strong></a>` : `<strong>${esc(name)}</strong>`}<span class="t-meta">${date ? `Reviewed ${fmtDate(String(date).slice(0, 10), "short")}` : ""}</span></span>
      ${scoreChip(score, { mine, label: mine ? undefined : "Reviewer's score" })}
    </header>
    <p class="review-card__body${body ? "" : " review-card__body--empty"}">${body ? esc(body) : "No notes yet. Add a few thoughts below."}</p>
    ${standouts.length ? `<div class="chips">${standouts.map((t) => `<span class="chip chip--static">${icon("star")}${esc(t)}</span>`).join("")}</div>` : ""}
  </article>`;
}

function profileHeader({ initial, avatar, eyebrow, name, stats = [], extra = "" }) {
  return `<header class="profile">
    ${avatar || `<span class="avatar avatar--lg" aria-hidden="true">${esc(initial)}</span>`}
    <div>
      ${eyebrow ? `<p class="profile__eyebrow">${esc(eyebrow)}</p>` : ""}
      <h1 class="t-title">${esc(name)}</h1>
      ${stats.length ? `<dl class="profile__stats">${stats.map((s) => `<div class="stat"><dt class="stat__label">${esc(s.label)}</dt><dd class="stat__value"${s.id ? ` id="${s.id}"` : ""} style="margin:0">${esc(s.value)}</dd></div>`).join("")}</dl>` : ""}
      ${extra}
    </div></header>`;
}

function sectionHead(title, { sub, link, linkLabel, id } = {}) {
  return `<div class="section__head"><div class="section__titles"><h2 class="t-section">${esc(title)}</h2>${sub != null ? `<p class="t-meta" ${id ? `id="${id}"` : ""}>${esc(sub)}</p>` : ""}</div>
    ${link ? `<a class="section__link" href="${link}">${esc(linkLabel)}${icon("chevron")}</a>` : ""}</div>`;
}

function emptyState({ iconName = "disc", title, body, actions = "", compact = false, plain = false }) {
  return `<div class="state${compact ? " state--compact" : ""}${plain ? " state--plain" : ""}">
    <span class="state__icon">${icon(iconName)}</span>
    <p class="state__title">${esc(title)}</p>
    ${body ? `<p class="state__body">${esc(body)}</p>` : ""}
    ${actions ? `<div class="state__actions">${actions}</div>` : ""}</div>`;
}
const retries = new Map();
function errorState({ title = "Something went wrong", body = "Check your connection and try again.", retry, compact = true } = {}) {
  const id = retry ? `r${Math.random().toString(36).slice(2, 8)}` : "";
  if (retry) retries.set(id, retry);
  return `<div class="state state--error${compact ? " state--compact" : ""}" role="alert">
    <span class="state__icon">${icon("alert")}</span>
    <p class="state__title">${esc(title)}</p><p class="state__body">${esc(body)}</p>
    ${retry ? `<div class="state__actions"><button type="button" class="btn btn--sm" data-retry="${id}">${icon("refresh")}<span>Try again</span></button></div>` : ""}</div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-retry]");
  if (b && retries.has(b.dataset.retry)) { retries.get(b.dataset.retry)(); retries.delete(b.dataset.retry); }
});

const skCards = (n) => Array.from({ length: n }, () =>
  `<div class="sk-card" aria-hidden="true"><div class="sk art"></div><div class="sk sk-line" style="width:82%"></div><div class="sk sk-line" style="width:56%"></div></div>`).join("");
const skList = (n) => `<div class="list" aria-hidden="true">${Array.from({ length: n }, () =>
  `<div class="list-card"><span></span><div class="sk art thumb"></div><span style="display:grid;gap:6px"><span class="sk sk-line" style="width:60%"></span><span class="sk sk-line" style="width:35%"></span></span><span></span></div>`).join("")}</div>`;
const loadingLabel = (text) => `<p class="sr" role="status">${esc(text)}</p>`;

function toast(message, kind = "success") {
  const wrap = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.innerHTML = `${icon(kind === "error" ? "alert" : kind === "success" ? "check" : "disc")}<span>${esc(message)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add("is-leaving"); setTimeout(() => el.remove(), 250); }, 2600);
}

function tabs(items, active, name) {
  return `<div class="tabs" role="tablist" aria-label="${esc(name)}">${items.map(([key, label]) =>
    `<button type="button" class="tab" role="tab" data-tab="${key}" aria-selected="${key === active}">${esc(label)}</button>`).join("")}</div>`;
}

function genreCard(g) {
  return `<a class="genre-card" href="#/genre/${g.slug}" data-genre="${g.slug}">
    <div class="genre-card__covers">${Array.from({ length: 3 }, () => `<div class="sk art"></div>`).join("")}</div>
    <div><div class="genre-card__name">${esc(g.name)}</div><div class="genre-card__top">Loading this week's chart</div></div></a>`;
}
function fillGenreCards(root = document) {
  $$("[data-genre]", root).forEach(async (el) => {
    const g = GENRES.find((x) => x.slug === el.dataset.genre);
    try {
      const c = await genreChart(g);
      if (!el.isConnected) return;
      $(".genre-card__covers", el).innerHTML = c.items.slice(0, 3).map((it) => artwork(it.art, `${it.title} by ${it.artist}`)).join("");
      $(".genre-card__top", el).textContent = `#1 ${c.items[0].title}, ${c.items[0].artist}`;
    } catch {
      $(".genre-card__covers", el).innerHTML = Array.from({ length: 3 }, () => artwork("", "")).join("");
      $(".genre-card__top", el).textContent = "Chart unavailable right now";
    }
  });
}

/* ==========================================================================
   Account: nav avatar, dropdown, sign-in dialog
   ========================================================================== */
// Only ever shown to the signed-in user themselves (the email prefix is a private fallback, never published)
const displayName = () => profile?.display_name || profile?.username || (user?.email || "You").split("@")[0];
function renderAccount() {
  const el = $("#account");
  if (!sb) { el.innerHTML = ""; return; }
  if (!user) { el.innerHTML = button("Sign in", { variant: "primary", size: "sm", id: "signIn" }); $("#signIn").onclick = openAuth; return; }
  el.innerHTML = `<button type="button" class="avatar" id="acctBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">${profile?.avatar_cover ? `<img src="${esc(smallArt(profile.avatar_cover))}" alt="" onerror="this.remove()">` : esc(displayName().charAt(0).toUpperCase())}</button>
    <div class="menu menu--account" id="acctMenu" role="menu" hidden>
      <div class="menu__label">${esc(user.email)}</div>
      <a class="menu__item" role="menuitem" href="#/me">${icon("disc")}Your shelf</a>
      <a class="menu__item" role="menuitem" href="${profile ? profileHref(profile.username) : "#/me/edit"}">${icon("user")}${profile ? "Your profile" : "Create profile"}</a>
      <a class="menu__item" role="menuitem" href="#/lists/yours">${icon("list")}Your lists</a>
      <button type="button" class="menu__item" role="menuitem" id="signOut">${icon("logout")}Sign out</button>
    </div>`;
  const btn = $("#acctBtn"), menu = $("#acctMenu");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); if (!menu.hidden) $(".menu__item", menu).focus(); };
  menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); btn.focus(); } });
  document.addEventListener("click", (e) => { if (!e.target.closest(".nav__account")) close(); });
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
  $("#signOut").onclick = async () => { close(); await sb.auth.signOut(); toast("Signed out", "info"); };
}
let signingUp = false;
function openAuth() { setAuthMode(false); $("#authError").hidden = true; $("#authDialog").showModal(); $("#authEmail").focus(); }
function setAuthMode(up) {
  signingUp = up;
  $("#authTitle").textContent = up ? "Create your account" : "Sign in";
  $("#authSubmit").textContent = up ? "Create account" : "Sign in";
  $("#authToggle").textContent = up ? "I already have an account" : "Create an account instead";
  $("#authPass").autocomplete = up ? "new-password" : "current-password";
}
$("#authToggle").onclick = () => setAuthMode(!signingUp);
$("#authClose").onclick = () => $("#authDialog").close();
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#authError"), submit = $("#authSubmit");
  err.hidden = true; submit.setAttribute("aria-busy", "true");
  const email = $("#authEmail").value.trim(), password = $("#authPass").value;
  const { data, error } = signingUp ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
  submit.removeAttribute("aria-busy");
  if (error) { err.textContent = error.message; err.hidden = false; return; }
  if (signingUp && !data.session) { err.className = "alert alert--warning"; err.textContent = "Check your email to confirm your account, then sign in."; err.hidden = false; return; }
  $("#authDialog").close();
  toast(signingUp ? "Account created" : "Signed in");
});

/* ==========================================================================
   Search dropdown with keyboard navigation
   ========================================================================== */
/* Two modes share one form: "menu" (hero) shows a dropdown and Enter opens the
   full results page; "page" (the Search view) renders results inline. */
let searchTimer, searchSeq = 0;
const searchHref = (term) => `#/search${term ? "/" + encodeURIComponent(term) : ""}`;
const searchForm = ({ mode, value = "", cls = "" }) => `<form class="search ${cls}" role="search" data-searchform>
  ${icon("search", "search__icon")}
  <input class="input input--search" type="search" data-search="${mode}" value="${esc(value)}" placeholder="Search albums and artists" autocomplete="off" aria-label="Search albums and artists"${mode === "menu" ? ' aria-expanded="false"' : ""}>
  ${mode === "menu" ? `<div class="menu menu--search" role="listbox" hidden></div>` : ""}</form>`;
const searchInput = (e) => e.target.closest?.("[data-search]");
const menuOf = (input) => input.closest(".search")?.querySelector(".menu--search");
function setResults(input, open) {
  const m = menuOf(input);
  if (!m) return;
  m.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
}
document.addEventListener("input", (e) => {
  const input = searchInput(e);
  if (!input) return;
  clearTimeout(searchTimer);
  const v = input.value.trim();
  if (input.dataset.search === "page") { searchTimer = setTimeout(() => pageSearch(v, true), 350); return; }
  if (v.length < 2) return setResults(input, false);
  searchTimer = setTimeout(() => search(input, v), 320);
});
document.addEventListener("keydown", (e) => {
  const input = searchInput(e);
  if (!input || input.dataset.search !== "menu") return;
  const menu = menuOf(input);
  const items = $$(".menu__item", menu);
  const i = items.findIndex((x) => x.getAttribute("aria-selected") === "true");
  if (e.key === "Escape") { setResults(input, false); input.blur(); }
  if (!items.length || menu.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((x, k) => x.setAttribute("aria-selected", String(k === n)));
    items[n].scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter" && i >= 0) { e.preventDefault(); items[i].click(); }
});
document.addEventListener("submit", (e) => {
  const form = e.target.closest?.("[data-searchform]");
  if (!form) return;
  e.preventDefault();
  const input = $("[data-search]", form), v = input.value.trim();
  if (v.length < 2) return input.focus();
  clearTimeout(searchTimer);
  if (input.dataset.search === "page") return pageSearch(v, true);
  setResults(input, false);
  location.hash = searchHref(v);
});
document.addEventListener("click", (e) => {
  $$(".menu--search").forEach((m) => { if (!m.hidden && !m.closest(".search").contains(e.target)) setResults($("[data-search]", m.closest(".search")), false); });
  const link = e.target.closest(".menu--search a");
  if (link) { const input = $("[data-search]", link.closest(".search")); setResults(input, false); input.value = ""; }
});

async function fetchSearch(term, artists, albums) {
  const [a, g] = await Promise.all([
    getJSON(`${MB}/artist?query=${encodeURIComponent(term)}&fmt=json&limit=${artists}`).catch(() => ({ artists: [] })),
    getJSON(`${MB}/release-group?query=${encodeURIComponent(`${term} AND primarytype:album`)}&fmt=json&limit=${albums}`),
  ]);
  return { ar: (a.artists || []).filter((x) => x.score >= 90), al: g["release-groups"] || [] };
}

async function pageSearch(term, replace = false) {
  const el = $("#sres");
  if (!el) return;
  const seq = ++searchSeq;
  if (replace) history.replaceState(null, "", searchHref(term));
  if (term.length < 2) {
    el.innerHTML = emptyState({ iconName: "search", title: "Search Rotation", body: "Find any album or artist, open it, and give it a score.", compact: true });
    return;
  }
  el.innerHTML = `${loadingLabel("Searching")}<div class="grid">${skCards(8)}</div>`;
  try {
    const { ar, al } = await fetchSearch(term, 6, 24);
    if (seq !== searchSeq || !el.isConnected) return;
    if (!ar.length && !al.length) {
      el.innerHTML = emptyState({ iconName: "search", title: `No matches for “${term}”`, body: "Try the artist and album together, or check the spelling.", compact: true });
      return;
    }
    el.innerHTML = `
      ${ar.length ? `<section class="section">${sectionHead("Artists")}<div class="grid grid--artists">${ar.map((a) =>
        artistCard({ id: a.id, name: a.name, sub: [a.type, a.area?.name].filter(Boolean).join(", ") })).join("")}</div></section>` : ""}
      ${al.length ? `<section class="section">${sectionHead("Albums")}<div class="grid">${al.map((g) =>
        albumCard({ id: g.id, title: g.title, artist: artistName(g["artist-credit"]), art: coverUrl(g.id, 250) }, { meta: year(g["first-release-date"]) || null })).join("")}</div></section>` : ""}`;
  } catch {
    if (seq === searchSeq && el.isConnected) el.innerHTML = errorState({ title: "Search is unavailable", body: "MusicBrainz may be busy. Try again in a moment.", retry: () => pageSearch(term) });
  }
}

async function search(input, term) {
  const seq = ++searchSeq, results = menuOf(input);
  setResults(input, true);
  results.innerHTML = `<p class="menu__note">Searching…</p>`;
  try {
    const { ar, al } = await fetchSearch(term, 3, 6);
    if (seq !== searchSeq) return;
    if (!ar.length && !al.length) { results.innerHTML = `<p class="menu__note">No matches for “${esc(term)}”. Try the artist and album together.</p>`; return; }
    results.innerHTML = `
      ${ar.length ? `<div class="menu__group"><div class="menu__label">Artists</div>${ar.map((a) => `
        <a class="menu__item" role="option" href="#/artist/${a.id}"><span class="avatar" aria-hidden="true">${esc(a.name.charAt(0).toUpperCase())}</span>
        <span class="menu__text"><strong>${esc(a.name)}</strong><span>${esc([a.type, a.area?.name].filter(Boolean).join(", ") || "Artist")}</span></span></a>`).join("")}</div>` : ""}
      ${al.length ? `<div class="menu__group"><div class="menu__label">Albums</div>${al.map((g) => `
        <a class="menu__item" role="option" href="#/album/${g.id}">${artwork(coverUrl(g.id, 250), g.title, "thumb")}
        <span class="menu__text"><strong>${esc(g.title)}</strong><span>${esc(artistName(g["artist-credit"]))}${g["first-release-date"] ? `, ${year(g["first-release-date"])}` : ""}</span></span></a>`).join("")}</div>` : ""}
      <div class="menu__group"><a class="menu__item" role="option" href="${searchHref(term)}">${icon("search")}<span class="menu__text"><strong>See all results for “${esc(term)}”</strong></span></a></div>`;
  } catch {
    if (seq === searchSeq) results.innerHTML = `<p class="menu__note">Search is unavailable right now. Try again in a moment.</p>`;
  }
}

/* ==========================================================================
   Views
   ========================================================================== */
const view = () => $("#view");
async function myRatings(fields = "score, standout_tracks, thoughts, updated_at, created_at, album:albums(id,title,artist,cover_url,genres)") {
  if (!sb || !user) return [];
  const { data, error } = await sb.from("ratings").select(fields).order("score", { ascending: false }).order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []).filter((r) => r.album);
}

/* ---------- Discover (home) ----------
   Every section is fed by real data: community ratings from Supabase and this
   week's Billboard charts. When there isn't enough community activity yet, a
   section says so and falls back to charts. Nothing is invented. */
const MIN_RATINGS = 3;       // ratings an album needs before it counts as "highest rated"
const keyOf = (it) => norm(it.title) + "|" + norm(it.artist);

function memo(key, fn) {
  if (!cache.has(key)) { const p = fn(); cache.set(key, p); p.catch(() => cache.delete(key)); }
  return cache.get(key);
}
// Ordered by a confidence-adjusted score (a Bayesian average) so one 10/10 can't outrank an album that many people rate 9.
// Each row still carries the plain average (avg_score) and rating_count, which are what the UI displays.
const communityStats = () => memo("m:stats", async () => {
  if (!sb) return [];
  let { data, error } = await sb.from("album_rankings").select("*").order("weighted_score", { ascending: false }).order("rating_count", { ascending: false }).limit(200);
  if (error) ({ data, error } = await sb.from("album_stats").select("*").order("avg_score", { ascending: false }).order("rating_count", { ascending: false }).limit(200));
  if (error) throw error;
  return data || [];
});
const RANKING_NOTE = `Albums need ${MIN_RATINGS}+ ratings. Order uses a confidence-adjusted score, so a few ratings count for less. The score shown is the plain average.`;
// Views added in schema v3. If they haven't been created yet, treat them as empty.
const optionalView = (name, build) => memo("m:" + name, async () => {
  if (!sb) return [];
  const { data, error } = await build(sb.from(name));
  return error ? [] : data || [];
});
const statCard = (s, opts = {}) => albumCard({ id: s.album_id, title: s.title, artist: s.artist, art: s.cover_url },
  { score: s.avg_score, count: s.rating_count, meta: plural(s.rating_count, "rating"), ...opts });
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts)) / 60000));
  if (m < 60) return m <= 1 ? "Just now" : `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} hr ago`;
  const d = Math.round(m / 1440);
  return d === 1 ? "Yesterday" : d < 14 ? `${d} days ago` : fmtDate(String(ts).slice(0, 10), "short");
}
const lazy = (el, fn) => {
  if (!("IntersectionObserver" in window)) return fn();
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { rootMargin: "400px 0px" });
  io.observe(el);
};

function homeSection(id, title, sub, { link, linkLabel } = {}) {
  return `<section class="section" id="${id}" aria-labelledby="${id}-h">
    ${sectionHead(title, { sub, link, linkLabel, id: `${id}-sub` }).replace("<h2", `<h2 id="${id}-h"`)}
    <div class="section__body">${loadingLabel(`Loading ${title}`)}<div class="row">${skCards(7)}</div></div></section>`;
}
// load() resolves to { sub?, cards: [html], empty?: { title, body, actions } } and may throw
function runSection(id, load, { defer = false } = {}) {
  const sec = $(`#${id}`);
  if (!sec) return;
  const run = async () => {
    const body = $(".section__body", sec);
    try {
      const r = await load();
      if (!sec.isConnected) return;
      if (r.sub != null) $(`#${id}-sub`).textContent = r.sub;
      body.innerHTML = r.cards?.length ? `<div class="row">${r.cards.join("")}</div>`
        : emptyState({ iconName: "disc", compact: true, ...r.empty });
    } catch {
      if (!sec.isConnected) return;
      body.innerHTML = errorState({ title: "This section didn't load", body: "Check your connection and try again.",
        retry: () => { body.innerHTML = `<div class="row">${skCards(7)}</div>`; run(); } });
    }
  };
  defer ? lazy(sec, run) : run();
}

async function loadTrending() {
  const act = await optionalView("album_activity", (t) => t.select("*").order("recent_count", { ascending: false }).order("recent_avg", { ascending: false }).limit(24));
  if (act.length >= 4) {
    return { sub: "Most rated by the community in the past 7 days",
      cards: act.map((s) => albumCard({ id: s.album_id, title: s.title, artist: s.artist, art: s.cover_url },
        { score: s.recent_avg, count: s.recent_count, meta: `${plural(s.recent_count, "rating")} this week` })) };
  }
  const c = await billboard("billboard-200");
  const movers = c.items.filter((x) => x.lastWeek != null && x.lastWeek - x.rank >= 1).sort((a, b) => (b.lastWeek - b.rank) - (a.lastWeek - a.rank)).slice(0, 14);
  const list = movers.length >= 4 ? movers : c.items.slice(0, 14);
  return { sub: movers.length >= 4 ? "Climbing the Billboard 200 this week. Community activity takes over as more people rate."
                                   : "Leading the Billboard 200 this week. Community activity takes over as more people rate.",
    cards: list.map((it) => albumCard(it)) };
}

async function loadNewReleases() {
  const charts = (await Promise.all([billboard("billboard-200"), ...GENRES.slice(0, 6).map(genreChart)].map((p) => p.catch(() => null)))).filter(Boolean);
  if (!charts.length) throw new Error("charts unavailable");
  const seen = new Set(), fresh = [];
  for (const c of charts) for (const it of c.items) {
    if (it.weeks == null || it.weeks > 4 || seen.has(keyOf(it))) continue;
    seen.add(keyOf(it));
    fresh.push(it);
  }
  fresh.sort((a, b) => a.weeks - b.weeks);
  return {
    sub: "Debuted on Billboard's charts in the last four weeks",
    cards: fresh.slice(0, 18).map((it) => albumCard(it, it.weeks <= 1 ? { meta: "Debuted this week", metaKind: "new" } : { meta: `Week ${it.weeks} on the charts` })),
    empty: { title: "No fresh debuts right now", body: "New albums land on the charts every Tuesday. Check back then.",
      actions: button("Browse the charts", { href: "#/lists/charts" }) },
  };
}

async function loadHighest() {
  const top = (await communityStats()).filter((s) => s.rating_count >= MIN_RATINGS).slice(0, 24);
  if (top.length) return { sub: RANKING_NOTE, cards: top.map((s, i) => statCard(s, { rank: i + 1 })) };
  const c = await billboard("billboard-200");
  return { sub: `Albums need ${MIN_RATINGS}+ ratings to rank here. Until then, the most popular albums right now.`,
    cards: c.items.slice(0, 14).map((it) => albumCard(it, { rank: it.rank })) };
}

async function loadRadar() {
  const few = (await communityStats()).filter((s) => s.rating_count < MIN_RATINGS && s.avg_score >= 8)
    .sort((a, b) => b.avg_score - a.avg_score || b.rating_count - a.rating_count).slice(0, 24);
  if (few.length) return { sub: `Scoring 8 or higher, with fewer than ${MIN_RATINGS} ratings so far`, cards: few.map((s) => statCard(s)) };
  const c = await billboard("billboard-200");
  return { sub: "No early community favorites yet. Deeper cuts from the Billboard 200 in the meantime.",
    cards: c.items.slice(25, 41).map((it) => albumCard(it, { rank: it.rank })) };
}

const COMPILATION = /\b(best of|greatest hits|the very best|anthology|essential|collection|hits)\b/i;
// Albums charting in a genre but absent from the Billboard 200: popular with their audience, missed by the mainstream
async function loadGems() {
  const picks = ["alternative", "americana", "electronic", "jazz", "hard-rock", "latin"].map((s) => GENRES.find((g) => g.slug === s));
  const main = await billboard("billboard-200").then((c) => new Set(c.items.map(keyOf))).catch(() => new Set());
  const lists = (await Promise.all(picks.map((g) => genreChart(g)
    .then((c) => c.items.filter((x) => !main.has(keyOf(x)) && !COMPILATION.test(x.title)).slice(0, 4).map((x) => ({ ...x, move: null, why: `#${x.rank} in ${g.name}` })))
    .catch(() => null)))).filter(Boolean);
  if (!lists.length) throw new Error("charts unavailable");
  const out = [], seen = new Set();
  for (let i = 0; i < 4; i++) lists.forEach((l) => { const it = l[i]; if (it && !seen.has(keyOf(it))) { seen.add(keyOf(it)); out.push(it); } });
  return { sub: "Charting with their own audiences, but missing from the Billboard 200",
    cards: out.slice(0, 18).map((it) => albumCard(it)),
    empty: { title: "No hidden gems this week", body: "Try browsing by genre instead.", actions: button("Explore genres", { href: "#/explore" }) } };
}

async function loadRecent() {
  const rows = await optionalView("recent_ratings", (t) => t.select("*").order("rated_at", { ascending: false }).limit(40));
  const seen = new Set(), list = [];
  for (const r of rows) if (!seen.has(r.album_id)) { seen.add(r.album_id); list.push(r); }
  return {
    sub: "Latest scores from the community. Notes stay private.",
    cards: list.slice(0, 18).map((r) => albumCard({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url },
      { score: r.score, scoreLabel: "A community rating", meta: `Rated ${ago(r.rated_at)}` })),
    empty: { iconName: "star", title: "No ratings yet", body: "When people start scoring albums, the latest ones show up here.",
      actions: button("Find an album to rate", { variant: "primary", href: "#/search", iconName: "search" }) },
  };
}

async function loadHeroMosaic() {
  const el = $("#mosaic");
  if (!el) return;
  try {
    const c = await billboard("billboard-200");
    if (!el.isConnected) return;
    const top = c.items.filter((x) => x.art).slice(0, 6);
    if (top.length < 6) throw new Error("not enough art");
    el.innerHTML = top.map((it) => `<a class="hero__cover" href="${albumHref(it)}" title="${esc(it.title)}, ${esc(it.artist)}">${artwork(it.art, `${it.title} by ${it.artist}`)}</a>`).join("");
  } catch { el?.closest(".hero")?.classList.add("hero--solo"); el?.remove(); }
}

const decadeGrid = () => `<div class="decades">${DECADES.map((d) =>
  `<a class="decade-card" href="#/decade/${d.start}"><span class="decade-card__num">${d.start}s</span><span class="decade-card__sub">${d.start}–${d.start + 9}</span></a>`).join("")}</div>`;

async function renderHome() {
  document.title = "Rotation";
  ["m:stats", "m:album_activity", "m:recent_ratings"].forEach((k) => cache.delete(k));
  view().innerHTML = `
    <section class="hero">
      <div class="hero__copy">
        <h1 class="t-hero">Find your next rotation.</h1>
        <p class="t-lead">Discover something new. Rate what moves you.</p>
        ${searchForm({ mode: "menu", cls: "search--hero" })}
        <nav class="chips" aria-label="Browse genres">${GENRES.slice(0, 5).map((g) => `<a class="chip" href="#/genre/${g.slug}">${esc(g.name)}</a>`).join("")}<a class="chip" href="#/explore">More</a></nav>
      </div>
      <div class="hero__mosaic" id="mosaic" aria-label="Top albums on this week's Billboard 200">${Array.from({ length: 6 }, () => `<div class="sk art"></div>`).join("")}</div>
    </section>
    <section class="section" id="recShelf" hidden>
      ${sectionHead("Recommended for you", { sub: "", id: "recWhy" })}
      <div class="row" id="recs">${skCards(6)}</div>
    </section>
    ${homeSection("sec-trending", "Trending this week", "", { link: "#/lists/charts", linkLabel: "Charts" })}
    ${homeSection("sec-new", "New releases", "", { link: "#/lists/charts", linkLabel: "Charts" })}
    ${homeSection("sec-top", "Highest rated", "", { link: "#/lists/community", linkLabel: "Full list" })}
    ${homeSection("sec-radar", "Under the radar", "", { link: "#/lists/community", linkLabel: "Top rated" })}
    <section class="section" id="sec-genres" aria-labelledby="sec-genres-h">
      ${sectionHead("Explore by genre", { sub: "Billboard's weekly album charts", link: "#/explore", linkLabel: "Explore all" }).replace("<h2", '<h2 id="sec-genres-h"')}
      <div class="genres">${GENRES.slice(0, 6).map(genreCard).join("")}</div>
    </section>
    <section class="section" aria-labelledby="sec-decades-h">
      ${sectionHead("Explore by decade", { sub: "Landmark albums and community picks from every era", link: "#/explore", linkLabel: "Explore all" }).replace("<h2", '<h2 id="sec-decades-h"')}
      ${decadeGrid()}
    </section>
    ${homeSection("sec-gems", "Hidden gems", "", { link: "#/explore", linkLabel: "Explore" })}
    ${homeSection("sec-recent", "Recently reviewed", "", { link: "#/search", linkLabel: "Find albums" })}`;
  loadHeroMosaic();
  loadRecs();
  runSection("sec-trending", loadTrending);
  runSection("sec-new", loadNewReleases, { defer: true });
  runSection("sec-top", loadHighest, { defer: true });
  runSection("sec-radar", loadRadar, { defer: true });
  lazy($("#sec-genres"), () => fillGenreCards($("#sec-genres")));
  runSection("sec-gems", loadGems, { defer: true });
  runSection("sec-recent", loadRecent, { defer: true });
}

/* ---------- Explore: genres and decades ---------- */
function renderExplore() {
  document.title = "Explore · Rotation";
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Explore</h1><p class="t-lead">Browse by genre, or travel through the decades.</p></header>
    <section class="section">${sectionHead("By genre", { sub: "Billboard's weekly album charts, updated every Tuesday" })}
      <div class="genres">${GENRES.map(genreCard).join("")}</div></section>
    <section class="section">${sectionHead("By decade", { sub: "Landmark albums and what's rated on Rotation" })}${decadeGrid()}</section>`;
  fillGenreCards(view());
}

// Real, well-known albums for each decade. Artwork comes from Apple; opening one resolves it in MusicBrainz.
const DECADES = [
  { start: 1960, albums: [["The Beach Boys", "Pet Sounds", 1966], ["The Beatles", "Revolver", 1966], ["Bob Dylan", "Highway 61 Revisited", 1965], ["The Jimi Hendrix Experience", "Are You Experienced", 1967], ["The Velvet Underground", "The Velvet Underground & Nico", 1967], ["John Coltrane", "A Love Supreme", 1965], ["Aretha Franklin", "I Never Loved a Man the Way I Love You", 1967], ["Van Morrison", "Astral Weeks", 1968], ["The Beatles", "Abbey Road", 1969], ["The Rolling Stones", "Let It Bleed", 1969]] },
  { start: 1970, albums: [["Fleetwood Mac", "Rumours", 1977], ["Marvin Gaye", "What's Going On", 1971], ["Pink Floyd", "The Dark Side of the Moon", 1973], ["Stevie Wonder", "Songs in the Key of Life", 1976], ["Joni Mitchell", "Blue", 1971], ["Led Zeppelin", "Led Zeppelin IV", 1971], ["Patti Smith", "Horses", 1975], ["Bob Dylan", "Blood on the Tracks", 1975], ["David Bowie", "Low", 1977], ["Bob Marley & The Wailers", "Exodus", 1977]] },
  { start: 1980, albums: [["Michael Jackson", "Thriller", 1982], ["Prince", "Purple Rain", 1984], ["U2", "The Joshua Tree", 1987], ["Paul Simon", "Graceland", 1986], ["Pixies", "Doolittle", 1989], ["Beastie Boys", "Paul's Boutique", 1989], ["R.E.M.", "Murmur", 1983], ["N.W.A", "Straight Outta Compton", 1988], ["Guns N' Roses", "Appetite for Destruction", 1987], ["The Smiths", "The Queen Is Dead", 1986]] },
  { start: 1990, albums: [["Radiohead", "OK Computer", 1997], ["Nirvana", "Nevermind", 1991], ["Lauryn Hill", "The Miseducation of Lauryn Hill", 1998], ["Nas", "Illmatic", 1994], ["My Bloody Valentine", "Loveless", 1991], ["Portishead", "Dummy", 1994], ["Björk", "Homogenic", 1997], ["Wu-Tang Clan", "Enter the Wu-Tang (36 Chambers)", 1993], ["Dr. Dre", "The Chronic", 1992], ["The Smashing Pumpkins", "Siamese Dream", 1993]] },
  { start: 2000, albums: [["Radiohead", "Kid A", 2000], ["The Strokes", "Is This It", 2001], ["Kanye West", "The College Dropout", 2004], ["Arcade Fire", "Funeral", 2004], ["Amy Winehouse", "Back to Black", 2006], ["Outkast", "Stankonia", 2000], ["Daft Punk", "Discovery", 2001], ["Wilco", "Yankee Hotel Foxtrot", 2002], ["Madvillain", "Madvillainy", 2004], ["Animal Collective", "Merriweather Post Pavilion", 2009]] },
  { start: 2010, albums: [["Kendrick Lamar", "To Pimp a Butterfly", 2015], ["Frank Ocean", "Channel Orange", 2012], ["Kanye West", "My Beautiful Dark Twisted Fantasy", 2010], ["Beyoncé", "Lemonade", 2016], ["Tame Impala", "Currents", 2015], ["Daft Punk", "Random Access Memories", 2013], ["Alabama Shakes", "Sound & Color", 2015], ["Tyler, the Creator", "IGOR", 2019], ["Weyes Blood", "Titanic Rising", 2019], ["Angel Olsen", "Burn Your Fire for No Witness", 2014]] },
  { start: 2020, albums: [["Taylor Swift", "folklore", 2020], ["Phoebe Bridgers", "Punisher", 2020], ["Olivia Rodrigo", "SOUR", 2021], ["Beyoncé", "RENAISSANCE", 2022], ["Kendrick Lamar", "Mr. Morale & the Big Steppers", 2022], ["SZA", "SOS", 2022], ["Bad Bunny", "Un Verano Sin Ti", 2022], ["Charli xcx", "BRAT", 2024], ["Tyler, the Creator", "CHROMAKOPIA", 2024], ["Beyoncé", "COWBOY CARTER", 2024]] },
];

async function appleArt(artist, title) {
  const key = "art:" + norm(artist) + "|" + norm(title);
  try { const hit = sessionStorage.getItem(key); if (hit !== null) return hit || null; } catch {}
  let art = null;
  try {
    const qs = new URLSearchParams({ term: `${artist} ${title}`, entity: "album", country: "us", limit: "5" });
    const j = await getJSON(`https://itunes.apple.com/search?${qs}`);
    const a = norm(artist).slice(0, 6), t = norm(title).slice(0, 8);
    const hit = (j.results || []).find((x) => norm(x.artistName).startsWith(a) && norm(x.collectionName).startsWith(t));
    if (hit) art = hit.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/, "/600x600bb.jpg");
  } catch {}
  if (!art) {
    // Apple doesn't carry every catalog album; fall back to the Cover Art Archive via MusicBrainz
    try {
      const lq = (s) => s.replace(/["\\]/g, "\\$&");
      const j = await mbSlow(`${MB}/release-group?query=${encodeURIComponent(`releasegroup:"${lq(title)}" AND artist:"${lq(artist)}" AND primarytype:album`)}&fmt=json&limit=1`);
      const id = j["release-groups"]?.[0]?.id;
      if (id) art = coverUrl(id, 500);
    } catch { return null; }
  }
  try { sessionStorage.setItem(key, art || ""); } catch {}
  return art;
}

async function renderDecade(start) {
  const d = DECADES.find((x) => x.start === start);
  if (!d) return renderNotFound();
  document.title = `${start}s · Rotation`;
  const short = String(start).slice(2);
  view().innerHTML = `
    <header class="page-head"><p class="t-meta">${start}–${start + 9}</p><h1 class="t-title">${start}s</h1></header>
    <nav class="chips" aria-label="Other decades" style="margin-bottom:var(--s-8)">${DECADES.map((x) =>
      `<a class="chip" href="#/decade/${x.start}" ${x === d ? 'aria-current="page"' : ""}>${x.start}s</a>`).join("")}</nav>
    <section class="section" id="dec-rated">${sectionHead("Rated on Rotation", { sub: `Community scores for albums released in the ${short}s`, id: "dec-rated-sub" })}
      <div class="section__body"><div class="row">${skCards(6)}</div></div></section>
    <section class="section">${sectionHead("Landmark albums", { sub: "A curated starting point for the decade" })}
      <div class="grid" id="dec-land">${d.albums.map(([artist, title, yr]) => albumCard({ title, artist }, { meta: String(yr) })).join("")}</div></section>`;
  d.albums.forEach(([artist, title], i) => appleArt(artist, title).then((url) => {
    const slot = url && $$("#dec-land .album-card .art")[i];
    if (slot?.isConnected) slot.outerHTML = artwork(url, `${title} by ${artist}`);
  }));
  const body = $("#dec-rated .section__body");
  const emptyRated = () => emptyState({ iconName: "star", compact: true, title: `No ${start}s albums rated yet`,
    body: "Rate one from this decade and it shows up here for everyone.", actions: button("Search albums", { href: "#/search", iconName: "search" }) });
  if (!sb) { body.innerHTML = emptyRated(); return; }
  const { data, error } = await sb.from("album_stats").select("*").gte("release_date", String(start)).lt("release_date", String(start + 10))
    .order("avg_score", { ascending: false }).order("rating_count", { ascending: false }).limit(24);
  if (!body.isConnected) return;
  body.innerHTML = error ? errorState({ title: "Couldn't load community scores", retry: () => renderDecade(start) })
    : data.length ? `<div class="row">${data.map((s) => statCard(s)).join("")}</div>` : emptyRated();
}

/* ---------- Lists ---------- */
async function renderLists(tab) {
  if (!["charts", "community", "mine", "yours"].includes(tab)) tab = "charts";
  document.title = "Lists · Rotation";
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Lists</h1><p class="t-lead">Ranked lists from the charts, the community and your own shelf. Make your own and share them.</p></header>
    ${tabs([["charts", "Charts"], ["community", "Top rated"], ["mine", "Your ranking"], ["yours", "My lists"]], tab, "Lists")}
    <div id="lbody">${loadingLabel("Loading list")}<div class="grid">${skCards(8)}</div></div>`;
  $$("[data-tab]").forEach((b) => b.onclick = () => { location.hash = `#/lists/${b.dataset.tab}`; });
  const el = $("#lbody");
  const fail = () => { if (el.isConnected) el.innerHTML = errorState({ title: "This list didn't load", retry: () => renderLists(tab), compact: false }); };
  if (tab === "charts") {
    try {
      const c = await billboard("billboard-200");
      if (!el.isConnected) return;
      el.innerHTML = `<section class="section">${sectionHead("Billboard 200", { sub: c.week ? `Week of ${fmtDate(c.week)}` : "" })}
        <div class="grid">${c.items.map((it) => albumCard(it, { rank: it.rank })).join("")}</div></section>
        <section class="section">${sectionHead("More charts", { sub: "One for every genre" })}
        <nav class="chips" aria-label="Genre charts">${GENRES.map((g) => `<a class="chip" href="#/genre/${g.slug}">${esc(g.name)}</a>`).join("")}</nav></section>`;
    } catch { fail(); }
  } else if (tab === "community") {
    try {
      const top = (await communityStats()).filter((s) => s.rating_count >= MIN_RATINGS).slice(0, 50);
      if (!el.isConnected) return;
      el.innerHTML = top.length
        ? `<section class="section">${sectionHead("Top rated on Rotation", { sub: RANKING_NOTE })}
            <div class="grid">${top.map((s, i) => statCard(s, { rank: i + 1 })).join("")}</div></section>`
        : emptyState({ iconName: "star", title: "No album has enough ratings yet", body: `Albums need ${MIN_RATINGS} ratings to appear here. Score a few and help build the list.`,
            actions: button("Browse the charts", { variant: "primary", href: "#/lists/charts" }) });
    } catch { fail(); }
  } else if (tab === "yours") {
    await renderMyLists(el);
  } else if (!sb || !user) {
    el.innerHTML = emptyState({ iconName: "user", title: "Your ranking lives here", body: "Sign in to keep a ranked list of everything you've scored.",
      actions: button("Sign in", { variant: "primary", id: "listSignIn" }) });
    $("#listSignIn")?.addEventListener("click", openAuth);
  } else {
    try {
      const rows = await myRatings();
      if (!el.isConnected) return;
      el.innerHTML = rows.length ? `<div class="list">${rows.map((r, i) => listCard(r, i + 1)).join("")}</div>`
        : emptyState({ iconName: "disc", title: "Nothing ranked yet", body: "Score an album and it lands here, ordered by your rating.",
            actions: button("Search albums", { variant: "primary", href: "#/search", iconName: "search" }) });
    } catch { fail(); }
  }
}

/* ---------- Search ---------- */
function renderSearch(term) {
  document.title = "Search · Rotation";
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Search</h1><p class="t-lead">Find any album or artist, then give it a score.</p></header>
    ${searchForm({ mode: "page", value: term, cls: "search--hero" })}
    <div id="sres" style="margin-top:var(--s-10)"></div>`;
  pageSearch(term);
  if (!term) $("[data-search]").focus();
}

/* ---------- Recommendations: Billboard charts matched to your taste ---------- */
async function buildRecs(ratings) {
  const ratedKeys = new Set(ratings.map((r) => norm(r.album?.title) + "|" + norm(r.album?.artist)));
  const seeds = ratings.filter((r) => r.score >= 7).slice(0, 8);
  if (!seeds.length) seeds.push(...ratings.slice(0, 3));
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
  const lists = await Promise.all(picks.map((g) => genreChart(g).then((c) => c.items.map((x) => ({ ...x, move: null, why: `#${x.rank} in ${g.name}` }))).catch(() => [])));
  const b200 = await billboard("billboard-200").then((c) => c.items.map((x) => ({ ...x, move: null, why: `#${x.rank} on the Billboard 200` }))).catch(() => []);
  const pool = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) lists.forEach((l) => l[i] && pool.push(l[i]));
  pool.push(...b200);
  const out = [], seen = new Set();
  for (const it of pool) {
    const k = norm(it.title) + "|" + norm(it.artist);
    if (ratedKeys.has(k) || seen.has(k) || !keep(it)) continue;
    seen.add(k);
    if (loved.has(norm(it.artist))) it.why = "An artist you rate highly";
    out.push(it);
  }
  out.sort((a, b) => loved.has(norm(b.artist)) - loved.has(norm(a.artist)));
  return { items: out.slice(0, 18), genres: picks.map((g) => g.name) };
}
async function loadRecs() {
  if (!sb || !user) return;
  const shelf = $("#recShelf");
  if (!shelf) return;
  shelf.hidden = false;
  const el = $("#recs");
  let ratings = [];
  try { ratings = await myRatings("score, updated_at, album:albums(id,title,artist,genres)"); } catch {}
  if (ratings.length < 3) {
    const need = 3 - ratings.length;
    $("#recWhy").textContent = "Tuned to the genres you score highest";
    if (el.isConnected) el.outerHTML = `<div id="recs">${emptyState({ iconName: "star", compact: true,
      title: ratings.length ? `Rate ${plural(need, "more album")} to unlock picks` : "Rate three albums to unlock picks",
      body: "We match this week's charts to what you score highly.",
      actions: button("Search albums", { variant: "primary", href: "#/search", iconName: "search" }) })}</div>`;
    return;
  }
  $("#recWhy").textContent = "Matching this week's charts to what you rate highly…";
  const sig = user.id + ":" + ratings.map((r) => r.album.id + r.score).join(",");
  let recs;
  try { recs = JSON.parse(sessionStorage.getItem("recs5:" + sig) || "null"); } catch {}
  if (!recs) {
    try { recs = await buildRecs(ratings); } catch { recs = { items: [] }; }
    try { sessionStorage.setItem("recs5:" + sig, JSON.stringify(recs)); } catch {}
  }
  if (!el.isConnected) return;
  $("#recWhy").textContent = recs.genres?.length ? `From this week's ${recs.genres.join(", ")} charts` : "From this week's Billboard 200";
  el.innerHTML = recs.items.length ? recs.items.map((it) => albumCard(it)).join("")
    : emptyState({ title: "No new picks this week", body: "You've rated everything charting in your genres. Check back after Tuesday's update.", compact: true });
}

/* ---------- Genre chart ---------- */
async function renderGenre(slug) {
  const g = GENRES.find((x) => x.slug === slug);
  if (!g) return renderNotFound();
  document.title = `${g.name} · Rotation`;
  view().innerHTML = `
    <header class="page-head"><p class="t-meta" id="gsub">Billboard chart</p><h1 class="t-title">${esc(g.name)}</h1></header>
    <nav class="chips" aria-label="Other genres" style="margin-bottom:var(--s-8)">${GENRES.map((x) =>
      `<a class="chip" href="#/genre/${x.slug}" ${x === g ? 'aria-current="page"' : ""}>${esc(x.name)}</a>`).join("")}</nav>
    <div class="grid" id="glist">${loadingLabel("Loading chart")}${skCards(12)}</div>`;
  const el = $("#glist");
  try {
    const c = await genreChart(g);
    if (!el.isConnected) return;
    $("#gsub").textContent = `${c.name.replace(/^Billboard\s*/i, "")}${c.week ? `, week of ${fmtDate(c.week)}` : ""}`;
    el.innerHTML = c.items.map((it) => albumCard(it, { rank: it.rank })).join("");
  } catch {
    el.outerHTML = errorState({ title: "This chart didn't load", body: "Billboard data is temporarily unavailable.", retry: () => { cache.delete(CHART(g.chart)); renderGenre(slug); }, compact: false });
  }
}

/* ---------- Profile ---------- */
let profileTab = "ranked", profileView = "list";
async function renderProfile() {
  document.title = "Your profile · Rotation";
  if (!sb || !user) {
    view().innerHTML = emptyState({ iconName: "user", title: "Your profile lives here",
      body: "Sign in to keep a ranked shelf of everything you've scored, with your notes and standout tracks.",
      actions: button("Sign in", { variant: "primary", id: "profSignIn" }) });
    $("#profSignIn")?.addEventListener("click", openAuth);
    return;
  }
  view().innerHTML = `${profileHeader({ initial: displayName().charAt(0).toUpperCase(), name: displayName(), eyebrow: " " })}${skList(6)}`;
  let rows;
  try { rows = await myRatings(); } catch { view().innerHTML = errorState({ title: "Couldn't load your profile", retry: renderProfile, compact: false }); return; }

  let statuses = [];
  try {
    const { data } = await sb.from("album_status").select("listened, want, favorite, updated_at, album:albums(id,title,artist,cover_url)").order("updated_at", { ascending: false });
    statuses = (data || []).filter((r) => r.album);
  } catch {}
  const STATUS_TABS = {
    favorite: { pick: (r) => r.favorite, meta: "Favorite", empty: ["Nothing favorited yet", "Tap Favorite on any album page to keep your all-time picks here."] },
    want: { pick: (r) => r.want, meta: "Want to listen", empty: ["Nothing queued yet", "Tap Want to listen on any album page to line up your next listens."] },
    listened: { pick: (r) => r.listened, meta: "Listened", empty: ["No listens logged yet", "Mark albums as Listened, or rate them, and they show up here."] },
  };

  const avg = rows.length ? (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1) : "–";
  const standouts = rows.reduce((s, r) => s + (r.standout_tracks?.length || 0), 0);
  const gCount = new Map();
  rows.forEach((r) => (r.album.genres || []).slice(0, 2).forEach((n) => { const g = matchGenre(n); if (g) gCount.set(g.name, (gCount.get(g.name) || 0) + 1); }));
  const topGenre = [...gCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "–";
  const since = user.created_at ? `Member since ${fmtDate(user.created_at.slice(0, 7))}` : "";

  const draw = () => {
    let list = [...rows];
    if (profileTab === "recent") list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    if (profileTab === "notes") list = list.filter((r) => r.thoughts);
    const st = STATUS_TABS[profileTab];
    const stRows = st ? statuses.filter(st.pick) : [];
    const body = st
      ? (stRows.length ? `<div class="grid">${stRows.map((r) => albumCard({ id: r.album.id, title: r.album.title, artist: r.album.artist, art: r.album.cover_url },
          { meta: `${st.meta} ${fmtDate(String(r.updated_at).slice(0, 10), "short")}` })).join("")}</div>`
        : emptyState({ iconName: profileTab === "favorite" ? "heart" : "bookmark", title: st.empty[0], body: st.empty[1], compact: true,
            actions: button("Browse the charts", { variant: "primary", href: "#/lists/charts" }) }))
      : !rows.length
      ? emptyState({ iconName: "disc", title: "Your shelf is empty", body: "Score your first album and your rankings, notes and standout tracks will collect here.",
          actions: button("Browse the charts", { variant: "primary", href: "#/" }) + button("Search albums", { href: "#/search", iconName: "search" }) })
      : !list.length
        ? emptyState({ iconName: "note", title: "No notes yet", body: "Add thoughts when you score an album and they'll appear here.", compact: true })
        : profileView === "list"
          ? `<div class="list">${list.map((r, i) => listCard(r, profileTab === "ranked" ? i + 1 : "")).join("")}</div>`
          : `<div class="grid">${list.map((r) => albumCard({ id: r.album.id, title: r.album.title, artist: r.album.artist, art: r.album.cover_url },
              { score: r.score, mine: true, meta: r.thoughts ? "Has notes" : null })).join("")}</div>`;
    view().innerHTML = `
      ${profileHeader({ initial: displayName().charAt(0).toUpperCase(), avatar: profile ? avatarHTML(profile, "lg") : undefined, name: displayName(), eyebrow: since, stats: [
        { label: "Albums rated", value: rows.length }, { label: "Average score", value: avg },
        { label: "Standout tracks", value: standouts }, { label: "Top genre", value: topGenre }],
        extra: `<div class="chips" style="margin-top:var(--s-4)">${profile
          ? `${button("View public profile", { size: "sm", href: profileHref(profile.username), iconName: "user" })}${button("Edit profile", { size: "sm", href: "#/me/edit", iconName: "note" })}<span class="t-meta" style="align-self:center">${profile.is_public ? "Public" : "Private until you make it public"}</span>`
          : `${button("Create your profile", { variant: "primary", size: "sm", href: "#/me/edit", iconName: "user" })}<span class="t-meta" style="align-self:center">Pin favorites, share lists and let people follow you.</span>`}</div>` })}
      <div class="toolbar">
        ${tabs([["ranked", "Ranked"], ["recent", "Recently rated"], ["notes", "With notes"], ["favorite", "Favorites"], ["want", "Want to listen"], ["listened", "Listened"]], profileTab, "Sort your shelf")}
        <div class="segmented" role="group" aria-label="Layout">
          <button type="button" data-view="list" aria-pressed="${profileView === "list"}" aria-label="List view">${icon("list")}</button>
          <button type="button" data-view="grid" aria-pressed="${profileView === "grid"}" aria-label="Grid view">${icon("grid")}</button>
        </div>
      </div>
      ${body}`;
    $$("[data-tab]").forEach((b) => b.onclick = () => { profileTab = b.dataset.tab; draw(); });
    $$("[data-view]").forEach((b) => b.onclick = () => { profileView = b.dataset.view; draw(); });
  };
  draw();
}

/* ---------- Artist ---------- */
async function renderArtist(id) {
  view().innerHTML = `${profileHeader({ initial: "", name: "Loading artist…" })}<div class="grid">${skCards(8)}</div>`;
  let a, groups;
  try {
    [a, groups] = await Promise.all([
      getJSON(`${MB}/artist/${id}?inc=genres&fmt=json`),
      getJSON(`${MB}/release-group?artist=${id}&type=album&limit=100&fmt=json`),
    ]);
  } catch {
    view().innerHTML = errorState({ title: "Couldn't load this artist", body: "MusicBrainz may be busy. Give it a moment.", retry: () => renderArtist(id), compact: false });
    return;
  }
  document.title = `${a.name} · Rotation`;
  const albums = (groups["release-groups"] || []).filter(isStudioAlbum)
    .sort((x, y) => (y["first-release-date"] || "").localeCompare(x["first-release-date"] || ""));
  const span = a["life-span"] || {};
  // For people, MusicBrainz's life span is birth (and death), not career length
  const isPerson = a.type === "Person";
  const lifeLabel = isPerson ? (span.ended ? "Lived" : "Born") : "Active";
  const active = !span.begin ? "–"
    : isPerson ? (span.ended && span.end ? `${year(span.begin)}–${year(span.end)}` : year(span.begin))
    : `${year(span.begin)}–${span.ended ? year(span.end) || "" : "present"}`;
  const genres = (a.genres || []).sort((x, y) => y.count - x.count).slice(0, 4);
  view().innerHTML = `
    ${profileHeader({
      initial: a.name.charAt(0).toUpperCase(), name: a.name,
      eyebrow: [a.type, a.area?.name].filter(Boolean).join(", "),
      stats: [{ label: "Studio albums", value: albums.length }, { label: lifeLabel, value: active }],
      extra: genres.length ? `<div class="chips" style="margin-top:var(--s-4)">${genres.map((g) => {
        const m = matchGenre(g.name);
        return m ? `<a class="chip" href="#/genre/${m.slug}">${esc(g.name)}</a>` : `<span class="chip chip--static">${esc(g.name)}</span>`;
      }).join("")}</div>` : "" })}
    <section class="section">
      ${sectionHead("Albums", { sub: albums.length ? "Newest first" : "" })}
      ${albums.length
        ? `<div class="grid">${albums.map((g) => albumCard({ id: g.id, title: g.title, art: coverUrl(g.id, 250) }, { meta: year(g["first-release-date"]) || "Year unknown" })).join("")}</div>`
        : emptyState({ title: "No studio albums listed", body: "MusicBrainz doesn't list any full-length albums for this artist yet.", compact: true })}
    </section>`;
}
async function resolveArtist(name) {
  view().innerHTML = `${profileHeader({ initial: "", name: "Finding artist…" })}`;
  try {
    const j = await getJSON(`${MB}/artist?query=${encodeURIComponent(`artist:"${name.replace(/["\\]/g, "")}"`)}&fmt=json&limit=1`);
    if (j.artists?.[0]) return location.replace(`#/artist/${j.artists[0].id}`);
  } catch {}
  view().innerHTML = emptyState({ iconName: "search", title: `Couldn't find ${name}`, body: "Try searching for them above.", compact: false });
}

/* ---------- Chart item → album page ---------- */
async function resolveFind(artist, title) {
  view().innerHTML = `${loadingLabel("Finding the album")}<div class="album"><div class="sk art"></div><div style="display:grid;gap:12px"><div class="sk sk-line" style="height:40px;width:70%"></div><div class="sk sk-line" style="width:40%"></div></div></div>`;
  const clean = title.replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+(EP|Single)$/i, "").trim();
  const quote = (s) => s.replace(/["\\]/g, "\\$&");
  try {
    let j = await getJSON(`${MB}/release-group?query=${encodeURIComponent(`releasegroup:"${quote(clean)}" AND artist:"${quote(artist)}"`)}&fmt=json&limit=5`);
    let rg = (j["release-groups"] || [])[0];
    if (!rg) { j = await getJSON(`${MB}/release-group?query=${encodeURIComponent(`${clean} ${artist}`)}&fmt=json&limit=5`); rg = (j["release-groups"] || [])[0]; }
    if (rg) return location.replace(`#/album/${rg.id}`);
  } catch {}
  view().innerHTML = emptyState({ iconName: "search", title: "Couldn't open this album yet", body: `We couldn't match “${title}” by ${artist} to an album page. Try searching for it.`,
    actions: button("Search", { href: searchHref(`${title} ${artist}`), iconName: "search" }) });
}

/* ---------- Album page ---------- */
function recordSvg(score) {
  const rings = Array.from({ length: 10 }, (_, i) => `<circle class="groove ${score && 10 - i <= score ? "on" : ""}" cx="68" cy="68" r="${64 - i * 3.7}"/>`).join("");
  return `<svg class="record" viewBox="0 0 136 136" role="img" aria-label="${score ? `Your score: ${score} out of 10` : "Not rated yet"}">
    ${rings}<circle class="label" cx="68" cy="68" r="24"/><text class="num" x="68" y="69" text-anchor="middle" dominant-baseline="central">${score || "–"}</text></svg>`;
}

// counts[i] is how many people gave the album a score of i + 1
function distribution(counts, mineScore) {
  const max = Math.max(...counts, 1);
  const label = counts.map((n, i) => `${i + 1}: ${n}`).join(", ");
  return `<div class="dist" role="img" aria-label="Rating distribution, score then count. ${label}">${counts.map((n, i) => `
    <div class="dist__col${mineScore === i + 1 ? " is-mine" : ""}" title="${plural(n, "rating")} of ${i + 1}">
      <span class="dist__n">${n || ""}</span>
      <span class="dist__track"><span class="dist__bar" style="height:${n ? Math.max(6, Math.round((n / max) * 100)) : 2}%"></span></span>
      <span class="dist__label">${i + 1}</span>
    </div>`).join("")}</div>`;
}

// Writes the album row that ratings and listening statuses point at. Falls back to the original columns if schema v4 isn't applied yet.
async function persistAlbum(a) {
  const base = { id: a.id, title: a.title, artist: a.artist, release_date: a.release_date, cover_url: a.cover_url, tracks: a.tracks, genres: a.genres || [] };
  let { error } = await sb.from("albums").upsert({ ...base, artist_id: a.artist_id || null, album_type: a.album_type || null });
  if (error && /column/i.test(error.message)) ({ error } = await sb.from("albums").upsert(base));
  return error;
}

const apiError = (e) => /row-level security|jwt|not authenticated/i.test(e?.message || "") ? "Please sign in again." : (e?.message || "Something went wrong.");

// Plain-language read of the distribution, computed only from the numbers shown. Needs enough ratings to mean anything.
function spreadNote(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n < 5) return "";
  const mean = counts.reduce((s, c, i) => s + c * (i + 1), 0) / n;
  const sd = Math.sqrt(counts.reduce((s, c, i) => s + c * (i + 1 - mean) ** 2, 0) / n);
  return sd >= 2.6 ? "Divisive: scores are spread across the scale." : sd <= 1.4 ? "Broad agreement: most scores sit close together." : "";
}
function confidenceNote(n) {
  if (n < MIN_RATINGS) return `Based on ${plural(n, "rating")}. Too few to rank or compare with other albums.`;
  if (n < 10) return "Early read. The average can move a lot as more people rate.";
  return "";
}

async function renderAlbum(id) {
  view().innerHTML = `${loadingLabel("Loading album")}<div class="album"><div class="sk art"></div>
    <div style="display:grid;gap:14px;align-content:start"><div class="sk sk-line" style="height:44px;width:72%"></div><div class="sk sk-line" style="width:36%"></div><div class="sk" style="height:180px;border-radius:var(--r-lg);margin-top:24px"></div></div></div>`;
  let album;
  try { album = await getAlbum(id); }
  catch (e) {
    view().innerHTML = e.message === "notfound"
      ? emptyState({ iconName: "search", title: "Album not found", body: "This album isn't in MusicBrainz anymore. Try searching for it.", compact: false })
      : errorState({ title: "Couldn't load this album", body: "MusicBrainz may be busy. Give it a moment.", retry: () => renderAlbum(id), compact: false });
    return;
  }
  const yr = year(album.release_date);
  document.title = `${album.title}${yr ? ` (${yr})` : ""} by ${album.artist} · Rotation`;

  // One state object drives every repaint, so rating and status changes update in place and never wipe an unsaved review.
  // Scores are whole numbers from 1 to 10, the scale Rotation already uses everywhere.
  const S = { mine: null, score: 0, stats: null, counts: null, status: { listened: false, want: false, favorite: false },
    standouts: new Set(), busy: false, statusBusy: false, albumSaved: false, pins: [] };
  let reviews = [];
  if (sb) {
    const [s, r, c, st, rv, pn] = await Promise.all([
      sb.from("album_stats").select("avg_score, rating_count").eq("album_id", id).maybeSingle(),
      user ? sb.from("ratings").select("*").eq("album_id", id).eq("user_id", user.id).maybeSingle() : Promise.resolve({ data: null }),
      sb.from("album_score_counts").select("score, n").eq("album_id", id),
      user ? sb.from("album_status").select("listened, want, favorite").eq("album_id", id).eq("user_id", user.id).maybeSingle() : Promise.resolve({ data: null }),
      sb.from("album_reviews").select("*").eq("album_id", id).order("updated_at", { ascending: false }).limit(20),
      user ? sb.from("profile_pins").select("album_id, position") : Promise.resolve({ data: null }),
    ]);
    S.pins = pn.data || [];
    S.stats = s.data; S.mine = r.data; S.score = r.data?.score || 0; S.standouts = new Set(r.data?.standout_tracks || []);
    if (st.data) S.status = st.data;
    if (c.data?.length) { S.counts = Array(10).fill(0); c.data.forEach((x) => { if (x.score >= 1 && x.score <= 10) S.counts[x.score - 1] = x.n; }); }
    reviews = (rv.data || []).filter((x) => !x.is_mine);
  }
  const total = album.tracks?.reduce((s, t) => s + (t.length || 0), 0);
  const artistHref = (aid) => aid ? `#/artist/${aid}` : `#/find-artist/${encodeURIComponent(album.artist)}`;
  const eyebrow = () => [album.album_type, yr].filter(Boolean).join(" · ");
  const facts = [album.release_date ? fmtDate(album.release_date) : "", album.tracks?.length ? plural(album.tracks.length, "track") : "", total ? `${Math.round(total / 60000)} min` : ""].filter(Boolean);
  const shared = !!S.mine?.is_public;
  const isPinned = () => S.pins.some((x) => x.album_id === album.id);
  const canCredit = () => !!profile?.is_public;
  const ratedOn = () => S.mine ? `Rated ${fmtDate(String(S.mine.updated_at || S.mine.created_at).slice(0, 10), "short")}` : "Not rated yet";

  const communityHTML = () => {
    const n = S.stats?.rating_count || 0;
    if (!S.stats) return `<p class="text-2" style="font-size:var(--fs-sm)">No ratings yet. Be the first to score it.</p>`;
    const notes = [confidenceNote(n), S.counts ? spreadNote(S.counts) : ""].filter(Boolean);
    return `<div class="community">
        <div class="rating-stat"><span class="score score--lg">${S.stats.avg_score}<small> /10</small></span><span class="t-meta">${plural(n, "rating")}</span></div>
        ${S.counts ? distribution(S.counts, S.score) : ""}</div>
      ${notes.length ? `<p class="t-meta">${notes.map(esc).join(" ")}</p>` : ""}`;
  };
  const statusHTML = () => {
    const st = S.status, locked = !!S.mine || st.favorite;
    const chip = (key, label, ic, on, extra = "") => `<button type="button" class="btn" data-st="${key}" aria-pressed="${on}"${extra}>${icon(ic)}<span>${label}</span></button>`;
    const lock = locked ? ' aria-disabled="true"' : "";
    return `<div class="status" role="group" aria-label="Listening status">
        ${chip("listened", "Listened", "check", st.listened, lock)}
        ${chip("want", "Want to listen", "bookmark", st.want, lock)}
        ${chip("rated", S.mine ? `Rated ${S.score}/10` : "Rated", "star", !!S.mine)}
        ${chip("favorite", "Favorite", "heart", st.favorite)}
      </div>
      <p class="field__hint" role="status">${S.mine ? "Rated albums count as listened." : st.favorite ? "Favorites count as listened." : "Rating an album marks it as listened."}</p>`;
  };
  const pickerHTML = () => `<div class="picker" id="picker" role="group" aria-labelledby="pickLabel">${Array.from({ length: 10 }, (_, i) =>
    `<button type="button" data-s="${i + 1}" aria-pressed="${S.score === i + 1}" aria-label="Rate ${i + 1} out of 10">${i + 1}</button>`).join("")}</div>`;

  view().innerHTML = `
    <article class="album">
      <div class="album__art">${artwork(album.cover_url, `${album.title} by ${album.artist}`)}</div>
      <div>
        <header class="album__head">
          <p class="t-meta" id="albumEyebrow"${eyebrow() ? "" : " hidden"}>${esc(eyebrow())}</p>
          <h1 class="t-title">${esc(album.title)}</h1>
          <a class="album__artist" id="artistLink" href="${artistHref(album.artist_id)}">${esc(album.artist)}</a>
          ${facts.length ? `<div class="album__facts">${facts.map((f, i) => `${i ? '<span class="dot" aria-hidden="true"></span>' : ""}<span>${esc(f)}</span>`).join("")}</div>` : ""}
          ${album.genres?.length ? `<div class="chips">${album.genres.map((n) => { const g = matchGenre(n);
            return g ? `<a class="chip" href="#/genre/${g.slug}">${esc(n)}</a>` : `<span class="chip chip--static">${esc(n)}</span>`; }).join("")}</div>` : ""}
        </header>

        <div class="album__actions">
          ${button(S.mine ? "Edit your rating" : "Rate this album", { variant: "primary", id: "jumpRate", iconName: "star" })}
          ${button("Share", { id: "shareBtn", iconName: "share" })}
          <button type="button" class="btn" id="pinBtn" aria-pressed="${isPinned()}">${icon(isPinned() ? "check" : "pin")}<span>${isPinned() ? "Pinned to profile" : "Pin to profile"}</span></button>
          ${button("Add to list", { id: "listBtn", iconName: "list" })}
        </div>
        <div id="statusWrap" class="status-wrap">${statusHTML()}</div>

        <section class="panel" aria-labelledby="comm-h">
          <div class="panel__head"><h2 class="t-section" id="comm-h">Community rating</h2><span class="t-meta">Plain average</span></div>
          <div id="communityBody">${communityHTML()}</div>
        </section>

        <section class="panel" id="yourRating" aria-labelledby="you-h">
          <div class="panel__head"><h2 class="t-section" id="you-h">Your rating</h2><span class="t-meta" id="ratedMeta">${ratedOn()}</span></div>
          <div class="rating-panel rating-panel--bare">
            <div id="rec">${recordSvg(S.score)}</div>
            <div class="rating-panel__side">
              <div class="rating-stat"><span class="t-meta">Your score</span><span class="score score--lg" id="myScore">${S.score || "–"}<small> /10</small></span></div>
              <div><p class="t-label" id="pickLabel" style="margin-bottom:var(--s-2)">${S.mine ? "Change your score" : "Tap a score to rate"}</p>${pickerHTML()}
                <p class="field__hint" id="rateStatus" role="status" aria-live="polite" style="margin-top:var(--s-2)">${user ? "Saves as soon as you tap. A review is optional." : "Sign in to save your rating."}</p></div>
            </div>
          </div>
        </section>

        <section class="block">
          <div class="block__head"><h2 class="t-section">Tracklist</h2>${album.tracks?.length ? `<span class="t-meta">Star your standouts</span>` : ""}</div>
          ${album.tracks?.length ? `<ol class="tracks" id="tracks">${album.tracks.map((t) => `
            <li class="track${S.standouts.has(t.title) ? " is-standout" : ""}">
              <span class="track__pos">${esc(t.pos)}</span><span class="track__title">${esc(t.title)}</span>
              <span class="track__len">${fmtLen(t.length)}</span>
              <button type="button" class="icon-btn" data-t="${esc(t.title)}" aria-pressed="${S.standouts.has(t.title)}" aria-label="Standout: ${esc(t.title)}">${icon("star")}</button>
            </li>`).join("")}</ol>`
            : emptyState({ iconName: "note", title: "No tracklist listed", body: "MusicBrainz doesn't have tracks for this album yet. You can still score it.", plain: true })}
        </section>

        <section class="block">
          <label class="field"><span class="t-section">Your review <span class="t-meta">Optional</span></span>
            <textarea id="thoughts" class="textarea" maxlength="2000" placeholder="What stuck with you? Favorite moments, how it holds up, where it fits.">${esc(S.mine?.thoughts || "")}</textarea>
          </label>
          <label class="check"><input type="checkbox" id="isPublic"${shared ? " checked" : ""}><span>Share this review with the community</span></label>
          <label class="check" id="creditField" hidden><input type="checkbox" id="creditProfile"${S.mine?.credit_profile ? " checked" : ""}><span>Credit this review to my profile${profile ? ` (@${esc(profile.username)})` : ""}</span></label>
          <label class="field" id="nameField"${shared ? "" : " hidden"}><span class="field__label">Show as</span>
            <input id="displayNameInput" class="input" maxlength="40" placeholder="Anonymous listener" value="${esc(S.mine?.display_name || "")}" autocomplete="off">
          </label>
          <span class="field__hint" id="reviewHint"></span>
        </section>

        <div class="save-bar">
          <button type="button" class="btn btn--primary" id="save"><span>${S.mine ? "Save review and standouts" : "Save rating and review"}</span></button>
          <button type="button" class="btn btn--ghost" id="remove" data-danger="1"${S.mine ? "" : " hidden"}><span>Remove rating</span></button>
        </div>

        <section class="block" id="reviews" aria-labelledby="rev-h">
          <div class="block__head"><h2 class="t-section" id="rev-h">Community reviews</h2>${reviews.length ? `<span class="t-meta">${plural(reviews.length, "review")}</span>` : ""}</div>
          ${reviews.length ? `<div class="reviews">${reviews.map((r) => reviewCard({ name: r.author, date: r.updated_at, score: r.score, body: r.body, standouts: r.standout_tracks || [], href: r.author_username ? profileHref(r.author_username) : null })).join("")}</div>`
            : emptyState({ iconName: "note", title: "No written reviews yet", body: "Reviews appear here when listeners choose to share them. Notes stay private unless the writer shares them.", plain: true })}
        </section>
      </div>
    </article>
    <div id="albumMore"></div>`;

  // Fall back to Apple artwork when the Cover Art Archive has none
  $(".album__art img")?.addEventListener("error", () => appleArt(album.artist, album.title).then((url) => {
    const slot = url && $(".album__art .art");
    if (slot?.isConnected) slot.outerHTML = artwork(url, `${album.title} by ${album.artist}`);
  }));

  /* ----- painting ----- */
  const announce = (msg) => { const el = $("#rateStatus"); if (el) el.textContent = msg; };
  const paintRating = () => {
    $("#rec").innerHTML = recordSvg(S.score);
    $("#myScore").innerHTML = `${S.score || "–"}<small> /10</small>`;
    $$("#picker button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.s === S.score)));
    $("#picker").setAttribute("aria-busy", String(S.busy));
    $("#pickLabel").textContent = S.mine ? "Change your score" : "Tap a score to rate";
    $("#ratedMeta").textContent = ratedOn();
    $("#jumpRate span").textContent = S.mine ? "Edit your rating" : "Rate this album";
    $("#save span").textContent = S.mine ? "Save review and standouts" : "Save rating and review";
    $("#remove").hidden = !S.mine;
  };
  const paintStatus = () => {
    const focused = document.activeElement?.dataset?.st;
    $("#statusWrap").innerHTML = statusHTML();
    if (focused) $(`#statusWrap [data-st="${focused}"]`)?.focus();
    $$("#statusWrap .btn").forEach((b) => b.setAttribute("aria-busy", String(S.statusBusy)));
  };
  const paintCommunity = () => { $("#communityBody").innerHTML = communityHTML(); };
  const refreshCommunity = async () => {
    const [s, c] = await Promise.all([
      sb.from("album_stats").select("avg_score, rating_count").eq("album_id", id).maybeSingle(),
      sb.from("album_score_counts").select("score, n").eq("album_id", id),
    ]);
    if (!$("#communityBody")) return;
    S.stats = s.data;
    S.counts = c.data?.length ? Array.from({ length: 10 }, (_, i) => c.data.find((x) => x.score === i + 1)?.n || 0) : null;
    paintCommunity();
  };
  const paintAll = () => { paintRating(); paintStatus(); paintCommunity(); };

  /* ----- saving ----- */
  const ensureAlbum = async () => {
    if (S.albumSaved) return null;
    const err = await persistAlbum(album);
    if (!err) S.albumSaved = true;
    return err;
  };
  const needSignIn = () => {
    if (!sb) { toast("Ratings are offline right now", "error"); return true; }
    if (!user) { openAuth(); return true; }
    return false;
  };
  // Tapping a score saves it right away. Only the score is sent, so an existing review is never touched.
  async function submitScore(n) {
    if (needSignIn() || S.busy || n === S.score) return;
    const prev = S.score;
    S.score = n; S.busy = true; paintRating(); announce("Saving…");
    let error = await ensureAlbum();
    let data = null;
    if (!error) ({ data, error } = await sb.from("ratings").upsert({ user_id: user.id, album_id: album.id, score: n }, { onConflict: "user_id,album_id" }).select("*").single());
    S.busy = false;
    if (error) { S.score = prev; paintRating(); announce("Not saved"); return toast(`Couldn't save your rating: ${apiError(error)}`, "error"); }
    S.mine = data; S.status = { ...S.status, listened: true, want: false };
    paintAll(); announce(`Rated ${n} out of 10`); toast(`Rated ${n}/10`);
    refreshCommunity();
  }
  // Listening status. Listened, Want to listen and Favorite never contradict: the database enforces the same rules.
  async function applyStatus(key) {
    if (key === "rated") { $("#jumpRate").click(); return; }
    if (needSignIn() || S.statusBusy) return;
    const st = { ...S.status }, locked = !!S.mine || st.favorite;
    if ((key === "listened" || key === "want") && locked) return toast(S.mine ? "Rated albums count as listened." : "Favorites count as listened.", "info");
    if (key === "favorite") { st.favorite = !st.favorite; if (st.favorite) st.listened = true; }
    else if (key === "listened") st.listened = !st.listened;
    else st.want = !st.want;
    if (st.listened) st.want = false;
    if (key === "want" && st.want) st.listened = false;
    S.statusBusy = true; paintStatus();
    let error = await ensureAlbum();
    let data = null;
    if (!error) ({ data, error } = await sb.from("album_status").upsert({ album_id: album.id, ...st }, { onConflict: "user_id,album_id" }).select("listened, want, favorite").single());
    S.statusBusy = false;
    if (error) { paintStatus(); return toast(`Couldn't update: ${apiError(error)}`, "error"); }
    S.status = data; paintStatus();
    toast(key === "favorite" ? (data.favorite ? "Added to favorites" : "Removed from favorites") : data.want ? "Added to Want to listen" : data.listened ? "Marked as listened" : "Status cleared", data.favorite || data.want || data.listened ? "success" : "info");
  }

  /* ----- events ----- */
  const paintHint = () => {
    const pub = $("#isPublic").checked, credit = pub && canCredit() && $("#creditProfile").checked;
    $("#creditField").hidden = !(pub && canCredit());
    $("#nameField").hidden = !pub || credit;
    $("#reviewHint").textContent = !pub ? "Only you can see your review. Your score still counts toward the community average."
      : credit ? `Your review and score will show on this page and on your public profile, with a link to @${profile.username}. Your email is never shown.`
      : "Your review and score will show on this page under the name above, with no link to your profile. Your email is never shown.";
  };
  // On phones the Save bar floats above the tab bar, but only once there is a review or standout change to save
  const markDirty = () => $(".save-bar")?.classList.add("is-dirty");
  $("#isPublic").onchange = () => { paintHint(); markDirty(); };
  $("#creditProfile").onchange = () => { paintHint(); markDirty(); };
  $("#thoughts").addEventListener("input", markDirty);
  $("#displayNameInput").addEventListener("input", markDirty);
  $("#tracks")?.addEventListener("click", markDirty);
  paintHint();

  $("#jumpRate").onclick = () => {
    $("#yourRating").scrollIntoView({ block: "start" });
    ($("#picker button[aria-pressed='true']") || $("#picker button")).focus({ preventScroll: true });
  };
  $("#listBtn").onclick = () => { if (!needSignIn()) openListPicker(album, ensureAlbum); };
  $("#pinBtn").onclick = async () => {
    if (needSignIn()) return;
    const btn = $("#pinBtn"); btn.setAttribute("aria-busy", "true");
    let error = null;
    if (isPinned()) {
      ({ error } = await sb.from("profile_pins").delete().eq("album_id", album.id));
      if (!error) S.pins = S.pins.filter((x) => x.album_id !== album.id);
    } else if (S.pins.length >= 6) {
      btn.removeAttribute("aria-busy");
      return toast("You can pin up to 6 albums. Unpin one in Edit profile first.", "info");
    } else {
      const position = [1, 2, 3, 4, 5, 6].find((n) => !S.pins.some((x) => x.position === n));
      error = await ensureAlbum();
      if (!error) ({ error } = await sb.from("profile_pins").insert({ album_id: album.id, position }));
      if (!error) S.pins.push({ album_id: album.id, position });
    }
    btn.removeAttribute("aria-busy");
    if (error) return toast(`Couldn't update your pins: ${apiError(error)}`, "error");
    btn.setAttribute("aria-pressed", String(isPinned()));
    btn.innerHTML = `${icon(isPinned() ? "check" : "pin")}<span>${isPinned() ? "Pinned to profile" : "Pin to profile"}</span>`;
    toast(isPinned() ? (profile?.is_public ? "Pinned to your profile" : "Pinned. Make your profile public to show it.") : "Unpinned", isPinned() ? "success" : "info");
  };
  $("#shareBtn").onclick = async () => {
    const data = { title: `${album.title} by ${album.artist}`, text: `${album.title} by ${album.artist} on Rotation`, url: location.href };
    if (navigator.share) { try { await navigator.share(data); } catch {} return; }
    try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch { toast("Copy the link from your address bar", "info"); }
  };
  $("#statusWrap").addEventListener("click", (e) => { const b = e.target.closest("[data-st]"); if (b) applyStatus(b.dataset.st); });

  const picker = $("#picker");
  picker.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) submitScore(+b.dataset.s); });
  // Hover and focus preview the score on the record without saving it
  const preview = (e) => { const b = e.target.closest?.("button"); if (b && !S.busy) $("#rec").innerHTML = recordSvg(+b.dataset.s); };
  const unpreview = () => { if (!picker.contains(document.activeElement) && !picker.matches(":hover")) $("#rec").innerHTML = recordSvg(S.score); };
  picker.addEventListener("mouseover", preview);
  picker.addEventListener("focusin", preview);
  picker.addEventListener("mouseleave", unpreview);
  picker.addEventListener("focusout", () => setTimeout(unpreview, 0));
  picker.addEventListener("keydown", (e) => {
    const btns = $$("button", picker), i = btns.indexOf(document.activeElement);
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: btns.length - 1 }[e.key];
    if (to == null || i < 0) return;
    e.preventDefault();
    btns[Math.min(btns.length - 1, Math.max(0, to))].focus();
  });
  $("#tracks")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]"); if (!b) return;
    const t = b.dataset.t, on = !S.standouts.has(t);
    on ? S.standouts.add(t) : S.standouts.delete(t);
    b.setAttribute("aria-pressed", String(on));
    b.closest(".track").classList.toggle("is-standout", on);
  });

  $("#save").onclick = async () => {
    if (needSignIn()) return;
    if (!S.score) return toast("Tap a score from 1 to 10 first", "info");
    const btn = $("#save"); btn.setAttribute("aria-busy", "true");
    const body = $("#thoughts").value.trim() || null;
    const pub = !!body && $("#isPublic").checked, name = $("#displayNameInput").value.trim();
    const row = { user_id: user.id, album_id: album.id, score: S.score, standout_tracks: [...S.standouts], thoughts: body };
    // Only send the sharing columns when they matter, so saving also works on databases without schema v4
    if (pub || S.mine?.is_public) row.is_public = pub;
    const credit = pub && canCredit() && $("#creditProfile").checked;
    if (profile && (credit || S.mine?.credit_profile)) row.credit_profile = credit;
    if (pub || name || S.mine?.display_name) row.display_name = credit ? null : (name || null);
    let error = await ensureAlbum();
    let data = null;
    if (!error) ({ data, error } = await sb.from("ratings").upsert(row, { onConflict: "user_id,album_id" }).select("*").single());
    btn.removeAttribute("aria-busy");
    if (error) return toast(`Couldn't save: ${apiError(error)}`, "error");
    const first = !S.mine;
    S.mine = data; S.status = { ...S.status, listened: true, want: false };
    $(".save-bar").classList.remove("is-dirty");
    paintAll(); toast(first ? "Rating saved" : "Saved");
    refreshCommunity();
  };
  $("#remove").onclick = async () => {
    if (!S.mine || !confirm("Remove your rating for this album? Your review and standout stars for it will be deleted too.")) return;
    const btn = $("#remove"); btn.setAttribute("aria-busy", "true");
    const { error } = await sb.from("ratings").delete().eq("id", S.mine.id);
    btn.removeAttribute("aria-busy");
    if (error) return toast(`Couldn't remove: ${apiError(error)}`, "error");
    S.mine = null; S.score = 0; S.standouts = new Set();
    $("#thoughts").value = ""; $("#isPublic").checked = false; $("#displayNameInput").value = "";
    $$("#tracks .track").forEach((li) => { li.classList.remove("is-standout"); $(".icon-btn", li).setAttribute("aria-pressed", "false"); });
    paintHint(); paintAll(); announce("Rating removed"); toast("Rating removed", "info");
    refreshCommunity();
  };

  loadAlbumMore(album, artistHref);
}

// Fills in anything the cached row lacked (artist id, type), then adds artist and related-album rows
async function loadAlbumMore(album, artistHref) {
  const wrap = $("#albumMore");
  if (!wrap) return;
  if (!album.artist_id || !album.album_type) {
    try {
      const rg = await getJSON(`${MB}/release-group/${album.id}?inc=artist-credits&fmt=json`);
      album.artist_id = album.artist_id || rg["artist-credit"]?.[0]?.artist?.id || null;
      album.album_type = album.album_type || typeLabel(rg) || null;
      if (!wrap.isConnected) return;
      const link = $("#artistLink"); if (link) link.href = artistHref(album.artist_id);
      const eb = $("#albumEyebrow");
      if (eb) { eb.textContent = [album.album_type, year(album.release_date)].filter(Boolean).join(" · "); eb.hidden = !eb.textContent; }
      if (user) sb.from("albums").update({ artist_id: album.artist_id, album_type: album.album_type }).eq("id", album.id).then(() => {});
    } catch {}
  }
  const sections = [];
  if (album.artist_id) {
    try {
      const j = await getJSON(`${MB}/release-group?artist=${album.artist_id}&type=album&limit=100&fmt=json`);
      const more = (j["release-groups"] || []).filter((g) => g.id !== album.id && isStudioAlbum(g))
        .sort((x, y) => (y["first-release-date"] || "").localeCompare(x["first-release-date"] || "")).slice(0, 12);
      if (more.length) sections.push(`<section class="section">${sectionHead(`More from ${album.artist}`, { link: `#/artist/${album.artist_id}`, linkLabel: "All albums" })}
        <div class="row">${more.map((g) => albumCard({ id: g.id, title: g.title, art: coverUrl(g.id, 250) }, { meta: year(g["first-release-date"]) || null })).join("")}</div></section>`);
    } catch {}
  }
  if (sb && album.genres?.length) {
    const { data } = await sb.from("albums").select("id, title, artist, cover_url").overlaps("genres", album.genres).neq("id", album.id).limit(12);
    if (data?.length) {
      const g = matchGenre(album.genres[0]);
      sections.push(`<section class="section">${sectionHead(`More ${album.genres.slice(0, 2).join(" and ")} on Rotation`, { link: g ? `#/genre/${g.slug}` : null, linkLabel: "Genre chart" })}
        <div class="row">${data.map((a) => albumCard({ id: a.id, title: a.title, artist: a.artist, art: a.cover_url })).join("")}</div></section>`);
    }
  }
  if (wrap.isConnected) wrap.innerHTML = sections.join("");
}

function renderNotFound() {
  view().innerHTML = emptyState({ iconName: "search", title: "Page not found", body: "That link doesn't go anywhere in Rotation.", actions: button("Go home", { variant: "primary", href: "#/" }) });
}

/* ==========================================================================
   Profiles, follows, pinned favorites and lists
   Other people only ever see rows from the public_* views, and only for profiles
   whose owner made them public. Your own page reads your own tables directly.
   ========================================================================== */
const profileHref = (username) => `#/u/${username}`;
const profileUrl = (username) => `${location.origin}${location.pathname}#/u/${username}`;
let profile = null; // the signed-in user's own profile row (private or public), or null
async function loadProfile() {
  profile = null;
  if (!sb || !user) return;
  const { data } = await sb.from("profiles").select("*, albums(cover_url)").maybeSingle();
  if (data) profile = { ...data, avatar_cover: data.albums?.cover_url || null };
}

function avatarHTML(p, size = "") {
  const cls = `avatar${size ? ` avatar--${size}` : ""}`;
  const initial = (p.display_name || p.username || "?").trim().charAt(0).toUpperCase();
  return p.avatar_cover
    ? `<span class="${cls}" aria-hidden="true"><img src="${esc(smallArt(p.avatar_cover))}" alt="" loading="lazy" onerror="this.remove()"></span>`
    : `<span class="${cls}" aria-hidden="true">${esc(initial)}</span>`;
}
// Album artwork with the score tucked into a corner, so grids stay clean
function tile({ href, art, title, artist, score, mine = false, note }) {
  return `<a class="tile" href="${href}" title="${esc(title)}${artist ? ` · ${esc(artist)}` : ""}">
    <span class="tile__art">${artwork(smallArt(art), `${title}${artist ? ` by ${artist}` : ""}`)}${score != null ? `<span class="tile__score${mine ? " tile__score--mine" : ""}"><span class="sr">Score: </span>${score}</span>` : ""}</span>
    <span class="tile__title">${esc(title)}</span>${note ? `<span class="tile__note">${esc(note)}</span>` : ""}</a>`;
}
function listTile(l, own = false) {
  const covers = l.covers || [];
  return `<a class="listtile" href="#/list/${l.id}">
    <span class="collage">${[0, 1, 2, 3].map((i) => covers[i] ? `<span class="collage__cell"><img src="${esc(smallArt(covers[i]))}" alt="" loading="lazy" onerror="this.remove()"></span>` : `<span class="collage__cell"></span>`).join("")}</span>
    <span class="listtile__title">${esc(l.title)}</span>
    <span class="t-meta">${plural(l.item_count, "album")}${own ? (l.is_public ? " · Public" : " · Private") : ""}</span></a>`;
}

// What the page needs, in one shape whether it came from the owner's tables or the public views
async function loadProfileData(p, own) {
  const q = (req) => req.then((r) => r.data || []).catch(() => []);
  const u = p.username;
  if (own) {
    const [pins, ratings, lists] = await Promise.all([
      q(sb.from("profile_pins").select("position, album:albums(id,title,artist,cover_url)").order("position")),
      q(sb.from("ratings").select("score, thoughts, is_public, credit_profile, updated_at, album:albums(id,title,artist,cover_url,genres)").order("updated_at", { ascending: false }).limit(300)),
      q(sb.from("lists").select("id, title, description, is_public, list_items(position, album:albums(cover_url))").order("updated_at", { ascending: false })),
    ]);
    const rs = ratings.filter((r) => r.album).map((r) => ({ album_id: r.album.id, title: r.album.title, artist: r.album.artist, cover_url: r.album.cover_url,
      genres: r.album.genres || [], score: r.score, rated_at: r.updated_at, has_review: !!(r.credit_profile && r.is_public && r.thoughts?.trim()), body: r.thoughts }));
    return {
      pins: pins.filter((x) => x.album).map((x) => ({ position: x.position, album_id: x.album.id, title: x.album.title, artist: x.album.artist, cover_url: x.album.cover_url })),
      ratings: rs,
      reviews: rs.filter((r) => r.has_review).map((r) => ({ ...r, updated_at: r.rated_at })),
      lists: lists.map((l) => { const items = [...(l.list_items || [])].filter((i) => i.album).sort((a, b) => a.position - b.position);
        return { id: l.id, title: l.title, description: l.description, is_public: l.is_public, item_count: items.length, covers: items.slice(0, 4).map((i) => i.album.cover_url) }; }),
    };
  }
  const [pins, ratings, reviews, lists] = await Promise.all([
    q(sb.from("public_pins").select("*").eq("username", u).order("position")),
    p.show_ratings ? q(sb.from("public_ratings").select("*").eq("username", u).order("rated_at", { ascending: false }).limit(300)) : [],
    q(sb.from("public_reviews").select("*").eq("username", u).order("updated_at", { ascending: false }).limit(50)),
    q(sb.from("public_lists").select("*").eq("username", u).order("updated_at", { ascending: false })),
  ]);
  return { pins, ratings, reviews, lists };
}

// Favorite genres and artists, only from ratings that are actually shown, and only once there is enough to say something
function tasteOf(ratings) {
  if (ratings.length < 5) return null;
  const g = new Map(), a = new Map();
  ratings.forEach((r) => {
    (r.genres || []).slice(0, 2).forEach((n) => { const x = g.get(n) || { n: 0, sum: 0 }; x.n++; x.sum += r.score; g.set(n, x); });
    const x = a.get(r.artist) || { n: 0, sum: 0 }; x.n++; x.sum += r.score; a.set(r.artist, x);
  });
  const genres = [...g].filter(([, v]) => v.n >= 2).sort((x, y) => y[1].sum - x[1].sum).slice(0, 3).map(([n]) => n);
  const artists = [...a].filter(([, v]) => v.n >= 2).sort((x, y) => y[1].sum / y[1].n - x[1].sum / x[1].n || y[1].n - x[1].n).slice(0, 3).map(([n]) => n);
  return genres.length || artists.length ? { genres, artists } : null;
}

let ptab = "ratings", psort = "recent";
async function renderPublicProfile(username) {
  username = username.toLowerCase();
  view().innerHTML = `${profileHeader({ initial: "", name: "Loading profile…" })}${skList(4)}`;
  const own = !!profile && profile.username === username;
  let p = null, counts = null;
  if (sb) {
    const { data, error } = await sb.from("public_profiles").select("*").eq("username", username).maybeSingle();
    if (error && !own) { view().innerHTML = errorState({ title: "Couldn't load this profile", retry: () => renderPublicProfile(username), compact: false }); return; }
    counts = data;
    p = own ? profile : data;
  }
  if (!p) {
    view().innerHTML = emptyState({ iconName: "user", title: "Profile not found", body: "This profile doesn't exist, or its owner keeps it private.",
      actions: button("Go home", { variant: "primary", href: "#/" }), compact: false });
    return;
  }
  document.title = `${p.display_name || p.username} (@${p.username}) · Rotation`;
  const d = await loadProfileData(p, own);
  let following = false, followers = counts?.followers || 0;
  if (!own && user && sb) { const { data } = await sb.rpc("is_following", { p_username: username }); following = !!data; }

  const ratingsVisible = own || p.show_ratings;
  const avg = own ? (d.ratings.length ? (d.ratings.reduce((s, r) => s + r.score, 0) / d.ratings.length).toFixed(1) : null) : p.avg_score;
  const reviewCount = own ? d.reviews.length : p.review_count;
  const stats = [
    { label: "Albums rated", value: ratingsVisible ? (own ? d.ratings.length : p.rating_count) : "Private" },
    ...(ratingsVisible && avg != null ? [{ label: "Average score", value: avg }] : []),
    { label: "Written reviews", value: reviewCount ?? 0 },
    { label: "Followers", value: followers, id: "stFollowers" }, { label: "Following", value: counts?.following || 0 },
  ];
  const actions = own
    ? `${button("Edit profile", { variant: "primary", size: "sm", href: "#/me/edit", iconName: "user" })}${button("Share", { size: "sm", id: "shareProfile", iconName: "share" })}`
    : `<button type="button" class="btn btn--sm${following ? "" : " btn--primary"}" id="followBtn" aria-pressed="${following}">${icon(following ? "check" : "user")}<span>${following ? "Following" : "Follow"}</span></button>${button("Share", { size: "sm", id: "shareProfile", iconName: "share" })}`;
  const taste = ratingsVisible ? tasteOf(d.ratings) : null;

  const draw = () => {
    let body = "";
    if (ptab === "ratings") {
      if (!ratingsVisible) body = emptyState({ iconName: "user", compact: true, title: "Ratings are private", body: `${p.display_name || "@" + p.username} keeps their ratings to themselves.` });
      else if (!d.ratings.length) body = emptyState({ iconName: "disc", compact: true, title: own ? "Nothing rated yet" : "No ratings yet",
        body: own ? "Score an album and it lands in your grid." : "Check back once they've rated something.", actions: own ? button("Search albums", { variant: "primary", href: "#/search", iconName: "search" }) : "" });
      else {
        const list = [...d.ratings].sort(psort === "top" ? (a, b) => b.score - a.score || String(b.rated_at).localeCompare(String(a.rated_at)) : (a, b) => String(b.rated_at).localeCompare(String(a.rated_at)));
        body = `<div class="chips" role="group" aria-label="Sort ratings" style="margin-bottom:var(--s-5)">
            <button type="button" class="chip" data-sort="recent" aria-pressed="${psort === "recent"}">Recently rated</button>
            <button type="button" class="chip" data-sort="top" aria-pressed="${psort === "top"}">Highest scores</button></div>
          <div class="tiles">${list.map((r) => tile({ href: `#/album/${r.album_id}`, art: r.cover_url, title: r.title, artist: r.artist, score: r.score, mine: own, note: r.has_review ? "Review" : "" })).join("")}</div>
          ${d.ratings.length >= 300 ? `<p class="t-meta" style="margin-top:var(--s-4)">Showing the 300 most recent ratings.</p>` : ""}`;
      }
    } else if (ptab === "reviews") {
      body = d.reviews.length ? `<div class="reviews">${d.reviews.map((r) => `<article class="review-card">
          <header class="review-card__head">${artwork(smallArt(r.cover_url), r.title, "thumb")}
            <span class="review-card__who"><a href="#/album/${r.album_id}"><strong>${esc(r.title)}</strong></a><span class="t-meta">${esc(r.artist || "")} · Reviewed ${fmtDate(String(r.updated_at).slice(0, 10), "short")}</span></span>
            ${scoreChip(r.score, { mine: own })}</header>
          <p class="review-card__body">${esc(r.body)}</p></article>`).join("")}</div>`
        : emptyState({ iconName: "note", compact: true, title: "No shared reviews", body: own ? "Write a review on an album page, share it, and credit it to your profile." : "Written reviews they choose to share appear here." });
    } else {
      body = d.lists.length ? `<div class="listtiles">${d.lists.map((l) => listTile(l, own)).join("")}</div>`
        : emptyState({ iconName: "list", compact: true, title: own ? "No lists yet" : "No public lists", body: own ? "Group albums into lists, then make them public to show them here." : "Lists they make public appear here.",
            actions: own ? button("Create a list", { variant: "primary", href: "#/lists/yours" }) : "" });
    }
    $("#pbody").innerHTML = `${tabs([["ratings", `Ratings${ratingsVisible ? ` (${d.ratings.length})` : ""}`], ["reviews", `Reviews (${d.reviews.length})`], ["lists", `Lists (${d.lists.length})`]], ptab, "Profile sections")}${body}`;
    $$("#pbody [data-tab]").forEach((b) => b.onclick = () => { ptab = b.dataset.tab; draw(); });
    $$("#pbody [data-sort]").forEach((b) => b.onclick = () => { psort = b.dataset.sort; draw(); });
  };

  view().innerHTML = `
    ${profileHeader({ avatar: avatarHTML(p, "lg"), eyebrow: `@${p.username}${p.created_at ? ` · Joined ${fmtDate(String(p.created_at).slice(0, 7))}` : ""}`,
      name: p.display_name || p.username, stats,
      extra: `${p.bio ? `<p class="profile__bio">${esc(p.bio)}</p>` : ""}<div class="chips" style="margin-top:var(--s-4)">${actions}</div>` })}
    ${own && !p.is_public ? `<p class="alert alert--warning" role="status" style="margin-bottom:var(--s-8)">${icon("alert")}<span>Only you can see this profile. Make it public in Edit profile to share the link.</span></p>` : ""}
    ${d.pins.length || own ? `<section class="section">${sectionHead("Favorite albums", { sub: d.pins.length ? "" : "Pin up to six albums from any album page.", link: own ? "#/me/edit" : null, linkLabel: "Manage" })}
      ${d.pins.length ? `<div class="tiles tiles--pins">${d.pins.map((x) => tile({ href: `#/album/${x.album_id}`, art: x.cover_url, title: x.title, artist: x.artist })).join("")}</div>` : ""}</section>` : ""}
    ${taste ? `<section class="section">${sectionHead("Taste", { sub: "From the ratings shown on this profile" })}<div class="chips">
      ${taste.genres.map((n) => { const g = matchGenre(n); return g ? `<a class="chip" href="#/genre/${g.slug}">${esc(n)}</a>` : `<span class="chip chip--static">${esc(n)}</span>`; }).join("")}
      ${taste.artists.map((n) => `<a class="chip" href="#/find-artist/${encodeURIComponent(n)}">${icon("user")}${esc(n)}</a>`).join("")}</div></section>` : ""}
    <div id="pbody"></div>`;
  draw();

  $("#shareProfile").onclick = async () => {
    const data = { title: `${p.display_name || p.username} on Rotation`, url: profileUrl(p.username) };
    if (!own || p.is_public) { if (navigator.share) { try { await navigator.share(data); } catch {} return; } }
    else return toast("This profile is private. Make it public before sharing the link.", "info");
    try { await navigator.clipboard.writeText(data.url); toast("Link copied"); } catch { toast("Copy the link from your address bar", "info"); }
  };
  const fb = $("#followBtn");
  if (fb) fb.onclick = async () => {
    if (!user) return openAuth();
    fb.setAttribute("aria-busy", "true");
    const { error } = await sb.rpc(following ? "unfollow_user" : "follow_user", { p_username: username });
    fb.removeAttribute("aria-busy");
    if (error) return toast(apiError(error), "error");
    following = !following; followers += following ? 1 : -1;
    fb.setAttribute("aria-pressed", String(following));
    fb.classList.toggle("btn--primary", !following);
    fb.innerHTML = `${icon(following ? "check" : "user")}<span>${following ? "Following" : "Follow"}</span>`;
    $("#stFollowers").textContent = followers;
    toast(following ? `Following @${username}` : `Unfollowed @${username}`, following ? "success" : "info");
  };
}

/* ---------- Create / edit your profile ---------- */
async function renderProfileEdit() {
  document.title = "Edit profile · Rotation";
  if (!sb || !user) {
    view().innerHTML = emptyState({ iconName: "user", title: "Sign in to set up your profile", body: "Your profile is private until you choose to make it public.",
      actions: button("Sign in", { variant: "primary", id: "editSignIn" }) });
    $("#editSignIn")?.addEventListener("click", openAuth);
    return;
  }
  view().innerHTML = `${loadingLabel("Loading profile")}${skList(4)}`;
  const { data: pinRows } = await sb.from("profile_pins").select("position, album:albums(id,title,artist,cover_url)").order("position");
  let pins = (pinRows || []).filter((x) => x.album);
  const p = profile || { username: "", display_name: "", bio: "", is_public: false, show_ratings: true, avatar_album_id: null };
  let avatarId = p.avatar_album_id;

  const pinsHTML = () => pins.length ? `<ol class="pinlist">${pins.map((x, i) => `<li class="pinlist__row">
      ${artwork(smallArt(x.album.cover_url), x.album.title, "thumb")}
      <span class="pinlist__text"><strong>${esc(x.album.title)}</strong><span class="t-meta">${esc(x.album.artist)}</span></span>
      <label class="pinlist__avatar"><input type="radio" name="avatar" value="${esc(x.album.id)}"${avatarId === x.album.id ? " checked" : ""}><span>Avatar</span></label>
      <button type="button" class="icon-btn" data-pin="up" data-i="${i}" aria-label="Move ${esc(x.album.title)} up"${i === 0 ? " disabled" : ""}>${icon("up")}</button>
      <button type="button" class="icon-btn" data-pin="down" data-i="${i}" aria-label="Move ${esc(x.album.title)} down"${i === pins.length - 1 ? " disabled" : ""}>${icon("down")}</button>
      <button type="button" class="icon-btn" data-pin="remove" data-i="${i}" aria-label="Unpin ${esc(x.album.title)}">${icon("close")}</button></li>`).join("")}</ol>`
    : emptyState({ iconName: "star", compact: true, plain: true, title: "No pinned albums", body: "Open any album and choose Pin to profile. You can pin up to six." });

  view().innerHTML = `
    <header class="page-head"><h1 class="t-page">${profile ? "Edit profile" : "Create your profile"}</h1>
      <p class="t-lead">Your profile is private until you make it public. Your email is never shown.</p></header>
    <form id="pform" class="form" novalidate>
      <label class="field"><span class="field__label">Username</span>
        <input id="pUser" class="input" maxlength="20" value="${esc(p.username)}" autocomplete="off" autocapitalize="off" spellcheck="false" required aria-describedby="uHint">
        <span class="field__hint" id="uHint">3 to 20 lowercase letters, numbers or underscores. Your link: ${esc(location.origin + location.pathname)}#/u/<strong id="uPrev">${esc(p.username || "username")}</strong></span></label>
      <label class="field"><span class="field__label">Display name <span class="t-meta">Optional</span></span>
        <input id="pName" class="input" maxlength="40" value="${esc(p.display_name || "")}" autocomplete="off"></label>
      <label class="field"><span class="field__label">Bio <span class="t-meta">Optional</span></span>
        <textarea id="pBio" class="textarea" maxlength="280" style="min-height:96px" placeholder="What do you listen for?">${esc(p.bio || "")}</textarea>
        <span class="field__hint"><span id="bioCount">${(p.bio || "").length}</span>/280</span></label>
      <fieldset class="fieldset"><legend class="field__label">Privacy</legend>
        <label class="check"><input type="checkbox" id="pPublic"${p.is_public ? " checked" : ""}><span>Make my profile public. Anyone with the link can see it, and people can follow me.</span></label>
        <label class="check"><input type="checkbox" id="pShow"${p.show_ratings ? " checked" : ""}><span>Show my ratings on my public profile. Turn this off to keep scores private while the rest stays public.</span></label>
        <span class="field__hint">Your listening status, private notes and unshared reviews are never shown to anyone else.</span></fieldset>
      <fieldset class="fieldset"><legend class="field__label">Pinned favorites and avatar</legend>
        <div id="pinsBox">${pinsHTML()}</div>
        <label class="check" style="margin-top:var(--s-3)"><input type="radio" name="avatar" value=""${avatarId ? "" : " checked"}><span>Use my initial as my avatar</span></label></fieldset>
      <p id="pError" class="alert alert--error" role="alert" hidden></p>
      <div class="save-bar" style="margin-top:0">
        <button type="submit" class="btn btn--primary" id="pSave"><span>${profile ? "Save profile" : "Create profile"}</span></button>
        ${profile ? `<a class="btn btn--ghost" href="${profileHref(profile.username)}">Cancel</a>` : ""}</div>
    </form>`;

  $("#pUser").addEventListener("input", (e) => { $("#uPrev").textContent = e.target.value.trim().toLowerCase() || "username"; });
  $("#pBio").addEventListener("input", (e) => { $("#bioCount").textContent = e.target.value.length; });
  $("#pform").addEventListener("change", (e) => { if (e.target.name === "avatar") avatarId = e.target.value || null; });
  const repaintPins = () => { $("#pinsBox").innerHTML = pinsHTML(); };
  $("#pinsBox").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pin]"); if (!b) return;
    const i = +b.dataset.i, op = b.dataset.pin;
    if (op === "remove") {
      const { error } = await sb.from("profile_pins").delete().eq("album_id", pins[i].album.id);
      if (error) return toast(`Couldn't unpin: ${apiError(error)}`, "error");
      if (avatarId === pins[i].album.id) avatarId = null;
      pins.splice(i, 1);
    } else {
      const j = op === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= pins.length) return;
      const [a, c] = [pins[i], pins[j]];
      const { error } = await sb.from("profile_pins").upsert([{ album_id: a.album.id, position: c.position }, { album_id: c.album.id, position: a.position }], { onConflict: "user_id,album_id" });
      if (error) return toast(`Couldn't reorder: ${apiError(error)}`, "error");
      pins[i] = { ...c, position: a.position }; pins[j] = { ...a, position: c.position };
    }
    repaintPins();
  });
  $("#pform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#pError"), btn = $("#pSave");
    err.hidden = true;
    const username = $("#pUser").value.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) { err.textContent = "Usernames are 3 to 20 lowercase letters, numbers or underscores."; err.hidden = false; $("#pUser").focus(); return; }
    btn.setAttribute("aria-busy", "true");
    const row = { user_id: user.id, username, display_name: $("#pName").value.trim() || null, bio: $("#pBio").value.trim() || null,
      is_public: $("#pPublic").checked, show_ratings: $("#pShow").checked, avatar_album_id: avatarId || null };
    const { data, error } = await sb.from("profiles").upsert(row, { onConflict: "user_id" }).select("*, albums(cover_url)").single();
    btn.removeAttribute("aria-busy");
    if (error) {
      err.textContent = error.code === "23505" ? "That username is taken. Try another."
        : error.code === "23514" ? "That username isn't allowed. Use 3 to 20 lowercase letters, numbers or underscores, and avoid reserved words."
        : `Couldn't save: ${apiError(error)}`;
      err.hidden = false; return;
    }
    profile = { ...data, avatar_cover: data.albums?.cover_url || null };
    renderAccount();
    toast(profile.is_public ? "Profile saved" : "Profile saved. It's private until you make it public.");
    location.hash = profileHref(profile.username);
  });
}

/* ---------- Lists ---------- */
const profileNeedsPublic = () => profile && !profile.is_public;
function listForm(l = {}) {
  return `<label class="field"><span class="field__label">Title</span><input id="lTitle" class="input" maxlength="80" value="${esc(l.title || "")}" required></label>
    <label class="field"><span class="field__label">Description <span class="t-meta">Optional</span></span><textarea id="lDesc" class="textarea" maxlength="500" style="min-height:80px">${esc(l.description || "")}</textarea></label>
    <label class="check"><input type="checkbox" id="lPublic"${l.is_public ? " checked" : ""}><span>Public. Shows on my public profile${profile?.is_public ? "." : " once my profile is public."}</span></label>`;
}
async function renderMyLists(el) {
  if (!sb || !user) {
    el.innerHTML = emptyState({ iconName: "user", title: "Your lists live here", body: "Sign in to make lists of albums, like a top ten of the year.", actions: button("Sign in", { variant: "primary", id: "listSignIn2" }) });
    $("#listSignIn2")?.addEventListener("click", openAuth);
    return;
  }
  const { data, error } = await sb.from("lists").select("id, title, is_public, list_items(position, album:albums(cover_url))").order("updated_at", { ascending: false });
  if (error) { el.innerHTML = errorState({ title: "Couldn't load your lists", retry: () => renderMyLists(el), compact: false }); return; }
  const lists = (data || []).map((l) => { const items = [...(l.list_items || [])].filter((i) => i.album).sort((a, b) => a.position - b.position);
    return { id: l.id, title: l.title, is_public: l.is_public, item_count: items.length, covers: items.slice(0, 4).map((i) => i.album.cover_url) }; });
  el.innerHTML = `<form id="newList" class="form panel" novalidate><h2 class="t-section">New list</h2>${listForm()}
      <p id="lError" class="alert alert--error" role="alert" hidden></p>
      <div><button type="submit" class="btn btn--primary" id="lSave"><span>Create list</span></button></div></form>
    <section class="section" style="margin-top:var(--s-10)">${sectionHead("Your lists", { sub: lists.length ? plural(lists.length, "list") : "" })}
      ${lists.length ? `<div class="listtiles">${lists.map((l) => listTile(l, true)).join("")}</div>` : emptyState({ iconName: "list", compact: true, title: "No lists yet", body: "Create one above, then add albums from any album page." })}</section>`;
  $("#newList").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#lTitle").value.trim(), err = $("#lError");
    if (!title) { err.textContent = "Give your list a title."; err.hidden = false; return; }
    const btn = $("#lSave"); btn.setAttribute("aria-busy", "true"); err.hidden = true;
    const { data: row, error: e2 } = await sb.from("lists").insert({ title, description: $("#lDesc").value.trim() || null, is_public: $("#lPublic").checked }).select("id").single();
    btn.removeAttribute("aria-busy");
    if (e2) { err.textContent = `Couldn't create the list: ${apiError(e2)}`; err.hidden = false; return; }
    location.hash = `#/list/${row.id}`;
  });
}

async function renderList(id) {
  view().innerHTML = `${loadingLabel("Loading list")}<div class="page-head"><div class="sk sk-line" style="height:40px;width:50%"></div></div>${skList(5)}`;
  let list = null, own = false;
  if (sb && user) { const { data } = await sb.from("lists").select("*").eq("id", id).maybeSingle(); if (data) { list = data; own = true; } }
  if (!list && sb) { const { data } = await sb.from("public_lists").select("*").eq("id", id).maybeSingle(); list = data; }
  if (!list) {
    view().innerHTML = emptyState({ iconName: "list", title: "List not found", body: "This list doesn't exist, or its owner keeps it private.", actions: button("Go home", { variant: "primary", href: "#/" }), compact: false });
    return;
  }
  let items = [];
  if (own) {
    const { data } = await sb.from("list_items").select("position, album:albums(id,title,artist,cover_url)").eq("list_id", id).order("position");
    items = (data || []).filter((x) => x.album).map((x) => ({ position: x.position, album_id: x.album.id, title: x.album.title, artist: x.album.artist, cover_url: x.album.cover_url }));
  } else {
    const { data } = await sb.from("public_list_items").select("*").eq("list_id", id).order("position");
    items = data || [];
  }
  document.title = `${list.title} · Rotation`;

  const rowsHTML = () => items.length ? `<ol class="entries">${items.map((x, i) => `<li class="entry">
      <span class="entry__rank">${i + 1}</span>
      <a class="entry__link" href="#/album/${x.album_id}">${artwork(smallArt(x.cover_url), `${x.title} by ${x.artist}`, "thumb")}
        <span class="list-card__text"><span class="list-card__title">${esc(x.title)}</span><span class="list-card__sub">${esc(x.artist || "")}</span></span></a>
      ${own ? `<span class="entry__actions">
        <button type="button" class="icon-btn" data-op="up" data-i="${i}" aria-label="Move ${esc(x.title)} up"${i === 0 ? " disabled" : ""}>${icon("up")}</button>
        <button type="button" class="icon-btn" data-op="down" data-i="${i}" aria-label="Move ${esc(x.title)} down"${i === items.length - 1 ? " disabled" : ""}>${icon("down")}</button>
        <button type="button" class="icon-btn" data-op="remove" data-i="${i}" aria-label="Remove ${esc(x.title)} from the list">${icon("close")}</button></span>` : ""}</li>`).join("")}</ol>`
    : emptyState({ iconName: "disc", compact: true, title: "No albums yet", body: own ? "Open any album and choose Add to list." : "This list is empty.",
        actions: own ? button("Search albums", { variant: "primary", href: "#/search", iconName: "search" }) : "" });

  const head = () => `<header class="page-head">
      <p class="t-meta">${own ? "Your list" : `List by <a href="${profileHref(list.username)}">@${esc(list.username)}</a>`}${own ? (list.is_public ? " · Public" : " · Private") : ""}</p>
      <h1 class="t-title">${esc(list.title)}</h1>
      ${list.description ? `<p class="t-lead">${esc(list.description)}</p>` : ""}
      <div class="chips">${own ? `${button("Edit list", { size: "sm", id: "editList", iconName: "note" })}` : ""}${button("Share", { size: "sm", id: "shareList", iconName: "share" })}</div>
      ${own && list.is_public && profileNeedsPublic() ? `<p class="alert alert--warning" role="status">${icon("alert")}<span>This list is public, but your profile is private, so nobody else can see it. <a href="#/me/edit" style="text-decoration:underline">Make your profile public</a>.</span></p>` : ""}
      ${own && list.is_public && !profile ? `<p class="alert alert--warning" role="status">${icon("alert")}<span>Create a public profile so others can find this list. <a href="#/me/edit" style="text-decoration:underline">Set up profile</a>.</span></p>` : ""}
    </header>`;
  const paint = () => { view().innerHTML = `${head()}<div id="entries">${rowsHTML()}</div><div id="editBox"></div>`; wire(); };

  const swap = async (i, j) => {
    const a = items[i], b = items[j];
    const { error } = await sb.from("list_items").upsert([{ list_id: id, album_id: a.album_id, position: b.position }, { list_id: id, album_id: b.album_id, position: a.position }], { onConflict: "list_id,album_id" });
    if (error) return toast(`Couldn't reorder: ${apiError(error)}`, "error");
    items[i] = { ...b, position: a.position }; items[j] = { ...a, position: b.position };
    $("#entries").innerHTML = rowsHTML();
  };
  function wire() {
    $("#shareList").onclick = async () => {
      const data = { title: list.title, text: `${list.title} on Rotation`, url: location.href };
      if (navigator.share && (!own || list.is_public)) { try { await navigator.share(data); } catch {} return; }
      try { await navigator.clipboard.writeText(location.href); toast(own && !list.is_public ? "Link copied. Only you can open it until the list is public." : "Link copied"); } catch { toast("Copy the link from your address bar", "info"); }
    };
    if (!own) return;
    $("#entries").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-op]"); if (!b) return;
      const i = +b.dataset.i, op = b.dataset.op;
      if (op === "remove") {
        const { error } = await sb.from("list_items").delete().eq("list_id", id).eq("album_id", items[i].album_id);
        if (error) return toast(`Couldn't remove: ${apiError(error)}`, "error");
        items.splice(i, 1); $("#entries").innerHTML = rowsHTML(); toast("Removed from list", "info");
      } else swap(i, op === "up" ? i - 1 : i + 1);
    });
    $("#editList").onclick = () => {
      $("#editBox").innerHTML = `<form id="editForm" class="form panel" novalidate style="margin-top:var(--s-8)"><h2 class="t-section">Edit list</h2>${listForm(list)}
        <p id="lError" class="alert alert--error" role="alert" hidden></p>
        <div class="save-bar" style="margin-top:0"><button type="submit" class="btn btn--primary" id="lSave"><span>Save list</span></button>
        <button type="button" class="btn btn--ghost" id="lCancel">Cancel</button>
        <button type="button" class="btn btn--ghost" id="lDelete" data-danger="1">Delete list</button></div></form>`;
      $("#lTitle").focus();
      $("#lCancel").onclick = () => { $("#editBox").innerHTML = ""; };
      $("#lDelete").onclick = async () => {
        if (!confirm(`Delete “${list.title}”? The albums stay in Rotation; only the list is removed.`)) return;
        const { error } = await sb.from("lists").delete().eq("id", id);
        if (error) return toast(`Couldn't delete: ${apiError(error)}`, "error");
        toast("List deleted", "info"); location.hash = "#/lists/yours";
      };
      $("#editForm").onsubmit = async (e) => {
        e.preventDefault();
        const title = $("#lTitle").value.trim(), err = $("#lError");
        if (!title) { err.textContent = "Give your list a title."; err.hidden = false; return; }
        const btn = $("#lSave"); btn.setAttribute("aria-busy", "true"); err.hidden = true;
        const { data, error } = await sb.from("lists").update({ title, description: $("#lDesc").value.trim() || null, is_public: $("#lPublic").checked }).eq("id", id).select("*").single();
        btn.removeAttribute("aria-busy");
        if (error) { err.textContent = `Couldn't save: ${apiError(error)}`; err.hidden = false; return; }
        list = data; document.title = `${list.title} · Rotation`; paint(); toast("List saved");
      };
    };
  }
  paint();
}

// "Add to list" dialog on the album page
async function openListPicker(album, ensureAlbum) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog";
  dlg.setAttribute("aria-labelledby", "lpTitle");
  dlg.innerHTML = `<div class="dialog__body"><div class="dialog__head"><h2 class="dialog__title" id="lpTitle">Add to list</h2>
    <button type="button" class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div><div id="lpBody">${loadingLabel("Loading your lists")}<div class="sk" style="height:96px"></div></div></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
  dlg.showModal();
  const body = $("#lpBody", dlg);
  const load = async () => {
    const { data, error } = await sb.from("lists").select("id, title, is_public, list_items(album_id)").order("updated_at", { ascending: false });
    if (error) { body.innerHTML = errorState({ title: "Couldn't load your lists", retry: load }); return; }
    body.innerHTML = `${data.length ? `<ul class="picklist">${data.map((l) => { const has = (l.list_items || []).some((i) => i.album_id === album.id);
        return `<li><label class="check"><input type="checkbox" data-list="${l.id}"${has ? " checked" : ""}><span>${esc(l.title)} <span class="t-meta">${l.is_public ? "Public" : "Private"}</span></span></label></li>`; }).join("")}</ul>`
      : `<p class="text-2" style="font-size:var(--fs-sm)">You don't have any lists yet. Make your first one below.</p>`}
      <form id="lpNew" class="lp-new" novalidate><input class="input" id="lpTitleInput" maxlength="80" placeholder="New list title" aria-label="New list title">
        <button type="submit" class="btn btn--primary btn--sm"><span>Create and add</span></button></form>`;
    $$("input[data-list]", body).forEach((cb) => cb.addEventListener("change", async () => {
      cb.disabled = true;
      let error = await ensureAlbum();
      if (!error) ({ error } = cb.checked
        ? await sb.from("list_items").insert({ list_id: cb.dataset.list, album_id: album.id })
        : await sb.from("list_items").delete().eq("list_id", cb.dataset.list).eq("album_id", album.id));
      cb.disabled = false;
      if (error) { cb.checked = !cb.checked; return toast(`Couldn't update the list: ${apiError(error)}`, "error"); }
      toast(cb.checked ? "Added to list" : "Removed from list", cb.checked ? "success" : "info");
    }));
    $("#lpNew", body).addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = $("#lpTitleInput", body).value.trim(); if (!title) return;
      let error = await ensureAlbum(), row = null;
      if (!error) ({ data: row, error } = await sb.from("lists").insert({ title }).select("id").single());
      if (!error) ({ error } = await sb.from("list_items").insert({ list_id: row.id, album_id: album.id }));
      if (error) return toast(`Couldn't create the list: ${apiError(error)}`, "error");
      toast("List created and album added"); load();
    });
  };
  load();
}

/* ==========================================================================
   Router and nav
   ========================================================================== */
function route() {
  const h = location.hash || "#/";
  window.scrollTo(0, 0);
  $("#nav").classList.remove("is-tucked");
  const own = profile && h.toLowerCase() === `#/u/${profile.username}`;
  const section = h.startsWith("#/me") || own ? "me" : /^#\/(genre|genres|explore|decade)\b/.test(h) ? "explore" : /^#\/lists?\b/.test(h) ? "lists"
    : h.startsWith("#/search") ? "search" : h === "#/" || h === "#" ? "discover" : "";
  $$("[data-nav]").forEach((a) => (a.dataset.nav === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  let m;
  if ((m = h.match(/^#\/album\/([0-9a-f-]{36})/i))) return renderAlbum(m[1]);
  if ((m = h.match(/^#\/artist\/([0-9a-f-]{36})/i))) return renderArtist(m[1]);
  if ((m = h.match(/^#\/find-artist\/(.+)$/))) return resolveArtist(decodeURIComponent(m[1]));
  if ((m = h.match(/^#\/find\/([^/]+)\/(.+)$/))) return resolveFind(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if ((m = h.match(/^#\/genre\/([a-z-]+)/))) return renderGenre(m[1]);
  if ((m = h.match(/^#\/u\/([a-z0-9_]{3,20})$/i))) return renderPublicProfile(m[1]);
  if ((m = h.match(/^#\/list\/([0-9a-f-]{36})$/i))) return renderList(m[1]);
  if (h === "#/me/edit") return renderProfileEdit();
  if ((m = h.match(/^#\/decade\/(\d{4})$/))) return renderDecade(+m[1]);
  if ((m = h.match(/^#\/lists(?:\/([a-z]+))?$/))) return renderLists(m[1]);
  if ((m = h.match(/^#\/search(?:\/(.*))?$/))) return renderSearch(m[1] ? decodeURIComponent(m[1]) : "");
  if (h.startsWith("#/explore") || h.startsWith("#/genres")) return renderExplore();
  if (h.startsWith("#/me")) return renderProfile();
  if (h === "#/" || h === "#") return renderHome();
  renderNotFound();
}
window.addEventListener("hashchange", route);

// On phones, tuck the nav away while scrolling down; bring it back on scroll up
let lastY = 0;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  if (window.matchMedia("(max-width: 760px)").matches) $("#nav").classList.toggle("is-tucked", y > lastY && y > 120);
  lastY = y;
}, { passive: true });

// Bottom navigation for phones and small tablets (CSS shows it under 860px)
$("#tabbar").innerHTML = [["discover", "#/", "Discover", "compass"], ["explore", "#/explore", "Explore", "grid"], ["lists", "#/lists", "Lists", "list"],
  ["search", "#/search", "Search", "search"], ["me", "#/me", "Profile", "user"]]
  .map(([key, href, label, ic]) => `<a href="${href}" data-nav="${key}">${icon(ic)}<span>${label}</span></a>`).join("");

(async function start() {
  if (sb) {
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    await loadProfile();
    sb.auth.onAuthStateChange((_e, session) => {
      const changed = (session?.user?.id || null) !== (user?.id || null);
      user = session?.user || null;
      // Deferred: calling Supabase from inside this callback can deadlock the auth client
      setTimeout(async () => { if (changed) await loadProfile(); renderAccount(); if (changed) route(); }, 0);
    });
  }
  renderAccount();
  route();
})();
