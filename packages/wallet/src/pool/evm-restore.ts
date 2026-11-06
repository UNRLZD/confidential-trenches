// Restore of the EVM pool's notes, and of every token each spent note's W holds, from the 12 words (card
// notes-restore-evm; ./solana-restore.ts is the Solana pool's, whose walk and follow rules this keeps).
//
// - No request names a note of the user's. The pool's own leaf events are the whole set: every Deposited records its
//   _precommitmentHash, _value, _label and _commitment, every Withdrawn and Bought its W (_recipient), _value
//   (withdrawnValue), _spentNullifier and _newCommitment (contracts/pool-evm/src/interfaces/IPrivacyPool.sol:65-85,
//   253-262). ./evm.ts evmTreeSync reads every one of them on two RPCs up to the newest block both agree on, the same
//   on both byte for byte, and builds the pool's two trees from them, which must be the pool's views at that block
//   (currentRoot, currentTreeSize, currentLabelRoot, currentLabelTreeSize): a log dropped or changed on both RPCs is
//   refused too. The device derives its own precommitments and nullifier hashes and looks them up here; a read per
//   note (nullifierHashes(n), usedPrecommitments(P), or a log filter on one) would tell the RPC which notes are one
//   user's, so none is made.
// - A deposit from its event: label = keccak256(scope ‖ nonce) mod p with nonce its place in the label tree + 1
//   (src/PrivacyPool.sol:96), and commitment = Poseidon(value, label, precommitment), which must be the event's
//   _commitment (so the value is the one the pool hashed); else the restore stops. One precommitment twice, one
//   nullifier spent twice, or one commitment twice in the state tree is not this pool (it refuses each) and stops it.
// - The walk: deposit indices lane by lane until RESTORE_GAP misses in a row (../notes/restore.ts walkLane), each
//   deposit note's second arrivals; for each note found, spent when its nullifier hash is a release's. The release
//   must come after the note's leaf and withdraw at most its value and above 0: a pool cannot make any other, so any
//   other stops the restore. Its change note is value - withdrawn under change (l, j), kept when it is the release's own
//   _newCommitment. The device's own release pays W_{evm, l, j} (l the note's label, j = jOf(its ref), ./queue.ts, the
//   only W bind takes, ./evm.ts) and makes that change note. One that does not (paid another address, or made another
//   new commitment: the note's secrets used elsewhere) is the chain's truth and never hides the rest: it is listed in
//   `elsewhere`, its change note is still kept when it matches, and an address the words do not give is never listed
//   as a W nor named in a read. Then the move, return and second-arrival notes under (l, j), as on the Solana pool.
//   No refund note: a release pays W in its own transaction and uses no refund precommitment
//   (src/PrivacyPool.sol:112-138, src/PrivacyPoolSimple.sol:49-78).
// - Each spent note's W: its secret key, derived for its address, is zeroed at once. Its tokens are every contract
//   that sent it a Transfer log from its release's block on (./evm.ts evmTokensSentTo: topic 2 = W, no token named, on
//   two RPCs, paged under each provider's range and result caps, any log one RPC gives and the other lacks refused for
//   every device alike), and a buy's _token. Each read names one W and nothing else; the Ws are read in a random order,
//   never in the notes' order (./buy-wallets.ts does the same for holdings). On Base and Robinhood a W is read on the
//   helper's route only (POST /v1/rpc/{chain}, ./buy-wallets.ts evmHelperRpc, decision M359): one reader, its keyed
//   provider and its fallbacks, paced with the holdings reads, so no mainnet W is ever named to a provider the device
//   reaches itself; the route must hold the restore's anchor block first (./evm.ts evmTokensSentToOne). A W's tokens are
//   display, never a signature's input, so one reader is enough. On the testnets, which have no helper route, the
//   Transfer RPCs are their own list (EVM_TRANSFER_RPCS), read as a pair with spares (./evm.ts evmPair): a provider of
//   the pool's list is dropped from it, so no W is ever named to a provider that reads the pool, and two must be left.
//   They must be on the pool's chain and hold the restore's anchor block first.
// - Only the pool pair may refuse the whole restore. The notes never wait on a W: a W whose read fails (a lag that
//   stays, a lie, a provider's cap no page can meet, as a stranger's Transfer spam to a public W can force) is listed
//   with tokens null and its error, and a Transfer pair that fails its check (another chain, or the restore's block
//   not held) leaves every W so, with no Transfer log taken; the notes stand. A W's error keeps none of a provider's
//   words, since a provider may echo the request, and so the W: they are cut to their JSON-RPC code or HTTP status,
//   and any other the kit's client puts in its words (an error with no number code, an answer's id, a body not JSON) to
//   "the call failed", as ./buy-wallets.ts does; the device's own words are kept. A W that fails while the pool pair no
//   longer holds the restore's block is a reorg under the restore: the pool pair's lag refuses it, never the orphaned
//   block's notes with the W blamed.
// - The pool read: a lag (an RPC behind the other) is a retry, EVM_LAG_TRIES rounds at most, then refused; a lie is
//   refused at once. A newest agreed block more than an epoch behind the higher RPC's latest time is a lag: the lower
//   of two latest blocks is the anchor, so an RPC stuck behind would otherwise give an old restore as a whole one.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultLabelOf } from "@blindfill/kit";
import { CHAINS, type Chain, freshWallet, type SecondId } from "../derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, walkLane } from "../notes/restore.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "../notes/store.ts";
import { solanaSameProvider } from "@blindfill/kit";
import { evmHelperRpc } from "./buy-wallets.ts";
import { EVM_CHAIN_IDS, EVM_EPOCH_MS, EVM_LOG_PAGE_BLOCKS, EvmLagError, evmHoldsAnchor, evmLatestHigh, evmPair, evmPoolScopeOf, evmRetryLag, evmTokensSentTo, evmTokensSentToOne, evmTreeSync, type EvmPoolEvent, type EvmPoolPin, type EvmRpc, type EvmSyncHold } from "./evm.ts";
import { jOf } from "./queue.ts";

