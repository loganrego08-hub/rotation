// Direct album and track links for a streaming service, with a search link as the graceful fallback.
//   /api/listen?service=spotify&artist=Zach+Bryan&title=American+Heartbreak&mbid=<musicbrainz release group id>
//   /api/listen?service=apple&artist=...&title=...&tracks=1        -> { album, tracks: { "<normalized track title>": url } }
// Where direct links come from, all keyless:
//   Apple Music   Apple's public iTunes lookup (artist -> albums -> tracks)
//   Deezer        Deezer's public API
//   Any service   links stored on the release in MusicBrainz (url relationships), when the release has one for that service
//   Spotify       Spotify's Web API, only when SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set in Vercel (otherwise the search link is used)
// Anything not found falls back to that service's search page for "artist title". Responses are cached at the edge for a day.
const RL = require("../lib.js");

const UA = `Rotation/1.0 ( ${process.env.MB_CONTACT || "https://rotation-ten.vercel.app"} )`;
const enc = encodeURIComponent;
async function getJSON(url, opts = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const bestTitle = (list, title, get) => {
  const hits = list.filter((x) => RL.sameTitleName(get(x), title));
  return hits.find((x) => RL.stripBrackets(get(x)) === RL.stripBrackets(title)) || hits[0] || null;
};

/* ---- Apple Music (iTunes lookup) ---- */
// Apple appends tracking (?uo=4). Track links need their ?i=<track id>, so only the tracking is removed.
const cleanApple = (raw) => { const u = new URL(raw); u.searchParams.delete("uo"); return u.toString(); };
async function appleAlbum(artist, title) {
  const a = await getJSON(`https://itunes.apple.com/search?term=${enc(artist)}&entity=musicArtist&country=us&limit=5`);
  const who = (a.results || []).find((x) => RL.sameArtistName(x.artistName, artist));
  if (!who) return null;
  const l = await getJSON(`https://itunes.apple.com/lookup?id=${who.artistId}&entity=album&limit=200&country=us`);
  const hit = bestTitle((l.results || []).filter((x) => x.wrapperType === "collection"), title, (x) => x.collectionName);
  return hit ? { id: hit.collectionId, url: cleanApple(hit.collectionViewUrl) } : null;
}
async function appleTracks(collectionId) {
  const j = await getJSON(`https://itunes.apple.com/lookup?id=${collectionId}&entity=song&country=us`);
  return Object.fromEntries((j.results || []).filter((x) => x.wrapperType === "track" && x.trackViewUrl).map((x) => [RL.stripBrackets(x.trackName), cleanApple(x.trackViewUrl)]));
}

/* ---- Deezer ---- */
async function deezerAlbum(artist, title) {
  const j = await getJSON(`https://api.deezer.com/search/album?q=${enc(`artist:"${artist}" album:"${title}"`)}&limit=8`);
  const list = (j.data || []).filter((x) => RL.sameArtistName(x.artist?.name, artist));
  const hit = bestTitle(list, title, (x) => x.title);
  return hit ? { id: hit.id, url: `https://www.deezer.com/album/${hit.id}` } : null;
}
async function deezerTracks(albumId) {
  const j = await getJSON(`https://api.deezer.com/album/${albumId}/tracks?limit=100`);
  return Object.fromEntries((j.data || []).map((x) => [RL.stripBrackets(x.title), `https://www.deezer.com/track/${x.id}`]));
}

/* ---- Spotify (optional, needs keys) ---- */
let spToken = null;
async function spotifyToken() {
  if (spToken && spToken.exp > Date.now()) return spToken.value;
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const j = await getJSON("https://accounts.spotify.com/api/token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  spToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return spToken.value;
}
const spotifyReady = () => !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
async function spotifyAlbum(artist, title) {
  const t = await spotifyToken();
  const j = await getJSON(`https://api.spotify.com/v1/search?q=${enc(`album:${title} artist:${artist}`)}&type=album&limit=8`, { headers: { Authorization: `Bearer ${t}` } });
  const list = (j.albums?.items || []).filter((x) => (x.artists || []).some((a) => RL.sameArtistName(a.name, artist)));
  const hit = bestTitle(list, title, (x) => x.name);
  return hit ? { id: hit.id, url: hit.external_urls.spotify } : null;
}
async function spotifyTracks(albumId) {
  const t = await spotifyToken();
  const j = await getJSON(`https://api.spotify.com/v1/albums/${albumId}/tracks?limit=50`, { headers: { Authorization: `Bearer ${t}` } });
  return Object.fromEntries((j.items || []).map((x) => [RL.stripBrackets(x.name), x.external_urls.spotify]));
}

/* ---- MusicBrainz url relationships on the release group's releases ---- */
async function musicbrainzLinks(mbid) {
  const j = await getJSON(`https://musicbrainz.org/ws/2/release?release-group=${mbid}&inc=url-rels&fmt=json&limit=100`);
  const found = {};
  for (const rel of j.releases || []) for (const r of rel.relations || []) {
    const hit = r.url?.resource && RL.streamingFromUrl(r.url.resource);
    if (hit && !found[hit.service]) found[hit.service] = hit.url;
  }
  return found;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const service = String(q.service || ""), artist = String(q.artist || "").trim().slice(0, 120), title = String(q.title || "").trim().slice(0, 160);
  const mbid = /^[0-9a-f-]{36}$/i.test(String(q.mbid || "")) ? String(q.mbid) : null, wantTracks = q.tracks === "1";
  if (!RL.streamingService(service) || !artist || !title) return res.status(400).json({ error: "Missing or unknown service, artist or title" });
  let album = null, tracks = {};
  try {
    if (service === "apple") { const a = await appleAlbum(artist, title); if (a) { album = a.url; if (wantTracks) tracks = await appleTracks(a.id).catch(() => ({})); } }
    else if (service === "deezer") { const a = await deezerAlbum(artist, title); if (a) { album = a.url; if (wantTracks) tracks = await deezerTracks(a.id).catch(() => ({})); } }
    else if (service === "spotify" && spotifyReady()) { const a = await spotifyAlbum(artist, title); if (a) { album = a.url; if (wantTracks) tracks = await spotifyTracks(a.id).catch(() => ({})); } }
  } catch {}
  // The release's own links on MusicBrainz cover every other service (and back up the ones above)
  if (!album && mbid) { try { album = (await musicbrainzLinks(mbid))[service] || null; } catch {} }
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  const fallback = RL.streamingSearchUrl(service, RL.listenQuery(artist, title));
  return res.status(200).json(wantTracks ? { album, direct: !!album, tracks } : { url: album || fallback, direct: !!album });
};
