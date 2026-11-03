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
//   never in the notes' order (./buy-wallets.ts does the same for holdings). The Transfer RPCs are their own pair, no
//   provider of the pool's pair, and must be on the pool's chain and hold the restore's anchor block first.
// - The notes never wait on a W: a W whose read fails (a lag that stays, a lie, a provider's cap no page can meet, as a
//   stranger's Transfer spam to a public W can force) is listed with tokens null and its error; the notes stand.
// - The pool read: a lag (an RPC behind the other) is a retry, EVM_LAG_TRIES rounds at most, then refused; a lie is
//   refused at once. A newest agreed block more than an epoch behind the higher RPC's latest time is a lag: the lower
//   of two latest blocks is the anchor, so an RPC stuck behind would otherwise give an old restore as a whole one.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultLabelOf } from "@blindfill/kit";
import { CHAINS, type Chain, freshWallet, type SecondId } from "../derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, walkLane } from "../notes/restore.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type Leaf } from "../notes/store.ts";
import { solanaSameProvider } from "@blindfill/kit";
import { checkEvmRpcs, EVM_CHAIN_IDS, EVM_EPOCH_MS, EVM_LOG_PAGE_BLOCKS, EvmLagError, evmHoldsAnchor, evmLatestHigh, evmPoolScopeOf, evmRetryLag, evmTokensSentTo, evmTreeSync, type EvmPoolEvent, type EvmPoolPin, type EvmRpc } from "./evm.ts";
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
 * commitment is not the note's change note (`changeOurs` false). Data only. */
export type EvmRestoredElsewhere = { note: string; to: string; withdrawn: bigint; block: bigint; changeOurs: boolean };

export type EvmRestoreArgs = {
  seed64: Uint8Array;
  scope: bigint;
  /** Every leaf event of the pool, in log order, as evmTreeSync's events() gives them. */
  events: readonly EvmPoolEvent[];
  /** tests only: RESTORE_GAP unless given */
  gap?: number;
};

export function evmRestore(a: EvmRestoreArgs): { notes: EvmRestoredNote[]; spends: EvmRestoredSpend[]; elsewhere: EvmRestoredElsewhere[] } {
  const { seed64, scope, events } = a;
  // every event adds one state leaf (src/PrivacyPool.sol:101, 263), and each Deposited one label: its place is the index
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
    const d = byPre.get(P);
    if (d === undefined) return false;
    const e = events[d.at]!;
    if (e.label !== vaultLabelOf(keccak_256, scope, d.nonce)) throw new Error(`deposit of ${refKey(ref)}: its label is not the label of nonce ${d.nonce}`);
    if (e.value === 0n || noteCommitment(e.value, e.label, P) !== e.state) throw new Error(`deposit of ${refKey(ref)}: its commitment is not Poseidon(value, label, precommitment)`);
    put(ref, P, { value: e.value, label: e.label, commitment: e.state, leafIndex: BigInt(d.at) });
    return true;
  };
  const seconds = (id: SecondId): void => {
    for (let n = 0; n <= U32 && asDeposit({ kind: "second", id, n }); n++);
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
  /** Two RPCs of different operators on the pool's network: the pool's events. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** Two RPCs of different operators on the pool's network: each W's Transfer logs. Each call names one W. */
  walletRpcs: readonly [EvmRpc, EvmRpc];
  signal?: AbortSignal;
  /** tests only: RESTORE_GAP, the wait between lag retries, and the Ws' order (a random index below n) */
  gap?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pick?: (n: number) => number;
};

/**
 * Restore of the EVM pool from the 12 words: the pool's whole set of events on two RPCs (evmTreeSync), at a newest
 * agreed block within an epoch of the higher RPC's latest time, one retry budget (EVM_LAG_TRIES); evmRestore; then
 * each spent note's W's tokens on the two Transfer RPCs from its release's block up to that same block, each W on its
 * own budget. A W that cannot be read is listed unread; the notes never fail with it.
 */
export async function evmRestoreNotes(a: EvmRestoreNotesArgs): Promise<{ notes: EvmRestoredNote[]; spends: EvmRestoredSpend[]; elsewhere: EvmRestoredElsewhere[]; wallets: EvmRestoredWallet[]; block: bigint }> {
  checkEvmRpcs(a.rpcs);
  checkEvmRpcs(a.walletRpcs);
  for (const w of a.walletRpcs) for (const p of a.rpcs) if (solanaSameProvider(w, p)) throw new Error("walletRpcs: a provider of the pool's rpcs; the Transfer reads name Ws and go to their own pair");
  const chainId = EVM_CHAIN_IDS[a.pin.network];
  if (chainId === undefined) throw new Error(`network: unknown ${String(a.pin.network)}`);
  const scope = evmPoolScopeOf(a.pin.pool, chainId);
  const sleep = a.sleep;
  const sync = evmTreeSync({ rpcs: a.rpcs, pin: a.pin, ...(sleep ? { sleep } : {}) });
  const pick = a.pick ?? randomIndex;
  const page = [EVM_LOG_PAGE_BLOCKS, EVM_LOG_PAGE_BLOCKS];
  const r = await evmRetryLag(async () => {
    const r = await sync.events(a.signal, true);
    const high = await evmLatestHigh(a.rpcs, a.signal);
    if (r.anchor.timestamp * 1000n + EVM_EPOCH_MS < high) throw new EvmLagError(`the newest agreed block ${r.anchor.number} is more than an epoch behind an RPC's latest block`);
    return r;
  }, sleep, a.signal);
  const { notes, spends, elsewhere } = evmRestore({ seed64: a.seed64, scope, events: r.events, ...(a.gap === undefined ? {} : { gap: a.gap }) });
  const order = spends.map((_, k) => k);
  for (let i = order.length - 1; i > 0; i--) {
    const x = pick(i + 1);
    if (!Number.isInteger(x) || x < 0 || x > i) throw new Error("pick: not an index");
    [order[i], order[x]] = [order[x]!, order[i]!];
  }
  const wallets: EvmRestoredWallet[] = spends.map((s) => ({ note: s.note, w: s.w, tokens: null }));
  // the Transfer RPCs on the pool's chain and at the restore's block before any W is named to them
  if (order.length > 0) await evmRetryLag(() => evmHoldsAnchor(a.walletRpcs, chainId, r.anchor, a.signal), sleep, a.signal);
  for (const k of order) {
    const s = spends[k]!;
    try {
      const tokens = await evmRetryLag(() => evmTokensSentTo(a.walletRpcs, s.w, s.block, r, page, a.signal), sleep, a.signal);
      wallets[k]!.tokens = s.token === null || tokens.includes(s.token) ? tokens : [...tokens, s.token].sort();
    } catch (e) {
      a.signal?.throwIfAborted();
      wallets[k]!.error = e instanceof Error ? e.message : String(e);
    }
  }
  return { notes, spends, elsewhere, wallets, block: r.anchor.number };
}
