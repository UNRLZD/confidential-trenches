#!/usr/bin/env node
// Live check of card evm-buy-gas-depth: the deployed helper prices each EVM pool's epoch fee on the gas limit it signs
// a buy with, so the fee per gas of that limit is at least twice the epoch block's base fee and a buy is fee_stale only
// once the base fee has doubled. PrivacyPoolSimple.buy reverts when gasleft() is under 651,000 before its swap, so a
// buy's limit (eth_estimateGas, which lands on that floor, x 1.2) is about twice its gas used; the kit's G(depth)
// (packages/kit/src/trade/evm/pool-fee.ts) covers it at every depth, which packages/kit/test/evm-pool-fee.test.ts holds
// against the measured table. For each EVM pool a deploy record names (scripts/ci/helper-live-checks.mjs evmPools):
//   - GET <helper>/v1/pool/fee?pool=<pool>: 200, this network and pool, the epoch's first block and its fee in wei;
//   - that block, read by number on both of the kit's fee providers for the network (evmPoolVenues feeProviders): one
//     hash and one base fee on both, and the pool's currentTreeDepth() at that hash, one word on both;
//   - the fee is at least 2 x the base fee x G(depth).
// The helper before this card priced G on the buy's gas used (686,816 at depth 2), under half of its limit: its fee on
// Base Sepolia at a 0.005 gwei base fee was the one-step floor, 1e13 wei, under 2 x 0.005 gwei x G(4) = 1.477e13.
// The buy's gas cap (EVM_BUY_GAS_MAX = G(32)) is not visible from outside: its proof is apps/helper/src/pool/
// evm-buy-gas-depth.test.ts.
//   node scripts/live-checks/evm-buy-gas-depth.mjs [--base <helper url>] [--record <file> --as good|bad] [--local]
//     PASS exit 0, FAIL exit 1, error exit 2
// --local answers the fee from this tree's helper code in process (evmPoolSendersFromEnv with a throwaway sender key
// made at run time, which holds nothing and sends nothing) over the same providers: how the good answer was recorded
// before the deploy. --record writes the run under `--as` in the file (evm-buy-gas-depth.answers.json), replayed by
// evm-buy-gas-depth.test.mjs.
import "../net-window.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evmPoolGas, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { evmPools } from "../ci/helper-live-checks.mjs";

export const BASE = "https://api.confidential.unrealized.trade";
/** currentTreeDepth() (State.sol), as evm-buy-hookdata-fee.mjs reads it */
const TREE_DEPTH = "0x4a2b75c8";
const HEX = /^0x[0-9a-f]+$/;
const DEC = /^[0-9]{1,40}$/;

