#!/usr/bin/env node
// Live check of card app-token-chart: the token page draws its price chart from the helper's candles. Node reads the
// helper's lists (GET /v1/market/lists?chain=solana, 200), takes a live mint (the third row of the Trending column as
// Discover orders it, app-token-route's pick) and reads its candles (GET /v1/market/candles?chain=solana&token=<mint>
// &tf=15m&limit=500): 200, an answer the page's own mapping takes (apps/terminal/src/screens/token/candles.ts
// toCandleData), at least one bar. Headless Chromium then opens APP_HOST/token/solana/<mint> at 1440 x 900 (desktop)
// and 390 x 844 (phone, dpr 2, touch), finds the terminal's frame inside SIGN_HOST's shell and reads, on the layout on
// screen:
//   - the page's own candle read: GET /v1/market/candles for that mint at 15m (the default), 200, and its bar count;
//   - the chart: data-chart="ready", a canvas drawn, and the bar count the chart holds (data-bars, read from the
//     library's own data list) equal to the bars the page's read answered;
//   - CoinGecko's label: shown exactly when the read's X-Helper-Source names geckoterminal.
// A screenshot of every load is kept.
//   node scripts/live-checks/app-token-chart.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute), the
// helper still answered live; --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { isGecko, toCandleData } from "../../apps/terminal/src/screens/token/candles.ts";
import { HELPER_HOST, LISTS_URL, pickOf } from "./app-token-route.mjs";

