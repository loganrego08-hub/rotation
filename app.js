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
  };
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

function scoreChip(value, { mine = false, count } = {}) {
  if (value == null) return "";
  const title = mine ? "Your score" : count != null ? `Average of ${plural(count, "rating")}` : "Average score";
  return `<span class="score${mine ? " score--mine" : ""}" title="${title}"><span class="sr">${title}: </span>${value}<small>/10</small></span>`;
}

function metaLine(text, kind) {
  if (!text) return "";
  const ic = { up: "up", down: "down", new: "spark" }[kind];
  return `<span class="meta${kind ? ` meta--${kind}` : ""}">${ic ? icon(ic) : ""}<span>${esc(text)}</span></span>`;
}

function albumCard(it, { rank, score, mine = false, count, meta, metaKind } = {}) {
  const m = meta != null ? { text: meta, kind: metaKind } : it.move ? { text: it.move.text, kind: it.move.kind } : it.why ? { text: it.why } : null;
  const foot = (m || score != null) ? `<div class="album-card__foot">${m ? metaLine(m.text, m.kind) : "<span></span>"}${scoreChip(score, { mine, count })}</div>` : "";
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

function reviewCard({ name, date, score, body, standouts = [] }) {
  return `<article class="review-card">
    <header class="review-card__head">
      <span class="avatar" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>
      <span class="review-card__who"><strong>${esc(name)}</strong><span class="t-meta">${date ? `Rated ${fmtDate(date, "short")}` : ""}</span></span>
      ${scoreChip(score, { mine: true })}
    </header>
    <p class="review-card__body${body ? "" : " review-card__body--empty"}">${body ? esc(body) : "No notes yet. Add a few thoughts below."}</p>
    ${standouts.length ? `<div class="chips">${standouts.map((t) => `<span class="chip chip--static">${icon("star")}${esc(t)}</span>`).join("")}</div>` : ""}
  </article>`;
}

function profileHeader({ initial, eyebrow, name, stats = [], extra = "" }) {
  return `<header class="profile">
    <span class="avatar avatar--lg" aria-hidden="true">${esc(initial)}</span>
    <div>
      ${eyebrow ? `<p class="profile__eyebrow">${esc(eyebrow)}</p>` : ""}
      <h1 class="t-title">${esc(name)}</h1>
      ${stats.length ? `<dl class="profile__stats">${stats.map((s) => `<div class="stat"><dt class="stat__label">${esc(s.label)}</dt><dd class="stat__value" style="margin:0">${esc(s.value)}</dd></div>`).join("")}</dl>` : ""}
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
const displayName = () => (user?.email || "You").split("@")[0];
function renderAccount() {
  const el = $("#account");
  if (!sb) { el.innerHTML = ""; return; }
  if (!user) { el.innerHTML = button("Sign in", { variant: "primary", size: "sm", id: "signIn" }); $("#signIn").onclick = openAuth; return; }
  el.innerHTML = `<button type="button" class="avatar" id="acctBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">${esc(displayName().charAt(0).toUpperCase())}</button>
    <div class="menu menu--account" id="acctMenu" role="menu" hidden>
      <div class="menu__label">${esc(user.email)}</div>
      <a class="menu__item" role="menuitem" href="#/me">${icon("user")}Your profile</a>
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
let searchTimer, searchSeq = 0;
const q = $("#q"), results = $("#results");
function setResults(open) { results.hidden = !open; q.setAttribute("aria-expanded", String(open)); }
q.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const v = q.value.trim();
  if (v.length < 2) return setResults(false);
  searchTimer = setTimeout(() => search(v), 320);
});
q.addEventListener("keydown", (e) => {
  const items = $$(".menu__item", results);
  const i = items.findIndex((x) => x.getAttribute("aria-selected") === "true");
  if (e.key === "Escape") { setResults(false); q.blur(); }
  if (!items.length || results.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((x, k) => x.setAttribute("aria-selected", String(k === n)));
    items[n].scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter" && i >= 0) { e.preventDefault(); items[i].click(); }
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) setResults(false); });
results.addEventListener("click", (e) => { if (e.target.closest("a")) { setResults(false); q.value = ""; } });

