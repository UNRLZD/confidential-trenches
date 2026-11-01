#!/usr/bin/env node
// Live check of card app-shell: the terminal's empty shell, as served at APP_HOST. Headless Chromium loads every route
// at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1) and reads:
//   - the page is served under a CSP and an Integrity-Policy (app-host-gate's headers, app.md 2.3);
//   - no CSP violation and no console error on any load;
//   - every script tag carries an integrity equal to the sha384 of the bytes served, no script is inline, and every
//     script the page's top frame loaded is one of those tags (the hidden signing-page frame is SIGN_HOST's to check);
//   - each route draws its own screen (main[data-route]), not the fallback;
//   - CLS at most 0.1 per load and 0 inside the shell (clicking through the navigation), every shift counted, the
//     hadRecentInput exclusion not applied (BAR-04, app.md:1102);
//   - no horizontal scroll, no text under 11 px, and on the phone no tap target under 44 px (BAR-10, app.md:1108; the
//     tests of R5's design/proto/tools/shoot.mjs:68, :76-91, :92-108).
// A screenshot of every load is kept at both widths.
//   node scripts/live-checks/app-shell.mjs [--url <origin>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read to <file>, so the check's test can replay it through judge().
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-shell";
export const APP_HOST = "https://confidential.unrealized.trade";
export const CLS_MAX = 0.1;
// the shell's routes (apps/terminal/src/routes/routes.ts)
export const ROUTES = [
  ["token", "/"],
  ["discover", "/discover"],
  ["portfolio", "/portfolio"],
  ["orders", "/orders"],
  ["profile", "/profile"],
  ["verify", "/verify"],
  ["privacy", "/privacy"],
  ["terms", "/terms"],
];
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, nav: ".tabbar a" },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, nav: ".tb .nav a, .ft a" },
];
const SETTLE_MS = 2000;

