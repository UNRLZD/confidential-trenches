#!/usr/bin/env node
// Live check of card solana-trades-show-on-every-token: a Solana token on a venue the helper's chain tape does not decode
// (it reads the pump.fun curve and PumpSwap only, apps/helper/src/data/solana/trades.ts) shows its trades. Before the
// card every such token's tape was empty: the deployed helper at main 204ee6b8a (2026-11-14 17:21Z) answered
// {"trades":[],"src":"chain"} for NEARKAT (a Raydium CPMM token, 29k USD a day on its token page) and for BONK, and its
// log read "no trade of a venue read" for every such token open. Now an empty chain tape is served the token's top
// pool's trades (apps/helper/src/data/solana/token.ts tape), and so is a Base or Robinhood token no pool of ours prices
// (Base SOGNI answered the same empty tape).
// With Origin APP, it reads GET /v1/market/trades?chain=<chain>&token=<t>&limit=50 at HELPER_HOST for each of TOKENS,
// again every FILL_POLL_MS while the answer is marked filling (tape-read.mjs), for FILLED_MS at most.
// PASS when every token answers 200 JSON { trades } with at least one row, every row well formed (t_ms, side b or s,
// usd and amt decimal text, tx a signature), newest first, and the newest within RECENT_MS of the read; FAIL otherwise.
// After: helper
//   node scripts/live-checks/solana-trades-show-on-every-token.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, for the test.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { FILL_POLL_MS, FILLED_MS, fillingOf } from "./tape-read.mjs";

export const KEY = "solana-trades-show-on-every-token";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
/** NEARKAT (Raydium CPMM) and BONK (Raydium, Orca, Meteora): neither trades on a venue the Solana chain tape decodes;
 *  SOGNI on Base (an Aerodrome USDT pool, 116k USD a day on 14 Nov): no pool the Base reads price (the same fix's EVM
 *  path, apps/helper/src/data/evm/swaps.ts noneTrades). */
export const TOKENS = {
  NEARKAT: { chain: "solana", coin: "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr" },
  BONK: { chain: "solana", coin: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  SOGNI: { chain: "base", coin: "0xe014d2a4da6e450f21b5050120d291e63c8940fd" },
};
/** The newest row is within this of the read [design: NEARKAT traded 10 times in the hour before 17:22Z on 14 Nov
 *  (getSignaturesForAddress), BONK every few seconds; 6 h leaves a quiet night room and still fails a stale tape]. */
export const RECENT_MS = 6 * 3_600_000;
const SIG = /^([1-9A-HJ-NP-Za-km-z]{64,88}|0x[0-9a-f]{64})$/;
const DEC = /^\d+(\.\d+)?$/;

/** What is wrong with one tape body read at `atMs`, or null when it holds recent, well-formed rows. */
export function tapeFault(body, atMs) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return "not JSON";
  }
  if (!Array.isArray(j?.trades)) return "no trades list";
  if (j.trades.length === 0) return `no trades (src ${j.src ?? "none"})`;
  for (const [i, r] of j.trades.entries()) {
    if (!Number.isSafeInteger(r?.t_ms) || (r.side !== "b" && r.side !== "s") || [r.usd, r.amt, r.tx].some((v) => typeof v !== "string") || !DEC.test(r.usd) || !DEC.test(r.amt) || !SIG.test(r.tx)) return `row ${i} out of shape`;
    if (i > 0 && r.t_ms > j.trades[i - 1].t_ms) return `row ${i} newer than row ${i - 1} (not newest first)`;
  }
  const age = atMs - j.trades[0].t_ms;
  if (age > RECENT_MS) return `newest row ${Math.round(age / 60_000)} min old`;
  return null;
}

/** The verdict on a run ({ tokens: { name: { status, body, atMs } } }): ok and one line per token. */
export function judge(run) {
  const lines = [];
  for (const name of Object.keys(TOKENS)) {
    const t = run.tokens?.[name];
    if (t === undefined) lines.push(`BAD ${name}: not read`);
    else if (t.status !== 200) lines.push(`BAD ${name}: status ${t.status}`);
    else {
      const f = tapeFault(t.body, t.atMs);
      if (f !== null) lines.push(`BAD ${name}: ${f}${fillingOf(t.body) ? ", still filling" : ""}`);
      else lines.push(`OK ${name}: ${JSON.parse(t.body).trades.length} rows, src ${JSON.parse(t.body).src}, newest ${Math.round((t.atMs - JSON.parse(t.body).trades[0].t_ms) / 1000)} s old`);
    }
  }
  return { ok: lines.every((l) => l.startsWith("OK")), lines };
}

async function readTape(base, { chain, coin }, fetchFn) {
  const url = `${base.replace(/\/$/, "")}/v1/market/trades?chain=${chain}&token=${coin}&limit=50`;
  const get = async () => {
    const r = await fetchFn(url, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: (await r.text()).slice(0, 200_000), atMs: Date.now() };
  };
  const t0 = Date.now();
  let a = await get();
  while (a.status === 200 && fillingOf(a.body) && Date.now() - t0 < FILLED_MS) {
    await new Promise((ok) => setTimeout(ok, FILL_POLL_MS));
    a = await get();
  }
  return a;
}

export async function run(base = BASE, fetchFn = fetch) {
  const tokens = {};
  for (const [name, t] of Object.entries(TOKENS)) tokens[name] = await readTape(base, t, fetchFn).catch((e) => ({ status: 0, body: String(e?.message ?? e).slice(0, 200), atMs: Date.now() }));
  return { base, tokens };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  try {
    const rec = await run(arg("--base") ?? BASE);
    if (arg("--record") !== undefined) writeFileSync(arg("--record"), JSON.stringify(rec, null, 1) + "\n");
    const v = judge(rec);
    for (const l of v.lines) console.log(l);
    console.log(`${KEY}: ${v.ok ? "PASS" : "FAIL"}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error ${String(e?.message ?? e)}`);
    process.exit(2);
  }
}
