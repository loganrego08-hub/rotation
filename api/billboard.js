// Current Billboard 200 with cover art, cached at Vercel's edge for 6 hours.
// Chart data: weekly scrape published by github.com/utdata/rwd-billboard-data
const SRC = "https://raw.githubusercontent.com/utdata/rwd-billboard-data/main/data-scraped/billboard-200";

function recentSaturdays() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7) + 7);
  const out = [];
  for (let i = 0; i < 6; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 7); }
  return out;
}
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
const norm = (s) => String(s || "").toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/[^a-z0-9]/g, "");
const sameArtist = (a, b) => { a = norm(a); b = norm(b); return a && b && (a.includes(b.slice(0, 6)) || b.includes(a.slice(0, 6))); };
const num = (v) => (/^\d+$/.test(v) ? +v : null);

module.exports = async (req, res) => {
  try {
    let csv, week;
    for (const date of recentSaturdays()) {
      const r = await fetch(`${SRC}/${date.slice(0, 4)}/${date}.csv`);
      if (r.ok) { csv = await r.text(); week = date; break; }
    }
    if (!csv) throw new Error("No recent Billboard 200 found");
    const [head, ...rows] = parseCSV(csv).filter((r) => r.length > 3);
    const col = (n) => head.indexOf(n);
    const items = rows.slice(0, 50).map((r) => ({
      rank: num(r[col("current_week")]), title: r[col("title")], artist: r[col("performer")],
      lastWeek: num(r[col("last_week")]), peak: num(r[col("peak_pos")]), weeks: num(r[col("wks_on_chart")]), art: null,
    }));

    // Cover art: Apple's album feed first, then iTunes search for whatever is left
    try {
      const j = await (await fetch("https://itunes.apple.com/us/rss/topalbums/limit=200/json")).json();
      const byTitle = new Map((j.feed.entry || []).map((e) => [norm(e["im:name"].label), { art: e["im:image"].at(-1).label, artist: e["im:artist"].label }]));
      items.forEach((it) => { const m = byTitle.get(norm(it.title)); if (m && sameArtist(m.artist, it.artist)) it.art = m.art; });
    } catch {}
    const missing = items.filter((it) => !it.art);
    for (let i = 0; i < missing.length; i += 5) {
      await Promise.all(missing.slice(i, i + 5).map(async (it) => {
        try {
          const q = new URLSearchParams({ term: `${it.artist} ${it.title}`, entity: "album", country: "us", limit: "3" });
          const j = await (await fetch(`https://itunes.apple.com/search?${q}`)).json();
          const hit = (j.results || []).find((x) => sameArtist(x.artistName, it.artist)) || (j.results || [])[0];
          if (hit) it.art = hit.artworkUrl100;
        } catch {}
      }));
    }
    items.forEach((it) => { if (it.art) it.art = it.art.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/, "/600x600bb.jpg"); });

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({ chart: "Billboard 200", week, items });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