const KEY = "app-token-chart";
export const APP_HOST = "https://ct-app.unrealized.trade";
export { HELPER_HOST, LISTS_URL };
export const CANDLES_PATH = "/v1/market/candles";
export const CANDLES_URL = (mint) => `${HELPER_HOST}${CANDLES_PATH}?chain=solana&token=${encodeURIComponent(mint)}&tf=15m&limit=500`;
export const LOADS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READ_MS = 25_000;

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const lists = rec.lists ?? null;
  const mint = lists?.trending ? pickOf(lists.trending) : null;
  say(!!lists && lists.status === 200 && lists.url === LISTS_URL && !!mint, `the helper's lists: ${lists ? `${lists.status} at ${lists.url}` : "none"}, the live mint ${mint ?? "none"}`);
  const c = rec.candles ?? null;
  const cbad = [];
  if (!c) cbad.push("no candle read");
  else {
    if (!mint || c.mint !== mint || c.tf !== "15m" || c.limit !== "500" || c.chain !== "solana") cbad.push(`read for ${c.chain}/${c.mint} at ${c.tf} (limit ${c.limit})`);
    if (c.status !== 200) cbad.push(`status ${c.status}`);
    const d = c.status === 200 ? toCandleData(c.body, "15m", c.src ?? null) : null;
    if (c.status === 200 && d === null) cbad.push("an answer the page's mapping refuses");
    else if (d && d.status !== "ready") cbad.push("no bars");
  }
  say(cbad.length === 0, `the helper's candles for the mint: ${cbad.length ? cbad.join("; ") : `200, ${c.body.candles.length} bars at 15m, X-Helper-Source ${c.src}`}`);
  const loads = rec.loads ?? [];
  say(loads.length === LOADS.length, `${loads.length} loads of ${LOADS.length} (the live mint at 1440 and 390)`);
  for (const [i, l] of loads.entries()) {
    const tag = `${LOADS[i]?.name ?? l.width} /token/solana/<live mint>`;
    const bad = [];
    if (mint && l.opened !== `${APP_HOST}/token/solana/${mint}`) bad.push(`opened ${l.opened}`);
    if (l.tokenState !== "ready") bad.push(`the page is ${l.tokenState ?? "not drawn"}`);
    const r = l.read;
    if (!r) bad.push("the page read no candles");
    else {
      if (r.mint !== mint || r.tf !== "15m" || r.chain !== "solana") bad.push(`the page read candles for ${r.chain}/${r.mint} at ${r.tf}`);
      if (r.status !== 200) bad.push(`its candle read answered ${r.status}`);
    }
    if (l.chart !== "ready") bad.push(`the chart is ${l.chart ?? "not there"}`);
    if (!(l.canvases > 0)) bad.push("no canvas drawn");
    const drawn = l.bars === null || l.bars === undefined ? null : Number(l.bars);
    if (!(drawn > 0)) bad.push(`the chart holds ${l.bars ?? "no"} bars`);
    else if (r && drawn !== r.count) bad.push(`the chart holds ${drawn} bars, its read answered ${r.count}`);
    if (r && l.vendor !== isGecko(r.src ?? null)) bad.push(`CoinGecko's label ${l.vendor ? "shown" : "missing"} for X-Helper-Source ${r.src ?? "none"}`);
    if (!l.shot) bad.push("no screenshot");
    say(bad.length === 0, `${tag}: ${bad.length ? bad.join("; ") : `the chart drew ${drawn} bars of its read's ${r.count} (15m, X-Helper-Source ${r.src}), CoinGecko's label ${l.vendor ? "shown" : "not shown"}`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
const MEASURE = () => {
  const root = document.querySelector('main[data-route="token"]');
  const p = root?.querySelector("[data-token-page]");
  const c = [...(root?.querySelectorAll("[data-chart]") ?? [])].find((e) => e.getClientRects().length);
  return {
    route: root?.dataset.route ?? null,
    tokenState: p?.getAttribute("data-token-page") ?? null,
    chart: c?.getAttribute("data-chart") ?? null,
    bars: c?.querySelector("[data-testid=chart-canvas]")?.getAttribute("data-bars") ?? null,
    canvases: c?.querySelectorAll("canvas").length ?? 0,
    vendor: !!c?.querySelector("[data-testid=chart-vendor]"),
  };
};

/** A candle read as kept: its query (the mint as `mint`: gitleaks reads a long id after `token=` as a secret). */
const query = (u) => {
  const q = new URL(u).searchParams;
  return { chain: q.get("chain"), mint: q.get("token"), tf: q.get("tf"), limit: q.get("limit") };
};

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  const lr = await fetch(LISTS_URL, { headers: { origin: APP_HOST } });
  const lb = await lr.json().catch(() => null);
  const rows = lb?.lists?.trending_1h ?? lb?.lists?.trending ?? null;
  const lists = { url: LISTS_URL, status: lr.status, as_of_ms: lb?.as_of_ms ?? null, trending: Array.isArray(rows) ? rows.map((r) => ({ mint: r?.token, symbol: r?.symbol, vol_1h_usd: r?.vol_1h_usd ?? null })) : null };
  const mint = lists.trending ? pickOf(lists.trending) : null;
  const rec = { source: build ? `harness: the build ${build} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), lists, candles: null, loads: [] };
  if (mint) {
    // the helper's GeckoTerminal budget is shared: a 429 is read again after its Retry-After, as the page does
    let cr = null;
    for (let i = 0; i < 4; i++) {
      cr = await fetch(CANDLES_URL(mint), { headers: { origin: APP_HOST } });
      if (cr.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1000 * Math.min(15, Math.max(1, Number(cr.headers.get("retry-after")) || 1))));
    }
    rec.candles = { ...query(CANDLES_URL(mint)), status: cr.status, src: cr.headers.get("x-helper-source"), body: await cr.json().catch(() => null) };
  }
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed");
  }
  const browser = await launchBrowser("chromium");
  rec.browser = browser.version();
  try {
    for (const [i, w] of LOADS.entries()) {
      const opened = `${APP_HOST}/token/solana/${mint}`;
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
      if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
      const page = await ctx.newPage();
      let read = null;
      page.on("response", (r) => {
        if (r.url().startsWith(`${HELPER_HOST}${CANDLES_PATH}?`) && !read) read = r;
      });
      await page.goto(opened, { waitUntil: "load" });
      let app = null;
      let m = null;
      for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
        for (const f of page.frames()) {
          const x = await f.evaluate(MEASURE).catch(() => null);
          if (x?.route) {
            app = f;
            m = x;
            break;
          }
        }
        if (m && m.chart && m.chart !== "loading") break;
      }
      await page.waitForTimeout(700);
      if (app) m = await app.evaluate(MEASURE).catch(() => m);
      const shot = path.join(shots, `${i}-${w.name}.png`);
      await page.screenshot({ path: shot });
      const rb = read ? await read.json().catch(() => null) : null;
      rec.loads.push({
        width: w.name,
        opened,
        tokenState: m?.tokenState ?? null,
        chart: m?.chart ?? null,
        bars: m?.bars ?? null,
        canvases: m?.canvases ?? 0,
        vendor: m?.vendor ?? false,
        read: read ? { ...query(read.url()), status: read.status(), src: (await read.allHeaders())["x-helper-source"] ?? null, count: Array.isArray(rb?.candles) ? rb.candles.length : null } : null,
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
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
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
