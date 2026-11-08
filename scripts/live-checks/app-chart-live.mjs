#!/usr/bin/env node
// Live check of card app-chart-live: the token page's chart is live, its last bar moving as real trades land, with no
// reload. Meme coins trade in bursts, so the check never bets on one coin in one window: it judges the page against the
// helper's own reads.
//   1. Candidates: on Solana and Base, the first PER_CHAIN listed tokens (GET /v1/market/lists, columns new,
//      trending_5m, trending_1h, trending).
//   2. Pick: the candidates' newest 15m bars (the chart's default timeframe; GET /v1/market/candles, limit 2, the
//      page's own live read) read round after round for PROBE_MS; of the answers that are the helper's own chain reads
//      (own_from_s: a token the helper opens on its first read has none yet), the token whose last bar changed most
//      often, at least once.
//   3. Watch: headless Chromium opens APP_HOST/token/<chain>/<token> at 1440 x 900 and 390 x 844 (dpr 2, touch), finds
//      the terminal's frame inside SIGN_HOST's shell and reads the library's own last bar (data-last: time and close)
//      every 250 ms until it changes or WATCH_MAX_MS passes, while Node reads the helper's newest bars each second and
//      its tape (GET /v1/market/trades, limit 1) every two.
//   4. Verdict per watch (classify):
//      - the page drew a change: it must be the newest bar of an answer the helper gave (the page's own candle reads,
//        each answer's last bar kept, or Node's: a burst moves a bar several times a second, so Node's one read a
//        second cannot hold every bar the page drew); a wrong fold's price fails;
//      - the helper's bars moved after the chart was ready and the page drew none: FAIL, the page's;
//      - the helper's bars did not move but its tape took new trades: FAIL, the helper's (candles behind its tape);
//      - nothing moved: no verdict on the page, pick again, at most TRIES picks; all silent is a FAIL that names the
//        helper as silent.
//      At both widths in a watch with a verdict: no reload (one time origin), live reads (limit 2) made, at most one
//      full read (limit 500) a minute after the first, no console error and no page error in the terminal's frame.
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
import { named } from "./record-names.mjs";

const KEY = "app-chart-live";
export const APP_HOST = "https://confidential.unrealized.trade";
export const HELPER_HOST = "https://api.confidential.unrealized.trade";
export const CHAINS = ["solana", "base"];
const CANDLES = `${HELPER_HOST}/v1/market/candles?`;
export const LOADS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
export const PER_CHAIN = 10;
export const PROBE_MS = 30_000;
export const WATCH_MAX_MS = 240_000;
export const TRIES = 3;
const READY_MS = 25_000;
/** The page's full reads: its first, one a minute after (candles.ts RESYNC_MS), and one after a failed read. */
const fullMax = (watchMs) => 1 + Math.ceil(watchMs / 60_000) + 1;

// ------------------------------------------------------------------------------------------------ the verdict
/** A helper bar [t_s, open, high, low, close, ...] as the page writes its last bar: time in ms and close. */
const keyOf = (bar) => (Array.isArray(bar) && bar.length >= 5 ? `${bar[0] * 1000}:${Number(bar[4])}` : null);
const norm = (s) => {
  const m = /^(\d+):([0-9.e+-]+)$/.exec(s ?? "");
  return m ? `${Number(m[1])}:${Number(m[2])}` : null;
};

/** One watch's verdict: "page" (the page is judged: the helper moved or the page drew a change, or the page drew no
 *  bar at all), "helper" (the tape moved and the candles did not), or "silent" (nothing moved). */
export function classify(a) {
  const loads = a.loads ?? [];
  if (loads.some((l) => norm(l.first) === null || norm(l.final) !== norm(l.first))) return "page";
  const ready = Math.min(...loads.map((l) => l.readyAt ?? Infinity));
  const after = (a.helper ?? []).filter((h) => h.status === 200 && h.at_ms >= ready).map((h) => keyOf(h.last));
  if (after.some((k) => k !== null && loads.some((l) => k !== norm(l.first)))) return "page";
  const tape = (a.tape ?? []).filter((t) => t.at_ms >= ready && Number.isFinite(t.newest_ms)).map((t) => t.newest_ms);
  if (tape.length > 1 && Math.max(...tape) > tape[0]) return "helper";
  return "silent";
}