const U32 = 0xffffffff;
const CHAIN_TAGS = Object.keys(CHAINS) as Chain[];

export type EvmRestoredNote = { ref: NoteRef; scope: bigint; precommitment: bigint; leaf: Leaf; state: "UNSPENT" | "SPENT"; parent?: string };
/** A spent note of ours: its release (l, j), the W it paid (lowercase), what it withdrew, the release's block, and a
 * buy's token (lowercase; null for a withdraw). */
export type EvmRestoredSpend = { l: bigint; j: number; note: string; w: string; withdrawn: bigint; block: bigint; token: string | null };
/** A spend's W and every token it was sent from the release's block on (lowercase contracts, sorted); null with the
 * error when its reads failed. */
export type EvmRestoredWallet = { note: string; w: string; tokens: string[] | null; error?: string };
/** A spent note of ours whose release the device did not make: it paid `to` (lowercase), not the note's W, or its new
 * commitment is not the note's change note (`changeOurs` false). Data only. A list of flags, not a second debit: a
 * release to our W with a foreign change is in both spends and elsewhere (its `to` is that spends entry's `w`). */
export type EvmRestoredElsewhere = { note: string; to: string; withdrawn: bigint; block: bigint; changeOurs: boolean };

export type EvmRestoreArgs = {
  seed64: Uint8Array;
  scope: bigint;
  /** Every leaf event of the pool, in log order, as evmTreeSync's events() gives them. */
  events: readonly EvmPoolEvent[];
  /** tests only: RESTORE_GAP unless given */
  gap?: number;
};

type Deposits = { byPre: Map<bigint, { at: number; nonce: bigint }>; byNull: Map<bigint, number> };
// every event adds one state leaf (src/PrivacyPool.sol:101, 263), and each Deposited one label: its place is the index
function indexEvents(events: readonly EvmPoolEvent[]): Deposits {
  const leaves = new Set<bigint>();
  const byPre = new Map<bigint, { at: number; nonce: bigint }>();
  const byNull = new Map<bigint, number>();
  let nonce = 0n;
  events.forEach((e, at) => {
    if (leaves.has(e.state)) throw new Error(`state leaf ${at} repeats`);
    leaves.add(e.state);
    if (e.kind === "deposit") {
      nonce++;
      if (byPre.has(e.precommitment!)) throw new Error(`leaf ${at}: a precommitment deposited twice`);
      byPre.set(e.precommitment!, { at, nonce });
    } else {
      if (byNull.has(e.nullifier!)) throw new Error(`leaf ${at}: a nullifier spent twice`);
      byNull.set(e.nullifier!, at);
    }
  });
  return { byPre, byNull };
}

