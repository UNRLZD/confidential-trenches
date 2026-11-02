// node --test packages/wallet/test/pool-ladder.test.ts: the 1-2-5 ladder and the split of a move into a pool (card
// wallet-pool-ladder, src/pool/ladder.ts). Test seed only: the all-zero entropy of vectors/a8.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as d from "../src/derive/index.ts";
import { noteSecrets } from "../src/notes/secrets.ts";
import { checkLadder, chunkOf, isRung, ladderSplit, poolDepositPlan, rungsUpTo, type Ladder } from "../src/pool/ladder.ts";
import { USDC_LADDER } from "../src/pool/near.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const CENTS: Ladder = { one: 100n, min: 200n }; // $1 = 100 cents, from $2: the USDC ladder at cent precision
const usd = (x: number): bigint => BigInt(Math.round(x * 1_000_000));

// Every split's rules: every note a rung, largest first, the notes plus what is kept back add up to the amount, and
// what is kept back covers no rung.
function splitHolds(l: Ladder, amount: bigint): void {
  const { notes, left } = ladderSplit(l, amount);
  assert.equal(notes.reduce((a, b) => a + b, 0n) + left, amount, `sum of ${amount}`);
  for (const [k, x] of notes.entries()) {
    assert.ok(isRung(l, x), `${amount}: note ${k} (${x}) is off the ladder`);
    assert.equal(chunkOf(l, x), x, `${amount}: note ${k}'s chunk is the whole note`);
    if (k > 0) assert.ok(x <= notes[k - 1]!, `${amount}: largest first`);
  }
  assert.ok(left >= 0n && left < l.min, `${amount}: what is kept back is below the smallest rung`);
}

test("ladder: rungs 1-2-5 per power of ten from the smallest, no top; a smallest rung off the ladder is refused", () => {
  assert.deepEqual(rungsUpTo(USDC_LADDER, usd(1000)), [1000, 500, 200, 100, 50, 20, 10, 5, 2].map(usd));
  assert.deepEqual(rungsUpTo(USDC_LADDER, usd(1.99)), []);
  assert.equal(rungsUpTo(USDC_LADDER, 1n << 127n).length, 96); // 2 x 10^6 to 10^38: 32 decades of 3
  for (const bad of [0n, 3_000_000n, 1_500_000n, 15n]) assert.throws(() => checkLadder({ one: 1_000_000n, min: bad }), /min is not a rung/);
  assert.throws(() => checkLadder({ one: 0n, min: 0n }), /one is a u128 above 0/);
  assert.equal(isRung(USDC_LADDER, usd(20)), true);
  assert.equal(isRung(USDC_LADDER, usd(25)), false);
  assert.equal(isRung(USDC_LADDER, usd(1)), false); // below the smallest rung
});

test("ladder: the chunk of a note is the largest rung at or below its value", () => {
  assert.equal(chunkOf(USDC_LADDER, usd(100.43)), usd(100));
  assert.equal(chunkOf(USDC_LADDER, usd(4.99)), usd(2));
  assert.equal(chunkOf(USDC_LADDER, usd(5)), usd(5));
  assert.equal(chunkOf(USDC_LADDER, usd(1.99)), null);
});

test("ladder: named splits, largest first, every note a rung, what is left kept back", () => {
  const split = (x: number) => { const r = ladderSplit(USDC_LADDER, usd(x)); return [r.notes, r.left]; };
  assert.deepEqual(split(137.43), [[usd(100), usd(20), usd(10), usd(5), usd(2)], usd(0.43)]);
  assert.deepEqual(split(50), [[usd(50)], 0n]);
  assert.deepEqual(split(9), [[usd(5), usd(2), usd(2)], 0n]);
  assert.deepEqual(split(9.99), [[usd(5), usd(2), usd(2)], usd(0.99)]);
  assert.deepEqual(split(1.99), [[], usd(1.99)]);
  assert.deepEqual(split(1000), [[usd(1000)], 0n]);
  for (const bad of [0n, -1n, 1n << 128n]) assert.throws(() => ladderSplit(USDC_LADDER, bad), /amount: a u128 above 0/);
});

test("ladder: every amount from 1 cent to $2,000 splits exactly, no note off the ladder", () => {
  for (let c = 1n; c <= 200_000n; c++) splitHolds(CENTS, c);
});

test("ladder: random amounts up to 2^128 split exactly, on the ladder, with every smallest rung", () => {
  let x = 0x9e3779b97f4a7c15n; // splitmix64, fixed seed: the same amounts every run
  const rand = (): bigint => {
    x = (x + 0x9e3779b97f4a7c15n) & ((1n << 64n) - 1n);
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & ((1n << 64n) - 1n);
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & ((1n << 64n) - 1n);
    return z ^ (z >> 31n);
  };
  const ladders: Ladder[] = [USDC_LADDER, CENTS, { one: 1n, min: 1n }, { one: 10_000_000n, min: 5n * 10_000_000n }];
  for (let k = 0; k < 2_000; k++) {
    const amount = ((rand() << 64n) | rand()) >> BigInt(k % 128);
    if (amount === 0n) continue;
    for (const l of ladders) splitHolds(l, amount);
  }
});

test("a move into a pool: its first note, then that id's second arrivals, under the pool's scope", () => {
  const s = 123n, s2 = 456n;
  const { notes: plan, left } = poolDepositPlan(SEED, s, USDC_LADDER, { kind: "deposit", s, i: 3 }, usd(137.43));
  assert.deepEqual(plan.map((n) => n.value), ladderSplit(USDC_LADDER, usd(137.43)).notes);
  assert.equal(left, usd(0.43), "what is left stays in the one-time wallet");
  assert.deepEqual(plan[0]!.ref, { kind: "deposit", s, i: 3 });
  plan.slice(1).forEach((n, k) => assert.deepEqual(n.ref, { kind: "second", id: { id: "U", s, i: 3 }, n: k }));
  for (const n of plan) {
    assert.equal(n.scope, s);
    assert.equal(n.precommitment, noteSecrets(SEED, n.ref).precommitment);
  }
  // another pool's scope: other notes, the same sizes
  const other = poolDepositPlan(SEED, s2, USDC_LADDER, { kind: "deposit", s: s2, i: 3 }, usd(137.43)).notes;
  assert.deepEqual(other.map((n) => n.value), plan.map((n) => n.value));
  for (const [k, n] of other.entries()) assert.notEqual(n.precommitment, plan[k]!.precommitment);
  // a return of W_{sol, l, j} goes in as R_{sol, l, j}'s notes
  const ret = poolDepositPlan(SEED, s, USDC_LADDER, { kind: "return", c: "sol", l: 7n, j: 1 }, usd(7)).notes;
  assert.deepEqual(ret.map((n) => n.ref), [{ kind: "return", c: "sol", l: 7n, j: 1 }, { kind: "second", id: { id: "R", c: "sol", l: 7n, j: 1 }, n: 0 }]);
  assert.throws(() => poolDepositPlan(SEED, s, USDC_LADDER, { kind: "deposit", s: s2, i: 0 }, usd(5)), /scope is its s/);
  assert.throws(() => poolDepositPlan(SEED, s, USDC_LADDER, { kind: "change", l: 1n, j: 0 }, usd(5)), /starts with a deposit, return or move note/);
  assert.deepEqual(poolDepositPlan(SEED, s, USDC_LADDER, { kind: "deposit", s, i: 4 }, usd(1.5)), { notes: [], left: usd(1.5) });
});
