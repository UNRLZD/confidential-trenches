// node --test packages/wallet/test/pool-standard-sizes.test.ts: every amount that enters or leaves the Solana pool is a
// rung of the 1-2-5 ladder from 0.005 SOL (card pool-amounts-are-standard-sizes; the Blindfill v2 lite paper: "Standard
// chunk sizes make every buy look like many others"). Read on mainnet 13 Nov 20:27Z: a sale's deposit back of
// 12,000,000 lamports and a release of 6,661,767 left the ladder. Test values only: no key, no seed but the all-zero one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRung, poolDepositPlan } from "../src/pool/ladder.ts";
import { noteOf, pieceChunk, releaseSizesUpTo, SOL_NOTE_FLOOR } from "../src/pool/pieces.ts";
import { SOL_LADDER, SOL_PIECE_LADDER, SOL_PIECES } from "../src/pool/solana.ts";

const M = 1_000_000n;
// what a step holds for the pool: a sale's proceeds, a W's sweep rest, a buy's leftover, to the lamport
const AMOUNTS: bigint[] = [12n * M, 9_966_767n, 39_425_404n, 5_487_104n, 7n * M, 27n * M + 1n];
for (let x = SOL_NOTE_FLOOR; x < 2_000_000_000n; x = (x * 11n) / 10n + 7_919n) AMOUNTS.push(x);

// the chunks a buy or a withdraw releases from a note of `v`, in order, until it is spent
const drain = (v: bigint): bigint[] => {
  const out: bigint[] = [];
  for (let x = v; x > 0n && out.length < 64; ) {
    const c = pieceChunk(SOL_PIECES, x);
    if (c === null) break;
    out.push(c);
    x -= c;
  }
  return out;
};

test("sell, change: every note a step makes is a rung, and what is under it is kept on W, never paid away", () => {
  const bad: string[] = [];
  for (const x of AMOUNTS) {
    const made = noteOf(SOL_PIECES, x) as { note: bigint; kept?: bigint };
    if (made.note !== 0n && !isRung(SOL_PIECE_LADDER, made.note)) bad.push(`${x} -> note ${made.note}`);
    if (made.kept !== x - made.note) bad.push(`${x} -> kept ${made.kept}`);
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${AMOUNTS.length} notes off the ladder or not kept`);
});

test("buy: every piece released from a note a step makes is a rung, and the note drains to 0", () => {
  const bad: string[] = [];
  for (const x of AMOUNTS) {
    const { note } = noteOf(SOL_PIECES, x);
    const out = drain(note);
    if (out.some((c) => !isRung(SOL_PIECE_LADDER, c))) bad.push(`${note}: ${out.join(",")}`);
    if (out.reduce((a, b) => a + b, 0n) !== note) bad.push(`${note}: drains to ${out.join(",")}`);
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} notes release off the ladder`);
});

test("buy, withdraw: the sizes a release may take are the rungs alone", () => {
  assert.deepEqual(releaseSizesUpTo(SOL_PIECES, 60n * M), [50n, 20n, 10n, 5n].map((x) => x * M));
});

test("older notes: one made before the rule releases rungs while its change moves, then its last remainder once, whole", () => {
  for (const v of [12n * M, 7n * M, 9_966_767n, 39_425_404n, 5_487_104n, 3_502_518n]) {
    const out = drain(v);
    assert.equal(out.reduce((a, b) => a + b, 0n), v, `${v}: drains to 0`);
    const off = out.filter((c) => !isRung(SOL_PIECE_LADDER, c));
    assert.ok(off.length <= 1 && (off.length === 0 || out.at(-1) === off[0]), `${v}: ${out.join(",")}`);
  }
});

test("move: every note a move or a deposit lands as is a rung of the pool's ladder", () => {
  const seed = new Uint8Array(64);
  for (const x of [10n * M, 37n * M + 123n, 1_234_567_890n]) {
    const { notes } = poolDepositPlan(seed, 1n, SOL_LADDER, { kind: "move", l: 1n, j: 0 }, x);
    for (const n of notes) assert.ok(isRung(SOL_PIECE_LADDER, n.value), `${x}: ${n.value}`);
  }
});
