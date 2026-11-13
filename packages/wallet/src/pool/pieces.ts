// The one rule for the pieces a pool holds (card every-lamport-can-move; owner 13 Nov 06:44Z: no leftover money, nothing
// that cannot move). Every step that makes a note (a deposit, a sale's return, a buy's or a withdraw's change) and every
// step that spends one (a buy's piece, a withdraw's part) asks this file, so no step ever makes a note no step can move.
//
// - The grid: the ladder's unit. On Solana 1,000,000 lamports (0.001 SOL, the program's MIN_DEPOSIT: contracts/pool-solana
//   src/lib.rs); every rung is a whole multiple of it. A rest kept as its own note would reappear, to the lamport, in
//   the release that finally spends it and tie that release to the sale whose public deposit made it (the privacy rule:
//   no two of one user's wallets linked), so no step ever deposits one.
// - The sizes (card pool-amounts-are-standard-sizes; the lite paper: "Standard chunk sizes make every buy look like
//   many others"): every amount that leaves or enters the pool is a rung of the 1-2-5 ladder from the floor up. A note
//   a step makes is one rung (noteOf: the largest rung at or under what the step holds), so every note made from here on
//   is released whole or in rungs, to 0. What a step holds under the next rung never enters the pool off the ladder and
//   is never paid away: it stays on its W, the user's own, listed in the balance, and goes on with W's next move (the
//   CO's pick (c), 13 Nov 20:4xZ). The one release off the ladder is the last remainder of a note made before this rule
//   (off the grid, or on it but no rung: main made 12,000,000 and 3,000,000 notes), once, whole: the circuit has one
//   input and withdrawnValue is public, so no other way out exists without a contract change.
// - The floor: the least piece, and the least note: 0.005 SOL, the smallest rung at or above what one release can move
//   whole on a buy and on a withdraw. A release
//   spends one note (the withdraw circuit has one input: src/release.rs Release, its 8 signals), passes the backstop
//   relay_fee x 10,000 <= withdrawn x 5,000 on its own (src/release.rs:150), and leaves W at least rent(0) after the
//   relay fee F and, on a buy, the tip cap (./solana.ts bind). So a buy needs F + SOL_TIP_CAP + rent(0) and a withdraw
//   max(2F, F + rent(0) + W's fee). At mainnet rent (5,080 a byte, read 2 Nov 2026; F 1,300,000) those are 2,950,240
//   and 2,600,000, so the least rung that covers both is 5,000,000 (SOL_NOTE_FLOOR). A constant, so the queue picks a chunk before any read; the bind still
//   checks the program's floors at the rent it reads, so a rent rise fails a bind, never signs a release the program
//   refuses (test/pool-every-lamport.test.ts holds the constant to the kit's floors at mainnet rent).
// - A piece (pieceChunk): a note's chunk is the largest rung at or under it whose change is 0 or at least the floor; with
//   none (only a note made before this rule), the note itself, once: from the floor up, or under it down to the rule's
//   `least`, what one release can move whole on a buy (on Solana the kit's buy floor at mainnet rent, F + SOL_TIP_CAP +
//   rent(0) = 2,950,240: SOL_FINISH_LEAST); one under `least` only a withdraw takes whole (signpage src/pool-withdraw.ts).
// - A note made (solanaNoteOf): the largest rung at or under what a step holds for the pool; under the floor, none. The
//   rest stays on W (a note under the floor could never leave: the per-release rent the program locks for good is
//   1,082,040).
import { isRung, rungsUpTo, type Ladder } from "./ladder.ts";

/** Solana's grid, lamports: 0.001 SOL. */
export const SOL_GRID = 1_000_000n;
/** The least piece and the least note on Solana, lamports: 0.005 SOL, the least rung over the buy and withdraw floors at mainnet rent. */
export const SOL_NOTE_FLOOR = 5_000_000n;
/** The least note made before this rule (under the floor) that a buy's release takes whole, lamports: the kit's buy floor
 *  at mainnet rent, F 1,300,000 + SOL_TIP_CAP 1,000,000 + rent(0) 650,240 (test/pool-every-lamport.test.ts holds it to
 *  the kit's at that rent; the bind checks the program's at the rent it reads). */
export const SOL_FINISH_LEAST = 2_950_240n;

/** A chain's piece rule: its grid, its floor (a multiple of the grid, the ladder's least rung), its ladder, and `least`:
 *  the least off-grid note (made before the rule) a release still finishes whole, at most the floor. */
export type PieceRule = { readonly grid: bigint; readonly floor: bigint; readonly ladder: Ladder; readonly least: bigint };

export function checkPieceRule(r: PieceRule): PieceRule {
  if (typeof r?.grid !== "bigint" || r.grid <= 0n) throw new Error("piece rule: grid above 0");
  if (typeof r.floor !== "bigint" || r.floor < r.grid || r.floor % r.grid !== 0n) throw new Error("piece rule: floor a multiple of the grid");
  if (r.ladder.one % r.grid !== 0n || r.ladder.min !== r.floor) throw new Error("piece rule: every rung on the grid, the least rung the floor");
  if (typeof r.least !== "bigint" || r.least <= 0n || r.least > r.floor) throw new Error("piece rule: least above 0, at most the floor");
  return r;
}

/** Whether a release of `x` is a standard size: a rung of the pool's ladder (the floor and up). */
export function isReleaseSize(r: PieceRule, x: bigint): boolean {
  return typeof x === "bigint" && isRung(r.ladder, x);
}

/** Every standard size at or under `top`, largest first: the rungs. */
export function releaseSizesUpTo(r: PieceRule, top: bigint): bigint[] {
  return rungsUpTo(r.ladder, top);
}

/** The chunk a release takes from a note of `value`: the largest rung that leaves 0 or at least the floor; else (a note
 *  made before this rule, no rung of which leaves a change that moves) the note itself, once; under the floor the note
 *  itself down to `least`, null under that. A note made under this rule is a rung, so it always meets a rung. */
export function pieceChunk(r: PieceRule, value: bigint): bigint | null {
  if (typeof value !== "bigint" || value < 0n) throw new Error("value: not a whole amount");
  if (value < r.floor) return value >= r.least ? value : null;
  for (const rung of rungsUpTo(r.ladder, value)) {
    const change = value - rung;
    if (change === 0n || change >= r.floor) return rung;
  }
  return value;
}

/** What a step that holds `amount` for the pool makes: one note, the largest rung at or under it, or none under the
 *  floor, and what it keeps on W (never paid away, never deposited off the ladder). */
export function noteOf(r: PieceRule, amount: bigint): { note: bigint; kept: bigint } {
  if (typeof amount !== "bigint" || amount < 0n) throw new Error("amount: not a whole amount");
  const note = amount < r.floor ? 0n : (rungsUpTo(r.ladder, amount)[0] ?? 0n);
  return { note, kept: amount - note };
}

/** Whether a change is one some step can move: 0, or at least the floor and on the grid. */
export function changeMoves(r: PieceRule, change: bigint): boolean {
  return change === 0n || (change >= r.floor && change % r.grid === 0n);
}
