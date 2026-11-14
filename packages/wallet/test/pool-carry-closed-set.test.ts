// node --test packages/wallet/test/pool-carry-closed-set.test.ts: card buy-spends-its-change-in-the-same-tap keeps the
// pieces rule's set closed (src/pool/pieces.ts; decided Q3: notes made before the rule still release whole, nothing new
// may join them). Every step that makes a note (a deposit or a sale's return: noteOf; a release's change; the change a
// carried piece leaves) makes 0 or a note on the grid at or above the floor, and every piece a tap carries is one of
// the listed release sizes. `strays` is the gate: a planted maker of a note off the grid or under the floor fails it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { carriedChunk } from "../src/pool/balances.ts";
import { isReleaseSize, noteOf, pieceChunk, SOL_GRID, SOL_NOTE_FLOOR } from "../src/pool/pieces.ts";
import { SOL_PIECES } from "../src/pool/solana.ts";

/** A note a step may make: none (0), or on the grid at or above the floor. */
const closed = (v: bigint): boolean => v === 0n || (v % SOL_GRID === 0n && v >= SOL_NOTE_FLOOR);
/** The inputs whose made note is outside the closed set. */
const strays = (make: (x: bigint) => bigint, inputs: readonly bigint[]): bigint[] => inputs.filter((x) => !closed(make(x)));

// every note on the grid from the floor to 2 SOL, and amounts to the lamport (a sale's proceeds) across the same span
const NOTES = Array.from({ length: 1_996 }, (_, i) => SOL_NOTE_FLOOR + BigInt(i) * SOL_GRID);
const AMOUNTS = Array.from({ length: 4_000 }, (_, i) => 1n + BigInt(i) * 499_979n);

const change = (v: bigint): bigint => v - pieceChunk(SOL_PIECES, v)!;
/** The change left after a tap carries a note's change: the carried piece taken from it (none carried: the change). */
const afterCarry = (v: bigint): bigint => {
  const c = change(v);
  const k = carriedChunk(SOL_PIECES, v, pieceChunk(SOL_PIECES, v)!);
  return k === null ? c : c - k;
};

test("every note-making step stays in the closed set: a deposit or a sale's return, a release's change, and the change a carried piece leaves", () => {
  assert.deepEqual(strays((x) => noteOf(SOL_PIECES, x).note, AMOUNTS), []);
  assert.deepEqual(strays(change, NOTES), []);
  assert.deepEqual(strays(afterCarry, NOTES), []);
});

/** A carried piece off the rule of every release (card pool-amounts-are-standard-sizes): a rung, or the last remainder of
 *  a note made before the rule, released whole and once (the change it is carried from, all of it). */
const offRule = (v: bigint, k: bigint | null): boolean => k !== null && !isReleaseSize(SOL_PIECES, k) && k !== change(v);

test("every piece a tap carries is a listed release size, or the whole last remainder of a note made before the rule", () => {
  const off = NOTES.filter((v) => offRule(v, carriedChunk(SOL_PIECES, v, pieceChunk(SOL_PIECES, v)!)));
  assert.deepEqual(off, []);
  // a note made under the rule is a rung: its piece is the whole note, nothing carried
  for (const v of [5_000_000n, 10_000_000n, 20_000_000n, 50_000_000n, 1_000_000_000n]) assert.equal(carriedChunk(SOL_PIECES, v, pieceChunk(SOL_PIECES, v)!), null, `${v}`);
  // the owner's 0.012 return (made before the rule): its 0.005 piece leaves 0.007, carried whole, its last remainder
  assert.equal(carriedChunk(SOL_PIECES, 12_000_000n, 5_000_000n), 7_000_000n);
  // a change that holds a rung is carried as that rung: 0.03 less its 0.02 piece leaves 0.01
  assert.equal(carriedChunk(SOL_PIECES, 30_000_000n, 20_000_000n), 10_000_000n);
  // planted: a carried piece off the ladder that leaves a change behind (not the last remainder) fails the rule
  assert.ok(offRule(12_000_000n, 6_000_000n), "0.006 of a 0.007 change: off the ladder, and not the whole remainder");
  assert.ok(offRule(207_000_000n, 3_000_000n), "0.003 of a 0.007 change");
  assert.ok(!offRule(207_000_000n, 7_000_000n) && !offRule(30_000_000n, 10_000_000n));
});

test("the gate refuses a planted maker of a new note off the grid or under the floor", () => {
  assert.notDeepEqual(strays((x) => change(x) + 1n, NOTES), [], "a change one lamport off the grid");
  assert.notDeepEqual(strays((x) => (x === 12_000_000n ? 3_000_000n : change(x)), NOTES), [], "a 0.003 change, under the floor");
  assert.notDeepEqual(strays((x) => noteOf(SOL_PIECES, x).note + (x % SOL_GRID), AMOUNTS), [], "a return kept to the lamport");
});
