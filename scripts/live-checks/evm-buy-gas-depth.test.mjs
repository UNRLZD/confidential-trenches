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
// card evm-fee-quiet-epoch: the time now and the chain's head on every provider (a second before it), and the helper's
// answer for the epoch it is asked
const NOW = 1_800_000_030_000;
const EPOCH = 1_800_000_000_000;
const HEAD = { number: "0x20", timestamp: `0x${(NOW / 1000 - 1).toString(16)}` };
const feeOf = async (network, pool, epochMs) => ({ status: 200, body: { network, pool, epoch_start_ms: epochMs, block: "0x10", fee: "20000000000000" } });
const honest = (_url, { method, params }) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_getBlockByNumber" ? (params?.[0] === "latest" ? { ...HEAD, hash: `0x${"c".repeat(64)}`, baseFeePerGas: "0x4c4b40" } : { hash: HASH, baseFeePerGas: "0x4c4b40" }) : DEPTH }), { status: 200 });
/** `f` for every read but the head, which every provider answers honestly */
const headsHonest = (f) => async (url, init) => {
  const b = JSON.parse(init.body);
  return b.method === "eth_getBlockByNumber" && b.params[0] === "latest" ? honest(url, b) : f(url, init);
};
const at = () => NOW;
// the fee providers, then the other quote providers (the check's providersOf)
const HOSTS = [...new Set([...evmPoolVenues()["base-sepolia"].feeProviders, ...evmPoolVenues()["base-sepolia"].providers].map((u) => new URL(u).host))];

test("collect reads the block on the fee providers then the quote providers and the depth at its hash, and skips a network with no pool", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push([new URL(url).host, method, params]);
    return honest(url, { method, params });
  };
  const runs = await collect(feeOf, fetchFn, ONE_POOL, at);
  assert.equal(runs.length, 1);
  // the head on the first two providers, then the block and the depth on each
  assert.deepEqual(calls.slice(0, 2).map((c) => [c[0], c[1], c[2][0]]), HOSTS.slice(0, 2).map((h) => [h, "eth_getBlockByNumber", "latest"]));
  assert.deepEqual(calls.slice(2).map((c) => c[1]), HOSTS.flatMap(() => ["eth_getBlockByNumber", "eth_call"]));
  assert.deepEqual(calls[3][2], [{ to: POOLS[0], data: "0x4a2b75c8" }, { blockHash: HASH }]);
  assert.equal(runs[0].epochMs, EPOCH, "the epoch both heads are in");
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
        return new URL(url).host === HOSTS[0] && method === read ? new Response(plant[1], { status: plant[0] }) : honest(url, JSON.parse(init.body));
      };
      const r = judge(await collect(feeOf, headsHonest(fetchFn), ONE_POOL, at));
      assert.equal(r.verdict, "PASS", `${name} on ${read}: ${r.lines.join("\n")}`);
      assert.ok(r.lines.some((l) => l.startsWith(`--- base-sepolia ${POOLS[0]} ${HOSTS[0]}: no answer: ${HOSTS[0]} HTTP ${plant[0]}`)), `${name} on ${read}: ${r.lines.join("\n")}`);
    }
  }
  // a null block (a provider a block behind) is one too
  const lag = async (url, init) => {
    const { method } = JSON.parse(init.body);
    return new URL(url).host === HOSTS[0] && method === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : honest(url, JSON.parse(init.body));
  };
  assert.equal(judge(await collect(feeOf, headsHonest(lag), ONE_POOL, at)).verdict, "PASS");
});

test("planted: fewer than two providers answering is INCONCLUSIVE (exit 3), never a pass", async () => {
  for (const [name, ...plant] of NO_ANSWERS) {
    const fetchFn = async (url, init) => (HOSTS.indexOf(new URL(url).host) < HOSTS.length - 1 ? new Response(plant[1], { status: plant[0] }) : honest(url, JSON.parse(init.body)));
    const r = judge(await collect(feeOf, headsHonest(fetchFn), ONE_POOL, at));
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
        return honest(url, JSON.parse(init.body));
      };
      const r = judge(await collect(feeOf, headsHonest(fetchFn), ONE_POOL, at));
      assert.equal(r.verdict, "FAIL", `${name}: ${r.lines.join("\n")}`);
    }
  }
  // a fee under the rule beside a no-answer
  const runs = await collect(async (network, pool, epochMs) => ({ status: 200, body: { network, pool, epoch_start_ms: epochMs, block: "0x10", fee: "1" } }), headsHonest(plantedFetch(HOSTS[0], NO_ANSWERS[0].slice(1), honest)), ONE_POOL, at);
  assert.equal(judge(runs).verdict, "FAIL");
  // a 403 with a real JSON-RPC error inside, on either read
  for (const read of ["eth_getBlockByNumber", "eth_call"]) {
    const fetchFn = async (url, init) => {
      const { method } = JSON.parse(init.body);
      return new URL(url).host === HOSTS[1] && method === read ? new Response(JUDGED_403[1], { status: JUDGED_403[0] }) : honest(url, JSON.parse(init.body));
    };
    const r = judge(await collect(feeOf, headsHonest(fetchFn), ONE_POOL, at));
    assert.equal(r.verdict, "FAIL", `${read}: ${r.lines.join("\n")}`);
  }
});

