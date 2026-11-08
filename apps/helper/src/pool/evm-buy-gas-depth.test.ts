// node --test apps/helper/src/pool/evm-buy-gas-depth.test.ts (card evm-buy-gas-depth): a pool buy goes out at every tree
// depth the pool takes, at a fee that survives a normal base-fee rise. PrivacyPoolSimple.buy reverts when gasleft() is
// under 651,000 before its swap, so eth_estimateGas lands on that floor: the estimates here are the least gas a buy lands
// with, measured on the pool at card pool-evm-buy-pays-revert (forge, isolate = true), plus the transaction's intrinsic
// gas (forge 1.7.1's least already holds the calldata, so the heaviest route counts it twice and errs high; kit
// pool-fee.ts). The fake chain is evm-release.test.ts's (Base Sepolia, 1 gwei, the pool's
// depth 2 at the epoch block), with the estimate and the latest block's base fee set per case.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmPoolFee, evmPoolGas } from "@blindfill/kit";
import { evmPoolSender, type EvmRpc } from "./evm.ts";

const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const CAST = JSON.parse(readFileSync(new URL("./fixtures/release-cast.json", import.meta.url), "utf8")) as { cases: Record<string, { callData: string }> };
const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const T0 = 1_999_999_000n;
const NOW = 2_000_000_000_000 - 100_000;
const EPOCH = 1_999_999_860_000;
const GWEI = 1_000_000_000n;
const DEPTH_DATA = `0x${Buffer.from(keccak_256(new TextEncoder().encode("currentTreeDepth()"))).subarray(0, 4).toString("hex")}`;
/** buy's return where its swap lands, abi.encode(true) */
const TRUE = `0x${"0".repeat(63)}1`;
type Calls = { method: string; params: readonly unknown[] }[];

function rpc(calls: Calls, o: { estimate: bigint; latestBase?: bigint; callAnswer?: string }): EvmRpc {
  const block = (n: bigint) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(T0 + 2n * n).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: `0x${(n === 600n && o.latestBase !== undefined ? o.latestBase : GWEI).toString(16)}` });
  return async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId": return "0x14a34";
      case "eth_getCode": return "0x";
      case "eth_call": {
        const [{ to, data }, at] = params as [{ to: string; data: string }, unknown];
        if (typeof at === "object" && at !== null && "blockHash" in at) return `0x${(to === "0x420000000000000000000000000000000000000f" ? (data.startsWith("0xf1c7a58b") ? 7_917n : 0n) : data === DEPTH_DATA ? 2n : 0n).toString(16).padStart(64, "0")}`;
        return o.callAnswer ?? TRUE;
      }
      case "eth_estimateGas": return `0x${o.estimate.toString(16)}`;
      case "eth_getBlockByNumber": return params[0] === "latest" ? block(600n) : BigInt(params[0] as string) <= 600n ? block(BigInt(params[0] as string)) : null;
      case "eth_maxPriorityFeePerGas": return "0x5f5e100";
      case "eth_getTransactionCount": return "0x7";
      case "eth_sendRawTransaction": return "0x";
      case "eth_getTransactionReceipt": return { status: "0x1" };
      case "eth_getBalance": return `0x${(10n ** 20n).toString(16)}`;
      default: throw new Error(`unexpected ${method}`);
    }
  };
}

/** The fields of a signed EIP-1559 transaction: 0x02 || rlp([chainId, nonce, tip, maxFee, gas, to, value, data, ...]). */
function txFields(raw: string): { maxFeePerGas: bigint; gas: bigint } {
  const b = Buffer.from(raw.slice(2), "hex");
  assert.equal(b[0], 2);
  let i = 1;
  const len = (p: number, short: number): [number, number] => {
    const x = b[p]!;
    if (x < short + 56) return [p + 1, x - short];
    const n = x - short - 55;
    return [p + 1 + n, Number(BigInt(`0x${b.subarray(p + 1, p + 1 + n).toString("hex")}`))];
  };
  [i] = len(i, 0xc0); // the list
  const items: bigint[] = [];
  for (let k = 0; k < 5; k++) {
    if (b[i]! < 0x80) { items.push(BigInt(b[i]!)); i += 1; continue; }
    const [at, n] = len(i, 0x80);
    items.push(n === 0 ? 0n : BigInt(`0x${b.subarray(at, at + n).toString("hex")}`));
    i = at + n;
  }
  return { maxFeePerGas: items[3]!, gas: items[4]! };
}

