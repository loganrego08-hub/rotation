/* Rotation: rate and rank albums */
const cfg = window.ROTATION_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
const sb = configured ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
// Pure helpers (query building, labels, notes) live in lib.js so they can be unit tested
const RL = window.RotationLib;
const { lucene, albumQuery, typeLabel, spreadNote } = RL;
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
   Navigation helpers (path routing)
   The address bar holds real paths (/album/<id>, /search/<term>?type=album). here() is the current path plus query; go() moves to a new one
   like a link would (pushState, then route). Old #/path links are rewritten to paths by a small script in index.html before this file runs.
   ========================================================================== */
const here = () => (location.pathname.replace(/(.)\/+$/, "$1") || "/") + location.search;
function go(path, { replace = false } = {}) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) { if (/^https?:$/.test(url.protocol)) location.href = url.href; return; }   // never javascript:, data: or similar
  const next = url.pathname + url.search + url.hash;
  if (next === location.pathname + location.search + location.hash) { route(); return; }
  history[replace ? "replaceState" : "pushState"](null, "", next);
  route();
}
/* ==========================================================================
   Data sources
   ========================================================================== */
const cache = new Map();
function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  // MusicBrainz answers 503 when it is rate limiting a burst; one patient retry usually clears it
  const get = async (retry) => {
    const r = await fetch(url);
    if (r.status === 503 && retry) { await new Promise((ok) => setTimeout(ok, 1500)); return get(false); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const p = get(true);
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
const albumHref = (it) => it.id ? `/album/${it.id}` : `/find/${encodeURIComponent(it.artist)}/${encodeURIComponent(it.title)}`;

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
  spark: '<path d="M7 17 17 7M9 7h8v8"/>',   /* a plain diagonal arrow: no sparkle icons */
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
  bell: '<path d="M6 17h12l-1.5-2v-5a4.5 4.5 0 0 0-9 0v5zM10 20a2 2 0 0 0 4 0"/>',
  flag: '<path d="M5 21V4M5 5h11l-2 4 2 4H5"/>',
  pin: '<path d="M12 17v5M8 3h8l-1 6 3 3H6l3-3z"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/>',
  play: '<path d="M8 5.5v13L18.5 12z"/>',
};
const icon = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

function button(label, { variant = "secondary", size, id, href, iconName, attrs = "" } = {}) {
  const cls = `btn btn--${variant}${size ? ` btn--${size}` : ""}`;
  const inner = `${iconName ? icon(iconName) : ""}<span>${esc(label)}</span>`;
  return href ? `<a class="${cls}" href="${href}" ${id ? `id="${id}"` : ""} ${attrs}>${inner}</a>`
              : `<button type="button" class="${cls}" ${id ? `id="${id}"` : ""} ${attrs}>${inner}</button>`;
}

// Cover Art Archive serves 250 and 500px versions (and 1200 for some): small covers get a 500px version on high-density screens.
// `priority` is for the one image that matters most on a page (it loads eagerly and first).
function artwork(src, alt, cls = "", { priority = false } = {}) {
  const fallback = `<div class="art__fallback">${icon("disc")}</div>`;
  if (!src) return `<div class="art ${cls}" role="img" aria-label="${esc(alt)}">${fallback}</div>`;
  // Only 250 -> 500 is used: the 1200px size isn't generated for every release, and a failed srcset candidate would hide the cover
  const m = /^(.*\/front-)250$/.exec(src);
  const srcset = m ? ` srcset="${esc(src)} 1x, ${esc(m[1] + "500")} 2x"` : "";
  return `<div class="art ${cls}"><img src="${esc(src)}"${srcset} alt="${esc(alt)}" ${priority ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async"
    onerror="this.parentNode.insertAdjacentHTML('beforeend', this.dataset.fb); this.remove()" data-fb="${esc(fallback)}"></div>`;
}
// Ambient album tint: the dominant color of the cover, drawn on a 32px canvas. The cover is loaded a second time with CORS on; if the
// host doesn't allow it the canvas is tainted, getImageData throws, and the page simply gets no tint. Cached for the session.
const tintCache = new Map();
function ambientTint(url) {
  if (!url) return Promise.resolve(null);
  const src = smallArt(url);
  if (tintCache.has(src)) return tintCache.get(src);
  const p = new Promise((done) => {
    const img = new Image(), timer = setTimeout(() => done(null), 5000);
    img.crossOrigin = "anonymous";
    img.onload = () => {
      clearTimeout(timer);
      try {
        const c = document.createElement("canvas"); c.width = c.height = 32;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, 32, 32);
        done(RL.tintFromPixels(g.getImageData(0, 0, 32, 32).data)?.css || null);
      } catch { done(null); }
    };
    img.onerror = () => { clearTimeout(timer); done(null); };
    img.src = src;
  });
  tintCache.set(src, p);
  return p;
}
// Sets --album-tint on the album page, then marks it so the CSS fades the tint in (neutral first, so nothing flashes)
async function applyAlbumTint(url) {
  const tint = await ambientTint(url);
  const page = $(".album2");
  if (!tint || !page || !page.isConnected) return;
  page.style.setProperty("--album-tint", tint);
  setTimeout(() => { page.dataset.tinted = "1"; }, 40);   // a timer, not requestAnimationFrame: rAF is paused in background tabs
}
// Re-tints an element when its score changes (the same ramp as RL.toneAttr)
const setTone = (el, n) => { if (!el) return; const t = RL.scoreTone(n); if (t) el.dataset.tone = t; else delete el.dataset.tone; };
const smallArt = (u) => (u || "").replace("/front-500", "/front-250");

function scoreChip(value, { mine = false, count, label } = {}) {
  if (value == null) return "";
  const title = label || (mine ? "Your score" : count != null ? `Average of ${plural(count, "rating")}` : "Average score");
  return `<span class="score${mine ? " score--mine" : ""}"${RL.toneAttr(value)} title="${title}"><span class="sr">${title}: </span>${value}<small>/10</small></span>`;
}

function metaLine(text, kind) {
  if (!text) return "";
  const ic = { up: "up", down: "down", new: "spark" }[kind];
  return `<span class="meta${kind ? ` meta--${kind}` : ""}${text.length > 30 ? " meta--wrap" : ""}" title="${esc(text)}">${ic ? icon(ic) : ""}<span>${esc(text)}</span></span>`;
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
  return `<a class="artist-card" href="/artist/${a.id}">
    <div class="artist-card__img" aria-hidden="true">${esc((a.name || "?").trim().charAt(0).toUpperCase())}</div>
    <div><div class="artist-card__name">${esc(a.name)}</div>${a.sub ? `<div class="t-meta">${esc(a.sub)}</div>` : ""}</div></a>`;
}

function listCard(r, rank) {
  const a = r.album;
  return `<a class="list-card" href="/album/${a.id}">
    <span class="list-card__rank">${rank}</span>
    ${artwork(smallArt(a.cover_url), `${a.title} by ${a.artist}`, "thumb")}
    <span class="list-card__text"><span class="list-card__title">${esc(a.title)}</span><span class="list-card__sub">${esc(a.artist)}${r.thoughts ? " · has notes" : ""}</span></span>
    ${scoreChip(r.score, { mine: true })}</a>`;
}

function reviewCard({ name, date, score, body, standouts = [], mine = false, href, footer = "" }) {
  return `<article class="review-card">
    <header class="review-card__head">
      <span class="avatar" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>
      <span class="review-card__who">${href ? `<a href="${href}"><strong>${esc(name)}</strong></a>` : `<strong>${esc(name)}</strong>`}<span class="t-meta">${date ? `Reviewed ${fmtDate(String(date).slice(0, 10), "short")}` : ""}</span></span>
      ${scoreChip(score, { mine, label: mine ? undefined : "Reviewer's score" })}
    </header>
    <p class="review-card__body${body ? "" : " review-card__body--empty"}">${body ? esc(body) : "No notes yet. Add a few thoughts below."}</p>
    ${standouts.length ? `<div class="chips">${standouts.map((t) => `<span class="chip chip--static">${icon("star")}${esc(t)}</span>`).join("")}</div>` : ""}
    ${footer}
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
  return `<a class="genre-card" href="/genre/${g.slug}" data-genre="${g.slug}">
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
  el.innerHTML = `<a class="icon-btn bell" id="bell" href="/notifications" aria-label="Notifications">${icon("bell")}<span class="bell__badge" id="bellBadge" hidden></span></a>
    <button type="button" class="avatar" id="acctBtn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">${profile?.avatar_cover ? `<img src="${esc(smallArt(profile.avatar_cover))}" alt="" onerror="this.remove()">` : esc(displayName().charAt(0).toUpperCase())}</button>
    <div class="menu menu--account" id="acctMenu" role="menu" hidden>
      <div class="menu__label">${esc(user.email)}</div>
      <a class="menu__item" role="menuitem" href="/me">${icon("disc")}Your shelf</a>
      <a class="menu__item" role="menuitem" href="/stats">${icon("star")}Your stats</a>
      <a class="menu__item" role="menuitem" href="${profile ? profileHref(profile.username) : "/me/edit"}">${icon("user")}${profile ? "Your profile" : "Create profile"}</a>
      <a class="menu__item" role="menuitem" href="/lists/yours">${icon("list")}Your lists</a>
      <a class="menu__item" role="menuitem" href="/feed">${icon("spark")}Following</a>
      <a class="menu__item" role="menuitem" href="/notifications">${icon("bell")}Notifications</a>
      <a class="menu__item" role="menuitem" href="/settings">${icon("note")}Settings</a>
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
/* ==========================================================================
   Streaming service
   The preferred service is saved on the account (Supabase user metadata, so it works without a profile) and on this device, so signed-out
   visitors can pick one too. The account's choice wins after sign-in; if the account has none, the device's choice is saved to it.
   Listen links are search URLs at first (always correct), then upgraded to direct album and song links from /api/listen when it finds them.
   ========================================================================== */
const STREAM_KEY = "rotation:streaming";
const validService = (id) => (RL.streamingService(id) ? id : null);
let streamPref = null;
const readLocalService = () => { try { return validService(localStorage.getItem(STREAM_KEY)); } catch { return null; } };
function loadStreamPref() { streamPref = validService(user?.user_metadata?.streaming_service) || readLocalService(); }
const getStream = () => streamPref;
const streamLabel = (id) => RL.streamingService(id)?.label || "";
async function setStream(id) {
  streamPref = validService(id);
  try { streamPref ? localStorage.setItem(STREAM_KEY, streamPref) : localStorage.removeItem(STREAM_KEY); } catch {}
  document.dispatchEvent(new CustomEvent("rotation:streaming"));
  if (sb && user) {
    const { error } = await sb.auth.updateUser({ data: { streaming_service: streamPref } });
    if (error) { toast("Saved on this device, but not to your account. Try again later.", "error"); return false; }
  }
  return true;
}
async function syncStreamPref() {
  const meta = validService(user?.user_metadata?.streaming_service), local = readLocalService();
  if (meta) { streamPref = meta; try { localStorage.setItem(STREAM_KEY, meta); } catch {} }
  else if (user && local) { streamPref = local; await sb.auth.updateUser({ data: { streaming_service: local } }).catch(() => {}); }
}
// The sign-up form's service picker
$("#authService").innerHTML = `<option value="">Choose later</option>${RL.STREAMING_SERVICES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}`;

// Asks where the person listens. pick(id) runs inside the click that chose, so a tab opened from it isn't treated as a blocked popup.
function chooseService(pick) {
  let dlg = $("#svcDialog");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "svcDialog"; dlg.className = "dialog"; dlg.setAttribute("aria-labelledby", "svcTitle"); document.body.appendChild(dlg); }
  dlg.innerHTML = `<div class="dialog__body">
    <div class="dialog__head"><h2 id="svcTitle" class="dialog__title">Where do you listen?</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div>
    <p class="text-2">Pick your streaming service. Listen buttons open albums and songs there. You can change it any time in Settings.</p>
    <div class="svcpick" role="group" aria-label="Streaming services">${RL.STREAMING_SERVICES.map((s) => `<button type="button" class="svc" data-svc="${s.id}">${esc(s.label)}</button>`).join("")}</div></div>`;
  dlg.onclick = (e) => {
    if (e.target === dlg || e.target.closest("[data-close]")) return dlg.close();
    const b = e.target.closest("[data-svc]"); if (!b) return;
    const id = b.dataset.svc;
    try { pick?.(id); } finally { dlg.close(); }
    setStream(id).then((ok) => { if (ok) toast(`Listen opens ${streamLabel(id)}`); });
  };
  dlg.showModal();
}

const listenMemo = new Map();
function listenLookup(params) {
  const key = params.toString();
  if (!listenMemo.has(key)) listenMemo.set(key, fetch(`/api/listen?${key}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return listenMemo.get(key);
}
let listenPaint = null;
// Album page: points the Listen button and every song's icon at the chosen service
function wireListen(album) {
  const page = $(".album2");
  if (!page) return;
  const albumQuery = RL.listenQuery(album.artist, album.title);
  let seq = 0;
  async function paint() {
    if (!page.isConnected) return document.removeEventListener("rotation:streaming", paint);
    const svc = getStream(), mine = ++seq, btn = $("#listenBtn"), note = $("#listenNote");
    if (!btn) return;
    $("span", btn).textContent = svc ? `Listen on ${streamLabel(svc)}` : "Listen";
    btn.href = svc ? RL.streamingSearchUrl(svc, albumQuery) : "/settings";
    if (note) { note.hidden = !svc; const nm = $("[data-svc-name]", note); if (nm) nm.textContent = streamLabel(svc); }
    $$(".track__listen").forEach((a) => {
      const label = svc ? `Listen to ${a.dataset.track} on ${streamLabel(svc)}` : `Listen to ${a.dataset.track}`;
      a.href = svc ? RL.streamingSearchUrl(svc, RL.listenQuery(album.artist, album.title, a.dataset.track), "track") : "/settings";
      a.setAttribute("aria-label", label); a.title = label;
    });
    if (!svc) return;
    // Upgrade the search links to direct ones when they can be found
    const p = new URLSearchParams({ service: svc, artist: album.artist, title: album.title, mbid: album.id });
    const a = await listenLookup(p);
    if (mine === seq && a?.direct) btn.href = a.url;
    if (["apple", "deezer", "spotify"].includes(svc)) {
      const tp = new URLSearchParams(p); tp.set("tracks", "1");
      const t = await listenLookup(tp);
      if (mine === seq && t?.tracks) $$(".track__listen").forEach((el) => { const u = t.tracks[RL.stripBrackets(el.dataset.track)]; if (u) el.href = u; });
    }
  }
  if (listenPaint) document.removeEventListener("rotation:streaming", listenPaint);
  listenPaint = paint;
  document.addEventListener("rotation:streaming", paint);
  // With no service chosen yet, tapping Listen asks first, then opens a search for that album or song in the service just picked
  page.addEventListener("click", (e) => {
    const link = e.target.closest(".listen-link");
    if (!link || getStream()) return;
    e.preventDefault();
    const track = link.dataset.track;
    chooseService((id) => window.open(RL.streamingSearchUrl(id, track ? RL.listenQuery(album.artist, album.title, track) : albumQuery, track ? "track" : "album"), "_blank", "noopener"));
  });
  paint();
}

// Privacy policy (plain language; kept in step with what the app actually stores)
function renderPrivacy() {
  setPageMeta("Privacy · Rotation", "What Rotation stores about you, who can see it, and how to download or delete it.");
  const sec = (id, h, body) => `<section class="section" aria-labelledby="${id}">${sectionHead(h).replace("<h2", `<h2 id="${id}"`)}<div class="prose">${body}</div></section>`;
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Privacy</h1><p class="t-lead">What Rotation keeps, who can see it, and how to take it back. Last updated October 8, 2026.</p></header>
    ${sec("pv-store", "What we store", `<p>If you make an account: your email address and a password (the password is hashed by our sign-in provider, Supabase, and we never see it). If you sign in with Google, we receive your email address and name from Google and nothing else.</p>
      <p>As you use Rotation: your scores, starred tracks, notes, saved albums, listening status (listened, want, favorite), lists, follows, and, if you make one, your profile (username, bio, pinned albums). Your streaming service choice is saved with your account, or on your device if you are signed out.</p>`)}
    ${sec("pv-see", "Who can see it", `<p>Your email address is never shown to anyone. Scores, notes, lists and your profile are private by default. Other people see them only if you make your profile public, share a review, or make a list public. Everyone sees the community average and the number of ratings, which count your score without saying whose it is.</p>`)}
    ${sec("pv-third", "Other services", `<p>Rotation runs on Supabase (accounts and database) and Vercel (hosting). Album details come from MusicBrainz, cover art from the Cover Art Archive and Apple, and charts from Billboard. Your browser contacts these to load pages and pictures, so they can see your IP address like any website you visit. Rotation does not run ads or analytics, and does not sell or share your data.</p>`)}
    ${sec("pv-device", "On your device", `<p>Rotation saves a few small settings in your browser: your sign-in session, light or dark theme, search filter, and streaming service. There are no tracking cookies.</p>`)}
    ${sec("pv-yours", "Your choices", `<p>You can download everything Rotation holds about you, or delete your account and all of it, from <a href="/me/edit">Edit profile</a> while signed in. Deleting is permanent. To report content or ask anything else, email <a href="mailto:loganrego08@gmail.com">loganrego08@gmail.com</a>.</p>
      <p>If this policy changes, the date at the top changes with it.</p>`)}`;
}
// Settings > Streaming service
function renderSettings() {
  setPageMeta("Settings · Rotation", "Choose which streaming service Listen buttons open on Rotation.");
  const cur = getStream() || "";
  const options = [["", "Ask me each time"], ...RL.STREAMING_SERVICES.map((s) => [s.id, s.label])];
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Settings</h1><p class="t-lead">Choose where Listen buttons open.</p></header>
    <section class="section" aria-labelledby="svc-h">
      ${sectionHead("Streaming service", { sub: user ? "Saved to your account." : "Saved on this device. Sign in to keep it on every device." }).replace("<h2", '<h2 id="svc-h"')}
      <fieldset class="svcset"><legend class="sr">Streaming service</legend>
        <div class="svcpick svcpick--radio">${options.map(([id, label]) => `<label class="svc"><input type="radio" name="svc" value="${id}"${id === cur ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div>
      </fieldset>
      <p class="field__hint" id="svcStatus" role="status" aria-live="polite"></p>
    </section>
    ${user ? `<section class="section">${sectionHead("Account")}<div class="chips">${button(profile ? "Edit profile" : "Create profile", { href: "/me/edit", iconName: "user" })}</div></section>` : ""}`;
  $$("input[name=svc]").forEach((r) => r.addEventListener("change", async () => {
    const id = r.value || null, status = $("#svcStatus");
    status.textContent = "Saving…";
    const ok = await setStream(id);
    status.textContent = ok ? (id ? `Listen opens ${streamLabel(id)}.` : "Listen will ask each time.") : "Saved on this device only.";
  }));
}
let signingUp = false, recovering = false;
function showAuthMessage(text, kind = "error") { const err = $("#authError"); err.className = `alert alert--${kind}`; err.textContent = text; err.hidden = false; }
/* ---------- Signing in: what you were doing is remembered ----------
   A write action (rate, star, list, follow) by someone signed out opens the sign-in dialog and stores what they were about to do: the page and the control
   (a CSS selector). Once they are signed in, by any method (even Google or Apple, which leave the site and come back), the page is reopened and that control
   is clicked for them. Stored for 30 minutes in localStorage, cleared when the dialog is dismissed. */
const INTENT_KEY = "rotation:intent", INTENT_TTL = 30 * 60 * 1000;
const clearIntent = () => { try { localStorage.removeItem(INTENT_KEY); } catch {} };
const saveIntent = (it) => { try { it ? localStorage.setItem(INTENT_KEY, JSON.stringify({ ...it, t: Date.now() })) : localStorage.removeItem(INTENT_KEY); } catch {} };
const readIntent = () => { try { return JSON.parse(localStorage.getItem(INTENT_KEY) || "null"); } catch { return null; } };
// For a write action: returns true when the person has to sign in first (and opens the dialog saying why)
function requireSignIn(selector, why) {
  if (!sb) { toast("Signing in is offline right now", "error"); return true; }
  if (user) return false;
  openAuth({ why, intent: { path: here(), selector: selector || null, why } });
  return true;
}
async function resumeIntent() {
  const it = readIntent();
  if (!it) return;
  clearIntent();
  if (!user || Date.now() - it.t > INTENT_TTL) return;
  if (it.path && it.path !== here()) go(it.path);   // Google and Apple return to the home page; go back to where they were
  if (!it.selector) return;
  for (let i = 0; i < 100; i++) {   // up to 10 seconds for the page to finish drawing
    const el = $(it.selector);
    if (el && el.getAttribute("aria-busy") !== "true" && !el.disabled) { toast(`Signed in. Picking up where you left off: ${it.why}.`); el.click(); return; }
    await sleep(100);
  }
}
function openAuth(opts) {
  const o = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  setAuthMode(!!o.signUp); $("#authError").hidden = true;
  const why = $("#authWhy");
  why.hidden = !o.why; why.textContent = o.why ? `Sign in to ${o.why}. We'll pick up where you left off.` : "";
  saveIntent(o.intent || null);
  $("#authDialog").showModal(); $("#authEmail").focus();
}
const anyProvider = cfg.AUTH_GOOGLE !== false || cfg.AUTH_APPLE === true;   // with no provider on, the "or with your email" divider has nothing above it
const authExtras = (show) => ["authProviders", "authOr", "authMagicRow", "authIntro"].forEach((id) => { $("#" + id).hidden = !show || (!anyProvider && (id === "authProviders" || id === "authOr")); });
function setAuthMode(up) {
  signingUp = up; recovering = false;
  $("#authTitle").textContent = up ? "Create your account" : "Sign in";
  $("#authSubmit").textContent = up ? "Create account" : "Sign in";
  $("#authToggle").textContent = up ? "I already have an account" : "Create an account instead";
  $("#authToggle").hidden = false; $("#authEmailField").hidden = false; $("#authEmail").required = true;
  $("#authForgot").hidden = up;
  authExtras(true);
  $("#authPass").autocomplete = up ? "new-password" : "current-password";
  $("#authServiceField").hidden = !up;
  if (up) $("#authService").value = getStream() || "";
}
// Arriving from a password-reset email: the person is signed in just long enough to choose a new password
function openRecovery() {
  setAuthMode(false); recovering = true;
  $("#authTitle").textContent = "Choose a new password";
  $("#authSubmit").textContent = "Save new password";
  $("#authToggle").hidden = true; $("#authForgot").hidden = true; $("#authEmailField").hidden = true; $("#authServiceField").hidden = true; $("#authEmail").required = false;
  $("#authPass").autocomplete = "new-password"; $("#authError").hidden = true; authExtras(false); $("#authWhy").hidden = true;
  if (!$("#authDialog").open) $("#authDialog").showModal();
  $("#authPass").focus();
}
$("#authToggle").onclick = () => setAuthMode(!signingUp);
$("#authClose").onclick = () => $("#authDialog").close();
// Dismissing the dialog without signing in forgets the pending action (a short delay lets a successful sign-in finish first)
$("#authDialog").addEventListener("close", () => setTimeout(() => { if (!user) clearIntent(); }, 800));

// Google and Apple: the browser leaves for the provider and comes back to the home page; the remembered intent then returns the person to where they were
async function signInWith(provider) {
  if (!sb) return showAuthMessage("Signing in is offline right now.");
  if (!readIntent()) saveIntent({ path: here(), selector: null });
  const btn = $(provider === "google" ? "#authGoogle" : "#authApple"); btn.setAttribute("aria-busy", "true");
  const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: location.origin + "/" } });
  btn.removeAttribute("aria-busy");
  if (error) showAuthMessage(RL.authReturnMessage({ code: error.code, description: error.message }) || error.message);
}
// Each provider button shows only when its flag in config.js is on (the provider must also be enabled in Supabase)
$("#authGoogle").hidden = cfg.AUTH_GOOGLE === false; $("#authApple").hidden = cfg.AUTH_APPLE !== true;
$("#authGoogle").onclick = () => signInWith("google");
$("#authApple").onclick = () => signInWith("apple");
// Email link: no password; works for new and existing accounts
$("#authMagic").onclick = async () => {
  const email = $("#authEmail").value.trim();
  if (!email || !$("#authEmail").checkValidity()) { showAuthMessage("Enter your email above, then choose Email me a sign-in link."); $("#authEmail").focus(); return; }
  if (!readIntent()) saveIntent({ path: here(), selector: null });
  const btn = $("#authMagic"); btn.setAttribute("aria-busy", "true");
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + "/", shouldCreateUser: true } });
  btn.removeAttribute("aria-busy");
  if (error) return showAuthMessage(/rate|limit|seconds/i.test(error.message) ? "Please wait a minute before asking for another link." : error.message);
  showAuthMessage(`Check your email. We sent a sign-in link to ${email}. It works once, so open it on this device if you can.`, "success");
};
$("#authForgot").onclick = async () => {
  const email = $("#authEmail").value.trim();
  if (!email) { showAuthMessage("Enter your email above, then choose Forgot password."); $("#authEmail").focus(); return; }
  const btn = $("#authForgot"); btn.setAttribute("aria-busy", "true");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" });
  btn.removeAttribute("aria-busy");
  // The same message whether or not an account exists, so this can't be used to discover who has one
  if (error && !/rate|limit|seconds/i.test(error.message)) return showAuthMessage(error.message);
  showAuthMessage(error ? "Please wait a minute before asking for another email." : "If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.", error ? "warning" : "success");
};
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#authSubmit");
  $("#authError").hidden = true; submit.setAttribute("aria-busy", "true");
  const email = $("#authEmail").value.trim(), password = $("#authPass").value;
  if (recovering) {
    const { error } = await sb.auth.updateUser({ password });
    submit.removeAttribute("aria-busy");
    if (error) return showAuthMessage(error.message);
    recovering = false; $("#authPass").value = ""; $("#authDialog").close(); toast("Password updated");
    return;
  }
  // A streaming service picked while signing up is saved with the account (and on this device, so it applies at first sign-in)
  const svc = signingUp ? validService($("#authService").value) : null;
  if (svc) { streamPref = svc; try { localStorage.setItem(STREAM_KEY, svc); } catch {} }
  const { data, error } = signingUp ? await sb.auth.signUp({ email, password, options: svc ? { data: { streaming_service: svc } } : undefined }) : await sb.auth.signInWithPassword({ email, password });
  submit.removeAttribute("aria-busy");
  if (error) return showAuthMessage(error.message);
  if (signingUp && !data.session) return showAuthMessage("Check your email to confirm your account, then sign in.", "warning");
  $("#authDialog").close();
  toast(signingUp ? "Account created" : "Signed in");
});

/* ==========================================================================
   Search: ranking pipeline, autocomplete combobox and the results page
   Candidates come from /api/search (MusicBrainz, cached at the edge), plus Rotation's own albums from Supabase (RPC search_albums).
   lib.js ranks them: text match, Rotation ratings, Billboard presence, release type, noise penalties.
   ========================================================================== */