// the leaf of the Deposited naming P, its label and commitment checked, at the value the pool hashed; null when none
function depositLeaf(scope: bigint, events: readonly EvmPoolEvent[], ix: Deposits, P: bigint, what: string): Leaf | null {
  const d = ix.byPre.get(P);
  if (d === undefined) return null;
  const e = events[d.at]!;
  if (e.label !== vaultLabelOf(keccak_256, scope, d.nonce)) throw new Error(`deposit of ${what}: its label is not the label of nonce ${d.nonce}`);
  if (e.value === 0n || noteCommitment(e.value, e.label, P) !== e.state) throw new Error(`deposit of ${what}: its commitment is not Poseidon(value, label, precommitment)`);
  return { value: e.value, label: e.label, commitment: e.state, leafIndex: BigInt(d.at) };
}

/**
 * Empty notes in a row the U, V and R second-arrival walks read past before they stop: the address gap limit of
 * BIP-44, 20. A second arrival can be empty while a later one holds the user's deposit only through evmNextNote below,
 * which names the next note past a take whose block is not final yet; if a reorg then drops that take, its note stays
 * empty. So evmNextNote never names a note more than SECOND_GAP - 1 past the last note that is final, and those walks
 * read past up to SECOND_GAP - 1 empty notes, so a restore from the words finds every note the device signed. The A
 * walk reads past none: evmNextNote signs only on a deposit's U, a move's V and a return's R (its `id` switch), so no
 * A note is ever named past an empty one, and A stops at its first miss as on Solana (./solana-restore.ts `seconds`).
 * Solana's chains have no such gap: the page passes a taken note only once its mark is read at finalized on both RPCs
 * (signpage pool-deposit.ts and pool-sell.ts markOf), and the store plans a second arrival only once the one before it
 * has landed (../notes/store.ts addLocked).
 */
export const SECOND_GAP = 20;

