/* Rotation — rate and rank albums */
const cfg = window.ROTATION_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
const sb = configured ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const MB = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org/release-group";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let user = null;
let homeTab = "mine";

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
function img(src, alt, cls = "") {
  return `<img src="${esc(src)}" alt="${esc(alt)}" class="${cls}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'No cover'}))">`;
}

/* ---------- Auth ---------- */
let signingUp = false;
function renderAccount() {
  const el = $("#account");
  if (!sb) { el.innerHTML = ""; return; }
  el.innerHTML = user
    ? `<span class="muted">${esc(user.email)}</span><button class="btn ghost" id="signOut">Sign out</button>`
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

/* ---------- Search (MusicBrainz) ---------- */
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
  box.innerHTML = `<p class="muted" style="padding:10px">Searching…</p>`;
  try {
    const query = `${q} AND primarytype:album`;
    const res = await fetch(`${MB}/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=12`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    const groups = data["release-groups"] || [];
    if (!groups.length) { box.innerHTML = `<p class="muted" style="padding:10px">No albums match “${esc(q)}”. Try the artist name too.</p>`; return; }
    box.innerHTML = groups.map((g) => `
      <a class="result" href="#/album/${g.id}">
        ${img(coverUrl(g.id, 250), g.title)}
        <div><strong>${esc(g.title)}</strong><span>${esc(artistName(g["artist-credit"]))}${g["first-release-date"] ? " · " + esc(g["first-release-date"].slice(0, 4)) : ""}</span></div>
      </a>`).join("");
    box.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => { box.hidden = true; $("#q").value = ""; }));
  } catch {
    box.innerHTML = `<p class="error" style="padding:10px">Search is unavailable right now. Try again in a moment.</p>`;
  }
}

/* Album details: stored copy first, then MusicBrainz */
async function getAlbum(id) {
  if (sb) {
    const { data } = await sb.from("albums").select("*").eq("id", id).maybeSingle();
    if (data && data.tracks?.length) return data;
  }
  const rgRes = await fetch(`${MB}/release-group/${id}?inc=artist-credits&fmt=json`);
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
  return {
    id, title: rg.title, artist: artistName(rg["artist-credit"]),
    release_date: rg["first-release-date"] || null, cover_url: coverUrl(id, 500), tracks,
  };
}

/* ---------- Views ---------- */
function setupNotice() {
  $("#view").innerHTML = `<div class="intro"><h1>Almost there.</h1><p>Add your Supabase project URL and anon key to <strong>config.js</strong> to turn on accounts and ratings.</p></div>`;
}

async function renderHome() {
  const v = $("#view");
  v.innerHTML = `
    <section class="intro">
      <h1>Every album you love, scored.</h1>
      <p>Look up any record, give it a score out of 10, mark the standout tracks, and see how everyone else rated it.</p>
    </section>
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" data-tab="mine" aria-selected="${homeTab === "mine"}">Your rankings</button>
      <button class="tab" role="tab" data-tab="all" aria-selected="${homeTab === "all"}">Top rated by everyone</button>
    </div>
    <div id="list" class="loading">Loading…</div>`;
  v.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { homeTab = b.dataset.tab; renderHome(); }));
  const list = $("#list");
  if (!sb) return setupNotice();

  if (homeTab === "mine") {
    if (!user) {
      list.className = "empty";
      list.innerHTML = `Sign in to start ranking your albums.<br><br><button class="btn primary" id="emptySignIn">Sign in</button>`;
      $("#emptySignIn").addEventListener("click", openAuth);
      return;
    }
    const { data, error } = await sb.from("ratings").select("score, album:albums(id,title,artist,cover_url)").order("score", { ascending: false }).order("updated_at", { ascending: false });
    if (error) { list.className = "error"; list.textContent = error.message; return; }
    if (!data.length) { list.className = "empty"; list.textContent = "You haven't rated anything yet. Search for an album above to add your first score."; return; }
    list.className = "grid";
    list.innerHTML = data.map((r) => tile(r.album, r.score)).join("");
  } else {
    const { data, error } = await sb.from("album_stats").select("*").order("avg_score", { ascending: false }).order("rating_count", { ascending: false }).limit(60);
    if (error) { list.className = "error"; list.textContent = error.message; return; }
    if (!data.length) { list.className = "empty"; list.textContent = "No one has rated an album yet. Be the first."; return; }
    list.className = "grid";
    list.innerHTML = data.map((s) => tile({ id: s.album_id, title: s.title, artist: s.artist, cover_url: s.cover_url }, s.avg_score, `${s.rating_count} rating${s.rating_count === 1 ? "" : "s"}`)).join("");
  }
}
function tile(a, score, sub) {
  return `<a class="tile" href="#/album/${a.id}">
    <div class="cover">${img(a.cover_url || coverUrl(a.id, 250), a.title)}<span class="badge">${score}</span></div>
    <h3>${esc(a.title)}</h3><p>${esc(sub || a.artist)}</p></a>`;
}

