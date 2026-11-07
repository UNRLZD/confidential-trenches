// The releases the device sent to a one-time wallet W at a sell (card evm-sell-no-release-in-flight; audit E-01): the
// `sent` list the kit's sell quote takes (packages/kit src/checks/evm/quote.ts evmPoolSellQuote, judged by
// src/trade/evm/sell-releases.ts). The quote reads W's landed releases itself, on two RPCs at its own block; what no
// chain read can see is a release on its way that has not landed, and only the device knows those: every note of this
// pool whose proof left the device (RESERVED, ../notes/store.ts: written before the proof is sent, and back to UNSPENT
// only once a final block's time is past its deadline) and whose release pays this W; and every SPENT note that pays this
// W whose release the pool's own round (./evm.ts evmTreeSync events(), the whole pool's events on two RPCs, no read
// naming a note) shows in a block above its finalized anchor, or does not show at all (the store saw it land on a
// fresher round): a release in a block not yet final, which the quote's read may not reach when it is above every
// provider's "latest" (review of 181fd050, info). The list can only add waits to the quote's verdict, never clear one.
//
// W is W_{evm, l, j}: l the note's label and j = jOf(its ref), the only W a proof of the note pays (./queue.ts prove,
// ./evm.ts bind), so a note pays W exactly when its (l, j) is W's; no key is derived here. Each is named by its ref,
// with its nullifier hash (from the seed, as ./evm-restore.ts reads a spend) and its attempt's deadline. A HELD note's
// proof never left the device, so it is not on its way. Nothing is sent: the store is read on the device, and the
// nullifier hashes go only into the kit's quote, never into a read.
import type { EvmSellSent } from "@blindfill/kit";
import type { EvmBlock, EvmPoolEvent } from "./evm.ts";
import { noteSecrets } from "../notes/secrets.ts";
import { refKey, type NoteRecord } from "../notes/store.ts";
import { jOf } from "./queue.ts";

/** The pool's round as its sync read it: its finalized anchor and its events up to the newest agreed block. */
export type EvmSellRound = { fin: Pick<EvmBlock, "number">; events: readonly EvmPoolEvent[] };

/** Every release the device sent to W_{evm, l, j} on the pool of `scope` that has not landed final as far as the store
 *  `notes` (its list) and the pool's `round` know: the kit sell quote's `sent` for that W. */
export function evmSellSent(seed64: Uint8Array, scope: bigint, l: bigint, j: number, notes: readonly NoteRecord[], round: EvmSellRound): EvmSellSent[] {
  const released = new Map(round.events.filter((e) => e.kind !== "deposit").map((e) => [e.nullifier, e.block]));
  const sent: EvmSellSent[] = [];
  for (const n of notes) {
    if (n.scope !== scope || (n.state !== "RESERVED" && n.state !== "SPENT")) continue;
    if (n.state === "RESERVED" && (n.leaf === undefined || n.deadlineMs === undefined)) throw new Error(`${refKey(n.ref)}: a RESERVED note holds its leaf and its deadline`);
    if (n.leaf === undefined) throw new Error(`${refKey(n.ref)}: a SPENT note holds its leaf`);
    if (n.leaf.label !== l || jOf(n.ref) !== j) continue;
    const nullifier = noteSecrets(seed64, n.ref).nullifierHash;
    if (n.state === "RESERVED") sent.push({ note: refKey(n.ref), nullifier, deadlineMs: n.deadlineMs! });
    else {
      // spent: final once the round shows its release at or below the finalized anchor
      const at = released.get(nullifier);
      if (at === undefined || at > round.fin.number) sent.push({ note: refKey(n.ref), nullifier });
    }
  }
  return sent;
}
