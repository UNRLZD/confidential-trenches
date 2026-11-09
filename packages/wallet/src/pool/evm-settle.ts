// The settle of the EVM pool's RESERVED notes (card signpage-evm-proof-queue): the one path that ends a RESERVED EVM
// pool note, whatever its send did (landed, refused, never answered, sent by a page that died). The Solana pool's is
// ./solana-restore.ts solanaSettleReserved; this keeps its rules on the EVM pool's own events and time.
//
// - The read: one round of the pool's sync (./evm.ts evmTreeSync events()): every leaf event of the pool up to the
//   newest block both RPCs agree on, the same on both byte for byte, whose trees are the pool's views at that block, and
//   the round's finalized anchor `fin`: the lower of the two RPCs' EVM_POOL_TAG ("finalized") blocks, read by number on
//   both with one hash. A round in which the two RPCs disagree (a release on one only, below the newer head of the two)
//   is refused or a lag, and settles nothing. No read names a note: only the pool's whole-set events and views.
// - Spent: a Withdrawn or Bought whose _spentNullifier is the note's nullifier hash (IPrivacyPool.sol:78-85, 253-262), in
//   a block at or below `fin`: both RPCs show it in a block that never moves. One above `fin` holds the note (a reorg may
//   still drop it). The release must come after the note's leaf and withdraw above 0 and at most its value, as the pool
//   makes every release (./evm-restore.ts evmRestore); any other holds the note. Its change note is value - withdrawn
//   under change (l, j), j = jOf(its ref) (the next note ./queue.ts prove binds), at the release's own leaf: written
//   UNSPENT through the store's add(child, parent), which moves the note to SPENT in the same write (../notes/store.ts).
//   A release whose _newCommitment is not that change (the note's secrets used elsewhere) is the chain's truth all the
//   same: the note goes to SPENT with no change note, as a restore lists it (`elsewhere`), never freed.
// - Freed: the pool refuses a release once block.timestamp * 1000 is past its deadlineMs (src/PrivacyPool.sol:241), and
//   a block's timestamp never goes below its parent's, so once `fin`'s time * 1000 is past the note's deadline, any
//   release of the note is in a block at or below `fin`, so in the round. `fin` is the lower of the two RPCs' finalized
//   blocks, so both RPCs' final block time is past the deadline. No release in the round then: RESERVED -> UNSPENT (the
//   store's own rule, blockTimeMs past deadlineMs), and the queue proves the note again. Before that the note is held:
//   its send may still land. A deadline past on one RPC's final block only is not past on `fin` (the lower), so it frees
//   nothing.
// - Robinhood serves no finalized state (decision M359: 3 of 4 Robinhood RPCs refused it): the sync reads no state at
//   `fin`, only its block header by the "finalized" tag, which every chain here serves, and the pool's views at the
//   newest agreed block. So "final" is the chain's finalized tag on both chains: on Base (OP Stack) an L2 block derived
//   from finalized L1 data, on Robinhood (Arbitrum Orbit) one whose batch is in a finalized parent-chain block. The tag
//   lags the head by about 155 s to 1,376 s on Base Sepolia and Robinhood testnet (./evm.ts header, read 3 Nov 04:46Z),
//   so a dropped note is freed that long after its deadline, never sooner.
// - Each state read runs it; it is idempotent: a note it settled is no longer RESERVED, so a second pass reads nothing
//   for it, and a change another tab wrote first with this leaf is taken. A reload mid-way leaves either the note
//   RESERVED (nothing written) or the change written, whose parent the store moves to SPENT at its next open.
// - A read that fails holds every note (the pass throws); a note's own check or write that fails holds that note.
// Nothing here logs, and the nullifier hashes never leave the device.
import { noteCommitment, noteSecrets } from "../notes/secrets.ts";
import { refKey, type NoteRecord, type NoteStore } from "../notes/store.ts";
import type { EvmBlock, EvmPoolEvent } from "./evm.ts";
import { jOf } from "./queue.ts";

/** One round of the pool's sync, as evmTreeSync events() gives it: its finalized anchor and its agreed events. */
export type EvmSettleRound = { fin: Pick<EvmBlock, "number" | "timestamp">; events: readonly EvmPoolEvent[] };

