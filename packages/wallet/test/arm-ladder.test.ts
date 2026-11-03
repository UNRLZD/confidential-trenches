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

test("a size off the ladder is no ladder wallet: left out", () => {
  assert.equal(ladderSplit(300n, [100n, 200n]), null, "$1 is no rung");
  assert.equal(ladderSplit(700n, [300n, 400n, 700n]), null);
  assert.deepEqual(ladderSplit(700n, [...$(5, 2), 300n, 250n]), $(5, 2));
  assert.equal(ladderSplit(650n, HAND), null, "no ladder sum has cents");
});

// The search this split replaced (signpage-solana-trade): every count of each size, largest first, memoized per
// (size, rest). Exact, and slow with many wallets on hand; the split must give its answer on every hand.
function searchSplit(cents: bigint, onHand: readonly bigint[]): bigint[] | null {
  if (cents <= 0n) return null;
  const counts = new Map<bigint, number>();
  for (const s of onHand) if (s > 0n) counts.set(s, (counts.get(s) ?? 0) + 1);
  const sizes = [...counts.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const memo = new Map<string, bigint[] | null>();
  const best = (i: number, rest: bigint): bigint[] | null => {
    if (rest === 0n) return [];
    if (i === sizes.length) return null;
    const k = `${i}:${rest}`;
    if (memo.has(k)) return memo.get(k)!;
    const s = sizes[i]!;
    let out: bigint[] | null = null;
    for (let n = Math.min(counts.get(s)!, Number(rest / s)); n >= 0; n--) {
      const tail = best(i + 1, rest - s * BigInt(n));
      if (tail && (out === null || n + tail.length < out.length)) out = [...new Array<bigint>(n).fill(s), ...tail];
    }
    memo.set(k, out);
    return out;
  };
  return best(0, cents);
}

test("the same split as the full search on 1000 random hands", () => {
  let seed = 20261103;
  const next = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * n);
  let none = 0;
  for (let k = 0; k < 1000; k++) {
    const hand: bigint[] = [];
    for (let d = 0, top = 1 + next(4); d < top; d++) for (const m of [2, 5, 10]) for (let i = next(7); i > 0; i--) hand.push(BigInt(m) * 100n * 10n ** BigInt(d));
    const total = hand.reduce((a, b) => a + b, 0n);
    const cents = k % 10 === 0 ? BigInt(next(200_000)) : (BigInt(next(Number(total / 100n) + 3)) + 1n) * 100n;
    const want = searchSplit(cents, hand);
    if (want === null) none++;
    assert.deepEqual(ladderSplit(cents, hand), want, `${cents} over [${hand.join(",")}]`);
  }
  assert.ok(none > 100 && none < 900, `${none} of 1000 have no split: both kinds covered`);
});

test("many wallets on hand stay quick", () => {
  const big: bigint[] = [];
  for (let d = 0; d < 7; d++) for (const m of [2, 5, 10]) for (let i = 0; i < 20; i++) big.push(BigInt(m) * 100n * 10n ** BigInt(d));
  const t = Date.now();
  const out = ladderSplit(123_456_700n, big);
  assert.ok(out && out.reduce((a, b) => a + b, 0n) === 123_456_700n);
  assert.ok(Date.now() - t < 200, `${Date.now() - t} ms`);
});
