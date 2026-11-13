// The proof pass's own reads on mainnet, read only, timed: what a load's queue reads before and around each proof
// (src/pool-testnet.ts openQueue: the wallet's solanaPool on the page's pair as a pass reads it, pageSolanaRpcs("pass"),
// and the helper's GET /v1/pool/fee), with no prover and no note.
//   node packages/signpage/scripts/pool-pass-reads-mainnet.mjs <out.json> [binds=5]
// - The pool's time (pool.now), the epoch's trees cold and again, the newest trees, then `binds` binds one after another,
//   each to a W made fresh in this run from 32 random bytes (its key never kept, nothing signed): bind reads the pool's
//   time on both, the helper's fee for the epoch, and (once an epoch) the Rent sysvar and base fee.
// - Every fetch is counted by host, with its ms; nothing is sent but reads (JSON-RPC reads and the fee GET).
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";

const [OUT, bindsArg] = process.argv.slice(2);
if (!OUT) throw new Error("usage: pool-pass-reads-mainnet.mjs <out.json> [binds]");
const BINDS = Number(bindsArg ?? 5);
const calls = [];
const realFetch = globalThis.fetch;
const READS = new Set(["getSlot", "getBlockTime", "getBlock", "getMultipleAccounts", "getAccountInfo", "getFeeForMessage", "getLatestBlockhash", "getBlockHeight", "getEpochInfo", "getProgramAccounts", "getSignaturesForAddress", "getMinimumBalanceForRentExemption", "getHealth"]);
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
  const r = await realFetch(u, init);
  calls.push({ at: Math.round(t0 - START), ms: Math.round(performance.now() - t0), host: new URL(href).host, path: new URL(href).pathname, rpc, status: r.status });
  return r;
};
const START = performance.now();
const { pageSolanaRpcs, poolRelayFee } = await import("../src/pool-testnet.ts");
const { solanaPool, solanaPoolOf, SOL_POOLS } = await import("../../wallet/src/pool/solana.ts");
const pin = SOL_POOLS.mainnet;
const pool = solanaPool({ pin, rpcs: pageSolanaRpcs("pass"), relayFee: (e, s) => poolRelayFee(solanaPoolOf(pin.program).pool, e, s) });
const spans = [];
const span = async (name, f) => {
  const t0 = performance.now();
  const n0 = calls.length;
  try {
    const v = await f();
    spans.push({ name, at: Math.round(t0 - START), ms: Math.round(performance.now() - t0), calls: calls.length - n0 });
    return v;
  } catch (e) {
    spans.push({ name, at: Math.round(t0 - START), ms: Math.round(performance.now() - t0), calls: calls.length - n0, error: String(e?.message ?? e).slice(0, 200) });
    return null;
  }
};
const now = await span("pool.now", () => pool.now());
const start = now - (now % pool.epochMs);
const epoch = await span("trees(epoch) cold", () => pool.trees(start));
await span("trees(epoch) again", () => pool.trees(start));
await span("trees(newest)", () => pool.trees(now + 1n, undefined, { newest: true }));
for (let i = 0; i < BINDS; i++) {
  const sk = randomBytes(32);
  const publicKey = ed25519.getPublicKey(sk);
  sk.fill(0);
  await span(`bind ${i}`, () => pool.bind({ chunk: 5_000_000n, wallet: { address: base58.encode(publicKey), publicKey }, refundPrecommitment: 1n, epochStartMs: start, deadlineMs: start + pool.lifeMs }));
}
const out = { at: new Date().toISOString(), program: pin.program, leaves: epoch ? epoch.stateTree.size : null, spans, calls, hosts: Object.fromEntries([...new Set(calls.map((c) => c.host))].map((h) => [h, calls.filter((c) => c.host === h).length])) };
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const s of spans) console.log(`${s.name}: ${s.ms} ms, ${s.calls} calls${s.error ? `, ${s.error}` : ""}`);
console.log(`leaves ${out.leaves}; calls by host ${JSON.stringify(out.hosts)}`);
process.exit(0);