const rpcOf = (url, fetchFn) => async (method, params) => {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const j = await r.json();
  if (j?.error !== undefined) throw new Error(`${new URL(url).host} ${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j?.result;
};

/** One run: each pool's fee answer and the reads of its block on both fee providers. `feeOf(network, pool)` gives the
 *  helper's answer as { status, body }. */
export async function collect(feeOf, fetchFn = fetch, pools = evmPools()) {
  const runs = [];
  for (const [network, pool] of Object.entries(pools)) {
    if (pool === null) continue;
    const fee = await feeOf(network, pool);
    const reads = [];
    const block = fee?.body?.block;
    if (fee?.status === 200 && typeof block === "string" && HEX.test(block)) {
      for (const url of evmPoolVenues()[network].feeProviders) {
        const rpc = rpcOf(url, fetchFn);
        const b = await rpc("eth_getBlockByNumber", [block, false]);
        const depth = b?.hash === undefined ? null : await rpc("eth_call", [{ to: pool, data: TREE_DEPTH }, { blockHash: b.hash }]);
        reads.push({ host: new URL(url).host, hash: b?.hash ?? null, baseFeePerGas: b?.baseFeePerGas ?? null, depth });
      }
    }
    runs.push({ network, pool, fee, reads });
  }
  return runs;
}

/** PASS lines and BAD lines for one run; ok when there is a pool and every pool passes. */
export function judge(runs) {
  const lines = [];
  const say = (ok, line) => lines.push(`${ok ? "PASS" : "BAD"} ${line}`);
  if (!Array.isArray(runs) || runs.length === 0) say(false, "no EVM pool to check");
  for (const r of Array.isArray(runs) ? runs : []) {
    const n = `${r?.network} ${r?.pool}`;
    const b = r?.fee?.body;
    if (r?.fee?.status !== 200 || b?.network !== r.network || b?.pool !== r.pool || typeof b?.fee !== "string" || !DEC.test(b.fee) || typeof b?.block !== "string" || !HEX.test(b.block)) {
      say(false, `${n}: the fee answer ${JSON.stringify(r?.fee).slice(0, 300)}`);
      continue;
    }
    const reads = Array.isArray(r.reads) ? r.reads : [];
    const word = (x) => (typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x) ? BigInt(x) : null);
    const one = reads.length === 2 && reads.every((x) => typeof x.hash === "string" && x.hash === reads[0].hash && typeof x.baseFeePerGas === "string" && HEX.test(x.baseFeePerGas) && x.baseFeePerGas === reads[0].baseFeePerGas && word(x.depth) !== null && x.depth === reads[0].depth);
    if (!one) {
      say(false, `${n}: block ${b.block} is not one block, base fee and tree depth on both fee providers: ${JSON.stringify(reads).slice(0, 400)}`);
      continue;
    }
    const depth = word(reads[0].depth);
    if (depth > 32n) {
      say(false, `${n}: tree depth ${depth} past the pool's 32`);
      continue;
    }
    const base = BigInt(reads[0].baseFeePerGas);
    const fee = BigInt(b.fee);
    const g = evmPoolGas(Number(depth));
    const need = 2n * base * g;
    say(fee >= need, `${n}: block ${BigInt(b.block)} (${reads.map((x) => x.host).join(", ")}), base fee ${base} wei, tree depth ${depth}: fee ${fee} wei ${fee >= need ? ">=" : "<"} 2 x ${base} x G(${depth}) ${g} = ${need}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("PASS")), lines };
}

const httpFee = (base, fetchFn) => async (_network, pool) => {
  const r = await fetchFn(`${base}/v1/pool/fee?pool=${pool}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
};

/** This tree's helper code, in process, with a throwaway sender key: the answer GET /v1/pool/fee gives (server.ts). */
async function localFee() {
  const { evmPoolSendersFromEnv } = await import("../../apps/helper/src/pool/evm.ts");
  return async (network, pool) => {
    const NAME = network.toUpperCase().replace(/-/g, "_");
    const senders = evmPoolSendersFromEnv({ [`POOL_EVM_ADDRESS_${NAME}`]: pool, [`POOL_EVM_SENDER_KEY_${NAME}`]: `0x${randomBytes(32).toString("hex")}` });
    const s = senders.get(pool);
    const body = await s.fee(Date.now());
    return body === null ? { status: 404, body } : { status: 200, body };
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  try {
    const feeOf = args.includes("--local") ? await localFee() : httpFee(opt("--base") ?? BASE, fetch);
    const runs = await collect(feeOf);
    const r = judge(runs);
    for (const l of r.lines) console.log(l);
    const file = opt("--record");
    if (file !== undefined) {
      const as = opt("--as");
      if (as !== "good" && as !== "bad") throw new Error("--record takes --as good or --as bad");
      const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      all[as] = { at: new Date().toISOString(), from: args.includes("--local") ? "local" : opt("--base") ?? BASE, runs };
      writeFileSync(file, `${JSON.stringify(all, null, 1)}\n`);
    }
    console.log(r.ok ? "PASS evm-buy-gas-depth" : "FAIL evm-buy-gas-depth");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`evm-buy-gas-depth: ${e?.message ?? e}`);
    process.exit(2);
  }
}