let searchTimer, searchSeq = 0, suggestAbort = null, optSeq = 0;
const SEARCH_TYPES = [["album", "Albums"], ["ep", "EPs"], ["single", "Singles"], ["compilation", "Compilations"], ["live", "Live albums"], ["soundtrack", "Soundtracks"], ["any", "All types"]];
// The type filter is remembered between searches, but the URL always spells it out, so a shared link means the same thing to everyone
const SEARCH_TYPE_KEY = "rotation:searchType";
const storedType = () => { try { const t = localStorage.getItem(SEARCH_TYPE_KEY); return SEARCH_TYPES.some(([v]) => v === t) ? t : "album"; } catch { return "album"; } };
const rememberType = (t) => { try { localStorage.setItem(SEARCH_TYPE_KEY, t); } catch {} };
const hasFilters = (f = {}) => !!((f.type && f.type !== "album") || f.from || f.to || f.genre || f.artist);
const searchHref = (term, f = {}) => {
  const q = new URLSearchParams();
  if (f.type) q.set("type", f.type);
  ["from", "to", "genre", "artist"].forEach((k) => { if (f[k]) q.set(k, f[k]); });
  const qs = q.toString();
  return `/search${term ? "/" + encodeURIComponent(term) : qs ? "/" : ""}${qs ? "?" + qs : ""}`;
};
function parseSearchHash(h) {
  const [path, qs = ""] = h.replace(/^\/search\/?/, "").split("?");
  const q = new URLSearchParams(qs);
  const f = {};
  ["type", "from", "to", "genre", "artist"].forEach((k) => { if (q.get(k)) f[k] = q.get(k); });
  let term = ""; try { term = decodeURIComponent(path || ""); } catch {}
  return { term, f };
}

/* ---------- Pipeline ---------- */
const apiTerm = (t) => t.trim().toLowerCase().replace(/\s+/g, " ");   // one spelling per query so the edge cache is shared
let billboardMap = null;
function billboardSignal() {
  billboardMap = billboardMap || billboard("billboard-200").then((c) => new Map(c.items.map((x) => [RL.baseTitle(x.title) + "|" + RL.normText(x.artist), x.rank]))).catch(() => new Map());
  return billboardMap;
}
async function ratingSignals(ids) {
  const m = new Map();
  if (!sb || !ids.length) return m;
  try {
    const { data } = await sb.from("album_catalog").select("album_id, rating_count").in("album_id", ids.slice(0, 80)).gt("rating_count", 0);
    (data || []).forEach((r) => m.set(r.album_id, r.rating_count));
  } catch {}
  return m;
}
// Rotation's own albums that match (typo and accent tolerant). Missing RPC (migration v10 not applied) just means no extra hits.
async function rotationHits(term, f) {
  if (!sb || RL.normText(term).length < 2 || f.from || f.to || f.genre || f.artist) return [];
  try {
    const { data, error } = await sb.rpc("search_albums", { q: term, lim: 8 });
    if (error) return [];
    const want = !f.type || f.type === "any" ? null : f.type;
    return (data || []).map((r) => {
      const t = String(r.album_type || "");
      return { id: r.album_id, title: r.title, artist: r.artist, artistId: r.artist_id, date: r.release_date || "", cover_url: r.cover_url, rating_count: r.rating_count, inRotation: true,
        type: /single/i.test(t) ? "Single" : /\bep\b/i.test(t) ? "EP" : "Album", secondary: /compilation/i.test(t) ? ["Compilation"] : /live/i.test(t) ? ["Live"] : /soundtrack/i.test(t) ? ["Soundtrack"] : [] };
    }).filter((c) => !want || RL.kindOf(c) === want);
  } catch { return []; }
}
async function directCandidates(term, f, { limit, offset, prefix }) {
  const plan = RL.searchPlan(term, f, { prefix });
  const get = async (q, off) => ((await mbSlow(`${MB}/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=${limit}&offset=${off}`))["release-groups"] || []).map(RL.candidateOf);
  let groups = plan.strict ? await get(plan.strict, offset) : [];
  if (offset === 0 && !prefix && term && plan.fuzzy && plan.fuzzy !== plan.strict) {
    const ranked = RL.rankAlbums(term, groups);
    if (RL.needsFuzzy(ranked)) { const more = await get(plan.fuzzy, 0).catch(() => []), seen = new Set(groups.map((g) => g.id)); groups = groups.concat(more.filter((g) => !seen.has(g.id))); }
  }
  if (offset === 0 && !prefix && term && plan.tagged && RL.isWeakPool(groups, term)) {   // same sweep as api/search.js
    const seen = new Set(groups.map((g) => g.id));
    for (const off of [0, 100]) {
      const more = ((await mbSlow(`${MB}/release-group?query=${encodeURIComponent(plan.tagged)}&fmt=json&limit=100&offset=${off}`).catch(() => ({})))["release-groups"] || []).map(RL.candidateOf);
      groups = groups.concat(more.filter((g) => !seen.has(g.id) && seen.add(g.id)));
      if (more.length < 100) break;
    }
  }
  return groups;
}
async function candidatesFor(term, f, { limit = 50, offset = 0, prefix = false, signal } = {}) {
  const p = new URLSearchParams({ q: apiTerm(term), limit, offset });
  if (prefix) p.set("prefix", "1");
  ["type", "from", "to", "genre", "artist"].forEach((k) => { if (f[k]) p.set(k, f[k]); });
  try {
    const r = await fetch(`/api/search?${p}`, { signal });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.groups)) return j.groups; }
  } catch (e) { if (e.name === "AbortError") throw e; }
  // The function is unavailable (not deployed yet, or down): fall back to asking MusicBrainz directly, throttled
  return directCandidates(term, f, { limit, offset, prefix });
}
async function runSearch(term, f, { limit = 50, offset = 0, prefix = false, signal, onRotation } = {}) {
  const rotP = offset === 0 ? rotationHits(term, f) : Promise.resolve([]);
  if (onRotation) rotP.then(onRotation);
  const [groups, rot, bb] = await Promise.all([candidatesFor(term, f, { limit, offset, prefix, signal }), rotP, billboardSignal()]);
  const byId = new Map();
  groups.forEach((c) => byId.set(c.id, c));
  rot.forEach((c) => byId.set(c.id, { ...(byId.get(c.id) || {}), ...c }));
  const cands = [...byId.values()];
  const signals = { ratings: await ratingSignals(cands.map((c) => c.id)), billboard: bb, rotation: new Set(rot.map((r) => r.id)) };
  const opts = { typeChosen: !!f.type && f.type !== "any" };
  // a chosen type means that type: Rotation's own entries follow the same rule as the MusicBrainz query
  const want = f.type && f.type !== "any" ? f.type : null;
  const ranked = RL.rankAlbums(term, cands, signals, opts).filter((r) => !want || r.kind === want);
  return { ranked, signals, opts, rawCount: groups.length, card: offset === 0 ? RL.artistCard(term, ranked, signals, opts) : null, did: offset === 0 ? RL.didYouMean(term, ranked) : null };
}
const KIND_LABEL = { ep: "EP", single: "Single", live: "Live album", soundtrack: "Soundtrack", compilation: "Compilation", other: "Other" };
const candMeta = (c) => [KIND_LABEL[c.kind] || "", year(c.date), c.disambiguation].filter(Boolean).join(" · ") || null;
const candArt = (c) => c.cover_url || coverUrl(c.id, 250);

/* ---------- Search form and autocomplete (ARIA combobox) ---------- */
const searchForm = ({ mode, value = "", cls = "" }) => { const id = `smenu${++optSeq}`; return `<form class="search ${cls}" role="search" data-searchform>
  ${icon("search", "search__icon")}
  <input class="input input--search" type="search" data-search="${mode}" value="${esc(value)}" placeholder="Search albums and artists" autocomplete="off" aria-label="Search albums and artists"
    role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}">
  <div class="menu menu--search" id="${id}" role="listbox" aria-label="Suggestions" hidden></div></form>`; };
const searchInput = (e) => e.target.closest?.("[data-search]");
const menuOf = (input) => input.closest(".search")?.querySelector(".menu--search");
function setResults(input, open) {
  const m = menuOf(input);
  if (!m) return;
  m.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  if (!open) input.removeAttribute("aria-activedescendant");
}
function readSearchFilters() {
  const f = {};
  $$("#sfilters [data-f]").forEach((el) => { const v = el.value.trim(); if (v) f[el.dataset.f] = v; });
  if (f.from) f.from = f.from.replace(/\D/g, "").slice(0, 4);
  if (f.to) f.to = f.to.replace(/\D/g, "").slice(0, 4);
  return f;
}
function suggestHTML(term, res, f) {
  const best = res.ranked[0];
  const artists = best ? RL.rankArtists(term, res.ranked, res.signals, res.opts).filter((a) => a.text >= 0.85 && a.relevance >= best.relevance * RL.SEARCH_WEIGHTS.artistCardShare).slice(0, 2) : [];
  const albums = res.ranked.slice(0, Math.max(3, 8 - artists.length));
  let n = 0; const oid = () => `${"sopt"}-${++n}`;
  return `${artists.length ? `<div class="menu__group" role="group" aria-label="Artists">${artists.map((a) => `
      <a class="menu__item" role="option" id="${oid()}" aria-selected="false" href="/artist/${a.id}"><span class="avatar" aria-hidden="true">${esc(a.name.charAt(0).toUpperCase())}</span>
      <span class="menu__text"><strong>${esc(a.name)}</strong><span>Artist</span></span></a>`).join("")}</div>` : ""}
    ${albums.length ? `<div class="menu__group" role="group" aria-label="Albums">${albums.map((c) => `
      <a class="menu__item" role="option" id="${oid()}" aria-selected="false" href="/album/${c.id}">${artwork(candArt(c), c.title, "thumb")}
      <span class="menu__text"><strong>${esc(c.title)}</strong><span>${esc([c.artist, year(c.date), KIND_LABEL[c.kind]].filter(Boolean).join(" · "))}</span></span></a>`).join("")}</div>` : ""}
    <div class="menu__group"><a class="menu__item" role="option" id="${oid()}" aria-selected="false" href="${searchHref(term, f)}">${icon("search")}<span class="menu__text"><strong>See all results for “${esc(term)}”</strong></span></a></div>`;
}
async function suggest(input, term) {
  if (suggestAbort) suggestAbort.abort();
  const ctl = suggestAbort = new AbortController(), seq = ++searchSeq, results = menuOf(input);
  if (!results) return;
  const f = { type: storedType() }, current = () => seq === searchSeq && input.isConnected && results.isConnected;
  setResults(input, true);
  if (!results.children.length) results.innerHTML = `<p class="menu__note" role="status">Searching…</p>`;
  let painted = false;
  try {
    const res = await runSearch(term, f, { limit: 25, prefix: true, signal: ctl.signal,
      // Rotation's own albums arrive first from Supabase, so show them while MusicBrainz is still answering
      onRotation: (rot) => { if (!current() || painted || !rot.length) return; const r = RL.rankAlbums(term, rot, { rotation: new Set(rot.map((x) => x.id)) }, { typeChosen: true }); if (r.length) results.innerHTML = suggestHTML(term, { ranked: r, signals: {}, opts: {} }, f); } });
    if (!current()) return;
    painted = true;
    results.innerHTML = res.ranked.length ? suggestHTML(term, res, f)
      : `<p class="menu__note" role="status">Nothing for “${esc(term)}”. Check the spelling, or try the artist’s name.</p><div class="menu__group"><a class="menu__item" role="option" id="sopt-1" aria-selected="false" href="${searchHref(term, f)}">${icon("search")}<span class="menu__text"><strong>Search all types</strong></span></a></div>`;
  } catch (e) {
    if (e.name === "AbortError" || !current()) return;
    results.innerHTML = `<p class="menu__note" role="status">Search is unavailable right now. Try again in a moment.</p>`;
  }
}
function openSearchOverlay() {
  const old = $("#searchOverlay");
  if (old) return $("[data-search]", old).focus();
  const o = document.createElement("div");
  o.id = "searchOverlay"; o.className = "overlay";
  o.innerHTML = `<div class="overlay__box" role="dialog" aria-modal="true" aria-label="Search">${searchForm({ mode: "menu", cls: "search--hero" })}<p class="t-meta">Esc to close</p></div>`;
  document.body.appendChild(o);
  const close = () => { o.remove(); window.removeEventListener("rotation:route", close); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  o.addEventListener("mousedown", (e) => { if (e.target === o) close(); });
  o.addEventListener("click", (e) => { if (e.target.closest(".menu--search a")) close(); });
  window.addEventListener("rotation:route", close);
  document.addEventListener("keydown", onKey, true);
  $("[data-search]", o).focus();
}
document.addEventListener("input", (e) => {
  const filter = e.target.closest?.("#sfilters [data-f]");
  const input = searchInput(e);
  if (!input && !filter) return;
  clearTimeout(searchTimer);
  if (filter) {
    if (filter.dataset.f === "type") rememberType(filter.value);
    searchTimer = setTimeout(() => pageSearch($("[data-search]").value.trim(), readSearchFilters(), true), filter.tagName === "SELECT" ? 0 : 450);
    return;
  }
  const v = input.value.trim();
  if (RL.normText(v).length < 2) { if (suggestAbort) suggestAbort.abort(); return setResults(input, false); }
  searchTimer = setTimeout(() => suggest(input, v), 180);
});
document.addEventListener("keydown", (e) => {
  // "/" jumps to search from anywhere that isn't a text field
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    e.preventDefault();
    const box = $("[data-search]");
    return box ? box.focus() : openSearchOverlay();
  }
  // Arrow keys move through search result cards
  const card = e.target.closest?.("#sres .album-card, #sres .artist-card");
  if (card && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
    const all = $$("#sres .album-card, #sres .artist-card"), i = all.indexOf(card);
    const to = all[i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1)];
    if (to) { e.preventDefault(); to.focus(); }
    return;
  }
  const input = searchInput(e);
  if (!input) return;
  const menu = menuOf(input);
  if (e.key === "Escape" && menu && !menu.hidden) { setResults(input, false); return; }
  const items = $$(".menu__item", menu);
  const i = items.findIndex((x) => x.getAttribute("aria-selected") === "true");
  if (!items.length || menu.hidden) { if (e.key === "ArrowDown" && menu && RL.normText(input.value).length >= 2) suggest(input, input.value.trim()); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((x, k) => x.setAttribute("aria-selected", String(k === n)));
    input.setAttribute("aria-activedescendant", items[n].id);
    items[n].scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter" && i >= 0) { e.preventDefault(); items[i].click(); }   // no selection: the form submits to the full results page
});
document.addEventListener("submit", (e) => {
  const form = e.target.closest?.("[data-searchform]");
  if (!form) return;
  e.preventDefault();
  const input = $("[data-search]", form), v = input.value.trim();
  clearTimeout(searchTimer);
  if (suggestAbort) suggestAbort.abort();
  if (RL.normText(v).length < 2 && input.dataset.search !== "page") return input.focus();
  setResults(input, false);
  if (input.dataset.search === "page") {
    const f = readSearchFilters(), h = searchHref(v, f);
    return here() === h ? pageSearch(v, f) : go(h);   // a new term is a new history entry, so Back works
  }
  go(searchHref(v, { type: storedType() }));
});
document.addEventListener("click", (e) => {
  $$(".menu--search").forEach((m) => { if (!m.hidden && !m.closest(".search").contains(e.target)) setResults($("[data-search]", m.closest(".search")), false); });
  const link = e.target.closest(".menu--search a");
  if (link) { const input = $("[data-search]", link.closest(".search")); setResults(input, false); input.value = ""; }
});

// The same title by the same artist can appear more than once; keep the best-ranked one (used by Surprise me).
const rgKey = (g) => norm(g.title) + "|" + norm(artistName(g["artist-credit"]));
function dedupeGroups(list, seen = new Set()) {
  const out = [];
  for (const g of list) { const k = rgKey(g); if (!g.title || seen.has(k)) continue; seen.add(k); out.push(g); }
  return out;
}

