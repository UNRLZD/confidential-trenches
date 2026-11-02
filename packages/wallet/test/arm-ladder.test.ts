// The exact fewest-wallets split of a buy over the wallets on hand (src/arming/ladder.ts; card signpage-solana-trade).
//   node --test test/arm-ladder.test.ts   (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import { ladderSplit } from "../src/arming/ladder.ts";

const $ = (...d: number[]) => d.map((x) => BigInt(x * 100));
// a hand of the ladder's sizes: three of each from $2 to $100
const HAND = $(2, 2, 2, 5, 5, 5, 10, 10, 10, 20, 20, 20, 50, 50, 50, 100, 100, 100);

test("sums a greedy take of the largest size misses: $6, $8, $11, $13, $16", () => {
  assert.deepEqual(ladderSplit(600n, HAND), $(2, 2, 2));
  assert.deepEqual(ladderSplit(800n, $(5, 2, 2, 2, 2)), $(2, 2, 2, 2));
  assert.deepEqual(ladderSplit(1_100n, HAND), $(5, 2, 2, 2));
  assert.deepEqual(ladderSplit(1_300n, $(10, 5, 2, 2, 2, 2)), $(5, 2, 2, 2, 2));
  assert.deepEqual(ladderSplit(1_600n, HAND), $(10, 2, 2, 2));
});

test("the fewest wallets, from the wallets on hand only", () => {
  assert.deepEqual(ladderSplit(1_700n, HAND), $(10, 5, 2));
  assert.deepEqual(ladderSplit(2_000n, HAND), $(20), "one $20, not two $10");
  assert.deepEqual(ladderSplit(2_000n, $(10, 10, 5, 5)), $(10, 10), "no $20 on hand: two $10");
  assert.deepEqual(ladderSplit(13_700n, HAND), $(100, 20, 10, 5, 2));
  assert.equal(ladderSplit(600n, $(5, 2, 2)), null, "two $2 on hand: $6 cannot be made");
  assert.equal(ladderSplit(300n, HAND), null, "$3 is no sum of ladder sizes");
  assert.equal(ladderSplit(0n, HAND), null);
  assert.equal(ladderSplit(-200n, HAND), null);
  assert.equal(ladderSplit(200n, []), null);
});

test("many wallets on hand stay quick", () => {
  const big: bigint[] = [];
  for (let d = 0; d < 7; d++) for (const m of [2, 5, 10]) for (let i = 0; i < 20; i++) big.push(BigInt(m) * 100n * 10n ** BigInt(d));
  const t = Date.now();
  const out = ladderSplit(123_456_700n, big);
  assert.ok(out && out.reduce((a, b) => a + b, 0n) === 123_456_700n);
  assert.ok(Date.now() - t < 2_000, `${Date.now() - t} ms`);
});
