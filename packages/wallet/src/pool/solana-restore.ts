// Restore of the Solana pool's notes from the 12 words (card notes-per-pool-sol; ../notes/restore.ts is the NEAR
// vault's, whose walk and follow rules this keeps).
//
// - No request names a note or a wallet of the user's. The program's marks are its only accounts of 8 and 16 bytes
//   (src/state.rs, M353, M355 (3)): a spent mark ["spent", nullifierHash] records the release's withdrawnValue u64 LE,
//   and a precommitment mark ["pre", precommitment] its deposit, value u64 LE then the nonce u64 LE its label hashes.
//   Two getProgramAccounts reads (dataSize 8 and dataSize 16, withContext) on each of two RPCs return every mark of
//   every user. The marks are the union of the two RPCs' (M355 (4)): two honest RPCs at different finalized slots differ
//   by the marks between them, and an RPC cannot invent a mark of ours, since a note's nullifier hash and precommitment
//   stay secret until used; a key both hold with different bytes stops the restore. Then the pages, on both RPCs at or
//   past the higher of the marks' slots (./solana.ts solanaTreeSync leaves), so every deposit and release a mark
//   records has its leaves in them. The device derives its own marks' addresses and looks them up
//   here; a read per mark (a note's own address) would tell the RPC which notes are one user's, so none is made.
// - A mark that lands while the pages are read (card sol-restore-race, review N1): straight after the pages, before any
//   walk, the marks are read again on each RPC at or past the highest slot that RPC answered its pages at
//   (minContextSlot, and the answer's own slot checked), and merged into the first read by the same union rule. A spend
//   or deposit whose leaves are in the pages has its mark in that read.
// - Rounds by a public rule first: while a read gives a mark the read before did not, the pages are read again past the
//   merged marks, then the marks; the walk runs once, when two reads in a row give the same union. Which marks are new
//   never changes these reads, so an RPC cannot tell whether a mark that landed during the restore is the user's.
// - Only after SOL_RESTORE_QUIET_ROUNDS such rounds in a row with new marks (a pool busy for the whole time, each round
//   a pages read and a marks read, about a second or two) does the restore walk and stop at the first read whose new
//   marks the walk never looked up: they change nothing it found. By then the RPC sees one of every mark of that busy
//   window, not one mark. 8 rounds: a pool with a landing every few seconds settles in two or three rounds, and only a
//   pool busy at every read for 10 to 20 s reaches the fallback. While the walk's own looked-up marks still grow, it
//   walks again, SOL_RESTORE_ROUNDS times at most, then stops with a refusal, never a loop without end.
// - A deposit from its mark: label = keccak256(scope ‖ nonce) mod p, which must be the label tree's leaf nonce - 1, and
//   commitment = Poseidon(value, label, precommitment), which must be a leaf of the state tree; else the restore stops.
// - The walk: deposit indices lane by lane until RESTORE_GAP misses in a row (../notes/restore.ts walkLane), each
//   deposit note's second arrivals; for each note found, spent when its spent mark is in the set. Its change note is
//   value - withdrawnValue (the spent mark's) under change (l, j), for any withdrawal amount, and must be a leaf of the
//   state tree; a withdrawal over the note's value or a change not in the tree is a drift and stops the restore. Then the
//   move, return and second-arrival notes the release's W brought back, as on the NEAR vault. No refund note: a Solana
//   release pays W in its own transaction.
// - Each spent note's W is W_{sol, l, j}: its address is returned and its secret key, derived for it, is zeroed at once.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultLabelOf, type SolanaRpc } from "@blindfill/kit";
import { CHAINS, type Chain, freshWallet, type SecondId } from "../derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, walkLane } from "../notes/restore.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "../notes/store.ts";
import { checkSolanaRpcs, type SolanaLagWait, solanaLagRetry, solanaPda, solanaPoolOf, solanaTreeSync } from "./solana.ts";

const U32 = 0xffffffff;
const CHAIN_TAGS = Object.keys(CHAINS) as Chain[];
const enc = new TextEncoder();
const be32 = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};

