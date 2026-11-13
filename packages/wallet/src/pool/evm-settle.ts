// The settle of the EVM pool's RESERVED notes (card signpage-evm-proof-queue): the one path that ends a RESERVED EVM
// pool note, whatever its send did (landed, refused, never answered, sent by a page that died). The Solana pool's is
// ./solana-restore.ts solanaSettleReserved; this keeps its rules on the EVM pool's own events and time.
//
// - The read: one round of the pool's sync (./evm.ts evmTreeSync events()): every leaf event of the pool up to the
//   newest block both RPCs agree on by hash (the round's `anchor`), the same on both byte for byte, whose trees are the
//   pool's views at that block, and the round's finalized anchor `fin` (the lower of the two RPCs' EVM_POOL_TAG blocks).
//   A round in which the two RPCs disagree (a release on one only, two blocks at the newest height) is refused or a lag,
//   and settles nothing: the store keeps its last agreed state. No read names a note: only the pool's whole-set events.
// - One cut, the anchor (card evm-money-shows-and-spends-at-once): a fact the anchor holds is written at once, never
//   held for `fin`, which trails the head by about 1,100 s on Base and Robinhood mainnet and 950-1,275 s on their test
//   networks (read 12 Nov 20:05Z). Base is an OP Stack chain: "latest" is an unsafe block the sequencer "can reorganize
//   ... until their data lands on Ethereum", "safe" once its data is posted and "finalized" once Ethereum finalizes it
//   (docs.optimism.io/stack/transactions/transaction-finality). Robinhood is an Arbitrum Orbit chain: "latest" is the
//   sequencer's soft confirmation, "safe" and "finalized" its batch at the parent chain's safe and finalized blocks
//   (docs.arbitrum.io/how-arbitrum-works/reference/finality-and-reorgs). One sequencer orders both, so a reorg of the
//   head replaces the blocks back to the last posted batch, minutes deep: no depth of a few blocks would cover it, and
//   two operators agreeing on one hash removes the only short disagreement. What covers it is the heal below and the pool
//   itself, which refuses a proof on a root a reorg dropped (UnknownStateRoot) or a nullifier spent twice: a reorg costs
//   at most a refused transaction, never money.
// - The heal, first: each landed note of the scope whose block the store keeps (../notes/store.ts EvmLandings: landed
//   above its round's finalized block, and no round since has held it with that block final), that block at or under
//   the round's anchor (a round short of it says nothing of it), not SPENT, no note's parent, whose leaf the round does
//   not hold at its index, is backed out (the store's backOut, refused for a note whose block it no longer keeps): its
//   own deposit back to INCOMING, its old block kept as the mark of a note backed out there, a change note gone with its
//   parent back to RESERVED (its release dropped: the settle below reads it again or frees it past its deadline).
//   Children first, so a chain of them unwinds in one pass.
// - The landing again: each backed-out note of the scope (INCOMING with its block kept), of any kind (deposit, return,
//   second arrival, move), whose precommitment a Deposited of the round names is taken at that leaf as a restore from
//   the words takes it (./evm-restore.ts evmDepositLeaf, evmClaimTaken), marked landed when above `fin`; a change note
//   lands again with its parent's release below. Then the store drops the kept block, at or under `fin`, of each note
//   this round held at its index and each backed-out one no Deposited of the round names (finalized): a fact final.
// - Spent: a Withdrawn or Bought whose _spentNullifier is the note's nullifier hash (IPrivacyPool.sol:78-85, 253-262), in
//   the round. The release must come after the note's leaf and withdraw above 0 and at most its value, as the pool
//   makes every release (./evm-restore.ts evmRestore); any other holds the note. Its change note is value - withdrawn
//   under change (l, j), j = jOf(its ref) (the next note ./queue.ts prove binds), at the release's own leaf: written
//   UNSPENT through the store's add(child, parent), which moves the note to SPENT in the same write (../notes/store.ts),
//   marked landed when the release's block is above `fin`. A release whose _newCommitment is not that change (the
//   note's secrets used elsewhere) is the chain's truth all the same: the note goes to SPENT with no change note, as a
//   restore lists it (`elsewhere`), never freed, once the release's block is at or under `fin`; above it the note is
//   held (SPENT is terminal, and no change's landing would undo it if a reorg dropped the release). The same holds an UNSPENT note to the round: one whose release the round
//   shows (a release a reorg brought back after the note was freed or backed out, or another device's) is settled spent.
// - Freed: the pool refuses a release once block.timestamp * 1000 is past its deadlineMs (src/PrivacyPool.sol:241), and
//   a block's timestamp is never below its parent's, and may equal it: on Robinhood (Arbitrum Nitro) the sequencer sets
//   a block's time to its parent's when it would be lower (OffchainLabs/nitro arbos/block_processor.go:211-212 at
//   ccc5c828); on Base it is observed, not cited: 40 consecutive blocks on each of Base and Base Sepolia (read 9 Nov
//   22:33Z) had none below its parent and 32 equal to it. So once the anchor's time * 1000 is past the note's deadline,
//   any release of the note is in a block at or below the anchor, so in the round. No release in the round then:
//   RESERVED -> UNSPENT (the store's own rule, blockTimeMs past deadlineMs), and the queue proves the note again. Before
//   that the note is held: its send may still land. The anchor is the lower of the two RPCs' newest blocks, so a
//   deadline past on one RPC's head only frees nothing. A reorg that brings the release back after that is read as a
//   spend of the UNSPENT note (above); a proof of it sent meanwhile is refused by the pool (its nullifier is spent).
// - Each state read runs it while evmSettleOpen holds: a RESERVED note of the scope, or one whose block the store keeps
//   (in the tail, or backed out and not landed again): one round read a state read while a note is unfinal, none once
//   every note is final. It is idempotent: a note it settled is
//   no longer RESERVED, so a second pass reads nothing for it, and a change another tab wrote first with this leaf is
//   taken. A reload mid-way leaves either the note RESERVED (nothing written) or the change written, whose parent the
//   store moves to SPENT at its next open.
// - A read that fails holds every note (the pass throws); a note's own check or write that fails holds that note.
// Nothing here logs, and the nullifier hashes never leave the device.
import { noteCommitment, noteSecrets } from "../notes/secrets.ts";
import { refKey, type NoteRecord, type NoteStore } from "../notes/store.ts";
import { EVM_LIFE_MS, type EvmBlock, type EvmPoolEvent } from "./evm.ts";
import { evmClaimTaken, evmDepositLeaf } from "./evm-restore.ts";
import { jOf } from "./queue.ts";

