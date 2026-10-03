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
        if (k === "single" || k === "maybeSingle") return () => Promise.resolve(res());
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

  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  results.forEach((r) => console.log(r));
  console.log(fails ? `${fails} FAILED` : `All ${results.length} checks passed`);
  return { passed: results.length - fails, failed: fails, results };
})();
