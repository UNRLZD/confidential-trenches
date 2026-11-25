#!/usr/bin/env node
// Live check of card solana-buy-never-below-a-hidden-market: a Solana buy is priced against the coin's real market even
// where that market is a pool the device can read but not trade through (a Raydium CLMM pool), so a thin pool beside it
// can never sell the coin at a fraction of its price. The coin is MPLX (METAewgx…), whose deepest pool in any quote is
// the CLMM wSOL pool BxRhW4q1… (Discover census, 21 Nov 16:23Z). The sign page finds a coin's CLMM markets with the
// kit's scan on the helper's /v1/rpc/solana (kit clmm.ts readSolanaClmmPools) and reads each one on its two providers
// (readSolanaClmmMarket), and a market at the cutoff sets the price a buy must meet (pool.ts solanaReferenceSet). This
// reads, after every helper deploy:
//   - HELPER_HOST's /v1/rpc/solana, asked as the sign page asks (its Origin): the kit's CLMM scan of MPLX and wSOL
//     answers a list that names BxRhW4q1… (the helper carries the scan's exact shape and no wider one);
//   - the pool, its config, both vaults, MPLX's mint and the Clock on api.mainnet-beta.solana.com and
//     solana-rpc.publicnode.com, judged by the kit's own read: a market both providers agree on, never refused;
//   - its SOL depth is a deep market's (at least MIN_DEPTH_SOL on each provider);
//   - its floor for a 1 SOL buy (the out of the pool's current tick-spacing cell, the price a thin pool is held to) is
//     the coin's real price: within PRICE_BAND_BPS of DexScreener's priceNative for the same pool, a source the device
//     never uses, read at the same minute.
// After: helper
// Record: the helper's list, both public providers' raw answers and DexScreener's price; a live run that fails keeps it
// beside its log
//   node scripts/live-checks/solana-buy-never-below-a-hidden-market.mjs [--record <file>] [--plant-lie] [--helper <url>]
//   PASS exit 0, FAIL 1, error 2. --record writes the run (the helper's list and both providers' raw answers), which the
//   .test.mjs replays; --plant-lie makes provider B's answer hold a SOL vault 5% over the chain's, as a provider that
//   lies would; --helper asks another helper's /v1/rpc/solana (a helper built from a branch, before its deploy).
//   Reads only: no key, no transaction.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOLANA_RPC_WINDOW_RETRY, SOLANA_SOL_MINT, readSolanaClmmMarket, solanaClmmPoolScan, solanaJsonRpc } from "../../packages/kit/src/index.ts";
import { rpcAnswer } from "./provider-answer.mjs";

export const KEY = "solana-buy-never-below-a-hidden-market";
export const COIN = "METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m";
export const POOL = "BxRhW4q1wTRwJkJ1C4NR4yJCRL2uusoju4g1bVenspZK";
export const PROVIDERS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
export const HELPER = "https://ct-api.unrealized.trade";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
export const MIN_DEPTH_SOL = 1_000n;
export const PRICE_BAND_BPS = 300n;
const SOL = 1_000_000_000n;
const AMOUNT = SOL;

/** A provider that answers each getMultipleAccounts from `answers` (by its account list), recording none. */
const replayRpc = (url, answers) => Object.assign(async (method, params) => {
  const a = answers[`${method} ${JSON.stringify(params[0])}`];
  if (a === undefined) throw new Error(`${url} was not asked ${method} ${JSON.stringify(params[0])}`);
  return structuredClone(a);
}, { url });

