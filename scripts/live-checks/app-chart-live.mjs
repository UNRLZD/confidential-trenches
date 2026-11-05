#!/usr/bin/env node
// Live check of card app-chart-live: the token page's chart is live, its last bar moving as real trades land, with no
// reload. Node reads the helper's Solana lists (GET /v1/market/lists?chain=solana) and takes the first listed token,
// column by column (at most PICK_MAX tokens, each read opens it on the helper), whose 15m candles are the helper's own
// chain reads (own_from_s) and whose tape (GET /v1/market/trades) holds its newest trade from the last ACTIVE_S seconds
// and five in the last minute, so a next trade is due inside the watch. Headless Chromium opens APP_HOST/token/solana/<mint>
// at 1440 x 900 and 390 x 844 (dpr 2, touch), finds the terminal's frame inside SIGN_HOST's shell, waits for the chart
// and reads the library's own last bar (data-last: its time and close) every 250 ms for up to WATCH_MS, while Node reads
// the helper's newest 15m bars each second. It passes when, at both widths:
//   - the drawn last bar changed after the chart was ready, with the frame never loaded again (one time origin);
//   - the page made live reads (limit 2) and at most one full read (limit 500) a minute after its first;
//   - the drawn last bar is one the helper answered during the watch (its time and close), so a wrong fold fails;
//   - the tape names a trade after the chart was ready (a real swap landed);
//   - no console error and no page error in the terminal's frame.
// A screenshot of every load is kept.
//   node scripts/live-checks/app-chart-live.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute), the
// helper still answered live; --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { consoleError, pageError } from "./console-errors.mjs";

const KEY = "app-chart-live";
export const APP_HOST = "https://confidential.unrealized.trade";
export const HELPER_HOST = "https://api.confidential.unrealized.trade";
export const LISTS_URL = `${HELPER_HOST}/v1/market/lists?chain=solana`;
const CANDLES = `${HELPER_HOST}/v1/market/candles?`;
export const LOADS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
/** A token is active when its tape's newest trade is this recent and its fifth newest within a minute. */
export const ACTIVE_S = 20;
export const PICK_MAX = 12;
/** How long a load watches for its last bar to move. */
export const WATCH_MS = 90_000;
const READY_MS = 25_000;
/** The page's full reads after its first: one a minute (candles.ts RESYNC_MS) over the watch, and one after a failure. */
const fullMax = (watchMs) => 1 + Math.ceil(watchMs / 60_000) + 1;

// ------------------------------------------------------------------------------------------------ the verdict
const lastOf = (s) => {
  const m = /^(\d+):([0-9.e-]+)$/.exec(s ?? "");
  return m ? { t_ms: Number(m[1]), close: Number(m[2]) } : null;
};