const carry = async (name: "buyBaseSepolia" | "withdrawBaseSepolia", o: { estimate: bigint; latestBase?: bigint; callAnswer?: string }) => {
  const calls: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO, receiptPollMs: 1, log: () => {} }, [rpc(calls, o), rpc([], o)], () => NOW);
  const a = await s.carry({ pool: POOL, data: CAST.cases[name]!.callData, epoch: EPOCH });
  const sent = calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => c.params[0] as string);
  // the simulation at "pending" (the fee's reads are eth_calls at a block hash)
  const sims = calls.filter((c) => c.method === "eth_call" && c.params[1] === "pending").map((c) => c.params[0] as { gas?: string });
  return { a, sent, sims };
};
const code = (a: { body: unknown }) => ((a.body as { error?: { code: string } }).error?.code ?? "ok");
/** The epoch fee the fixture's releases carry: the kit's rule at depth 2, 1 gwei and a chain fee of 7,917 wei. */
const FEE = evmPoolFee({ gas: evmPoolGas(2), gasPrice: GWEI, chainFee: 7_917n });

// the least gas measured (forge) plus each route's intrinsic gas: the helper's one-hop test buy (1,252 bytes of calldata,
// 33,244 intrinsic, measured with the top side node unset) and the largest calldata the helper carries (2,404 bytes, its
// intrinsic bounded at 21,000 + 16 x 2,404) at each depth's heaviest real tree state, with geth's and reth's 1.5% search
// slack (x 1000 / 985)
const ONE_HOP_DEPTH_2 = 1_082_371n + 33_244n;
const ONE_HOP_DEPTH_11 = 1_288_754n + 33_244n;
const slack = (g: bigint) => (g * 1000n + 984n) / 985n;
const HEAVIEST_DEPTH_2 = slack(1_110_751n + 21_000n + 16n * 2_404n);
const HEAVIEST_DEPTH_32 = slack(1_732_470n + 21_000n + 16n * 2_404n);

test("depth 11: a buy whose limit is the floor's estimate x 1.2 (1,586,397, over the old 1,500,000) goes out at that limit; a withdraw keeps EVM_GAS_MAX", async () => {
  const { a, sent } = await carry("buyBaseSepolia", { estimate: ONE_HOP_DEPTH_11 });
  assert.deepEqual([a.status, code(a), sent.length], [200, "ok", 1], JSON.stringify(a.body));
  assert.equal(txFields(sent[0]!).gas, 1_586_397n);
  const w = await carry("withdrawBaseSepolia", { estimate: ONE_HOP_DEPTH_11 });
  assert.deepEqual([w.a.status, code(w.a), w.sent.length], [422, "simulation_failed", 0], "a withdraw over 1,500,000 is still refused");
});

test("depth 32: the heaviest route's limit (2,183,067) goes out, its worst cost (gas x maxFeePerGas) at most the fee; over G(32) is refused", async () => {
  assert.equal(evmPoolGas(32), 2_194_363n, "the helper's buy gas cap, EVM_BUY_GAS_MAX");
  const { a, sent } = await carry("buyBaseSepolia", { estimate: HEAVIEST_DEPTH_32 });
  assert.deepEqual([a.status, code(a), sent.length], [200, "ok", 1], JSON.stringify(a.body));
  const { gas, maxFeePerGas } = txFields(sent[0]!);
  assert.equal(gas, 2_183_067n);
  assert.ok(gas * maxFeePerGas <= FEE, `worst ${gas * maxFeePerGas} over the fee ${FEE}`);
  // the boundary (review of f7f4631a, L2): an estimate whose x 1.2 is exactly G(32) goes out at G(32)
  const edge = await carry("buyBaseSepolia", { estimate: 1_828_636n });
  assert.deepEqual([edge.a.status, code(edge.a), edge.sent.length], [200, "ok", 1], JSON.stringify(edge.a.body));
  assert.equal(txFields(edge.sent[0]!).gas, evmPoolGas(32));
  // one estimate whose x 1.2 passes G(32): refused before any eth_call or send
  const over = ((evmPoolGas(32) + 1n) * 10n + 11n) / 12n; // the least estimate whose x 1.2 is G(32) + 1 or more
  assert.ok((over * 12n) / 10n > evmPoolGas(32) && ((over - 1n) * 12n) / 10n <= evmPoolGas(32));
  const r = await carry("buyBaseSepolia", { estimate: over });
  assert.deepEqual([r.a.status, code(r.a), r.sent.length], [422, "simulation_failed", 0]);
  assert.match(JSON.stringify(r.a.body), new RegExp(`over ${evmPoolGas(32)}`));
});

