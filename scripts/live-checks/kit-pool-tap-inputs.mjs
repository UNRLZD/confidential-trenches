#!/usr/bin/env node
// Live check of card kit-pool-tap-inputs: the kit's own USD price reads (poolUsdPrice and poolUsdToUnits, through the
// kit's public entry) work on the chains' real feeds, on two public RPCs of two operators per chain. It passes only when:
//   - each chain's two RPCs are of two operators (two hosts, and not one provider by the kit's own check);
//   - Solana: Pyth's SOL/USD account (POOL_USD_FEEDS.solana) reads the same bytes on both RPCs, is the Receiver's
//     PriceUpdateV2 of the SOL/USD feed, fully verified, its price positive, its confidence within the bound and its
//     publish time within 60 s of now (poolUsdPrice refuses otherwise);
//   - Base and Robinhood: each chain's own Chainlink ETH/USD proxy (POOL_USD_FEEDS.base, .robinhood) answers the same
//     decimals and latestRoundData on both RPCs at one block, positive and within the chain's bound; and description()
//     at that block is "ETH / USD" on both;
//   - the two ETH/USD feeds are within 1% of each other (their deviation thresholds are 0.15% and 0.5%): the kit itself
//     refuses a Robinhood price more than POOL_USD_CROSS_BPS from Base's, read in the same call on Base's two RPCs, and
//     this line checks the two reads above once more;
//   - poolUsdToUnits turns $100 into base units on each chain, rounded down, within 0.5% of 100 / the price read.
//   node scripts/live-checks/kit-pool-tap-inputs.mjs [--record <file>]     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read and the time of the run, for the test's replay (kit-pool-tap-inputs.answers.json).
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POOL_USD_FEEDS, poolUsdPrice, poolUsdToUnits, solanaJsonRpc, solanaSameProvider } from "../../packages/kit/src/index.ts";

const KEY = "kit-pool-tap-inputs";
/** Two public RPCs of two operators per chain. */
export const RPCS = {
  solana: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  robinhood: ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
};
const DESCRIPTION = "0x7284e416"; // description()

/** An ABI-encoded string answer (one offset, a length, the bytes), or null. */
function abiString(hex) {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{64}){2,}$/.test(hex)) return null;
  const h = hex.slice(2);
  if (BigInt(`0x${h.slice(0, 64)}`) !== 32n) return null;
  const n = Number(BigInt(`0x${h.slice(64, 128)}`));
  if (n > 256 || h.length < 128 + 2 * n) return null;
  return Buffer.from(h.slice(128, 128 + 2 * n), "hex").toString("utf8");
}

export async function check({ fetchFn = fetch, nowMs = Date.now(), rpcs = RPCS } = {}) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${text}`);
  };
  const eth = {};
  const basePair = rpcs.base.map((u) => solanaJsonRpc(u, { fetch: fetchFn }));
  for (const chain of ["solana", "base", "robinhood"]) {
    const [u0, u1] = rpcs[chain];
    const pair = [solanaJsonRpc(u0, { fetch: fetchFn }), solanaJsonRpc(u1, { fetch: fetchFn })];
    say(new URL(u0).host !== new URL(u1).host && !solanaSameProvider(pair[0], pair[1]), `${chain}: two operators, ${u0} and ${u1}`);
    const feed = POOL_USD_FEEDS[chain];
    let p;
    try {
      p = await poolUsdPrice({ chain, rpcs: pair, nowMs, ...(chain === "robinhood" ? { baseRpcs: basePair } : {}) });
    } catch (e) {
      say(false, `${chain}: ${feed.kind} ${feed.kind === "pyth" ? feed.account : feed.proxy}: ${String(e?.message ?? e).split("\n")[0]}`);
      continue;
    }
    const age = Math.floor(nowMs / 1000) - p.publishedS;
    say(true, `${chain}: ${p.source} ${p.asset}/USD ${p.price} x 10^${p.expo} agreed on both RPCs at ${p.source === "pyth" ? "slot" : "block"} ${p.at}, published ${new Date(p.publishedS * 1000).toISOString()}, ${age} s before now (bound ${feed.maxAgeS} s)`);
    if (feed.kind === "chainlink") {
      eth[chain] = p.price * 10n ** BigInt(18 + p.expo); // one ETH in USD x 10^18
      try {
        const at = `0x${p.at.toString(16)}`;
        const ds = await Promise.all(pair.map((rpc) => rpc("eth_call", [{ to: feed.proxy, data: DESCRIPTION }, at])));
        const names = ds.map(abiString);
        say(names.every((n) => n === "ETH / USD"), `${chain}: the feed ${feed.proxy}'s description() at block ${p.at} is ${names.map((n) => JSON.stringify(n)).join(" and ")}, want "ETH / USD" on both`);
      } catch (e) {
        say(false, `${chain}: description(): ${String(e?.message ?? e).split("\n")[0]}`);
      }
    }
    try {
      const units = await poolUsdToUnits({ chain, usd: "100", rpcs: pair, nowMs, ...(chain === "robinhood" ? { baseRpcs: basePair } : {}) });
      // 100 / the read's price, in base units: the second read may be a newer round, so within 0.5%
      const want = (100n * 10n ** BigInt(p.decimals - p.expo)) / p.price;
      const gap = units > want ? units - want : want - units;
      say(units > 0n && gap * 1000n <= want * 5n, `${chain}: $100 is ${units} base units of ${p.asset}, ${want} by the first read (within 0.5%)`);
    } catch (e) {
      say(false, `${chain}: poolUsdToUnits $100: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
  if (eth.base !== undefined && eth.robinhood !== undefined) {
    const gap = eth.base > eth.robinhood ? eth.base - eth.robinhood : eth.robinhood - eth.base;
    say(gap * 100n <= eth.base, `ETH/USD on Base ${eth.base} and on Robinhood ${eth.robinhood} (x 10^-18) within 1% of each other`);
  } else say(false, "ETH/USD on Base and on Robinhood: not both read");
  return { ok, lines };
}

/** fetch that keeps every JSON-RPC answer it passes on. */
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    answers.push({ url, method, params, status: r.status, json });
    return new Response(text, { status: r.status });
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const rec = recorder();
    const nowMs = Date.now();
    const r = await check({ fetchFn: opt("--record") ? rec.fetchFn : fetch, nowMs });
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ read: new Date(nowMs).toISOString(), nowMs, answers: rec.answers }) + "\n");
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(2);
  }
}