export function evmRestore(a: EvmRestoreArgs): { notes: EvmRestoredNote[]; spends: EvmRestoredSpend[]; elsewhere: EvmRestoredElsewhere[] } {
  const { seed64, scope, events } = a;
  const ix = indexEvents(events);
  const { byPre, byNull } = ix;

  const notes: EvmRestoredNote[] = [];
  const spends: EvmRestoredSpend[] = [];
  const elsewhere: EvmRestoredElsewhere[] = [];
  const seen = new Set<string>();
  const put = (ref: NoteRef, precommitment: bigint, leaf: Leaf, parent?: string): void => {
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    notes.push({ ref, scope, precommitment, leaf, state: "UNSPENT", ...(parent === undefined ? {} : { parent }) });
  };
  // a note the pool holds as a deposit: its Deposited event, its label and commitment checked
  const asDeposit = (ref: NoteRef): boolean => {
    const P = noteSecrets(seed64, ref).precommitment;
    const leaf = depositLeaf(scope, events, ix, P, refKey(ref));
    if (leaf === null) return false;
    put(ref, P, leaf);
    return true;
  };
  // on U, V and R up to SECOND_GAP - 1 empty notes in a row read past (a pending take evmNextNote passed over, then
  // reorged out); A, which evmNextNote never signs on, stops at its first miss
  const seconds = (id: SecondId): void => {
    const gap = id.id === "A" ? 1 : SECOND_GAP;
    for (let n = 0, miss = 0; n <= U32 && miss < gap; n++) miss = asDeposit({ kind: "second", id, n }) ? 0 : miss + 1;
  };

  for (let lane = 0; lane < RESTORE_LANES; lane++)
    for (const i of walkLane(seed64, scope, lane, (P) => byPre.has(P), a.gap ?? RESTORE_GAP).found)
      if (!asDeposit({ kind: "deposit", s: scope, i })) throw new Error(`deposit index ${i}: the walk's precommitment is not the note's`);

  for (let k = 0; k < notes.length; k++) {
    const note = notes[k]!;
    const ref = note.ref;
    if (ref.kind === "deposit") seconds({ id: "U", s: ref.s, i: ref.i });
    const at = byNull.get(noteSecrets(seed64, ref).nullifierHash);
    if (at === undefined) continue;
    note.state = "SPENT";
    const e = events[at]!;
    const key = refKey(ref);
    const l = note.leaf.label;
    const j = jOf(ref);
    if (BigInt(at) <= note.leaf.leafIndex) throw new Error(`${key}: its release is not after its leaf`);
    if (e.value === 0n || e.value > note.leaf.value) throw new Error(`${key}: its release withdrew ${e.value} of ${note.leaf.value}`);
    const w = freshWallet(seed64, "evm", l, j);
    w.secretKey.fill(0);
    const ours = e.recipient === w.address.toLowerCase();
    const cref: NoteRef = { kind: "change", l, j };
    const cP = noteSecrets(seed64, cref).precommitment;
    const cValue = note.leaf.value - e.value;
    const cCommitment = noteCommitment(cValue, l, cP);
    const changeOurs = cCommitment === e.state;
    // only a W the words give is listed (and read); a release the device did not make is listed as such, never a refusal
    if (ours) spends.push({ l, j, note: key, w: e.recipient!, withdrawn: e.value, block: e.block, token: e.token });
    if (!ours || !changeOurs) elsewhere.push({ note: key, to: e.recipient!, withdrawn: e.value, block: e.block, changeOurs });
    if (changeOurs) put(cref, cP, { value: cValue, label: l, commitment: cCommitment, leafIndex: BigInt(at) }, key);
    asDeposit({ kind: "move", l, j });
    seconds({ id: "V", l, j });
    seconds({ id: "A", l, j });
    for (const c of CHAIN_TAGS) {
      asDeposit({ kind: "return", c, l, j });
      seconds({ id: "R", c, l, j });
    }
  }
  return { notes, spends, elsewhere };
}

/** evmNextNote's wait for finality: a take in a block not final yet stands before the note to sign. A "not now",
 * never a "no": the same request runs again once that block is final (signpage pool-kinds.ts answers it busy). */
export class EvmNotFinalError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "EvmNotFinalError";
  }
}

/**
 * A deposit or a sell whose precommitment another deposit took first (card precommit-taken-recover; pool-review-3 L-2).
 * Anyone who sees a pending deposit or W's signed Sell can deposit MIN_DEPOSIT with its precommitment and land first:
 * the pool keeps the first (contracts/pool-evm/src/PrivacyPool.sol:90-93) and the real one reverts
 * PrecommitmentAlreadyUsed, a sell whole (SellDelegate.sol: the deposit is its last step, so W keeps its token and its
 * Sell nonce). That deposit is the user's note all the same: only the seed gives the precommitment's secrets.
 *
 * The chain of notes a deposit or a sell signs on, from `first`: a deposit's U note then U's second arrivals, a sell's
 * return note (c, l, j) then R's, a move's V. Read against the pool's events as evmTreeSync's events() gives them (both
 * RPCs byte for byte, the trees checked against the pool's views), every note of the chain a Deposited already names
 * is `taken`, with its leaf at the value that deposit carried (MIN_DEPOSIT or any other), and `next` is the first one
 * none names: the one to sign. Called before each signature and again after a revert, so the device never signs a
 * precommitment the pool already holds, and a sell signed in advance whose deposit reverted is signed again on `next`.
 * Only a Deposited at or below `finalBlock` (the round's finalized anchor, evmTreeSync's `fin`) is `taken`, so a note
 * is stored only from a block that never moves; one in the tail above it is `pending`: passed over for `next`, never
 * written, and taken at a later round once its block is final (a reorg that drops it leaves the note as it was). If
 * that reorg drops it and nothing else lands on its precommitment, the chain holds an empty note before the one signed
 * next: evmRestore's second-arrival walk reads past SECOND_GAP - 1 of them, and this refuses to name a note past
 * SECOND_GAP pending takes in a row (the next round, with those blocks final, names it), so a restore from the words
 * never misses a signed note. Both waits for finality (that one, and a deposit note taken in a block not final yet)
 * throw EvmNotFinalError; every other refusal is a plain Error. The device also names that empty note as `next` at its next call, which fills the gap.
 */
