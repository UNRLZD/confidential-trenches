// Replays card evm-buy-gas-depth's live check on its recorded answers (evm-buy-gas-depth.answers.json).
// Good: `good`, a real run (2026-11-07 08:10Z) of this card's helper code in process (--local: evmPoolSendersFromEnv
// with a throwaway sender key, nothing sent) over the kit's fee providers, on both testnet pools the deploy records name:
// each fee at least 2 x the epoch block's base fee x G(depth). Bad: `bad`, the same run of the helper code at main 332672aa
// (before this card), which priced G on a buy's gas used: Base Sepolia's fee the 1e13 floor, Robinhood testnet's 2e13,
// each under 2 x base x G(depth). The deployed helper did not yet serve these pools (404 on both, read the same minute).
//   node --test scripts/live-checks/evm-buy-gas-depth.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collect, judge } from "./evm-buy-gas-depth.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-buy-gas-depth.answers.json", import.meta.url), "utf8"));
const POOLS = ["0xeb967dfc1b4ffb22942f833c76866ea85fc42266", "0xed9fac860e6bc5e932455232eedca8b71c44da4d"];

test("the good answer (this card's helper) passes on both testnet pools", () => {
  assert.deepEqual(A.good.runs.map((r) => r.pool), POOLS);
  const r = judge(A.good.runs);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 2);
});

test("the bad answer (the helper at main 332672aa, before this card) fails on both pools: the fee is under 2 x base x G(depth)", () => {
  assert.deepEqual(A.bad.runs.map((r) => r.pool), POOLS);
  const r = judge(A.bad.runs);
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines.map((l) => l.split(" ")[0]), ["BAD", "BAD"], r.lines.join("\n"));
  assert.ok(r.lines.every((l) => / wei < 2 x /.test(l)), r.lines.join("\n"));
});

test("planted: no pool, a fee answer that is not 200, two providers on different blocks, base fees or depths, a depth past 32", () => {
  const good = A.good.runs[0];
  const with_ = (f) => [f(structuredClone(good))];
  assert.equal(judge([]).ok, false, "no pool");
  assert.equal(judge(with_((r) => ((r.fee.status = 503), r))).ok, false, "503");
  assert.equal(judge(with_((r) => ((r.fee.body.pool = POOLS[1]), r))).ok, false, "another pool's answer");
  assert.equal(judge(with_((r) => ((r.reads[1].hash = `0x${"1".repeat(64)}`), r))).ok, false, "two blocks");
  assert.equal(judge(with_((r) => ((r.reads[1].baseFeePerGas = "0x1"), r))).ok, false, "two base fees");
  assert.equal(judge(with_((r) => ((r.reads[1].depth = `0x${"0".repeat(63)}9`), r))).ok, false, "two depths");
  assert.equal(judge(with_((r) => ((r.reads = r.reads.slice(0, 1)), r))).ok, false, "one provider");
  assert.equal(judge(with_((r) => ((r.reads[0].depth = r.reads[1].depth = `0x${"0".repeat(62)}21`), r))).ok, false, "depth 33");
  // one step under what the rule needs fails; the good fee passes
  assert.equal(judge(with_((r) => ((r.fee.body.fee = "1"), r))).ok, false, "a fee of 1 wei");
});

test("collect reads the block on both fee providers and the depth at its hash, and skips a network with no pool", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push([new URL(url).host, method, params]);
    const result = method === "eth_getBlockByNumber" ? { hash: `0x${"a".repeat(64)}`, baseFeePerGas: "0x4c4b40" } : `0x${"0".repeat(63)}7`;
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  const runs = await collect(async (network, pool) => ({ status: 200, body: { network, pool, block: "0x10", fee: "20000000000000" } }), fetchFn, { base: null, "base-sepolia": POOLS[0] });
  assert.equal(runs.length, 1);
  assert.deepEqual(calls.map((c) => c[1]), ["eth_getBlockByNumber", "eth_call", "eth_getBlockByNumber", "eth_call"]);
  assert.deepEqual(calls[1][2], [{ to: POOLS[0], data: "0x4a2b75c8" }, { blockHash: `0x${"a".repeat(64)}` }]);
  assert.equal(new Set(calls.map((c) => c[0])).size, 2, "two providers");
  assert.equal(judge(runs).ok, true, judge(runs).lines.join("\n"));
});
