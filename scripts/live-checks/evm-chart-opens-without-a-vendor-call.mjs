// Live check of card evm-chart-opens-without-a-vendor-call: a Base token's chart opens for every caller however many
// tokens are opened in a minute. The helper's GeckoTerminal budget is 5 calls in 75 s for the whole server
// (apps/helper/src/data/gecko.ts); a listed token's candles answer our own reads' bars at once, with GeckoTerminal's
// history added when a call is free; with nothing of ours held and the budget spent, the 429 with its wait, which the
// page reads again at each Retry-After for one window (apps/terminal/src/screens/token/candles.ts loadCandles,
// THROTTLE_SPAN_S), never an empty chart for a token that has one (live run 42995547054 at 09:29:50Z).
// It reads at HELPER_HOST with Origin APP_HOST:
//   GET /v1/market/lists?chain=base                                   (one read: the trending tokens)
//   GET /v1/market/candles?chain=base&token=<t>&tf=15m&limit=500      (the token page's first read, for N tokens)
// N (default 10) distinct tokens, Trending 5m's then Trending 1h's rows in order, one after another, each read as the
// page reads it (candles-read.mjs: a 429 again at its Retry-After, within one THROTTLE_SPAN_S span for the run), and
// passes only when:
//   - the lists answer 200 with at least N distinct trending tokens;
//   - every candles answer is 200 JSON with X-Helper-Commit a full sha, its src one the helper names (X-Helper-Source
//     and the body's src alike): "chain", "chain,geckoterminal" or "chain,coingecko" (our own bars, the vendor, keyless
//     or the paid plan, only before our first), or "geckoterminal" or "coingecko" for a token our reads find no pool of; tf "15m", bars [t_s, o, h, l, c, vol] on the 15m grid,
//     oldest first, at least one (a trending token has a chart), high and low holding open and close; own_from_s, when
//     present, one of its bars;
//   - each chart opened within THROTTLE_SPAN_S of its first read.
// The line names each token's source and bar count. Run after a deploy on a helper started fresh (the coordinator's
// run); on a warm helper the tokens may already be held, which still must pass.
// After: helper
// Usage:
//   node scripts/live-checks/evm-chart-opens-without-a-vendor-call.mjs [--base <helper url>] [--n <count>] [--record <file>]
import { writeFileSync } from "node:fs";
import "../net-window.mjs";
import { candlesReader, THROTTLE_SPAN_S } from "./candles-read.mjs";
import { APP, BASE } from "./index-evm-swaps.mjs";

const KEY = "evm-chart-opens-without-a-vendor-call";
export const N = 10;
/** GeckoTerminal's window (apps/helper/src/data/gecko.ts WINDOW_MS). */
export const WINDOW_S = 75;
export const LISTS_PATH = "/v1/market/lists?chain=base";
/** The token page's first candles read (apps/terminal/src/screens/token/candles.ts DEFAULT_TF 15m, CANDLES_LIMIT 500). */
export const CANDLES_PATH = (t) => `/v1/market/candles?chain=base&token=${t}&tf=15m&limit=500`;
export const SOURCES = ["chain", "chain,geckoterminal", "chain,coingecko", "geckoterminal", "coingecko"];
/** The vendor-only sources: CoinGecko's bars alone, keyless or the paid plan. */
const VENDOR_ONLY = ["geckoterminal", "coingecko"];
const STEP = 900;
const SHA = /^[0-9a-f]{40}$/;
const DEC = /^\d+(\.\d+)?$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The trending tokens of a lists answer, Trending 5m's then Trending 1h's, distinct, in order. */
export function trending(body) {
  const l = isObj(body) && isObj(body.lists) ? body.lists : {};
  const out = [];
  for (const k of ["trending_5m", "trending_1h", "trending"]) for (const r of Array.isArray(l[k]) ? l[k] : []) if (ADDR.test(r?.token ?? "") && !out.includes(r.token)) out.push(r.token);
  return out;
}

