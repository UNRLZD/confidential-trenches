// A buy spends its change in the same tap (card buy-spends-its-change-in-the-same-tap). A release takes one listed piece
// of a note (../../wallet/src/pool/pieces.ts pieceChunk: 0.012 SOL gives 0.005, the 0.007 change after it), and a
// release names a root the tree already holds (contracts/pool-solana src/release.rs:216-217) while its change leaf only
// enters when it lands (release.rs:271), so one transaction cannot release a note's piece and its change. The tap does it
// in two rounds to the one W: round 1 releases the pieces whose change it carries (tag 2s, no tag 3: the helper's round,
// card buy-carry-helper-round), reads them back, settles each note (its change written UNSPENT with its leaf), and proves
// each change bound to the same W on the newest root (the queue's proveFor); round 2 is the buy as before, with the
// carried changes among its pieces and round 1's landed releases counted in W's funds (`landed`).
//
// - Who is carried: a piece of a note other than W's own one (the own note's release is round 2's tag 3, so a buy that
//   lands always spends W's own note and the restore finds W, ./buy-wallets.ts; its change is never carried). A carried
//   piece is the change's own listed piece (pieceChunk of the change), one level: a change that leaves a change again
//   gives its next piece on the next tap.
// - The cap: round 1's releases and round 2's together are at most the kit's SOLANA_POOL_BUY_PIECES_MAX, the funds rule
//   counting them all (req.before).
// - No new link: every piece pays the same W, and the change is proved to that W.
// - The step is the buy's and any caller's that moves pool money to one W before it spends (card
//   one-balance-buys-on-every-chain): carryRound(host, pieces, to) returns the change proofs bound to `to`, ready for
//   the caller's own round.
import { carriedChunk } from "../../wallet/src/pool/balances.ts";
import { SOL_PIECES } from "../../wallet/src/pool/solana.ts";
import type { PieceRule } from "../../wallet/src/pool/pieces.ts";

/** A pick piece standing for a change a tap would carry: its parent note's id, W and binding, and the change's piece. */
export type Carried<P> = P & { readonly carryOf: string };

/** The list with, for each piece of a note other than its W's own that leaves a change, that change's piece as a carried
 *  pick piece (noteId `<parent>#change`, newest root): what the pick weighs past the ready pieces. `valueOf`: the note's
 *  value, as the store holds it (undefined: not carried). */
export function carriesOf<P extends { readonly noteId: string; readonly own?: true; readonly chunk: bigint; readonly root?: string; readonly wallet: { readonly address: string } }>(list: readonly P[], valueOf: (noteId: string) => bigint | undefined, rule: PieceRule = SOL_PIECES): (P | Carried<P>)[] {
  const out: (P | Carried<P>)[] = [...list];
  const seen = new Set<string>();
  for (const p of list) {
    if (p.own === true || p.noteId.endsWith("#change")) continue;
    const v = valueOf(p.noteId);
    const k = v === undefined ? null : carriedChunk(rule, v, p.chunk);
    // one carried piece per note and W
    const key = `${p.noteId}|${p.wallet.address}`;
    if (k === null || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p, noteId: `${p.noteId}#change`, chunk: k, root: "newest", carryOf: p.noteId } as Carried<P>);
  }
  return out;
}

/** Whether a set carries only changes of notes it releases a piece of. */
export function carryOk<P extends { readonly noteId: string }>(set: readonly P[]): boolean {
  const ids = new Set(set.map((p) => p.noteId));
  return set.every((p) => (p as unknown as Partial<Carried<P>>).carryOf === undefined || ids.has((p as unknown as Carried<P>).carryOf));
}

/** The set's carried pieces, and the notes round 1 releases for them (each carried piece's parent). */
export function roundsOf<P extends { readonly noteId: string }>(set: readonly P[]): { carried: Carried<P>[]; first: P[]; rest: P[] } {
  const carried = set.filter((p) => (p as unknown as Partial<Carried<P>>).carryOf !== undefined) as Carried<P>[];
  const parents = new Set(carried.map((c) => c.carryOf));
  return { carried, first: set.filter((p) => parents.has(p.noteId)), rest: set.filter((p) => !parents.has(p.noteId) && (p as unknown as Partial<Carried<P>>).carryOf === undefined) };
}