async function search(term) {
  const seq = ++searchSeq;
  setResults(true);
  results.innerHTML = `<p class="menu__note">Searching…</p>`;
  try {
    const [artists, albums] = await Promise.all([
      getJSON(`${MB}/artist?query=${encodeURIComponent(term)}&fmt=json&limit=3`).catch(() => ({ artists: [] })),
      getJSON(`${MB}/release-group?query=${encodeURIComponent(`${term} AND primarytype:album`)}&fmt=json&limit=8`),
    ]);
    if (seq !== searchSeq) return;
    const ar = (artists.artists || []).filter((a) => a.score >= 90);
    const al = albums["release-groups"] || [];
    if (!ar.length && !al.length) { results.innerHTML = `<p class="menu__note">No matches for “${esc(term)}”. Try the artist and album together.</p>`; return; }
    results.innerHTML = `
      ${ar.length ? `<div class="menu__group"><div class="menu__label">Artists</div>${ar.map((a) => `
        <a class="menu__item" role="option" href="#/artist/${a.id}"><span class="avatar" aria-hidden="true">${esc(a.name.charAt(0).toUpperCase())}</span>
        <span class="menu__text"><strong>${esc(a.name)}</strong><span>${esc([a.type, a.area?.name].filter(Boolean).join(", ") || "Artist")}</span></span></a>`).join("")}</div>` : ""}
      ${al.length ? `<div class="menu__group"><div class="menu__label">Albums</div>${al.map((g) => `
        <a class="menu__item" role="option" href="#/album/${g.id}">${artwork(coverUrl(g.id, 250), g.title, "thumb")}
        <span class="menu__text"><strong>${esc(g.title)}</strong><span>${esc(artistName(g["artist-credit"]))}${g["first-release-date"] ? `, ${year(g["first-release-date"])}` : ""}</span></span></a>`).join("")}</div>` : ""}`;
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

/* ---------- Home ---------- */
async function renderHome() {
  document.title = "Rotation";
  view().innerHTML = `
    <section class="intro">
      <h1 class="t-hero">What's in rotation</h1>
      <p class="t-lead">Score albums out of 10, mark the tracks that stay with you, and see where everyone else lands.</p>
    </section>
    <section class="section" aria-labelledby="h-charts">
      ${sectionHead("On the charts", { sub: "Billboard 200", id: "chartsSub" }).replace("<h2", '<h2 id="h-charts"')}
      <div class="row" id="charts">${loadingLabel("Loading chart")}${skCards(7)}</div>
    </section>
    <section class="section" id="recShelf" hidden>
      ${sectionHead("Recommended for you", { sub: "", id: "recWhy" })}
      <div class="row" id="recs">${skCards(6)}</div>
    </section>
    <section class="section">
      ${sectionHead("Browse by genre", { sub: "Billboard's weekly album charts", link: "#/genres", linkLabel: "All genres" })}
      <div class="genres">${GENRES.slice(0, 6).map(genreCard).join("")}</div>
    </section>
    <section class="section">
      ${sectionHead("Top rated on Rotation", { sub: "Highest community averages" })}
      <div class="row" id="community">${skCards(6)}</div>
    </section>
    <section class="section">
      ${sectionHead("Your shelf", { sub: "Your highest-scored albums", link: user ? "#/me" : null, linkLabel: "See all" })}
      <div id="mine">${user ? skList(3) : ""}</div>
    </section>`;
  fillGenreCards(view());
  loadCharts(); loadCommunity(); loadShelf(); loadRecs();
}

async function loadCharts() {
  const el = $("#charts");
  try {
    const c = await billboard("billboard-200");
    if (!el.isConnected) return;
    $("#chartsSub").textContent = `Billboard 200${c.week ? `, week of ${fmtDate(c.week)}` : ""}`;
    el.innerHTML = c.items.slice(0, 24).map((it) => albumCard(it, { rank: it.rank })).join("");
  } catch {
    el.outerHTML = `<div id="charts">${errorState({ title: "Charts didn't load", body: "Billboard data is temporarily unavailable.", retry: loadChartsAgain })}</div>`;
  }
}
function loadChartsAgain() { $("#charts").outerHTML = `<div class="row" id="charts">${skCards(7)}</div>`; cache.delete(CHART("billboard-200")); loadCharts(); }

async function loadCommunity() {
  const el = $("#community");
  if (!sb) { el.outerHTML = emptyState({ title: "Community scores are offline", compact: true }); return; }
  const { data, error } = await sb.from("album_stats").select("*").order("avg_score", { ascending: false }).order("rating_count", { ascending: false }).limit(24);
  if (!el.isConnected) return;
  if (error) { el.outerHTML = `<div id="community">${errorState({ title: "Couldn't load community scores", retry: () => { $("#community").outerHTML = `<div class="row" id="community">${skCards(6)}</div>`; loadCommunity(); } })}</div>`; return; }
  if (!data.length) { el.outerHTML = `<div id="community">${emptyState({ iconName: "star", title: "No community scores yet", body: "When people start rating, the best-loved albums show up here.", compact: true })}</div>`; return; }
  el.innerHTML = data.map((s) => albumCard({ id: s.album_id, title: s.title, artist: s.artist, art: s.cover_url },
    { score: s.avg_score, count: s.rating_count, meta: plural(s.rating_count, "rating") })).join("");
}

async function loadShelf() {
  const el = $("#mine");
  if (!sb) return;
  if (!user) {
    el.innerHTML = emptyState({ iconName: "disc", title: "Start your shelf",
      body: "Sign in to score albums. Your rankings, notes and standout tracks live here.",
      actions: button("Sign in", { variant: "primary", id: "shelfSignIn" }) });
    $("#shelfSignIn").onclick = openAuth;
    return;
  }
  try {
    const rows = await myRatings();
    if (!el.isConnected) return;
    el.innerHTML = rows.length
      ? `<div class="list">${rows.slice(0, 5).map((r, i) => listCard(r, i + 1)).join("")}</div>`
      : emptyState({ iconName: "disc", title: "Nothing rated yet", body: "Pick any album from the charts above, give it a score, and it lands here.",
          actions: button("Search albums", { id: "focusSearch", iconName: "search" }) });
    $("#focusSearch")?.addEventListener("click", () => q.focus());
  } catch { el.innerHTML = errorState({ title: "Couldn't load your shelf", retry: loadShelf }); }
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
  if (!ratings.length) {
    $("#recWhy").textContent = "Popular this week. Rate a few albums and these tune to your taste.";
    try { const c = await billboard("billboard-200"); if (el.isConnected) el.innerHTML = c.items.slice(0, 12).map((it) => albumCard({ ...it, move: null, why: `#${it.rank} on the Billboard 200` })).join(""); }
    catch { if (el.isConnected) el.outerHTML = errorState({ title: "Recommendations didn't load" }); }
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

/* ---------- Genres ---------- */
function renderGenres() {
  document.title = "Genres · Rotation";
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Genres</h1><p class="t-lead">Billboard's weekly album charts, one per genre. Updated every Tuesday.</p></header>
    <div class="genres">${GENRES.map(genreCard).join("")}</div>`;
  fillGenreCards(view());
}

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
    const body = !rows.length
      ? emptyState({ iconName: "disc", title: "Your shelf is empty", body: "Score your first album and your rankings, notes and standout tracks will collect here.",
          actions: button("Browse the charts", { variant: "primary", href: "#/" }) + button("Search albums", { id: "profSearch", iconName: "search" }) })
      : !list.length
        ? emptyState({ iconName: "note", title: "No notes yet", body: "Add thoughts when you score an album and they'll appear here.", compact: true })
        : profileView === "list"
          ? `<div class="list">${list.map((r, i) => listCard(r, profileTab === "ranked" ? i + 1 : "")).join("")}</div>`
          : `<div class="grid">${list.map((r) => albumCard({ id: r.album.id, title: r.album.title, artist: r.album.artist, art: r.album.cover_url },
              { score: r.score, mine: true, meta: r.thoughts ? "Has notes" : null })).join("")}</div>`;
    view().innerHTML = `
      ${profileHeader({ initial: displayName().charAt(0).toUpperCase(), name: displayName(), eyebrow: since, stats: [
        { label: "Albums rated", value: rows.length }, { label: "Average score", value: avg },
        { label: "Standout tracks", value: standouts }, { label: "Top genre", value: topGenre }] })}
      <div class="toolbar">
        ${tabs([["ranked", "Ranked"], ["recent", "Recently rated"], ["notes", "With notes"]], profileTab, "Sort your shelf")}
        <div class="segmented" role="group" aria-label="Layout">
          <button type="button" data-view="list" aria-pressed="${profileView === "list"}" aria-label="List view">${icon("list")}</button>
          <button type="button" data-view="grid" aria-pressed="${profileView === "grid"}" aria-label="Grid view">${icon("grid")}</button>
        </div>
      </div>
      ${body}`;
    $$("[data-tab]").forEach((b) => b.onclick = () => { profileTab = b.dataset.tab; draw(); });
    $$("[data-view]").forEach((b) => b.onclick = () => { profileView = b.dataset.view; draw(); });
    $("#profSearch")?.addEventListener("click", () => q.focus());
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
  const active = span.begin ? `${year(span.begin)}–${span.ended ? year(span.end) || "" : "present"}` : "–";
  const genres = (a.genres || []).sort((x, y) => y.count - x.count).slice(0, 4);
  view().innerHTML = `
    ${profileHeader({
      initial: a.name.charAt(0).toUpperCase(), name: a.name,
      eyebrow: [a.type, a.area?.name].filter(Boolean).join(", "),
      stats: [{ label: "Studio albums", value: albums.length }, { label: "Active", value: active }],
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
    actions: button("Search", { id: "findSearch", iconName: "search" }) });
  $("#findSearch").onclick = () => { q.value = `${title} ${artist}`; q.focus(); search(q.value); };
}

/* ---------- Album page ---------- */
function recordSvg(score) {
  const rings = Array.from({ length: 10 }, (_, i) => `<circle class="groove ${score && 10 - i <= score ? "on" : ""}" cx="68" cy="68" r="${64 - i * 3.7}"/>`).join("");
  return `<svg class="record" viewBox="0 0 136 136" role="img" aria-label="${score ? `Your score: ${score} out of 10` : "Not rated yet"}">
    ${rings}<circle class="label" cx="68" cy="68" r="24"/><text class="num" x="68" y="69" text-anchor="middle" dominant-baseline="central">${score || "–"}</text></svg>`;
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
  document.title = `${album.title} by ${album.artist} · Rotation`;

  let mine = null, stats = null;
  if (sb) {
    const [s, r] = await Promise.all([
      sb.from("album_stats").select("avg_score, rating_count").eq("album_id", id).maybeSingle(),
      user ? sb.from("ratings").select("*").eq("album_id", id).eq("user_id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    stats = s.data; mine = r.data;
  }
  const state = { score: mine?.score || 0, standouts: new Set(mine?.standout_tracks || []) };
  const total = album.tracks?.reduce((s, t) => s + (t.length || 0), 0);
  const artistHref = album.artist_id ? `#/artist/${album.artist_id}` : `#/find-artist/${encodeURIComponent(album.artist)}`;
  const facts = [year(album.release_date), album.tracks?.length ? plural(album.tracks.length, "track") : "", total ? `${Math.round(total / 60000)} min` : ""].filter(Boolean);

  view().innerHTML = `
    <article class="album">
      <div class="album__art">${artwork(album.cover_url, `${album.title} by ${album.artist}`)}</div>
      <div>
        <header class="album__head">
          <h1 class="t-title">${esc(album.title)}</h1>
          <a class="album__artist" href="${artistHref}">${esc(album.artist)}</a>
          <div class="album__facts">${facts.map((f, i) => `${i ? '<span class="dot" aria-hidden="true"></span>' : ""}<span>${esc(f)}</span>`).join("")}</div>
          ${album.genres?.length ? `<div class="chips">${album.genres.map((n) => { const g = matchGenre(n);
            return g ? `<a class="chip" href="#/genre/${g.slug}">${esc(n)}</a>` : `<span class="chip chip--static">${esc(n)}</span>`; }).join("")}</div>` : ""}
        </header>

        <section class="rating-panel" aria-label="Scores">
          <div id="rec">${recordSvg(state.score)}</div>
          <div class="rating-panel__side">
            <div class="rating-stats">
              <div class="rating-stat"><span class="t-meta">Community</span>
                ${stats ? `<span class="score score--lg">${stats.avg_score}<small> /10</small></span><span class="t-meta">${plural(stats.rating_count, "rating")}</span>`
                        : `<span class="text-2" style="font-size:var(--fs-sm)">No ratings yet</span>`}</div>
              <div class="rating-stat"><span class="t-meta">You</span><span class="score score--lg" id="myScore">${state.score || "–"}<small> /10</small></span></div>
            </div>
            <div><p class="t-label" id="pickLabel" style="margin-bottom:var(--s-2)">${mine ? "Change your score" : "Your score"}</p>
              <div class="picker" id="picker" role="group" aria-labelledby="pickLabel">${Array.from({ length: 10 }, (_, i) =>
                `<button type="button" data-s="${i + 1}" aria-pressed="${state.score === i + 1}">${i + 1}</button>`).join("")}</div></div>
          </div>
        </section>

        ${mine ? `<section class="block"><h2 class="t-section">Your review</h2>${reviewCard({ name: displayName(), date: mine.updated_at, score: mine.score, body: mine.thoughts, standouts: mine.standout_tracks || [] })}</section>` : ""}

        <section class="block">
          <div class="block__head"><h2 class="t-section">Tracklist</h2><span class="t-meta">Star your standouts</span></div>
          ${album.tracks?.length ? `<ol class="tracks" id="tracks">${album.tracks.map((t) => `
            <li class="track${state.standouts.has(t.title) ? " is-standout" : ""}">
              <span class="track__pos">${esc(t.pos)}</span><span class="track__title">${esc(t.title)}</span>
              <span class="track__len">${fmtLen(t.length)}</span>
              <button type="button" class="icon-btn" data-t="${esc(t.title)}" aria-pressed="${state.standouts.has(t.title)}" aria-label="Standout: ${esc(t.title)}">${icon("star")}</button>
            </li>`).join("")}</ol>`
            : emptyState({ iconName: "note", title: "No tracklist listed", body: "MusicBrainz doesn't have tracks for this album yet. You can still score it.", plain: true })}
        </section>

        <section class="block">
          <label class="field"><span class="t-section">Notes</span>
            <textarea id="thoughts" class="textarea" placeholder="What stuck with you? Favorite moments, how it holds up, where it fits.">${esc(mine?.thoughts || "")}</textarea>
            <span class="field__hint">Only you can see your notes. Your score counts toward the community average.</span>
          </label>
        </section>

        <div class="save-bar">
          ${button(mine ? "Update rating" : "Save rating", { variant: "primary", id: "save" })}
          ${mine ? button("Remove rating", { variant: "ghost", id: "remove", attrs: 'data-danger="1"' }) : ""}
        </div>
      </div>
    </article>`;

  $("#picker").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.score = +b.dataset.s;
    $$("#picker button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#rec").innerHTML = recordSvg(state.score);
    $("#myScore").innerHTML = `${state.score}<small> /10</small>`;
  });
  $("#tracks")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]"); if (!b) return;
    const t = b.dataset.t, on = !state.standouts.has(t);
    on ? state.standouts.add(t) : state.standouts.delete(t);
    b.setAttribute("aria-pressed", String(on));
    b.closest(".track").classList.toggle("is-standout", on);
  });
  $("#save").onclick = async () => {
    if (!sb) return toast("Ratings are offline right now", "error");
    if (!user) return openAuth();
    if (!state.score) return toast("Pick a score from 1 to 10 first", "info");
    const btn = $("#save"); btn.setAttribute("aria-busy", "true");
    const { error: aErr } = await sb.from("albums").upsert({
      id: album.id, title: album.title, artist: album.artist, release_date: album.release_date,
      cover_url: album.cover_url, tracks: album.tracks, genres: album.genres || [],
    });
    const { error } = aErr ? { error: aErr } : await sb.from("ratings").upsert({
      user_id: user.id, album_id: album.id, score: state.score,
      standout_tracks: [...state.standouts], thoughts: $("#thoughts").value.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,album_id" });
    btn.removeAttribute("aria-busy");
    if (error) return toast(`Couldn't save: ${error.message}`, "error");
    toast(mine ? "Rating updated" : "Rating saved");
    renderAlbum(id);
  };
  $("#remove")?.addEventListener("click", async () => {
    if (!confirm("Remove your rating for this album?")) return;
    const { error } = await sb.from("ratings").delete().eq("id", mine.id);
    if (error) return toast(`Couldn't remove: ${error.message}`, "error");
    toast("Rating removed", "info");
    renderAlbum(id);
  });
}

function renderNotFound() {
  view().innerHTML = emptyState({ iconName: "search", title: "Page not found", body: "That link doesn't go anywhere in Rotation.", actions: button("Go home", { variant: "primary", href: "#/" }) });
}

/* ==========================================================================
   Router and nav
   ========================================================================== */
function route() {
  const h = location.hash || "#/";
  window.scrollTo(0, 0);
  $("#nav").classList.remove("is-tucked");
  const section = h.startsWith("#/me") ? "me" : h.startsWith("#/genre") ? "genres" : h === "#/" ? "home" : "";
  $$("[data-nav]").forEach((a) => (a.dataset.nav === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  let m;
  if ((m = h.match(/^#\/album\/([0-9a-f-]{36})/i))) return renderAlbum(m[1]);
  if ((m = h.match(/^#\/artist\/([0-9a-f-]{36})/i))) return renderArtist(m[1]);
  if ((m = h.match(/^#\/find-artist\/(.+)$/))) return resolveArtist(decodeURIComponent(m[1]));
  if ((m = h.match(/^#\/find\/([^/]+)\/(.+)$/))) return resolveFind(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if ((m = h.match(/^#\/genre\/([a-z-]+)/))) return renderGenre(m[1]);
  if (h.startsWith("#/genres")) return renderGenres();
  if (h.startsWith("#/me")) return renderProfile();
  if (h === "#/" || h === "#") return renderHome();
  renderNotFound();
}
window.addEventListener("hashchange", route);

// On phones, tuck the nav away while scrolling down; bring it back on scroll up
let lastY = 0;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  if (window.matchMedia("(max-width: 760px)").matches && results.hidden) $("#nav").classList.toggle("is-tucked", y > lastY && y > 120);
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
