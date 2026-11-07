// The releases the device sent to a one-time wallet W at a sell (card evm-sell-no-release-in-flight; audit E-01): the
// `sent` list the kit's sell quote takes (packages/kit src/checks/evm/quote.ts evmPoolSellQuote, judged by
// src/trade/evm/sell-releases.ts). The quote reads W's landed releases itself, on two RPCs at its own block; what no
// chain read can see is a release on its way that has not landed, and only the device knows those: every note of this
// pool whose proof left the device (RESERVED, ../notes/store.ts: written before the proof is sent, and back to UNSPENT
// only once a final block's time is past its deadline) and whose release pays this W. The list can only add waits to
// the quote's verdict, never clear one.
//
// W is W_{evm, l, j}: l the note's label and j = jOf(its ref), the only W a proof of the note pays (./queue.ts prove,
// ./evm.ts bind), so a note pays W exactly when its (l, j) is W's; no key is derived here. Each is named by its ref,
// with its nullifier hash (from the seed, as ./evm-restore.ts reads a spend) and its attempt's deadline. A HELD note's
// proof never left the device, so it is not on its way. Nothing is sent: the store is read on the device, and the
// nullifier hashes go only into the kit's quote, never into a read.
import type { EvmSellSent } from "@blindfill/kit";
import { noteSecrets } from "../notes/secrets.ts";
import { refKey, type NoteRecord } from "../notes/store.ts";
import { jOf } from "./queue.ts";

/** Every release the device sent to W_{evm, l, j} on the pool of `scope` that has not landed as far as the store `notes`
 *  (its list) knows: the kit sell quote's `sent` for that W. */
export function evmSellSent(seed64: Uint8Array, scope: bigint, l: bigint, j: number, notes: readonly NoteRecord[]): EvmSellSent[] {
  const sent: EvmSellSent[] = [];
  for (const n of notes) {
    if (n.scope !== scope || n.state !== "RESERVED") continue;
    if (n.leaf === undefined || n.deadlineMs === undefined) throw new Error(`${refKey(n.ref)}: a RESERVED note holds its leaf and its deadline`);
    if (n.leaf.label !== l || jOf(n.ref) !== j) continue;
    sent.push({ note: refKey(n.ref), nullifier: noteSecrets(seed64, n.ref).nullifierHash, deadlineMs: n.deadlineMs });
  }
  return sent;
}