test("depth 2: a 7% base-fee rise since the epoch's block still sends; fee_stale only past a doubling", async () => {
  for (const estimate of [ONE_HOP_DEPTH_2, HEAVIEST_DEPTH_2]) {
    const up7 = await carry("buyBaseSepolia", { estimate, latestBase: (GWEI * 107n) / 100n });
    assert.deepEqual([up7.a.status, code(up7.a), up7.sent.length], [200, "ok", 1], `estimate ${estimate}: ${JSON.stringify(up7.a.body)}`);
    const doubled = await carry("buyBaseSepolia", { estimate, latestBase: 2n * GWEI });
    assert.deepEqual([doubled.a.status, code(doubled.a)], [200, "ok"], `estimate ${estimate}, base fee doubled: ${JSON.stringify(doubled.a.body)}`);
  }
  // past fee / limit (2.91e15 / 1,425,643 = 2.041 gwei for the heaviest route): fee_stale, nothing sent
  const past = await carry("buyBaseSepolia", { estimate: HEAVIEST_DEPTH_2, latestBase: (GWEI * 205n) / 100n });
  assert.deepEqual([past.a.status, code(past.a), past.sent.length], [422, "fee_stale", 0]);
});

test("pays-revert M1 on every gas path: a buy goes out only when its simulation at the very limit it signs answers true", async () => {
  // under the old 1,500,000 and over it, up to the depth-32 cap
  for (const estimate of [ONE_HOP_DEPTH_2, ONE_HOP_DEPTH_11, HEAVIEST_DEPTH_32]) {
    const ok = await carry("buyBaseSepolia", { estimate });
    assert.deepEqual([ok.a.status, ok.sent.length], [200, 1], `estimate ${estimate}: ${JSON.stringify(ok.a.body)}`);
    assert.equal(ok.sims.length, 1);
    assert.equal(BigInt(ok.sims[0]!.gas!), txFields(ok.sent[0]!).gas, "simulated at the gas limit it signs");
    // the swap would fail (buy returns false: the pool takes the fee and pays W ETH), or no word comes back
    for (const callAnswer of [`0x${"0".repeat(64)}`, "0x", `0x${"0".repeat(63)}2`]) {
      const no = await carry("buyBaseSepolia", { estimate, callAnswer });
      assert.deepEqual([no.a.status, code(no.a), no.sent.length], [422, "simulation_failed", 0], `estimate ${estimate}, eth_call ${callAnswer}`);
    }
  }
});

// card evm-buy-gas-floor, review of 498eae83 L1: the kit takes a route only where its swap fits 476,190 (500,000 / 1.05),
// which leaves 23,810 for what moves before the buy lands, less than one first crossing of a v4 tick (two fee-growth
// slots set from 0, 2 x 22,100). The helper's limit covers that: PrivacyPoolSimple.buy reverts SwapGasTooLow under
// BUY_SWAP_GAS + BUY_FAIL_GAS + 1,000 left (PrivacyPoolSimple.sol:75), so the estimate lands where that check passes and
// every gas of the limit above the estimate reaches the swap, which is given all but BUY_FAIL_GAS (:78; a 64th of the gas
// left is under BUY_FAIL_GAS, so EIP-150 takes nothing more): the swap gets at least BUY_SWAP_GAS + (limit - estimate)
test("evm-buy-gas-floor L1: at every measured estimate a buy's limit leaves its swap at least 544,200 gas (500,000 and two first tick crossings)", async () => {
  const [BUY_SWAP_GAS, TICK_CROSSINGS] = [500_000n, 2n * 22_100n];
  for (const estimate of [ONE_HOP_DEPTH_2, ONE_HOP_DEPTH_11, HEAVIEST_DEPTH_2, HEAVIEST_DEPTH_32]) {
    const { a, sent } = await carry("buyBaseSepolia", { estimate });
    assert.deepEqual([a.status, code(a), sent.length], [200, "ok", 1], JSON.stringify(a.body));
    const swap = BUY_SWAP_GAS + (txFields(sent[0]!).gas - estimate);
    assert.ok(swap >= BUY_SWAP_GAS + TICK_CROSSINGS, `estimate ${estimate}: the swap gets ${swap}`);
  }
});
