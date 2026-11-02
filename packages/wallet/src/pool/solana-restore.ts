// Restore of the Solana pool's notes from the 12 words (card notes-per-pool-sol; ../notes/restore.ts is the NEAR
// vault's, whose walk and follow rules this keeps).
//
// - No request names a note or a wallet of the user's. The spent marks ["spent", nullifierHash] and the precommitment
//   marks ["pre", precommitment] are the program's only empty accounts (src/state.rs), so one getProgramAccounts read
//   with a dataSize 0 filter on each of two RPCs returns every mark of every user; the two sets must be equal. The
//   device derives its own marks' addresses and looks them up here. A read per mark (getAccountInfo of a note's own
//   address) would tell the RPC which notes are one user's, so none is made.
// - Deposit rows (precommitment, value, label, leaf index) are an input: the program keeps no account that holds a
//   deposit's value or nonce, only the transaction that made it. Every row is checked against the two RPCs' trees and
//   marks before it is used: its commitment must be the state tree's leaf at its index, its label in the label tree,
//   and its precommitment mark present. So a row source can hide a note but never invent or move one.
// - The walk: deposit indices lane by lane until RESTORE_GAP misses in a row (../notes/restore.ts walkLane), each
//   deposit note's second arrivals; for each note found, spent when its spent mark is in the set. A spent note's
//   release withdrew its chunk (chunkOf: the queue releases exactly one rung, ./queue.ts), so its change note is
//   value - chunk under change (l, j), which must be a leaf of the state tree (a drift stops the restore). Then the
//   move, return and second-arrival notes the release's W brought back, as on the NEAR vault. No refund note: a Solana
//   release pays W in its own transaction.
// - Each spent note's W is W_{sol, l, j}: its address is returned, the key stays derivable from the words alone.
import { base58 } from "@scure/base";
import type { SolanaRpc } from "@blindfill/kit";
import { CHAINS, type Chain, freshWallet, type SecondId } from "../derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, walkLane } from "../notes/restore.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type Leaf } from "../notes/store.ts";
import { chunkOf, type Ladder } from "./ladder.ts";
import { solanaPda } from "./solana.ts";

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

/** Every mark of the pool, read whole on two RPCs that must give the same set. */
export async function solanaMarks(rpcs: readonly [SolanaRpc, SolanaRpc], program: string, signal?: AbortSignal): Promise<Set<string>> {
  const cfg = { commitment: "finalized", encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 0 }] };
  signal?.throwIfAborted();
  const sets = await Promise.all(
    rpcs.map(async (rpc, k) => {
      const a = await rpc("getProgramAccounts", [program, cfg]);
      if (!Array.isArray(a)) throw new Error(`rpc ${k}: getProgramAccounts: not a list`);
      const s = new Set<string>();
      for (const x of a as { pubkey?: unknown; account?: { owner?: unknown } }[]) {
        if (typeof x?.pubkey !== "string" || x.account?.owner !== program) throw new Error(`rpc ${k}: getProgramAccounts: not the program's account`);
        s.add(x.pubkey);
      }
      return s;
    }),
  );
  signal?.throwIfAborted();
  const [x, y] = sets as [Set<string>, Set<string>];
  if (x.size !== y.size || [...x].some((m) => !y.has(m))) throw new Error("the two RPCs' marks differ");
  return x;
}

/** One deposit into the pool, from a row source; checked against the trees and the marks before use. */
export type SolanaDepositRow = { precommitment: bigint; value: bigint; label: bigint; leafIndex: bigint };

export type SolanaRestoredNote = { ref: NoteRef; scope: bigint; precommitment: bigint; leaf: Leaf; state: "UNSPENT" | "SPENT"; parent?: string };
/** A spent note of ours: its release (l, j), the W it paid and the chunk. */
export type SolanaRestoredSpend = { l: bigint; j: number; note: string; w: string; withdrawn: bigint };

export type SolanaRestoreArgs = {
  seed64: Uint8Array;
  program: string;
  scope: bigint;
  ladder: Ladder;
  /** The whole state tree's leaves and the label tree's, from the two-RPC page read (./solana.ts). */
  stateLeaves: readonly bigint[];
  labelLeaves: readonly bigint[];
  /** solanaMarks' set. */
  marks: ReadonlySet<string>;
  deposits: readonly SolanaDepositRow[];
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
  const labels = new Set(a.labelLeaves);
  const byP = new Map<bigint, SolanaDepositRow>();
  for (const r of a.deposits) if (!byP.has(r.precommitment)) byP.set(r.precommitment, r);

  const notes: SolanaRestoredNote[] = [];
  const spends: SolanaRestoredSpend[] = [];
  const seen = new Set<string>();
  const put = (ref: NoteRef, precommitment: bigint, leaf: Leaf, parent?: string): void => {
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    notes.push({ ref, scope, precommitment, leaf, state: "UNSPENT", ...(parent === undefined ? {} : { parent }) });
  };
  // a note the pool holds as a deposit: its row, checked against the trees and the marks
  const asDeposit = (ref: NoteRef): boolean => {
    const P = noteSecrets(seed64, ref).precommitment;
    const r = byP.get(P);
    if (r === undefined) return false;
    const commitment = noteCommitment(r.value, r.label, P);
    if (leafAt.get(commitment) !== Number(r.leafIndex)) throw new Error(`deposit of ${refKey(ref)}: its commitment is not the state tree's leaf ${r.leafIndex}`);
    if (!labels.has(r.label)) throw new Error(`deposit of ${refKey(ref)}: its label is not in the label tree`);
    if (!marks.has(solanaMarkOf(program, "pre", P))) throw new Error(`deposit of ${refKey(ref)}: no precommitment mark`);
    put(ref, P, { value: r.value, label: r.label, commitment, leafIndex: r.leafIndex });
    return true;
  };
  const seconds = (id: SecondId): void => {
    for (let n = 0; n <= U32 && asDeposit({ kind: "second", id, n }); n++);
  };

  for (let lane = 0; lane < RESTORE_LANES; lane++)
    for (const i of walkLane(seed64, scope, lane, (P) => byP.has(P), a.gap ?? RESTORE_GAP).found) asDeposit({ kind: "deposit", s: scope, i });

  for (let k = 0; k < notes.length; k++) {
    const note = notes[k]!;
    const ref = note.ref;
    if (ref.kind === "deposit") seconds({ id: "U", s: ref.s, i: ref.i });
    if (!marks.has(solanaMarkOf(program, "spent", noteSecrets(seed64, ref).nullifierHash))) continue;
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