/** A mark's address: ["spent", nullifierHash] or ["pre", precommitment], both 32 bytes big-endian. */
export function solanaMarkOf(program: string, seed: "spent" | "pre", key: bigint): string {
  return base58.encode(solanaPda([enc.encode(seed), be32(key)], base58.decode(program)).address);
}

/** A deposit as its precommitment mark records it. */
export type SolanaDepositMark = { value: bigint; nonce: bigint };
/** Every mark of the pool: each spent mark's address with its withdrawnValue, each precommitment mark's with its record. */
export type SolanaMarks = { spent: ReadonlyMap<string, bigint>; pre: ReadonlyMap<string, SolanaDepositMark>; slot: number };

export const SOL_SPENT_MARK_LEN = 8;
export const SOL_PRE_MARK_LEN = 16;

/**
 * Every mark of the pool, the union of two RPCs' whole-set reads; a key both hold with different bytes is refused.
 * minSlots: RPC k answers at or past minSlots[k] (minContextSlot), and an answer below it is refused. lagWait: tests only.
 */
export async function solanaMarks(rpcs: readonly [SolanaRpc, SolanaRpc], program: string, signal?: AbortSignal, minSlots?: readonly [number, number], lagWait?: SolanaLagWait): Promise<SolanaMarks> {
  checkSolanaRpcs(rpcs);
  if (minSlots !== undefined && !(Array.isArray(minSlots) && minSlots.length === 2 && minSlots.every((x) => Number.isSafeInteger(x) && x >= 0))) throw new Error("minSlots: two slots");
  const read = async (rpc: SolanaRpc, k: number, size: number): Promise<{ marks: Map<string, string>; slot: number }> => {
    const min = minSlots?.[k] ?? 0;
    const a = (await solanaLagRetry(() => rpc("getProgramAccounts", [program, { commitment: "finalized", encoding: "base64", withContext: true, ...(min > 0 ? { minContextSlot: min } : {}), filters: [{ dataSize: size }] }]), lagWait)) as { context?: { slot?: unknown }; value?: unknown };
    const slot = a?.context?.slot;
    if (!Number.isSafeInteger(slot) || (slot as number) < 0 || !Array.isArray(a.value)) throw new Error(`rpc ${k}: getProgramAccounts: not a list with its context`);
    if ((slot as number) < min) throw new Error(`rpc ${k}: getProgramAccounts: answered at slot ${slot as number}, below ${min}`);
    const m = new Map<string, string>();
    for (const x of a.value as { pubkey?: unknown; account?: { owner?: unknown; data?: unknown } }[]) {
      const d = x?.account?.data;
      if (typeof x?.pubkey !== "string" || x.account?.owner !== program || !Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new Error(`rpc ${k}: getProgramAccounts: not the program's account`);
      if (m.has(x.pubkey)) throw new Error(`rpc ${k}: getProgramAccounts: an account twice`);
      if (base64.decode(d[0]).length !== size) throw new Error(`rpc ${k}: mark ${x.pubkey}: not ${size} bytes`);
      m.set(x.pubkey, d[0]);
    }
    return { marks: m, slot: slot as number };
  };
  signal?.throwIfAborted();
  const reads = await Promise.all(rpcs.map(async (rpc, k) => [await read(rpc, k, SOL_SPENT_MARK_LEN), await read(rpc, k, SOL_PRE_MARK_LEN)] as const));
  signal?.throwIfAborted();
  const union = (i: 0 | 1): Map<string, Uint8Array> => {
    const out = new Map<string, string>(reads[0]![i].marks);
    for (const [key, d] of reads[1]![i].marks) {
      const have = out.get(key);
      if (have !== undefined && have !== d) throw new Error(`mark ${key}: the two RPCs' bytes differ`);
      out.set(key, d);
    }
    return new Map([...out].map(([key, d]) => [key, base64.decode(d)]));
  };
  const u64 = (d: Uint8Array, at: number): bigint => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(at, true);
  const spent = new Map([...union(0)].map(([key, d]) => [key, u64(d, 0)] as const));
  const pre = new Map([...union(1)].map(([key, d]) => [key, { value: u64(d, 0), nonce: u64(d, 8) }] as const));
  const slot = Math.max(...reads.flatMap((r) => [r[0].slot, r[1].slot]));
  return { spent, pre, slot };
}

export type SolanaRestoredNote = { ref: NoteRef; scope: bigint; precommitment: bigint; leaf: Leaf; state: "UNSPENT" | "SPENT"; parent?: string };
/** A spent note of ours: its release (l, j), the W it paid and the chunk. */
export type SolanaRestoredSpend = { l: bigint; j: number; note: string; w: string; withdrawn: bigint };

// A spent note's change note: value - withdrawnValue (its spent mark's) under change (l, j), j the spend's change index,
// which must be a leaf of the state tree; a withdrawal of 0 or over the note's value, or a change not in the tree, is a
// drift and stops. The one rule for the walk and for a send refused as already spent.
function spentChange(seed64: Uint8Array, ref: NoteRef, leaf: Leaf, withdrawn: bigint, leafAt: ReadonlyMap<bigint, number>): { ref: NoteRef & { kind: "change" }; precommitment: bigint; leaf: Leaf } {
  const l = leaf.label;
  const j = ref.kind === "change" ? ref.j + 1 : 0;
  if (j > U32) throw new Error("change index out of range");
  const key = refKey(ref);
  if (withdrawn === 0n || withdrawn > leaf.value) throw new Error(`${key}: its spent mark withdrew ${withdrawn} of ${leaf.value}`);
  const cref = { kind: "change", l, j } as const;
  const cP = noteSecrets(seed64, cref).precommitment;
  const cValue = leaf.value - withdrawn;
  const cCommitment = noteCommitment(cValue, l, cP);
  const cAt = leafAt.get(cCommitment);
  if (cAt === undefined) throw new Error(`${key}: spent, but its change note (l ${l}, j ${j}) is not in the state tree`);
  return { ref: cref, precommitment: cP, leaf: { value: cValue, label: l, commitment: cCommitment, leafIndex: BigInt(cAt) } };
}

export type SolanaRestoreArgs = {
  seed64: Uint8Array;
  program: string;
  scope: bigint;
  /** The whole state tree's leaves and the label tree's, read after the marks (./solana.ts solanaTreeSync leaves). */
  stateLeaves: readonly bigint[];
  labelLeaves: readonly bigint[];
  marks: SolanaMarks;
  /** tests only: RESTORE_GAP unless given */
  gap?: number;
};

export function solanaRestore(a: SolanaRestoreArgs): { notes: SolanaRestoredNote[]; spends: SolanaRestoredSpend[] } {
  const { seed64, program, scope, marks } = a;
  const leafAt = new Map<bigint, number>();
  a.stateLeaves.forEach((c, k) => {
    if (leafAt.has(c)) throw new Error(`state leaf ${k} repeats`);
    leafAt.set(c, k);
  });
  const markOf = (P: bigint): SolanaDepositMark | undefined => marks.pre.get(solanaMarkOf(program, "pre", P));

  const notes: SolanaRestoredNote[] = [];
  const spends: SolanaRestoredSpend[] = [];
  const seen = new Set<string>();
  const put = (ref: NoteRef, precommitment: bigint, leaf: Leaf, parent?: string): void => {
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    notes.push({ ref, scope, precommitment, leaf, state: "UNSPENT", ...(parent === undefined ? {} : { parent }) });
  };
  // a note the pool holds as a deposit: its precommitment mark's record, checked against both trees
  const asDeposit = (ref: NoteRef): boolean => {
    const P = noteSecrets(seed64, ref).precommitment;
    const m = markOf(P);
    if (m === undefined) return false;
    if (m.value === 0n || m.nonce === 0n || m.nonce > BigInt(a.labelLeaves.length)) throw new Error(`deposit of ${refKey(ref)}: its mark's nonce ${m.nonce} is not a label tree leaf`);
    const label = vaultLabelOf(keccak_256, scope, m.nonce);
    if (a.labelLeaves[Number(m.nonce - 1n)] !== label) throw new Error(`deposit of ${refKey(ref)}: its label is not the label tree's leaf ${m.nonce - 1n}`);
    const commitment = noteCommitment(m.value, label, P);
    const at = leafAt.get(commitment);
    if (at === undefined) throw new Error(`deposit of ${refKey(ref)}: its commitment is not in the state tree`);
    put(ref, P, { value: m.value, label, commitment, leafIndex: BigInt(at) });
    return true;
  };
  const seconds = (id: SecondId): void => {
    for (let n = 0; n <= U32 && asDeposit({ kind: "second", id, n }); n++);
  };

  for (let lane = 0; lane < RESTORE_LANES; lane++)
    for (const i of walkLane(seed64, scope, lane, (P) => markOf(P) !== undefined, a.gap ?? RESTORE_GAP).found)
      if (!asDeposit({ kind: "deposit", s: scope, i })) throw new Error(`deposit index ${i}: the walk's precommitment is not the note's`);

  for (let k = 0; k < notes.length; k++) {
    const note = notes[k]!;
    const ref = note.ref;
    if (ref.kind === "deposit") seconds({ id: "U", s: ref.s, i: ref.i });
    const withdrawn = marks.spent.get(solanaMarkOf(program, "spent", noteSecrets(seed64, ref).nullifierHash));
    if (withdrawn === undefined) continue;
    note.state = "SPENT";
    const l = note.leaf.label;
    const key = refKey(ref);
    const c = spentChange(seed64, ref, note.leaf, withdrawn, leafAt);
    const j = c.ref.j;
    const w = freshWallet(seed64, "sol", l, j);
    w.secretKey.fill(0);
    spends.push({ l, j, note: key, w: w.address, withdrawn });
    put(c.ref, c.precommitment, c.leaf, key);
    asDeposit({ kind: "move", l, j });
    seconds({ id: "V", l, j });
    seconds({ id: "A", l, j });
    for (const c of CHAIN_TAGS) {
      asDeposit({ kind: "return", c, l, j });
      seconds({ id: "R", c, l, j });
    }
  }
  return { notes, spends };
}

/** Rounds that only read (pages, then marks) while the pool keeps growing, before the walk's own marks decide (header). */
export const SOL_RESTORE_QUIET_ROUNDS = 8;
/** Walks past the quiet rounds whose looked-up marks may still grow before the restore refuses: each extra one needs a
 * spend or deposit of the user's own to land during the read before it. */
export const SOL_RESTORE_ROUNDS = 4;

/** Two reads of the marks as one: the union, a key both hold with different values refused, the higher slot. */
export function solanaMarksUnion(x: SolanaMarks, y: SolanaMarks): SolanaMarks {
  const spent = new Map(x.spent);
  for (const [key, w] of y.spent) {
    const have = spent.get(key);
    if (have !== undefined && have !== w) throw new Error(`mark ${key}: two reads differ`);
    spent.set(key, w);
  }
  const pre = new Map(x.pre);
  for (const [key, m] of y.pre) {
    const have = pre.get(key);
    if (have !== undefined && (have.value !== m.value || have.nonce !== m.nonce)) throw new Error(`mark ${key}: two reads differ`);
    pre.set(key, m);
  }
  return { spent, pre, slot: Math.max(x.slot, y.slot) };
}

// A map that records every key looked up in it: the marks a walk asked for.
class Looked<V> extends Map<string, V> {
  readonly asked: Set<string>;
  constructor(m: ReadonlyMap<string, V>, asked: Set<string>) {
    super(m);
    this.asked = asked;
  }
  override get(key: string): V | undefined {
    this.asked.add(key);
    return super.get(key);
  }
  override has(key: string): boolean {
    this.asked.add(key);
    return super.has(key);
  }
}

/**
 * Restore of the Solana pool from the 12 words, on two RPCs: the marks, then rounds of the pages and the marks again past
 * them until two marks reads agree (bounded, header), then solanaRestore once on the last marks and pages.
 */
export async function solanaRestoreNotes(a: { seed64: Uint8Array; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; signal?: AbortSignal; gap?: number; /** tests only */ lagWait?: SolanaLagWait }) {
  const sync = solanaTreeSync(a.rpcs, a.program, a.lagWait);
  const scope = solanaPoolOf(a.program).scope;
  let marks = await solanaMarks(a.rpcs, a.program, a.signal, undefined, a.lagWait);
  for (let round = 1, walks = 0; ; round++) {
    const leaves = await sync.leaves(marks.slot, a.signal);
    const again = solanaMarksUnion(marks, await solanaMarks(a.rpcs, a.program, a.signal, leaves.slots, a.lagWait));
    const fresh = [...again.spent.keys(), ...again.pre.keys()].filter((key) => !marks.spent.has(key) && !marks.pre.has(key));
    if (fresh.length > 0 && round <= SOL_RESTORE_QUIET_ROUNDS) {
      marks = again;
      continue;
    }
    const asked = new Set<string>();
    const seen: SolanaMarks = { spent: new Looked(marks.spent, asked), pre: new Looked(marks.pre, asked), slot: marks.slot };
    const out = solanaRestore({ seed64: a.seed64, program: a.program, scope, stateLeaves: leaves.state, labelLeaves: leaves.label, marks: seen, ...(a.gap === undefined ? {} : { gap: a.gap }) });
    if (!fresh.some((key) => asked.has(key))) return out;
    if (++walks >= SOL_RESTORE_ROUNDS) throw new Error(`restore: the user's own marks still grew after ${SOL_RESTORE_ROUNDS} reads; try again`);
    marks = again;
  }
}

/** What a refused send's settle found: the note's spend on chain (its change written, the note SPENT), or none. */
export type SolanaSettled = { kind: "spent"; change: NoteRecord; withdrawn: bigint } | { kind: "unspent" };

/**
 * The one place a Solana pool send the chain refused as already spent (the pool's NullifierAlreadySpent, error 16: the
 * note's spent mark exists) is settled, by whatever sends a release. Never on the refusal's word: the helper, the
 * simulation and the send are hostile input, and the nullifier hash is no longer secret once the send has left. The
 * marks are read whole on two RPCs (the union, as a restore reads them: no read names the note), then the pages past
 * them. Only when the note's spent mark is there and its change note (spentChange: value - withdrawnValue under change
 * (l, j)) is a leaf both RPCs agree on is the change written UNSPENT through the store's add(child, parent), which moves
 * the note to SPENT, so the queue never offers it again. No spent mark: nothing is written ("unspent"). A spent mark
 * whose change is not in the state tree: a refusal, nothing written. A change another tab wrote first, with this leaf,
 * is taken. The marks and the pages are read whether or not the mark is there, so the reads look the same either way.
 * The sender treats "unspent" as: the note stays RESERVED and the settle is tried again later (the marks are read at
 * finalized, so a spend that just landed shows up a few seconds on), until the store's deadline rule frees it.
 */
export async function solanaSettleSpent(a: { seed64: Uint8Array; notes: NoteStore; noteId: string; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; signal?: AbortSignal; /** tests only */ lagWait?: SolanaLagWait }): Promise<SolanaSettled> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  const scope = solanaPoolOf(a.program).scope;
  const note = await a.notes.get(a.noteId);
  if (note === undefined || note.leaf === undefined || note.scope !== scope) throw new Error(`note ${a.noteId}: not a landed note of this pool`);
  const marks = await solanaMarks(a.rpcs, a.program, a.signal, undefined, a.lagWait);
  const leaves = await solanaTreeSync(a.rpcs, a.program, a.lagWait).leaves(marks.slot, a.signal);
  const withdrawn = marks.spent.get(solanaMarkOf(a.program, "spent", noteSecrets(a.seed64, note.ref).nullifierHash));
  if (withdrawn === undefined) return { kind: "unspent" };
  const leafAt = new Map<bigint, number>();
  leaves.state.forEach((c, k) => {
    if (leafAt.has(c)) throw new Error(`state leaf ${k} repeats`);
    leafAt.set(c, k);
  });
  const c = spentChange(a.seed64, note.ref, note.leaf, withdrawn, leafAt);
  try {
    return { kind: "spent", change: await a.notes.add({ ref: c.ref, scope, precommitment: c.precommitment, state: "UNSPENT", parent: note.id, leaf: c.leaf }), withdrawn };
  } catch (e) {
    const there = (await a.notes.list()).find((n) => n.scope === scope && refKey(n.ref) === refKey(c.ref));
    if (there !== undefined && there.precommitment === c.precommitment && there.leaf?.commitment === c.leaf.commitment && there.leaf.leafIndex === c.leaf.leafIndex) return { kind: "spent", change: there, withdrawn };
    throw e;
  }
}