/** What one pass did with each RESERVED note: settled spent, freed (RESERVED -> UNSPENT) or held for the next pass. */
export type EvmReservedPass = { spent: string[]; freed: string[]; held: string[] };

export type EvmSettleArgs = {
  seed64: Uint8Array;
  notes: NoteStore;
  /** The pool's scope (evmPoolScopeOf): only its notes are settled. */
  scope: bigint;
  /** One round of the pool's sync (evmTreeSync events()), read only when a RESERVED note of the scope is open. */
  round: (signal?: AbortSignal) => Promise<EvmSettleRound>;
  signal?: AbortSignal;
};

export async function evmSettleReserved(a: EvmSettleArgs): Promise<EvmReservedPass> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  const out: EvmReservedPass = { spent: [], freed: [], held: [] };
  const reserved = (await a.notes.list()).filter((n) => n.scope === a.scope && n.state === "RESERVED");
  if (reserved.length === 0) return out;
  const r = await a.round(a.signal);
  a.signal?.throwIfAborted();
  if (typeof r?.fin?.number !== "bigint" || typeof r.fin.timestamp !== "bigint" || !Array.isArray(r.events)) throw new Error("round: not the sync's round");
  const finMs = r.fin.timestamp * 1000n;
  // each release by its nullifier: at most one (the pool refuses a nullifier twice; a round with two is not the pool's)
  const releases = new Map<bigint, number>();
  r.events.forEach((e, at) => {
    if (e.kind === "deposit") return;
    if (releases.has(e.nullifier!)) throw new Error(`leaf ${at}: a nullifier spent twice`);
    releases.set(e.nullifier!, at);
  });
  for (const n of reserved) {
    try {
      const s = await settleOne(a, n, r, releases, finMs);
      out[s].push(n.id);
    } catch {
      out.held.push(n.id);
    }
  }
  return out;
}

async function settleOne(a: EvmSettleArgs, n: NoteRecord, r: EvmSettleRound, releases: ReadonlyMap<bigint, number>, finMs: bigint): Promise<keyof EvmReservedPass> {
  const leaf = n.leaf;
  if (leaf === undefined || n.deadlineMs === undefined) throw new Error(`${refKey(n.ref)}: a RESERVED note holds its leaf and its deadline`);
  // the note's own leaf, as the round holds it: a store and a round that differ settle nothing
  if (r.events[Number(leaf.leafIndex)]?.state !== leaf.commitment) throw new Error(`${refKey(n.ref)}: its leaf is not the round's`);
  const at = releases.get(noteSecrets(a.seed64, n.ref).nullifierHash);
  if (at === undefined) {
    if (finMs <= n.deadlineMs) return "held"; // its release can still land
    await a.notes.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: finMs });
    return "freed";
  }
  const e = r.events[at]!;
  if (e.block > r.fin.number) return "held"; // in a block not final on both RPCs yet
  if (BigInt(at) <= leaf.leafIndex) throw new Error(`${refKey(n.ref)}: its release is not after its leaf`);
  if (e.value === 0n || e.value > leaf.value) throw new Error(`${refKey(n.ref)}: its release withdrew ${e.value} of ${leaf.value}`);
  const l = leaf.label;
  const cref = { kind: "change", l, j: jOf(n.ref) } as const;
  const cP = noteSecrets(a.seed64, cref).precommitment;
  const cValue = leaf.value - e.value;
  const commitment = noteCommitment(cValue, l, cP);
  if (commitment !== e.state) {
    // not the device's release (its change is not the note's): spent all the same, with no change note of ours
    await a.notes.move(n.id, "RESERVED", "SPENT");
    return "spent";
  }
  const cLeaf = { value: cValue, label: l, commitment, leafIndex: BigInt(at) };
  try {
    await a.notes.add({ ref: cref, scope: a.scope, precommitment: cP, state: "UNSPENT", parent: n.id, leaf: cLeaf });
  } catch (err) {
    // another tab wrote this change first: taken when it is this leaf
    const there = (await a.notes.list()).find((x) => x.scope === a.scope && refKey(x.ref) === refKey(cref));
    if (there === undefined || there.precommitment !== cP || there.leaf?.commitment !== commitment || there.leaf.leafIndex !== cLeaf.leafIndex) throw err;
  }
  return "spent";
}
