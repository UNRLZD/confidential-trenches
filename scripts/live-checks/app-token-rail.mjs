#!/usr/bin/env node
// Live check of card app-token-rail: the token page's left rail lists Trending and New, as design-lock-r5 draws it
// (trenches-1440.html rail, proto.css .rail and .rr, token.css's width modes). Three reads:
//   - the rail's data on Solana: HELPER_HOST's GET /v1/market/lists?chain=solana, one of the chains of Discover's own
//     read that the rail draws (every chain's since card app-chains-evm-rail, whose check reads Base and Robinhood). It
//     must answer 200 with a Solana snapshot whose Trending column (the 1h list, rows traded in the hour) and New column
//     each hold at least one row with a token id and a symbol;
//   - what APP_HOST serves: the page, then every script and stylesheet it names, which must hold the rail (token-rail,
//     rail-expand, tkr-row, tkr-chip) and its rules (.tkr-row, .tkr-exp) with both width modes (the slim rail on a page
//     box under 1527 layout px: 1526.98px; no rail under 1180: 1179.98px);
//   - the rail as drawn at 1440 x 900 (card app-token-rail-r5-fit, research repo docs/owner-decisions.md 8 Nov 19:40Z):
//     headless Chrome opens APP_HOST/ inside SIGN_HOST's shell, finds the terminal's frame and reads the rail's mode off
//     the drawn rail. At 1440 the page is a 1920 layout px page (shell/fit.ts), where the full rail fits uncut, so the
//     rail must be full (340 layout px with its head and chips), as R5's picture at 1440.
// The behaviour (each mode's width, the strip whole at every width from 1100 to 1920, a rail click opening its token,
// New, the slim rail's expand, CLS 0, signed in and out) is the terminal's own browser runs,
// apps/terminal/test/token-rail/run.mjs and sweep.mjs, and the data store apps/terminal/test/token-rail.test.ts.
// After: app
// Bundle: out a browser and the helper
//   node scripts/live-checks/app-token-rail.mjs [--url <url>] [--helper <url>] [--record <file>] [--shots <dir>]
//   node scripts/live-checks/app-token-rail.mjs --build <dir> [...]   a local build (apps/terminal/dist, built first):
//     its files read from disk, the page drawn at APP_HOST's name inside the stand-in shell (app-in-shell.mjs
//     harnessRoute); the helper is still read live
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (--build: a FAIL while the helper missed an answer, helper-misses.mjs)
// --record writes what the run read (the lists answer's counts, the markers each file holds, not the files, and the
// drawn rail's mode and width), so the check's test can replay it.
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { liveHelper, verdictOf as helperVerdict, EXIT as HELPER_EXIT, helperFetch } from "./helper-misses.mjs";

const KEY = "app-token-rail";
export const APP_URL = "https://ct-app.unrealized.trade/";
export const HELPER_URL = "https://ct-api.unrealized.trade";
/** The width the rail's mode is read at: R5's own picture's (research repo design/proto/shots/02-trenches-S7.1-1440.png). */
export const VIEWPORT = { width: 1440, height: 900 };
const READ_MS = 20_000;
// each a test id or class only the rail draws
export const JS_MARKERS = ["token-rail", "rail-expand", "tkr-row", "tkr-chip"];
// the rail's rules and its two width modes (rail.css, token.css .tkp-desk), in the page's layout px
export const CSS_MARKERS = [".tkr-row", ".tkr-exp", "1526.98px", "1179.98px"];

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isRow = (r) => isObject(r) && typeof r.token === "string" && r.token !== "" && typeof r.symbol === "string" && r.symbol !== "";
const vol = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : 0);

/** The facts of one lists answer the verdict reads: the rows each rail list would draw, counted, not kept. Trending as
 *  Discover's column takes it (the 1h list, else `trending`, rows with an hour's volume); New, every row. */
export function listsFacts(status, body) {
  const b = isObject(body) ? body : {};
  const L = isObject(b.lists) ? b.lists : {};
  const trendingList = Array.isArray(L.trending_1h) ? L.trending_1h : Array.isArray(L.trending) ? L.trending : null;
  return {
    status,
    chain: b.chain ?? null,
    trending: trendingList === null ? null : trendingList.filter((r) => isRow(r) && vol(r.vol_1h_usd) > 0).length,
    new: Array.isArray(L.new) ? L.new.filter(isRow).length : null,
  };
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, lists: { status, chain, trending, new }, pageStatus, js, css }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const l = rec.lists ?? {};
  say(l.status === 200 && l.chain === "solana", `the helper's lists read answers ${l.status ?? "nothing"} for ${l.chain ?? "no chain"}`);
  say(Number.isSafeInteger(l.trending) && l.trending > 0, `the rail's Trending list holds ${l.trending ?? "no"} row(s) traded in the hour`);
  say(Number.isSafeInteger(l.new) && l.new > 0, `the rail's New list holds ${l.new ?? "no"} row(s)`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.length > 0 && css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const jsHeld = new Set(js.flatMap((f) => f.found ?? []));
  const missJs = JS_MARKERS.filter((m) => !jsHeld.has(m));
  say(missJs.length === 0, missJs.length ? `the scripts lack the rail: ${missJs.join(", ")}` : `the scripts hold the rail: ${JS_MARKERS.join(", ")}`);
  const cssHeld = new Set(css.flatMap((f) => f.found ?? []));
  const missCss = CSS_MARKERS.filter((m) => !cssHeld.has(m));
  say(missCss.length === 0, missCss.length ? `the stylesheets lack the rail's rules: ${missCss.join(", ")}` : `the stylesheets hold the rail's rules and width modes: ${CSS_MARKERS.join(", ")}`);
  const d = rec.drawn ?? {};
  say(d.state === "ready", `at ${VIEWPORT.width}: the token page is ${d.state ?? "not drawn"}`);
  say(d.mode === "full" && d.width === 340 && d.head === true, `at ${VIEWPORT.width}: the rail is ${d.mode ?? "not read"}${Number.isFinite(d.width) ? ` (${d.width} layout px${d.head ? ", its head drawn" : ", no head"})` : ""}; want the full rail (340 with its head), as R5 draws it at ${VIEWPORT.width}`);
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await helperFetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  return { status: r.status, text: await r.text() };
}

