#!/usr/bin/env node
// Live check of card app-near-trading: the deployed app trades NEAR tokens. Headless Chromium opens a NEAR token's page,
// /token/near/<id> on APP_HOST, at 1440 x 900 (desktop) and 390 x 844 (phone, dpr 2, touch), the id the top of NEAR's
// Trending list as the helper answers it now (GET /v1/market/lists?chain=near on HELPER_HOST, Discover's own order:
// columnRows of apps/terminal/src/screens/discover/model.ts), finds the frame that draws the token route (APP_HOST runs
// inside SIGN_HOST's shell) and reads:
//   - the served JS: the app's scripts carry the NEAR buy and sell requests, the kit's pool.buy and pool.sell with chain
//     near (apps/terminal/src/screens/trade/model.ts nearBuyAsk and tradeSellAsk, as the build writes them);
//   - the page: main[data-route="token"] draws the page ready for that id, and the trade box (the desktop column at
//     1440; the trade sheet the bar's Buy opens at 390) takes NEAR's path (data-path near), with its main button and its
//     four presets drawn.
// A screenshot of every load is kept. Signs nothing and moves nothing: the page is read signed out.
// After: app
//   node scripts/live-checks/app-near-trading.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute "tap",
// signed out), the helper still answered live; --record writes what the run read, so the check's test replays it.
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { columnRows } from "../../apps/terminal/src/screens/discover/model.ts";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-near-trading";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const LISTS_URL = `${HELPER_HOST}/v1/market/lists?chain=near`;
/** The NEAR requests as the build writes them (esbuild keeps property names and the literals). */
export const MARKS = {
  buy: /kind:[`"']pool\.buy[`"'],params:\{chain:[`"']near[`"']/,
  sell: /kind:[`"']pool\.sell[`"'],params:\{chain:[`"']near[`"'],token:[\w$]+,share_bps:/,
};
export const LOADS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READ_MS = 25_000;

/** The top of NEAR's Trending column (Discover's order) of the helper's answer, or null. */
export function topOf(answer) {
  const rows = (answer?.lists?.trending_1h?.length ? answer.lists.trending_1h : answer?.lists?.trending) ?? [];
  const near = rows.filter((r) => r?.chain === "near" && typeof r.token === "string");
  return columnRows({ chain: "near", as_of_ms: 0, lists: { new: [], trending: near, trending_1h: near } }, "trending")[0]?.token ?? null;
}

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.lists?.status === 200 && typeof rec.top === "string", `NEAR's lists answered ${rec.lists?.status ?? "nothing"}, the top of Trending ${rec.top ?? "none"}`);
  const loads = rec.loads ?? [];
  say(loads.length === LOADS.length, `${loads.length} loads of ${LOADS.length} (1440 and 390)`);
  for (const l of loads) {
    const js = l.scripts ?? [];
    const jsBad = [];
    if (js.length === 0) jsBad.push("no script read");
    for (const s of js) if (s.status !== 200) jsBad.push(`${s.url} answered ${s.status}`);
    for (const k of Object.keys(MARKS)) if (!js.some((s) => s.marks?.[k])) jsBad.push(`no NEAR ${k} request (pool.${k} with chain near) in the served JS`);
    say(jsBad.length === 0, `${l.width}: the served JS (${js.length} script(s)) ${jsBad.length ? jsBad.join("; ") : "carries the NEAR buy and sell requests"}`);
    const bad = [];
    if (l.route !== "token") bad.push(`drew ${l.route ?? "nothing"}`);
    else if (l.state !== "ready") bad.push(`state ${l.state ?? "none"}, not ready`);
    if (l.shown !== rec.top || l.chain !== "near") bad.push(`the page is ${l.chain ?? "none"}/${l.shown ?? "none"}, not near/${rec.top}`);
    if (l.box?.path !== "near") bad.push(`the trade box's path is ${l.box?.path ?? "no box"}, not near`);
    if (!l.box?.cta) bad.push("the box draws no main button");
    if (l.box?.presets !== 4) bad.push(`${l.box?.presets ?? 0} presets, not 4`);
    if (!l.shot) bad.push("no screenshot");
    say(bad.length === 0, `${l.width}: ${bad.length ? bad.join("; ") : `ready, near/${l.shown} (${l.symbol}), the trade box on NEAR's path ("${l.box.cta}", ${l.box.presets} presets)`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
const MEASURE = (phone) => {
  const root = document.querySelector('main[data-route="token"]');
  const p = root?.querySelector("[data-token-page]");
  const vis = [...(root?.querySelectorAll("h1.tkp-sym") ?? [])].find((e) => e.getClientRects().length);
  const box = document.querySelector(phone ? '[data-sheet="trade"] [data-testid="trade-box"]' : '.tkp-desk .tkp-trade [data-testid="trade-box"]');
  return {
    route: root?.dataset.route ?? null,
    state: p?.getAttribute("data-token-page") ?? null,
    shown: p?.getAttribute("data-token") ?? null,
    chain: p?.getAttribute("data-chain") ?? location.pathname.split("/")[2] ?? null,
    symbol: vis?.textContent ?? null,
    box: box ? { path: box.getAttribute("data-path"), cta: box.querySelector('[data-testid="trade-cta"]')?.textContent?.trim() ?? null, presets: box.querySelectorAll('[data-testid="trade-presets"] button').length } : null,
  };
};

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  const res = await fetch(LISTS_URL);
  const answer = res.ok ? await res.json().catch(() => null) : null;
  const top = topOf(answer);
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "tap");
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, signed out, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), lists: { status: res.status, rows: answer?.lists?.trending?.length ?? null }, top, loads: [] };
  try {
    for (const w of top ? LOADS : []) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
      if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
      const page = await ctx.newPage();
      const scripts = [];
      page.on("response", (r) => {
        if (r.request().resourceType() === "script" && new URL(r.url()).origin === APP_HOST) scripts.push(r);
      });
      await page.goto(`${APP_HOST}/token/near/${encodeURIComponent(top)}`, { waitUntil: "load" });
      let app = null;
      let m = null;
      for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
        for (const f of page.frames()) {
          const x = await f.evaluate(MEASURE, w.isMobile).catch(() => null);
          if (x?.route) {
            app = f;
            m = x;
            break;
          }
        }
        if (m && m.state && m.state !== "loading") break;
      }
      // 390: the box is in the trade sheet the bar's Buy opens
      if (app && w.isMobile) {
        await app.locator(".tkp-buy").click({ timeout: 5_000 }).catch(() => {});
        await app.waitForSelector('[data-sheet="trade"] [data-testid="trade-box"]', { timeout: 5_000 }).catch(() => {});
      }
      await page.waitForTimeout(500);
      if (app) m = await app.evaluate(MEASURE, w.isMobile).catch(() => m);
      const shot = `${w.name}.png`;
      await page.screenshot({ path: path.join(shots, shot) });
      const js = [];
      for (const s of scripts) {
        const text = await s.text().catch(() => "");
        js.push({ url: s.url(), status: s.status(), bytes: text.length, marks: Object.fromEntries(Object.entries(MARKS).map(([k, re]) => [k, re.test(text)])) });
      }
      rec.loads.push({ width: w.name, framed: app ? app !== page.mainFrame() : null, ...(m ?? {}), scripts: js, shot });
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
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
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
