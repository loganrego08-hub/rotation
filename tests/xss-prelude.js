// XSS harness: loads the real app with every network answer stuffed with hostile strings, then checks whether any of them became live markup.
// Use it through tests/xss.html?s=<scenario>[&in=1]  (see tests/README.md). It only changes window.fetch on that page.
(() => {
  const q = new URLSearchParams(location.search);
  const scenario = q.get("s") || "/";
  const loggedIn = q.get("in") === "1";
  const UUID = "11111111-2222-4333-8444-555555555555";
  const P = `"><img src=x onerror="window.__xss=(window.__xss||0)+1"><svg onload="window.__xss=(window.__xss||0)+1"></svg>'`;
  const COVER = `https://x.test/a.jpg" onerror="window.__xss=(window.__xss||0)+1" x="`;
  window.__xss = 0;
  window.__scenario = scenario;

  // One row that carries every column any table, view or RPC returns. Text columns are hostile; numbers are numbers.
  const NUM = { score: 8, n: 5, rating_count: 5, review_count: 2, like_count: 3, followers: 4, following: 6, item_count: 3, co_raters: 4, similar_listeners: 3, recent_count: 3, total: 2, position: 1, list_count: 3, avg_score: 8.2, recent_avg: 8.1, weighted_score: 8, sd: 1.1, low_share: 0.1, high_share: 0.6 };
  const ID = ["id", "album_id", "list_id", "rating_id", "artist_id", "avatar_album_id", "user_id"];
  const BOOL = ["is_public", "show_ratings", "is_mine", "liked_by_me", "has_review", "is_divisive", "listened", "want", "favorite", "credit_profile", "follows", "likes"];
  const DATE = ["created_at", "updated_at", "read_at", "rated_at", "first_rated_at", "happened_at", "added_at"];
  const TEXT = ["title", "artist", "cover_url", "release_date", "album_type", "username", "display_name", "bio", "avatar_cover", "description", "author", "author_username", "body", "thoughts", "kind", "event_key", "actor_username", "actor_name", "actor_avatar", "album_title", "album_artist", "list_title", "actor", "search_text", "reason", "details", "name"];
  const row = () => {
    const r = {};
    ID.forEach((k) => { r[k] = UUID; });
    BOOL.forEach((k) => { r[k] = true; });
    DATE.forEach((k) => { r[k] = "2026-01-02T03:04:05Z"; });
    TEXT.forEach((k) => { r[k] = P; });
    Object.assign(r, NUM);
    r.cover_url = COVER; r.avatar_cover = COVER; r.actor_avatar = COVER;
    r.username = "xss_user"; r.author_username = "xss_user"; r.actor_username = "xss_user";   // usernames are DB-constrained to [a-z0-9_]; they also appear in URLs
    r.release_date = "1999-05-05";
    r.kind = "review"; r.event_key = "r:" + UUID;
    r.genres = [P, "rock"]; r.standout_tracks = [P]; r.covers = [COVER, COVER];
    r.tracks = [{ title: P, position: 1, length: 200000 }, { title: P, position: 2, length: 190000 }];
    return r;
  };

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const hdr = (init && init.headers) || {};
    const accept = (hdr.Accept || hdr.accept || (hdr.get && hdr.get("Accept")) || "");
    if (url.includes("/rest/v1/")) {
      const one = /object\+json/.test(accept);
      const r = row();
      return json(one ? r : (/=eq\.|limit=1(&|$)/.test(url) ? [r] : [r, r]));   // lookups by id/username get exactly one row (maybeSingle fails on two)
    }
    if (url.includes("/auth/v1/user")) return json({ id: UUID, email: "me@example.test", aud: "authenticated", user_metadata: {}, app_metadata: {} });
    if (url.includes("/auth/v1/")) return json({});
    if (url.includes("musicbrainz.org") || url.includes("/api/search")) {
      const g = { id: UUID, title: P, "first-release-date": "1999-05-05", "primary-type": "Album", "secondary-types": [], "artist-credit": [{ name: P, joinphrase: "", artist: { id: UUID, name: P } }], tags: [{ name: P, count: 4 }], "tag-list": [], "release-groups": [], releases: [], artists: [{ id: UUID, name: P, type: "Group", score: 100 }], name: P, type: "Group", area: { name: P }, "life-span": { begin: "1990" }, "release-group-count": 1 };
      if (url.includes("/api/search")) return json({ groups: [{ id: UUID, title: P, artist: P, artistId: UUID, year: 1999, type: "Album", tags: [P], date: "1999-05-05" }] });
      return json({ ...g, "release-groups": [g], count: 1 });
    }
    if (url.includes("/api/chart")) return json({ slug: "x", week: "2026-01-03", name: P, items: [{ rank: 1, title: P, artist: P, art: COVER, last: 2, peak: 1, weeks: 3 }, { rank: 2, title: P, artist: P, art: COVER }] });
    if (url.includes("/api/listen")) return json({ url: "https://example.test/", direct: false });
    if (url.includes("coverartarchive.org") || url.includes("itunes.apple.com")) return json({ images: [], results: [] });
    return json({});
  };

  // Start the app on the page under test; sign in with a fake session when asked
  const route = scenario.startsWith("/") ? scenario : "/" + scenario;
  history.replaceState(null, "", route);
  try {
    if (loggedIn) {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      localStorage.setItem("sb-qiyauhiekzeccduznotv-auth-token", JSON.stringify({ access_token: "a.b.c", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: exp, user: { id: UUID, email: "me@example.test", aud: "authenticated", user_metadata: {}, app_metadata: {} } }));
    } else localStorage.removeItem("sb-qiyauhiekzeccduznotv-auth-token");
  } catch {}

  // Called by the test runner after the page settles
  window.__xssReport = () => {
    const live = [...document.querySelectorAll("[onerror],[onload]")].filter((e) => /__xss/.test(e.getAttribute("onerror") || e.getAttribute("onload") || "")).length;
    const stray = document.querySelectorAll('img[src="x"], svg[onload]').length;
    const attrBreak = [...document.querySelectorAll("img")].filter((i) => i.hasAttribute("onerror") && /__xss/.test(i.getAttribute("onerror"))).length;
    return { scenario, loggedIn, fired: window.__xss, injectedHandlers: live, strayNodes: stray, attrBreak, h1: (document.querySelector("h1") || {}).textContent, textLen: document.body.innerText.length };
  };
})();
