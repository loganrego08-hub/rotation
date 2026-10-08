// Responsive audit. Run from a page on the same origin, e.g. in the browser console on tests/index.html:
//   const s = await (await fetch("/tests/responsive-audit.js")).text(); const audit = (0, eval)(s);
//   const rows = await audit.run({ widths: [360, 390, 768, 1024, 1280], routes: ["/", "/album/..."], signedIn: true });
// Each page is loaded in an iframe of that width through tests/xss.html?benign=1 (the real app with realistic, long fake data and no network).
// It reports horizontal overflow, controls smaller than 44px, text clipped without an ellipsis, cover images that are not square, and layout shift.
(() => {
  const path = (el) => { const bits = []; for (let e = el; e && e.nodeType === 1 && bits.length < 3; e = e.parentElement) bits.unshift(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "")); return bits.join(" > "); };
  const visible = (el, win) => { const r = el.getBoundingClientRect(), cs = win.getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"; };
  const clippedByAncestor = (el, win) => { for (let a = el.parentElement; a && a !== win.document.body; a = a.parentElement) { const o = win.getComputedStyle(a).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true; } return false; };

  function auditWindow(win) {
    const d = win.document, W = win.innerWidth, out = { width: W, overflow: [], small: [], clipped: [], art: [], cls: +(win.__cls || 0).toFixed(3) };
    out.pageOverflow = d.documentElement.scrollWidth - W;
    for (const el of d.querySelectorAll("body *")) {
      if (!visible(el, win)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > W + 1 || r.left < -1) && !clippedByAncestor(el, win) && !el.closest(".sr, [hidden]")) out.overflow.push(path(el) + ` (${Math.round(r.left)}..${Math.round(r.right)})`);
    }
    const targets = d.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], summary');
    for (const el of targets) {
      if (!visible(el, win) || el.closest(".sr, .skip, [hidden], [inert]")) continue;
      const cs = win.getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.display === "inline" && el.tagName === "A" && el.closest("p, li, span, label, small, h1, h2, h3, h4")) continue;   // links inside a sentence are exempt
      if (el.tagName === "INPUT" && /checkbox|radio/.test(el.type) && el.closest("label")) continue;   // the label is the target
      if (r.height < 44 - 0.5 || r.width < 44 - 0.5) out.small.push(path(el) + ` ${Math.round(r.width)}x${Math.round(r.height)} "${(el.getAttribute("aria-label") || el.textContent || el.value || "").trim().slice(0, 24)}"`);
    }
    for (const el of d.querySelectorAll("body *")) {
      if (!visible(el, win) || el.closest(".sr, .skip") || el.classList.contains("sr") || !el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = win.getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(cs.overflowX) && cs.textOverflow !== "ellipsis") out.clipped.push(path(el) + ` ${el.scrollWidth}>${el.clientWidth} "${el.textContent.trim().slice(0, 30)}"`);
    }
    for (const img of d.querySelectorAll(".art img, .art--hero img")) {
      if (!visible(img, win)) continue;
      const r = img.getBoundingClientRect();
      if (Math.abs(r.width - r.height) > 2) out.art.push(path(img) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }

  async function run({ widths = [390], routes = ["/"], signedIn = false, wait = 3200, height = 900 } = {}) {
    const rows = [];
    for (const route of routes) for (const w of widths) {
      const f = document.createElement("iframe");
      f.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${height}px;border:0;opacity:0;pointer-events:none`;
      f.src = `/tests/xss.html?benign=1&s=${encodeURIComponent(route)}${signedIn ? "&in=1" : ""}`;
      document.body.append(f);
      await new Promise((r) => (f.onload = r));
      await new Promise((r) => setTimeout(r, wait));
      try { rows.push({ route, signedIn, ...auditWindow(f.contentWindow) }); } catch (e) { rows.push({ route, width: w, error: String(e) }); }
      f.remove();
    }
    return rows;
  }
  return { run, auditWindow };
})();
