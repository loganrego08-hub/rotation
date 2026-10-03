// Deletes the signed-in user's account. Every row they own (ratings, lists, profile, follows, ...) is removed by the
// foreign keys' ON DELETE CASCADE. This must run on the server because deleting an auth user needs the service-role key.
//
// Setup (once): in Vercel, add the environment variable SUPABASE_SERVICE_ROLE_KEY (Project Settings > Environment Variables).
// It is a secret: never put it in config.js or any file in this repository. Without it this endpoint answers 501 and the app
// tells the person that deletion isn't available yet.
//
// Safety: the caller must send their own access token; we ask Supabase who that token belongs to and delete only that user.
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const base = process.env.SUPABASE_URL || "https://qiyauhiekzeccduznotv.supabase.co";
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) return res.status(501).json({ error: "Account deletion isn't set up on this server yet." });
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in first." });
  if (!req.body || req.body.confirm !== "DELETE") return res.status(400).json({ error: "Confirmation missing." });
  try {
    const who = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: service } });
    if (!who.ok) return res.status(401).json({ error: "Your session has expired. Sign in again." });
    const user = await who.json();
    if (!user?.id) return res.status(401).json({ error: "Your session has expired. Sign in again." });
    const del = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${service}`, apikey: service } });
    if (!del.ok) return res.status(502).json({ error: "Couldn't delete the account. Try again in a moment." });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(502).json({ error: "Couldn't reach the account service. Try again in a moment." });
  }
};
