// node --test scripts/live-checks/evm-pool-index-from-the-first-pool.test.mjs: the live check's verdict replays recorded
// reads (evm-pool-index-from-the-first-pool.answers.json; its _note says where each was read): the good answer passes, the
// recorded bad one fails, and planted edits of the good one fail by name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHAINS, judge, poolIdOf } from "./evm-pool-index-from-the-first-pool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "evm-pool-index-from-the-first-pool.answers.json"), "utf8"));
/** The good reads with the helper's answer edited by `f`. */
const edit = (f) => {
  const reads = structuredClone(A.good.reads);
  const a = JSON.parse(reads.answer.text);
  f(a);
  reads.answer.text = JSON.stringify(a);
  return judge(A.good.chain, reads);
};
const fails = (r, re) => (assert.equal(r.ok, false, r.lines.join("\n")), assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n")));

test("the recorded good answer passes: Robinhood's index complete to within the scan's depth of the head, every key hashing to its id, the named pool from before the depth served", () => {
  const r = judge(A.good.chain, A.good.reads);
  assert.equal(r.ok, true, r.lines.join("\n"));
  const a = JSON.parse(A.good.reads.answer.text);
  assert.ok(a.pools.some((p) => p.id === CHAINS.robinhood.pool));
  for (const p of a.pools) assert.equal(poolIdOf(p.key), p.id);
});

test("the recorded bad answers fail: a backfill short of its head (complete false, the named pool not yet read), and the deployed helper before this card (404)", () => {
  fails(judge(A.badPartial.chain, A.badPartial.reads), /complete false/);
  fails(judge(A.badPartial.chain, A.badPartial.reads), /named pool .* is not served/);
  fails(judge(A.badNotServed.chain, A.badNotServed.reads), /status 404/);
});

test("planted: a served pool the PoolManager does not hold on a provider (slot0's price 0) fails by name", () => {
  const reads = structuredClone(A.good.reads);
  const j = JSON.parse(reads.heads[0].text);
  j.find((x) => x.id === 1).result = "0x" + "0".repeat(64);
  reads.heads[0].text = JSON.stringify(j);
  fails(judge(A.good.chain, reads), /does not hold the named pool/);
});

test("planted: an answer short of its head, another chain's, another PoolManager's, or behind the scan's depth fails by name", () => {
  fails(edit((a) => (a.complete = false)), /complete false/);
  fails(edit((a) => (a.chainId = 8453)), /chainId/);
  fails(edit((a) => (a.poolManager = "0x0000000000000000000000000000000000000001")), /poolManager/);
  fails(edit((a) => (a.through -= 10_000_000)), /unread/);
  fails(edit((a) => (a.through += 10_000_000)), /past the head/);
});

test("planted: a forged key, a pool of another token, a malformed pool, or the named pool left out fails by name", () => {
  fails(edit((a) => (a.pools[0].key.fee += 1)), /hashes to/);
  fails(
    edit((a) => {
      const k = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x00000000000000000000000000000000000000aa", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" };
      a.pools.push({ id: poolIdOf(k), key: k });
    }),
    /does not pair/,
  );
  fails(edit((a) => a.pools.push({ id: "0x12", key: null })), /malformed/);
  fails(edit((a) => (a.pools = a.pools.filter((p) => p.id !== CHAINS.robinhood.pool))), /named pool/);
});

test("planted: a head provider that answers no block number fails by name", () => {
  const reads = structuredClone(A.good.reads);
  reads.heads[1] = { status: 429, text: "rate limited" };
  fails(judge(A.good.chain, reads), /BAD head/);
});
