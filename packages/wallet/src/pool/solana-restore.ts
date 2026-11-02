// Restore of the Solana pool's notes from the 12 words (card notes-per-pool-sol; ../notes/restore.ts is the NEAR
// vault's, whose walk and follow rules this keeps).
//
// - No request names a note or a wallet of the user's. The program's marks are its only accounts of 0 and 16 bytes
//   (src/state.rs, M353): a spent mark ["spent", nullifierHash] is empty, and a precommitment mark ["pre",
//   precommitment] holds its deposit, value u64 LE then the nonce u64 LE its label hashes. Two getProgramAccounts reads
//   (dataSize 0 and dataSize 16) on each of two RPCs return every mark of every user; the two RPCs must give the same
//   marks, byte for byte. Then the pages, read after the marks, on the same two RPCs (./solana.ts solanaTreeSync), so
//   every deposit a mark records has its leaves in them. The device derives its own marks' addresses and looks them up
//   here; a read per mark (a note's own address) would tell the RPC which notes are one user's, so none is made.
// - A deposit from its mark: label = keccak256(scope ‖ nonce) mod p, which must be the label tree's leaf nonce - 1, and
//   commitment = Poseidon(value, label, precommitment), which must be a leaf of the state tree; else the restore stops.
// - The walk: deposit indices lane by lane until RESTORE_GAP misses in a row (../notes/restore.ts walkLane), each
//   deposit note's second arrivals; for each note found, spent when its spent mark is in the set. A spent note's
//   release withdrew its chunk (chunkOf: the queue releases exactly one rung, ./queue.ts), so its change note is
//   value - chunk under change (l, j), which must be a leaf of the state tree (a drift stops the restore). Then the
//   move, return and second-arrival notes the release's W brought back, as on the NEAR vault. No refund note: a Solana
//   release pays W in its own transaction.
// - Each spent note's W is W_{sol, l, j}: its address is returned, the key stays derivable from the words alone.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultLabelOf, type SolanaRpc } from "@blindfill/kit";
import { CHAINS, type Chain, freshWallet, type SecondId } from "../derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, walkLane } from "../notes/restore.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type Leaf } from "../notes/store.ts";
import { chunkOf, type Ladder } from "./ladder.ts";
import { solanaPda, solanaPoolOf, solanaTreeSync, SOL_LADDER } from "./solana.ts";

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
/** Every mark of the pool: the spent marks' addresses, and each precommitment mark's address with its record. */
export type SolanaMarks = { spent: ReadonlySet<string>; pre: ReadonlyMap<string, SolanaDepositMark> };

const PRE_MARK_LEN = 16;

/** Every mark of the pool, read whole on two RPCs that must give the same marks, byte for byte. */
export async function solanaMarks(rpcs: readonly [SolanaRpc, SolanaRpc], program: string, signal?: AbortSignal): Promise<SolanaMarks> {
  const read = async (rpc: SolanaRpc, k: number, size: number): Promise<Map<string, string>> => {
    const cfg = { commitment: "finalized", encoding: "base64", ...(size === 0 ? { dataSlice: { offset: 0, length: 0 } } : {}), filters: [{ dataSize: size }] };
    const a = await rpc("getProgramAccounts", [program, cfg]);
    if (!Array.isArray(a)) throw new Error(`rpc ${k}: getProgramAccounts: not a list`);
    const m = new Map<string, string>();
    for (const x of a as { pubkey?: unknown; account?: { owner?: unknown; data?: unknown } }[]) {
      const d = x?.account?.data;
      if (typeof x?.pubkey !== "string" || x.account?.owner !== program || !Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new Error(`rpc ${k}: getProgramAccounts: not the program's account`);
      if (m.has(x.pubkey)) throw new Error(`rpc ${k}: getProgramAccounts: an account twice`);
      m.set(x.pubkey, d[0]);
    }
    return m;
  };
  signal?.throwIfAborted();
  const [x, y] = await Promise.all(rpcs.map(async (rpc, k) => [await read(rpc, k, 0), await read(rpc, k, PRE_MARK_LEN)] as const));
  signal?.throwIfAborted();
  for (const i of [0, 1]) {
    const [p, q] = [x![i]!, y![i]!];
    if (p.size !== q.size || [...p].some(([key, d]) => q.get(key) !== d)) throw new Error("the two RPCs' marks differ");
  }
  const pre = new Map<string, SolanaDepositMark>();
  for (const [key, d64] of x![1]!) {
    const d = base64.decode(d64);
    if (d.length !== PRE_MARK_LEN) throw new Error(`mark ${key}: not ${PRE_MARK_LEN} bytes`);
    const v = new DataView(d.buffer, d.byteOffset, 16);
    pre.set(key, { value: v.getBigUint64(0, true), nonce: v.getBigUint64(8, true) });
  }
  return { spent: new Set(x![0]!.keys()), pre };
}

export type SolanaRestoredNote = { ref: NoteRef; scope: bigint; precommitment: bigint; leaf: Leaf; state: "UNSPENT" | "SPENT"; parent?: string };
/** A spent note of ours: its release (l, j), the W it paid and the chunk. */
export type SolanaRestoredSpend = { l: bigint; j: number; note: string; w: string; withdrawn: bigint };

export type SolanaRestoreArgs = {
  seed64: Uint8Array;
  program: string;
  scope: bigint;
  ladder: Ladder;
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
    for (const i of walkLane(seed64, scope, lane, (P) => markOf(P) !== undefined, a.gap ?? RESTORE_GAP).found) asDeposit({ kind: "deposit", s: scope, i });

  for (let k = 0; k < notes.length; k++) {
    const note = notes[k]!;
    const ref = note.ref;
    if (ref.kind === "deposit") seconds({ id: "U", s: ref.s, i: ref.i });
    if (!marks.spent.has(solanaMarkOf(program, "spent", noteSecrets(seed64, ref).nullifierHash))) continue;
    note.state = "SPENT";
    const l = note.leaf.label;
    const j = ref.kind === "change" ? ref.j + 1 : 0;
    if (j > U32) throw new Error("change index out of range");
    const key = refKey(ref);
    const withdrawn = chunkOf(a.ladder, note.leaf.value);
    if (withdrawn === null) throw new Error(`${key}: spent, but below the smallest rung`);
    spends.push({ l, j, note: key, w: freshWallet(seed64, "sol", l, j).address, withdrawn });
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
  const leaves = await solanaTreeSync(a.rpcs, a.program).leaves(a.signal);
  return solanaRestore({ seed64: a.seed64, program: a.program, scope: solanaPoolOf(a.program).scope, ladder: SOL_LADDER, stateLeaves: leaves.state, labelLeaves: leaves.label, marks, ...(a.gap === undefined ? {} : { gap: a.gap }) });
}
