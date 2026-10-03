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

  /* ---- profile setup, list creation and reporting ---- */
  const writes = [], rpcs = [];
  const stubDb = ({ fail = {}, returns = {}, tables = {} } = {}) => {
    sb.from = (tb) => { let op = null, payload = null;
      const out = () => { if (op) { writes.push({ tb, op, payload }); if (fail[tb]) return { data: null, error: fail[tb] }; return { data: returns[tb] ? { ...payload, ...returns[tb] } : payload, error: null }; }
        return { data: tables[tb] ?? [], error: null, count: 0 }; };
      const p = new Proxy(function () {}, { get: (_, k) => { if (k === "then") return (f, r) => Promise.resolve(out()).then(f, r);
        if (["upsert", "insert", "update"].includes(k)) return (d) => { op = k; payload = d; return p; };
        if (k === "delete") return () => { op = "delete"; return p; };
        if (k === "single" || k === "maybeSingle") return () => Promise.resolve(op ? out() : { data: Array.isArray(tables[tb]) ? (tables[tb][0] ?? null) : (tables[tb] ?? null), error: null });
        return () => p; }, apply: () => p }); return p; };
    sb.rpc = (name, args) => { rpcs.push({ name, args }); const e = fail["rpc:" + name]; return Promise.resolve({ data: null, error: e || null }); };
  };
  const setVal = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const submit = async (formSel) => { document.querySelector(formSel).dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); await wait(600); };

  user = { id: "x", email: "test@example.com" }; profile = null; writes.length = 0;
  stubDb(); location.hash = "#/"; await wait(300);
  await renderProfileEdit(); await wait(600);
  setVal("#pUser", "ab"); await submit("#pform");
  check("a too-short username is rejected before anything is written", !document.querySelector("#pError").hidden && writes.length === 0);
  setVal("#pUser", "Tester_One"); setVal("#pBio", "Hello");
  await submit("#pform");
  const prow = writes.find((w) => w.tb === "profiles")?.payload || {};
  check("profile saves a lowercased username", prow.username === "tester_one", JSON.stringify(prow));
  check("a new profile starts private", prow.is_public === false);
  check("a new profile defaults to showing ratings (once public) and is owned by the signed-in user", prow.show_ratings === true && prow.user_id === "x");
  writes.length = 0; profile = null;
  stubDb({ fail: { profiles: { code: "23505", message: "duplicate key" } } });
  await renderProfileEdit(); await wait(600); setVal("#pUser", "taken_name"); await submit("#pform");
  check("a taken username shows a clear message", /taken/i.test(document.querySelector("#pError").textContent) && !document.querySelector("#pError").hidden);

  writes.length = 0; stubDb({ returns: { lists: { id: "11111111-1111-4111-8111-111111111111" } } });
  const holder = document.querySelector("#view"); holder.innerHTML = '<div id="lh"></div>';
  await renderMyLists(document.querySelector("#lh")); await wait(500);
  setVal("#lTitle", "   "); await submit("#newList");
  check("an empty list title is rejected without a write", writes.length === 0 && !document.querySelector("#lError").hidden);
  setVal("#lTitle", "Albums For A Night Drive"); document.querySelector("#lPublic").checked = true; await submit("#newList");
  const lrow = writes.find((w) => w.tb === "lists")?.payload || {};
  check("creating a list sends title, description and visibility only", JSON.stringify(Object.keys(lrow).sort()) === JSON.stringify(["description", "is_public", "title"]) && lrow.title === "Albums For A Night Drive" && lrow.is_public === true, JSON.stringify(lrow));
  check("after creating, it opens the new list", location.hash === "#/list/11111111-1111-4111-8111-111111111111", location.hash);

  rpcs.length = 0; stubDb();
  openReportDialog({ type: "review", id: "abc-123", label: "this review" }); await wait(300);
  document.querySelector("dialog[open] #rpReason").value = "harassment";
  document.querySelector("dialog[open] form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); await wait(500);
  const rep = rpcs.find((c) => c.name === "report_content");
  check("a report calls report_content with type, id and reason", rep && rep.args.p_type === "review" && rep.args.p_id === "abc-123" && rep.args.p_reason === "harassment", JSON.stringify(rep));
  check("the report dialog closes after sending", !document.querySelector("dialog[open]"));
  stubDb({ fail: { "rpc:report_content": { message: "You can't report your own content." } } });
  openReportDialog({ type: "review", id: "mine", label: "this review" }); await wait(300);
  document.querySelector("dialog[open] form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); await wait(500);
  check("a refused report shows the reason and stays open", /own content/.test(document.querySelector("dialog[open] #rpError")?.textContent || ""));
  document.querySelector("dialog[open] [data-close]")?.click();

  /* ---- password reset (the auth client is stubbed: no email is sent) ---- */
  const authCalls = [];
  sb.auth.resetPasswordForEmail = async (email, opts) => { authCalls.push({ fn: "reset", email, opts }); return { error: null }; };
  sb.auth.updateUser = async (u) => { authCalls.push({ fn: "update", u }); return { error: null }; };
  openAuth(); await wait(200);
  document.querySelector("#authForgot").click(); await wait(200);
  check("Forgot password without an email asks for one and sends nothing", /Enter your email/.test(document.querySelector("#authError").textContent) && authCalls.length === 0);
  document.querySelector("#authEmail").value = "someone@example.com";
  document.querySelector("#authForgot").click(); await wait(300);
  check("Forgot password requests a reset to this site", authCalls[0]?.fn === "reset" && authCalls[0].email === "someone@example.com" && authCalls[0].opts.redirectTo.startsWith(location.origin), JSON.stringify(authCalls[0]));
  check("the confirmation never says whether the account exists", /If an account exists/.test(document.querySelector("#authError").textContent) && document.querySelector("#authError").classList.contains("alert--success"));
  document.querySelector("#authClose").click();
  openRecovery(); await wait(200);
  check("recovery mode hides the email field and the sign-up toggle", document.querySelector("#authEmailField").hidden && document.querySelector("#authToggle").hidden && document.querySelector("#authTitle").textContent === "Choose a new password");
  document.querySelector("#authPass").value = "a-new-password";
  document.querySelector("#authForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); await wait(400);
  check("saving a new password calls updateUser and closes the dialog", authCalls.at(-1)?.fn === "update" && authCalls.at(-1).u.password === "a-new-password" && !document.querySelector("#authDialog").open);
  openAuth(); await wait(100);
  check("opening sign-in afterwards restores the normal form", !document.querySelector("#authEmailField").hidden && document.querySelector("#authTitle").textContent === "Sign in");
  document.querySelector("#authClose").click();

  /* ---- your data: export and account deletion (network, prompt and sign-out are stubbed) ---- */
  user = { id: "x", email: "test@example.com", created_at: "2026-01-01" }; profile = null;
  stubDb({ tables: { ratings: [{ album_id: "a", score: 8 }], lists: [] } });
  await renderProfileEdit(); await wait(600);
  const blobs = []; const realCreate = URL.createObjectURL; URL.createObjectURL = (b) => { blobs.push(b); return "blob:test"; };
  document.querySelector("#exportData").click(); await wait(700); URL.createObjectURL = realCreate;
  const exported = blobs[0] ? JSON.parse(await blobs[0].text()) : null;
  check("Download my data produces a JSON file with the account and ratings", exported && exported.account.email === "test@example.com" && Array.isArray(exported.ratings) && exported.ratings[0]?.score === 8, JSON.stringify(exported)?.slice(0, 120));

  const realFetch = window.fetch, realPrompt = window.prompt, fetched = []; let signedOut = 0, reply = { ok: true, status: 200, body: { ok: true } };
  sb.auth.getSession = async () => ({ data: { session: { access_token: "tok123" } } }); sb.auth.signOut = async () => { signedOut++; };
  window.fetch = async (url, opts) => { if (String(url).includes("/api/delete-account")) { fetched.push({ url, opts }); return { ok: reply.ok, status: reply.status, json: async () => reply.body }; } return realFetch(url, opts); };
  window.prompt = () => "nope"; document.querySelector("#deleteAccount").click(); await wait(300);
  check("deleting needs the exact word DELETE: anything else sends nothing", fetched.length === 0 && signedOut === 0);
  window.prompt = () => null; document.querySelector("#deleteAccount").click(); await wait(200);
  check("cancelling the prompt sends nothing", fetched.length === 0);
  reply = { ok: false, status: 501, body: { error: "Account deletion isn't set up on this server yet." } };
  window.prompt = () => "DELETE"; document.querySelector("#deleteAccount").click(); await wait(500);
  check("a server that can't delete explains why and keeps you signed in", /isn't set up/.test(document.querySelector(".toast--error")?.textContent || "") && signedOut === 0);
  reply = { ok: true, status: 200, body: { ok: true } }; document.querySelector("#deleteAccount").click(); await wait(600);
  const call = fetched.at(-1);
  check("confirmed deletion posts the person's own token and the confirmation", call && call.opts.method === "POST" && call.opts.headers.Authorization === "Bearer tok123" && JSON.parse(call.opts.body).confirm === "DELETE", JSON.stringify(call?.opts));
  check("after deletion the person is signed out and sent home", signedOut === 1 && location.hash === "#/");
  window.fetch = realFetch; window.prompt = realPrompt;

  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  results.forEach((r) => console.log(r));
  console.log(fails ? `${fails} FAILED` : `All ${results.length} checks passed`);
  return { passed: results.length - fails, failed: fails, results };
})();