/** One round of the pool's sync, as evmTreeSync events() gives it: its finalized anchor, its newest agreed anchor and
 *  its agreed events up to that anchor. */
export type EvmSettleRound = { fin: Pick<EvmBlock, "number" | "timestamp">; anchor: Pick<EvmBlock, "number" | "timestamp">; events: readonly EvmPoolEvent[] };

/** What one pass did with each note it read for: settled spent, freed (RESERVED -> UNSPENT), held for the next pass, or
 *  backed out (a reorg dropped its leaf or its release). */
export type EvmReservedPass = { spent: string[]; freed: string[]; held: string[]; backedOut: string[] };

export type EvmSettleArgs = {
  seed64: Uint8Array;
  notes: NoteStore;
  /** The pool's scope (evmPoolScopeOf): only its notes are settled. */
  scope: bigint;
  /** One round of the pool's sync (evmTreeSync events()), read only while evmSettleOpen holds for the scope. */
  round: (signal?: AbortSignal) => Promise<EvmSettleRound>;
  signal?: AbortSignal;
};

/** The most rounds of back-outs one pass makes: a chain of change notes unwinds one generation a round. */
const HEAL_ROUNDS = 64;

/**
 * Whether a settle pass has anything to read for the scope: a RESERVED note of it, or a note of it whose block the store
 * keeps (`landings`: one landed above the finalized block, or one backed out and not landed again yet). The one rule a
 * caller asks before it reads a round or the seed; false once every note of the scope is final.
 */
