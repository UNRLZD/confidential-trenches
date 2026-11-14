// node --test packages/wallet/test/pool-every-lamport.test.ts: no step leaves a Solana pool note that cannot move (card
// every-lamport-can-move). Over buy sizes and piece sets, every note a step makes is 0 or at least both floors, and
// buying from a note drains it to exactly 0. The floors are the program's, at mainnet rent (5,080 a byte, read 2 Nov
// 2026): a withdraw needs max(2F, F + rent(0) + W's fee) = 2,600,000 (the kit's solanaPoolNoteFloor), a buy F + the tip
// cap + rent(0) = 2,950,240 (./src/pool/solana.ts bind), F = 1,300,000. Test values only: no key, no seed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaPoolFee, solanaPoolNoteFloor, solanaRentMin } from "@blindfill/kit";
import { changeMoves, isReleaseSize, noteOf, pieceChunk, releaseSizesUpTo, SOL_FINISH_LEAST, SOL_NOTE_FLOOR } from "../src/pool/pieces.ts";
import { rungsUpTo } from "../src/pool/ladder.ts";
import { SOL_PIECES, SOL_TIP_CAP } from "../src/pool/solana.ts";

const F = 1_300_000n;
const RENT0 = 650_240n;
const W_FEE = 5_000n;
const WITHDRAW_FLOOR = 2n * F > F + RENT0 + W_FEE ? 2n * F : F + RENT0 + W_FEE;
const BUY_FLOOR = F + SOL_TIP_CAP + RENT0;
const EXACT = WITHDRAW_FLOOR > BUY_FLOOR ? WITHDRAW_FLOOR : BUY_FLOOR;
const FLOOR = SOL_NOTE_FLOOR;
const M = 1_000_000n;

// The chunk the device's proof queue releases from a note of `value` (queue.ts prove), or null when none can.
const chunkFor = (value: bigint): bigint | null => pieceChunk(SOL_PIECES, value);
// What a sale's return deposits for `rest` lamports W holds past its costs, and what it keeps on W (card
// pool-amounts-are-standard-sizes: never paid away).
const returnFor = (rest: bigint): { note: bigint; kept: bigint } => noteOf(SOL_PIECES, rest);

// Sale returns from just over the floor to 0.2 SOL, at odd lamports, as a venue's proceeds land.
const RESTS: bigint[] = [];
for (let x = EXACT + 1n; x < 200_000_000n; x = (x * 13n) / 10n + 7_919n) RESTS.push(x);