/* ---------- Results page ---------- */
const PAGE = 50;
async function pageSearch(term, f = {}, replace = false) {
  const el = $("#sres");
  if (!el) return;
  const seq = ++searchSeq;
  if (replace) history.replaceState(null, "", searchHref(term, f));
  const summary = $("#sfilters")?.closest("details")?.querySelector("summary");
  if (summary) summary.textContent = hasFilters(f) ? "Filters (active)" : "Filters";
  const searchable = RL.normText(term).length >= 2;
  if (!searchable && !hasFilters(f)) {
    el.innerHTML = emptyState({ iconName: "search", title: "Search Rotation", body: term ? "Type at least two characters." : "Find any album or artist, then narrow it by type, year, genre or artist. Press / anywhere to start.", compact: true });
    return;
  }
  el.innerHTML = `${loadingLabel("Searching")}<div class="grid">${skCards(8)}</div>`;
  const q = searchable ? term : "";
  const retry = () => pageSearch(term, f);
  try {
    const res = await runSearch(q, f, { limit: PAGE });
    if (seq !== searchSeq || !el.isConnected) return;
    const keyOf = (r) => RL.normText(r.artist) + "|" + RL.baseTitle(r.title) + "|" + r.kind, seen = new Set(res.ranked.map(keyOf));
    let offset = PAGE, canMore = res.rawCount >= PAGE && offset < MB_WINDOW;
    if (!res.ranked.length && !canMore) {
      el.innerHTML = emptyState({ iconName: "search", title: term ? `Nothing for “${term}”` : "No albums match these filters",
        body: hasFilters(f) ? "Try loosening the year range, type or genre, or clear the filters." : "Check the spelling, or try the artist’s name.",
        actions: hasFilters(f) ? button("Clear filters", { id: "emptyClear" }) : (f.type && f.type !== "any" ? button("Search all types", { href: searchHref(term, { ...f, type: "any" }) }) : ""), compact: true });
      $("#emptyClear")?.addEventListener("click", () => { $("#clearFilters")?.click(); });
      return;
    }
    const { top, more } = RL.splitTop(res.ranked);
    const card = (c) => albumCard({ id: c.id, title: c.title, artist: c.artist, art: candArt(c) }, { meta: candMeta(c) });
    el.innerHTML = `
      ${res.did ? `<p class="did-you-mean" role="status">Did you mean <a class="textlink" href="${searchHref(res.did, f)}">${esc(res.did)}</a>?</p>` : ""}
      ${res.card ? `<section class="section" aria-label="Artist"><div class="grid grid--artists">${artistCard({ id: res.card.id, name: res.card.name, sub: "Artist" })}</div></section>` : ""}
      <section class="section">${sectionHead("Top results")}<div class="grid" id="sTop">${top.map(card).join("")}</div></section>
      <section class="section" id="sMoreSec"${more.length ? "" : " hidden"}>${sectionHead("More results")}<div class="grid" id="sMoreGrid">${more.map(card).join("")}</div></section>
      <div id="sMore" class="search__more"></div>`;
    let busy = false, io;
    const paint = () => {
      $("#sMore").innerHTML = canMore ? `<button type="button" class="btn" id="sLoadMore"><span>Load more results</span></button>` : (top.length + $$("#sMoreGrid > *").length > PAGE / 2 ? `<p class="t-meta">That's everything we found.</p>` : "");
      $("#sLoadMore")?.addEventListener("click", loadMore);
      if (io) io.disconnect();
      if (canMore && "IntersectionObserver" in window) { io = new IntersectionObserver((es) => { if (!el.isConnected) return io.disconnect(); if (es.some((x) => x.isIntersecting) && !busy) $("#sLoadMore")?.click(); }, { rootMargin: "600px" }); io.observe($("#sMore")); }
    };
    async function loadMore() {
      if (busy) return; busy = true;
      const btn = $("#sLoadMore"); btn?.setAttribute("aria-busy", "true");
      try {
        for (let tries = 0; tries < 3 && canMore; tries++) {
          const next = await runSearch(q, f, { limit: PAGE, offset });
          if (seq !== searchSeq || !el.isConnected) return;
          offset += PAGE; canMore = next.rawCount >= PAGE && offset < MB_WINDOW;
          const add = next.ranked.filter((r) => { const k = keyOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
          if (add.length) { $("#sMoreSec").hidden = false; $("#sMoreGrid").insertAdjacentHTML("beforeend", add.map(card).join("")); break; }
        }
      } catch { toast("Couldn't load more results. Try again.", "error"); }
      busy = false; paint();
    }
    paint();
  } catch {
    if (seq === searchSeq && el.isConnected) el.innerHTML = errorState({ title: "Search is unavailable", body: "MusicBrainz may be busy or slow. Try again in a moment.", retry });
  }
}

/* ==========================================================================
   Views
   ========================================================================== */
const view = () => $("#view");
// Supabase answers at most 1000 rows per request and does not say when it cut the list short. This walks a query page by page (build() must return a
// fresh, fully ordered query, ending in a unique column so pages never overlap or skip) until a short page says it is done.
async function fetchAll(build, size = 1000) {
  const rows = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if ((data || []).length < size) return { data: rows, error: null };
  }
}
async function myRatings(fields = "score, standout_tracks, thoughts, updated_at, created_at, album:albums(id,title,artist,cover_url,genres,release_date)") {
  if (!sb || !user) return [];
  const { data, error } = await fetchAll(() => sb.from("ratings").select(fields).order("score", { ascending: false }).order("updated_at", { ascending: false }).order("id"));
  if (error) throw error;
  return (data || []).filter((r) => r.album);
}

/* ---------- Missing covers ----------
   Chart albums that Apple couldn't match with confidence arrive without art (better empty than the wrong album's cover).
   Any card that links to a name lookup (/find/artist/title) and has no picture gets one here from MusicBrainz and the Cover Art Archive:
   the same source the album page uses. Looked up one at a time (MusicBrainz allows about one request a second), remembered for the session. */
async function resolveCover(artist, title) {
  const key = "cov2:" + norm(artist) + "|" + norm(title);
  try { const hit = sessionStorage.getItem(key); if (hit !== null) return hit || null; } catch {}
  let url = null;
  try {
    const clean = title.replace(/\s*[(\[](ep|single|deluxe[^)\]]*)[)\]]\s*$/i, ""), q = `${artist} ${clean}`, cands = await candidatesFor(q, { type: "any" }, { limit: 10 });
    // Same title (exact for cast recordings and soundtracks, whose "artist" differs between sources) and the same artist
    const best = RL.rankAlbums(q, cands, {}, {}).find((r) => { const ts = RL.textScore(clean, r.title); return ts >= 0.9 && (RL.textScore(artist, r.artist) >= 0.8 || (ts === 1 && /various|cast|soundtrack/i.test(`${artist} ${r.artist}`))); });
    if (best) url = coverUrl(best.id, 500);
    resolveCover.last = best ? `${best.title} | ${best.artist}` : null;   // for debugging in the console
  } catch { return null; }   // a failed lookup isn't remembered, so it can be retried
  try { sessionStorage.setItem(key, url || ""); } catch {}
  return url;
}
let healing = false;
async function healCovers() {
  if (healing) return;
  healing = true;
  try {
    const targets = $$('#view a[href^="/find/"] .art:not(:has(img)):not([data-healed])').slice(0, 12);
    for (const el of targets) {
      el.dataset.healed = "1";
      const [, artist, title] = decodeURIComponent((el.closest("a").getAttribute("href") || "").replace(/^\/find\//, "")).match(/^([^/]*)\/(.*)$/) || [];
      if (!artist || !title) continue;
      const url = await resolveCover(artist, title);
      if (url && el.isConnected) el.outerHTML = artwork(url, `${title} by ${artist}`, el.className.replace(/\bart\b/, "").replace(/\bis-healed\b/, "").trim());
    }
  } finally { healing = false; }
}
let healTimer;
new MutationObserver(() => { clearTimeout(healTimer); healTimer = setTimeout(healCovers, 700); }).observe($("#view"), { childList: true, subtree: true });
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

// Every home section says where its picks come from: calculated from community ratings, a Billboard chart, or an editor's choice
function homeSection(id, title, sub, { link, linkLabel } = {}) {
  return `<section class="section" id="${id}" aria-labelledby="${id}-h">
    ${sectionHead(title, { sub, link, linkLabel, id: `${id}-sub` }).replace("<h2", `<h2 id="${id}-h"`).replace("</h2>", `</h2><span class="badge" id="${id}-badge" hidden></span>`)}
    <div class="section__body">${loadingLabel(`Loading ${title}`)}<div class="row">${skCards(7)}</div></div></section>`;
}
// load() resolves to { sub?, cards: [html], empty?: { title, body, actions } } and may throw
function runSection(id, load, { defer = false, big = false } = {}) {
  const sec = $(`#${id}`);
  if (!sec) return;
  const run = async () => {
    const body = $(".section__body", sec);
    try {
      const r = await load();
      if (!sec.isConnected) return;
      if (r.sub != null) $(`#${id}-sub`).textContent = r.sub;
      const badge = $(`#${id}-badge`); if (badge && r.badge) { badge.textContent = r.badge; badge.hidden = false; }
      body.innerHTML = r.cards?.length ? (r.sheet ? sheetHTML(r) : `<div class="row${big ? " row--big" : ""}">${r.cards.join("")}</div>`)
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
    return { sub: "Most rated by the community in the past 7 days", badge: "Community activity",
      cards: act.map((s) => albumCard({ id: s.album_id, title: s.title, artist: s.artist, art: s.cover_url },
        { score: s.recent_avg, count: s.recent_count, meta: `${plural(s.recent_count, "rating")} this week` })) };
  }
  const c = await billboard("billboard-200");
  const movers = c.items.filter((x) => x.lastWeek != null && x.lastWeek - x.rank >= 1).sort((a, b) => (b.lastWeek - b.rank) - (a.lastWeek - a.rank)).slice(0, 14);
  const list = movers.length >= 4 ? movers : c.items.slice(0, 14);
  return { badge: "Billboard chart", sub: movers.length >= 4 ? "Climbing the Billboard 200 this week. Community activity takes over as more people rate."
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
    sub: "Debuted on Billboard's charts in the last four weeks", badge: "Billboard chart",
    cards: fresh.slice(0, 18).map((it) => albumCard(it, it.weeks <= 1 ? { meta: "Debuted this week", metaKind: "new" } : { meta: `Week ${it.weeks} on the charts` })),
    empty: { title: "No fresh debuts right now", body: "New albums land on the charts every Tuesday. Check back then.",
      actions: button("Browse the charts", { href: "/lists/charts" }) },
  };
}

async function loadHighest() {
  const top = (await communityStats()).filter((s) => s.rating_count >= MIN_RATINGS).slice(0, 24);
  if (top.length) return { sub: RANKING_NOTE, badge: "Community ranking", cards: top.map((s, i) => statCard(s, { rank: i + 1 })),
    sheet: { href: `/album/${top[0].album_id}`, art: top[0].cover_url, title: top[0].title, artist: top[0].artist } };
  const c = await billboard("billboard-200");
  return { badge: "Billboard chart", sub: `Albums need ${MIN_RATINGS}+ ratings to rank here. Until then, the most popular albums right now.`,
    cards: c.items.slice(0, 14).map((it) => albumCard(it, { rank: it.rank })),
    sheet: { noCover: true } };   // the chart's number one is already the lead feature above, so no second big cover
}

// Calculated, not curated: 3 to 20 ratings (enough to trust, few enough to be undiscovered) averaging 8 or higher
async function loadHiddenGems() {
  if (!sb) return { badge: "Community ranking", cards: [], empty: { title: "Community data is offline", body: "Try again in a little while." } };
  const { data, error } = await sb.from("album_catalog").select("*").gte("rating_count", MIN_RATINGS).lte("rating_count", 20).gte("avg_score", 8)
    .order("avg_score", { ascending: false }).order("rating_count", { ascending: false }).limit(24);
  if (error) throw error;
  return { badge: "Community ranking", sub: `Albums with ${MIN_RATINGS} to 20 ratings averaging 8 or higher. Few people have found them yet. Calculated from ratings, not picked by editors.`,
    cards: (data || []).map((r) => albumCard({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url }, { score: r.avg_score, count: r.rating_count, meta: plural(r.rating_count, "rating") })),
    empty: { iconName: "star", title: "No hidden gems yet", body: `A hidden gem needs ${MIN_RATINGS} to 20 ratings averaging 8 or higher. Rate albums you love and the best-kept secrets show up here.`,
      actions: button("Browse hidden gems", { href: browseHref({ min: "8", count: String(MIN_RATINGS), few: "1", sort: "rated" }) }) } };
}
// Albums where opinion splits into camps, shown only with enough ratings to mean something
async function loadDivisive() {
  if (!sb) return { badge: "Community ranking", cards: [], empty: { title: "Community data is offline", body: "Try again in a little while." } };
  const { data, error } = await sb.from("album_catalog").select("*").eq("is_divisive", true).order("sd", { ascending: false }).limit(18);
  if (error) throw error;
  return { badge: "Community ranking", sub: `Albums with ${DIVISIVE_MIN}+ ratings where opinions split into camps. Calculated from rating distributions.`,
    cards: (data || []).map((r) => albumCard({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url },
      { score: r.avg_score, count: r.rating_count, meta: `${Math.round(r.high_share * 100)}% scored 8+, ${Math.round(r.low_share * 100)}% scored 4 or lower` })),
    empty: { iconName: "star", title: "No divisive albums yet", body: `An album needs ${DIVISIVE_MIN}+ ratings with real camps on both sides before it counts, so a couple of votes never label anything divisive.`,
      actions: button("Browse all", { href: browseHref({ divisive: "1", sort: "divisive" }) }) } };
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
  return { badge: "Billboard genre charts", sub: "Charting with their own audiences, but missing from the Billboard 200. Chart-based, not community ratings.",
    cards: out.slice(0, 18).map((it) => albumCard(it)),
    empty: { title: "Nothing off the main chart this week", body: "Try browsing by genre instead.", actions: button("Explore genres", { href: "/explore" }) } };
}

async function loadRecent() {
  const rows = await optionalView("recent_ratings", (t) => t.select("*").order("rated_at", { ascending: false }).limit(40));
  const seen = new Set(), list = [];
  for (const r of rows) if (!seen.has(r.album_id)) { seen.add(r.album_id); list.push(r); }
  return {
    sub: "Latest scores from the community. Notes stay private.", badge: "Community",
    cards: list.slice(0, 18).map((r) => albumCard({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url },
      { score: r.score, scoreLabel: "A community rating", meta: `Rated ${ago(r.rated_at)}` })),
    empty: { iconName: "star", title: "No ratings yet", body: "When people start scoring albums, the latest ones show up here.",
      actions: button("Find an album to rate", { variant: "primary", href: "/search", iconName: "search" }) },
  };
}

// Hero crate: this week's top three covers, overlapping like records in a bin, with a mono caption of real numbers.
// The community line only appears once there are enough ratings for the number to mean something.
const HERO_STAT_MIN_RATINGS = 25;
async function loadHeroMosaic() {
  const el = $("#mosaic");
  if (!el) return;
  try {
    const c = await billboard("billboard-200");
    if (!el.isConnected) return;
    const top = c.items.filter((x) => x.art).slice(0, 3);
    if (top.length < 3) throw new Error("not enough art");
    el.innerHTML = top.map((it, i) => `<a class="hero__cover hero__cover--${i + 1}" href="${albumHref(it)}" title="${esc(it.title)}, ${esc(it.artist)}">${artwork(it.art, `${it.title} by ${it.artist}`)}</a>`).join("");
    const cap = $("#mosaicCap");
    if (cap) cap.innerHTML = `<span>Billboard 200 · week of ${esc(fmtDate(c.week, "short"))}</span>`;
    if (sb && cap) {
      const { data } = await sb.from("album_catalog").select("rating_count").gt("rating_count", 0).limit(1000);
      const ratings = (data || []).reduce((s, r) => s + r.rating_count, 0);
      if (cap.isConnected && ratings >= HERO_STAT_MIN_RATINGS) cap.insertAdjacentHTML("beforeend", `<span>${plural(data.length, "album")} rated · ${plural(ratings, "rating")}</span>`);
    }
  } catch { el?.closest(".hero")?.classList.add("hero--solo"); el?.closest(".hero__side")?.remove(); }
}

// Lead feature: the number one album on the Billboard 200 this week, large, with its real chart facts.
// If you're signed in and have rated it, your own score is shown in vermilion.
async function loadLead() {
  const el = $("#leadFeature");
  if (!el) return;
  try {
    const c = await billboard("billboard-200");
    const it = c.items.find((x) => x.rank === 1 && x.art) || c.items.find((x) => x.art);
    if (!it || !el.isConnected) throw new Error("no lead");
    let mine = null;
    if (user) { try { mine = (await myRatings("score, album:albums(id,title,artist)")).find((r) => keyOf(r.album) === keyOf(it))?.score ?? null; } catch {} }
    const href = albumHref(it);
    const facts = [it.move?.text, it.weeks != null ? `${plural(it.weeks, "week")} on the chart` : null, it.peak != null ? `Peak No. ${it.peak}` : null].filter(Boolean);
    el.innerHTML = `${sectionHead("Number one this week", { link: "/lists/charts", linkLabel: "Charts" }).replace("<h2", '<h2 id="lead-h"').replace("</h2>", '</h2><span class="badge">Billboard chart</span>')}
      <div class="lead__inner">
        <a class="sleeve lead__sleeve" href="${href}" aria-label="${esc(it.title)} by ${esc(it.artist)}"><div class="vinyl" aria-hidden="true">${vinylSvg("1")}</div><div class="album__art">${artwork(it.art, `${it.title} by ${it.artist}`)}</div></a>
        <div class="lead__text">
          <p class="eyebrow">Billboard 200 · week of ${esc(fmtDate(c.week, "short"))}</p>
          <h3 class="lead__title"><a href="${href}">${esc(it.title)}</a></h3>
          <p class="lead__artist">${esc(it.artist)}</p>
          ${facts.length ? `<p class="lead__facts">${facts.map((f, i) => `${i ? '<span class="dot" aria-hidden="true"></span>' : ""}<span>${esc(f)}</span>`).join("")}</p>` : ""}
          ${mine != null ? `<p class="lead__yours"><span class="t-label">Your score</span>${scoreChip(mine, { mine: true })}</p>` : ""}
          <div class="lead__actions">${button(mine != null ? "Open album" : "Rate this album", { variant: "primary", href, iconName: "star" })}${button("All charts", { href: "/lists/charts" })}</div>
        </div></div>`;
    el.hidden = false;
  } catch { el.remove(); }
}

// "Highest rated": the number one cover large beside a printed chart sheet of the top six
function sheetHTML(r) {
  const s = r.sheet;
  return `<div class="sheet${s?.noCover ? " sheet--solo" : ""}">${s && !s.noCover ? `<a class="sheet__cover" href="${s.href}" aria-label="${esc(s.title)} by ${esc(s.artist)}">${artwork(s.art, `${s.title} by ${s.artist}`)}<span class="sheet__cap t-meta">No. 1 · ${esc(s.title)}</span></a>` : ""}
    <div class="grid">${r.cards.slice(0, 6).join("")}</div></div>`;
}

// Genres and decades on the home page are typographic indexes, like a table of contents
const genreIndex = () => `<ol class="index index--genres">${GENRES.slice(0, 6).map((g, i) =>
  `<li><a href="/genre/${g.slug}"><span class="index__n t-meta">${String(i + 1).padStart(2, "0")}</span><span class="index__name">${esc(g.name)}</span><span class="index__cap t-meta" data-genre="${g.slug}"></span></a></li>`).join("")}</ol>`;
function fillGenreIndex(root) {
  GENRES.slice(0, 6).forEach((g) => genreChart(g).then((c) => {
    const top = c.items[0], cap = $(`[data-genre="${g.slug}"]`, root);
    if (top && cap) cap.textContent = `#1 ${top.title}, ${top.artist}`;
  }).catch(() => {}));
}
const decadeIndex = () => `<ol class="index index--decades">${DECADES.map((d) =>
  `<li><a href="/decade/${d.start}" aria-label="${d.start}s"><span class="index__big" aria-hidden="true">${String(d.start).slice(2)}s</span><span class="index__cap t-meta">${d.start}–${d.start + 9}</span></a></li>`).join("")}</ol>`;
const decadeGrid = () => `<div class="decades">${DECADES.map((d) =>
  `<a class="decade-card" href="/decade/${d.start}"><span class="decade-card__num">${d.start}s</span><span class="decade-card__sub">${d.start}–${d.start + 9}</span></a>`).join("")}</div>`;

async function renderHome() {
  document.title = "Rotation";
  ["m:stats", "m:album_activity", "m:recent_ratings"].forEach((k) => cache.delete(k));
  // Signed-out visitors get a landing hero (what this is, and two ways in) with live content right underneath; signed-in people go straight to their home.
  const out = !user;
  const topSec = homeSection("sec-top", "Highest rated", "", { link: "/lists/community", linkLabel: "Full list" });
  const recentSec = homeSection("sec-recent", "Recently reviewed", "", { link: "/search", linkLabel: "Find albums" });
  const heroTop = out ? `
    <section class="hero hero--landing" aria-labelledby="landing-h">
      <div class="hero__copy">
        <h1 class="t-hero" id="landing-h">Keep score on every album you hear.</h1>
        <p class="t-lead">Score albums out of 10, star standout tracks, keep lists, and see where everyone else lands.</p>
        <div class="landing__cta"><button type="button" class="btn btn--primary btn--lg" id="heroCreate">Create account</button><a class="btn btn--lg" href="/explore">Browse albums</a></div>
        ${searchForm({ mode: "menu", cls: "search--hero" })}
      </div>` : `
    <section class="hero">
      <div class="hero__copy">
        <h1 class="t-hero">What’s in your rotation?</h1>
        <p class="t-lead">Score albums out of 10. Star the tracks that hit. See where everyone else lands.</p>
        ${searchForm({ mode: "menu", cls: "search--hero" })}
        <nav class="chips" aria-label="Browse genres">${GENRES.slice(0, 5).map((g) => `<a class="chip" href="/genre/${g.slug}">${esc(g.name)}</a>`).join("")}<a class="chip" href="/explore">More</a><a class="chip" href="/surprise">Surprise me</a></nav>
      </div>`;
  view().innerHTML = `${heroTop}
      <div class="hero__side"><div class="hero__mosaic" id="mosaic" aria-label="Top albums on this week's Billboard 200"></div><p class="hero__caption t-meta" id="mosaicCap"></p></div>
    </section>
    <section class="section lead" id="leadFeature" hidden aria-labelledby="lead-h"></section>
    <section class="section" id="feedShelf" hidden>
      ${sectionHead("From people you follow", { sub: "Latest activity from public profiles you follow", link: "/feed", linkLabel: "See all" })}
      <div class="feed"></div>
    </section>
    <section class="section" id="recShelf" hidden>
      ${sectionHead("Recommended for you", { sub: "", id: "recWhy" })}
      <div class="row" id="recs">${skCards(6)}</div>
    </section>
    ${out ? topSec + recentSec : ""}
    ${homeSection("sec-trending", "Trending this week", "", { link: "/lists/charts", linkLabel: "Charts" })}
    ${homeSection("sec-new", "New releases", "", { link: "/lists/charts", linkLabel: "Charts" })}
    ${out ? "" : topSec}
    ${homeSection("sec-radar", "Hidden gems", "", { link: browseHref({ min: "8", count: String(MIN_RATINGS), few: "1", sort: "rated" }), linkLabel: "Browse all" })}
    ${homeSection("sec-divisive", "Divisive albums", "", { link: browseHref({ divisive: "1", sort: "divisive" }), linkLabel: "Browse all" })}
    <section class="section" id="sec-genres" aria-labelledby="sec-genres-h">
      ${sectionHead("Explore by genre", { sub: "Billboard's weekly album charts", link: "/explore", linkLabel: "Explore all" }).replace("<h2", '<h2 id="sec-genres-h"')}
      ${genreIndex()}
    </section>
    <section class="section" aria-labelledby="sec-decades-h">
      ${sectionHead("Explore by decade", { sub: "Editorial landmarks and community picks from every era", link: "/explore", linkLabel: "Explore all" }).replace("<h2", '<h2 id="sec-decades-h"').replace("</h2>", '</h2><span class="badge">Editorial picks</span>')}
      ${decadeIndex()}
    </section>
    ${homeSection("sec-gems", "Beyond the Billboard 200", "", { link: "/explore", linkLabel: "Explore" })}
    ${out ? "" : recentSec}`;
  loadHeroMosaic();
  loadLead();
  if (!out) { loadHomeFeed(); loadRecs(); }
  $("#heroCreate")?.addEventListener("click", () => openAuth({ signUp: true }));
  runSection("sec-trending", loadTrending);
  runSection("sec-new", loadNewReleases, { defer: true });
  runSection("sec-top", loadHighest, { defer: !out });
  runSection("sec-radar", loadHiddenGems, { defer: true, big: true });
  runSection("sec-divisive", loadDivisive, { defer: true });
  lazy($("#sec-genres"), () => fillGenreIndex($("#sec-genres")));
  runSection("sec-gems", loadGems, { defer: true });
  runSection("sec-recent", loadRecent, { defer: !out });
}

/* ---------- Explore: genres and decades ---------- */
function renderExplore() {
  document.title = "Explore · Rotation";
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Explore</h1><p class="t-lead">Browse by genre, or travel through the decades.</p>
      <div class="chips" style="margin-top:var(--s-2)">${button("Surprise me", { variant: "primary", size: "sm", href: "/surprise", iconName: "spark" })}${button("Browse with filters", { size: "sm", href: "/browse", iconName: "list" })}</div></header>
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
  // Set APPLE_ART: false in config.js to stop using Apple artwork entirely (see CLAUDE.md, "Sources and rights")
  if (cfg.APPLE_ART !== false) try {
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
      `<a class="chip" href="/decade/${x.start}" ${x === d ? 'aria-current="page"' : ""}>${x.start}s</a>`).join("")}</nav>
    <section class="section" id="dec-rated">${sectionHead("Rated on Rotation", { sub: `Calculated from community scores for albums released in the ${short}s`, id: "dec-rated-sub" }).replace("</h2>", '</h2><span class="badge">Community ranking</span>')}
      <div class="section__body"><div class="row">${skCards(6)}</div></div></section>
    <section class="section">${sectionHead("Landmark albums", { sub: "An editor's starting point for the decade. Hand-picked, not a ranking, and not based on Rotation ratings." }).replace("</h2>", '</h2><span class="badge">Editorial picks</span>')}
      <div class="grid" id="dec-land">${d.albums.map(([artist, title, yr]) => albumCard({ title, artist }, { meta: String(yr) })).join("")}</div></section>`;
  d.albums.forEach(([artist, title], i) => appleArt(artist, title).then((url) => {
    const slot = url && $$("#dec-land .album-card .art")[i];
    if (slot?.isConnected) slot.outerHTML = artwork(url, `${title} by ${artist}`);
  }));
  const body = $("#dec-rated .section__body");
  const emptyRated = () => emptyState({ iconName: "star", compact: true, title: `No ${start}s albums rated yet`,
    body: "Rate one from this decade and it shows up here for everyone.", actions: button("Search albums", { href: "/search", iconName: "search" }) });
  if (!sb) { body.innerHTML = emptyRated(); return; }
  const { data, error } = await sb.from("album_stats").select("*").gte("release_date", String(start)).lt("release_date", String(start + 10))
    .order("avg_score", { ascending: false }).order("rating_count", { ascending: false }).limit(24);
  if (!body.isConnected) return;
  body.innerHTML = error ? errorState({ title: "Couldn't load community scores", retry: () => renderDecade(start) })
    : data.length ? `<div class="row">${data.map((s) => statCard(s)).join("")}</div>` : emptyRated();
}

/* ---------- Lists ---------- */
async function renderLists(tab) {
  if (!["charts", "community", "browse", "yours", "mine"].includes(tab)) tab = "charts";
  document.title = "Lists · Rotation";
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Lists</h1><p class="t-lead">Ranked lists from the charts, the community and your own shelf. Make your own and share them.</p></header>
    ${tabs([["charts", "Charts"], ["community", "Top rated"], ["browse", "Public lists"], ["yours", "My lists"], ["mine", "Your ranking"]], tab, "Lists")}
    <div id="lbody">${loadingLabel("Loading list")}<div class="grid">${skCards(8)}</div></div>`;
  $$("[data-tab]").forEach((b) => b.onclick = () => { go(`/lists/${b.dataset.tab}`); });
  const el = $("#lbody");
  const fail = () => { if (el.isConnected) el.innerHTML = errorState({ title: "This list didn't load", retry: () => renderLists(tab), compact: false }); };
  if (tab === "charts") {
    try {
      const c = await billboard("billboard-200");
      if (!el.isConnected) return;
      el.innerHTML = `<section class="section">${sectionHead("Billboard 200", { sub: c.week ? `Week of ${fmtDate(c.week)}` : "" })}
        <div class="grid">${c.items.map((it) => albumCard(it, { rank: it.rank })).join("")}</div></section>
        <section class="section">${sectionHead("More charts", { sub: "One for every genre" })}
        <nav class="chips" aria-label="Genre charts">${GENRES.map((g) => `<a class="chip" href="/genre/${g.slug}">${esc(g.name)}</a>`).join("")}</nav></section>`;
    } catch { fail(); }
  } else if (tab === "community") {
    try {
      const top = (await communityStats()).filter((s) => s.rating_count >= MIN_RATINGS).slice(0, 50);
      if (!el.isConnected) return;
      el.innerHTML = top.length
        ? `<section class="section">${sectionHead("Top rated on Rotation", { sub: RANKING_NOTE })}
            <div class="grid">${top.map((s, i) => statCard(s, { rank: i + 1 })).join("")}</div></section>`
        : emptyState({ iconName: "star", title: "No album has enough ratings yet", body: `Albums need ${MIN_RATINGS} ratings to appear here. Score a few and help build the list.`,
            actions: button("Browse the charts", { variant: "primary", href: "/lists/charts" }) });
    } catch { fail(); }
  } else if (tab === "browse") {
    await renderBrowseLists(el);
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
            actions: button("Search albums", { variant: "primary", href: "/search", iconName: "search" }) });
    } catch { fail(); }
  }
}