export function evmNextNote(seed64: Uint8Array, scope: bigint, events: readonly EvmPoolEvent[], first: NoteRef, finalBlock: bigint): { taken: EvmRestoredNote[]; pending: NoteRef[]; next: { ref: NoteRef; precommitment: bigint } } {
  if (typeof finalBlock !== "bigint" || finalBlock < 0n) throw new Error("finalBlock: the round's finalized block number");
  if (first.kind === "deposit" && first.s !== scope) throw new Error("a deposit note's scope is its s");
  const id: SecondId =
    first.kind === "deposit" ? { id: "U", s: first.s, i: first.i }
    : first.kind === "return" ? { id: "R", c: first.c, l: first.l, j: first.j }
    : first.kind === "move" ? { id: "V", l: first.l, j: first.j }
    : (() => { throw new Error(`a deposit or a sell signs on a deposit, return or move note, not ${String(first?.kind)}`); })();
  const ix = indexEvents(events);
  const taken: EvmRestoredNote[] = [];
  const pending: NoteRef[] = [];
  let run = 0; // pending takes in a row: each may yet be dropped, an empty note before `next`
  for (let n = -1; n <= U32; n++) {
    const ref: NoteRef = n < 0 ? first : { kind: "second", id, n };
    const precommitment = noteSecrets(seed64, ref).precommitment;
    const leaf = depositLeaf(scope, events, ix, precommitment, refKey(ref));
    if (leaf === null) {
      if (run >= SECOND_GAP) throw new EvmNotFinalError(`${refKey(ref)}: ${run} pending takes in a row before it, past the restore's gap of ${SECOND_GAP}: signed once they are final`);
      return { taken, pending, next: { ref, precommitment } };
    }
    if (events[Number(leaf.leafIndex)]!.block > finalBlock) {
      // a deposit index is found by its deposit note alone (walkLane), so an empty deposit note hides its whole chain:
      // the one take never passed over while pending
      if (n < 0 && first.kind === "deposit") throw new EvmNotFinalError(`${refKey(ref)}: taken in a block not final yet; the deposit index is found by this note alone, so its chain is signed once that block is final`);
      pending.push(ref);
      run++;
    } else {
      taken.push({ ref, scope, precommitment, leaf, state: "UNSPENT" });
      run = 0;
    }
  }
  throw new Error("no second arrival left on this id");
}

/**
 * Writes evmNextNote's taken notes as the user's own, in order: one the store does not hold is added UNSPENT with its
 * leaf; one it holds PLANNED or INCOMING (a deposit or sell signed on it, which reverted or never will land) goes
 * UNSPENT with that leaf; one it holds landed is kept when its leaf is the taken one's. A held note whose precommitment
 * or scope, or a landed one whose leaf, is not the taken one's is refused. Returns the notes written, each for the proof
 * queue's next pass.
 */
export async function evmClaimTaken(store: NoteStore, taken: readonly EvmRestoredNote[]): Promise<NoteRecord[]> {
  const held = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  const out: NoteRecord[] = [];
  for (const t of taken) {
    const h = held.get(refKey(t.ref));
    if (h !== undefined && (h.precommitment !== t.precommitment || h.scope !== t.scope)) throw new Error(`${refKey(t.ref)}: the store holds another note on this ref`);
    if (h === undefined) out.push(await store.add({ ref: t.ref, scope: t.scope, precommitment: t.precommitment, state: "UNSPENT", leaf: t.leaf }));
    else if (h.state === "PLANNED" || h.state === "INCOMING") {
      const incoming = h.state === "PLANNED" ? await store.move(h.id, "PLANNED", "INCOMING") : h;
      out.push(await store.move(incoming.id, "INCOMING", "UNSPENT", { leaf: t.leaf }));
    } else if (h.leaf !== undefined && (h.leaf.commitment !== t.leaf.commitment || h.leaf.leafIndex !== t.leaf.leafIndex)) throw new Error(`${refKey(t.ref)}: the store holds this note at another leaf`);
  }
  return out;
}

