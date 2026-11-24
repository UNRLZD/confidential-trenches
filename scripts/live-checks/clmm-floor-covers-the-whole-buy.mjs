#!/usr/bin/env node
// Live check of card clmm-floor-covers-the-whole-buy: a buy of many tick-spacing cells is held to a coin's hidden
// market as a whole, never to the pool's current cell alone. A Raydium CLMM pool's floor (kit clmm.ts
// readSolanaClmmMarket, solanaClmmSwapOut) walks the pool's current tick array and the next two in the buy's direction,
// each read alike on both providers, across every initialized tick with its liquidity_net, as the program's swap does.
// Before it, a buy that left the cell was credited only to the cell's edge: MPLX's 10 SOL floor was 73% under what the
// program pays (24 Nov, tick -2582), so the price a thin pool beside it had to meet was far too low. This reads MPLX's
// wSOL pool BxRhW4q1… (the coin of check solana-buy-never-below-a-hidden-market) on api.mainnet-beta.solana.com and
// solana-rpc.publicnode.com, judged by the kit's own read, after every signing page deploy (the kit ships in it):
//   - a 25 SOL buy (about 3 cells on 24 Nov, 6.4 to 9 SOL a cell) is a market both providers agree on, priced whole on
//     each provider's read (the walk reached the buy's end inside the arrays both read alike);
//   - its floor is the coin's real price for 25 SOL: within PRICE_BAND_BPS of 25 SOL at DexScreener's priceNative for
//     the same pool, a source the device never uses, read at the same minute, and under the price's own bound.
// After: sign
// Record: both public providers' raw answers and DexScreener's price; a live run that fails keeps it beside its log
//   node scripts/live-checks/clmm-floor-covers-the-whole-buy.mjs [--record <file>] [--plant-lie]
//   PASS exit 0, FAIL 1, error 2. --record writes the run, which the .test.mjs replays; --plant-lie makes provider B's
//   tick array that holds the pool's price carry one more initialized tick than the chain's, as a provider that lies
//   would. Reads only: no key, no transaction.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSolanaClmmMarket, solanaJsonRpc } from "../../packages/kit/src/index.ts";
import { COIN, POOL, PROVIDERS } from "./solana-buy-never-below-a-hidden-market.mjs";

export const KEY = "clmm-floor-covers-the-whole-buy";
export const PRICE_BAND_BPS = 300n;
const SOL = 1_000_000_000n;
export const AMOUNT = 25n * SOL;
// the list's seventh account: the tick array that holds the pool's price (kit solanaClmmReadList)
const FIRST_ARRAY = 6;

/** A provider that answers each getMultipleAccounts from `answers` (by its account list), recording none. */
const replayRpc = (url, answers) => Object.assign(async (method, params) => {
  const a = answers[`${method} ${JSON.stringify(params[0])}`];
  if (a === undefined) throw new Error(`${url} was not asked ${method} ${JSON.stringify(params[0])}`);
  return structuredClone(a);
}, { url });

/** The verdict on a run { providers: { [url]: answers }, dex: { priceNative } }. */
export async function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const ps = PROVIDERS.map((u) => replayRpc(u, run?.providers?.[u] ?? {}));
  let r;
  try {
    r = await readSolanaClmmMarket(ps, { token: COIN, pool: POOL, side: "buy", amount: AMOUNT });
  } catch (e) {
    r = { kind: "bad", why: String(e?.message ?? e).slice(0, 200) };
  }
  say(r.kind === "ok", `[chain] MPLX's CLMM pool ${POOL.slice(0, 8)}… is a market both providers agree on (${r.kind}${r.kind === "bad" ? `: ${r.why}` : ""})`);
  const reads = r.kind === "ok" ? r.market.reads : [];
  say(reads.length === 2 && reads.every((x) => x.whole), `[chain] a ${AMOUNT / SOL} SOL buy is priced whole on each provider's read: ${reads.length ? reads.map((x) => (x.whole ? "whole" : "cut at the ticks read")).join(" / ") : "no read"}`);
  const dex = Number(run?.dex?.priceNative);
  const out = reads[0]?.out ?? 0n;
  // priceNative is SOL per MPLX; the floor is MPLX base units (6 decimals) for AMOUNT, after the pool's fee and its move
  const want = Number.isFinite(dex) && dex > 0 ? BigInt(Math.round((Number(AMOUNT / SOL) * 1e6) / dex)) : 0n;
  const off = want > 0n ? ((out > want ? out - want : want - out) * 10_000n) / want : 10_000n;
  say(want > 0n && off <= PRICE_BAND_BPS && reads.every((x) => x.out < x.spotOut), `[chain] its floor is the coin's real price: a ${AMOUNT / SOL} SOL buy must get at least ${Number(out) / 1e6} MPLX, DexScreener ${want > 0n ? Number(want) / 1e6 : "no price"} (${off} bps apart, want at most ${PRICE_BAND_BPS}, under the price's own bound)`);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** Both providers' answers to the kit's read and DexScreener's price of the pool. */
export async function read({ plantLie = false } = {}) {
  const providers = {};
  const rpcs = PROVIDERS.map((u, i) => {
    const rpc = solanaJsonRpc(u, { timeoutMs: 8_000 });
    providers[u] = {};
    return Object.assign(async (method, params, signal) => {
      let ans = await rpc(method, params, signal);
      // one more initialized tick (liquidity 1, behind the price) in B's tick array that holds the price
      const at = ans?.value?.[FIRST_ARRAY]?.data?.[0];
      if (plantLie && i === 1 && Array.isArray(params[0]) && params[0].length > FIRST_ARRAY && at) {
        const d = Buffer.from(at, "base64");
        const o = 44; // the array's first tick, at its start index
        d.writeInt32LE(d.readInt32LE(40), o);
        d.writeBigUInt64LE(d.readBigUInt64LE(o + 4) + 1n, o + 4);
        d.writeBigUInt64LE(d.readBigUInt64LE(o + 20) + 1n, o + 20);
        const value = [...ans.value];
        value[FIRST_ARRAY] = { ...ans.value[FIRST_ARRAY], data: [d.toString("base64"), "base64"] };
        ans = { ...ans, value };
      }
      providers[u][`${method} ${JSON.stringify(params[0])}`] = ans;
      return ans;
    }, { url: u });
  });
  await readSolanaClmmMarket(rpcs, { token: COIN, pool: POOL, side: "buy", amount: AMOUNT });
  const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${POOL}`, { redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (r.status !== 200) throw new Error(`DexScreener: HTTP ${r.status}`);
  const j = await r.json();
  const pair = Array.isArray(j?.pairs) ? j.pairs.find((p) => p?.pairAddress === POOL && p?.baseToken?.address === COIN) : null;
  return { readAt: new Date().toISOString(), plantLie, providers, dex: { priceNative: typeof pair?.priceNative === "string" ? pair.priceNative.slice(0, 32) : null } };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read({ plantLie: a.includes("--plant-lie") });
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = await judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(verdict === "PASS" ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e?.message ?? e).slice(0, 300)}`);
    process.exit(2);
  }
}