/* ---------- Search ---------- */
function renderSearch(term, f = {}) {
  document.title = term ? `${term} · Search · Rotation` : "Search · Rotation";
  f = { ...f, type: f.type || storedType() };   // the URL wins; without one, the type you used last
  const genreList = [...new Set(GENRES.flatMap((g) => g.tags))];
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Search</h1><p class="t-lead">Find any album or artist, then give it a score.</p></header>
    ${searchForm({ mode: "page", value: term, cls: "search--hero" })}
    <details class="filters"${hasFilters(f) ? " open" : ""}><summary>${hasFilters(f) ? "Filters (active)" : "Filters"}</summary>
      <div class="filters__grid" id="sfilters">
        <label class="field"><span class="field__label">Type</span><select class="select" data-f="type">${SEARCH_TYPES.map(([v, l]) => `<option value="${v}"${(f.type || "album") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field"><span class="field__label">Released from</span><input class="input" data-f="from" inputmode="numeric" maxlength="4" placeholder="Year" value="${esc(f.from || "")}" autocomplete="off"></label>
        <label class="field"><span class="field__label">Released to</span><input class="input" data-f="to" inputmode="numeric" maxlength="4" placeholder="Year" value="${esc(f.to || "")}" autocomplete="off"></label>
        <label class="field"><span class="field__label">Genre</span><input class="input" data-f="genre" list="genreOptions" placeholder="e.g. jazz" value="${esc(f.genre || "")}" autocomplete="off"></label>
        <label class="field"><span class="field__label">Artist</span><input class="input" data-f="artist" placeholder="Artist name" value="${esc(f.artist || "")}" autocomplete="off"></label>
        <button type="button" class="btn btn--ghost btn--sm" id="clearFilters">Clear filters</button>
      </div><datalist id="genreOptions">${genreList.map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist></details>
    <div id="sres" style="margin-top:var(--s-8)"></div>`;
  $("#clearFilters").onclick = () => { $$("#sfilters [data-f]").forEach((el) => { el.value = el.tagName === "SELECT" ? "album" : ""; }); rememberType("album"); pageSearch($("[data-search]").value.trim(), {}, true); };
  pageSearch(term, f);
  if (!term && !hasFilters(f)) $("[data-search]").focus();
}

/* ---------- Recommendations ----------
   Explainable rules, no machine learning. Each pick says which rule produced it, and nothing you've
   already rated is ever suggested. Sources, interleaved so no single rule dominates:
     1. listeners whose rating pattern is similar to yours scored it 8+ (needs 2+ similar listeners)
     2. more albums by artists you rate highly, from Rotation's community catalog
     3. the best-known albums by those artists, from MusicBrainz (the biggest source for a small catalog)
     4. well-rated albums in genres you rate highly
     5. this week's Billboard albums in those genres
   Thin results are topped up to a full row with clearly labeled, NOT personalized picks (the community's favorites, then the Billboard 200).
   Taste thresholds are strict (2+ albums per genre, artists averaging 8+) and relax to 1 album and 7+ only when the strict ones find nothing.
   With fewer than 3 ratings we don't pretend to know your taste: you get general discovery, labeled as such. */
const REC_MIN_RATINGS = 3, REC_ROW = 24, REC_FULL = 12;   // row size; below REC_FULL picks the row is topped up
const REC_RULE_TEXT = { listeners: "listeners with similar taste", artist: "artists you rate highly", discog: "artists you rate highly", genre: "genres you rate highly", chart: "this week's charts" };
async function buildRecs(rows) {
  const rated = rows.map((r) => ({ id: r.album.id, title: r.album.title, artist: r.album.artist }));
  const flat = rows.map((r) => ({ album_id: r.album.id, title: r.album.title, artist: r.album.artist, genres: r.album.genres || [], score: r.score }));
  let taste = RL.tasteProfile(flat);
  if (!taste.genres.length || !taste.artists.length) {
    const loose = RL.tasteProfile(flat, { genreMin: 1, artistAvg: 7 });
    taste = { genres: taste.genres.length ? taste.genres : loose.genres, artists: taste.artists.length ? taste.artists : loose.artists };
  }
  const topGenres = taste.genres.slice(0, 3), topArtists = taste.artists.slice(0, 4);
  const cat = (r, why) => ({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url, why });
  const [sim, byArtist, byGenre, charts, community, bb] = await Promise.all([
    sb.rpc("recs_from_similar_listeners", { p_limit: 12 }).then((r) => r.data || []).catch(() => []),
    topArtists.length ? sb.from("album_catalog").select("album_id, title, artist, cover_url, avg_score, rating_count").in("artist", topArtists.map((a) => a.name)).limit(40).then((r) => r.data || []).catch(() => []) : [],
    topGenres.length ? sb.from("album_catalog").select("album_id, title, artist, cover_url, genres, avg_score, rating_count, weighted_score").overlaps("genres", topGenres.map((g) => g.name)).gte("rating_count", 1)
      .order("weighted_score", { ascending: false }).limit(40).then((r) => r.data || []).catch(() => []) : [],
    Promise.all(topGenres.map((tg) => { const g = matchGenre(tg.name); return g ? genreChart(g).then((c) => c.items.map((x) => ({ ...x, genreName: g.name }))).catch(() => []) : []; })).then((x) => x.flat()),
    communityStats().then((s) => s.filter((x) => x.rating_count >= MIN_RATINGS)).catch(() => []),
    billboard("billboard-200").then((c) => c.items).catch(() => []),
  ]);
  const lists = {
    listeners: sim.map((r) => cat(r, `${r.similar_listeners} listeners with taste like yours scored it 8+`)),
    artist: byArtist.map((r) => { const a = taste.artists.find((x) => x.name === r.artist); return cat(r, `You rate ${r.artist} ${a?.avg ?? "highly"} on average`); }),
    discog: [],   // filled by recsFromDiscographies once MusicBrainz answers
    genre: byGenre.map((r) => { const g = topGenres.find((x) => (r.genres || []).includes(x.name)); return cat(r, `You rate ${g?.name || "this genre"} highly (${plural(g?.n || 0, "album")}); the community averages ${r.avg_score}`); }),
    chart: charts.filter((x) => keep(x) && !/\b(EP|Single)\b/i.test(x.title)).map((x) => ({ title: x.title, artist: x.artist, art: x.art, why: `#${x.rank} in ${x.genreName} this week, a genre you rate highly` })),
    // Not personalized, labeled as such, and only used to top up a thin row
    community: community.map((s) => cat(s, `Community favorite: ${s.avg_score} from ${plural(s.rating_count, "rating")}`)),
    popular: bb.filter((x) => keep(x) && !/\b(EP|Single)\b/i.test(x.title)).map((x) => ({ title: x.title, artist: x.artist, art: x.art, why: `#${x.rank} on the Billboard 200 right now` })),
  };
  return { lists, rated, artists: topArtists };
}
// Round-robin across the personalized rules, drop anything already rated or duplicated, then top up a thin row with the labeled fillers
function mergeRecLists({ lists, rated }) {
  const order = ["listeners", "artist", "discog", "genre", "chart"], groups = [];
  for (let i = 0; i < 24; i++) order.forEach((rule) => { if (lists[rule][i]) groups.push({ rule, items: [lists[rule][i]] }); });
  let items = RL.mergeRecs(groups, rated, REC_ROW);
  const personalized = items.length;
  if (items.length < REC_FULL) items = RL.mergeRecs([...items.map((it) => ({ rule: it.rule, items: [it] })), ...["community", "popular"].map((rule) => ({ rule, items: lists[rule] }))], rated, REC_FULL);
  return { items, personalized, rules: [...new Set(items.map((i) => i.rule))] };
}
// The best-known albums by the artists you rate highly: MusicBrainz, ranked by how widely each was released and tagged (same signals as search)
async function recsFromDiscographies(artists) {
  const perArtist = [];
  for (const a of artists) {
    try {
      const cands = (await candidatesFor("", { type: "album", artist: a.name }, { limit: 50 })).filter((c) => RL.sameArtistName(c.artist, a.name));
      perArtist.push(RL.rankAlbums("", cands, {}, { typeChosen: true }).filter((r) => r.kind === "album" && !r.noisy).slice(0, 6)
        .map((r) => ({ id: r.id, title: r.title, artist: r.artist, art: coverUrl(r.id, 250), why: `You rate ${a.name} ${a.avg} on average` })));
    } catch {}
  }
  // Interleave the artists, so the row mixes them instead of listing one artist's whole catalog first
  const out = [];
  for (let i = 0; i < 6; i++) perArtist.forEach((list) => { if (list[i]) out.push(list[i]); });
  return out;
}
const recsNote = (m) => {
  if (!m.items.length) return "";
  if (!m.personalized) return "Nothing matched your taste yet, so these are popular right now (labeled on each). Picks get more personal as you rate more albums.";
  const from = [...new Set(m.rules.filter((r) => REC_RULE_TEXT[r]).map((r) => REC_RULE_TEXT[r]))].join(", ");
  const extra = m.items.length - m.personalized;
  return `Picked from ${from}.${extra ? ` ${plural(extra, "more pick")} ${extra === 1 ? "is" : "are"} popular right now rather than matched to you (labeled on each).` : ""} Albums you've rated are never shown.`;
};// One flow for the home page and the stats page: calls onUpdate with the quick row first, then again with discographies added (or once, from cache)
async function getRecs(ratings, sig, onUpdate) {
  let cached; try { cached = JSON.parse(sessionStorage.getItem("recs7:" + sig) || "null"); } catch {}
  if (cached) { onUpdate(cached); return cached; }
  let built;
  try { built = await buildRecs(ratings); } catch { const none = { items: [], personalized: 0, rules: [] }; onUpdate(none); return none; }
  onUpdate(mergeRecLists(built));
  built.lists.discog = await recsFromDiscographies(built.artists);
  const final = mergeRecLists(built);
  try { sessionStorage.setItem("recs7:" + sig, JSON.stringify(final)); } catch {}
  onUpdate(final);
  return final;
}
async function loadRecs() {
  if (!sb || !user) return;
  const shelf = $("#recShelf");
  if (!shelf) return;
  shelf.hidden = false;
  const el = $("#recs");
  let ratings = [];
  try { ratings = await myRatings("score, updated_at, album:albums(id,title,artist,genres)"); } catch {}
  if (ratings.length < REC_MIN_RATINGS) {
    // New account: general discovery, honestly labeled
    const need = REC_MIN_RATINGS - ratings.length;
    $("#recWhy").textContent = `Popular right now, not personalized yet. Rate ${plural(need, "more album")} and these start to reflect your taste.`;
    try { const c = await billboard("billboard-200"); if (el.isConnected) el.innerHTML = c.items.slice(0, 12).map((it) => albumCard({ ...it, move: null, why: `#${it.rank} on the Billboard 200` })).join(""); }
    catch { if (el.isConnected) el.outerHTML = `<div id="recs">${emptyState({ iconName: "star", compact: true, title: "Rate a few albums to get picks", body: "We match this week's charts and the community to what you score highly.", actions: button("Search albums", { variant: "primary", href: "/search", iconName: "search" }) })}</div>`; }
    return;
  }
  $("#recWhy").textContent = "Matching genres, artists and similar listeners to what you rate highly…";
  const sig = user.id + ":" + ratings.map((r) => r.album.id + r.score).join(",");
  const paint = (m) => {
    if (!el.isConnected) return;
    $("#recWhy").textContent = recsNote(m);
    el.innerHTML = m.items.length ? m.items.map((it) => albumCard(it)).join("")
      : emptyState({ title: "No new picks right now", body: "You've rated everything we'd suggest from your genres and artists. Try Surprise me or browse hidden gems.", compact: true,
          actions: button("Surprise me", { variant: "primary", href: "/surprise", iconName: "spark" }) });
  };
  await getRecs(ratings, sig, paint);
}
/* ---------- Genre chart ---------- */
async function renderGenre(slug) {
  const g = GENRES.find((x) => x.slug === slug);
  if (!g) return renderNotFound();
  document.title = `${g.name} · Rotation`;
  view().innerHTML = `
    <header class="page-head"><p class="t-meta" id="gsub">Billboard chart</p><h1 class="t-title">${esc(g.name)}</h1></header>
    <nav class="chips" aria-label="Other genres" style="margin-bottom:var(--s-8)">${GENRES.map((x) =>
      `<a class="chip" href="/genre/${x.slug}" ${x === g ? 'aria-current="page"' : ""}>${esc(x.name)}</a>`).join("")}</nav>
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

/* ---------- Your library (private shelf) ---------- */
// Each view is a filter over your own rows plus a sensible default sort. The sort menu can override it.
const LIB_VIEWS = {
  all: { label: "All rated", sort: "rating-desc", src: "rated" },
  recent: { label: "Recently rated", sort: "date-desc", src: "rated" },
  top: { label: "Highest rated", sort: "rating-desc", src: "rated" },
  low: { label: "Lowest rated", sort: "rating-asc", src: "rated" },
  favorite: { label: "Favorites", sort: "date-desc", src: "status", pick: (r) => r.favorite, empty: ["Nothing favorited yet", "Tap Favorite on any album page to keep your all-time picks here."] },
  want: { label: "Want to listen", sort: "date-desc", src: "status", pick: (r) => r.want, noRating: true, empty: ["Nothing queued yet", "Tap Want to listen on any album page to line up your next listens."] },
  listened: { label: "Listened", sort: "date-desc", src: "status", pick: (r) => r.listened, empty: ["No listens logged yet", "Mark albums as Listened, or rate them, and they show up here."] },
  notes: { label: "With notes", sort: "date-desc", src: "rated", pick: (r) => !!r.thoughts, empty: ["No notes yet", "Add a review when you score an album and it will appear here."] },
};
const byText = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
// Albums with no value for the sort key (no score, no release date) always go last
const missingLast = (get, dir) => (a, b) => { const x = get(a), y = get(b); return x == null ? (y == null ? 0 : 1) : y == null ? -1 : dir * (x - y); };
const LIB_SORTS = {
  "date-desc": { label: (v) => `${v.src === "rated" ? "Date rated" : "Date added"} (newest)`, fn: (a, b) => String(b.date).localeCompare(String(a.date)) },
  "date-asc": { label: (v) => `${v.src === "rated" ? "Date rated" : "Date added"} (oldest)`, fn: (a, b) => String(a.date).localeCompare(String(b.date)) },
  "rating-desc": { label: () => "Rating (high to low)", fn: (a, b) => missingLast((r) => r.score, -1)(a, b) || String(b.date).localeCompare(String(a.date)), rating: true },
  "rating-asc": { label: () => "Rating (low to high)", fn: (a, b) => missingLast((r) => r.score, 1)(a, b) || String(b.date).localeCompare(String(a.date)), rating: true },
  artist: { label: () => "Artist (A to Z)", fn: (a, b) => byText(a.album.artist, b.album.artist) || byText(a.album.title, b.album.title) },
  title: { label: () => "Album title (A to Z)", fn: (a, b) => byText(a.album.title, b.album.title) },
  "year-desc": { label: () => "Release year (newest)", fn: (a, b) => missingLast((r) => +year(r.album.release_date) || null, -1)(a, b), year: true },
  "year-asc": { label: () => "Release year (oldest)", fn: (a, b) => missingLast((r) => +year(r.album.release_date) || null, 1)(a, b), year: true },
};
let profileTab = "all", profileView = "list", profileSort = null, profileQuery = "";
async function renderProfile() {
  document.title = "Your library · Rotation";
  if (!sb || !user) {
    view().innerHTML = emptyState({ iconName: "user", title: "Your library lives here",
      body: "Sign in to keep a library of everything you've scored, favorited or want to hear, with your notes and standout tracks.",
      actions: button("Sign in", { variant: "primary", id: "profSignIn" }) });
    $("#profSignIn")?.addEventListener("click", openAuth);
    return;
  }
  view().innerHTML = `${profileHeader({ initial: displayName().charAt(0).toUpperCase(), name: displayName(), eyebrow: " " })}${skList(6)}`;
  let rows;
  try { rows = await myRatings(); } catch { view().innerHTML = errorState({ title: "Couldn't load your library", retry: renderProfile, compact: false }); return; }
  let statuses = [];
  try {
    const { data } = await sb.from("album_status").select("listened, want, favorite, updated_at, album:albums(id,title,artist,cover_url,genres,release_date)").order("updated_at", { ascending: false });
    statuses = (data || []).filter((r) => r.album);
  } catch {}

  const avg = rows.length ? (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1) : "–";
  const standouts = rows.reduce((s, r) => s + (r.standout_tracks?.length || 0), 0);
  const gCount = new Map();
  rows.forEach((r) => (r.album.genres || []).slice(0, 2).forEach((n) => { const g = matchGenre(n); if (g) gCount.set(g.name, (gCount.get(g.name) || 0) + 1); }));
  const topGenre = [...gCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "–";
  const since = user.created_at ? `Member since ${fmtDate(user.created_at.slice(0, 7))}` : "";

  // One row shape for every view
  const ratingBy = new Map(rows.map((r) => [r.album.id, r]));
  const ratedRows = rows.map((r) => ({ album: r.album, score: r.score, thoughts: r.thoughts, date: r.updated_at }));
  const statusRows = statuses.map((s) => ({ album: s.album, score: ratingBy.get(s.album.id)?.score ?? null, thoughts: ratingBy.get(s.album.id)?.thoughts ?? null,
    date: s.updated_at, listened: s.listened, want: s.want, favorite: s.favorite }));
  const count = (k) => { const v = LIB_VIEWS[k]; return (v.src === "rated" ? ratedRows : statusRows).filter(v.pick || (() => true)).length; };

  const current = () => {
    const v = LIB_VIEWS[profileTab] || LIB_VIEWS.all;
    const sortKey = profileSort && LIB_SORTS[profileSort] && !(v.noRating && LIB_SORTS[profileSort].rating) ? profileSort : v.sort;
    const q = profileQuery.trim().toLowerCase();
    let list = (v.src === "rated" ? ratedRows : statusRows).filter(v.pick || (() => true))
      .filter((r) => !q || `${r.album.title} ${r.album.artist}`.toLowerCase().includes(q));
    list = [...list].sort(LIB_SORTS[sortKey].fn);
    return { v, sortKey, list, total: (v.src === "rated" ? ratedRows : statusRows).filter(v.pick || (() => true)).length, q };
  };
  const bodyHTML = () => {
    const { v, sortKey, list, total, q } = current();
    if (!list.length) {
      if (q && total) return emptyState({ iconName: "search", compact: true, title: `Nothing for “${profileQuery.trim()}”`, body: "Try a different title or artist, or clear the filter." });
      if (v.empty) return emptyState({ iconName: profileTab === "favorite" ? "heart" : profileTab === "want" ? "bookmark" : "note", compact: true, title: v.empty[0], body: v.empty[1],
        actions: button("Browse the charts", { variant: "primary", href: "/lists/charts" }) });
      return emptyState({ iconName: "disc", title: "Your library is empty", body: "Score your first album and your rankings, notes and standout tracks will collect here.",
        actions: button("Browse the charts", { variant: "primary", href: "/" }) + button("Search albums", { href: "/search", iconName: "search" }) });
    }
    const ranked = LIB_SORTS[sortKey].rating;
    const noYear = LIB_SORTS[sortKey].year ? list.filter((r) => !year(r.album.release_date)).length : 0;
    const cards = profileView === "list"
      ? `<div class="list">${list.map((r, i) => listCard({ album: r.album, score: r.score, thoughts: r.thoughts }, ranked && r.score != null ? i + 1 : "")).join("")}</div>`
      : `<div class="grid">${list.map((r) => albumCard({ id: r.album.id, title: r.album.title, artist: r.album.artist, art: r.album.cover_url },
          { score: r.score, mine: true, meta: [year(r.album.release_date), r.thoughts ? "Has notes" : ""].filter(Boolean).join(" · ") || null })).join("")}</div>`;
    return `${cards}${noYear ? `<p class="t-meta" style="margin-top:var(--s-4)">${plural(noYear, "album")} with no release year listed, shown last.</p>` : ""}`;
  };
  const countText = () => { const { list, total, q } = current(); return q ? `${list.length} of ${total}` : plural(total, "album"); };
  const sortOptions = () => { const { v, sortKey } = current();
    return Object.entries(LIB_SORTS).filter(([, s]) => !(v.noRating && s.rating)).map(([k, s]) => `<option value="${k}"${k === sortKey ? " selected" : ""}>${esc(s.label(v))}</option>`).join(""); };

  const drawBody = () => { $("#libBody").innerHTML = bodyHTML(); $("#libCount").textContent = countText(); };
  const draw = () => {
    view().innerHTML = `
      ${profileHeader({ initial: displayName().charAt(0).toUpperCase(), avatar: profile ? avatarHTML(profile, "lg") : undefined, name: displayName(), eyebrow: since, stats: [
        { label: "Albums rated", value: rows.length }, { label: "Average score", value: avg },
        { label: "Standout tracks", value: standouts }, { label: "Top genre", value: topGenre }],
        extra: `<div class="chips" style="margin-top:var(--s-4)">${profile
          ? `${button("View public profile", { size: "sm", href: profileHref(profile.username), iconName: "user" })}${button("Year in Rotation", { size: "sm", href: `/year/${thisYear()}`, iconName: "star" })}${button("Stats", { size: "sm", href: "/stats", iconName: "star" })}${button("Edit profile", { size: "sm", href: "/me/edit", iconName: "note" })}<span class="t-meta" style="align-self:center">${profile.is_public ? "Public" : "Private until you make it public"}</span>`
          : `${button("Create your profile", { variant: "primary", size: "sm", href: "/me/edit", iconName: "user" })}${button("Year in Rotation", { size: "sm", href: `/year/${thisYear()}`, iconName: "star" })}${button("Stats", { size: "sm", href: "/stats", iconName: "star" })}<span class="t-meta" style="align-self:center">Pin favorites, share lists and let people follow you.</span>`}</div>` })}
      ${tabs(Object.entries(LIB_VIEWS).map(([k, v]) => [k, `${v.label} (${count(k)})`]), profileTab, "Library views")}
      <div class="toolbar toolbar--lib">
        <label class="search search--lib"><span class="sr">Filter by title or artist</span>${icon("search", "search__icon")}
          <input id="libQuery" class="input input--search" type="search" placeholder="Filter by title or artist" value="${esc(profileQuery)}" autocomplete="off"></label>
        <label class="field field--inline"><span class="sr">Sort by</span><select id="libSort" class="select" aria-label="Sort by">${sortOptions()}</select></label>
        <div class="segmented" role="group" aria-label="Layout">
          <button type="button" data-view="list" aria-pressed="${profileView === "list"}" aria-label="List view">${icon("list")}</button>
          <button type="button" data-view="grid" aria-pressed="${profileView === "grid"}" aria-label="Grid view">${icon("grid")}</button>
        </div>
      </div>
      <p class="t-meta" id="libCount" role="status" aria-live="polite" style="margin-bottom:var(--s-4)">${countText()}</p>
      <div id="libBody">${bodyHTML()}</div>`;
    $$("[data-tab]").forEach((b) => b.onclick = () => { profileTab = b.dataset.tab; profileSort = null; draw(); });
    $$("[data-view]").forEach((b) => b.onclick = () => { profileView = b.dataset.view; draw(); });
    $("#libSort").onchange = (e) => { profileSort = e.target.value; drawBody(); };
    $("#libQuery").oninput = (e) => { profileQuery = e.target.value; drawBody(); };
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
  setPageMeta(document.title, `${a.name}${a.type ? `, ${a.type.toLowerCase()}` : ""}${a.area?.name ? ` from ${a.area.name}` : ""}. Albums and ratings on Rotation.`);
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
        return m ? `<a class="chip" href="/genre/${m.slug}">${esc(g.name)}</a>` : `<span class="chip chip--static">${esc(g.name)}</span>`;
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
    if (j.artists?.[0]) return location.replace(`/artist/${j.artists[0].id}`);
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
    if (rg) return location.replace(`/album/${rg.id}`);
  } catch {}
  view().innerHTML = emptyState({ iconName: "search", title: "Couldn't open this album yet", body: `We couldn't match “${title}” by ${artist} to an album page. Try searching for it.`,
    actions: button("Search", { href: searchHref(`${title} ${artist}`), iconName: "search" }) });
}

