#!/usr/bin/env node
// Live check of card sol-tape-in-order: a busy Solana coin's tape on the helper is newest first by its blocks' times,
// each row dated by its own block. The deployed helper c775de255 dated a trade whose event has no clock (Orca, Raydium)
// by the second the stream sent it, 2 s after its block, so on TTWO's tape an Orca row sat above a DLMM row of its own
// block ("trade 29 is newer than trade 28", 18 Nov 16:49:43Z, both in slot 471007315, block time 1795020581 on two
// public RPCs). It reads the Solana Discover lists at HELPER_HOST (Origin APP_HOST), takes the COINS listed coins off
// pump.fun with the most volume in a day (several venues each: Orca, Raydium, Meteora, PumpSwap), and reads each tape
//   GET /v1/market/trades?chain=solana&token=<t>&limit=50   (READS times, GAP_MS apart)
// then reads the block time of SAMPLE rows of each read (getTransaction on the public RPC, scripts/live-checks/
// provider-answer.mjs: a provider's no-answer is left out, never judged). It passes only when:
//   - every read answers 200 with its trades newest first (no row dated after the row above it);
//   - every sampled row's time is its transaction's block time, to the second;
//   - at least MIN_DATED rows were read back (fewer: INCONCLUSIVE, exit 3).
// Card helper-sol-tape-checks-hold: each read is read as the page reads a 429 (candles-read.mjs): again at its
// Retry-After, the read counted once, for at most one 75 s span in the run; a 429 still standing after it is BAD with its
// waits named. The live helper's 429 on a read is its walks' or its window's refusal, which names its wait (live run
// 44665943571, 20 Nov 03:1xZ: "pumpCmXq read 1: answers 429", its next reads 200).
// After: helper
//   node scripts/live-checks/sol-tape-in-order.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";
import { candlesReader, waitsText } from "./candles-read.mjs";

const KEY = "sol-tape-in-order";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
const RPC = "https://api.mainnet-beta.solana.com";
export const COINS = 3;
export const READS = 4;
const GAP_MS = 3_000;
/** Rows read back per tape read: the newest of its trades with no clock of their own are among them on a busy coin. */
export const SAMPLE = 8;
export const MIN_DATED = 10;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const TRADES_PATH = (t) => `/v1/market/trades?chain=solana&token=${t}&limit=50`;

/** The busiest COINS listed coins off pump.fun, by their day's volume. */
export function busiest(rows) {
  const seen = new Map();
  for (const r of rows) if (typeof r?.token === "string" && B58.test(r.token) && r.launchpad !== "pump.fun" && !seen.has(r.token)) seen.set(r.token, Number(r.vol_24h_usd) || 0);
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, COINS).map(([t]) => t);
}

/** The rows of one read to read back: SAMPLE of them, spread over the tape. */
export const sampled = (trades) => trades.filter((_, i) => i % Math.max(1, Math.floor(trades.length / SAMPLE)) === 0).slice(0, SAMPLE);

/**
 * The verdict on one run: { base, coins: [{ coin, reads: [{ atMs, status, body }] }], blocks: { [tx]: blockTime |
 * { noAnswer } } }.
 */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let dated = 0;
  const coins = Array.isArray(run?.coins) ? run.coins : [];
  say(coins.length > 0, `${coins.length} busy listed coins off pump.fun read`);
  for (const c of coins) {
    for (const [i, r] of (c.reads ?? []).entries()) {
      const name = `${String(c.coin).slice(0, 8)} read ${i + 1}`;
      if (r.status !== 200) {
        say(false, `${name}: answers ${r.status}${waitsText(r)}`);
        continue;
      }
      let b;
      try {
        b = JSON.parse(r.body);
      } catch {
        say(false, `${name}: not JSON`);
        continue;
      }
      const t = Array.isArray(b?.trades) ? b.trades : null;
      if (t === null || t.some((x) => !Number.isSafeInteger(x?.t_ms) || !B58.test(x?.tx ?? ""))) {
        say(false, `${name}: trades not rows of t_ms and tx`);
        continue;
      }
      const back = t.findIndex((x, k) => k > 0 && x.t_ms > t[k - 1].t_ms);
      say(back === -1, `${name}: ${t.length} rows newest first${back === -1 ? "" : `: trade ${back} (${t[back].tx.slice(0, 10)}, ${t[back].t_ms}) is newer than trade ${back - 1} (${t[back - 1].tx.slice(0, 10)}, ${t[back - 1].t_ms})`}`);
      for (const x of sampled(t)) {
        const bt = run.blocks?.[x.tx];
        if (!Number.isSafeInteger(bt)) continue;
        dated++;
        if (x.t_ms !== bt * 1000) say(false, `${name}: ${x.tx.slice(0, 10)} dated ${x.t_ms}, its block ${bt * 1000} (${(x.t_ms - bt * 1000) / 1000} s off)`);
      }
    }
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  lines.push(`${dated >= MIN_DATED ? "ok " : "-- "} ${dated} sampled rows read back on ${new URL(RPC).host}${dated >= MIN_DATED ? "" : ` (at least ${MIN_DATED} needed to judge their dates)`}`);
  return { verdict: bad ? "FAIL" : dated < MIN_DATED ? "INCONCLUSIVE" : "PASS", lines };
}

async function get(base, path, fetchFn) {
  const atMs = Date.now();
  try {
    const r = await fetchFn(`${base}${path}`, { headers: { origin: APP }, signal: AbortSignal.timeout(15_000) });
    return { atMs, status: r.status, headers: { "retry-after": r.headers.get("retry-after") }, body: await r.text() };
  } catch (e) {
    throw new Error(`GET ${path} failed: ${e?.name === "TimeoutError" ? "timed out after 15 s" : e?.message}`);
  }
}

/** One live run against `base`. `reader`: the run's 429 reader (candles-read.mjs): a 429 is read again at its
 *  Retry-After, as the page reads it, within one span for the run. */
export async function read(base = BASE, fetchFn = fetch, reader = candlesReader()) {
  const lists = await get(base, "/v1/market/lists?chain=solana", fetchFn);
  if (lists.status !== 200) throw new Error(`lists answered ${lists.status}`);
  const coins = busiest(Object.values(JSON.parse(lists.body).lists ?? {}).flat()).map((coin) => ({ coin, reads: [] }));
  const tape = (c) => reader.read(() => get(base, TRADES_PATH(c.coin), fetchFn));
  // the first read opens each tape on the helper; its walk and stream fill it before the reads that count
  for (const c of coins) await tape(c);
  await new Promise((r) => setTimeout(r, 10_000));
  for (let i = 0; i < READS; i++) {
    for (const c of coins) c.reads.push(await tape(c));
    if (i < READS - 1) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const blocks = {};
  for (const c of coins) {
    for (const r of c.reads) {
      const t = r.status === 200 ? (JSON.parse(r.body).trades ?? []) : [];
      for (const x of sampled(t)) {
        if (x.tx in blocks || !B58.test(x.tx ?? "")) continue;
        const a = await rpcAnswer(RPC, "getTransaction", [x.tx, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], { nullNoAnswer: true });
        blocks[x.tx] = Number.isSafeInteger(a.result?.blockTime) ? a.result.blockTime : { noAnswer: a.noAnswer ?? (a.error ? JSON.stringify(a.error).slice(0, 80) : "no block time") };
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  return { base, coins, blocks };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
