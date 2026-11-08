#!/usr/bin/env node
// Live check of card app-shell: the terminal's empty shell, as served at APP_HOST. The terminal runs only inside
// SIGN_HOST's shell (card app-in-shell): a visit to APP_HOST moves the top window to SIGN_HOST, which frames APP_HOST,
// so every read below is of the terminal's frame inside the shell. Headless Chromium loads every route at 390 x 844
// (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1) and reads:
//   - the page is served under a CSP and an Integrity-Policy (app-host-gate's headers, app.md 2.3);
//   - each load runs inside SIGN_HOST's shell (the top window on SIGN_HOST, the terminal in its frame);
//   - no CSP violation and no console error on any load;
//   - every script tag carries an integrity equal to the sha384 of the bytes served, no script is inline, and every
//     script an APP_HOST document loaded is one of those tags (the shell's own scripts are SIGN_HOST's to check);
//   - each route draws its own screen (main[data-route]), not the fallback;
//   - CLS 0 per load at both widths and 0 inside the shell (from the first screen's load through the click-through; a FAIL names each shift's element and its
//     rects before and after), every shift counted, the
//     hadRecentInput exclusion not applied (BAR-04, app.md:1102);
//   - no horizontal scroll, no text under 11 px, and on the phone no tap target under 44 px (BAR-10, app.md:1108; the
//     tests of R5's design/proto/tools/shoot.mjs:68, :76-91, :92-108).
// A screenshot of every load is kept at both widths.
// After: app
//   node scripts/live-checks/app-shell.mjs [--url <origin>] [--shots <dir>] [--record <file>]
//   node scripts/live-checks/app-shell.mjs --harness [--build <dir>] ...   the hosts' real names answered from local
//     files by Playwright's route, as app-in-shell.mjs --harness does: APP_HOST the terminal's build (apps/terminal/dist
//     or <dir>) under its own _headers, SIGN_HOST app-in-shell's stand-in shell
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read to <file>, so the check's test can replay it through judge().
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { consoleError } from "./console-errors.mjs";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-shell";
export const APP_HOST = "https://ct-app.unrealized.trade";
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
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, nav: ".tb .nav a, .ft .links a" },
];
const SETTLE_MS = 2000;

