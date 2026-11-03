// Restore of the Solana pool's notes from the 12 words (card notes-per-pool-sol; ../notes/restore.ts is the NEAR
// vault's, whose walk and follow rules this keeps).
//
// - No request names a note or a wallet of the user's. The program's marks are its only accounts of 12 and 16 bytes
//   (src/state.rs, M353, M355 (3), M376): a spent mark ["spent", nullifierHash] records the release's withdrawnValue
//   u64 LE then the release's number u32 LE, and a precommitment mark ["pre", precommitment] its deposit, value u64 LE
//   then the nonce u64 LE its label hashes.
//   Two getProgramAccounts reads (dataSize 12 and dataSize 16, withContext) on each of two RPCs return every mark of
//   every user. The marks are the union of the two RPCs' (M355 (4)): two honest RPCs at different finalized slots differ
//   by the marks between them, and an RPC cannot invent a mark of ours, since a note's nullifier hash and precommitment
//   stay secret until used; a key both hold with different bytes stops the restore. Then the pages, on both RPCs at or
//   past the higher of the marks' slots (./solana.ts solanaTreeSync leaves), so every deposit and release a mark
//   records has its leaves in them. The device derives its own marks' addresses and looks them up
//   here; a read per mark (a note's own address) would tell the RPC which notes are one user's, so none is made.
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
import { SOLANA_POOL_SPENT_MARK_LEN, vaultLabelOf, type SolanaRpc } from "@blindfill/kit";
import { CHAINS, type Chain, freshWallet, type SecondId } from "../derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, walkLane } from "../notes/restore.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type Leaf } from "../notes/store.ts";
import { checkSolanaRpcs, solanaPda, solanaPoolOf, solanaTreeSync } from "./solana.ts";

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

/** The kit's one definition of the spent mark's length (src/state.rs SPENT_MARK_LEN). */
export const SOL_SPENT_MARK_LEN = SOLANA_POOL_SPENT_MARK_LEN;
export const SOL_PRE_MARK_LEN = 16;

/** Every mark of the pool, the union of two RPCs' whole-set reads; a key both hold with different bytes is refused. */
export async function solanaMarks(rpcs: readonly [SolanaRpc, SolanaRpc], program: string, signal?: AbortSignal): Promise<SolanaMarks> {
  checkSolanaRpcs(rpcs);
  const read = async (rpc: SolanaRpc, k: number, size: number): Promise<{ marks: Map<string, string>; slot: number }> => {
    const a = (await rpc("getProgramAccounts", [program, { commitment: "finalized", encoding: "base64", withContext: true, filters: [{ dataSize: size }] }])) as { context?: { slot?: unknown }; value?: unknown };
    const slot = a?.context?.slot;
    if (!Number.isSafeInteger(slot) || (slot as number) < 0 || !Array.isArray(a.value)) throw new Error(`rpc ${k}: getProgramAccounts: not a list with its context`);
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
    const j = ref.kind === "change" ? ref.j + 1 : 0;
    if (j > U32) throw new Error("change index out of range");
    const key = refKey(ref);
    if (withdrawn === 0n || withdrawn > note.leaf.value) throw new Error(`${key}: its spent mark withdrew ${withdrawn} of ${note.leaf.value}`);
    const w = freshWallet(seed64, "sol", l, j);
    w.secretKey.fill(0);
    spends.push({ l, j, note: key, w: w.address, withdrawn });
    const cref: NoteRef = { kind: "change", l, j };
    const cP = noteSecrets(seed64, cref).precommitment;
    const cValue = note.leaf.value - withdrawn;
    const cCommitment = noteCommitment(cValue, l, cP);
    const cAt = leafAt.get(cCommitment);
    if (cAt === undefined) throw new Error(`${key}: spent, but its change note (l ${l}, j ${j}) is not in the state tree`);
    put(cref, cP, { value: cValue, label: l, commitment: cCommitment, leafIndex: BigInt(cAt) }, key);
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

/** Restore of the Solana pool from the 12 words: the marks, then the pages, on two RPCs; then solanaRestore. */
export async function solanaRestoreNotes(a: { seed64: Uint8Array; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; signal?: AbortSignal; gap?: number }) {
  const marks = await solanaMarks(a.rpcs, a.program, a.signal);
  const leaves = await solanaTreeSync(a.rpcs, a.program).leaves(marks.slot, a.signal);
  return solanaRestore({ seed64: a.seed64, program: a.program, scope: solanaPoolOf(a.program).scope, stateLeaves: leaves.state, labelLeaves: leaves.label, marks, ...(a.gap === undefined ? {} : { gap: a.gap }) });
}