/** The rail as drawn in a frame: its mode (none when not drawn), its width in layout px, its head; the page's state. */
const RAIL = () => {
  const page = document.querySelector("[data-token-page]");
  if (!page) return null;
  const rail = document.querySelector('.tkp-desk [data-testid="token-rail"]');
  const vis = (e) => !!e && e.getClientRects().length > 0;
  return {
    state: page.getAttribute("data-token-page"),
    rail: rail?.getAttribute("data-state") ?? null,
    mode: !vis(rail) ? "none" : rail.getAttribute("data-slim") === "true" ? "slim" : "full",
    width: vis(rail) ? rail.offsetWidth : null,
    head: vis(rail?.querySelector('[data-testid="rail-head"]')),
  };
};

/** APP_HOST/ at VIEWPORT in headless Chrome (a build at APP_HOST's name in the stand-in shell when `build` is set): the
 *  rail once the page and the rail are drawn, and a screenshot. */
export async function drawn({ url = APP_URL, build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "tap");
  }
  const browser = await (harness ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
    if (harness) await liveHelper(ctx, harness);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load" });
    let m = null;
    let app = null;
    for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
      for (const f of app ? [app] : page.frames()) {
        const x = await f.evaluate(RAIL).catch(() => null);
        if (x) {
          app = f;
          m = x;
          break;
        }
      }
      if (m && m.state !== "loading" && m.rail !== "loading") break;
    }
    await page.waitForTimeout(400);
    if (app) m = (await app.evaluate(RAIL).catch(() => null)) ?? m;
    const shot = path.join(shots, `rail-${VIEWPORT.width}.png`);
    await page.screenshot({ path: shot });
    return { browser: browser.version(), shot, ...(m ?? {}) };
  } finally {
    await browser.close();
  }
}

export async function collect({ url = APP_URL, helper = HELPER_URL, root = null, build = null, shots } = {}) {
  const lr = await http(`${helper}/v1/market/lists?chain=solana`);
  let body = null;
  try {
    body = JSON.parse(lr.text);
  } catch {}
  const read = async (ref, base) => {
    if (root) {
      const file = path.join(root, new URL(ref, "http://x/").pathname);
      try {
        return { status: 200, text: readFileSync(file, "utf8") };
      } catch {
        return { status: 404, text: "" };
      }
    }
    return http(new URL(ref, base).href);
  };
  const page = root ? { status: 200, text: readFileSync(path.join(root, "index.html"), "utf8") } : await http(url);
  const { js, css } = assetsOf(page.text);
  const rec = { source: `${root ? `a local build read from ${path.basename(root)}${build ? ", drawn at APP_HOST's name in the stand-in shell" : ""}` : url}; ${helper}`, at: new Date().toISOString(), lists: listsFacts(lr.status, body), pageStatus: page.status, js: [], css: [] };
  for (const ref of js) {
    const f = await read(ref, url);
    rec.js.push({ url: ref, status: f.status, found: holds(f.text, JS_MARKERS) });
  }
  for (const ref of css) {
    const f = await read(ref, url);
    rec.css.push({ url: ref, status: f.status, found: holds(f.text, CSS_MARKERS) });
  }
  const d = await drawn({ url: build ? `${new URL(APP_URL).origin}/` : url, build, shots });
  rec.drawn = { state: d.state ?? null, mode: d.mode ?? null, width: d.width ?? null, head: d.head ?? false };
  rec.browser = d.browser;
  rec.shot = d.shot;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const build = opt("--build", null) ? path.resolve(opt("--build", null)) : null;
    const root = build ?? (opt("--root", null) ? path.resolve(opt("--root", null)) : null);
    const rec = await collect({ url: opt("--url", APP_URL), helper: opt("--helper", HELPER_URL), root, build, shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the screenshot
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shot: undefined }, null, 1)}\n`);
    const { ok: judged, lines } = judge(rec);
    for (const l of lines) console.log(l);
    // a FAIL in a run where the helper missed an answer the page asked for is INCONCLUSIVE (helper-misses.mjs)
    const miss = helperVerdict(judged ? "PASS" : "FAIL");
    for (const l of miss.lines) console.log(l);
    console.log(`screenshot: ${rec.shot}`);
    console.log(`CARD ${KEY} / live: ${miss.verdict} (${rec.source}; Chrome ${rec.browser})`);
    process.exit(HELPER_EXIT[miss.verdict]);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