/* ---------- Album page ---------- */
// The viewer's own score as a record-label stamp: a thin double ring, a big Fraunces numeral and a small mono "/10" beneath. Vermilion because it's yours.
function recordSvg(score) {
  return `<svg class="record" viewBox="0 0 136 136" role="img" aria-label="${score ? `Your score: ${score} out of 10` : "Not rated yet"}">
    <circle class="stamp__ring" cx="68" cy="68" r="65"/><circle class="stamp__ring stamp__ring--in" cx="68" cy="68" r="58"/>
    <text class="stamp__num${score ? "" : " stamp__num--none"}" x="68" y="70" text-anchor="middle" dominant-baseline="central">${score || "–"}</text>
    <text class="stamp__of" x="68" y="100" text-anchor="middle">/10</text></svg>`;
}
// counts[i] is how many people gave the album a score of i + 1
function distribution(counts, mineScore) {
  const max = Math.max(...counts, 1);
  const label = counts.map((n, i) => `${i + 1}: ${n}`).join(", ");
  return `<div class="dist" role="img" aria-label="Rating distribution, score then count. ${label}">${counts.map((n, i) => `
    <div class="dist__col${mineScore === i + 1 ? " is-mine" : ""}"${RL.toneAttr(i + 1)} title="${plural(n, "rating")} of ${i + 1}">
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
function confidenceNote(n) {
  if (n < MIN_RATINGS) return `Only ${plural(n, "rating")} so far. Not enough to rank.`;
  if (n < 10) return "Early read. The average can move a lot as more people rate.";
  return "";
}

// A decorative record that slides out from behind the sleeve. Its label repeats the community average (shown in text elsewhere).
function vinylSvg(label) {
  const rings = Array.from({ length: 11 }, (_, i) => `<circle cx="100" cy="100" r="${92 - i * 4.6}" class="vinyl__ring"/>`).join("");
  return `<svg class="vinyl__svg" viewBox="0 0 200 200" aria-hidden="true" focusable="false"><circle cx="100" cy="100" r="98" class="vinyl__disc"/>${rings}
    <circle cx="100" cy="100" r="34" class="vinyl__label"/><text x="100" y="101" class="vinyl__text" text-anchor="middle" dominant-baseline="central">${esc(label ?? "")}</text><circle cx="100" cy="100" r="3" class="vinyl__hole"/></svg>`;
}

async function renderAlbum(id) {
  view().innerHTML = `${loadingLabel("Loading album")}<div class="ahero ahero--loading"><div class="ahero__inner"><div class="sleeve"><div class="sk art"></div></div>
    <div class="ahero__text" style="gap:14px"><div class="sk sk-line" style="height:18px;width:30%"></div><div class="sk sk-line" style="height:64px;width:78%"></div><div class="sk sk-line" style="height:24px;width:40%"></div><div class="sk" style="height:96px;border-radius:var(--r-md);margin-top:24px"></div></div></div></div>`;
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
      sb.from("album_reviews").select("*").eq("album_id", id).order("updated_at", { ascending: false }).limit(100),
      user ? sb.from("profile_pins").select("album_id, position") : Promise.resolve({ data: null }),
    ]);
    S.pins = pn.data || [];
    S.stats = s.data; S.mine = r.data; S.score = r.data?.score || 0; S.standouts = new Set(r.data?.standout_tracks || []);
    if (st.data) S.status = st.data;
    if (c.data?.length) { S.counts = Array(10).fill(0); c.data.forEach((x) => { if (x.score >= 1 && x.score <= 10) S.counts[x.score - 1] = x.n; }); }
    reviews = (rv.data || []).filter((x) => !x.is_mine);
  }
  setPageMeta(document.title, `${album.title} by ${album.artist}${yr ? ` (${yr})` : ""}${album.tracks?.length ? `, ${plural(album.tracks.length, "track")}` : ""}. ${S.stats ? `Community rating ${S.stats.avg_score} out of 10 from ${plural(S.stats.rating_count, "rating")}.` : "Not rated yet on Rotation."}`);
  const total = album.tracks?.reduce((s, t) => s + (t.length || 0), 0);
  const artistHref = (aid) => aid ? `/artist/${aid}` : `/find-artist/${encodeURIComponent(album.artist)}`;
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
        <div class="rating-stat"><span class="score score--lg"${RL.toneAttr(S.stats.avg_score)}>${S.stats.avg_score}<small> /10</small></span><span class="t-meta">${plural(n, "rating")}</span></div>
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
    `<button type="button" data-s="${i + 1}"${RL.toneAttr(i + 1)} aria-pressed="${S.score === i + 1}" aria-label="Rate ${i + 1} out of 10">${i + 1}</button>`).join("")}</div>`;

  const genreLinks = (album.genres || []).map((n) => { const g = matchGenre(n); return g ? `<a class="textlink" href="/genre/${g.slug}">${esc(n)}</a>` : `<span>${esc(n)}</span>`; }).join('<span class="slash" aria-hidden="true">/</span>');
  const heroFigures = () => `
    <div class="figure"${RL.toneAttr(S.stats?.avg_score)}><span class="figure__num" id="heroAvg">${S.stats ? S.stats.avg_score : "–"}</span><span class="figure__label" id="heroCount">${S.stats ? `Community · ${plural(S.stats.rating_count, "rating")}` : "No ratings yet"}</span></div>
    <div class="figure figure--mine"${RL.toneAttr(S.score)}><span class="figure__num" id="heroMine">${S.score || "–"}</span><span class="figure__label">Your score</span></div>`;

  view().innerHTML = `
    <article class="album2">
      <header class="ahero">
        <div class="ahero__inner">
          <div class="sleeve">
            <div class="vinyl" aria-hidden="true">${vinylSvg(S.stats ? S.stats.avg_score : "")}</div>
            <div class="album__art">${artwork(album.cover_url, `${album.title} by ${album.artist}`, "", { priority: true })}</div>
          </div>
          <div class="ahero__text">
            <p class="eyebrow" id="albumEyebrow"${eyebrow() ? "" : " hidden"}>${esc(eyebrow())}</p>
            <h1 class="ahero__title">${esc(album.title)}</h1>
            <a class="ahero__artist" id="artistLink" href="${artistHref(album.artist_id)}">${esc(album.artist)}</a>
            ${facts.length ? `<p class="ahero__facts">${facts.map((f, i) => `${i ? '<span class="dot" aria-hidden="true"></span>' : ""}<span>${esc(f)}</span>`).join("")}</p>` : ""}
            ${genreLinks ? `<p class="ahero__genres" aria-label="Genres">${genreLinks}</p>` : ""}
            <div class="figures" id="heroFigures" aria-label="Scores">${heroFigures()}</div>
            <div class="album__actions">
              <a class="btn btn--listen listen-link" id="listenBtn" href="${getStream() ? RL.streamingSearchUrl(getStream(), RL.listenQuery(album.artist, album.title)) : "/settings"}" target="_blank" rel="noopener">${icon("play", "icon icon--play")}<span>${getStream() ? `Listen on ${esc(streamLabel(getStream()))}` : "Listen"}</span></a>
              ${button(S.mine ? "Edit your rating" : "Rate this album", { variant: "primary", id: "jumpRate", iconName: "star" })}
              ${button("Share", { id: "shareBtn", iconName: "share" })}
              <button type="button" class="btn" id="pinBtn" aria-pressed="${isPinned()}">${icon(isPinned() ? "check" : "pin")}<span>${isPinned() ? "Pinned to profile" : "Pin to profile"}</span></button>
              ${button("Add to list", { id: "listBtn", iconName: "list" })}
            </div>
            <p class="listen__note t-meta" id="listenNote"${getStream() ? "" : " hidden"}>Opens in <span data-svc-name>${esc(streamLabel(getStream()))}</span>. <a class="textlink" href="/settings">Change</a></p>
            <div id="statusWrap" class="status-wrap">${statusHTML()}</div>
          </div>
        </div>
      </header>

      <div class="album-body">
        <div class="album-body__main">
          <section class="rate" id="yourRating" aria-labelledby="you-h">
            <div class="kicker"><h2 id="you-h">Your rating</h2><span class="t-meta" id="ratedMeta">${ratedOn()}</span></div>
            <div class="rate__row">
              <div id="rec">${recordSvg(S.score)}</div>
              <div class="rate__side">
                <div class="rating-stat"><span class="t-meta">Your score</span><span class="score score--lg" id="myScore"${RL.toneAttr(S.score)}>${S.score || "–"}<small> /10</small></span></div>
                <p class="t-label" id="pickLabel">${S.mine ? "Change your score" : "Tap a score to rate"}</p>
              </div>
            </div>
            ${pickerHTML()}
            <p class="field__hint" id="rateStatus" role="status" aria-live="polite">${user ? "Saves as soon as you tap. A review is optional." : "Sign in to save your rating."}</p>
          </section>

          <section class="block" aria-labelledby="trk-h">
            <div class="kicker"><h2 id="trk-h">Tracklist</h2>${album.tracks?.length ? `<span class="t-meta">Star your standouts</span>` : ""}</div>
            ${album.tracks?.length ? `<ol class="tracks" id="tracks">${album.tracks.map((t) => `
              <li class="track${S.standouts.has(t.title) ? " is-standout" : ""}">
                <span class="track__pos">${esc(t.pos)}</span><span class="track__title">${esc(t.title)}</span>
                <span class="track__len">${fmtLen(t.length)}</span>
                <a class="icon-btn track__listen listen-link" href="/settings" target="_blank" rel="noopener" data-track="${esc(t.title)}" aria-label="Listen to ${esc(t.title)}">${icon("play", "icon icon--play")}</a>
                <button type="button" class="icon-btn" data-t="${esc(t.title)}" aria-pressed="${S.standouts.has(t.title)}" aria-label="Standout: ${esc(t.title)}">${icon("star")}</button>
              </li>`).join("")}</ol>`
              : emptyState({ iconName: "note", title: "No tracklist listed", body: "MusicBrainz doesn't have tracks for this album yet. You can still score it.", plain: true })}
          </section>

          <section class="block" aria-labelledby="rv-h">
            <div class="kicker"><h2 id="rv-h">Your review</h2><span class="t-meta">Optional</span></div>
            <label class="field"><span class="sr">Your review</span>
              <textarea id="thoughts" class="textarea" maxlength="2000" placeholder="What stuck with you? Favorite moments, how it holds up, where it fits.">${esc(S.mine?.thoughts || "")}</textarea>
            </label>
            <label class="check"><input type="checkbox" id="isPublic"${shared ? " checked" : ""}><span>Share this review with the community</span></label>
            <label class="check" id="creditField" hidden><input type="checkbox" id="creditProfile"${S.mine?.credit_profile ? " checked" : ""}><span>Credit this review to my profile${profile ? ` (@${esc(profile.username)})` : ""}</span></label>
            <label class="field" id="nameField"${shared ? "" : " hidden"}><span class="field__label">Show as</span>
              <input id="displayNameInput" class="input" maxlength="40" placeholder="Anonymous listener" value="${esc(S.mine?.display_name || "")}" autocomplete="off">
            </label>
            <span class="field__hint" id="reviewHint"></span>
            <div><button type="button" class="btn btn--ghost btn--sm" id="delReview" data-danger="1"${S.mine?.thoughts ? "" : " hidden"}>${icon("close")}<span>Delete review</span></button></div>
            <div class="save-bar">
              <button type="button" class="btn btn--primary" id="save"><span>${S.mine ? "Save review and standouts" : "Save rating and review"}</span></button>
              <button type="button" class="btn btn--ghost" id="remove" data-danger="1"${S.mine ? "" : " hidden"}><span>Remove rating</span></button>
            </div>
          </section>

          <section class="block" id="reviews" aria-labelledby="rev-h">
            <div class="kicker"><h2 id="rev-h">Community reviews</h2><span class="t-meta" id="revCount" role="status" aria-live="polite"></span></div>
            ${reviews.length > 1 ? `<label class="field field--inline"><span class="sr">Sort reviews</span><select class="select" id="revSort" aria-label="Sort reviews">
              <option value="recent">Most recent</option><option value="high">Highest rated</option><option value="low">Lowest rated</option><option value="liked">Most liked</option></select></label>` : ""}
            <div id="revList"></div><div id="revMore"></div>
          </section>
        </div>

        <aside class="album-body__side" aria-label="Community">
          <section class="aside-block" aria-labelledby="comm-h">
            <div class="kicker"><h2 id="comm-h">Community rating</h2><span class="t-meta">Plain average</span></div>
            <div id="communityBody">${communityHTML()}</div>
          </section>
        </aside>
      </div>
    </article>
    <div id="albumMore"></div>`;
  applyAlbumTint(album.cover_url);
  wireListen(album);

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
    setTone($("#myScore"), S.score);
    $$("#picker button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.s === S.score)));
    $("#picker").setAttribute("aria-busy", String(S.busy));
    $("#pickLabel").textContent = S.mine ? "Change your score" : "Tap a score to rate";
    $("#ratedMeta").textContent = ratedOn();
    $("#jumpRate span").textContent = S.mine ? "Edit your rating" : "Rate this album";
    $("#save span").textContent = S.mine ? "Save review and standouts" : "Save rating and review";
    $("#remove").hidden = !S.mine;
    $("#delReview").hidden = !S.mine?.thoughts;
    paintHero();
  };
  const paintStatus = () => {
    const focused = document.activeElement?.dataset?.st;
    $("#statusWrap").innerHTML = statusHTML();
    if (focused) $(`#statusWrap [data-st="${focused}"]`)?.focus();
    $$("#statusWrap .btn").forEach((b) => b.setAttribute("aria-busy", String(S.statusBusy)));
  };
  // The big numbers in the hero (community average and your own score) follow the same state as the panels below
  const paintHero = () => {
    const f = $("#heroFigures"); if (!f) return;
    $("#heroAvg").textContent = S.stats ? S.stats.avg_score : "–";
    $("#heroCount").textContent = S.stats ? `Community · ${plural(S.stats.rating_count, "rating")}` : "No ratings yet";
    $("#heroMine").textContent = S.score || "–";
    setTone($("#heroMine").parentNode, S.score); setTone($("#heroAvg").parentNode, S.stats?.avg_score);
    const t = $(".vinyl__text"); if (t) t.textContent = S.stats ? S.stats.avg_score : "";
  };
  const paintCommunity = () => { $("#communityBody").innerHTML = communityHTML(); paintHero(); };
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
  const needSignIn = (selector, why) => requireSignIn(selector, why);
  // Tapping a score saves it right away. Only the score is sent, so an existing review is never touched.
  async function submitScore(n) {
    if (needSignIn(`#picker [data-s="${n}"]`, "rate this album") || S.busy || n === S.score) return;
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
    if (needSignIn(`[data-st="${key}"]`, "update your listening status") || S.statusBusy) return;
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

  /* ----- community reviews: sort, show more, like, report ----- */
  const R = { sort: "recent", shown: 10 };
  const recentFirst = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at));
  const REVIEW_SORTS = { recent: recentFirst, high: (a, b) => b.score - a.score || recentFirst(a, b), low: (a, b) => a.score - b.score || recentFirst(a, b),
    liked: (a, b) => (b.like_count || 0) - (a.like_count || 0) || recentFirst(a, b) };
  const reviewFooter = (r) => `<footer class="review-card__foot">
      <button type="button" class="btn btn--sm btn--ghost" data-like="${r.id}" aria-pressed="${!!r.liked_by_me}" aria-label="${r.liked_by_me ? "Unlike" : "Like"} this review">${icon("heart")}<span>${r.like_count || ""}</span></button>
      <button type="button" class="btn btn--sm btn--ghost" data-report="${r.id}" aria-label="Report this review">${icon("flag")}<span>Report</span></button></footer>`;
  const paintReviews = () => {
    const sorted = [...reviews].sort(REVIEW_SORTS[R.sort]);
    $("#revCount").textContent = reviews.length ? plural(reviews.length, "review") : "";
    $("#revList").innerHTML = sorted.length
      ? `<div class="reviews">${sorted.slice(0, R.shown).map((r) => reviewCard({ name: r.author, date: r.updated_at, score: r.score, body: r.body, standouts: r.standout_tracks || [],
          href: r.author_username ? profileHref(r.author_username) : null, footer: reviewFooter(r) })).join("")}</div>`
      : emptyState({ iconName: "note", title: "No written reviews yet. Say something.", body: "Reviews appear here when listeners choose to share them. Notes stay private unless the writer shares them.", plain: true });
    $("#revMore").innerHTML = sorted.length > R.shown ? `<button type="button" class="btn" id="revShowMore"><span>Show ${Math.min(10, sorted.length - R.shown)} more</span></button>` : "";
  };
  paintReviews();
  $("#revSort")?.addEventListener("change", (e) => { R.sort = e.target.value; R.shown = 10; paintReviews(); });
  $("#reviews").addEventListener("click", async (e) => {
    if (e.target.closest("#revShowMore")) { R.shown += 10; paintReviews(); return; }
    const like = e.target.closest("[data-like]"), rep = e.target.closest("[data-report]");
    if (rep) return openReportDialog({ type: "review", id: rep.dataset.report, label: "this review" });
    if (!like || needSignIn(`[data-like="${like.dataset.like}"]`, "like this review") || like.getAttribute("aria-busy") === "true") return;
    const r = reviews.find((x) => x.id === like.dataset.like); if (!r) return;
    like.setAttribute("aria-busy", "true");
    const { data, error } = await sb.rpc("toggle_review_like", { p_rating: r.id });
    like.removeAttribute("aria-busy");
    if (error) return toast(apiError(error), "error");
    r.liked_by_me = data.liked; r.like_count = data.count;
    like.setAttribute("aria-pressed", String(data.liked));
    like.setAttribute("aria-label", `${data.liked ? "Unlike" : "Like"} this review`);
    $("span", like).textContent = data.count || "";
  });

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
  $("#tracks")?.addEventListener("click", (e) => { if (e.target.closest("[data-t]")) markDirty(); });   // only a star changes the draft, not Listen
  paintHint();

  $("#jumpRate").onclick = () => {
    $("#yourRating").scrollIntoView({ block: "start" });
    ($("#picker button[aria-pressed='true']") || $("#picker button")).focus({ preventScroll: true });
  };
  $("#listBtn").onclick = () => { if (!needSignIn("#listBtn", "add this album to a list")) openListPicker(album, ensureAlbum); };
  $("#pinBtn").onclick = async () => {
    if (needSignIn("#pinBtn", "pin this album to your profile")) return;
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
    if (needSignIn("#save", "save your review")) return;
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
  // Deletes only the written review (and its sharing); the score and standout stars stay
  $("#delReview").onclick = async () => {
    if (!S.mine || !confirm("Delete your written review? Your score stays.")) return;
    const btn = $("#delReview"); btn.setAttribute("aria-busy", "true");
    const { data, error } = await sb.from("ratings").update({ thoughts: null, is_public: false, credit_profile: false, display_name: null }).eq("id", S.mine.id).select("*").single();
    btn.removeAttribute("aria-busy");
    if (error) return toast(`Couldn't delete the review: ${apiError(error)}`, "error");
    S.mine = data;
    $("#thoughts").value = ""; $("#isPublic").checked = false; $("#displayNameInput").value = ""; $("#creditProfile").checked = false;
    paintHint(); paintAll(); toast("Review deleted", "info");
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
  // Real rating patterns: listeners who scored this 8+ and also scored these 8+. Needs 3+ people in common.
  if (sb) {
    const { data } = await sb.rpc("related_by_ratings", { p_album: album.id });
    if (data?.length) sections.push(`<section class="section">${sectionHead("Loved by the same listeners", { sub: "People who scored this album 8 or higher also scored these 8 or higher. Calculated from community ratings; needs 3 or more people in common." })}
      <div class="row">${data.map((r) => albumCard({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url }, { score: r.avg_score, scoreLabel: "Average among these listeners", meta: `${r.co_raters} people scored both 8+` })).join("")}</div></section>`);
  }
  if (album.artist_id) {
    try {
      const j = await getJSON(`${MB}/release-group?artist=${album.artist_id}&type=album&limit=100&fmt=json`);
      const more = (j["release-groups"] || []).filter((g) => g.id !== album.id && isStudioAlbum(g))
        .sort((x, y) => (y["first-release-date"] || "").localeCompare(x["first-release-date"] || "")).slice(0, 12);
      if (more.length) sections.push(`<section class="section">${sectionHead(`More from ${album.artist}`, { sub: "Same artist, from MusicBrainz. Newest first.", link: `/artist/${album.artist_id}`, linkLabel: "All albums" })}
        <div class="row">${more.map((g) => albumCard({ id: g.id, title: g.title, art: coverUrl(g.id, 250) }, { meta: year(g["first-release-date"]) || null })).join("")}</div></section>`);
    } catch {}
  }
  if (sb && album.genres?.length) {
    const { data } = await sb.from("album_catalog").select("album_id, title, artist, cover_url, genres, avg_score, rating_count").overlaps("genres", album.genres).neq("album_id", album.id).neq("artist", album.artist).limit(60);
    // Most shared genres first, then the better-liked; the card says exactly which genres match
    const mine = new Set(album.genres), ranked = (data || []).map((a) => ({ ...a, shared: (a.genres || []).filter((x) => mine.has(x)) }))
      .sort((a, b) => b.shared.length - a.shared.length || (b.rating_count ? b.avg_score : 0) - (a.rating_count ? a.avg_score : 0)).slice(0, 12);
    if (ranked.length) {
      const g = matchGenre(album.genres[0]);
      sections.push(`<section class="section">${sectionHead("Similar on Rotation", { sub: "Other albums people on Rotation have saved or rated that share this album's genres (MusicBrainz).", link: g ? `/genre/${g.slug}` : null, linkLabel: "Genre chart" })}
        <div class="row">${ranked.map((a) => albumCard({ id: a.album_id, title: a.title, artist: a.artist, art: a.cover_url },
          { score: a.rating_count ? a.avg_score : null, count: a.rating_count, meta: `Shares ${a.shared.slice(0, 2).join(", ")}` })).join("")}</div></section>`);
    }
  }
  if (wrap.isConnected) wrap.innerHTML = sections.join("");
}

function renderNotFound() {
  document.title = "Page not found · Rotation";
  view().innerHTML = emptyState({ iconName: "search", title: "Page not found", body: "That link doesn't go anywhere in Rotation.", actions: button("Go home", { variant: "primary", href: "/" }) });
}

/* ==========================================================================
   Profiles, follows, pinned favorites and lists
   Other people only ever see rows from the public_* views, and only for profiles
   whose owner made them public. Your own page reads your own tables directly.
   ========================================================================== */
const profileHref = (username) => `/u/${username}`;
const profileUrl = (username) => `${location.origin}/u/${username}`;
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
    <span class="tile__art">${artwork(smallArt(art), `${title}${artist ? ` by ${artist}` : ""}`)}${score != null ? `<span class="tile__score${mine ? " tile__score--mine" : ""}"${RL.toneAttr(score)}><span class="sr">Score: </span>${score}</span>` : ""}</span>
    <span class="tile__title">${esc(title)}</span>${note ? `<span class="tile__note">${esc(note)}</span>` : ""}</a>`;
}
// A list card: cover collage, title, creator (when browsing other people's lists) and details.
// The collage and title are separate links so the creator link can sit between them.
function listTile(l, { own = false, showCreator = false } = {}) {
  const covers = l.covers || [], href = `/list/${l.id}`;
  const meta = [plural(l.item_count, "album"), own ? (l.is_public ? "Public" : "Private") : null,
    l.updated_at ? `Updated ${fmtDate(String(l.updated_at).slice(0, 10), "short")}` : null].filter(Boolean).join(" · ");
  const n = Math.min(4, covers.length);
  return `<article class="listtile">
    <a class="collage collage--${n}" href="${href}" aria-label="Open ${esc(l.title)}">${n ? covers.slice(0, n).map((c) => `<span class="collage__cell"><img src="${esc(smallArt(c))}" alt="" loading="lazy" onerror="this.remove()"></span>`).join("") : `<span class="collage__cell"></span>`}</a>
    <a class="listtile__title" href="${href}">${esc(l.title)}</a>
    ${showCreator && l.username ? `<span class="t-meta">by <a class="textlink" href="${profileHref(l.username)}">@${esc(l.username)}</a></span>` : ""}
    <span class="t-meta">${esc(meta)}</span></article>`;
}

// What the page needs, in one shape whether it came from the owner's tables or the public views
async function loadProfileData(p, own) {
  const q = (req) => req.then((r) => r.data || []).catch(() => []);
  const u = p.username;
  if (own) {
    const [pins, ratings, lists] = await Promise.all([
      q(sb.from("profile_pins").select("position, album:albums(id,title,artist,cover_url)").order("position")),
      q(sb.from("ratings").select("score, thoughts, is_public, credit_profile, updated_at, created_at, album:albums(id,title,artist,cover_url,genres)").order("updated_at", { ascending: false }).limit(300)),
      q(sb.from("lists").select("id, title, description, is_public, updated_at, list_items(position, album:albums(cover_url))").order("updated_at", { ascending: false })),
    ]);
    const rs = ratings.filter((r) => r.album).map((r) => ({ album_id: r.album.id, title: r.album.title, artist: r.album.artist, cover_url: r.album.cover_url,
      genres: r.album.genres || [], score: r.score, rated_at: r.updated_at, first_rated_at: r.created_at, has_review: !!(r.credit_profile && r.is_public && r.thoughts?.trim()), body: r.thoughts }));
    return {
      pins: pins.filter((x) => x.album).map((x) => ({ position: x.position, album_id: x.album.id, title: x.album.title, artist: x.album.artist, cover_url: x.album.cover_url })),
      ratings: rs,
      reviews: rs.filter((r) => r.has_review).map((r) => ({ ...r, updated_at: r.rated_at })),
      lists: lists.map((l) => { const items = [...(l.list_items || [])].filter((i) => i.album).sort((a, b) => a.position - b.position);
        return { id: l.id, title: l.title, description: l.description, is_public: l.is_public, updated_at: l.updated_at, item_count: items.length, covers: items.slice(0, 4).map((i) => i.album.cover_url) }; }),
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
      actions: button("Go home", { variant: "primary", href: "/" }), compact: false });
    return;
  }
  document.title = `${p.display_name || p.username} (@${p.username}) · Rotation`;
  setPageMeta(document.title, p.bio ? p.bio.slice(0, 160) : `${p.display_name || "@" + p.username} on Rotation: albums rated, favorites and lists.`);
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
    ? `${button("Edit profile", { variant: "primary", size: "sm", href: "/me/edit", iconName: "user" })}${button("Share", { size: "sm", id: "shareProfile", iconName: "share" })}`
    : `<button type="button" class="btn btn--sm${following ? "" : " btn--primary"}" id="followBtn" aria-pressed="${following}">${icon(following ? "check" : "user")}<span>${following ? "Following" : "Follow"}</span></button>${button("Compare tastes", { size: "sm", href: `/compare/${username}`, iconName: "spark" })}${button("Share", { size: "sm", id: "shareProfile", iconName: "share" })}${button("Report", { size: "sm", variant: "ghost", id: "reportProfile", iconName: "flag" })}`;
  const recapYear = ratingsVisible ? RL.yearsWithRatings(d.ratings)[0] : null;
  const taste = ratingsVisible ? tasteOf(d.ratings) : null;

  const draw = () => {
    let body = "";
    if (ptab === "ratings") {
      if (!ratingsVisible) body = emptyState({ iconName: "user", compact: true, title: "Ratings are private", body: `${p.display_name || "@" + p.username} keeps their ratings to themselves.` });
      else if (!d.ratings.length) body = emptyState({ iconName: "disc", compact: true, title: own ? "Nothing rated yet" : "No ratings yet",
        body: own ? "Score an album and it lands in your grid." : "Check back once they've rated something.", actions: own ? button("Search albums", { variant: "primary", href: "/search", iconName: "search" }) : "" });
      else {
        const list = [...d.ratings].sort(psort === "top" ? (a, b) => b.score - a.score || String(b.rated_at).localeCompare(String(a.rated_at)) : (a, b) => String(b.rated_at).localeCompare(String(a.rated_at)));
        body = `<div class="chips" role="group" aria-label="Sort ratings" style="margin-bottom:var(--s-5)">
            <button type="button" class="chip" data-sort="recent" aria-pressed="${psort === "recent"}">Recently rated</button>
            <button type="button" class="chip" data-sort="top" aria-pressed="${psort === "top"}">Highest scores</button></div>
          <div class="tiles">${list.map((r) => tile({ href: `/album/${r.album_id}`, art: r.cover_url, title: r.title, artist: r.artist, score: r.score, mine: own, note: r.has_review ? "Review" : "" })).join("")}</div>
          ${d.ratings.length >= 300 ? `<p class="t-meta" style="margin-top:var(--s-4)">Showing the 300 most recent ratings.</p>` : ""}`;
      }
    } else if (ptab === "reviews") {
      body = d.reviews.length ? `<div class="reviews">${d.reviews.map((r) => `<article class="review-card">
          <header class="review-card__head">${artwork(smallArt(r.cover_url), r.title, "thumb")}
            <span class="review-card__who"><a href="/album/${r.album_id}"><strong>${esc(r.title)}</strong></a><span class="t-meta">${esc(r.artist || "")} · Reviewed ${fmtDate(String(r.updated_at).slice(0, 10), "short")}</span></span>
            ${scoreChip(r.score, { mine: own })}</header>
          <p class="review-card__body">${esc(r.body)}</p></article>`).join("")}</div>`
        : emptyState({ iconName: "note", compact: true, title: "No shared reviews", body: own ? "Write a review on an album page, share it, and credit it to your profile." : "Written reviews they choose to share appear here." });
    } else {
      body = d.lists.length ? `<div class="listtiles">${d.lists.map((l) => listTile(l, { own })).join("")}</div>`
        : emptyState({ iconName: "list", compact: true, title: own ? "No lists yet" : "No public lists", body: own ? "Group albums into lists, then make them public to show them here." : "Lists they make public appear here.",
            actions: own ? button("Create a list", { variant: "primary", href: "/lists/yours" }) : "" });
    }
    $("#pbody").innerHTML = `${tabs([["ratings", `Ratings${ratingsVisible ? ` (${d.ratings.length})` : ""}`], ["reviews", `Reviews (${d.reviews.length})`], ["lists", `Lists (${d.lists.length})`]], ptab, "Profile sections")}${body}`;
    $$("#pbody [data-tab]").forEach((b) => b.onclick = () => { ptab = b.dataset.tab; draw(); });
    $$("#pbody [data-sort]").forEach((b) => b.onclick = () => { psort = b.dataset.sort; draw(); });
  };

  view().innerHTML = `
    ${profileHeader({ avatar: avatarHTML(p, "lg"), eyebrow: `@${p.username}${p.created_at ? ` · Joined ${fmtDate(String(p.created_at).slice(0, 7))}` : ""}`,
      name: p.display_name || p.username, stats,
      extra: `${p.bio ? `<p class="profile__bio">${esc(p.bio)}</p>` : ""}<div class="chips" style="margin-top:var(--s-4)">${actions}${recapYear ? button("Year in Rotation", { size: "sm", href: `/u/${username}/year/${recapYear}`, iconName: "star" }) : ""}</div>` })}
    ${own && !p.is_public ? `<p class="alert alert--warning" role="status" style="margin-bottom:var(--s-8)">${icon("alert")}<span>Only you can see this profile. Make it public in Edit profile to share the link.</span></p>` : ""}
    ${d.pins.length || own ? `<section class="section">${sectionHead("Favorite albums", { sub: d.pins.length ? "" : "Pin up to six albums from any album page.", link: own ? "/me/edit" : null, linkLabel: "Manage" })}
      ${d.pins.length ? `<div class="tiles tiles--pins">${d.pins.map((x) => tile({ href: `/album/${x.album_id}`, art: x.cover_url, title: x.title, artist: x.artist })).join("")}</div>` : ""}</section>` : ""}
    ${taste ? `<section class="section">${sectionHead("Taste", { sub: "From the ratings shown on this profile" })}<div class="chips">
      ${taste.genres.map((n) => { const g = matchGenre(n); return g ? `<a class="chip" href="/genre/${g.slug}">${esc(n)}</a>` : `<span class="chip chip--static">${esc(n)}</span>`; }).join("")}
      ${taste.artists.map((n) => `<a class="chip" href="/find-artist/${encodeURIComponent(n)}">${icon("user")}${esc(n)}</a>`).join("")}</div></section>` : ""}
    <div id="pbody"></div>`;
  draw();

  $("#shareProfile").onclick = async () => {
    const data = { title: `${p.display_name || p.username} on Rotation`, url: profileUrl(p.username) };
    if (!own || p.is_public) { if (navigator.share) { try { await navigator.share(data); } catch {} return; } }
    else return toast("This profile is private. Make it public before sharing the link.", "info");
    try { await navigator.clipboard.writeText(data.url); toast("Link copied"); } catch { toast("Copy the link from your address bar", "info"); }
  };
  $("#reportProfile")?.addEventListener("click", () => openReportDialog({ type: "profile", id: username, label: `@${username}` }));
  const fb = $("#followBtn");
  if (fb) fb.onclick = async () => {
    if (requireSignIn("#followBtn", "follow this person")) return;
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
        <span class="field__hint" id="uHint">3 to 20 lowercase letters, numbers or underscores. Your link: ${esc(location.origin)}/u/<strong id="uPrev">${esc(p.username || "username")}</strong></span></label>
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
    </form>
    <section class="fieldset" style="margin-top:var(--s-10);max-width:560px" aria-labelledby="yourdata-h">
      <h2 class="t-section" id="yourdata-h">Your data</h2>
      <p class="text-2" style="font-size:var(--fs-sm)">Download everything Rotation stores about you as a file, or delete your account. Deleting removes your ratings, reviews, lists, profile and follows for good.</p>
      <div class="chips">${button("Download my data", { id: "exportData", iconName: "share" })}<button type="button" class="btn btn--ghost" id="deleteAccount" data-danger="1">${icon("close")}<span>Delete my account</span></button></div>
    </section>`;

  $("#exportData").onclick = async () => {
    const btn = $("#exportData"); btn.setAttribute("aria-busy", "true");
    try {
      const tables = ["profiles", "ratings", "album_status", "profile_pins", "lists", "list_items", "follows", "review_likes", "notification_prefs"];
      const out = { exported_at: new Date().toISOString(), account: { id: user.id, email: user.email, created_at: user.created_at } };
      const order = { ratings: ["id"], album_status: ["album_id"], profile_pins: ["position"], lists: ["id"], list_items: ["list_id", "album_id"], follows: ["followee_id"], review_likes: ["rating_id"], profiles: ["user_id"], notification_prefs: ["user_id"] };
      for (const t of tables) {
        const { data, error } = await fetchAll(() => order[t].reduce((q, col) => q.order(col), sb.from(t).select("*")));
        if (error) throw error;   // a file that silently leaves a table out would look complete
        out[t] = data;
      }
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `rotation-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast("Your data was downloaded");
    } catch { toast("Couldn't prepare your data. Try again.", "error"); }
    btn.removeAttribute("aria-busy");
  };
  $("#deleteAccount").onclick = async () => {
    const typed = prompt("This permanently deletes your account, ratings, reviews, lists, profile and follows. It cannot be undone.\n\nType DELETE to confirm.");
    if (typed !== "DELETE") { if (typed !== null) toast("Nothing was deleted. You have to type DELETE exactly.", "info"); return; }
    const btn = $("#deleteAccount"); btn.setAttribute("aria-busy", "true");
    try {
      const { data: { session } } = await sb.auth.getSession();
      const r = await fetch("/api/delete-account", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` }, body: JSON.stringify({ confirm: "DELETE" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { btn.removeAttribute("aria-busy"); return toast(j.error || "Couldn't delete the account.", "error"); }
      await sb.auth.signOut(); profile = null;
      toast("Your account was deleted", "info"); go("/");
    } catch { btn.removeAttribute("aria-busy"); toast("Couldn't reach the server. Nothing was deleted.", "error"); }
  };
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
    go(profileHref(profile.username));
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
  const { data, error } = await sb.from("lists").select("id, title, is_public, updated_at, list_items(position, album:albums(cover_url))").order("updated_at", { ascending: false });
  if (error) { el.innerHTML = errorState({ title: "Couldn't load your lists", retry: () => renderMyLists(el), compact: false }); return; }
  const lists = (data || []).map((l) => { const items = [...(l.list_items || [])].filter((i) => i.album).sort((a, b) => a.position - b.position);
    return { id: l.id, title: l.title, is_public: l.is_public, updated_at: l.updated_at, item_count: items.length, covers: items.slice(0, 4).map((i) => i.album.cover_url) }; });
  el.innerHTML = `<form id="newList" class="form panel" novalidate><h2 class="t-section">New list</h2>${listForm()}
      <p id="lError" class="alert alert--error" role="alert" hidden></p>
      <div><button type="submit" class="btn btn--primary" id="lSave"><span>Create list</span></button></div></form>
    <section class="section" style="margin-top:var(--s-10)">${sectionHead("Your lists", { sub: lists.length ? plural(lists.length, "list") : "" })}
      ${lists.length ? `<div class="listtiles">${lists.map((l) => listTile(l, { own: true })).join("")}</div>` : emptyState({ iconName: "list", compact: true, title: "No lists yet", body: "Create one above, then add albums from any album page." })}</section>`;
  $("#newList").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#lTitle").value.trim(), err = $("#lError");
    if (!title) { err.textContent = "Give your list a title."; err.hidden = false; return; }
    const btn = $("#lSave"); btn.setAttribute("aria-busy", "true"); err.hidden = true;
    const { data: row, error: e2 } = await sb.from("lists").insert({ title, description: $("#lDesc").value.trim() || null, is_public: $("#lPublic").checked }).select("id").single();
    btn.removeAttribute("aria-busy");
    if (e2) { err.textContent = `Couldn't create the list: ${apiError(e2)}`; err.hidden = false; return; }
    go(`/list/${row.id}`);
  });
}

