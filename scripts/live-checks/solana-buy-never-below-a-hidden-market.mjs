#!/usr/bin/env node
// Live check of card solana-buy-never-below-a-hidden-market: a coin whose deepest pool is one the device cannot trade
// through (a Raydium CLMM pool) is still priced from the chain, on two providers that agree. The coin is MPLX
// (METAewgx…), whose deepest pool in any quote is the CLMM wSOL pool BxRhW4q1… (Discover census, 21 Nov 16:23Z). The
// check reads the pool and both vaults on api.mainnet-beta.solana.com and solana-rpc.publicnode.com, keeps both
// answers, and judges them with the kit's own read (readSolanaClmmSpot, packages/kit/src/trade/solana/clmm.ts):
//   - the two providers agree: a market, never refused, never "none";
//   - its SOL depth is a deep market's (at least MIN_DEPTH_SOL on each provider);
//   - its spot price is the coin's real one: within PRICE_BAND_BPS of DexScreener's priceNative for the same pool, a
//     source the device never uses, read at the same minute.
// The rest of the card's end state (the sign page's buy refused below that market) lands with the card's next round,
// which wires the read into the reference; the check then gains SIGN_HOST's part and an After line.
// Runs: pending solana-buy-never-below-a-hidden-market, the sign page reads no CLMM market until the card's next round
//   node scripts/live-checks/solana-buy-never-below-a-hidden-market.mjs [--record <file>] [--plant-lie]
//   PASS exit 0, FAIL 1, error 2. --record writes the run (both providers' raw answers), which the .test.mjs replays;
//   --plant-lie makes provider B's answer hold a SOL vault 5% over the chain's, as a provider that lies would.
//   Reads only: no key, no transaction.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSolanaClmmSpot, solanaJsonRpc } from "../../packages/kit/src/index.ts";

export const KEY = "solana-buy-never-below-a-hidden-market";
export const COIN = "METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m";
export const POOL = "BxRhW4q1wTRwJkJ1C4NR4yJCRL2uusoju4g1bVenspZK";
export const PROVIDERS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
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

/** The verdict on a run { providers: { [url]: answers }, dex: { priceNative } }: { ok, verdict, lines }. */
export async function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const ps = PROVIDERS.map((u) => replayRpc(u, run?.providers?.[u] ?? {}));
  let r;
  try {
    r = await readSolanaClmmSpot(ps, { token: COIN, pool: POOL, side: "buy", amount: AMOUNT });
  } catch (e) {
    r = { kind: "bad", why: String(e?.message ?? e).slice(0, 200) };
  }
  say(r.kind === "ok", `[chain] MPLX's CLMM pool ${POOL.slice(0, 8)}… is a market both providers agree on (${r.kind}${r.kind === "bad" ? `: ${r.why}` : ""})`);
  const depth = r.kind === "ok" ? r.spot.depth : [0n, 0n];
  say(depth.every((d) => d >= MIN_DEPTH_SOL * SOL), `[chain] its SOL depth is a deep market's: ${depth.map((d) => `${d / SOL} SOL`).join(" / ")} (want at least ${MIN_DEPTH_SOL} on each)`);
  const dex = Number(run?.dex?.priceNative);
  const out = r.kind === "ok" ? r.spot.spotOut[0] : 0n;
  // priceNative is SOL per MPLX; the spot out is MPLX base units (6 decimals) for 1 SOL
  const want = Number.isFinite(dex) && dex > 0 ? BigInt(Math.round(1e6 / dex)) : 0n;
  const off = want > 0n ? ((out > want ? out - want : want - out) * 10_000n) / want : 10_000n;
  say(want > 0n && off <= PRICE_BAND_BPS, `[chain] its spot price is the coin's real one: 1 SOL buys ${Number(out) / 1e6} MPLX at spot, DexScreener ${want > 0n ? Number(want) / 1e6 : "no price"} (${off} bps apart, want at most ${PRICE_BAND_BPS})`);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** Both providers' answers to the kit's read, and DexScreener's price of the pool. */
export async function read({ plantLie = false } = {}) {
  const providers = {};
  const rpcs = PROVIDERS.map((u, i) => {
    const rpc = solanaJsonRpc(u, { timeoutMs: 8_000 });
    providers[u] = {};
    return Object.assign(async (method, params, signal) => {
      let a = await rpc(method, params, signal);
      if (plantLie && i === 1 && Array.isArray(params[0]) && params[0].length === 3 && a?.value?.[2]?.data?.[0]) {
        const d = Buffer.from(a.value[2].data[0], "base64");
        d.writeBigUInt64LE((d.readBigUInt64LE(64) * 105n) / 100n, 64);
        a = { ...a, value: [a.value[0], a.value[1], { ...a.value[2], data: [d.toString("base64"), "base64"] }] };
      }
      providers[u][`${method} ${JSON.stringify(params[0])}`] = a;
      return a;
    }, { url: u });
  });
  await readSolanaClmmSpot(rpcs, { token: COIN, pool: POOL, side: "buy", amount: AMOUNT });
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