function recordSvg(score) {
  const rings = Array.from({ length: 10 }, (_, i) => {
    const r = 80 - i * 4.6;
    return `<circle class="groove ${score && 10 - i <= score ? "on" : ""}" cx="84" cy="84" r="${r}"/>`;
  }).join("");
  return `<svg class="record" viewBox="0 0 168 168" role="img" aria-label="${score ? `Your score: ${score} out of 10` : "Not rated yet"}">
    ${rings}<circle class="label" cx="84" cy="84" r="30"/>
    <text class="num" x="84" y="84" text-anchor="middle" dominant-baseline="central">${score || "–"}</text></svg>`;
}

async function renderAlbum(id) {
  const v = $("#view");
  v.innerHTML = `<p class="loading">Pulling up the record…</p>`;
  let album;
  try { album = await getAlbum(id); } catch { v.innerHTML = `<div class="empty">That album couldn't be found. Try searching for it again.</div>`; return; }

  let mine = null, stats = null;
  if (sb) {
    const [{ data: s }, r] = await Promise.all([
      sb.from("album_stats").select("avg_score, rating_count").eq("album_id", id).maybeSingle(),
      user ? sb.from("ratings").select("*").eq("album_id", id).eq("user_id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    stats = s; mine = r.data;
  }
  const state = { score: mine?.score || 0, standouts: new Set(mine?.standout_tracks || []), thoughts: mine?.thoughts || "" };

  v.innerHTML = `
    <article class="album">
      <div class="art">${img(album.cover_url, `${album.title} cover`)}</div>
      <div>
        <h1>${esc(album.title)}</h1>
        <p class="artist">${esc(album.artist)}</p>
        <p class="date">${esc(fmtDate(album.release_date))}</p>

        <div class="scores">
          <div id="rec">${recordSvg(state.score)}</div>
          <div>
            <p class="picker-title">Your score</p>
            <div class="picker" id="picker">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-s="${i + 1}" aria-pressed="${state.score === i + 1}">${i + 1}</button>`).join("")}</div>
            <p class="community">${stats ? `<strong>${stats.avg_score}</strong> average from ${stats.rating_count} rating${stats.rating_count === 1 ? "" : "s"}` : "No ratings from anyone yet."}</p>
          </div>
        </div>

        <h2 class="section-title">Tracklist</h2>
        <p class="muted" style="margin:0 0 12px">Star the standout tracks.</p>
        ${album.tracks?.length ? `<ol class="tracks" id="tracks">${album.tracks.map((t) => `
          <li class="${state.standouts.has(t.title) ? "standout" : ""}">
            <span class="pos">${esc(t.pos)}</span><span class="title">${esc(t.title)}</span>
            <span class="len">${fmtLen(t.length)}</span>
            <button type="button" class="star" data-t="${esc(t.title)}" aria-pressed="${state.standouts.has(t.title)}" aria-label="Mark ${esc(t.title)} as a standout">★</button>
          </li>`).join("")}</ol>` : `<p class="muted">No tracklist is listed for this album.</p>`}

        <h2 class="section-title">Your thoughts</h2>
        <textarea id="thoughts" placeholder="What stuck with you? Favorite moments, how it holds up, where it fits in your rotation.">${esc(state.thoughts)}</textarea>

        <div class="save-row">
          <button class="btn primary" id="save">${mine ? "Update rating" : "Save rating"}</button>
          ${mine ? `<button class="btn ghost" id="remove">Remove rating</button>` : ""}
        </div>
      </div>
    </article>`;

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
    if (!sb) return setupNotice();
    if (!user) return openAuth();
    if (!state.score) return toast("Pick a score from 1 to 10 first");
    $("#save").disabled = true;
    const { error: aErr } = await sb.from("albums").upsert({
      id: album.id, title: album.title, artist: album.artist,
      release_date: album.release_date, cover_url: album.cover_url, tracks: album.tracks,
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
  const m = location.hash.match(/^#\/album\/([0-9a-f-]{36})/i);
  window.scrollTo(0, 0);
  m ? renderAlbum(m[1]) : renderHome();
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
