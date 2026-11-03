#!/usr/bin/env node
// Live check of card app-discover-live: Discover runs on the helper's live lists, as served at APP_HOST. Headless
// Chromium opens /discover at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1), waits for Discover to
// leave its loading state and reads:
//   - Discover is routed: a main[data-route="discover"] draws the screen, ready (not loading, not offline);
//   - rows render: each column's header count equals the rows it draws, and New and Trending hold rows (Hot and
//     Graduating may be empty on a quiet minute: they are listed, not required);
//   - Trending draws the 1h buys and sells on desktop (the field pair the helper added for it);
//   - the page read GET /v1/market/lists?chain=solana at HELPER_HOST, 200, and every row of the answer it read holds
//     exactly the terminal's ROW_FIELDS, in order, read from apps/terminal/src/screens/discover/fields.ts itself
//     (the live shape equals the fixtures');
//   - no CSP violation and no console error in Discover's frame;
//   - every request Discover's frame made (and the navigation of its own child frames) is to a host its CSP lets that
//     kind of request reach.
// The page may be the top document (APP_HOST today) or a frame inside another page (APP_HOST inside SIGN_HOST's
// frame, card signpage-shell): the check looks through every frame for the one that draws Discover, takes the CSP
// from that frame's own document answer, and counts only that frame's requests and errors. A script of the outer page
// or of a hidden frame is judged by its own host's checks (app-shell, signpage-*).
// A screenshot of every width is kept.
//   node scripts/live-checks/app-discover-live.mjs [--url <page>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --url is the page to open (default APP_HOST/discover); --record writes what the run read, so the check's test can
// replay it through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROW_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";
import { launchBrowser } from "../browsers.mjs";

const KEY = "app-discover-live";
export const APP_HOST = "https://confidential.unrealized.trade";
export const HELPER_HOST = "https://api.confidential.unrealized.trade";
export const LISTS_URL = `${HELPER_HOST}/v1/market/lists?chain=solana`;
export const COLUMNS = ["new", "trending", "hot", "graduating"];
/** The columns that must hold rows: the helper's own check requires `new` and `trending_1h` to hold rows. */
export const REQUIRED = ["new", "trending"];
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READ_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the CSP
/** A CSP header as { directive: [sources] }. */
export function parseCsp(csp) {
  const out = {};
  for (const part of String(csp ?? "").split(";")) {
    const [name, ...src] = part.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] ??= src;
  }
  return out;
}

const DIRECTIVE = { fetch: "connect-src", xhr: "connect-src", eventsource: "connect-src", websocket: "connect-src", ping: "connect-src", image: "img-src", media: "media-src", script: "script-src", stylesheet: "style-src", font: "font-src", document: "frame-src", manifest: "manifest-src", other: "connect-src" };