test("every lamport: a sale's return lands as one rung that buys drain to exactly 0, the rest kept on W", () => {
  const bad: string[] = [];
  for (const rest of RESTS) {
    const { note, kept } = returnFor(rest);
    assert.equal(note + kept, rest, `${rest}: the return accounts for every lamport`);
    // the note is the largest rung at or under the rest; under the floor none, all of it kept on W
    assert.equal(note, rest < FLOOR ? 0n : rungsUpTo(SOL_PIECES.ladder, rest)[0], `${rest}: the note is the largest rung`);
    assert.ok(note === 0n || isReleaseSize(SOL_PIECES, note), `${rest}: the note ${note} is a rung`);
    let v = note;
    for (let step = 0; v > 0n && step < 64; step++) {
      const c = chunkFor(v);
      if (c === null) break;
      assert.ok(isReleaseSize(SOL_PIECES, c), `${rest}: a release of ${c} is not on the list`);
      v -= c;
      if (v !== 0n && v < FLOOR) break;
    }
    if (v !== 0n) bad.push(`${rest} -> ${v} left`);
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${RESTS.length} returns leave a note that cannot move`);
});

test("every lamport: a set of pieces a buy spends leaves each note at 0 or at least both floors", () => {
  const bad: string[] = [];
  const NOTES = RESTS.map((x) => returnFor(x).note).filter((x) => x > 0n);
  for (const a of NOTES)
    for (const b of NOTES.filter((_, i) => i % 3 === 0)) {
      for (const v of [a, b]) {
        const c = chunkFor(v);
        if (c === null) continue;
        assert.ok(isReleaseSize(SOL_PIECES, c), `${v}: a release of ${c} is not on the list`);
        const change = v - c;
        if (change !== 0n && change < FLOOR) bad.push(`${v} -> change ${change}`);
      }
    }
  assert.deepEqual([...new Set(bad)].slice(0, 5), [], "a buy's change under a floor");
});

test("every lamport: the floor is the kit's buy and withdraw floors at mainnet rent, up to the grid", () => {
  const rent = { lamportsPerByte: 5_080n, factor: 1n as const };
  const fee = solanaPoolFee(rent);
  assert.equal(fee, F);
  assert.equal(solanaRentMin(rent, 0), RENT0);
  const exact = solanaPoolNoteFloor(rent) > fee + SOL_TIP_CAP + solanaRentMin(rent, 0) ? solanaPoolNoteFloor(rent) : fee + SOL_TIP_CAP + solanaRentMin(rent, 0);
  assert.equal(exact, EXACT);
  // the least rung of the piece ladder at or over both floors
  assert.equal(SOL_NOTE_FLOOR, rungsUpTo(SOL_PIECES.ladder, 10n ** 12n).filter((r) => r >= exact).at(-1));
  assert.equal(SOL_NOTE_FLOOR, 5_000_000n);
});

test("every lamport: a piece is a rung while its change moves, else an older note's whole remainder once; under the least, none", () => {
  const cases: [bigint, bigint | null][] = [[2n * M, null], [3n * M, 3n * M], [4n * M, 4n * M], [5n * M, 5n * M], [6n * M, 6n * M], [7n * M, 7n * M], [9n * M, 9n * M], [10n * M, 10n * M], [11n * M, 5n * M], [12n * M, 5n * M], [14n * M, 5n * M], [15n * M, 10n * M], [20n * M, 20n * M], [22n * M, 10n * M], [27n * M, 20n * M], [57n * M, 50n * M]];
  for (const [v, c] of cases) assert.equal(chunkFor(v), c, `${v}`);
  // the closed list: the rungs from 0.005 SOL alone (card pool-amounts-are-standard-sizes: no finishing sizes)
  assert.deepEqual(releaseSizesUpTo(SOL_PIECES, 60n * M), [50n, 20n, 10n, 5n].map((x) => x * M));
  for (const x of [3n * M, 4n * M, 6n * M, 7n * M, 8n * M, 9n * M, 11n * M, 27n * M, 5n * M + 1n]) assert.ok(!isReleaseSize(SOL_PIECES, x), `${x}`);
  // every on-grid note from the floor up drains to 0: a rung (every note made under the rule) in one release of itself;
  // any other (made before the rule) in rungs while the change moves, then its last remainder once, whole
  for (let v = FLOOR; v <= 300n * M; v += M) {
    let x = v;
    const out: bigint[] = [];
    while (x > 0n) {
      const c = chunkFor(x);
      assert.ok(c !== null && c > 0n && c <= x, `${v}: ${c}`);
      out.push(c);
      x -= c;
    }
    assert.equal(out.reduce((a, b) => a + b, 0n), v);
    const off = out.filter((c) => !isReleaseSize(SOL_PIECES, c));
    if (isReleaseSize(SOL_PIECES, v)) assert.deepEqual(out, [v], `${v}: a rung releases whole`);
    assert.ok(off.length <= 1 && (off.length === 0 || out.at(-1) === off[0]), `${v}: ${out.join(",")}`);
  }
  // a note already off the grid (made before this rule) still drains to 0: rungs while the change moves, then itself once
  for (const v of [5_004_120n, 6_513_275n, 11_025_647n, 23_843_232n]) {
    let x = v;
    const out: bigint[] = [];
    while (x > 0n) out.push(chunkFor(x)!), (x -= out.at(-1)!);
    assert.equal(out.filter((c) => !isReleaseSize(SOL_PIECES, c)).length, 1, `${v}: one finish off the list`);
  }
  for (const v of [0n, 5n * M, 17n * M]) assert.ok(changeMoves(SOL_PIECES, v));
  for (const v of [1n, 3n * M, 4n * M, 5n * M + 1n]) assert.ok(!changeMoves(SOL_PIECES, v));
});

test("every lamport: a note made before the rule, off the grid and under the floor, still buys whole down to the kit's buy floor", () => {
  // the owner-shaped set's 4,120,333 bought whole before the rule; the T1 rule's floor left it to withdraws alone
  for (const v of [4_120_333n, 4_999_999n, 2_950_240n, 3_000_001n]) assert.equal(chunkFor(v), v, `${v}`);
  // an on-grid one main's planner left (review P3-2 of 00d6bef00) finishes whole too
  for (const v of [3n * M, 4n * M]) assert.equal(chunkFor(v), v, `${v}`);
  // under the buy floor a release cannot fund a buy (only a withdraw takes it whole)
  for (const v of [2_950_239n, 2_731_005n, 1n, 2n * M]) assert.equal(chunkFor(v), null, `${v}`);
  // the least is the kit's buy floor at mainnet rent: F + the tip cap + rent(0)
  const rent = { lamportsPerByte: 5_080n, factor: 1n as const };
  assert.equal(SOL_FINISH_LEAST, solanaPoolFee(rent) + SOL_TIP_CAP + solanaRentMin(rent, 0));
  assert.equal(SOL_PIECES.least, SOL_FINISH_LEAST);
});
