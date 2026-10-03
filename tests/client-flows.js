/* Client rating-flow test. Paste this whole file into the browser console on any page of the running app
   (local or live). It replaces the database client with a recording stub, so NOTHING is written anywhere, then drives the
   real album page: tapping a score, a failed save, saving a review, and removing a rating.
   It prints PASS/FAIL lines and returns a summary. Reload the page afterwards to restore the real client. */
(async () => {
  const results = [];
  const check = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  const ALBUM = "21e886f7-db66-3103-beb4-da9323adddc7";
  const calls = []; let mode = "ok";
  const chain = (tb) => {
    let op = null, payload = null;
    const res = () => {
      if (["upsert", "insert", "update"].includes(op)) {
        calls.push({ tb, op, payload });
        if (mode === "fail" && tb === "ratings") return { data: null, error: { message: "Slow down a little and try again." } };
        if (tb === "ratings") return { data: { id: "rid1", user_id: "x", album_id: ALBUM, score: payload.score ?? 7, thoughts: payload.thoughts ?? null, standout_tracks: payload.standout_tracks ?? [], updated_at: new Date().toISOString(), created_at: new Date().toISOString() }, error: null };
        return { data: payload, error: null };
      }
      if (op === "delete") { calls.push({ tb, op }); return { data: null, error: null }; }
      return { data: tb === "albums" ? null : [], error: null };
    };
    const p = new Proxy(function () {}, {
      get: (_, k) => {
        if (k === "then") return (f, r) => Promise.resolve(res()).then(f, r);
        if (["upsert", "insert", "update"].includes(k)) return (d) => { op = k; payload = d; return p; };
        if (k === "delete") return () => { op = "delete"; return p; };
        // a read of one row finds nothing; a write that asks for its row back returns it
        if (k === "single" || k === "maybeSingle") return () => Promise.resolve(op ? res() : { data: null, error: null });
        return () => p;
      }, apply: () => p,
    });
    return p;
  };
  sb.from = chain; sb.rpc = () => Promise.resolve({ data: [], error: null });
  user = { id: "x", email: "test@example.com" }; profile = null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tap = async (n) => { document.querySelector(`#picker button[data-s="${n}"]`).click(); await wait(600); };

  await renderAlbum(ALBUM); await wait(1500);
  await tap(8);
  const first = calls.filter((c) => c.tb === "ratings");
  check("tapping a score saves once", first.length === 1);
  check("only the score is sent (a review is never overwritten)", JSON.stringify(Object.keys(first[0]?.payload || {}).sort()) === JSON.stringify(["album_id", "score", "user_id"]), JSON.stringify(first[0]?.payload));
  check("the score is shown immediately", document.querySelector("#myScore").textContent.startsWith("8"));
  check("rating marks the album as listened", document.querySelector('[data-st="listened"]').getAttribute("aria-pressed") === "true");
  check("Rated status turns on", document.querySelector('[data-st="rated"]').getAttribute("aria-pressed") === "true");
  check("Remove rating becomes available", !document.querySelector("#remove").hidden);

  mode = "fail"; await tap(3);
  check("a failed save reverts to the previous score", document.querySelector("#myScore").textContent.startsWith("8"));
  check("a failed save explains why", /Slow down/.test(document.querySelector(".toast--error")?.textContent || ""));

  mode = "ok"; calls.length = 0;
  document.querySelector("#thoughts").value = "Great record"; document.querySelector("#save").click(); await wait(700);
  const saved = calls.find((c) => c.tb === "ratings");
  check("saving a review sends the text", saved?.payload.thoughts === "Great record");
  check("an unshared review does not send sharing flags", !("is_public" in (saved?.payload || {})));
  check("Delete review appears once there is a review", !document.querySelector("#delReview").hidden);

  calls.length = 0; const realConfirm = window.confirm; window.confirm = () => true;
  document.querySelector("#remove").click(); await wait(600); window.confirm = realConfirm;
  check("removing a rating deletes it", calls.some((c) => c.tb === "ratings" && c.op === "delete"));
  check("the score and review fields reset", document.querySelector("#myScore").textContent.startsWith("–") && document.querySelector("#thoughts").value === "");

  /* ---- listening status: the same rules the database enforces ---- */
  const upserts = (tb) => calls.filter((c) => c.tb === tb && c.op === "upsert");
  const stat = (k) => document.querySelector(`[data-st="${k}"]`);
  const press = async (k) => { stat(k).click(); await wait(500); };
  calls.length = 0; await renderAlbum(ALBUM); await wait(1500);
  await press("want");
  check("Want to listen saves want=true, listened=false", upserts("album_status").at(-1)?.payload.want === true && upserts("album_status").at(-1)?.payload.listened === false, JSON.stringify(upserts("album_status").at(-1)?.payload));
  check("Want to listen shows as on", stat("want").getAttribute("aria-pressed") === "true");
  await press("listened");
  check("Listened clears Want to listen", stat("listened").getAttribute("aria-pressed") === "true" && stat("want").getAttribute("aria-pressed") === "false");
  await press("favorite");
  check("Favorite also marks listened", stat("favorite").getAttribute("aria-pressed") === "true" && stat("listened").getAttribute("aria-pressed") === "true");
  const before = calls.length; await press("listened");
  check("a favorite can't be un-listened (no write is made)", calls.length === before && stat("listened").getAttribute("aria-pressed") === "true");
  await press("favorite");
  check("unfavoriting keeps it listened", stat("favorite").getAttribute("aria-pressed") === "false" && stat("listened").getAttribute("aria-pressed") === "true");
  await tap(9);
  const w = calls.length; await press("want");
  check("a rated album can't be moved to Want to listen", calls.length === w && stat("want").getAttribute("aria-pressed") === "false");

  /* ---- sign-in gate: nothing is written when signed out ---- */
  user = null; calls.length = 0; await renderAlbum(ALBUM); await wait(1500);
  document.querySelector('#picker button[data-s="7"]').click(); await wait(300);
  check("signed-out tap opens sign-in instead of saving", document.querySelector("#authDialog").open && calls.length === 0);
  document.querySelector("#authClose").click();
  user = { id: "x", email: "test@example.com" };

  /* ---- following and liking go through the checked server functions ---- */
  const rpcCalls = [];
  const tables = { public_profiles: { username: "mira", display_name: "Mira", bio: "", show_ratings: true, created_at: "2026-01-01T00:00:00Z", followers: 3, following: 1, rating_count: 0, avg_score: null, review_count: 0 } };
  sb.from = (tb) => { const data = tables[tb] ?? []; const res = { data, error: null, count: 0 };
    const p = new Proxy(function () {}, { get: (_, k) => k === "then" ? (f, r) => Promise.resolve(res).then(f, r) : (k === "maybeSingle" || k === "single") ? () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null }) : () => p, apply: () => p }); return p; };
  sb.rpc = (name, args) => { rpcCalls.push(name + ":" + (args.p_username || args.p_rating || "")); return Promise.resolve({ data: name === "is_following" ? false : name === "toggle_review_like" ? { liked: true, count: 1 } : null, error: null }); };
  await renderPublicProfile("mira"); await wait(1200);
  const followers = () => document.querySelector("#stFollowers").textContent;
  check("profile shows the follower count from the public view", followers() === "3");
  document.querySelector("#followBtn").click(); await wait(500);
  check("Follow calls follow_user for that username", rpcCalls.includes("follow_user:mira"), rpcCalls.join(","));
  check("Follow updates the button and count", document.querySelector("#followBtn").textContent.includes("Following") && followers() === "4");
  document.querySelector("#followBtn").click(); await wait(500);
  check("Unfollow calls unfollow_user and restores the count", rpcCalls.includes("unfollow_user:mira") && followers() === "3");
  user = null; rpcCalls.length = 0;
  await renderPublicProfile("mira"); await wait(1200);
  document.querySelector("#followBtn").click(); await wait(300);
  check("signed-out Follow opens sign-in and calls nothing", document.querySelector("#authDialog").open && !rpcCalls.some((c) => c.startsWith("follow_user")));
  document.querySelector("#authClose").click();
  user = { id: "x", email: "test@example.com" };

  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  results.forEach((r) => console.log(r));
  console.log(fails ? `${fails} FAILED` : `All ${results.length} checks passed`);
  return { passed: results.length - fails, failed: fails, results };
})();