export function evmSettleOpen(notes: readonly NoteRecord[], landings: ReadonlyMap<string, bigint>, scope: bigint): boolean {
  return notes.some((n) => n.scope === scope && (n.state === "RESERVED" || landings.has(n.id)));
}

export async function evmSettleReserved(a: EvmSettleArgs): Promise<EvmReservedPass> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  const out: EvmReservedPass = { spent: [], freed: [], held: [], backedOut: [] };
  const mine = async () => (await a.notes.list()).filter((n) => n.scope === a.scope);
  const first = await mine();
  const tail = await a.notes.landings();
  if (!evmSettleOpen(first, tail, a.scope)) return out;
  const r = await a.round(a.signal);
  if (typeof r?.fin?.number !== "bigint" || typeof r.fin.timestamp !== "bigint" || typeof r?.anchor?.number !== "bigint" || typeof r.anchor.timestamp !== "bigint" || !Array.isArray(r.events)) throw new Error("round: not the sync's round");
  const anchorMs = r.anchor.timestamp * 1000n;
  // each release by its nullifier: at most one (the pool refuses a nullifier twice; a round with two is not the pool's)
  const releases = new Map<bigint, number>();
  r.events.forEach((e, at) => {
    if (e.kind === "deposit") return;
    if (releases.has(e.nullifier!)) throw new Error(`leaf ${at}: a nullifier spent twice`);
    releases.set(e.nullifier!, at);
  });
  // the heal: a tail note whose leaf the round lacks at its index, children first
  const failed = new Set<string>();
  for (let k = 0; k < HEAL_ROUNDS; k++) {
    a.signal?.throwIfAborted();
    const all = await mine();
    const kept = k === 0 ? tail : await a.notes.landings();
    // only a note whose kept block the round reached (at or under its anchor): a round short of it says nothing of it
    const gone = all.filter((n) => kept.has(n.id) && kept.get(n.id)! <= r.anchor.number && n.leaf !== undefined && n.state !== "SPENT" && !failed.has(n.id) && r.events[Number(n.leaf.leafIndex)]?.state !== n.leaf.commitment && !all.some((c) => c.parent === n.id));
    if (gone.length === 0) break;
    for (const n of gone) {
      a.signal?.throwIfAborted();
      try {
        // a parent with no attempt of this store: the latest its release's proof could still land (made before now)
        await a.notes.backOut(n.id, r.fin.number, anchorMs + EVM_LIFE_MS);
        out.backedOut.push(n.id);
      } catch {
        failed.add(n.id);
        out.held.push(n.id);
      }
    }
  }
  // the landing again: each backed-out note (INCOMING, its old block kept) whose precommitment a Deposited of the round
  // names is taken at that leaf, as a restore from the words takes it (evmDepositLeaf, evmClaimTaken)
  const final: string[] = [];
  let changed = out.backedOut.length > 0;
  const marks = await a.notes.landings();
  for (const n of await mine()) {
    const b = marks.get(n.id);
    if (b === undefined || failed.has(n.id)) continue;
    if (n.state === "INCOMING") {
      a.signal?.throwIfAborted();
      try {
        const leaf = evmDepositLeaf(a.scope, r.events, n.precommitment);
        if (leaf === null) {
          if (b <= r.fin.number) final.push(n.id); // its old block final, no deposit of it: the mark goes
          continue;
        }
        const block = r.events[Number(leaf.leafIndex)]!.block;
        await evmClaimTaken(a.notes, [{ ref: n.ref, scope: n.scope, precommitment: n.precommitment, leaf, state: "UNSPENT", ...(block > r.fin.number ? { landed: { block, fin: r.fin.number } } : {}) }]);
        changed = true;
      } catch {
        out.held.push(n.id);
      }
    } else if (n.leaf !== undefined && r.events[Number(n.leaf.leafIndex)]?.state === n.leaf.commitment) final.push(n.id);
  }
  // a kept block at or under fin goes only for a note this round held (or, backed out, names no deposit of)
  await a.notes.finalized(a.scope, r.fin.number, final);
  // the notes as first read unless the heal changed some (a note another tab settled meanwhile is caught by its write)
  for (const n of changed ? await mine() : first) {
    if (n.state !== "RESERVED" && n.state !== "UNSPENT") continue;
    if (n.state === "UNSPENT" && (n.leaf === undefined || !releases.has(noteSecrets(a.seed64, n.ref).nullifierHash))) continue;
    a.signal?.throwIfAborted(); // a sign out (its round read or a note's write in hand) stops the pass before its next write
    try {
      const s = await settleOne(a, n, r, releases, anchorMs);
      out[s].push(n.id);
    } catch {
      out.held.push(n.id);
    }
  }
  return out;
}

