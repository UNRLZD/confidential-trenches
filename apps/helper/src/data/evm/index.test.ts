// The chain's swap index (index.ts, card helper-robinhood-capacity fold 6): one read for every caller, only the blocks
// it does not hold, a gap past its window started again, and a read that answers outside its blocks never held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSwapIndex } from "./index.ts";
import type { Log } from "./swaps.ts";

const SWAP = `0x${"aa".repeat(32)}`;
const OTHER = `0x${"bb".repeat(32)}`;
const PM = `0x${"11".repeat(20)}`;
const POOL = `0x${"22".repeat(20)}`;
const ID = `0x${"33".repeat(32)}`;
/** Two logs a block: a v4 swap of pool ID at PM and a v3 swap at POOL. */
const chainLogs = (lo: number, hi: number): Log[] =>
  Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).flatMap((b) => [
    { block: b, index: 0, tx: `0x${b.toString(16).padStart(64, "0")}`, address: PM, topics: [SWAP, ID], data: "0x", t: b },
    { block: b, index: 1, tx: `0x${b.toString(16).padStart(64, "0")}`, address: POOL, topics: [SWAP], data: "0x", t: b },
  ]);
function fake(answer: (lo: number, hi: number) => Promise<Log[] | null> | Log[] | null = chainLogs) {
  const reads: [number, number][] = [];
  const read = async (lo: number, hi: number) => {
    reads.push([lo, hi]);
    await new Promise((r) => setTimeout(r, 1));
    return answer(lo, hi);
  };
  return { reads, index: createSwapIndex({ topics: [SWAP], read, window: 100, chunk: 40 }) };
}

test("a dozen callers at once share one read of the newest window, in chunks", async () => {
  const { reads, index } = fake();
  const got = await Promise.all(Array.from({ length: 12 }, () => index.upTo(1_000)));
  assert.deepEqual(got, Array(12).fill(true));
  assert.deepEqual(reads, [[901, 940], [941, 980], [981, 1_000]]);
  assert.deepEqual(index.range(), { from: 901, to: 1_000 });
});

test("a catch-up reads only the blocks after what it holds, and keeps the window", async () => {
  const { reads, index } = fake();
  await index.upTo(1_000);
  reads.length = 0;
  assert.equal(await index.upTo(1_050), true);
  assert.deepEqual(reads, [[1_001, 1_040], [1_041, 1_050]]);
  assert.deepEqual(index.range(), { from: 951, to: 1_050 });
  assert.equal(index.holds(951, 1_050), true);
  assert.equal(index.holds(950, 1_050), false);
  assert.equal(index.logs(900, 2_000).length, 200, "the pruned blocks are gone");
  assert.equal(await index.upTo(1_020), true, "a range it holds reads nothing");
  assert.equal(reads.length, 2);
});

test("a gap past the window starts again at the newest window", async () => {
  const { reads, index } = fake();
  await index.upTo(1_000);
  reads.length = 0;
  await index.upTo(1_500);
  assert.deepEqual(reads[0], [1_401, 1_440]);
  assert.deepEqual(index.range(), { from: 1_401, to: 1_500 });
});

test("a read that fails is no answer, and the next ask reads again; a read with a log outside its blocks is never held", async () => {
  let fail = true;
  const { index } = fake((lo, hi) => (fail ? null : chainLogs(lo, hi)));
  assert.equal(await index.upTo(1_000), false);
  assert.equal(index.range(), null);
  fail = false;
  assert.equal(await index.upTo(1_000), true);
  const bad = fake((lo, hi) => (lo > 1_000 ? chainLogs(lo, hi + 1) : chainLogs(lo, hi)));
  await bad.index.upTo(1_000);
  assert.equal(await bad.index.upTo(1_010), false);
  assert.deepEqual(bad.index.range(), { from: 901, to: 1_000 });
  const first = fake((lo, hi) => chainLogs(lo - 1, hi));
  assert.equal(await first.index.upTo(1_000), false, "the first window's read is checked the same");
  assert.equal(first.index.range(), null);
});

test("a filter is answered from it only for its topics with an address: a v4 pool by its id, a pool by its address, in block order", async () => {
  const { index } = fake();
  await index.upTo(1_000);
  assert.equal(index.indexes({ address: PM, topics: [SWAP, ID] }), true);
  assert.equal(index.indexes({ address: POOL, topics: [[SWAP]] }), true);
  assert.equal(index.indexes({ address: POOL, topics: [OTHER] }), false, "a topic it does not hold");
  assert.equal(index.indexes({ topics: [SWAP] }), false, "no address: the chain-wide read itself");
  const v4 = index.query({ address: PM, topics: [SWAP, ID] }, 990, 999);
  assert.deepEqual(v4.map((l) => [l.block, l.address]), Array.from({ length: 10 }, (_, k) => [990 + k, PM]));
  assert.deepEqual(index.query({ address: PM, topics: [SWAP, OTHER] }, 900, 1_000), []);
  const v3 = index.query({ address: POOL.toUpperCase().replace("0X", "0x"), topics: [SWAP] }, 995, 1_000);
  assert.deepEqual(v3.map((l) => l.block), [995, 996, 997, 998, 999, 1_000]);
});