async function renderList(id) {
  view().innerHTML = `${loadingLabel("Loading list")}<div class="page-head"><div class="sk sk-line" style="height:40px;width:50%"></div></div>${skList(5)}`;
  let list = null, own = false;
  if (sb && user) { const { data } = await sb.from("lists").select("*").eq("id", id).maybeSingle(); if (data) { list = data; own = true; } }
  if (!list && sb) { const { data } = await sb.from("public_lists").select("*").eq("id", id).maybeSingle(); list = data; }
  if (!list) {
    view().innerHTML = emptyState({ iconName: "list", title: "List not found", body: "This list doesn't exist, or its owner keeps it private.", actions: button("Go home", { variant: "primary", href: "/" }), compact: false });
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
  setPageMeta(document.title, list.description ? list.description.slice(0, 160) : `A list of ${plural(items.length, "album")} on Rotation.`);

  const rowsHTML = () => items.length ? `<ol class="entries">${items.map((x, i) => `<li class="entry">
      <span class="entry__rank">${i + 1}</span>
      <a class="entry__link" href="/album/${x.album_id}">${artwork(smallArt(x.cover_url), `${x.title} by ${x.artist}`, "thumb")}
        <span class="list-card__text"><span class="list-card__title">${esc(x.title)}</span><span class="list-card__sub">${esc(x.artist || "")}</span></span></a>
      ${own ? `<span class="entry__actions">
        <button type="button" class="icon-btn" data-op="up" data-i="${i}" aria-label="Move ${esc(x.title)} up"${i === 0 ? " disabled" : ""}>${icon("up")}</button>
        <button type="button" class="icon-btn" data-op="down" data-i="${i}" aria-label="Move ${esc(x.title)} down"${i === items.length - 1 ? " disabled" : ""}>${icon("down")}</button>
        <button type="button" class="icon-btn" data-op="remove" data-i="${i}" aria-label="Remove ${esc(x.title)} from the list">${icon("close")}</button></span>` : ""}</li>`).join("")}</ol>`
    : emptyState({ iconName: "disc", compact: true, title: "No albums yet", body: own ? "Open any album and choose Add to list." : "This list is empty.",
        actions: own ? button("Search albums", { variant: "primary", href: "/search", iconName: "search" }) : "" });

  const head = () => `<header class="page-head">
      <p class="t-meta">${own ? "Your list" : `List by <a class="textlink" href="${profileHref(list.username)}">@${esc(list.username)}</a>`}${own ? (list.is_public ? " · Public" : " · Private") : ""}
        · <span id="listCount">${plural(items.length, "album")}</span> · Updated ${fmtDate(String(list.updated_at).slice(0, 10), "short")} · <a class="textlink" href="/lists/browse">Browse public lists</a></p>
      <h1 class="t-title">${esc(list.title)}</h1>
      ${list.description ? `<p class="t-lead">${esc(list.description)}</p>` : ""}
      <div class="chips">${own ? `${button("Edit list", { size: "sm", id: "editList", iconName: "note" })}` : ""}${button("Share", { size: "sm", id: "shareList", iconName: "share" })}${own ? "" : button("Report", { size: "sm", variant: "ghost", id: "reportList", iconName: "flag" })}</div>
      ${own && list.is_public && profileNeedsPublic() ? `<p class="alert alert--warning" role="status">${icon("alert")}<span>This list is public, but your profile is private, so nobody else can see it. <a href="/me/edit" style="text-decoration:underline">Make your profile public</a>.</span></p>` : ""}
      ${own && list.is_public && !profile ? `<p class="alert alert--warning" role="status">${icon("alert")}<span>Create a public profile so others can find this list. <a href="/me/edit" style="text-decoration:underline">Set up profile</a>.</span></p>` : ""}
    </header>`;
  const paint = () => { view().innerHTML = `${head()}<div id="entries">${rowsHTML()}</div><div id="editBox"></div>`; wire(); };

  // After the list is redrawn, keep the person's place: focus the same kind of button on the moved row (or the other one if that end is reached) and keep the row on screen
  const refocus = (index, op) => {
    const btn = [`[data-op="${op}"][data-i="${index}"]`, `[data-op="${op === "up" ? "down" : "up"}"][data-i="${index}"]`].map((s) => $(s)).find((b) => b && !b.disabled);
    if (btn) { btn.focus({ preventScroll: true }); btn.scrollIntoView({ block: "nearest" }); }
  };
  const swap = async (i, j, op) => {
    const a = items[i], b = items[j];
    const { error } = await sb.from("list_items").upsert([{ list_id: id, album_id: a.album_id, position: b.position }, { list_id: id, album_id: b.album_id, position: a.position }], { onConflict: "list_id,album_id" });
    if (error) return toast(`Couldn't reorder: ${apiError(error)}`, "error");
    items[i] = { ...b, position: a.position }; items[j] = { ...a, position: b.position };
    $("#entries").innerHTML = rowsHTML();
    refocus(j, op); toast(`${a.title} is now number ${j + 1}`, "info");
  };
  function wire() {
    $("#shareList").onclick = async () => {
      const data = { title: list.title, text: `${list.title} on Rotation`, url: location.href };
      if (navigator.share && (!own || list.is_public)) { try { await navigator.share(data); } catch {} return; }
      try { await navigator.clipboard.writeText(location.href); toast(own && !list.is_public ? "Link copied. Only you can open it until the list is public." : "Link copied"); } catch { toast("Copy the link from your address bar", "info"); }
    };
    $("#reportList")?.addEventListener("click", () => openReportDialog({ type: "list", id, label: "this list" }));
    if (!own) return;
    $("#entries").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-op]"); if (!b) return;
      const i = +b.dataset.i, op = b.dataset.op;
      if (op === "remove") {
        const { error } = await sb.from("list_items").delete().eq("list_id", id).eq("album_id", items[i].album_id);
        if (error) return toast(`Couldn't remove: ${apiError(error)}`, "error");
        items.splice(i, 1); $("#entries").innerHTML = rowsHTML(); $("#listCount").textContent = plural(items.length, "album"); toast("Removed from list", "info");
        const next = $(`[data-op="remove"][data-i="${Math.min(i, items.length - 1)}"]`); if (next) next.focus({ preventScroll: true }); else $("#editList")?.focus();
      } else swap(i, op === "up" ? i - 1 : i + 1, op);
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
        toast("List deleted", "info"); go("/lists/yours");
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

/* ---------- Browse everyone's public lists ---------- */
let browseSort = "recent", browseQuery = "";
async function renderBrowseLists(el) {
  if (!sb) { el.innerHTML = emptyState({ iconName: "list", title: "Lists are offline right now", body: "Try again in a little while.", compact: true }); return; }
  const { data, error } = await sb.from("public_lists").select("*").gt("item_count", 0).order("updated_at", { ascending: false }).limit(100);
  if (error) { el.innerHTML = errorState({ title: "Couldn't load public lists", retry: () => renderBrowseLists(el), compact: false }); return; }
  const all = data || [];
  const shown = () => {
    const q = browseQuery.trim().toLowerCase();
    const list = all.filter((l) => !q || `${l.title} ${l.username} ${l.description || ""}`.toLowerCase().includes(q));
    return browseSort === "largest" ? [...list].sort((a, b) => b.item_count - a.item_count || String(b.updated_at).localeCompare(String(a.updated_at))) : list;
  };
  const body = () => {
    const list = shown();
    return list.length ? `<div class="listtiles">${list.map((l) => listTile(l, { showCreator: true })).join("")}</div>`
      : all.length ? emptyState({ iconName: "search", compact: true, title: `No lists match “${browseQuery.trim()}”`, body: "Try a different word, or clear the filter." })
      : emptyState({ iconName: "list", compact: true, title: "No public lists yet", body: "When people publish lists from public profiles, they show up here. Make yours public from My lists.",
          actions: button("Make a list", { variant: "primary", href: "/lists/yours" }) });
  };
  el.innerHTML = `<section class="section">${sectionHead("Public lists", { sub: all.length ? `${plural(all.length, "list")} from public profiles` : "" })}
    <div class="toolbar toolbar--lib"><label class="search search--lib"><span class="sr">Filter lists</span>${icon("search", "search__icon")}
      <input id="bQuery" class="input input--search" type="search" placeholder="Filter by title or creator" value="${esc(browseQuery)}" autocomplete="off"></label>
      <label class="field field--inline"><span class="sr">Sort lists</span><select id="bSort" class="select" aria-label="Sort lists">
        <option value="recent"${browseSort === "recent" ? " selected" : ""}>Recently updated</option><option value="largest"${browseSort === "largest" ? " selected" : ""}>Most albums</option></select></label></div>
    <div id="bBody">${body()}</div></section>`;
  $("#bSort").onchange = (e) => { browseSort = e.target.value; $("#bBody").innerHTML = body(); };
  $("#bQuery").oninput = (e) => { browseQuery = e.target.value; $("#bBody").innerHTML = body(); };
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
   Social layer: activity feed, notifications, reports
   ========================================================================== */
const FEED_PAGE = 20;
async function fetchFeed(cursor) {
  const { data, error } = await sb.rpc("get_feed", { p_ts: cursor?.ts || null, p_key: cursor?.key || null, p_limit: FEED_PAGE });
  if (error) throw error;
  return data || [];
}
function feedItemHTML(e) {
  const prof = profileHref(e.actor_username);
  const when = `<time class="t-meta" datetime="${esc(e.happened_at)}" title="${esc(new Date(e.happened_at).toLocaleString())}">${esc(ago(e.happened_at))}</time>`;
  const who = `<a class="feed__who" href="${prof}">${esc(e.actor_name)}</a>`;
  const avatar = `<a href="${prof}" tabindex="-1" aria-hidden="true">${avatarHTML({ display_name: e.actor_name, username: e.actor_username, avatar_cover: e.actor_avatar })}</a>`;
  let action, subject, art, body = "";
  if (e.kind === "list") {
    const covers = e.covers || [], n = Math.min(4, covers.length), href = `/list/${e.list_id}`;
    action = `${who} published a list`;
    subject = `<a class="feed__title" href="${href}">${esc(e.list_title)}</a><span class="t-meta">${plural(e.list_count, "album")}</span>`;
    art = `<a class="feed-item__art" href="${href}" tabindex="-1" aria-hidden="true"><span class="collage collage--${n}">${n ? covers.slice(0, n).map((c) => `<span class="collage__cell"><img src="${esc(smallArt(c))}" alt="" loading="lazy" onerror="this.remove()"></span>`).join("") : `<span class="collage__cell"></span>`}</span></a>`;
    body = e.body || "";
  } else {
    const href = `/album/${e.album_id}`;
    action = `${who} ${e.kind === "review" ? "reviewed" : e.kind === "pin" ? "pinned a favorite" : "rated"}`;
    subject = `<a class="feed__title" href="${href}">${esc(e.album_title)}</a><span class="t-meta">${esc(e.album_artist || "")}</span>${e.score != null ? scoreChip(e.score, { label: "Their score" }) : ""}`;
    art = `<a class="feed-item__art" href="${href}" tabindex="-1" aria-hidden="true">${artwork(smallArt(e.cover_url), `${e.album_title} by ${e.album_artist}`)}</a>`;
    body = e.kind === "review" ? e.body : "";
  }
  return `<article class="feed-item">${avatar}
    <div class="feed-item__main"><p class="feed-item__line">${action} · ${when}</p>
      <div class="feed-item__subject">${subject}</div>
      ${body ? `<p class="feed-item__body">${esc(body)}</p>` : ""}</div>${art}</article>`;
}

async function renderFeed() {
  document.title = "Following · Rotation";
  if (!sb || !user) {
    view().innerHTML = emptyState({ iconName: "user", title: "See what people you follow are listening to", body: "Sign in, follow a few listeners, and their ratings, reviews, lists and pinned favorites show up here.",
      actions: button("Sign in", { variant: "primary", id: "feedSignIn" }) });
    $("#feedSignIn")?.addEventListener("click", openAuth);
    return;
  }
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Following</h1>
    <p class="t-lead">Ratings, reviews, new public lists and pinned favorites from people you follow. Only public profiles appear here.</p></header>
    <div id="feedList" class="feed">${loadingLabel("Loading activity")}${skList(4)}</div><div id="feedMore"></div>`;
  const list = $("#feedList"), more = $("#feedMore");
  let cursor = null, loading = false, done = false, first = true;
  const next = async () => {
    if (loading || done) return;
    loading = true;
    more.innerHTML = first ? "" : `<button type="button" class="btn" aria-busy="true"><span>Loading…</span></button>`;
    try {
      const rows = await fetchFeed(cursor);
      if (!list.isConnected) return;
      if (first) list.innerHTML = "";
      if (first && !rows.length) {
        const { count } = await sb.from("follows").select("followee_id", { count: "exact", head: true });
        list.innerHTML = count
          ? emptyState({ iconName: "disc", title: "Nothing new yet", body: "The people you follow haven't rated, reviewed or published anything lately. Check back soon.", compact: true })
          : emptyState({ iconName: "user", title: "You're not following anyone yet", body: "Find listeners through public lists or the reviews on album pages, open their profile, and tap Follow.",
              actions: button("Browse public lists", { variant: "primary", href: "/lists/browse" }), compact: true });
        done = true; more.innerHTML = ""; return;
      }
      first = false;
      list.insertAdjacentHTML("beforeend", rows.map(feedItemHTML).join(""));
      const last = rows[rows.length - 1];
      cursor = { ts: last.happened_at, key: last.event_key };
      done = rows.length < FEED_PAGE;
      more.innerHTML = done ? (list.children.length > 3 ? `<p class="t-meta" style="text-align:center">You're all caught up.</p>` : "") : `<div style="text-align:center"><button type="button" class="btn" id="feedLoad"><span>Load more</span></button></div>`;
      $("#feedLoad")?.addEventListener("click", next);
      // Also load the next page as the button scrolls into view
      if (!done && "IntersectionObserver" in window) { const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); next(); } }, { rootMargin: "300px" }); const b = $("#feedLoad"); if (b) io.observe(b); }
    } catch {
      if (list.isConnected) { if (first) list.innerHTML = errorState({ title: "Couldn't load activity", retry: () => { first = true; loading = false; list.innerHTML = skList(4); next(); }, compact: false });
        else more.innerHTML = errorState({ title: "Couldn't load more", retry: next }); }
    } finally { loading = false; }
  };
  next();
}

// A short taste of the feed on Discover. Hidden when there is nothing to show.
async function loadHomeFeed() {
  const shelf = $("#feedShelf");
  if (!shelf || !sb || !user) return;
  try {
    const rows = (await fetchFeed(null)).slice(0, 4);
    if (!rows.length || !shelf.isConnected) return;
    shelf.hidden = false;
    $(".feed", shelf).innerHTML = rows.map(feedItemHTML).join("");
  } catch {}
}

/* ---------- Notifications ---------- */
async function refreshUnread() {
  const badge = $("#bellBadge");
  if (!badge || !sb || !user) return;
  const { count, error } = await sb.from("my_notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  if (error || !$("#bellBadge")) return;
  badge.hidden = !count;
  badge.textContent = count > 9 ? "9+" : String(count || "");
  $("#bell").setAttribute("aria-label", count ? `Notifications, ${count} unread` : "Notifications");
}
async function renderNotifications() {
  document.title = "Notifications · Rotation";
  if (!sb || !user) {
    view().innerHTML = emptyState({ iconName: "user", title: "Sign in to see notifications", body: "You'll only hear about new followers and likes on your reviews.", actions: button("Sign in", { variant: "primary", id: "noteSignIn" }) });
    $("#noteSignIn")?.addEventListener("click", openAuth);
    return;
  }
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Notifications</h1>
    <p class="t-lead">Only two things notify you, and likes are grouped into one notification per review. Everything else stays quiet.</p></header>
    <div id="noteList">${loadingLabel("Loading notifications")}${skList(3)}</div><section class="section" style="margin-top:var(--s-12)" id="prefs"></section>`;
  const [{ data, error }, { data: pref }] = await Promise.all([
    sb.from("my_notifications").select("*").order("updated_at", { ascending: false }).limit(50),
    sb.from("notification_prefs").select("*").maybeSingle(),
  ]);
  if (!$("#noteList")) return;
  if (error) $("#noteList").innerHTML = errorState({ title: "Couldn't load notifications", retry: renderNotifications, compact: false });
  else {
    const rows = data || [];
    $("#noteList").innerHTML = rows.length ? `<ul class="notes">${rows.map((n) => {
      const text = n.kind === "follow"
        ? `${n.actor_username ? `<a class="textlink" href="${profileHref(n.actor_username)}">@${esc(n.actor_username)}</a>` : "Someone"} started following you`
        : `${n.total === 1 ? "1 person" : `${n.total} people`} liked your review of <a class="textlink" href="/album/${n.album_id}">${esc(n.album_title || "an album")}</a>`;
      return `<li class="note${n.read_at ? "" : " is-unread"}">${icon(n.kind === "follow" ? "user" : "heart")}<span>${text}</span><time class="t-meta" datetime="${esc(n.updated_at)}">${esc(ago(n.updated_at))}</time></li>`; }).join("")}</ul>`
      : emptyState({ iconName: "disc", compact: true, title: "You're all caught up", body: "New followers and likes on your reviews will show up here." });
    if (rows.some((n) => !n.read_at)) sb.rpc("mark_notifications_read").then(() => refreshUnread());
  }
  const p = { follows: pref?.follows ?? true, likes: pref?.likes ?? true };
  $("#prefs").innerHTML = `${sectionHead("Notification preferences", { sub: "Changes save right away" })}
    <div class="form"><label class="check"><input type="checkbox" data-pref="follows"${p.follows ? " checked" : ""}><span>New followers<br><span class="t-meta">When someone follows you for the first time. Unfollowing and refollowing never notifies again.</span></span></label>
    <label class="check"><input type="checkbox" data-pref="likes"${p.likes ? " checked" : ""}><span>Likes on my reviews<br><span class="t-meta">One notification per review with a running count, not one per like.</span></span></label></div>`;
  $$("#prefs [data-pref]").forEach((cb) => cb.addEventListener("change", async () => {
    p[cb.dataset.pref] = cb.checked;
    const { error: e } = await sb.from("notification_prefs").upsert({ user_id: user.id, follows: p.follows, likes: p.likes }, { onConflict: "user_id" });
    if (e) { cb.checked = !cb.checked; p[cb.dataset.pref] = cb.checked; return toast(`Couldn't save: ${apiError(e)}`, "error"); }
    toast("Preferences saved");
  }));
}

/* ---------- Reports ---------- */
function openReportDialog({ type, id, label }) {
  if (!sb) return toast("Reporting is offline right now", "error");
  if (requireSignIn(null, "report this")) return;
  const dlg = document.createElement("dialog");
  dlg.className = "dialog";
  dlg.setAttribute("aria-labelledby", "rpTitle");
  dlg.innerHTML = `<form class="dialog__body" method="dialog" novalidate>
    <div class="dialog__head"><h2 class="dialog__title" id="rpTitle">Report ${esc(label)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div>
    <p class="text-2" style="font-size:var(--fs-sm)">Reports are private. Content that several people report is hidden until it has been reviewed.</p>
    <label class="field"><span class="field__label">Reason</span><select class="select" id="rpReason" style="width:100%">
      <option value="spam">Spam or ads</option><option value="harassment">Harassment or hate</option><option value="inappropriate">Inappropriate content</option><option value="other">Something else</option></select></label>
    <label class="field"><span class="field__label">Details <span class="t-meta">Optional</span></span><textarea class="textarea" id="rpDetails" maxlength="500" style="min-height:88px"></textarea></label>
    <p id="rpError" class="alert alert--error" role="alert" hidden></p>
    <div class="dialog__actions"><button type="button" class="btn btn--ghost" data-close>Cancel</button><button type="submit" class="btn btn--primary" id="rpSend"><span>Send report</span></button></div></form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#rpSend", dlg), err = $("#rpError", dlg);
    btn.setAttribute("aria-busy", "true"); err.hidden = true;
    const { error } = await sb.rpc("report_content", { p_type: type, p_id: String(id), p_reason: $("#rpReason", dlg).value, p_details: $("#rpDetails", dlg).value.trim() || null });
    btn.removeAttribute("aria-busy");
    if (error) { err.textContent = apiError(error); err.hidden = false; return; }
    dlg.close(); toast("Thanks. Your report was sent.");
  });
  dlg.showModal();
  $("#rpReason", dlg).focus();
}

/* ==========================================================================
   Browse with filters and Surprise me
   Both draw only from real data: albums people have saved or rated on Rotation, this week's
   Billboard charts, and (for Surprise me) the MusicBrainz catalog.
   ========================================================================== */
const DIVISIVE_MIN = 10; // ratings an album needs before it can be called divisive (matches the album_catalog view)
const divisiveWhy = (r) => `${Math.round((r.high_share || 0) * 100)}% scored 8 or higher and ${Math.round((r.low_share || 0) * 100)}% scored 4 or lower, from ${plural(r.rating_count, "rating")}`;
const decadeRange = (d) => (d ? { from: String(d), to: String(+d + 9) } : {});
const BROWSE_TYPES = { studio: "Studio album", ep: "EP", single: "Single", compilation: "%compilation%", live: "%live%", soundtrack: "%soundtrack%" };
const BROWSE_SORTS = {
  rated: ["Highest rated", "weighted_score", false], popular: ["Most rated", "rating_count", false], divisive: ["Most divisive", "sd", false],
  newest: ["Newest release", "release_date", false], oldest: ["Oldest release", "release_date", true], title: ["Title (A to Z)", "title", true],
};
const BROWSE_PAGE = 24;
function parseBrowse(h) {
  const q = new URLSearchParams((h.split("?")[1] || ""));
  const f = {}; ["genre", "decade", "from", "to", "min", "count", "type", "sort"].forEach((k) => { if (q.get(k)) f[k] = q.get(k); });
  if (q.get("few")) f.few = "1"; if (q.get("divisive")) f.divisive = "1";
  return f;
}
const browseHref = (f) => { const q = new URLSearchParams(); Object.entries(f).forEach(([k, v]) => { if (v) q.set(k, v); }); return `/browse${q.toString() ? "?" + q : ""}`; };

async function renderBrowse(f0 = {}) {
  document.title = "Browse · Rotation";
  const f = { ...f0 };
  const opt = (v, l, cur) => `<option value="${v}"${String(cur ?? "") === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  view().innerHTML = `<header class="page-head"><p class="t-meta"><span class="badge">Community data</span></p><h1 class="t-page">Browse</h1>
    <p class="t-lead">Filter the albums people on Rotation have rated and saved. Scores are plain averages with their rating counts shown, so a single rating is never mistaken for a consensus.</p></header>
    <div class="chips" style="margin-bottom:var(--s-6)" aria-label="Presets">
      <a class="chip" href="${browseHref({ min: "8", count: "3", few: "1", sort: "rated" })}">Hidden gems</a>
      <a class="chip" href="${browseHref({ divisive: "1", sort: "divisive" })}">Divisive</a>
      <a class="chip" href="${browseHref({ count: "3", sort: "rated" })}">Highest rated</a>
      <a class="chip" href="/surprise">Surprise me</a></div>
    <form class="filters__grid filters__grid--browse" id="bfilters" novalidate>
      <label class="field"><span class="field__label">Genre</span><select class="select" data-b="genre"><option value="">Any genre</option>${GENRES.map((g) => opt(g.slug, g.name, f.genre)).join("")}</select></label>
      <label class="field"><span class="field__label">Decade</span><select class="select" data-b="decade"><option value="">Any decade</option>${DECADES.map((d) => opt(d.start, `${d.start}s`, f.decade)).join("")}</select></label>
      <label class="field"><span class="field__label">Released from</span><input class="input" data-b="from" inputmode="numeric" maxlength="4" placeholder="Year" value="${esc(f.from || "")}" autocomplete="off"></label>
      <label class="field"><span class="field__label">Released to</span><input class="input" data-b="to" inputmode="numeric" maxlength="4" placeholder="Year" value="${esc(f.to || "")}" autocomplete="off"></label>
      <label class="field"><span class="field__label">Minimum average</span><select class="select" data-b="min">${opt("", "Any", f.min)}${[6, 7, 8, 9].map((n) => opt(n, `${n} or higher`, f.min)).join("")}</select></label>
      <label class="field"><span class="field__label">Minimum ratings</span><select class="select" data-b="count">${opt("", "Any", f.count)}${[1, 3, 5, 10, 25].map((n) => opt(n, `${n} or more`, f.count)).join("")}</select></label>
      <label class="field"><span class="field__label">Album type</span><select class="select" data-b="type"><option value="">Any type</option>
        ${Object.keys(BROWSE_TYPES).map((k) => opt(k, { studio: "Studio album", ep: "EP", single: "Single", compilation: "Compilation", live: "Live album", soundtrack: "Soundtrack" }[k], f.type)).join("")}</select></label>
      <label class="field"><span class="field__label">Sort by</span><select class="select" data-b="sort">${Object.entries(BROWSE_SORTS).map(([k, v]) => opt(k, v[0], f.sort || "rated")).join("")}</select></label>
      <label class="check"><input type="checkbox" data-b="few"${f.few ? " checked" : ""}><span>Few ratings only (20 or fewer)</span></label>
      <label class="check"><input type="checkbox" data-b="divisive"${f.divisive ? " checked" : ""}><span>Divisive only (${DIVISIVE_MIN}+ ratings, split opinions)</span></label>
      <button type="button" class="btn btn--ghost btn--sm" id="bClear">Clear filters</button>
    </form>
    <p class="t-meta" id="bCount" role="status" aria-live="polite" style="margin:var(--s-5) 0 var(--s-4)"></p>
    <div id="bres"></div>`;

  let seq = 0, offset = 0, total = 0;
  const read = () => { const g = {}; $$("#bfilters [data-b]").forEach((el) => { const v = el.type === "checkbox" ? (el.checked ? "1" : "") : el.value.trim(); if (v) g[el.dataset.b] = v; }); return g; };
  const note = (g) => g.type ? `<p class="t-meta" style="margin-top:var(--s-3)">Only albums with a recorded type are included when filtering by type.</p>` : "";
  async function run(append = false) {
    const mine = ++seq, el = $("#bres");
    const g = f; // current filters
    if (!append) { offset = 0; el.innerHTML = `${loadingLabel("Loading albums")}<div class="grid">${skCards(8)}</div>`; }
    if (!sb) { el.innerHTML = emptyState({ iconName: "disc", title: "Browsing is offline right now", compact: true }); return; }
    let q = sb.from("album_catalog").select("*", { count: "exact" });
    const gen = GENRES.find((x) => x.slug === g.genre);
    if (gen) q = q.overlaps("genres", gen.tags);
    const from = g.from || (g.decade ? decadeRange(g.decade).from : ""), to = g.to || (g.decade ? decadeRange(g.decade).to : "");
    if (from) q = q.gte("release_date", from);
    if (to) q = q.lt("release_date", String(+to + 1));
    if (g.min) q = q.gte("avg_score", +g.min);
    if (g.count) q = q.gte("rating_count", +g.count);
    if (g.few) q = q.lte("rating_count", 20).gte("rating_count", Math.max(+g.count || 0, 1));
    if (g.divisive) q = q.eq("is_divisive", true);
    if (g.type) { const t = BROWSE_TYPES[g.type]; q = t.includes("%") ? q.ilike("album_type", t) : q.eq("album_type", t); }
    const [col, asc] = [BROWSE_SORTS[g.sort || "rated"][1], BROWSE_SORTS[g.sort || "rated"][2]];
    q = q.order(col, { ascending: asc, nullsFirst: false }).order("rating_count", { ascending: false }).range(offset, offset + BROWSE_PAGE - 1);
    const { data, error, count } = await q;
    if (mine !== seq || !el.isConnected) return;
    if (error) { el.innerHTML = errorState({ title: "Couldn't load albums", body: "Check your connection and try again.", retry: () => run(false), compact: false }); return; }
    total = count ?? total;
    const cards = (data || []).map((r) => albumCard({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url },
      { score: r.rating_count ? r.avg_score : null, count: r.rating_count,
        meta: r.is_divisive ? "Divisive" : [year(r.release_date), r.rating_count ? plural(r.rating_count, "rating") : "Not rated yet"].filter(Boolean).join(" · ") })).join("");
    if (append) $("#bGrid").insertAdjacentHTML("beforeend", cards);
    else el.innerHTML = (data || []).length
      ? `<div class="grid" id="bGrid">${cards}</div><div id="bMore" style="margin-top:var(--s-6)"></div>${note(g)}`
      : emptyState({ iconName: "search", title: "No albums match these filters", body: "Loosen a filter, or clear them all. Browse only covers albums that people on Rotation have rated or saved; search finds anything in MusicBrainz.",
          actions: button("Clear filters", { id: "bEmptyClear" }) + button("Search instead", { href: "/search", iconName: "search" }), compact: true });
    $("#bEmptyClear")?.addEventListener("click", () => $("#bClear").click());
    offset += (data || []).length;
    $("#bCount").textContent = total ? `Showing ${Math.min(offset, total)} of ${total}` : "";
    const more = $("#bMore");
    if (more) { more.innerHTML = offset < total ? `<button type="button" class="btn" id="bShowMore"><span>Show more</span></button>` : ""; $("#bShowMore")?.addEventListener("click", () => run(true)); }
  }
  let t;
  const change = (e) => {
    const el = e.target.closest("[data-b]"); if (!el) return;
    if (el.dataset.b === "decade") { const r = decadeRange(el.value); $("[data-b=from]").value = r.from || ""; $("[data-b=to]").value = r.to || ""; }
    clearTimeout(t); t = setTimeout(() => { Object.keys(f).forEach((k) => delete f[k]); Object.assign(f, read()); history.replaceState(null, "", browseHref(f)); run(false); }, el.tagName === "INPUT" && el.type !== "checkbox" ? 450 : 0);
  };
  $("#bfilters").addEventListener("input", change);
  $("#bfilters").addEventListener("change", change);
  $("#bClear").onclick = () => { $$("#bfilters [data-b]").forEach((el) => { if (el.type === "checkbox") el.checked = false; else el.value = el.dataset.b === "sort" ? "rated" : ""; }); Object.keys(f).forEach((k) => delete f[k]); history.replaceState(null, "", "/browse"); run(false); };
  run(false);
}

/* ---------- Surprise me ---------- */
const MB_WINDOW = 500; // deepest result MusicBrainz will return for a search (offset + limit)
const seenKey = "rotation:surprise-seen";
const loadSeen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(seenKey) || "[]")); } catch { return new Set(); } };
const saveSeen = (s) => { try { sessionStorage.setItem(seenKey, JSON.stringify([...s].slice(-150))); } catch {} };
const cardKey = (c) => c.id || `${norm(c.title)}|${norm(c.artist)}`;
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