async function settleOne(a: EvmSettleArgs, n: NoteRecord, r: EvmSettleRound, releases: ReadonlyMap<bigint, number>, anchorMs: bigint): Promise<"spent" | "freed" | "held"> {
  const leaf = n.leaf;
  const from = n.state as "RESERVED" | "UNSPENT";
  if (leaf === undefined || (from === "RESERVED" && n.deadlineMs === undefined)) throw new Error(`${refKey(n.ref)}: a RESERVED note holds its leaf and its deadline`);
  // the note's own leaf, as the round holds it: a store and a round that differ settle nothing
  if (r.events[Number(leaf.leafIndex)]?.state !== leaf.commitment) throw new Error(`${refKey(n.ref)}: its leaf is not the round's`);
  const at = releases.get(noteSecrets(a.seed64, n.ref).nullifierHash);
  if (at === undefined) {
    if (from === "UNSPENT") return "held";
    if (anchorMs <= n.deadlineMs!) {
      // a release this device read landed (on the note's mark) in a block the round covers, yet not in the round: a
      // reorg dropped it, so the balance counts the whole note again (card pool-buy-record-never-stays-sent)
      const m = (await a.notes.marks()).get(n.id);
      if (m !== undefined && m.attempt === n.attempt && m.withdrawn !== undefined && m.block !== undefined && m.block <= r.anchor.number) await a.notes.unlanded(n.id, m.attempt);
      return "held"; // its release can still land
    }
    await a.notes.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: anchorMs });
    return "freed";
  }
  const e = r.events[at]!;
  if (BigInt(at) <= leaf.leafIndex) throw new Error(`${refKey(n.ref)}: its release is not after its leaf`);
  if (e.value === 0n || e.value > leaf.value) throw new Error(`${refKey(n.ref)}: its release withdrew ${e.value} of ${leaf.value}`);
  const l = leaf.label;
  const cref = { kind: "change", l, j: jOf(n.ref) } as const;
  const cP = noteSecrets(a.seed64, cref).precommitment;
  const cValue = leaf.value - e.value;
  const commitment = noteCommitment(cValue, l, cP);
  if (commitment !== e.state) {
    // not the device's release (its change is not the note's): spent all the same, with no change note of ours, once
    // its block is final; above `fin` held, since SPENT is terminal and no change's landing would undo it after a reorg
    if (e.block > r.fin.number) return "held";
    await a.notes.move(n.id, from, "SPENT");
    return "spent";
  }
  const cLeaf = { value: cValue, label: l, commitment, leafIndex: BigInt(at) };
  const landed = e.block > r.fin.number ? { landed: { block: e.block, fin: r.fin.number } } : {};
  try {
    await a.notes.add({ ref: cref, scope: a.scope, precommitment: cP, state: "UNSPENT", parent: n.id, leaf: cLeaf, ...landed });
  } catch (err) {
    // another tab wrote this change first: taken when it is this leaf
    const there = (await a.notes.list()).find((x) => x.scope === a.scope && refKey(x.ref) === refKey(cref));
    if (there === undefined || there.precommitment !== cP || there.leaf?.commitment !== commitment || there.leaf.leafIndex !== cLeaf.leafIndex) throw err;
  }
  return "spent";
}