/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const attempts = rec.attempts ?? [];
  say((rec.candidates ?? []).length > 0 && attempts.length > 0, `${(rec.candidates ?? []).length} listed candidates on ${CHAINS.join(" and ")}; ${attempts.length} picks`);
  for (const [n, a] of attempts.entries()) {
    const p = a.pick;
    const kind = classify(a);
    const tag = p ? `pick ${n + 1} ${p.chain}/<token> (${p.symbol}, ${p.changes} changes in the probe)` : `pick ${n + 1}: no candidate's bars moved in the ${PROBE_MS / 1000} s probe`;
    if (kind === "silent") {
      const last = n === attempts.length - 1;
      say(!last, `${tag}: the helper's own bars and tape did not move in ${Math.round((a.loads?.[0]?.watchedMs ?? 0) / 1000)} s: no verdict on the page${last ? `; the helper was silent in all ${attempts.length} picks` : ", picked again"}`);
      continue;
    }
    if (n !== attempts.length - 1) say(false, `${tag}: a watch with a verdict (${kind}) was followed by another pick`);
    if (kind === "helper") {
      say(false, `${tag}: the helper's tape took new trades during the watch but its limit-2 15m candles did not move (the helper's candles lag its tape)`);
      continue;
    }
    for (const [i, l] of (a.loads ?? []).entries()) {
      const helperBars = new Set([...(a.helper ?? []).filter((h) => h.status === 200).map((h) => keyOf(h.last)), ...(l.answered ?? [])]);
      const w = `${LOADS[i]?.name ?? l.width}`;
      const bad = [];
      if (p?.token && l.opened !== `${APP_HOST}/token/${p.chain}/${p.token}`) bad.push(`opened ${l.opened}`);
      if (l.chart !== "ready") bad.push(`the chart is ${l.chart ?? "not there"}`);
      const first = norm(l.first);
      const final = norm(l.final);
      if (first === null) bad.push(`no last bar drawn (${l.first ?? "none"})`);
      else if (final === first) bad.push(`the helper's own bars moved after the chart was ready, the page's last bar stayed ${l.first} for ${l.watchedMs} ms`);
      else if (!helperBars.has(final)) bad.push(`the last bar drawn ${l.final} is none the helper answered during the watch (the page's ${(l.answered ?? []).length} answers or Node's reads)`);
      if (!(l.origin > 0) || l.originEnd !== l.origin) bad.push(`the frame was loaded again (time origin ${l.origin} -> ${l.originEnd})`);
      if (!(l.liveReads > 0)) bad.push("no live read (limit 2)");
      if (!(l.fullReads >= 1 && l.fullReads <= fullMax(l.watchedMs ?? WATCH_MAX_MS))) bad.push(`${l.fullReads} full reads (limit 500) in ${l.watchedMs} ms`);
      if ((l.errors ?? []).length) bad.push(`errors: ${l.errors.join(" | ")}`);
      if (!l.shot) bad.push("no screenshot");
      say(bad.length === 0, `${tag} ${w}: ${bad.length ? bad.join("; ") : `the last bar moved ${l.first} -> ${l.final} after ${l.changedMs} ms, a bar the helper answered; ${l.liveReads} live reads, ${l.fullReads} full, one load, no error`}`);
    }
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
const candlesUrl = (chain, token, limit) => `${CANDLES}chain=${chain}&token=${encodeURIComponent(token)}&tf=15m&limit=${limit}`;
const tradesUrl = (chain, token) => `${HELPER_HOST}/v1/market/trades?chain=${chain}&token=${encodeURIComponent(token)}&limit=1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first PER_CHAIN listed tokens of each chain. */
async function candidates() {
  const out = [];
  for (const chain of CHAINS) {
    const l = await getJson(`${HELPER_HOST}/v1/market/lists?chain=${chain}`);
    const seen = new Set();
    for (const column of ["new", "trending_5m", "trending_1h", "trending"]) {
      for (const r of l.body?.lists?.[column] ?? []) {
        if (seen.size >= PER_CHAIN) break;
        if (typeof r?.token !== "string" || seen.has(r.token)) continue;
        seen.add(r.token);
        out.push({ chain, token: r.token, symbol: r.symbol ?? null });
      }
    }
  }
  return out;
}

/** The candidate whose own newest bar changed most often over PROBE_MS, at least once; null when none moved. */
async function probe(cands) {
  const last = new Map();
  const changes = new Map(cands.map((c) => [c, 0]));
  for (const t0 = Date.now(); Date.now() - t0 < PROBE_MS; await sleep(500)) {
    for (const c of cands) {
      const r = await getJson(candlesUrl(c.chain, c.token, 2));
      const k = r.status === 200 && Number.isSafeInteger(r.body?.own_from_s) ? keyOf(r.body?.candles?.at(-1)) : null;
      if (k === null) continue;
      if (last.has(c) && last.get(c) !== k) changes.set(c, changes.get(c) + 1);
      last.set(c, k);
    }
  }
  let best = null;
  for (const [c, n] of changes) if (n > 0 && n > (best?.changes ?? 0)) best = { ...c, changes: n };
  return best;
}

const MEASURE = () => {
  const root = document.querySelector('main[data-route="token"]');
  const c = [...(root?.querySelectorAll("[data-chart]") ?? [])].find((e) => e.getClientRects().length);
  return { route: root?.dataset.route ?? null, chart: c?.getAttribute("data-chart") ?? null, last: c?.querySelector("[data-testid=chart-canvas]")?.getAttribute("data-last") || null };
};

async function watchLoad(browser, w, i, pick, harness, shots, n) {
  const opened = `${APP_HOST}/token/${pick.chain}/${pick.token}`;
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
  const page = await ctx.newPage();
  const errors = [];
  let liveReads = 0;
  let fullReads = 0;
  /** The newest bar of every candle answer the page was given, as the page writes its last bar. */
  const answered = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(CANDLES)) return;
    const limit = new URL(r.url()).searchParams.get("limit");
    if (limit === "2") liveReads++;
    else if (limit === "500") fullReads++;
  });
  page.on("response", (r) => {
    if (!r.url().startsWith(CANDLES) || r.status() !== 200) return;
    void r.json().then((b) => {
      const k = keyOf(b?.candles?.at(-1));
      if (k !== null && !answered.includes(k)) answered.push(k);
    }, () => undefined);
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
  // a page that draws no last bar has nothing to watch
  if (app && m?.chart === "ready" && first !== null) {
    for (const t0 = Date.now(); Date.now() - t0 < WATCH_MAX_MS; await page.waitForTimeout(250)) {
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
  // the record keeps the file's name only: the folder is the recorder's own, printed once at the end
  const shot = `${n}-${i}-${w.name}.png`;
  await page.screenshot({ path: path.join(shots, shot) });
  await ctx.close();
  return { width: w.name, opened, chart: m?.chart ?? null, first, final, changedMs, watchedMs: Date.now() - readyAt, readyAt, origin, originEnd, liveReads, fullReads, answered, errors, shot };
}

/** One pick watched at both widths, with the helper's newest bars read each second and its tape every two. */
async function watch(browser, pick, harness, shots, n) {
  const a = { pick, helper: [], tape: [], loads: [] };
  let watching = true;
  const reads = (async () => {
    for (let i = 0; watching; i++) {
      const c = await getJson(candlesUrl(pick.chain, pick.token, 2));
      a.helper.push({ at_ms: Date.now(), status: c.status, last: c.body?.candles?.at(-1)?.slice(0, 5) ?? null });
      if (i % 2 === 0) {
        const t = await getJson(tradesUrl(pick.chain, pick.token));
        a.tape.push({ at_ms: Date.now(), status: t.status, newest_ms: t.body?.trades?.[0]?.t_ms ?? null });
      }
      await sleep(1_000);
    }
  })();
  try {
    a.loads = await Promise.all(LOADS.map((w, i) => watchLoad(browser, w, i, pick, harness, shots, n)));
  } finally {
    watching = false;
    await reads;
  }
  return a;
}

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  const cands = await candidates();
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), candidates: cands.map((c) => ({ chain: c.chain, symbol: c.symbol })), attempts: [], shots };
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed");
  }
  const browser = await launchBrowser("chromium");
  rec.browser = browser.version();
  try {
    const left = [...cands];
    for (let n = 0; n < TRIES && left.length; n++) {
      const pick = await probe(left);
      if (!pick) {
        rec.attempts.push({ pick: null, helper: [], tape: [], loads: [] });
        continue;
      }
      left.splice(left.findIndex((c) => c.token === pick.token), 1);
      const a = await watch(browser, pick, harness, shots, n);
      rec.attempts.push(a);
      if (classify(a) !== "silent") break;
    }
  } finally {
    await browser.close();
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
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