// Everything you've rated or saved in any way, so it can be excluded. Signed-out visitors have none.
async function ownedAlbums() {
  const ids = new Set(), keys = new Set();
  if (!sb || !user) return { ids, keys };
  const sets = await Promise.all(["ratings", "album_status", "list_items", "profile_pins"].map((t) => sb.from(t).select("album:albums(id,title,artist)").then((r) => r.data || []).catch(() => [])));
  sets.flat().forEach((r) => { if (r.album) { ids.add(r.album.id); keys.add(`${norm(r.album.title)}|${norm(r.album.artist)}`); } });
  return { ids, keys };
}
async function surpriseCandidates(f) {
  const out = [], gen = GENRES.find((g) => g.slug === f.genre), { from, to } = decadeRange(f.decade);
  // 1) Albums on Rotation
  if (sb) {
    let q = sb.from("album_catalog").select("*").limit(400);
    if (gen) q = q.overlaps("genres", gen.tags);
    if (from) q = q.gte("release_date", from).lt("release_date", String(+to + 1));
    if (f.min) q = q.gte("avg_score", +f.min);
    const { data } = await q;
    (data || []).forEach((r) => out.push({ id: r.album_id, title: r.title, artist: r.artist, art: r.cover_url, year: year(r.release_date), genres: r.genres || [], avg: r.avg_score, n: r.rating_count, source: "rotation" }));
  }
  // 2) This week's charts (they carry no release year or ratings, so only when those filters are off)
  if (!from && !f.min) {
    const charts = gen ? [gen] : [null, ...GENRES.slice().sort(() => Math.random() - 0.5).slice(0, 3)];
    const lists = await Promise.all(charts.map((g) => (g ? genreChart(g) : billboard("billboard-200")).then((c) => c.items.map((x) => ({ ...x, chartName: g ? g.name : "the Billboard 200" }))).catch(() => [])));
    lists.flat().filter((x) => !/\b(EP|Single)\b/i.test(x.title)).forEach((x) => out.push({ title: x.title, artist: x.artist, art: x.art, year: "", genres: gen ? [gen.name.toLowerCase()] : [], source: "chart", rank: x.rank, chartName: x.chartName }));
  }
  return out;
}
async function mbCandidates(f) {
  const gen = GENRES.find((g) => g.slug === f.genre), { from, to } = decadeRange(f.decade);
  const tag = gen ? gen.tags[0] : "";
  const q = albumQuery("", { type: "album", from: from || "1960", to: to || String(new Date().getFullYear()), genre: tag });
  const first = await mbSlow(`${MB}/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=1`);
  // MusicBrainz rejects any search page where offset + limit passes 500 (HTTP 400), so pick a random page inside that window
  const count = Math.min(first.count || 0, MB_WINDOW);
  if (!count) return [];
  const off = RL.randomPageOffset(count, 25);
  const page = await mbSlow(`${MB}/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=25&offset=${off}`);
  return dedupeGroups(page["release-groups"] || []).filter(isStudioAlbum).map((g) => ({ id: g.id, title: g.title, artist: artistName(g["artist-credit"]), art: coverUrl(g.id, 500),
    year: year(g["first-release-date"]), genres: (g.tags || []).slice(0, 3).map((t) => t.name), source: "musicbrainz", tag }));
}
const surpriseWhy = (c, f) => {
  const bits = [f.genre && GENRES.find((g) => g.slug === f.genre)?.name, f.decade && `${f.decade}s`, f.min && `average ${f.min}+`].filter(Boolean);
  const where = c.source === "rotation" ? `From Rotation's catalog. ${c.n ? `Rated ${c.avg}/10 by ${c.n === 1 ? "1 person" : c.n + " people"}.` : "Nobody has rated it yet."}`
    : c.source === "chart" ? `Charting this week: #${c.rank} on ${c.chartName}.`
    : `From the MusicBrainz catalog: a studio album${c.year ? ` from ${c.year}` : ""}${c.tag ? `, tagged ${c.tag}` : ""}.`;
  return `${where} Picked at random from albums you haven't rated or saved${bits.length ? `, matching ${bits.join(", ")}` : ""}.`;
};

async function renderSurprise() {
  document.title = "Surprise me · Rotation";
  const f = {}; try { Object.assign(f, JSON.parse(sessionStorage.getItem("rotation:surprise-filters") || "{}")); } catch {}
  const opt = (v, l, cur) => `<option value="${v}"${String(cur ?? "") === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  view().innerHTML = `<header class="page-head"><h1 class="t-page">Surprise me</h1>
    <p class="t-lead">A random album you haven't rated or saved${user ? "" : ". Sign in and we'll also skip everything you've rated, saved or listed"}. Narrow it down if you like.</p></header>
    <form class="filters__grid" id="sfilt" novalidate>
      <label class="field"><span class="field__label">Genre</span><select class="select" data-s="genre"><option value="">Any genre</option>${GENRES.map((g) => opt(g.slug, g.name, f.genre)).join("")}</select></label>
      <label class="field"><span class="field__label">Decade</span><select class="select" data-s="decade"><option value="">Any decade</option>${DECADES.map((d) => opt(d.start, `${d.start}s`, f.decade)).join("")}</select></label>
      <label class="field"><span class="field__label">Community rating</span><select class="select" data-s="min"><option value="">Any (including unrated)</option>${[6, 7, 8].map((n) => opt(n, `${n} or higher`, f.min)).join("")}</select></label>
      <button type="submit" class="btn btn--primary" id="spin">${icon("spark")}<span>Surprise me</span></button>
    </form>
    <div id="sresult" style="margin-top:var(--s-8)" aria-live="polite"></div>`;
  const read = () => { const g = {}; $$("#sfilt [data-s]").forEach((el) => { if (el.value) g[el.dataset.s] = el.value; }); return g; };
  let busy = false;
  async function spin() {
    if (busy) return;
    busy = true;
    const g = read(); try { sessionStorage.setItem("rotation:surprise-filters", JSON.stringify(g)); } catch {}
    const out = $("#sresult"), btn = $("#spin");
    btn.setAttribute("aria-busy", "true");
    out.innerHTML = `${loadingLabel("Finding an album")}<div class="surprise"><div class="sk art"></div><div style="display:grid;gap:12px;align-content:start"><div class="sk sk-line" style="height:36px;width:60%"></div><div class="sk sk-line" style="width:40%"></div></div></div>`;
    try {
      const [owned, base] = await Promise.all([ownedAlbums(), surpriseCandidates(g)]);
      const seen = loadSeen();
      const usable = (c) => !(c.id && owned.ids.has(c.id)) && !owned.keys.has(`${norm(c.title)}|${norm(c.artist)}`);
      let pool = base.filter(usable), fresh = pool.filter((c) => !seen.has(cardKey(c))), repeated = false;
      if (!fresh.length && !g.min) {
        // nothing local is new: pull a random page from the real MusicBrainz catalog
        let mbFailed = false;
        const mb = (await mbCandidates(g).catch(() => { mbFailed = true; return []; })).filter((c) => usable(c) && !seen.has(cardKey(c)));
        if (mb.length) fresh = mb;
        else if (mbFailed && !pool.length) throw new Error("catalog busy"); // say so instead of claiming nothing matches
      }
      if (!fresh.length && pool.length) { repeated = true; seen.clear(); fresh = pool; }
      if (!fresh.length) {
        out.innerHTML = emptyState({ iconName: "disc", compact: true, title: "Nothing new matches", body: g.min ? "No unrated albums have a community average that high. Try a lower rating, or any genre or decade." : "You've rated or saved everything we found for these filters. Try different ones." });
        return;
      }
      const c = pickOne(fresh);
      seen.add(cardKey(c)); saveSeen(seen);
      const href = c.id ? `/album/${c.id}` : `/find/${encodeURIComponent(c.artist)}/${encodeURIComponent(c.title)}`;
      out.innerHTML = `<article class="surprise">
        <a class="surprise__art" href="${href}">${artwork(c.art, `${c.title} by ${c.artist}`)}</a>
        <div class="surprise__body">
          <h2 class="t-title">${esc(c.title)}</h2><p class="album__artist">${esc(c.artist)}</p>
          <div class="album__facts">${[c.year, c.n ? `${c.avg}/10 from ${plural(c.n, "rating")}` : ""].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('<span class="dot" aria-hidden="true"></span>')}</div>
          ${c.genres?.length ? `<div class="chips">${c.genres.slice(0, 4).map((n) => `<span class="chip chip--static">${esc(n)}</span>`).join("")}</div>` : ""}
          <p class="text-2" style="font-size:var(--fs-sm)">${esc(surpriseWhy(c, g))}${repeated ? " You've now seen every match, so this one repeats." : ""}</p>
          <div class="album__actions">${button("Open album", { variant: "primary", href, iconName: "disc" })}<button type="button" class="btn" id="again">${icon("refresh")}<span>Another one</span></button></div>
        </div></article>`;
      $("#again").onclick = spin;
    } catch {
      out.innerHTML = errorState({ title: "Couldn't find an album", body: "A data source may be busy. Try again in a moment.", retry: spin, compact: true });
    } finally { busy = false; btn.removeAttribute("aria-busy"); }
  }
  $("#sfilt").addEventListener("submit", (e) => { e.preventDefault(); spin(); });
  spin();
}

/* ==========================================================================
   Taste comparison and Year in Rotation
   Both are computed in the browser from ratings the viewer is allowed to see (see lib.js).
   ========================================================================== */
const thisYear = () => new Date().getFullYear();

// One person's ratings in a common shape. Your own come from your tables; anyone else's from the public views,
// and only when their profile is public and shows ratings.
async function ratingsOf(username) {
  if (username === "me" || (profile && profile.username === username)) {
    const rows = await myRatings("score, thoughts, is_public, credit_profile, updated_at, created_at, album:albums(id,title,artist,cover_url,genres)");
    return { self: true, username: profile?.username || null, name: username === "me" && !profile ? "You" : (profile?.display_name || profile?.username || "You"), avatar: profile ? { ...profile } : { display_name: "You" },
      available: true, rows: rows.map((r) => ({ album_id: r.album.id, title: r.album.title, artist: r.album.artist, cover_url: r.album.cover_url, genres: r.album.genres || [], score: r.score,
        first_rated_at: r.created_at, thoughts: r.thoughts, shared: !!(r.is_public && r.credit_profile && r.thoughts?.trim()), updated_at: r.updated_at })) };
  }
  const { data: p } = await sb.from("public_profiles").select("*").eq("username", username).maybeSingle();
  if (!p) return { self: false, username, available: false, reason: "missing", rows: [] };
  if (!p.show_ratings) return { self: false, username, name: p.display_name || p.username, avatar: p, available: false, reason: "private", rows: [] };
  const { data } = await sb.from("public_ratings").select("*").eq("username", username).limit(1000);
  return { self: false, username, name: p.display_name || p.username, avatar: p, available: true,
    rows: (data || []).map((r) => ({ album_id: r.album_id, title: r.title, artist: r.artist, cover_url: r.cover_url, genres: r.genres || [], score: r.score, first_rated_at: r.first_rated_at || r.rated_at, shared: r.has_review })) };
}

/* ---------- Taste comparison ---------- */
async function renderCompare(aName, bName) {
  document.title = "Compare tastes · Rotation";
  if (!sb || (!bName && !user)) {
    view().innerHTML = emptyState({ iconName: "user", title: "Sign in to compare tastes", body: "Comparing uses the albums you've both rated.", actions: button("Sign in", { variant: "primary", id: "cmpSignIn" }) });
    $("#cmpSignIn")?.addEventListener("click", openAuth);
    return;
  }
  view().innerHTML = `${loadingLabel("Comparing tastes")}<header class="page-head"><div class="sk sk-line" style="height:36px;width:50%"></div></header>${skList(4)}`;
  const first = bName ? aName : "me", second = bName || aName;
  let A, B;
  try { [A, B] = await Promise.all([ratingsOf(first), ratingsOf(second)]); }
  catch { view().innerHTML = errorState({ title: "Couldn't load the comparison", retry: () => renderCompare(aName, bName), compact: false }); return; }
  for (const P of [A, B]) if (!P.available) {
    view().innerHTML = emptyState({ iconName: "user", compact: false, title: P.reason === "private" ? `${P.name} keeps their ratings private` : "Profile not found",
      body: P.reason === "private" ? "Taste comparison only works with people who show their ratings." : "This profile doesn't exist, or its owner keeps it private.", actions: button("Go home", { variant: "primary", href: "/" }) });
    return;
  }
  if (A.self && B.self) { view().innerHTML = emptyState({ iconName: "user", title: "That's you twice", body: "Pick someone else to compare with.", compact: false }); return; }
  const c = RL.compareTaste(A.rows, B.rows);
  const nameA = A.self ? "You" : A.name, nameB = B.self ? "You" : B.name;
  document.title = `${nameA} and ${nameB} · Compare tastes · Rotation`;
  const pair = (s) => `${nameA}: ${s.a} · ${nameB}: ${s.b}`;
  const tileOf = (s) => tile({ href: `/album/${s.album_id}`, art: s.cover_url, title: s.title, artist: s.artist, note: pair(s) });
  const link = (P) => (P.username ? `<a class="textlink" href="${profileHref(P.username)}">${esc(P.self ? "You" : P.name)}</a>` : esc(P.name));

  view().innerHTML = `
    <header class="page-head"><p class="t-meta">Taste comparison</p><h1 class="t-title">${link(A)} and ${link(B)}</h1>
      <p class="t-lead">Compares the albums you've both rated on Rotation. It says nothing about what either of you has heard but not rated.</p></header>
    <section class="panel" aria-labelledby="cmp-h"><h2 class="t-section" id="cmp-h">The numbers</h2>
      <dl class="profile__stats">
        <div class="stat"><dt class="stat__label">Albums you both rated</dt><dd class="stat__value" style="margin:0">${c.n}</dd></div>
        ${c.n ? `<div class="stat"><dt class="stat__label">Average gap</dt><dd class="stat__value" style="margin:0">${c.avgGap} pts</dd></div>
        <div class="stat"><dt class="stat__label">${esc(nameA)} averaged</dt><dd class="stat__value" style="margin:0">${c.avgA}</dd></div>
        <div class="stat"><dt class="stat__label">${esc(nameB)} averaged</dt><dd class="stat__value" style="margin:0">${c.avgB}</dd></div>` : ""}
        ${c.enough ? `<div class="stat"><dt class="stat__label">Rough similarity</dt><dd class="stat__value" style="margin:0">${c.similarity}%</dd></div>` : ""}
      </dl>
      <p class="t-meta">${c.enough ? `Based on ${plural(c.n, "shared rating")}. Similarity is 100% minus the average gap as a share of a 9-point swing. A rough guide, not a verdict.`
        : c.n ? `Only ${plural(c.n, "shared rating")} so far. A similarity percentage needs ${c.needed}, so none is shown. The albums below are still real.`
        : "You haven't rated any of the same albums yet, so there's nothing to compare."}</p></section>
    ${c.love.length ? `<section class="section" style="margin-top:var(--s-10)">${sectionHead("Albums you both love", { sub: "Both scored 8 or higher" })}<div class="tiles">${c.love.map(tileOf).join("")}</div></section>` : ""}
    ${c.differ.length ? `<section class="section">${sectionHead("Where you differ", { sub: "Scores 4 or more points apart, biggest gap first" })}<div class="tiles">${c.differ.map(tileOf).join("")}</div></section>` : ""}
    <section class="section">${sectionHead("Genres", { sub: c.genres.sufficient ? "Each person's most-rated genres" : "" })}
      ${c.genres.sufficient ? (c.genres.shared.length ? `<p class="text-2" style="font-size:var(--fs-sm);margin-bottom:var(--s-3)">You both rate a lot of:</p><div class="chips">${c.genres.shared.map((g) => `<span class="chip chip--static">${esc(g)}</span>`).join("")}</div>`
          : `<p class="text-2" style="font-size:var(--fs-sm)">No overlap in your five most-rated genres. ${esc(nameA)}: ${esc(c.genres.topA.join(", "))}. ${esc(nameB)}: ${esc(c.genres.topB.join(", "))}.</p>`)
        : `<p class="text-2" style="font-size:var(--fs-sm)">Genre overlap needs ${c.genres.needed}+ rated albums with genre data each. ${esc(nameA)} has ${c.genres.a}, ${esc(nameB)} has ${c.genres.b}.</p>`}</section>
    ${c.n ? `<section class="section">${sectionHead(c.n === 1 ? "Your shared album" : `All ${c.n} shared albums`)}<div class="tiles">${c.shared.map(tileOf).join("")}</div></section>` : ""}`;
}

/* ---------- Year in Rotation ---------- */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
async function catalogCounts(ids) {
  const counts = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const { data } = await sb.from("album_catalog").select("album_id, rating_count").in("album_id", ids.slice(i, i + 80));
    (data || []).forEach((r) => counts.set(r.album_id, r.rating_count));
  }
  return counts;
}
async function renderRecap(username, yearArg) {
  const own = !username || (profile && profile.username === username);
  if (!sb || (own && !user)) {
    view().innerHTML = emptyState({ iconName: "user", title: "Sign in to see your year", body: "Year in Rotation summarizes the albums you rated.", actions: button("Sign in", { variant: "primary", id: "yrSignIn" }) });
    $("#yrSignIn")?.addEventListener("click", openAuth);
    return;
  }
  view().innerHTML = `${loadingLabel("Building the recap")}<div class="recap"><div class="sk" style="height:220px;border-radius:var(--r-lg)"></div></div>`;
  let P, reviews = [];
  try {
    P = await ratingsOf(own ? "me" : username);
    if (P.available) {
      reviews = P.self ? P.rows.filter((r) => r.shared).map((r) => ({ ...r, body: r.thoughts, when: r.updated_at }))
        : ((await sb.from("public_reviews").select("*").eq("username", username).limit(200)).data || []).map((r) => ({ album_id: r.album_id, title: r.title, artist: r.artist, cover_url: r.cover_url, score: r.score, body: r.body, when: r.updated_at }));
    }
  } catch { view().innerHTML = errorState({ title: "Couldn't build the recap", retry: () => renderRecap(username, yearArg), compact: false }); return; }
  if (!P.available) {
    view().innerHTML = emptyState({ iconName: "user", compact: false, title: P.reason === "private" ? "This recap isn't shared" : "Profile not found",
      body: P.reason === "private" ? `${P.name} keeps their ratings private.` : "This profile doesn't exist, or its owner keeps it private.", actions: button("Go home", { variant: "primary", href: "/" }) });
    return;
  }
  const years = RL.yearsWithRatings(P.rows), year = +yearArg || +years[0] || thisYear();
  const counts = await catalogCounts([...new Set(P.rows.filter((r) => String(r.first_rated_at).startsWith(String(year))).map((r) => r.album_id))]).catch(() => new Map());
  const r = RL.recapOf(P.rows, year, counts);
  const handle = P.username ? `@${P.username}` : "You";
  const who = P.self ? "You" : P.name;
  const yearReviews = reviews.filter((x) => String(x.when).startsWith(String(year))).sort((a, b) => String(b.body).length - String(a.body).length).slice(0, 3);
  document.title = `${who === "You" ? "Your" : who + "'s"} ${year} in Rotation`;
  const base = P.username ? `/u/${P.username}/year/` : `/year/`;
  const maxN = Math.max(...r.byMonth.map((m) => m.n), 1);
  const shareUrl = P.username ? `${location.origin}/u/${P.username}/year/${year}` : "";

  view().innerHTML = `
    <article class="recap" aria-labelledby="recap-h">
      <header class="recap__hero">
        <p class="recap__eyebrow">Year in Rotation · ${esc(handle)}</p>
        <h1 class="recap__year" id="recap-h">${year}</h1>
        ${r.n ? `<p class="recap__lead">${who === "You" ? "You" : esc(who)} rated <strong>${r.n}</strong> ${r.n === 1 ? "album" : "albums"}${r.avg != null ? `, averaging <strong>${r.avg}</strong> out of 10` : ""}.</p>`
          : `<p class="recap__lead">No albums rated in ${year}.</p>`}
        <div class="chips" aria-label="Years">${[...new Set([...years, String(thisYear())])].sort().reverse().map((y) => `<a class="chip" href="${base}${y}"${+y === year ? ' aria-current="page"' : ""}>${y}</a>`).join("")}</div>
        <div class="chips">${r.n ? `<button type="button" class="btn btn--sm btn--primary" id="dlRecap">${icon("share")}<span>Download image</span></button>` : ""}${shareUrl ? button("Share link", { size: "sm", id: "shareRecap", iconName: "share" }) : ""}</div>
        ${P.self && !profile?.is_public ? `<p class="t-meta">Only you can open this link. Make your profile public with ratings shown to share it.</p>` : ""}
      </header>
      ${r.n ? `
      <section class="section" aria-labelledby="mo-h"><h2 class="t-section" id="mo-h">Rating rhythm</h2>
        <div class="months" role="img" aria-label="Albums rated per month: ${r.byMonth.map((m) => `${MONTHS[m.month - 1]} ${m.n}`).join(", ")}">${r.byMonth.map((m) => `
          <div class="months__col" title="${MONTHS[m.month - 1]}: ${plural(m.n, "album")}${m.avg != null ? `, averaging ${m.avg}` : ""}"><span class="dist__n">${m.n || ""}</span><span class="dist__track"><span class="dist__bar" style="height:${m.n ? Math.max(6, Math.round((m.n / maxN) * 100)) : 2}%"></span></span><span class="dist__label">${MONTHS[m.month - 1][0]}</span></div>`).join("")}</div>
        <p class="t-meta">${r.busiestMonth ? `Busiest month: ${MONTHS[r.busiestMonth - 1]}. ` : ""}${r.trend ? `Your scores ${r.trend.direction === "steady" ? "stayed steady" : r.trend.direction === "up" ? "rose" : "fell"} through the year: ${r.trend.first} average for the first half, ${r.trend.second} for the second.` : "A trend needs 10 or more ratings in the year."}</p></section>
      ${r.topRated.length ? `<section class="section">${sectionHead("Highest rated", { sub: "Your best scores this year" })}<div class="tiles">${r.topRated.map((x) => tile({ href: `/album/${x.album_id}`, art: x.cover_url, title: x.title, artist: x.artist, score: x.score, mine: P.self })).join("")}</div></section>` : ""}
      ${r.discoveries.length ? `<section class="section">${sectionHead("Highest rated, least heard", { sub: "Albums you scored 8+ that 10 or fewer people on Rotation have rated" })}<div class="tiles">${r.discoveries.map((x) => tile({ href: `/album/${x.album_id}`, art: x.cover_url, title: x.title, artist: x.artist, score: x.score, mine: P.self, note: plural(counts.get(x.album_id) || 0, "rating") + " on Rotation" })).join("")}</div></section>` : ""}
      ${r.mostRated.length ? `<section class="section">${sectionHead("Most-rated albums you rated", { sub: "The albums you rated that the most people on Rotation have rated" })}<div class="tiles">${r.mostRated.map((x) => tile({ href: `/album/${x.album_id}`, art: x.cover_url, title: x.title, artist: x.artist, score: x.score, mine: P.self, note: plural(x.community_count, "rating") })).join("")}</div></section>` : ""}
      ${r.genres.length || r.artists.length ? `<section class="section">${sectionHead("Favorite genres and artists", { sub: "Genres and artists with 2+ albums rated this year" })}
        ${r.genres.length ? `<div class="chips">${r.genres.map((g) => `<span class="chip chip--static">${esc(g.name)} · ${plural(g.n, "album")}, avg ${g.avg}</span>`).join("")}</div>` : ""}
        ${r.artists.length ? `<div class="chips" style="margin-top:var(--s-3)">${r.artists.map((a) => `<span class="chip chip--static">${icon("user")}${esc(a.name)} · ${plural(a.n, "album")}, avg ${a.avg}</span>`).join("")}</div>` : ""}</section>` : ""}
      ${yearReviews.length ? `<section class="section">${sectionHead("Memorable reviews", { sub: "Reviews shared publicly this year" })}<div class="reviews">${yearReviews.map((x) => `<article class="review-card"><header class="review-card__head">${artwork(smallArt(x.cover_url), x.title, "thumb")}
        <span class="review-card__who"><a href="/album/${x.album_id}"><strong>${esc(x.title)}</strong></a><span class="t-meta">${esc(x.artist || "")}</span></span>${scoreChip(x.score, { mine: P.self })}</header><p class="review-card__body">${esc(x.body)}</p></article>`).join("")}</div></section>` : ""}` : emptyState({ iconName: "disc", compact: true, title: `Nothing rated in ${year}`, body: P.self ? "Rate an album and it will show up in your recap." : "Check another year." })}
      <footer class="recap__note"><h2 class="t-label">What this measures</h2>
        <p>Albums ${esc(who === "You" ? "you" : who)} rated on Rotation in ${year}, counted by the day each was first rated. Rotation doesn't track what anyone listens to, so this is not listening time, play counts or an all-time ranking. Only real ratings are used; genres come from MusicBrainz tags.</p></footer>
    </article>`;

  $("#shareRecap")?.addEventListener("click", async () => {
    const data = { title: `${who === "You" ? "My" : who + "'s"} ${year} in Rotation`, url: shareUrl };
    if (P.self && !profile?.is_public) return toast("Make your profile public to share this recap.", "info");
    if (navigator.share) { try { await navigator.share(data); } catch {} return; }
    try { await navigator.clipboard.writeText(shareUrl); toast("Link copied"); } catch { toast("Copy the link from your address bar", "info"); }
  });
  $("#dlRecap")?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.setAttribute("aria-busy", "true");
    try { await exportRecapImage(r, handle, who); toast("Image downloaded"); } catch { toast("Couldn't create the image in this browser", "error"); }
    b.removeAttribute("aria-busy");
  });
}

// A shareable PNG drawn on a canvas from the same numbers. It is text and charts only: album artwork belongs to its
// rights holders and is only shown inside the app, so it is never copied into an exported file.
async function exportRecapImage(r, handle, who) {
  try { await document.fonts?.ready; } catch {}
  const W = 1080, H = 1350, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d"), css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const bg = css("--bg"), surf = css("--surface-1"), text = css("--text"), t2 = css("--text-2"), t3 = css("--text-3"), accent = css("--accent"), line = css("--border-strong");
  const serif = `"Newsreader", Georgia, serif`, sans = `"Geist", "Segoe UI", sans-serif`;
  const clip = (s, max) => { s = String(s); if (g.measureText(s).width <= max) return s; while (s.length > 1 && g.measureText(s + "…").width > max) s = s.slice(0, -1); return s + "…"; };
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.strokeStyle = line; g.lineWidth = 2; g.strokeRect(40, 40, W - 80, H - 80);
  g.fillStyle = t3; g.font = `500 28px ${sans}`; g.fillText(`YEAR IN ROTATION  ·  ${handle}`.toUpperCase(), 90, 120);
  g.fillStyle = accent; g.font = `500 280px ${serif}`; g.fillText(String(r.year), 82, 360);
  g.fillStyle = text; g.font = `500 54px ${serif}`;
  g.fillText(clip(`${who === "You" ? "I" : who} rated ${r.n} ${r.n === 1 ? "album" : "albums"}${r.avg != null ? `, averaging ${r.avg}` : ""}`, W - 180), 90, 450);
  // monthly bars
  const bx = 90, bw = (W - 180) / 12, top = 520, bh = 170, max = Math.max(...r.byMonth.map((m) => m.n), 1);
  r.byMonth.forEach((m, i) => { const h = m.n ? Math.max(8, (m.n / max) * bh) : 3; g.fillStyle = m.n ? accent : line; g.fillRect(bx + i * bw + 8, top + bh - h, bw - 16, h);
    g.fillStyle = t3; g.font = `500 22px ${sans}`; g.textAlign = "center"; g.fillText(MONTHS[i][0], bx + i * bw + bw / 2, top + bh + 34); if (m.n) g.fillText(String(m.n), bx + i * bw + bw / 2, top + bh - h - 10); g.textAlign = "left"; });
  let y = top + bh + 110;
  const list = (title, items, fmt) => { if (!items.length) return; g.fillStyle = t3; g.font = `500 24px ${sans}`; g.fillText(title.toUpperCase(), 90, y); y += 48;
    items.slice(0, 4).forEach((it) => { g.fillStyle = text; g.font = `500 36px ${sans}`; g.fillText(clip(fmt(it).left, W - 330), 90, y); g.fillStyle = accent; g.font = `500 36px ${serif}`; g.textAlign = "right"; g.fillText(fmt(it).right, W - 90, y); g.textAlign = "left"; y += 52; }); y += 28; };
  list("Highest rated", r.topRated, (x) => ({ left: `${x.title} · ${x.artist}`, right: `${x.score}/10` }));
  list("Favorite genres", r.genres.slice(0, 3), (x) => ({ left: x.name, right: `${x.n} albums` }));
  list("Favorite artists", r.artists.slice(0, 3), (x) => ({ left: x.name, right: `avg ${x.avg}` }));
  g.fillStyle = t3; g.font = `400 24px ${sans}`;
  g.fillText("Based on albums rated on Rotation. Not listening time.", 90, H - 90);
  g.textAlign = "right"; g.fillStyle = t2; g.font = `500 30px ${serif}`; g.fillText("Rotation", W - 90, H - 88); g.textAlign = "left";
  const blob = await new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("no blob"))), "image/png"));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `year-in-rotation-${r.year}.png`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ==========================================================================
   Stats dashboard (/stats): listening diary heatmap, decades, genres, top artists, picks.
   Everything is computed from the viewer's own ratings (see RL.statsOf). The diary counts the day each album was first
   rated, not listening time. Signed-out visitors can open /stats/sample, a clearly labeled demo made of fake data.
   ========================================================================== */
const SAMPLE_POOL = [
  ["Nevermind", "Nirvana", ["grunge", "rock"], "1991-09-24"], ["OK Computer", "Radiohead", ["alternative rock", "art rock"], "1997-05-21"], ["Blue", "Joni Mitchell", ["folk", "singer-songwriter"], "1971-06-22"],
  ["Kind of Blue", "Miles Davis", ["jazz"], "1959-08-17"], ["Purple Rain", "Prince", ["pop", "funk"], "1984-06-25"], ["Rumours", "Fleetwood Mac", ["rock", "pop"], "1977-02-04"],
  ["To Pimp a Butterfly", "Kendrick Lamar", ["hip hop"], "2015-03-15"], ["Currents", "Tame Impala", ["psychedelic pop", "pop"], "2015-07-17"], ["Illmatic", "Nas", ["hip hop"], "1994-04-19"],
  ["Remain in Light", "Talking Heads", ["new wave", "art rock"], "1980-10-08"], ["Random Access Memories", "Daft Punk", ["electronic", "disco"], "2013-05-17"], ["The Dark Side of the Moon", "Pink Floyd", ["progressive rock", "rock"], "1973-03-01"],
  ["Is This It", "The Strokes", ["indie rock", "rock"], "2001-07-30"], ["Lemonade", "Beyoncé", ["r&b", "pop"], "2016-04-23"], ["Hunky Dory", "David Bowie", ["rock", "art rock"], "1971-12-17"],
  ["Gold", "Ryan Adams", ["rock", "folk"], "2001-09-25"], ["Discovery", "Daft Punk", ["electronic", "house"], "2001-03-12"], ["Abbey Road", "The Beatles", ["rock", "pop"], "1969-09-26"],
  ["Pet Sounds", "The Beach Boys", ["pop", "psychedelic pop"], "1966-05-16"], ["In Rainbows", "Radiohead", ["alternative rock", "art rock"], "2007-10-10"], ["Brothers", "The Black Keys", ["blues rock", "rock"], "2010-05-18"],
  ["Mezzanine", "Massive Attack", ["trip hop", "electronic"], "1998-04-20"], ["Madvillainy", "Madvillain", ["hip hop"], "2004-03-23"], ["Sound of Silver", "LCD Soundsystem", ["electronic", "indie rock"], "2007-03-12"],
];
function sampleRows(today = new Date()) {
  let s = 20260; const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rows = [];
  for (let back = 0; back < 360; back++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const busy = rnd() < (d.getDay() === 0 || d.getDay() === 6 ? 0.34 : 0.18);   // weekends are heavier
    if (!busy) continue;
    const n = rnd() < 0.8 ? 1 : rnd() < 0.7 ? 2 : 3;
    for (let k = 0; k < n; k++) {
      const a = SAMPLE_POOL[Math.floor(rnd() * SAMPLE_POOL.length)];
      rows.push({ album_id: `sample-${rows.length}`, title: a[0], artist: a[1], genres: a[2], release_date: a[3], cover_url: null, score: 5 + Math.floor(rnd() * 6),
        first_rated_at: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T12:00:00Z` });
    }
  }
  return rows;
}
const SAMPLE_RECS = [
  { title: "Loveless", artist: "My Bloody Valentine", why: "Because you rated Nevermind 9/10" }, { title: "Kid A", artist: "Radiohead", why: "Because you rated OK Computer 10/10" },
  { title: "Court and Spark", artist: "Joni Mitchell", why: "Because you rated Blue 9/10" }, { title: "A Love Supreme", artist: "John Coltrane", why: "Because you rated Kind of Blue 10/10" },
  { title: "Sign o' the Times", artist: "Prince", why: "You rate Prince 9 on average" }, { title: "Fetch the Bolt Cutters", artist: "Fiona Apple", why: "Because you rated Lemonade 8/10" },
];
const DONUT_COLORS = ["var(--accent)", "var(--success)", "var(--warning)", "var(--text-2)", "var(--text-3)"];