/** Whether the CSP of a document at `self` lets a request of `type` reach `url`. */
export function allowed(csp, type, url, self) {
  const d = DIRECTIVE[type] ?? "default-src";
  const sources = csp[d] ?? csp["default-src"] ?? null;
  if (sources === null) return true;
  const u = new URL(url);
  for (const s of sources) {
    if (s === "'self'") {
      if (u.origin === self) return true;
    } else if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) {
      if (u.protocol === s.toLowerCase()) return true;
    } else if (!s.startsWith("'") && !s.includes("*")) {
      // a host source with a scheme, as the shipped policy writes them
      try {
        if (new URL(s).origin === u.origin) return true;
      } catch {
        // not a URL: no match
      }
    }
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The first thing wrong with one answer row's keys, or null. */
export function keysFault(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "not an object";
  const keys = Object.keys(row);
  const missing = ROW_FIELDS.filter((f) => !keys.includes(f));
  const extra = keys.filter((k) => !ROW_FIELDS.includes(k));
  if (missing.length || extra.length) return `${missing.length ? `missing ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `extra ${extra.join(", ")}` : ""}`;
  return keys.join() === ROW_FIELDS.join() ? null : "keys in another order";
}

/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(loads.length === WIDTHS.length, `${loads.length} loads of ${WIDTHS.length} (every width)`);
  for (const l of loads) {
    const tag = `${l.width} ${l.path}${l.framed ? " (framed)" : ""}`;
    const bad = [];
    if (l.route !== "discover") bad.push(`drew ${l.route ?? "nothing"}`);
    else if (l.state !== "ready") bad.push(`state ${l.state ?? "none"}, not ready`);
    for (const c of l.columns ?? []) {
      if (c.count !== c.rows) bad.push(`${c.key} says ${c.count}, draws ${c.rows}`);
      if (REQUIRED.includes(c.key) && !(c.rows > 0)) bad.push(`${c.key} draws no rows`);
    }
    if ((l.columns ?? []).length !== COLUMNS.length) bad.push(`${(l.columns ?? []).length} of ${COLUMNS.length} columns read`);
    if (l.trendingSides !== null && !(l.trendingSides > 0)) bad.push("Trending draws no 1h buys and sells");
    if (!l.csp || !l.csp["connect-src"]) bad.push("no CSP on Discover's document");
    if (l.violations.length) bad.push(`CSP violation: ${l.violations.map((v) => `${v.directive} ${v.blocked}`).join("; ")}`);
    if (l.consoleErrors.length) bad.push(`console error: ${l.consoleErrors.join("; ")}`);
    const off = l.requests.filter((r) => !allowed(l.csp ?? {}, r.type, r.url, l.origin));
    if (off.length) bad.push(`${off.length} request(s) off the CSP: ${[...new Set(off.map((r) => `${r.type} ${new URL(r.url).origin}`))].join(", ")}`);
    if (!l.shot) bad.push("no screenshot");
    const rows = (l.columns ?? []).map((c) => `${c.key} ${c.rows}`).join(", ");
    say(bad.length === 0, `${tag}: ${bad.length ? bad.join("; ") : `ready, ${rows}; ${l.requests.length} request(s), all on the CSP; no violation, no error`}`);

    const a = l.lists;
    const abad = [];
    if (!a) abad.push("the page read no lists answer");
    else {
      if (a.url !== LISTS_URL) abad.push(`read ${a.url}`);
      if (a.status !== 200) abad.push(`status ${a.status}`);
      if (a.badRows.length) abad.push(`${a.badRows.length} of ${a.rows} row(s) differ from ROW_FIELDS, first ${a.badRows[0].list}[${a.badRows[0].index}]: ${a.badRows[0].fault}`);
      if (!(a.rows > 0)) abad.push("no rows");
    }
    say(abad.length === 0, `${tag}: the lists read at HELPER_HOST ${a ? `${a.status}, ${a.rows} rows each with exactly the ${ROW_FIELDS.length} fields of the fixtures${abad.length ? `: ${abad.join("; ")}` : ""}` : abad.join("; ")}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
// runs in every frame before its own code: CSP violations
const INIT = () => {
  window.__ct = { violations: [] };
  document.addEventListener("securitypolicyviolation", (e) => window.__ct.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
};

/** In the frame that draws Discover: its state, its columns (visible ones), and Trending's buys and sells. */
const MEASURE = ({ phone }) => {
  const vis = (e) => e.getClientRects().length > 0;
  const root = document.querySelector('main[data-route="discover"]');
  const dsc = root?.querySelector(".dsc");
  const columns = [];
  let trendingSides = null;
  if (dsc && !phone) {
    for (const col of dsc.querySelectorAll(".dsc-grid .dsc-col")) {
      const rows = [...col.querySelectorAll('[role="listitem"]')].filter(vis).length;
      columns.push({ key: col.dataset.col, count: Number(col.querySelector(".dsc-count")?.textContent), rows });
    }
    const t = [...dsc.querySelectorAll('.dsc-col[data-col="trending"] .dsc-bs')].filter(vis);
    trendingSides = t.filter((e) => /^[\d.,KM]+\/[\d.,KM]+$/.test(e.textContent.trim())).length;
  }
  return { route: root?.dataset.route ?? null, state: dsc?.dataset.discover ?? null, columns, trendingSides };
};

export async function collect({ url = `${APP_HOST}/discover`, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), prepare = null } = {}) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  const rec = { url, at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      await ctx.addInitScript(INIT);
      if (prepare) await prepare(ctx);
      const page = await ctx.newPage();
      const requests = [];
      const navs = [];
      const consoleErrors = [];
      let lists = null;
      page.on("request", (r) => requests.push(r));
      page.on("response", (r) => {
        if (r.request().isNavigationRequest()) navs.push(r);
        if (r.url() === LISTS_URL && !lists) lists = r;
      });
      page.on("console", (m) => m.type() === "error" && consoleErrors.push({ text: m.text(), src: m.location().url }));
      page.on("pageerror", (e) => consoleErrors.push({ text: String(e), src: "" }));
      await page.goto(url, { waitUntil: "load" });
      // the frame that draws Discover (the page itself, or one inside it), once it has left its loading state
      const stateOf = (f) => f.evaluate(() => document.querySelector('main[data-route="discover"] .dsc')?.dataset.discover ?? null).catch(() => null);
      let app = null;
      for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
        app = null;
        let state = null;
        for (const f of page.frames()) {
          state = await stateOf(f);
          if (state) {
            app = f;
            break;
          }
        }
        if (app && state !== "loading") break;
      }
      await page.waitForTimeout(500);
      const target = app ?? page.mainFrame();
      await target.evaluate(() => document.fonts.ready).catch(() => {});
      const m = await target.evaluate(MEASURE, { phone: w.isMobile }).catch(() => ({ route: null, state: null, columns: [], trendingSides: null }));
      if (w.isMobile && m.state) {
        // the phone holds one list at a time: read each tab
        for (const key of COLUMNS) {
          await target.click(`.dsc-tab[data-tab="${key}"]`);
          const c = await target.evaluate((k) => {
            const vis = (e) => e.getClientRects().length > 0;
            return { key: k, count: Number(document.querySelector(`.dsc-tab[data-tab="${k}"] .dsc-count`)?.textContent), rows: [...document.querySelectorAll('.dsc-phone [role="listitem"]')].filter(vis).length };
          }, key);
          m.columns.push(c);
        }
        await target.click('.dsc-tab[data-tab="new"]');
      }
      const shot = path.join(shots, `${w.name}-discover.png`);
      await page.screenshot({ path: shot });
      const origin = new URL(target.url()).origin;
      // the frame's own document answers under its own CSP (read below); only what it loads, and the frames it opens, are judged
      const nav = (r) => r.isNavigationRequest();
      const own = (r) => r.frame() === target && !nav(r);
      const childNav = (r) => nav(r) && r.frame().parentFrame() === target;
      const doc = navs.filter((r) => r.frame() === target).pop();
      let body = null;
      if (lists) body = await lists.json().catch(() => null);
      const badRows = [];
      let rows = 0;
      if (body && typeof body === "object" && body.lists && typeof body.lists === "object") {
        for (const [list, rs] of Object.entries(body.lists)) {
          for (const [i, row] of (Array.isArray(rs) ? rs : []).entries()) {
            rows++;
            const fault = keysFault(row);
            if (fault) badRows.push({ list, index: i, fault });
          }
        }
      }
      const violations = await target.evaluate(() => window.__ct?.violations ?? []).catch(() => []);
      rec.loads.push({
        width: w.name,
        path: new URL(target.url()).pathname,
        origin,
        framed: target !== page.mainFrame(),
        route: m.route,
        state: m.state,
        columns: m.columns,
        trendingSides: m.trendingSides,
        csp: doc ? parseCsp(doc.headers()["content-security-policy"]) : null,
        violations,
        consoleErrors: consoleErrors.filter((e) => e.src === "" || e.src.startsWith(origin) || e.src.startsWith(HELPER_HOST)).map((e) => e.text),
        requests: requests.filter((r) => own(r) || childNav(r)).map((r) => ({ url: r.url().startsWith("data:") ? r.url().slice(0, 40) : r.url(), type: r.resourceType() })),
        lists: lists ? { url: lists.url(), status: lists.status(), rows, badRows } : null,
        shot,
      });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", `${APP_HOST}/discover`), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
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