/** An unread W's error: a provider's words cut to their JSON-RPC code or HTTP status; the device's own words kept. */
const cutError = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  const code = /RPC error (-?\d+)/i.exec(m)?.[1];
  if (code !== undefined) return `rpc error ${code}`;
  const http = /\bHTTP (\d{3})\b/.exec(m)?.[1];
  if (http !== undefined) return `http ${http}`;
  // the kit client's other words that carry a provider's text (solanaJsonRpc): an error with no number code or an
  // answer's id, also inside a lag's words (./evm.ts readLogs' head lag), and a body not JSON
  return e instanceof SyntaxError || /RPC error|answer id/.test(m) ? "the call failed" : m;
};

const randomIndex = (n: number): number => {
  const max = Math.floor(0x1_0000_0000 / n) * n;
  const b = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(b);
  while (b[0]! >= max);
  return b[0]! % n;
};

export type EvmRestoreNotesArgs = {
  seed64: Uint8Array;
  /** The network's pin (EVM_POOLS[network]). */
  pin: EvmPoolPin;
  /** A pinned list of two or more providers of different operators on the pool's network: the pool's events. */
  rpcs: readonly EvmRpc[];
  /** Base and Robinhood only: the helper's origin. Each W's Transfer logs on its route (POST /v1/rpc/{chain}), one
   * reader; no list may be given there. Each call names one W. */
  helper?: string;
  /** The testnets only: a pinned list of providers of different operators on the pool's network (EVM_TRANSFER_RPCS):
   * each W's Transfer logs, on those of them that are no provider of `rpcs`, two or more. Each call names one W. */
  walletRpcs?: readonly EvmRpc[];
  signal?: AbortSignal;
  /** false: the notes only. No W is read or named to any provider, `helper` and `walletRpcs` are not asked for, and
   * `wallets` comes back empty (the signing page's restore, which keeps the notes alone: pool-restore.ts). */
  wallets?: false;
  /** Where the device holds the pool's sync between syncs (evm.ts EvmSyncArgs held): a restore after it reads only the
   * blocks past it. */
  held?: EvmSyncHold;
  /** tests only: RESTORE_GAP, the wait between lag retries, and the Ws' order (a random index below n) */
  gap?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pick?: (n: number) => number;
};

/**
 * Restore of the EVM pool from the 12 words: the pool's whole set of events on two RPCs (evmTreeSync), at a newest
 * agreed block within an epoch of the higher RPC's latest time, one retry budget (EVM_LAG_TRIES); evmRestore; then
 * each spent note's W's tokens from its release's block up to that same block (on the helper's route on Base and
 * Robinhood, on the two Transfer RPCs on a testnet), each W on its own budget. A W that cannot be read is listed
 * unread; the notes never fail with it.
 */
