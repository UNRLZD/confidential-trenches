// The EVM proof pass's own reads on mainnet, read only, timed (card evm-pool-spend-binds): the Base or Robinhood pool
// as src/pool-testnet.ts openEvmQueue builds it (the wallet's evmPool on the pass pair, its time read on the trade pair,
// the kit's fee list, the helper's GET /v1/pool/fee, the page's fee hold), with no prover and no note.
//   node packages/signpage/scripts/evm-pass-reads-mainnet.mjs <base|robinhood> <out.json> [rounds=6] [gapMs=10000]
// - Each round: the pool's time (the queue's now), the period's fee held (the turn's holdFee), the period's trees, then
//   one bind to a W made fresh in this run from 32 random bytes (its key never kept or printed, nothing signed).
// - Every fetch is counted by host, with its ms and status; nothing is sent but reads (JSON-RPC reads and the fee GET).
import { writeFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const [CHAIN, OUT, roundsArg, gapArg] = process.argv.slice(2);
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !OUT) throw new Error("usage: evm-pass-reads-mainnet.mjs <base|robinhood> <out.json> [rounds] [gapMs]");
const ROUNDS = Number(roundsArg ?? 6);
const GAP = Number(gapArg ?? 10_000);
// --owners-case: every publicnode and Pocket host fails as the owner's Firefox met them (scripts/firefox-rpc-blocked.mjs
// OWNERS_CASE: "CORS request did not succeed", no answer), the page's other hosts answered as they are
// --block <regex>: hosts matching it fail the same way (Chrome refusing a host's doubled CORS header, rpc.mainnet.chain.robinhood.com)
const OWNERS = process.argv.includes("--owners-case");
const BLOCK_AT = process.argv.indexOf("--block");
const BLOCK = BLOCK_AT > 0 ? new RegExp(process.argv[BLOCK_AT + 1]) : null;
const blocked = (h) => (OWNERS && /(^|\.)publicnode\.com$|(^|\.)pocket\.network$/.test(h)) || (BLOCK !== null && BLOCK.test(h));
const READS = new Set(["eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call", "eth_getLogs", "eth_chainId", "eth_getBalance", "eth_getTransactionCount"]);
const calls = [];
const realFetch = globalThis.fetch;
const START = performance.now();
globalThis.fetch = async (u, init) => {
  const href = typeof u === "string" ? u : u instanceof URL ? u.href : u.url;
  const method = (init?.method ?? "GET").toUpperCase();
  let rpc = null;
  if (method === "POST") {
    const body = JSON.parse(String(init?.body ?? "null"));
    const all = Array.isArray(body) ? body : [body];
    rpc = all.map((x) => x?.method).join(",");
    for (const x of all) if (!READS.has(x?.method)) throw new Error(`not a read: ${x?.method}`);
  } else if (method !== "GET") throw new Error(`not a read: ${method}`);
  const t0 = performance.now();
  if (blocked(new URL(href).host)) {
    calls.push({ at: Math.round(t0 - START), ms: 0, host: new URL(href).host, rpc, error: "blocked (owners case)" });
    throw new TypeError("NetworkError when attempting to fetch resource.");
  }
  try {
    const r = await realFetch(u, init);
    calls.push({ at: Math.round(t0 - START), ms: Math.round(performance.now() - t0), host: new URL(href).host, rpc, status: r.status });
    return r;
  } catch (e) {
    calls.push({ at: Math.round(t0 - START), ms: Math.round(performance.now() - t0), host: new URL(href).host, rpc, error: String(e?.message ?? e).slice(0, 120) });
    throw e;
  }
};
const P = await import("../src/pool-testnet.ts");
const W = await import("../../wallet/src/pool/evm.ts");
const { evmAddress } = await import("../../wallet/src/derive/index.ts");
const pin = W.EVM_POOLS[CHAIN];
const list = P.pageEvmPoolRpcs(CHAIN);
const passList = P.pageEvmPoolRpcs(CHAIN, "pass");
const tradePair = W.evmPair(list);
const passPair = W.evmPair(passList);
const feeHold = W.evmFeeHold(pin);
const pool = W.evmPool({
  pin,
  rpcs: passPair,
  feeRpcs: P.pageEvmFeeRpcs(CHAIN, "pass"),
  feeHold,
  history: [...passList, ...P.pageEvmHistory(pin)],
  relayFee: (ep, s) => P.evmPoolRelayFee(pin.pool, ep, s),
  epochFee: P.evmEpochFee,
});
// the queue's time: openEvmQueue's passNow, on the trade pair
const now = (s) => W.evmRetryLag(() => W.evmNow(tradePair, s), undefined, s);
const spans = [];
const dump = () => writeFileSync(OUT, JSON.stringify({ chain: CHAIN, owners: OWNERS, at: new Date().toISOString(), spans, calls }, null, 1));
setInterval(dump, 5_000).unref();
const span = async (round, name, f) => {
  const t0 = performance.now();
  const n0 = calls.length;
  try {
    const v = await f();
    spans.push({ round, name, at: Math.round(t0 - START), ms: Math.round(performance.now() - t0), calls: calls.length - n0, wall: Date.now() });
    console.log(`${new Date().toISOString()} round ${round} ${name} ${spans.at(-1).ms}ms ${spans.at(-1).calls} calls`);
    return v;
  } catch (e) {
    spans.push({ round, name, at: Math.round(t0 - START), ms: Math.round(performance.now() - t0), calls: calls.length - n0, wall: Date.now(), error: `${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 300)}` });
    console.log(`${new Date().toISOString()} round ${round} ${name} ${spans.at(-1).ms}ms ${spans.at(-1).calls} calls ERR ${spans.at(-1).error}`);
    return null;
  }
};
for (let i = 0; i < ROUNDS; i++) {
  const ms = await span(i, "now", () => now());
  if (ms === null) continue;
  const start = ms - (ms % W.EVM_EPOCH_MS);
  spans.at(-1).poolMs = Number(ms);
  spans.at(-1).intoPeriodMs = Number(ms - start);
  await span(i, "holdFee", () => pool.holdFee(start));
  await span(i, "trees(epoch)", () => pool.trees(start));
  const sk = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(sk, false);
  sk.fill(0);
  const address = evmAddress(publicKey);
  await span(i, "bind", () => pool.bind({ chunk: W.EVM_LADDER.min, wallet: { address, publicKey }, refundPrecommitment: 1n, epochStartMs: start, deadlineMs: start + W.EVM_LIFE_MS }));
  console.log(spans.filter((s) => s.round === i).map((s) => `${s.name} ${s.ms}ms${s.error ? ` ERR ${s.error}` : ""}${s.intoPeriodMs !== undefined ? ` (+${s.intoPeriodMs}ms into period)` : ""}`).join(" | "));
  if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, GAP));
}
dump();
process.exit(0);
