// Album search candidates from MusicBrainz, fetched server-side so the site identifies itself properly and every visitor
// shares one cache. The browser ranks them with lib.js (same code as tests/index.html).
//   /api/search?q=kendrick+gnx&type=album&from=&to=&genre=&artist=&limit=50&offset=0&prefix=1
// Rate limit: MusicBrainz allows about 1 request/second per client. Requests in one function instance are queued 1.1 s apart and
// identical in-flight requests are shared. Responses are cached at Vercel's edge for an hour (a day while revalidating), so a repeated
// query costs nothing. Separate cold instances are not coordinated; see the notes in the pull request / README.
// Optional env var: MB_CONTACT (a URL or email MusicBrainz can reach you at; defaults to the site address).
const RL = require("../lib.js");

const MB = "https://musicbrainz.org/ws/2";
const UA = `Rotation/1.0 ( ${process.env.MB_CONTACT || "https://rotation-ten.vercel.app"} )`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chain = Promise.resolve(), last = 0;
const inflight = new Map();
function mb(url) {
  if (inflight.has(url)) return inflight.get(url);
  const run = chain.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = last + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 503 && attempt === 0) { await sleep(1500); continue; }
      if (!r.ok) throw new Error(`MusicBrainz HTTP ${r.status}`);
      return r.json();
    }
    throw new Error("MusicBrainz is busy");
  });
  chain = run.catch(() => {});
  inflight.set(url, run);
  run.finally(() => inflight.delete(url)).catch(() => {});
  return run;
}
const fetchGroups = async (query, limit, offset) => {
  const j = await mb(`${MB}/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}&offset=${offset}`);
  return (j["release-groups"] || []).map(RL.candidateOf);
};

module.exports = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 100);
    const f = {};
    ["type", "from", "to", "genre", "artist"].forEach((k) => { if (req.query[k]) f[k] = String(req.query[k]).slice(0, 60); });
    if (f.from) f.from = f.from.replace(/\D/g, "").slice(0, 4);
    if (f.to) f.to = f.to.replace(/\D/g, "").slice(0, 4);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, Math.min(RL.MB_WINDOW - limit, parseInt(req.query.offset, 10) || 0));
    const prefix = req.query.prefix === "1";
    if (!q && !Object.keys(f).length) { res.setHeader("Cache-Control", "public, s-maxage=3600"); return res.status(200).json({ groups: [], fuzzy: false }); }

    const plan = RL.searchPlan(q, f, { prefix });
    let groups = plan.strict ? await fetchGroups(plan.strict, limit, offset) : [];
    let fuzzy = false;
    // Weak or empty results usually mean a typo: try again with typo-tolerant terms and merge
    if (offset === 0 && !prefix && q && plan.fuzzy && plan.fuzzy !== plan.strict) {
      const ranked = RL.rankAlbums(q, groups, {}, { typeChosen: !!f.type && f.type !== "any" });
      if (ranked.length < 3 || ranked[0].text < 0.75) {
        const more = await fetchGroups(plan.fuzzy, limit, 0).catch(() => []);
        const seen = new Set(groups.map((g) => g.id));
        groups = groups.concat(more.filter((g) => !seen.has(g.id)));
        fuzzy = true;
      }
    }
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ groups, fuzzy });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Search is unavailable right now" });
  }
};