const sha384 = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/** What moved, for a FAIL line: each layout shift's time, value and sources (element, rect before -> after). */
const shiftsOf = (shifts) =>
  shifts?.length ? ` [${shifts.map((e) => `+${e.at}ms ${e.value.toFixed(4)}${e.input ? " after input" : ""}: ${e.sources.join(" | ") || "no source"}`).join("; ")}]` : "";

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
  // only an APP_HOST document's scripts count: the shell's are judged by SIGN_HOST's own checks (signpage-*); a script
  // not marked as another document's (a bare address, or no app mark) counts as APP_HOST's
  const loaded = (rec.loadedScripts ?? []).map((l) => (typeof l === "string" ? { url: l, app: true } : l));
  const untagged = [...new Set(loaded.filter((l) => l.app !== false).map((l) => l.url))].filter((u) => !tagged.has(u));
  say(untagged.length === 0, `every script loaded is a tag with its integrity${untagged.length ? `: not a tag: ${untagged.join(", ")}` : ""}`);

  const loads = rec.loads ?? [];
  say(loads.length === ROUTES.length * WIDTHS.length, `${loads.length} loads of ${ROUTES.length * WIDTHS.length} (every route at both widths)`);
  for (const l of loads) {
    const bad = [];
    if (l.framed !== true) bad.push(`not inside SIGN_HOST's shell (top window at ${l.top ?? "unknown"})`);
    if (l.route !== l.expect) bad.push(`drew ${l.route ?? "nothing"}`);
    if (l.violations.length) bad.push(`CSP violation: ${l.violations.map((v) => `${v.directive} ${v.blocked}`).join("; ")}`);
    if (l.consoleErrors.length) bad.push(`console error: ${l.consoleErrors.join("; ")}`);
    // every load holds still at both widths (card app-shell-tabbar-cls: a phone tab bar drawn before the frame had its
    // size moved 0.0806 under the old 0.1 limit and passed)
    if (l.cls !== 0) bad.push(`CLS ${l.cls.toFixed(4)} above 0${shiftsOf(l.shifts)}`);
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
    if (s.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (s.cls !== 0) bad.push(`CLS ${s.cls.toFixed(4)} inside the shell${shiftsOf(s.shifts)}`);
    if (s.steps.length === 0) bad.push("no navigation link");
    for (const st of s.steps) {
      if (st.reloaded) bad.push(`${st.href} reloaded the page`);
      if (st.route !== st.expect) bad.push(`${st.href} drew ${st.route ?? "nothing"}`);
    }
    if (s.violations.length || s.consoleErrors.length) bad.push(`${s.violations.length} CSP violation(s), ${s.consoleErrors.length} console error(s)${s.consoleErrors.length ? `: ${s.consoleErrors.join("; ")}` : ""}`);
    say(bad.length === 0, `${s.width} inside the shell, ${s.steps.length} link(s): ${bad.length ? bad.join("; ") : "CLS 0, no reload"}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
// runs in the page before any of its own code: CSP violations and every layout shift
export const INIT = () => {
  window.__ct = { violations: [], shifts: [], shiftLog: [], doc: Math.random() };
  document.addEventListener("securitypolicyviolation", (e) => window.__ct.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__ct.shifts.push(e.value);
      // what moved: each source's element and its rects before and after (a shift with no source is logged as such)
      const rect = (r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      const name = (n) => (n ? `${n.nodeName.toLowerCase()}${n.id ? `#${n.id}` : ""}${typeof n.className === "string" && n.className ? `.${n.className.trim().split(/\s+/).join(".")}` : ""}${n.nodeType === 1 && n.dataset?.state ? `[data-state=${n.dataset.state}]` : ""}` : "(removed)");
      window.__ct.shiftLog.push({ at: Math.round(e.startTime), value: e.value, input: e.hadRecentInput, sources: e.sources.map((x) => `${name(x.node)} ${rect(x.previousRect)} -> ${rect(x.currentRect)}`) });
    }
  }).observe({ type: "layout-shift", buffered: true });
};

// runs in the page: R5's shoot.mjs checks (:68, :76-91, :92-108)
export const MEASURE = ({ phone, vw }) => {
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
    shiftLog: window.__ct.shiftLog,
    doc: window.__ct.doc,
  };
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/** The check's console hook: every error an APP_HOST document (or one with no address) logs, kept through the shared
 *  collector (console-errors.mjs) as its text and its address's origin and path; the shell's are SIGN_HOST's to check. */
export function onConsole(consoleErrors) {
  return (m) => m.type() === "error" && originOf(m.location()?.url ?? "") !== SIGN_HOST && consoleErrors.push(consoleError(m));
}

function watch(page, origin) {
  const consoleErrors = [];
  const loadedScripts = [];
  page.on("console", onConsole(consoleErrors));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  // every frame's script is recorded with its frame's address and whether that frame shows an APP_HOST document
  page.on("response", (r) => {
    if (r.request().resourceType() !== "script") return;
    const f = r.frame();
    loadedScripts.push({ url: r.url(), frame: f.url(), app: originOf(f.url()) === origin });
  });
  return { consoleErrors, loadedScripts };
}

/** The terminal's frame inside SIGN_HOST's shell, waited for up to 8 s; null when there is none. */
async function terminalFrame(page, origin) {
  const until = Date.now() + 8_000;
  for (;;) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === origin);
    if (f || Date.now() > until) return f ?? null;
    await page.waitForTimeout(100);
  }
}

/** The document a load is judged on: the terminal's frame inside the shell, or, when there is none, the top window. */
async function open(page, url, origin) {
  const resp = await page.goto(url, { waitUntil: "load" });
  const f = await terminalFrame(page, origin);
  if (f) await f.waitForLoadState("load").catch(() => {});
  const framed = f !== null && originOf(page.url()) === SIGN_HOST;
  return { resp, doc: f ?? page.mainFrame(), framed, top: page.url() };
}

// `route`: the harness's answers for the hosts' real names (app-in-shell.mjs harnessRoute). `prepare(context)` runs on
// each fresh browser context after it, before any page opens: the terminal's own browser test (test/bar10) answers the
// helper there.
export async function collect({ url = APP_HOST, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), fetchFn = fetch, route = null, source = "live", prepare = null } = {}) {
  const origin = new URL(url).origin;
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  const rec = { url: origin, source, at: new Date().toISOString(), browser: browser.version(), headers: null, scripts: [], loadedScripts: [], loads: [], inShell: [] };
  const seen = new Map();
  try {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      if (route) await ctx.route("**/*", route);
      await ctx.addInitScript(INIT);
      if (prepare) await prepare(ctx);
      for (const [id, p] of ROUTES) {
        const page = await ctx.newPage();
        const seenBy = watch(page, origin);
        const { resp, doc, framed, top } = await open(page, origin + p, origin);
        if (!rec.headers) {
          const h = resp.headers();
          rec.headers = { csp: h["content-security-policy"] ?? "", integrityPolicy: h["integrity-policy"] ?? "" };
        }
        await doc.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(SETTLE_MS);
        const m = await doc.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
        // the record keeps the file's name only: the folder is the recorder's own, printed once at the end
        const shot = `${w.name}-${id}.png`;
        await page.screenshot({ path: path.join(shots, shot) });
        for (const s of m.scripts) seen.set(`${s.src} ${s.integrity}`, s);
        rec.loadedScripts.push(...seenBy.loadedScripts);
        rec.loads.push({ width: w.name, path: p, expect: id, framed, top, route: m.route, violations: m.violations, consoleErrors: seenBy.consoleErrors, cls: m.cls, shiftCount: m.shiftCount, shifts: m.shiftLog, hscroll: m.hscroll, smallText: m.smallText, smallTaps: m.smallTaps, shot });
        await page.close();
      }
      // inside the shell: load the first route, then click every navigation link in turn
      const page = await ctx.newPage();
      const seenBy = watch(page, origin);
      const { doc, framed } = await open(page, origin + "/", origin);
      await doc.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(SETTLE_MS);
      const start = await doc.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      const hrefs = await doc.$$eval(w.nav, (as) => as.map((a) => a.getAttribute("href")));
      const steps = [];
      // with no link drawn there is nothing to click; judge() reads the empty steps as a failure
      for (const href of hrefs.length ? [...hrefs.slice(1), hrefs[0]] : []) {
        await doc.click(`${w.nav.split(",").map((s) => `${s.trim()}[href="${href}"]`).join(", ")}`);
        await page.waitForTimeout(400);
        const m = await doc.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
        steps.push({ href, expect: ROUTES.find(([, p]) => p === href)?.[0] ?? null, route: m.route, reloaded: m.doc !== start.doc });
      }
      const end = await doc.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      await page.screenshot({ path: path.join(shots, `${w.name}-in-shell.png`) });
      rec.inShell.push({ width: w.name, framed, steps, cls: end.cls, shifts: end.shiftLog, violations: end.violations, consoleErrors: seenBy.consoleErrors });
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
  rec.loadedScripts = [...new Map(rec.loadedScripts.map((l) => [`${l.app} ${l.frame} ${l.url}`, l])).values()];
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let rec;
    if (a.includes("--harness")) {
      const build = path.resolve(opt("--build", fileURLToPath(new URL("../../apps/terminal/dist", import.meta.url))));
      // the bytes served for a script are the build's own file at its path
      const fetchFn = async (u) => new Response(readFileSync(path.join(build, decodeURIComponent(new URL(u).pathname))));
      rec = await collect({ shots: opt("--shots", undefined), fetchFn, route: await harnessRoute(build), source: `harness, ${named(build)}` });
    } else rec = await collect({ url: opt("--url", APP_HOST), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
