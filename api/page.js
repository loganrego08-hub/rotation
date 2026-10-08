// The app shell (index.html) with real <title>, description, canonical and Open Graph / Twitter tags, so crawlers that don't run JavaScript
// (link previews in chat apps, search engines) see the right thing. vercel.json rewrites every page path here:
//   /album/:id  -> album from Supabase (album_catalog), else MusicBrainz;  cover art, community score when there are ratings
//   /list/:id   -> a PUBLIC list (public_lists view; private lists simply aren't there, so nothing leaks)
//   /artist/:id -> artist name from MusicBrainz
//   anything else -> a title and description for that kind of page, canonical URL, noindex for personal pages
// The browser app takes over after load exactly as before; this only decides what is in <head>.
// Uses only the public Supabase key (the same one config.js ships to every browser). Optional env: SUPABASE_URL, SUPABASE_ANON_KEY, MB_CONTACT.
const fs = require("fs");
const path = require("path");
const RL = require("../lib.js");

const SB_URL = process.env.SUPABASE_URL || "https://qiyauhiekzeccduznotv.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_nbpLuPtDALIdmj6I6wEnXQ_SZDdPwaU";
const UA = `Rotation/1.0 ( ${process.env.MB_CONTACT || "https://rotation-ten.vercel.app"} )`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The shell comes from the bundled file (vercel.json includeFiles). If that ever isn't there, it is fetched from the site itself: /index.html is a
// real static file, so it is never rewritten back to this function.
let shell = null;
async function readShell(origin) {
  if (shell) return shell;
  try { shell = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8"); }
  catch { const r = await fetch(`${origin}/index.html`); if (!r.ok) throw new Error("no shell"); shell = await r.text(); }
  return shell;
}

async function getJSON(url, headers = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3500);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const supabase = (query) => getJSON(`${SB_URL}/rest/v1/${query}`, { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` });

async function albumRow(id) {
  // Rotation's own copy first: it has the community score and the cover Rotation shows
  try {
    const rows = await supabase(`album_catalog?album_id=eq.${id}&select=title,artist,cover_url,release_date,rating_count,avg_score&limit=1`);
    if (rows[0]) return rows[0];
  } catch {}
  // Most albums have never been rated, so they only exist in MusicBrainz
  try {
    const g = await getJSON(`https://musicbrainz.org/ws/2/release-group/${id}?inc=artist-credits&fmt=json`, { "User-Agent": UA });
    return { title: g.title, artist: (g["artist-credit"] || []).map((c) => c.name + (c.joinphrase || "")).join(""), release_date: g["first-release-date"] };
  } catch {}
  return null;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "rotation-ten.vercel.app").split(",")[0];
  const origin = `${proto}://${host}`;
  let pathname = String(q.path || "/"); if (!pathname.startsWith("/")) pathname = "/" + pathname;
  let meta = null;
  try {
    const id = String(q.id || "");
    if (q.kind === "album" && UUID.test(id)) { const row = await albumRow(id); if (row) meta = RL.albumMeta(row, { origin, id }); pathname = `/album/${id}`; }
    else if (q.kind === "list" && UUID.test(id)) {
      const rows = await supabase(`public_lists?id=eq.${id}&select=title,description,username,item_count,covers&limit=1`).catch(() => []);
      if (rows[0]) meta = RL.listMeta(rows[0], { origin, id });
      pathname = `/list/${id}`;
    } else if (q.kind === "artist" && UUID.test(id)) {
      const a = await getJSON(`https://musicbrainz.org/ws/2/artist/${id}?fmt=json`, { "User-Agent": UA }).catch(() => null);
      if (a) meta = RL.artistMeta({ name: a.name, type: a.type, area: a.area?.name }, { origin, id });
      pathname = `/artist/${id}`;
    }
  } catch {}
  if (!meta) meta = RL.routeMeta(pathname.split("?")[0], { origin });
  let html;
  try { html = RL.injectMeta(await readShell(origin), meta); } catch { return res.status(500).send("Rotation is unavailable right now."); }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Share previews don't need to be fresher than an hour; the app itself loads live data after it starts
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).send(html);
};