function heatmapHTML(h) {
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let lastMonth = -1;
  const labels = h.weeks.map((col, wi) => {
    const first = col.find(Boolean); if (!first) return "";
    const m = +first.date.slice(5, 7) - 1;
    if (m === lastMonth) return ""; lastMonth = m;
    return wi + 3 > h.weeks.length ? "" : `<span class="heat__month" style="grid-column:${wi + 2}">${MONTHS[m]}</span>`;
  }).join("");
  const cells = h.weeks.map((col, wi) => col.map((c, di) => !c ? "" :
    `<span class="heat__cell" data-l="${RL.heatLevel(c.n, h.max)}" data-date="${c.date}" data-n="${c.n}" style="grid-column:${wi + 2};grid-row:${di + 2}"></span>`).join("")).join("");
  const days = [1, 3, 5].map((d) => `<span class="heat__day" style="grid-row:${d + 2}">${dayName[d]}</span>`).join("");
  return `<div class="heat__scroll" id="heatScroll"><div class="heat" id="heat" tabindex="0" role="group" aria-describedby="heatSum" style="--cols:${h.weeks.length}">${labels}${days}${cells}</div></div>
    <p class="sr" id="heatLive" role="status" aria-live="polite"></p><div class="heat__tip" id="heatTip" role="presentation" hidden></div>`;
}
function wireHeatmap(prefix) {
  const heat = $("#heat"), tip = $("#heatTip"), live = $("#heatLive");
  if (!heat) return;
  $("#heatScroll").scrollLeft = 99999;   // newest weeks first on small screens
  const cells = () => $$(".heat__cell", heat);
  const label = (c) => `${fmtDate(c.dataset.date)}: ${c.dataset.n === "0" ? "no albums" : plural(+c.dataset.n, "album")} ${prefix}`;
  const show = (c) => {
    tip.textContent = label(c); tip.hidden = false;
    const r = c.getBoundingClientRect(), t = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2)) + "px";
    tip.style.top = (r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8) + "px";
  };
  const hide = () => { tip.hidden = true; };
  heat.addEventListener("pointerover", (e) => { const c = e.target.closest(".heat__cell"); if (c) show(c); else hide(); });
  heat.addEventListener("pointerleave", hide);
  heat.addEventListener("click", (e) => { const c = e.target.closest(".heat__cell"); if (c) show(c); });
  $("#heatScroll").addEventListener("scroll", hide, { passive: true });
  // Keyboard: arrows move through days, the tooltip text is announced
  let at = null;
  heat.addEventListener("keydown", (e) => {
    const all = cells(); if (!all.length) return;
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1, Home: -1e9, End: 1e9 }[e.key];
    if (step == null) return;
    e.preventDefault();
    at = Math.max(0, Math.min(all.length - 1, (at == null ? all.length - 1 : at) + step));
    $$(".heat__cell.is-active", heat).forEach((x) => x.classList.remove("is-active"));
    const c = all[at]; c.classList.add("is-active"); c.scrollIntoView({ block: "nearest", inline: "center" }); show(c); live.textContent = label(c);
  });
  heat.addEventListener("blur", () => { hide(); $$(".heat__cell.is-active", heat).forEach((x) => x.classList.remove("is-active")); at = null; });
}
function donutHTML(genres, withGenre) {
  if (!genres.length) return `<p class="t-meta">No genre data yet. Genres come from MusicBrainz tags, and some albums have none.</p>`;
  let off = 25;   // start at 12 o'clock
  const total = genres.reduce((s, g) => s + g.share, 0) || 1;
  const arcs = genres.map((g, i) => { const len = (g.share / total) * 100, el = `<circle class="donut__arc" cx="21" cy="21" r="15.9155" fill="none" stroke="${DONUT_COLORS[i]}" stroke-width="5.5" stroke-dasharray="${Math.max(0, len - 0.8)} ${100 - Math.max(0, len - 0.8)}" stroke-dashoffset="${off}"/>`; off -= len; return el; }).join("");
  return `<div class="donut"><svg viewBox="0 0 42 42" class="donut__svg" role="img" aria-label="Top genres: ${genres.map((g) => `${esc(g.name)} ${g.share}%`).join(", ")}"><circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--surface-3)" stroke-width="5.5"/>${arcs}
      <text x="21" y="20.5" text-anchor="middle" class="donut__num">${withGenre}</text><text x="21" y="26" text-anchor="middle" class="donut__cap">albums</text></svg>
    <ul class="donut__legend">${genres.map((g, i) => `<li><span class="donut__dot" style="background:${DONUT_COLORS[i]}" aria-hidden="true"></span><span class="donut__name">${esc(g.name)}</span><span class="t-meta">${g.share}% · ${g.n}</span></li>`).join("")}</ul></div>`;
}
function decadesHTML(ds) {
  if (!ds.length) return `<p class="t-meta">No release dates yet for your rated albums.</p>`;
  const max = Math.max(...ds.map((d) => d.n), 1);
  return `<div class="decbars" style="--n:${ds.length}" role="img" aria-label="Albums by release decade: ${ds.map((d) => `${d.label} ${d.n}`).join(", ")}">${ds.map((d) => `
    <div class="decbars__col" title="${d.label}: ${plural(d.n, "album")}"><span class="dist__n">${d.n}</span><span class="dist__track"><span class="dist__bar" style="height:${Math.max(4, Math.round((d.n / max) * 100))}%"></span></span><span class="dist__label">${d.label}</span></div>`).join("")}</div>`;
}

async function renderStats(sampleMode) {
  const demo = sampleMode || !user;
  setPageMeta(demo ? "Sample stats · Rotation" : "Your stats · Rotation", "Your listening diary, decades, genres and favorite artists on Rotation.");
  if (!sb && !demo) { view().innerHTML = errorState({ title: "Stats aren't available", compact: false }); return; }
  view().innerHTML = `${loadingLabel("Loading your stats")}<header class="page-head"><div class="sk sk-line" style="height:36px;width:40%"></div></header><div class="sk" style="height:200px;border-radius:var(--r-lg)"></div>`;
  let rows, ratings = [];
  const today = new Date();
  try {
    if (demo) rows = sampleRows(today);
    else {
      ratings = await myRatings();
      rows = ratings.map((r) => ({ album_id: r.album.id, title: r.album.title, artist: r.album.artist, cover_url: r.album.cover_url, genres: r.album.genres || [], release_date: r.album.release_date, score: r.score, first_rated_at: r.created_at }));
    }
  } catch { view().innerHTML = errorState({ title: "Couldn't load your stats", retry: () => renderStats(sampleMode), compact: false }); return; }
  if (!rows.length) {
    view().innerHTML = emptyState({ iconName: "disc", compact: false, title: "Nothing to chart yet", body: "Rate a few albums and your diary, decades and genres appear here.",
      actions: `${button("Find an album", { variant: "primary", href: "/search", iconName: "search" })}${button("See a sample", { href: "/stats/sample" })}` });
    return;
  }
  const S = RL.statsOf(rows, today), h = S.heat;
  const sampleBanner = demo ? `<p class="stats__sample" role="note"><strong>Sample data.</strong> These numbers are made up to show the layout. ${user ? button("See your own stats", { size: "sm", href: "/stats" }) : `<a class="textlink" href="/stats" id="statsSignIn">Sign in</a> to see yours.`}</p>` : "";
  view().innerHTML = `
    <div class="stats">
    <header class="page-head"><p class="t-meta">${demo ? "Sample preview" : "Your stats"}</p><h1 class="t-title">Listening stats</h1>
      <p class="t-lead">${S.n === 1 ? "1 rated album" : `${S.n} rated albums`}${S.avg != null ? `, averaging ${S.avg}` : ""}. Counted by the day each album was first rated; Rotation doesn't track play counts or listening time.</p>
      ${sampleBanner}</header>

    <section class="section panel" aria-labelledby="diary-h">
      <div class="section__head"><div class="section__titles"><h2 class="t-section" id="diary-h">Listening diary</h2><p class="t-meta" id="heatSum">${plural(h.total, "album")} in the last 12 months · ${plural(h.active, "active day")} · longest streak ${plural(h.longestStreak, "day")}. Arrow keys move between days.</p></div>
        <div class="heat__key" aria-hidden="true"><span class="t-meta">Less</span>${[0, 1, 2, 3, 4].map((l) => `<span class="heat__cell heat__cell--key" data-l="${l}"></span>`).join("")}<span class="t-meta">More</span></div></div>
      ${heatmapHTML(h)}
    </section>

    <div class="stats__grid">
      <section class="panel" aria-labelledby="dec-h"><div class="section__titles"><h2 class="t-section" id="dec-h">Decades</h2><p class="t-meta">${S.decadeCount} of ${S.n} albums have a release date</p></div>${decadesHTML(S.decades)}</section>
      <section class="panel" aria-labelledby="gen-h"><div class="section__titles"><h2 class="t-section" id="gen-h">Top genres</h2><p class="t-meta">Each album counts toward its first two MusicBrainz genres</p></div>${donutHTML(S.genres, S.withGenre)}</section>
    </div>

    <section class="section">${sectionHead(`Top artists of ${S.year}`, { sub: "Most albums rated this year; ties go to the higher average" })}
      ${S.artists.length ? `<ol class="toplist">${S.artists.map((a, i) => `<li class="toplist__item"><span class="toplist__rank">${i + 1}</span>${artwork(smallArt(a.cover_url), a.name, "thumb")}
          <span class="toplist__text"><span class="toplist__name">${esc(a.name)}</span><span class="t-meta">${plural(a.n, "album")} rated · average ${a.avg}</span></span></li>`).join("")}</ol>`
        : `<p class="t-meta">Nothing rated yet in ${S.year}.</p>`}</section>

    <section class="section">${sectionHead("You might like", { sub: demo ? "Sample picks" : "", id: "statsRecWhy" })}
      <div class="row" id="statsRecs">${skCards(6)}</div></section>
    </div>`;
  $("#statsSignIn")?.addEventListener("click", (e) => { e.preventDefault(); openAuth(); });
  wireHeatmap(demo ? "(sample)" : "");

  // Picks: same engine and cache as the home page; sample mode shows fixed demo cards
  const recs = $("#statsRecs"), why = $("#statsRecWhy");
  if (demo) { recs.innerHTML = SAMPLE_RECS.map((r) => albumCard({ ...r, art: null })).join(""); return; }
  if (ratings.length < REC_MIN_RATINGS) {
    why.textContent = "";
    recs.outerHTML = `<div id="statsRecs">${emptyState({ iconName: "star", compact: true, title: "Rate a few albums to get picks", body: `Picks need ${plural(REC_MIN_RATINGS - ratings.length, "more rating")}. Until then we don't pretend to know your taste.` })}</div>`;
    return;
  }
  why.textContent = "Matching genres, artists and similar listeners to what you rate highly…";
  const sig = user.id + ":" + ratings.map((r) => r.album.id + r.score).join(",");
  await getRecs(ratings, sig, (picks) => {
    if (!recs.isConnected) return;
    why.textContent = recsNote(picks);
    recs.innerHTML = picks.items.length ? picks.items.map((it) => albumCard(it)).join("")
      : emptyState({ title: "No new picks right now", body: "Try Surprise me or browse hidden gems.", compact: true, actions: button("Surprise me", { variant: "primary", href: "/surprise", iconName: "spark" }) });
  });
}

/* ==========================================================================
   Router and nav
   ========================================================================== */
// Page metadata. Rotation uses hash URLs, so crawlers that don't run scripts only see the defaults in index.html;
// browsers, link unfurlers that run scripts and screen readers get a real title and description per page.
const DEFAULT_DESC = "Rotation: score albums out of 10, star standout tracks, keep lists and see where everyone else lands.";
function setPageMeta(title, description = DEFAULT_DESC) {
  if (title) document.title = title;
  const set = (sel, attr, val) => { const el = $(sel); if (el) el.setAttribute(attr, val); };
  set('meta[name="description"]', "content", description);
  set('meta[property="og:title"]', "content", document.title);
  set('meta[property="og:description"]', "content", description);
  set('link[rel="canonical"]', "href", location.origin + location.pathname);
  set('meta[property="og:url"]', "content", location.origin + location.pathname);
}
// Error boundary: a failure while drawing a page shows a recoverable message instead of a blank screen
function onRouteError(err) {
  console.error("Page failed to render:", err);
  const v = $("#view");
  if (v) v.innerHTML = errorState({ title: "This page hit a problem", body: "Something unexpected went wrong. Your data is safe. Try again, or head back home.", retry: route, compact: false });
}
let lastErrorToast = 0;
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled:", e.reason);
  if (Date.now() - lastErrorToast > 4000) { lastErrorToast = Date.now(); toast("Something went wrong. Please try again.", "error"); }
});
// Every page gets a top-level heading for screen readers, even full-page empty and error states that have none
new MutationObserver(() => {
  const v = $("#view");
  if (v && !$("h1", v)) v.insertAdjacentHTML("afterbegin", `<h1 class="sr">${esc(document.title.replace(/ · Rotation$/, ""))}</h1>`);
}).observe($("#view"), { childList: true });
function route() {
  window.dispatchEvent(new Event("rotation:route"));
  setPageMeta("Rotation");
  try { const r = routeInner(); if (r && typeof r.catch === "function") r.catch(onRouteError); } catch (e) { onRouteError(e); }
}
function routeInner() {
  const path = location.pathname.replace(/(.)\/+$/, "$1") || "/", h = path + location.search;   // path for plain routes, path + query for search and browse
  window.scrollTo(0, 0);
  $("#nav").classList.remove("is-tucked");
  const own = profile && path.toLowerCase() === `/u/${profile.username}`;
  const section = path.startsWith("/me") || own ? "me" : /^\/(genre|genres|explore|decade|browse|surprise)\b/.test(path) ? "explore" : /^\/lists?\b/.test(path) ? "lists"
    : path.startsWith("/search") ? "search" : path === "/" ? "discover" : "";
  $$("[data-nav]").forEach((a) => (a.dataset.nav === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  refreshUnread();
  let m;
  if ((m = path.match(/^\/album\/([0-9a-f-]{36})/i))) return renderAlbum(m[1]);
  if ((m = path.match(/^\/artist\/([0-9a-f-]{36})/i))) return renderArtist(m[1]);
  if ((m = path.match(/^\/find-artist\/(.+)$/))) return resolveArtist(decodeURIComponent(m[1]));
  if ((m = path.match(/^\/find\/([^/]+)\/(.+)$/))) return resolveFind(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if ((m = path.match(/^\/genre\/([a-z-]+)/))) return renderGenre(m[1]);
  if (path === "/stats") return renderStats(false);
  if (path === "/stats/sample") return renderStats(true);
  if (path === "/feed") return renderFeed();
  if (path === "/notifications") return renderNotifications();
  if ((m = path.match(/^\/u\/([a-z0-9_]{3,20})\/year\/(\d{4})$/i))) return renderRecap(m[1].toLowerCase(), m[2]);
  if ((m = path.match(/^\/year(?:\/(\d{4}))?$/))) return renderRecap(null, m[1]);
  if ((m = path.match(/^\/compare\/([a-z0-9_]{3,20})(?:\/([a-z0-9_]{3,20}))?$/i))) return renderCompare(m[1].toLowerCase(), m[2]?.toLowerCase());
  if ((m = path.match(/^\/u\/([a-z0-9_]{3,20})$/i))) return renderPublicProfile(m[1]);
  if ((m = path.match(/^\/list\/([0-9a-f-]{36})$/i))) return renderList(m[1]);
  if (path === "/settings") return renderSettings();
  if (path === "/privacy") return renderPrivacy();
  if (path === "/me/edit") return renderProfileEdit();
  if ((m = path.match(/^\/decade\/(\d{4})$/))) return renderDecade(+m[1]);
  if ((m = path.match(/^\/lists(?:\/([a-z]+))?$/))) return renderLists(m[1]);
  if (/^\/browse(?:\?|$)/.test(h)) return renderBrowse(parseBrowse(h));
  if (path === "/surprise") return renderSurprise();
  if (/^\/search(?:[\/?]|$)/.test(h)) { const s = parseSearchHash(h); return renderSearch(s.term, s.f); }
  if (path.startsWith("/explore") || path.startsWith("/genres")) return renderExplore();
  if (path.startsWith("/me")) return renderProfile();
  if (path === "/" || path === "#") return renderHome();
  renderNotFound();
}
// Path routing (History API). Links stay plain <a href="/album/...">, so they work with right-click, middle-click, copy link and crawlers.
window.addEventListener("popstate", route);
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[href]");
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
  const href = a.getAttribute("href");
  if (!href || href[0] !== "/" || href[1] === "/") return;   // only same-site paths; "#view" skip links, https links and "//" are left to the browser
  e.preventDefault();
  go(href);
});

// Album page backdrop fades out as you scroll so the content below sits on the plain page color
// On phones, tuck the nav away while scrolling down; bring it back on scroll up
let lastY = 0;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  if (window.matchMedia("(max-width: 760px)").matches) $("#nav").classList.toggle("is-tucked", y > lastY && y > 120);
  lastY = y;
}, { passive: true });

// Bottom navigation for phones and small tablets (CSS shows it under 860px)
$("#tabbar").innerHTML = [["discover", "/", "Home", "compass"], ["explore", "/explore", "Explore", "grid"], ["lists", "/lists", "Lists", "list"],
  ["search", "/search", "Search", "search"], ["me", "/me", "Profile", "user"]]
  .map(([key, href, label, ic]) => `<a href="${href}" data-nav="${key}">${icon(ic)}<span>${label}</span></a>`).join("");

(async function start() {
  if (sb) {
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    loadStreamPref();
    await loadProfile();
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setTimeout(openRecovery, 0);
      const changed = (session?.user?.id || null) !== (user?.id || null);
      user = session?.user || null;
      loadStreamPref();
      // Deferred: calling Supabase from inside this callback can deadlock the auth client
      setTimeout(async () => { if (changed) { await loadProfile(); await syncStreamPref(); } renderAccount(); if (changed) { route(); if (user) resumeIntent(); } }, 0);
    });
  }
  renderAccount();
  route();
  // Came back from Google, Apple or an email link: show why it failed, or pick up what the person was doing
  const failure = window.__authReturn && RL.authReturnMessage(window.__authReturn);
  window.__authReturn = null;
  if (failure) { openAuth(); showAuthMessage(failure, "error"); }
  else if (user) resumeIntent();
})();

/* ---------- Theme toggle (paper / after hours) ----------
   The initial theme is set by a script in <head> (saved choice, else the system setting). This wires the footer button, saves the
   choice, keeps the browser's theme-color in step with --bg, and follows the system setting until a choice has been saved. */
(function themeToggle() {
  const KEY = "rotation:theme", btn = $("#themeToggle"), root = document.documentElement;
  const saved = () => { try { const t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : null; } catch { return null; } };
  const paint = () => {
    const dark = root.dataset.theme === "dark";
    if (btn) btn.textContent = dark ? "Theme: after hours. Switch to paper" : "Theme: paper. Switch to after hours";
    const bg = getComputedStyle(root).getPropertyValue("--bg").trim(), meta = $('meta[name="theme-color"]');
    if (meta && bg) meta.setAttribute("content", bg);
  };
  const set = (t, save) => { root.dataset.theme = t; if (save) { try { localStorage.setItem(KEY, t); } catch {} } paint(); };
  btn?.addEventListener("click", () => set(root.dataset.theme === "dark" ? "light" : "dark", true));
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => { if (!saved()) set(e.matches ? "dark" : "light", false); }); } catch {}
  paint();
})();