/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = rec.pick ?? null;
  say(rec.lists?.status === 200 && !!p?.mint && p.own === true && p.tradeAgoS !== null && p.tradeAgoS <= ACTIVE_S, `the helper's lists: ${rec.lists?.status ?? "none"}; the active token ${p?.mint ? `${p.symbol} (${p.column}), own bars ${p.own}, its newest trade ${p.tradeAgoS} s old` : "none"}`);
  const helperBars = new Set((rec.helper ?? []).filter((h) => h.status === 200 && h.last).map((h) => `${h.last[0] * 1000}:${Number(h.last[1])}`));
  say(helperBars.size > 0, `the helper's own newest bars read during the watch: ${(rec.helper ?? []).length} reads, ${helperBars.size} distinct last bars`);
  const loads = rec.loads ?? [];
  say(loads.length === LOADS.length, `${loads.length} loads of ${LOADS.length} (1440 and 390)`);
  for (const [i, l] of loads.entries()) {
    const tag = `${LOADS[i]?.name ?? l.width} /token/solana/<active mint>`;
    const bad = [];
    if (p?.mint && l.opened !== `${APP_HOST}/token/solana/${p.mint}`) bad.push(`opened ${l.opened}`);
    if (l.chart !== "ready") bad.push(`the chart is ${l.chart ?? "not there"}`);
    const a = lastOf(l.first);
    const b = lastOf(l.final);
    if (!a) bad.push(`no last bar drawn (${l.first ?? "none"})`);
    else if (!b || l.final === l.first) bad.push(`the last bar stayed ${l.first} for ${l.watchedMs} ms`);
    else if (!helperBars.has(`${b.t_ms}:${b.close}`)) bad.push(`the last bar drawn ${l.final} is none the helper answered during the watch`);
    if (!(l.origin > 0) || l.originEnd !== l.origin) bad.push(`the frame was loaded again (time origin ${l.origin} -> ${l.originEnd})`);
    if (!(l.liveReads > 0)) bad.push("no live read (limit 2)");
    if (!(l.fullReads >= 1 && l.fullReads <= fullMax(l.watchedMs ?? WATCH_MS))) bad.push(`${l.fullReads} full reads (limit 500) in ${l.watchedMs} ms`);
    // a trade's time is its block's whole-second clock, and it reaches the helper up to ~2 s later (trades.ts header)
    if (!(rec.tape?.newest_ms > (l.readyAt ?? Infinity) - 3_000)) bad.push(`no trade on the tape after the chart was ready (newest ${rec.tape?.newest_ms ?? "none"})`);
    if ((l.errors ?? []).length) bad.push(`errors: ${l.errors.join(" | ")}`);
    if (!l.shot) bad.push("no screenshot");
    say(bad.length === 0, `${tag}: ${bad.length ? bad.join("; ") : `the last bar moved ${l.first} -> ${l.final} after ${l.changedMs} ms, a bar the helper answered; ${l.liveReads} live reads, ${l.fullReads} full, one load, no error`}`);
  }
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
const headers = { origin: APP_HOST, "cache-control": "no-cache" };
const getJson = async (url) => {
  try {
    const r = await fetch(url, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
};
const candlesUrl = (mint, limit) => `${CANDLES}chain=solana&token=${encodeURIComponent(mint)}&tf=15m&limit=${limit}`;
const tradesUrl = (mint) => `${HELPER_HOST}/v1/market/trades?chain=solana&token=${encodeURIComponent(mint)}&limit=5`;

/** The first listed token, column by column, with the helper's own 15m bars, a trade in the last ACTIVE_S s and five
 *  in the last minute. */
async function pickActive(lists) {
  const seen = new Set();
  for (const column of ["new", "trending_5m", "trending_1h", "trending", "graduating"]) {
    for (const r of lists?.[column] ?? []) {
      if (typeof r?.token !== "string" || seen.has(r.token)) continue;
      if (seen.size >= PICK_MAX) return null;
      seen.add(r.token);
      const c = await getJson(candlesUrl(r.token, 2));
      if (c.status !== 200 || !Number.isSafeInteger(c.body?.own_from_s)) continue;
      const t = await getJson(tradesUrl(r.token));
      const ms = (t.body?.trades ?? []).map((x) => x?.t_ms).filter(Number.isFinite);
      const ago = ms.length ? Math.round((Date.now() - ms[0]) / 1000) : null;
      if (ago !== null && ago <= ACTIVE_S && ms.length >= 5 && Date.now() - ms[4] <= 60_000) return { mint: r.token, symbol: r.symbol ?? null, column, own: true, tradeAgoS: ago };
    }
  }
  return null;
}

const MEASURE = () => {
  const root = document.querySelector('main[data-route="token"]');
  const c = [...(root?.querySelectorAll("[data-chart]") ?? [])].find((e) => e.getClientRects().length);
  return { route: root?.dataset.route ?? null, chart: c?.getAttribute("data-chart") ?? null, last: c?.querySelector("[data-testid=chart-canvas]")?.getAttribute("data-last") || null };
};

async function watchLoad(browser, w, i, mint, harness, shots) {
  const opened = `${APP_HOST}/token/solana/${mint}`;
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
  const page = await ctx.newPage();
  const errors = [];
  let liveReads = 0;
  let fullReads = 0;
  page.on("request", (r) => {
    if (!r.url().startsWith(CANDLES)) return;
    const limit = new URL(r.url()).searchParams.get("limit");
    if (limit === "2") liveReads++;
    else if (limit === "500") fullReads++;
  });
  page.on("console", (m) => m.type() === "error" && errors.push(consoleError(m)));
  page.on("pageerror", (e) => errors.push(pageError(e)));
  await page.goto(opened, { waitUntil: "load" });
  let app = null;
  let m = null;
  for (const t0 = Date.now(); Date.now() - t0 < READY_MS; await page.waitForTimeout(250)) {
    for (const f of page.frames()) {
      const x = await f.evaluate(MEASURE).catch(() => null);
      if (x?.route) {
        app = f;
        m = x;
        break;
      }
    }
    if (m?.chart && m.chart !== "loading") break;
  }
  const readyAt = Date.now();
  const origin = app ? await app.evaluate(() => performance.timeOrigin).catch(() => null) : null;
  const first = m?.last ?? null;
  let final = first;
  let changedMs = null;
  if (app && m?.chart === "ready") {
    for (const t0 = Date.now(); Date.now() - t0 < WATCH_MS; await page.waitForTimeout(250)) {
      final = (await app.evaluate(MEASURE).catch(() => null))?.last ?? final;
      if (final !== first) {
        changedMs = Date.now() - t0;
        // one more read later, so the bar compared with the helper's is not one caught mid-render
        await page.waitForTimeout(1_500);
        final = (await app.evaluate(MEASURE).catch(() => null))?.last ?? final;
        break;
      }
    }
  }
  const originEnd = app ? await app.evaluate(() => performance.timeOrigin).catch(() => null) : null;
  const shot = path.join(shots, `${i}-${w.name}.png`);
  await page.screenshot({ path: shot });
  await ctx.close();
  return { width: w.name, opened, chart: m?.chart ?? null, first, final, changedMs, watchedMs: Date.now() - readyAt, readyAt, origin, originEnd, liveReads, fullReads, errors, shot };
}

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  const l = await getJson(LISTS_URL);
  const pick = l.status === 200 ? await pickActive(l.body?.lists) : null;
  const rec = { source: build ? `harness: the build ${build} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), lists: { url: LISTS_URL, status: l.status }, pick, helper: [], tape: null, loads: [] };
  if (!pick) return { ...rec, shots };
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed");
  }
  const browser = await launchBrowser("chromium");
  rec.browser = browser.version();
  let watching = true;
  // the helper's own newest bars, read each second while the loads watch: what the page may draw
  const reads = (async () => {
    while (watching) {
      const c = await getJson(candlesUrl(pick.mint, 2));
      rec.helper.push({ at_ms: Date.now(), status: c.status, last: c.body?.candles?.at(-1)?.slice(0, 5) ?? null });
      await new Promise((r) => setTimeout(r, 1_000));
    }
  })();
  try {
    rec.loads = await Promise.all(LOADS.map((w, i) => watchLoad(browser, w, i, pick.mint, harness, shots)));
  } finally {
    watching = false;
    await reads;
    await browser.close();
  }
  const t = await getJson(tradesUrl(pick.mint));
  rec.tape = { status: t.status, newest_ms: t.body?.trades?.[0]?.t_ms ?? null };
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
    for (const x of lines) console.log(x);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
