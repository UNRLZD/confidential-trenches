#!/usr/bin/env node
// Live check of card helper-candles-never-refuse-a-listed-coin: no coin on Discover's lists is answered a refused chart.
// Release 157's app live run 43763914220 (15 Nov 21:41Z) opened the first listed Solana coin, TTWO, and its chart stayed
// empty: the helper log for 21:29-21:43Z held 33 windows of refused candles ("geckoterminal budget filling", "candles
// bound", "client window") while every CoinGecko keyed read was refused by the key's day share, so each chart fell to
// GeckoTerminal's keyless 5 calls in 75 s, and a listed coin whose bars were held past GT_SERVE_MS, or held none,
// answered 200 with no bars. The helper now holds every listed chart off our own venues ahead, serves held bars at any
// age when a read is refused (dated by their read), queues the re-read, and serves a listed coin whose walk of ours
// cannot open from those bars (apps/helper/src/data/solana/token.ts ahead and candles, data/solana/trades.ts candles,
// data/evm/swaps.ts geckoBars).
// It reads each chain's Discover lists (solana, base, robinhood), then every listed coin's chart at the tf the token page
// asks first (apps/terminal/src/screens/token/candles.ts DEFAULT_TF, 15m) with the page's limit (CANDLES_LIMIT, 500), WAVE at once each
// WAVE_GAP_MS (under the helper's per-client API_RATE_MAX of 120 a 10 s window, apps/helper/src/server.ts, so the check
// never meets the abuse bound that holds one client back). Want, for every coin: 200 with bars. A coin with no pool to
// chart is told apart and not judged: a 404, or a 200 with no bars and no `filling` for a Solana coin (GeckoTerminal names
// no pool); a Base or Robinhood coin the lists name a pool for has one, so its empty chart is BAD. A 200 with no bars
// and `filling` true is the refusal's form (server.ts fillingOf) and is BAD, as is any other status.
// Runs: pending helper-listed-charts-own-reads, it fails on the helper this branch deploys too: Base's and Robinhood's cold books answer filling past the route's 5 s (Base 38 of 45 at 22:41Z) and more coins than OPEN_MAX open at once, and Solana's lists take in about two coins off pump.fun a minute, more than the keyless budget reads ahead; it joins the helper's list once every listed coin's chart is our own reads'
//   node scripts/live-checks/helper-candles-never-refuse-a-listed-coin.mjs [--base <url>] [--chains solana,base,robinhood] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { CANDLES_LIMIT, DEFAULT_TF, TF_API } from "../../apps/terminal/src/screens/token/candles.ts";

const KEY = "helper-candles-never-refuse-a-listed-coin";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["solana", "base", "robinhood"];
/** The token page's first candles read: its default tf (15m) and limit. */
export const TF = TF_API[DEFAULT_TF];
export const LIMIT = CANDLES_LIMIT;
/** Reads at once, and the gap between waves [design: 100 in 10.5 s, under one client's 120 a 10 s window]. */
export const WAVE = 100;
export const WAVE_GAP_MS = 10_500;
/** The rows a chain's lists may hold that are read (Discover's five Solana lists hold 290 rows at most). */
export const COINS_MAX = 400;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function ask(base, path, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), body: "", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** A lists answer's distinct coins (each its `address`; a record never names it `token`, which the secret scan reads as
 *  a key's name), in list order, each with whether the lists name its pool; null when not a lists answer. */
export function coinsOf(chain, body) {
  try {
    const j = JSON.parse(body);
    if (typeof j?.lists !== "object" || j.lists === null) return null;
    const pools = typeof j.pools === "object" && j.pools !== null ? j.pools : {};
    const seen = new Map();
    for (const rows of Object.values(j.lists)) {
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const t = r?.token;
        if (typeof t !== "string" || !(chain === "solana" ? SOL : EVM).test(t) || seen.has(t)) continue;
        seen.set(t, { address: t, pool: Object.hasOwn(pools, t) });
      }
    }
    return [...seen.values()].slice(0, COINS_MAX);
  } catch {
    return null;
  }
}

/** A candles answer's bar count and filling, or what is wrong with it. */
export function shapeOf(body) {
  try {
    const j = JSON.parse(body);
    if (!Array.isArray(j?.candles) || typeof j.src !== "string") return { bad: "not a candles answer" };
    return { bars: j.candles.length, filling: j.filling === true, src: j.src, as_of_ms: j.as_of_ms };
  } catch {
    return { bad: "not JSON" };
  }
}

export async function read(base = BASE, chains = CHAINS, fetchFn = fetch, wait = sleep) {
  const at = new Date().toISOString();
  const lists = {};
  const coins = [];
  for (const chain of chains) {
    const a = await ask(base, `/v1/market/lists?chain=${chain}`, fetchFn);
    const c = a.status === 200 ? coinsOf(chain, a.body) : null;
    lists[chain] = { status: a.status, coins: c === null ? null : c.length };
    for (const x of c ?? []) coins.push({ chain, ...x });
  }
  const reads = [];
  for (let i = 0; i < coins.length; i += WAVE) {
    if (i > 0) await wait(WAVE_GAP_MS);
    const wave = coins.slice(i, i + WAVE);
    reads.push(
      ...(await Promise.all(
        wave.map(async (c) => {
          const a = await ask(base, `/v1/market/candles?chain=${c.chain}&token=${c.address}&tf=${TF}&limit=${LIMIT}`, fetchFn);
          const s = a.status === 200 ? shapeOf(a.body) : null;
          return { ...c, status: a.status, ms: a.ms, ...(s === null ? { body: a.body.slice(0, 120) } : s.bad !== undefined ? { shape: s.bad } : s), ...(a.error ? { error: a.error } : {}) };
        }),
      )),
    );
  }
  return { base, at, tf: TF, chains, lists, reads };
}

const pct = (xs, p) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]);

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const chain of run.chains ?? []) {
    const l = run.lists?.[chain];
    if (l?.status !== 200 || !(l.coins > 0)) say(false, `${chain}: lists answered ${l?.status}${l?.coins === 0 ? " with no coin" : ""}; no chart read`);
  }
  if ((run.chains ?? []).length === 0) say(false, "no chain read");
  const counts = {};
  for (const r of run.reads ?? []) {
    const c = (counts[r.chain] ??= { charted: 0, noPool: 0, bad: 0 });
    const noPool = r.status === 404 || (r.status === 200 && r.bars === 0 && r.filling !== true && r.chain === "solana");
    const good = r.status === 200 && r.bars > 0;
    if (good) c.charted++;
    else if (noPool) c.noPool++;
    else {
      c.bad++;
      const what = r.status === 200 ? (r.shape ?? `${r.bars} bars${r.filling ? ", filling" : ""}${r.pool ? ", the lists name its pool" : ""}`) : `${r.status} ${r.body ?? r.error ?? ""}`.trim();
      say(false, `${r.chain} ${r.address}: ${what}`);
    }
  }
  for (const [chain, c] of Object.entries(counts)) {
    const ms = (run.reads ?? []).filter((r) => r.chain === chain).map((r) => r.ms);
    say(c.bad === 0, `${chain}: ${c.charted} charted, ${c.noPool} with no pool, ${c.bad} refused, of ${c.charted + c.noPool + c.bad} listed at ${run.tf}; answer p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const chains = opt("--chains", CHAINS.join(",")).split(",");
    if (chains.some((c) => !CHAINS.includes(c))) throw new Error(`--chains takes ${CHAINS.join(", ")}`);
    const run = await read(opt("--base", BASE), chains, fetch, sleep);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