export async function evmRestoreNotes(a: EvmRestoreNotesArgs): Promise<{ notes: EvmRestoredNote[]; spends: EvmRestoredSpend[]; elsewhere: EvmRestoredElsewhere[]; wallets: EvmRestoredWallet[]; block: bigint }> {
  const rpcs = evmPair(a.rpcs);
  const chainId = EVM_CHAIN_IDS[a.pin.network];
  if (chainId === undefined) throw new Error(`network: unknown ${String(a.pin.network)}`);
  const net = a.pin.network;
  const sleep = a.sleep;
  // the Transfer reads name Ws: on mainnet only on the helper's route, never a provider the device reaches itself; on a
  // testnet never on a provider of the pool's list
  let reads: { holds: () => Promise<unknown>; tokens: (w: string, from: bigint) => Promise<string[]>; name: string };
  if (a.wallets === false) reads = { holds: async () => {}, tokens: async () => [], name: "none" };
  else if (net === "base" || net === "robinhood") {
    if (a.walletRpcs !== undefined) throw new Error(`walletRpcs: a ${net} W is read on the helper's route only`);
    if (typeof a.helper !== "string") throw new Error(`helper: a ${net} W is read on the helper's route`);
    const reader = evmHelperRpc(a.helper, net);
    const page = [EVM_LOG_PAGE_BLOCKS];
    reads = { holds: async () => {}, tokens: (w, from) => evmTokensSentToOne(reader, w, from, r, page, a.signal, sleep), name: "the helper's route" };
  } else {
    if (a.helper !== undefined) throw new Error(`helper: ${net} has no helper route`);
    if (!Array.isArray(a.walletRpcs)) throw new Error("walletRpcs: two or more");
    const walletRpcs = evmPair(a.walletRpcs.filter((w) => !a.rpcs.some((p) => solanaSameProvider(w, p))), "walletRpcs (no provider of the pool's rpcs)");
    const page = [EVM_LOG_PAGE_BLOCKS, EVM_LOG_PAGE_BLOCKS];
    reads = { holds: () => evmHoldsAnchor(walletRpcs, chainId, r.anchor, a.signal, sleep), tokens: (w, from) => evmTokensSentTo(walletRpcs, w, from, r, page, a.signal, sleep), name: "the Transfer RPCs" };
  }
  const scope = evmPoolScopeOf(a.pin.pool, chainId);
  const sync = evmTreeSync({ rpcs, pin: a.pin, ...(a.held ? { held: a.held } : {}), ...(sleep ? { sleep } : {}) });
  const pick = a.pick ?? randomIndex;
  const r = await evmRetryLag(async () => {
    const r = await sync.events(a.signal, true);
    const high = await evmLatestHigh(rpcs, a.signal, sleep);
    if (r.anchor.timestamp * 1000n + EVM_EPOCH_MS < high) throw new EvmLagError(`the newest agreed block ${r.anchor.number} is more than an epoch behind an RPC's latest block`);
    return r;
  }, sleep, a.signal);
  const { notes, spends, elsewhere } = evmRestore({ seed64: a.seed64, scope, events: r.events, ...(a.gap === undefined ? {} : { gap: a.gap }) });
  if (a.wallets === false) return { notes, spends, elsewhere, wallets: [], block: r.anchor.number };
  const order = spends.map((_, k) => k);
  for (let i = order.length - 1; i > 0; i--) {
    const x = pick(i + 1);
    if (!Number.isInteger(x) || x < 0 || x > i) throw new Error("pick: not an index");
    [order[i], order[x]] = [order[x]!, order[i]!];
  }
  const wallets: EvmRestoredWallet[] = spends.map((s) => ({ note: s.note, w: s.w, tokens: null }));
  // a W read that fails while the pool pair no longer holds the anchor: a reorg under the restore, the pool pair's lag
  const poolHolds = () => evmHoldsAnchor(rpcs, chainId, r.anchor, a.signal, sleep);
  // the Transfer RPCs on the pool's chain and at the restore's block before any W is named to them; a pair that fails
  // leaves every W unread with its error, never the notes
  let pairError: string | null = null;
  if (order.length > 0) {
    try {
      await evmRetryLag(reads.holds, sleep, a.signal);
    } catch (e) {
      a.signal?.throwIfAborted();
      await poolHolds();
      pairError = `${reads.name}: ${cutError(e)}`;
    }
  }
  for (const k of order) {
    const s = spends[k]!;
    if (pairError !== null) {
      wallets[k]!.error = pairError;
      continue;
    }
    try {
      const tokens = await evmRetryLag(() => reads.tokens(s.w, s.block), sleep, a.signal);
      wallets[k]!.tokens = s.token === null || tokens.includes(s.token) ? tokens : [...tokens, s.token].sort();
    } catch (e) {
      a.signal?.throwIfAborted();
      await poolHolds();
      wallets[k]!.error = cutError(e);
    }
  }
  return { notes, spends, elsewhere, wallets, block: r.anchor.number };
}
