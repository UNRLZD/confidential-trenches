// The 1-2-5 ladder and the split of every move into a pool (card wallet-pool-ladder; owner pick ladder, OD:268: rungs
// 1-2-5 per power of ten from $2, no top; wallet.md §2.4 "The deposit lands as several notes" and §2.5 "Standard
// sizes" at research 6d3a34c, re-cut for architecture v2, M349).
//
// - A rung is d x 10^k x one, d in {1, 2, 5}, k >= 0, at or above the pool's smallest rung. `one` is the asset's base
//   units of its unit (10^6 for USDC), so the ladder holds in any asset and has no top.
// - A proof withdraws exactly one rung (withdrawnValue is public), and the fee is paid from it, as fixed-denomination
//   pools pay their relayers. So every release, from every user, at every gas price, is one of the same few sizes.
// - The split: from the largest rung down, repeats allowed, it takes a rung while what is left covers it, largest
//   first. What is left below the smallest rung rides on the first (largest) note, so the notes add up to the amount
//   exactly and there is one note per rung taken. That note's chunk is still its rung (the remainder is smaller than
//   any gap between rungs), and the remainder stays behind as that spend's change. An amount below the smallest rung
//   goes in as one note that no proof draws on until more joins it.
// - Each note of a move is its own deposit: the move's first note, then that id's second arrivals n = 0, 1, ... (the
//   store's rule, notes/store.ts), all under the pool's scope.
import { noteSecrets, type NoteRef } from "../notes/secrets.ts";

/** A pool's ladder: base units of the asset's unit, and the smallest rung (itself a rung). */
export type Ladder = { one: bigint; min: bigint };

const U128 = 1n << 128n;

// d of a positive multiple of `one`, with the powers of ten taken out; 0 when the quotient is not d x 10^k.
function digit(l: Ladder, x: bigint): bigint {
  if (x <= 0n || x % l.one !== 0n) return 0n;
  let q = x / l.one;
  while (q % 10n === 0n) q /= 10n;
  return q === 1n || q === 2n || q === 5n ? q : 0n;
}

/** Refuses a ladder whose unit is not above 0 or whose smallest rung is not d x 10^k x one. */
export function checkLadder(l: Ladder): Ladder {
  if (l === null || typeof l !== "object") throw new Error("ladder: not an object");
  if (typeof l.one !== "bigint" || l.one <= 0n || l.one >= U128) throw new Error("ladder: one is a u128 above 0");
  if (typeof l.min !== "bigint" || l.min >= U128 || digit(l, l.min) === 0n) throw new Error("ladder: min is not a rung (1, 2 or 5 x 10^k x one)");
  return l;
}

/** Whether x is a rung of the ladder. */
export function isRung(l: Ladder, x: bigint): boolean {
  checkLadder(l);
  return typeof x === "bigint" && x >= l.min && digit(l, x) !== 0n;
}

// The rung after r: x2 from 1 and 5, x2.5 from 2.
const next = (l: Ladder, r: bigint): bigint => (digit(l, r) === 2n ? (r * 5n) / 2n : r * 2n);

/** Every rung up to `top`, largest first. */
export function rungsUpTo(l: Ladder, top: bigint): bigint[] {
  checkLadder(l);
  const up: bigint[] = [];
  for (let r = l.min; r <= top; r = next(l, r)) up.push(r);
  return up.reverse();
}

/** The chunk a note of this value gives: the largest rung at or below it, or null below the smallest rung. */
export function chunkOf(l: Ladder, value: bigint): bigint | null {
  if (typeof value !== "bigint" || value < 0n || value >= U128) throw new Error("value: not a u128");
  return rungsUpTo(l, value)[0] ?? null;
}

/** The note values a move of `amount` lands as: largest first, adding up to the amount exactly. */
export function ladderSplit(l: Ladder, amount: bigint): bigint[] {
  checkLadder(l);
  if (typeof amount !== "bigint" || amount <= 0n || amount >= U128) throw new Error("amount: a u128 above 0");
  const out: bigint[] = [];
  let left = amount;
  for (const r of rungsUpTo(l, amount)) {
    while (left >= r) {
      out.push(r);
      left -= r;
    }
  }
  if (out.length === 0) return [amount];
  out[0] = out[0]! + left; // below the smallest rung: rides on the largest note
  return out;
}

/** One note of a move into a pool: its ref, its value and its precommitment. */
export type PlannedNote = { ref: NoteRef; scope: bigint; value: bigint; precommitment: bigint };

// The second-arrival id of a move's first note (the store's firstOf, read the other way).
function idOf(first: NoteRef): Extract<NoteRef, { kind: "second" }>["id"] {
  switch (first.kind) {
    case "deposit": return { id: "U", s: first.s, i: first.i };
    case "return": return { id: "R", c: first.c, l: first.l, j: first.j };
    case "move": return { id: "V", l: first.l, j: first.j };
    default: throw new Error(`a move into a pool starts with a deposit, return or move note, not ${String(first?.kind)}`);
  }
}

/**
 * The notes a move of `amount` into the pool of `scope` lands as: `first` takes the largest value, then the same id's
 * second arrivals n = 0, 1, ... in order. Each note is deposited on its own, the next only once the one before has
 * landed (the store refuses to plan it sooner).
 */
export function poolDepositPlan(seed64: Uint8Array, scope: bigint, ladder: Ladder, first: NoteRef, amount: bigint): PlannedNote[] {
  if (first.kind === "deposit" && first.s !== scope) throw new Error("a deposit note's scope is its s");
  const id = idOf(first);
  return ladderSplit(ladder, amount).map((value, n) => {
    const ref: NoteRef = n === 0 ? first : { kind: "second", id, n: n - 1 };
    return { ref, scope, value, precommitment: noteSecrets(seed64, ref).precommitment };
  });
}