/** The verdict on a run { scan: { status, result | error | noAnswer }, providers: { [url]: answers }, dex: { priceNative } }. */
export async function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const listed = Array.isArray(run?.scan?.result?.value) ? run.scan.result.value.map((e) => e?.pubkey) : null;
  say(run?.scan?.status === 200 && listed !== null && listed.includes(POOL), `[helper] /v1/rpc/solana carries the kit's CLMM scan of MPLX and wSOL from the sign page's origin and lists ${POOL.slice(0, 8)}… (HTTP ${run?.scan?.status ?? "none"}${listed ? `, ${listed.length} listed` : `, ${String(run?.scan?.error?.message ?? run?.scan?.noAnswer ?? "no list").slice(0, 120)}`})`);
  const ps = PROVIDERS.map((u) => replayRpc(u, run?.providers?.[u] ?? {}));
  let r;
  try {
    r = await readSolanaClmmMarket(ps, { token: COIN, pool: POOL, side: "buy", amount: AMOUNT });
  } catch (e) {
    r = { kind: "bad", why: String(e?.message ?? e).slice(0, 200) };
  }
  say(r.kind === "ok", `[chain] MPLX's CLMM pool ${POOL.slice(0, 8)}… is a market both providers agree on (${r.kind}${r.kind === "bad" ? `: ${r.why}` : ""})`);
  const depth = r.kind === "ok" ? r.market.reads.map((x) => x.depth) : [0n, 0n];
  say(depth.every((d) => d >= MIN_DEPTH_SOL * SOL), `[chain] its SOL depth is a deep market's: ${depth.map((d) => `${d / SOL} SOL`).join(" / ")} (want at least ${MIN_DEPTH_SOL} on each)`);
  const dex = Number(run?.dex?.priceNative);
  const out = r.kind === "ok" ? r.market.reads[0].out : 0n;
  // priceNative is SOL per MPLX; the floor is MPLX base units (6 decimals) for 1 SOL, after the pool's fee
  const want = Number.isFinite(dex) && dex > 0 ? BigInt(Math.round(1e6 / dex)) : 0n;
  const off = want > 0n ? ((out > want ? out - want : want - out) * 10_000n) / want : 10_000n;
  say(want > 0n && off <= PRICE_BAND_BPS, `[chain] its floor is the coin's real price: a 1 SOL buy must get at least ${Number(out) / 1e6} MPLX, DexScreener ${want > 0n ? Number(want) / 1e6 : "no price"} (${off} bps apart, want at most ${PRICE_BAND_BPS})`);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** The helper's scan answer, both providers' answers to the kit's read, and DexScreener's price of the pool. */
export async function read({ plantLie = false, helper = HELPER } = {}) {
  const a = await rpcAnswer(`${helper}/v1/rpc/solana`, "getProgramAccounts", solanaClmmPoolScan(COIN, SOLANA_SOL_MINT), { headers: { origin: SIGN_ORIGIN } });
  const scan = { status: a.status ?? null, ...(a.result !== undefined ? { result: a.result } : a.error !== undefined ? { error: a.error } : { noAnswer: String(a.noAnswer ?? "no answer").slice(0, 200) }) };
  const providers = {};
  const rpcs = PROVIDERS.map((u, i) => {
    // card live-checks-ride-out-a-public-rpc-stall: a stall is asked again within the kit's window (helper live run
    // 45526898423: "provider A gave no answer (the call failed)")
    const rpc = solanaJsonRpc(u, { timeoutMs: 8_000, retry: SOLANA_RPC_WINDOW_RETRY });
    providers[u] = {};
    return Object.assign(async (method, params, signal) => {
      let ans = await rpc(method, params, signal);
      // the pool's SOL vault is the list's fourth (token 1: wSOL); the list is the pool's six accounts, then its tick arrays
      if (plantLie && i === 1 && Array.isArray(params[0]) && params[0].length >= 6 && ans?.value?.[3]?.data?.[0]) {
        const d = Buffer.from(ans.value[3].data[0], "base64");
        d.writeBigUInt64LE((d.readBigUInt64LE(64) * 105n) / 100n, 64);
        const value = [...ans.value];
        value[3] = { ...ans.value[3], data: [d.toString("base64"), "base64"] };
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
  return { readAt: new Date().toISOString(), plantLie, helper: helper === HELPER ? "deployed" : "another", scan, providers, dex: { priceNative: typeof pair?.priceNative === "string" ? pair.priceNative.slice(0, 32) : null } };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read({ plantLie: a.includes("--plant-lie"), helper: a.includes("--helper") ? a[a.indexOf("--helper") + 1] : HELPER });
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
