// W's releases at a sell (card evm-sell-no-release-in-flight; audit E-01): the device's read the kit's sell builder
// takes (the kit's evmSellReleases, packages/kit src/trade/evm/sell-releases.ts, which judges it), so no sale is built
// for a W while a release to W is on its way.
//
// - The chain's part is the pool's own round, read by ./evm.ts evmTreeSync's events(): the finalized anchor both RPCs
//   agree on (`fin`) and every Withdrawn and Bought of the pool up to the newest agreed block, the same on both byte for
//   byte and making the pool's trees at that block. No second read: a release in a block above `fin` is not final.
// - The device's part is its store: every note of this pool whose proof left the device (RESERVED, ../notes/store.ts:
//   written before the proof is sent, and back to UNSPENT only once a final block's time is past its deadline) and
//   whose release pays this W, W_{evm, l, j} with l the note's label and j = jOf(its ref), the only W a proof of the
//   note pays (./queue.ts prove, ./evm.ts bind). Each is named by its ref, with its nullifier hash (from the seed, as
//   ./evm-restore.ts reads a spend) and its deadline. A HELD note's proof never left the device, so it is not on its way.
// - Nothing is sent: the store and the round are read on the device, and only the kit's verdict leaves this function.
import { evmSellReleases, type EvmSellReleases } from "@blindfill/kit";
import { freshWallet } from "../derive/index.ts";
import { noteSecrets } from "../notes/secrets.ts";
import { refKey, type NoteRecord } from "../notes/store.ts";
import type { EvmBlock, EvmNetwork, EvmPoolEvent, EvmTreeSync } from "./evm.ts";
import { jOf } from "./queue.ts";

/** The round an EVM pool's sync read: its finalized anchor and every leaf event up to the newest agreed block. */
export type EvmReleaseRound = { fin: Pick<EvmBlock, "number" | "timestamp">; events: readonly EvmPoolEvent[] };

/** The kit's verdict on W's releases on `chain`, from `round` (the pool's events() at one round) and the device's notes
 *  `notes` (the store's list): every release to W not final on two RPCs is pending in it. */
export function evmSellReleasesOf(seed64: Uint8Array, chain: EvmNetwork, scope: bigint, w: string, notes: readonly NoteRecord[], round: EvmReleaseRound): EvmSellReleases {
  if (typeof w !== "string") throw new Error("W: an address");
  const me = w.toLowerCase();
  const sent: { note: string; nullifier: bigint; deadlineMs: bigint }[] = [];
  for (const n of notes) {
    if (n.scope !== scope || n.state !== "RESERVED") continue;
    if (n.leaf === undefined || n.deadlineMs === undefined) throw new Error(`${refKey(n.ref)}: a RESERVED note holds its leaf and its deadline`);
    const k = freshWallet(seed64, "evm", n.leaf.label, jOf(n.ref));
    k.secretKey.fill(0);
    if (k.address.toLowerCase() !== me) continue;
    sent.push({ note: refKey(n.ref), nullifier: noteSecrets(seed64, n.ref).nullifierHash, deadlineMs: n.deadlineMs });
  }
  const releases = round.events.filter((e) => e.kind !== "deposit").map((e) => ({ block: e.block, recipient: e.recipient!, nullifier: e.nullifier! }));
  return evmSellReleases({ chain, w, fin: { number: round.fin.number, timestamp: round.fin.timestamp }, releases, sent });
}

/** evmSellReleasesOf with the notes the store `notes` lists, then a round `sync` reads (its events(), the pool's one read
 *  on two RPCs). The notes first: a release that lands between the two reads is in the round, whatever the store has
 *  made of its note by then, and a sent one that has not landed by the round keeps its note's deadline. */
export async function evmReadSellReleases(a: { seed64: Uint8Array; chain: EvmNetwork; scope: bigint; w: string; notes: { list(): Promise<NoteRecord[]> }; sync: Pick<EvmTreeSync, "events">; signal?: AbortSignal }): Promise<EvmSellReleases> {
  const notes = await a.notes.list();
  const round = await a.sync.events(a.signal);
  return evmSellReleasesOf(a.seed64, a.chain, a.scope, a.w, notes, round);
}
