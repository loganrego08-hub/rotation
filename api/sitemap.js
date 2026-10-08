// /sitemap.xml: the main pages, every public list, and albums that have at least one rating on Rotation.
// (Albums nobody has rated live only in MusicBrainz; they are reachable by search and links, just not listed here.)
const SB_URL = process.env.SUPABASE_URL || "https://qiyauhiekzeccduznotv.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_nbpLuPtDALIdmj6I6wEnXQ_SZDdPwaU";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function rows(query) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${query}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}
module.exports = async (req, res) => {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "rotation-ten.vercel.app").split(",")[0];
  const origin = `https://${host}`;
  const [albums, lists] = await Promise.all([
    rows("album_catalog?select=album_id&rating_count=gt.0&order=rating_count.desc&limit=2000"),
    rows("public_lists?select=id,updated_at&order=updated_at.desc&limit=1000"),
  ]);
  const urls = [["/", "daily"], ["/explore", "daily"], ["/lists", "daily"], ["/lists/community", "daily"], ["/search", "monthly"], ["/browse", "weekly"]].map(([p, f]) => ({ loc: origin + p, freq: f }))
    .concat(albums.map((a) => ({ loc: `${origin}/album/${a.album_id}`, freq: "weekly" })))
    .concat(lists.map((l) => ({ loc: `${origin}/list/${l.id}`, freq: "weekly", mod: l.updated_at ? String(l.updated_at).slice(0, 10) : null })));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.mod ? `<lastmod>${u.mod}</lastmod>` : ""}<changefreq>${u.freq}</changefreq></url>`).join("\n")}\n</urlset>\n`;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  return res.status(200).send(xml);
};
