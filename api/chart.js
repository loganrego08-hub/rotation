// Any Billboard album chart as JSON, cached at Vercel's edge for 6 hours.
//   /api/chart?slug=billboard-200        (from the utdata weekly archive)
//   /api/chart?slug=top-country-albums   (read from the public billboard.com chart page)
const ARCHIVE = "https://raw.githubusercontent.com/utdata/rwd-billboard-data/main/data-scraped/billboard-200";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const norm = (s) => String(s || "").toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/[^a-z0-9]/g, "");
const sameArtist = (a, b) => { a = norm(a); b = norm(b); return a && b && (a.includes(b.slice(0, 6)) || b.includes(a.slice(0, 6))); };
const num = (v) => (/^\d+$/.test(String(v).trim()) ? +v : null);
const decode = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#0?39;|&#8217;|&rsquo;/g, "'")
  .replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&#8211;/g, "-").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();

function parseCSV(t) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function billboard200() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7) + 7);
  for (let i = 0; i < 6; i++, d.setUTCDate(d.getUTCDate() - 7)) {
    const date = d.toISOString().slice(0, 10);
    const r = await fetch(`${ARCHIVE}/${date.slice(0, 4)}/${date}.csv`);
    if (!r.ok) continue;
    const [head, ...rows] = parseCSV(await r.text()).filter((x) => x.length > 3);
    const col = (n) => head.indexOf(n);
    return {
      name: "Billboard 200", week: date,
      items: rows.slice(0, 50).map((x) => ({
        rank: num(x[col("current_week")]), title: x[col("title")], artist: x[col("performer")],
        lastWeek: num(x[col("last_week")]), peak: num(x[col("peak_pos")]), weeks: num(x[col("wks_on_chart")]), art: null,
      })),
    };
  }
  throw new Error("No recent Billboard 200 found");
}

async function billboardPage(slug) {
  const r = await fetch(`https://www.billboard.com/charts/${slug}/`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
  if (!r.ok) throw new Error(`Billboard returned ${r.status} for ${slug}`);
  const html = await r.text();
  const name = decode((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]) || slug;
  const weekText = (html.match(/Week of ([A-Z][a-z]+ \d{1,2}, \d{4})/) || [])[1];
  const week = weekText ? new Date(weekText + " UTC").toISOString().slice(0, 10) : null;
  const items = [];
  for (const chunk of html.split("o-chart-results-list-row-container").slice(1)) {
    const t = chunk.match(/<h3[^>]*id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/);
    if (!t) continue;
    const after = chunk.slice(chunk.indexOf(t[0]) + t[0].length);
    const labels = [...after.matchAll(/<span[^>]*class="c-label[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => decode(m[1])).filter(Boolean);
    const stats = labels.slice(1).filter((x) => /^(\d+|-)$/.test(x));
    const img = (chunk.match(/data-lazy-src="([^"]+)"/) || [])[1];
    items.push({
      rank: items.length + 1, title: decode(t[1]), artist: labels[0] || "",
      lastWeek: num(stats[0]), peak: num(stats[1]), weeks: num(stats[2]),
      art: img && !/fallback|placeholder/.test(img) ? img.replace(/-\d+x\d+(\.\w+)$/, "-344x344$1") : null,
    });
    if (items.length >= 50) break;
  }
  if (!items.length) throw new Error(`Couldn't read the ${slug} chart`);
  return { name, week, items };
}

async function addArt(items) {
  const missing = items.filter((it) => !it.art);
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(missing.slice(i, i + 5).map(async (it) => {
      try {
        const q = new URLSearchParams({ term: `${it.artist} ${it.title}`, entity: "album", country: "us", limit: "3" });
        const j = await (await fetch(`https://itunes.apple.com/search?${q}`)).json();
        const hit = (j.results || []).find((x) => sameArtist(x.artistName, it.artist)) || (j.results || [])[0];
        if (hit) { it.art = hit.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/, "/600x600bb.jpg"); it.genre = hit.primaryGenreName; }
      } catch {}
    }));
  }
}

module.exports = async (req, res) => {
  const slug = String(req.query.slug || "billboard-200").toLowerCase();
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return res.status(400).json({ error: "Bad chart slug" });
  try {
    const chart = slug === "billboard-200" ? await billboard200() : await billboardPage(slug);
    await addArt(chart.items);
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({ slug, ...chart });
  } catch (e) {
    res.status(502).json({ slug, error: e.message });
  }
};