/** The first thing wrong with one candles read, or null. */
export function candlesFault(r) {
  if (r.status !== 200) return `answered ${r.status}${r.headers?.["retry-after"] ? ` (retry-after ${r.headers["retry-after"]})` : ""}`;
  if (!SHA.test(r.headers?.["x-helper-commit"] ?? "")) return `X-Helper-Commit ${show(r.headers?.["x-helper-commit"])}`;
  let c;
  try {
    c = JSON.parse(r.body);
  } catch {
    return "not JSON";
  }
  const keys = isObj(c) ? Object.keys(c) : [];
  if (!["tf", "candles", "src", "as_of_ms"].every((k) => keys.includes(k)) || !keys.every((k) => ["tf", "candles", "src", "own_from_s", "as_of_ms"].includes(k))) return `keys ${show(keys)}`;
  if (c.tf !== "15m") return `tf ${show(c.tf)}`;
  if (!SOURCES.includes(c.src) || r.headers?.["x-helper-source"] !== c.src) return `src ${show(c.src)}, X-Helper-Source ${show(r.headers?.["x-helper-source"])}`;
  if (!Number.isSafeInteger(c.as_of_ms)) return `as_of_ms ${show(c.as_of_ms)}`;
  if (!Array.isArray(c.candles) || c.candles.length > 500) return `candles ${Array.isArray(c.candles) ? c.candles.length : "not a list"}`;
  if (c.candles.length === 0) return `no bars (src ${show(c.src)}): an empty chart for a trending token`;
  for (const [i, b] of c.candles.entries()) {
    if (!Array.isArray(b) || b.length !== 6 || !Number.isSafeInteger(b[0]) || b[0] % STEP !== 0 || !b.slice(1).every((v) => typeof v === "string" && DEC.test(v))) return `bar ${i} ${show(b)}`;
    if (i > 0 && b[0] <= c.candles[i - 1][0]) return `bar ${i} not after bar ${i - 1}`;
    const [, o, h, l, cl] = b.map(Number);
    if (!(h >= o && h >= cl && l <= o && l <= cl)) return `bar ${i} high/low does not hold open and close ${show(b)}`;
  }
  if (c.own_from_s !== undefined && !c.candles.some((b) => b[0] === c.own_from_s)) return `own_from_s ${show(c.own_from_s)} is not a bar`;
  if (c.own_from_s !== undefined && VENDOR_ONLY.includes(c.src)) return "own_from_s on a vendor-only chart";
  return null;
}

/** The check on one run: { base, n, lists, candles: [{ coin, at, ms, status, headers, body }] }, `coin` the token read. */
export function judge(run) {
  const lines = [];
  let ok = true;
  const bad = (s) => (lines.push(`BAD ${s}`), (ok = false));
  if (run.lists?.status !== 200) {
    bad(`lists answered ${run.lists?.status}`);
    return { ok, lines };
  }
  let body;
  try {
    body = JSON.parse(run.lists.body);
  } catch {
    body = null;
  }
  const want = trending(body).slice(0, run.n);
  if (want.length < run.n) bad(`lists hold ${want.length} trending tokens, under ${run.n}`);
  const got = run.candles ?? [];
  if (got.length !== want.length || got.some((c, i) => c.coin !== want[i])) bad(`read ${got.length} tokens, not the lists' first ${want.length}`);
  for (const c of got) {
    const f = candlesFault(c);
    const waited = (c.waitedMs ?? 0) / 1000;
    if (f !== null) bad(`${c.coin}: ${f}${waited > 0 ? `, after ${waited} s of the page's reads` : ""}`);
    else if (!(waited <= THROTTLE_SPAN_S)) bad(`${c.coin}: opened after ${waited} s, over the page's ${THROTTLE_SPAN_S} s`);
    else {
      const b = JSON.parse(c.body);
      lines.push(`ok  ${c.coin}: 200 ${b.src}, ${b.candles.length} bar(s)${b.own_from_s === undefined ? "" : `, ours from ${new Date(b.own_from_s * 1000).toISOString()}`}, ${c.ms} ms${waited > 0 ? ` after ${waited} s of 429s` : ""}`);
    }
  }
  if (got.length > 0) lines.push(`--  ${got.length} charts in ${((Date.parse(got.at(-1).at) + got.at(-1).ms - Date.parse(got[0].first ?? got[0].at)) / 1000).toFixed(1)} s`);
  return { ok, lines };
}

async function get(base, path, fetchFn) {
  const at = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { at, ms: Math.round(performance.now() - t0), status: r.status, headers, body };
}

/** One run: the lists, then each of the first `n` trending tokens' candles, one after another, each read as the page
 *  reads it (candles-read.mjs, one span for the run, its clock the time waited: the reads are one after another), the
 *  last answer judged with `first` (its first read's time) and `waitedMs`. */
export async function read(base = BASE, n = N, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms))) {
  const lists = await get(base, LISTS_PATH, fetchFn);
  let body = null;
  try {
    body = JSON.parse(lists.body);
  } catch {
    // judged as no tokens
  }
  const candles = [];
  let waited = 0;
  const reader = candlesReader({ now: () => waited, wait: async (ms) => void (await wait(ms), (waited += ms)) });
  for (const token of lists.status === 200 ? trending(body).slice(0, n) : []) {
    let first;
    const { waits, ...r } = await reader.read(async () => {
      const a = await get(base, CANDLES_PATH(token), fetchFn);
      first ??= a.at;
      return a;
    });
    candles.push({ coin: token, first, waitedMs: (waits ?? []).reduce((x, y) => x + y, 0), ...r });
  }
  return { base, n, lists, candles };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const n = Number(opt("--n", String(N)));
    if (!Number.isSafeInteger(n) || n < 1 || n > 20) throw new Error(`--n ${n}: 1 to 20`);
    const run = await read(base, n);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${base}, ${n} Base tokens)`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