const sha384 = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const csp = rec.headers?.csp ?? "";
  const ip = rec.headers?.integrityPolicy ?? "";
  say(/\bscript-src\b/.test(csp) && /require-trusted-types-for 'script'/.test(csp) && /\bscript\b/.test(ip), `served with a CSP and an Integrity-Policy: ${csp ? "CSP" : "no CSP"}, ${ip ? `Integrity-Policy ${ip}` : "no Integrity-Policy"}`);

  const scripts = rec.scripts ?? [];
  say(scripts.length > 0, `${scripts.length} script tag(s)`);
  for (const s of scripts) {
    const tokens = (s.integrity ?? "").split(/\s+/).filter((t) => t.startsWith("sha384-"));
    if (!s.src) say(false, "an inline script");
    else if (tokens.length === 0) say(false, `${s.src} has no sha384 integrity`);
    else say(tokens.includes(s.served), `${s.src} integrity ${tokens.includes(s.served) ? "equals" : "differs from"} the sha384 of the bytes served`);
  }
  const tagged = new Set(scripts.map((s) => s.src));
  // only the top frame's scripts count: the signing page's hidden frame is judged by SIGN_HOST's own checks (signpage-*)
  const untagged = [...new Set((rec.loadedScripts ?? []).filter((l) => l.top).map((l) => l.url))].filter((u) => !tagged.has(u));
  say(untagged.length === 0, `every script loaded is a tag with its integrity${untagged.length ? `: not a tag: ${untagged.join(", ")}` : ""}`);

  const loads = rec.loads ?? [];
  say(loads.length === ROUTES.length * WIDTHS.length, `${loads.length} loads of ${ROUTES.length * WIDTHS.length} (every route at both widths)`);
  for (const l of loads) {
    const bad = [];
    if (l.route !== l.expect) bad.push(`drew ${l.route ?? "nothing"}`);
    if (l.violations.length) bad.push(`CSP violation: ${l.violations.map((v) => `${v.directive} ${v.blocked}`).join("; ")}`);
    if (l.consoleErrors.length) bad.push(`console error: ${l.consoleErrors.join("; ")}`);
    if (!(l.cls <= CLS_MAX)) bad.push(`CLS ${l.cls.toFixed(4)} above ${CLS_MAX}`);
    if (l.hscroll) bad.push("horizontal scroll");
    if (l.smallText.length) bad.push(`text under 11 px: ${l.smallText.join(", ")}`);
    if (l.smallTaps.length) bad.push(`tap under 44 px: ${l.smallTaps.join(", ")}`);
    if (!l.shot) bad.push("no screenshot");
    say(bad.length === 0, `${l.width} ${l.path} (${l.expect}): ${bad.length ? bad.join("; ") : `CLS ${l.cls.toFixed(4)}, no violation, no error`}`);
  }

  const shells = rec.inShell ?? [];
  say(shells.length === WIDTHS.length, `the shell clicked through at ${shells.length} width(s) of ${WIDTHS.length}`);
  for (const s of shells) {
    const bad = [];
    if (s.cls !== 0) bad.push(`CLS ${s.cls.toFixed(4)} inside the shell`);
    if (s.steps.length === 0) bad.push("no navigation link");
    for (const st of s.steps) {
      if (st.reloaded) bad.push(`${st.href} reloaded the page`);
      if (st.route !== st.expect) bad.push(`${st.href} drew ${st.route ?? "nothing"}`);
    }
    if (s.violations.length || s.consoleErrors.length) bad.push(`${s.violations.length} CSP violation(s), ${s.consoleErrors.length} console error(s)`);
    say(bad.length === 0, `${s.width} inside the shell, ${s.steps.length} link(s): ${bad.length ? bad.join("; ") : "CLS 0, no reload"}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
// runs in the page before any of its own code: CSP violations and every layout shift
const INIT = () => {
  window.__ct = { violations: [], shifts: [], doc: Math.random() };
  document.addEventListener("securitypolicyviolation", (e) => window.__ct.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__ct.shifts.push(e.value);
  }).observe({ type: "layout-shift", buffered: true });
};

// runs in the page: R5's shoot.mjs checks (:68, :76-91, :92-108)
const MEASURE = ({ phone, vw }) => {
  const de = document.documentElement;
  const hscroll = Math.max(de.scrollWidth, document.body.scrollWidth, innerWidth) > vw + 0.5;
  const smallText = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (!t.textContent.trim()) continue;
    const el = t.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 10.95) smallText.add(`${el.tagName.toLowerCase()}:${fs}:${t.textContent.trim().slice(0, 12)}`);
  }
  const smallTaps = new Set();
  if (phone) {
    document.querySelectorAll("button, a, [data-hit]").forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) return;
      const hr = (b.closest("[data-hit]") || b).getBoundingClientRect();
      let w = hr.width;
      let h = hr.height;
      for (const ps of ["::before", "::after"]) {
        const cs = getComputedStyle(b, ps);
        if (cs.content && cs.content !== "none" && cs.position === "absolute") {
          w = Math.max(w, parseFloat(cs.width) || 0);
          h = Math.max(h, parseFloat(cs.height) || 0);
        }
      }
      if (Math.min(w, h) < 43.5) smallTaps.add(`${b.tagName.toLowerCase()}.${b.className}:${Math.round(w)}x${Math.round(h)}`);
    });
  }
  const scripts = [...document.querySelectorAll("script, link[rel=modulepreload]")].map((s) => ({ src: s.src || s.href || "", integrity: s.integrity || "" }));
  return {
    route: document.querySelector("main[data-route]")?.dataset.route ?? null,
    hscroll,
    smallText: [...smallText],
    smallTaps: [...smallTaps],
    scripts,
    violations: window.__ct.violations,
    cls: window.__ct.shifts.reduce((a, b) => a + b, 0),
    shiftCount: window.__ct.shifts.length,
    doc: window.__ct.doc,
  };
};

function watch(page) {
  const consoleErrors = [];
  const loadedScripts = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  // every frame's script is recorded with its frame's address and whether that frame is the page's top frame
  page.on("response", (r) => {
    if (r.request().resourceType() !== "script") return;
    const f = r.frame();
    loadedScripts.push({ url: r.url(), frame: f.url(), top: f === page.mainFrame() });
  });
  return { consoleErrors, loadedScripts };
}

export async function collect({ url = APP_HOST, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), fetchFn = fetch } = {}) {
  const origin = new URL(url).origin;
  // playwright is the terminal's dev dependency (apps/terminal/package.json)
  const { chromium } = createRequire(new URL("../../apps/terminal/package.json", import.meta.url))("playwright");
  mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch();
  const rec = { url: origin, at: new Date().toISOString(), browser: browser.version(), headers: null, scripts: [], loadedScripts: [], loads: [], inShell: [] };
  const seen = new Map();
  try {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      await ctx.addInitScript(INIT);
      for (const [id, p] of ROUTES) {
        const page = await ctx.newPage();
        const seenBy = watch(page);
        const resp = await page.goto(origin + p, { waitUntil: "load" });
        if (!rec.headers) {
          const h = resp.headers();
          rec.headers = { csp: h["content-security-policy"] ?? "", integrityPolicy: h["integrity-policy"] ?? "" };
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(SETTLE_MS);
        const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
        const shot = path.join(shots, `${w.name}-${id}.png`);
        await page.screenshot({ path: shot });
        for (const s of m.scripts) seen.set(`${s.src} ${s.integrity}`, s);
        rec.loadedScripts.push(...seenBy.loadedScripts);
        rec.loads.push({ width: w.name, path: p, expect: id, route: m.route, violations: m.violations, consoleErrors: seenBy.consoleErrors, cls: m.cls, shiftCount: m.shiftCount, hscroll: m.hscroll, smallText: m.smallText, smallTaps: m.smallTaps, shot });
        await page.close();
      }
      // inside the shell: load the first route, then click every navigation link in turn
      const page = await ctx.newPage();
      const seenBy = watch(page);
      await page.goto(origin + "/", { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(SETTLE_MS);
      const start = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      const hrefs = await page.$$eval(w.nav, (as) => as.map((a) => a.getAttribute("href")));
      const steps = [];
      // with no link drawn there is nothing to click; judge() reads the empty steps as a failure
      for (const href of hrefs.length ? [...hrefs.slice(1), hrefs[0]] : []) {
        await page.click(`${w.nav.split(",").map((s) => `${s.trim()}[href="${href}"]`).join(", ")}`);
        await page.waitForTimeout(400);
        const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
        steps.push({ href, expect: ROUTES.find(([, p]) => p === href)?.[0] ?? null, route: m.route, reloaded: m.doc !== start.doc });
      }
      const end = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      await page.screenshot({ path: path.join(shots, `${w.name}-in-shell.png`) });
      rec.inShell.push({ width: w.name, steps, cls: end.cls - start.cls, violations: end.violations, consoleErrors: seenBy.consoleErrors });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  for (const s of seen.values()) {
    let served = null;
    if (s.src) served = sha384(Buffer.from(await (await fetchFn(s.src)).arrayBuffer()));
    rec.scripts.push({ ...s, served });
  }
  rec.loadedScripts = [...new Map(rec.loadedScripts.map((l) => [`${l.top} ${l.frame} ${l.url}`, l])).values()];
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", APP_HOST), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