// review of 6cfd2778, P2-1: a block the helper names that every provider answers null for is the helper's wrong
// answer, a FAIL, never INCONCLUSIVE (no read again clears it)
test("planted: every provider that answered holds no such block: BAD, the helper named a block none holds", async () => {
  const none = async (url, init) => {
    const { method } = JSON.parse(init.body);
    return method === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : honest(url, JSON.parse(init.body));
  };
  const r = judge(await collect(feeOf, headsHonest(none), ONE_POOL, at));
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD base-sepolia ${POOLS[0]}: no provider holds block 0x10 (`)), r.lines.join("\n"));
  // one null and the rest rate-limited: one provider lagging at an epoch's turn, INCONCLUSIVE (delta review P3-a); two
  // nulls and one rate-limited: FAIL
  const nulls = (k) => async (url, init) => {
    const { method } = JSON.parse(init.body);
    if (method !== "eth_getBlockByNumber") return honest(url, JSON.parse(init.body));
    return HOSTS.indexOf(new URL(url).host) < k ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : new Response("", { status: 429 });
  };
  assert.equal(judge(await collect(feeOf, headsHonest(nulls(1)), ONE_POOL, at)).verdict, "INCONCLUSIVE");
  assert.equal(judge(await collect(feeOf, headsHonest(nulls(2)), ONE_POOL, at)).verdict, "FAIL");
  assert.equal(HOSTS.length, 3);
  // one null beside two that hold it: that provider lags, the pool is judged on the two
  const lag = async (url, init) => {
    const { method } = JSON.parse(init.body);
    return new URL(url).host === HOSTS[2] && method === "eth_getBlockByNumber" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }) : honest(url, JSON.parse(init.body));
  };
  assert.equal(judge(await collect(feeOf, headsHonest(lag), ONE_POOL, at)).verdict, "PASS");
});

// card evm-fee-quiet-epoch: helper live run 42726731385 (10 Nov 00:15:00Z) asked robinhood-testnet's fee for the epoch
// now in its first half second, before the helper's provider held a block in it, and went red on 404 not_found; the
// same ask answered 200 two minutes later. The check now names the epoch from the heads and steps back once on the
// helper's "no block yet".
const INDEX_BEHIND = { status: 503, body: { error: { code: "index_behind" } } };
const NOT_FOUND = { status: 404, body: { error: { code: "not_found" } } };
/** feeOf answering `first` for the epoch the heads name and `then` for any other, each ask logged */
const feeSeq = (first, then, asked) => async (network, pool, epochMs) => {
  asked.push(epochMs);
  if (epochMs === asked[0]) return structuredClone(first);
  return then === "good" ? feeOf(network, pool, epochMs) : structuredClone(then);
};
const honestFetch = (url, init) => honest(url, JSON.parse(init.body));
const headsAt = (seconds) => async (url, init) => {
  const b = JSON.parse(init.body);
  if (b.method === "eth_getBlockByNumber" && b.params[0] === "latest") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x20", timestamp: `0x${seconds(new URL(url).host).toString(16)}`, hash: `0x${"c".repeat(64)}`, baseFeePerGas: "0x1" } }), { status: 200 });
  return honest(url, b);
};

test("the epoch now with no block yet on the helper (503 index_behind, or 404 from the helper before): the epoch before is asked and judged, PASS", async () => {
  for (const first of [INDEX_BEHIND, NOT_FOUND]) {
    const asked = [];
    const runs = await collect(feeSeq(first, "good", asked), honestFetch, ONE_POOL, at);
    assert.deepEqual(asked, [EPOCH, EPOCH - 60_000], `${first.status}: the epoch the heads name, then the one before`);
    const r = judge(runs);
    assert.equal(r.verdict, "PASS", r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith(`--- base-sepolia ${POOLS[0]}: the helper answered ${first.status} `) && l.includes("judged the epoch before")), r.lines.join("\n"));
  }
});

test("a pool the helper does not carry (404 to both epochs) FAILs; no block in the epoch before either, which both heads are a minute past, FAILs", async () => {
  for (const [first, then] of [[NOT_FOUND, NOT_FOUND], [INDEX_BEHIND, INDEX_BEHIND], [INDEX_BEHIND, NOT_FOUND]]) {
    const r = judge(await collect(feeSeq(first, then, []), honestFetch, ONE_POOL, at));
    assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith(`BAD base-sepolia ${POOLS[0]}: the fee answer for epoch ${new Date(EPOCH - 60_000).toISOString()} {"status":${then.status}`)), r.lines.join("\n"));
  }
});

test("both heads before the epoch now (a quiet chain): the newest epoch both hold a block in is asked, never the epoch now", async () => {
  // the newest block 91 s and 95 s old: the epoch before the one before
  const old = (h) => NOW / 1000 - (h === HOSTS[0] ? 91 : 95);
  const asked2 = [];
  const runs = await collect(async (network, pool, epochMs) => (asked2.push(epochMs), feeOf(network, pool, epochMs)), headsAt(old), ONE_POOL, at);
  assert.deepEqual(asked2, [EPOCH - 120_000]);
  assert.equal(judge(runs).verdict, "PASS", judge(runs).lines.join("\n"));
  // a recorded run that judged another epoch than its heads name is not judged
  const moved = structuredClone(runs);
  moved[0].epochMs = EPOCH;
  moved[0].fee.body.epoch_start_ms = EPOCH;
  assert.equal(judge(moved).verdict, "INCONCLUSIVE");
});

test("never a pass on nothing: one head, two heads over a minute apart, or no block within a proof's life is INCONCLUSIVE with no fee asked", async () => {
  const cases = [
    ["one provider answers the head", async (url, init) => (HOSTS.indexOf(new URL(url).host) > 0 && JSON.parse(init.body).params[0] === "latest" ? new Response("", { status: 429 }) : honest(url, JSON.parse(init.body)))],
    ["heads 61 s apart", headsAt((h) => NOW / 1000 - (h === HOSTS[0] ? 1 : 62))],
    ["the newest block 9 minutes old", headsAt(() => NOW / 1000 - 540)],
  ];
  for (const [name, fetchFn] of cases) {
    const asked = [];
    const runs = await collect(async (network, pool, epochMs) => (asked.push(epochMs), feeOf(network, pool, epochMs)), fetchFn, ONE_POOL, at);
    const r = judge(runs);
    assert.equal(r.verdict, "INCONCLUSIVE", `${name}: ${r.lines.join("\n")}`);
    assert.deepEqual(asked, [], `${name}: no fee asked`);
  }
  // the providers that did not answer the head are named as live-rerun's noAnswerHosts reads them
  const { noAnswerHosts } = await import("../ci/live-rerun.mjs");
  const r = judge(await collect(feeOf, cases[0][1], ONE_POOL, at));
  assert.deepEqual(noAnswerHosts(r.lines.join("\n")), HOSTS.slice(1).sort(), r.lines.join("\n"));
});

// card evm-fee-quiet-epoch, real runs of this check against the deployed helper (https://ct-api.unrealized.trade,
// helper at f8945cd4): `live` 10 Nov 00:40:41Z, every pool; `turn` 00:41:00.9Z, robinhood-testnet asked a second into
// the minute, the heads at 00:40:59 and 00:41:00, so the epoch 00:40 judged (the epoch 00:41 is the one the deployed
// helper answered 404 in the first 0.06 to 0.32 s of 00:37 and 00:38, read the same hour); `notCarried` 00:40:06Z,
// robinhood-testnet's fee recipient asked as a pool: 404 for the epoch and for the one before.
test("real runs: every pool PASSes; at the turn the epoch both heads hold is judged; an address the helper does not carry FAILs", () => {
  const live = judge(A.live.runs);
  assert.equal(live.verdict, "PASS", live.lines.join("\n"));
  assert.equal(A.live.runs.length, 4);
  const turn = judge(A.turn.runs);
  assert.equal(turn.verdict, "PASS", turn.lines.join("\n"));
  const r = A.turn.runs[0];
  assert.ok(r.epochMs < r.nowMs - (r.nowMs % 60_000), "the epoch judged is before the epoch now");
  assert.ok(r.heads.some((h) => Number(BigInt(h.timestamp)) * 1000 < r.nowMs - (r.nowMs % 60_000)), "a head was still before the minute");
  const nc = judge(A.notCarried.runs);
  assert.equal(nc.verdict, "FAIL", nc.lines.join("\n"));
  assert.ok(nc.lines.some((l) => l.startsWith("BAD robinhood-testnet ") && l.includes('{"status":404,"body":{"error":{"code":"not_found"}}}')), nc.lines.join("\n"));
  // the turn's run with its heads moved into the epoch now no longer matches the epoch it asked: never judged good
  const moved = structuredClone(A.turn.runs);
  for (const h of moved[0].heads) h.timestamp = `0x${Math.ceil(moved[0].nowMs / 60_000 * 60).toString(16)}`;
  assert.equal(judge(moved).verdict, "INCONCLUSIVE");
});
