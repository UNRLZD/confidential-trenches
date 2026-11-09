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
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { collect, judge } from "./evm-buy-gas-depth.mjs";
import { EXIT, RETRY } from "./provider-answer.mjs";
import { JUDGED_403, NO_ANSWERS, plantedFetch } from "./provider-answer.plants.mjs";

// a no-answer is read again at once here, not after provider-answer.mjs's pause
RETRY.ms = 0;

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

const HASH = `0x${"a".repeat(64)}`;
const DEPTH = `0x${"0".repeat(63)}7`;
const ONE_POOL = { base: null, "base-sepolia": POOLS[0] };
const feeOf = async (network, pool) => ({ status: 200, body: { network, pool, block: "0x10", fee: "20000000000000" } });
const honest = (_url, { method }) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_getBlockByNumber" ? { hash: HASH, baseFeePerGas: "0x4c4b40" } : DEPTH }), { status: 200 });
// the fee providers, then the other quote providers (the check's providersOf)
const HOSTS = [...new Set([...evmPoolVenues()["base-sepolia"].feeProviders, ...evmPoolVenues()["base-sepolia"].providers].map((u) => new URL(u).host))];

test("collect reads the block on the fee providers then the quote providers and the depth at its hash, and skips a network with no pool", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push([new URL(url).host, method, params]);
    return honest(url, { method });
  };
  const runs = await collect(feeOf, fetchFn, ONE_POOL);
  assert.equal(runs.length, 1);
  assert.deepEqual(calls.map((c) => c[1]), HOSTS.flatMap(() => ["eth_getBlockByNumber", "eth_call"]));
  assert.deepEqual(calls[1][2], [{ to: POOLS[0], data: "0x4a2b75c8" }, { blockHash: HASH }]);
  assert.deepEqual([...new Set(calls.map((c) => c[0]))], HOSTS);
  assert.deepEqual(HOSTS.slice(0, 2), ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"], "the fee providers first");
  assert.ok(HOSTS.length >= 3, "a third provider to judge on when one does not answer");
  assert.equal(judge(runs).verdict, "PASS", judge(runs).lines.join("\n"));
});

// card live-checks-provider-no-answer: robinhood.drpc.org answered "Unknown state. First available state is 1" (code
// 27) and the check died with exit 2 (helper live run 42556116812, 9 Nov 03:54Z)
test("planted: each kind of no-answer from one provider is named and left out; the pool is judged on the others", async () => {
  for (const [name, ...plant] of NO_ANSWERS) {
    for (const read of ["eth_getBlockByNumber", "eth_call"]) {
      const fetchFn = async (url, init) => {
        const { method } = JSON.parse(init.body);
        return new URL(url).host === HOSTS[0] && method === read ? new Response(plant[1], { status: plant[0] }) : honest(url, { method });
      };
      const r = judge(await collect(feeOf, fetchFn, ONE_POOL));
      assert.equal(r.verdict, "PASS", `${name} on ${read}: ${r.lines.join("\n")}`);
      assert.ok(r.lines.some((l) => l.startsWith(`--- base-sepolia ${POOLS[0]} ${HOSTS[0]}: no answer: ${HOSTS[0]} HTTP ${plant[0]}`)), `${name} on ${read}: ${r.lines.join("\n")}`);
    }
  }
  // a null block (a provider a block behind) is one too
  const lag = async (url, init) => {
    const { method } = JSON.parse(init.body);
    return new URL(url).host === HOSTS[0] && method === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : honest(url, { method });
  };
  assert.equal(judge(await collect(feeOf, lag, ONE_POOL)).verdict, "PASS");
});

test("planted: fewer than two providers answering is INCONCLUSIVE (exit 3), never a pass", async () => {
  for (const [name, ...plant] of NO_ANSWERS) {
    const fetchFn = async (url, init) => (HOSTS.indexOf(new URL(url).host) < HOSTS.length - 1 ? new Response(plant[1], { status: plant[0] }) : honest(url, JSON.parse(init.body)));
    const r = judge(await collect(feeOf, fetchFn, ONE_POOL));
    assert.equal(r.verdict, "INCONCLUSIVE", `${name}: ${r.lines.join("\n")}`);
    assert.equal(r.ok, false);
  }
  assert.equal(EXIT.INCONCLUSIVE, 3);
  // and on the recorded good run, a pool whose second provider did not answer
  const good = structuredClone(A.good.runs);
  good[0].reads[1] = { host: good[0].reads[1].host, noAnswer: "planted" };
  assert.equal(judge(good).verdict, "INCONCLUSIVE");
});

test("planted: a wrong answer beside a no-answer still FAILs; a 403 that carries a real JSON-RPC error is judged", async () => {
  for (const [name, ...plant] of NO_ANSWERS) {
    for (const wrong of [{ hash: `0x${"b".repeat(64)}`, baseFeePerGas: "0x4c4b40" }, { hash: HASH, baseFeePerGas: "0x1" }]) {
      const fetchFn = async (url, init) => {
        const { method } = JSON.parse(init.body);
        const h = new URL(url).host;
        if (h === HOSTS[0]) return new Response(plant[1], { status: plant[0] });
        if (h === HOSTS[2] && method === "eth_getBlockByNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: wrong }), { status: 200 });
        return honest(url, { method });
      };
      const r = judge(await collect(feeOf, fetchFn, ONE_POOL));
      assert.equal(r.verdict, "FAIL", `${name}: ${r.lines.join("\n")}`);
    }
  }
  // a fee under the rule beside a no-answer
  const runs = await collect(async (network, pool) => ({ status: 200, body: { network, pool, block: "0x10", fee: "1" } }), plantedFetch(HOSTS[0], NO_ANSWERS[0].slice(1), honest), ONE_POOL);
  assert.equal(judge(runs).verdict, "FAIL");
  // a 403 with a real JSON-RPC error inside, on either read
  for (const read of ["eth_getBlockByNumber", "eth_call"]) {
    const fetchFn = async (url, init) => {
      const { method } = JSON.parse(init.body);
      return new URL(url).host === HOSTS[1] && method === read ? new Response(JUDGED_403[1], { status: JUDGED_403[0] }) : honest(url, { method });
    };
    const r = judge(await collect(feeOf, fetchFn, ONE_POOL));
    assert.equal(r.verdict, "FAIL", `${read}: ${r.lines.join("\n")}`);
  }
});

// review of 6cfd2778, P2-1: a block the helper names that every provider answers null for is the helper's wrong
// answer, a FAIL, never INCONCLUSIVE (no read again clears it)
test("planted: every provider that answered holds no such block: BAD, the helper named a block none holds", async () => {
  const none = async (url, init) => {
    const { method } = JSON.parse(init.body);
    return method === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : honest(url, { method });
  };
  const r = judge(await collect(feeOf, none, ONE_POOL));
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD base-sepolia ${POOLS[0]}: no provider holds block 0x10 (`)), r.lines.join("\n"));
  // one null and the rest rate-limited: still the helper's block nobody holds among those that answered
  const mixed = async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method !== "eth_getBlockByNumber") return honest(url, { method });
    return new URL(url).host === HOSTS[0] ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : new Response("", { status: 429 });
  };
  assert.equal(judge(await collect(feeOf, mixed, ONE_POOL)).verdict, "FAIL");
  // one null beside two that hold it: that provider lags, the pool is judged on the two
  const lag = async (url, init) => {
    const { method } = JSON.parse(init.body);
    return new URL(url).host === HOSTS[2] && method === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : honest(url, { method });
  };
  assert.equal(judge(await collect(feeOf, lag, ONE_POOL)).verdict, "PASS");
});
