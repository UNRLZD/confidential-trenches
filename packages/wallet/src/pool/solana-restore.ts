// Restore of the Solana pool's notes from the 12 words (card notes-per-pool-sol; ../notes/restore.ts is the NEAR
// vault's, whose walk and follow rules this keeps).
//
// - No request names a note or a wallet of the user's. The program's marks are its only accounts of 12 and 16 bytes
//   (src/state.rs, M353, M355 (3), M376): a spent mark ["spent", nullifierHash] records the release's withdrawnValue
//   u64 LE then the release's number u32 LE, and a precommitment mark ["pre", precommitment] its deposit, value u64 LE
//   then the nonce u64 LE its label hashes.
//   Each mark's public counter sits at offset 8: a deposit's nonce (1..D, no gap) and a release's number (0..R-1, no
//   gap). Each RPC reads each mark size in buckets of 256 consecutive counters (card sol-marks-scale, M376 (1)): a
//   getProgramAccounts call (dataSize, withContext) with a memcmp on the counter's bytes past its low byte. A counter is
//   one mark's on both RPCs (a second key for it is refused), so an answer holds at most 256 marks (about 63 KiB) at any
//   pool size, far under the kit's 1 MiB answer cap. A record whose first 8 bytes are 0 is no mark the program wrote and
//   is passed over: anyone can make a zeroed account of a mark's size that the program owns. Both RPCs read a size
//   together in waves of 1, 2, 4, then SOL_MARK_WAVE buckets, the never-closed rule run after every wave, until the last
//   bucket of each one's wave is short; a short bucket at slot s says no counter past it exists at s. An RPC that has
//   stopped while the other reads on reads its lowest bucket not full again, at or past the other's highest slot, so an
//   RPC that answers every bucket full is refused a wave on, and a throw on either RPC stops every read. A bucket names
//   a range of public counters, never a note or a wallet; which buckets are read depends only on the two RPCs'
//   answers. The marks are the union of the two RPCs' (M355 (4)): two honest RPCs at
//   different finalized slots differ by the marks between them, and an RPC cannot invent a mark of ours, since a note's
//   nullifier hash and precommitment stay secret until used; a key both hold with different bytes stops the restore.
//   Then the pages, on both RPCs at or past the higher of the marks' slots (./solana.ts solanaTreeSync leaves), so every
//   deposit and release a mark records has its leaves in them. The device derives its own marks' addresses and looks
//   them up here; a read per mark (a note's own address) would tell the RPC which notes are one user's, so none is made.
// - A mark that lands while the pages are read (card sol-restore-race, review N1): straight after the pages, before any
//   walk, the marks are read again on each RPC at or past the highest slot that RPC answered its pages at
//   (minContextSlot, and the answer's own slot checked), and merged into the first read by the same union rule. A spend
//   or deposit whose leaves are in the pages has its mark in that read.
// - Rounds by one public rule: while a read gives a mark the union did not hold, the pages are read again past the
//   merged marks, then the marks; the walk runs once, at the first read that gives no new mark, on the marks held before
//   it and the pages read just before it. Every mark the walk sees has its leaves in those pages (it landed at or before
//   their slot), and every leaf in them has its mark (the read after them gave nothing new). Whether to read again, and
//   so the number of reads and the outcome, depends only on the two RPCs' answers, never on the device's notes: an RPC
//   learns nothing of which notes are the user's from how the restore reads. No cap and no timer: while marks keep
//   landing the restore reads on as the chain moves (a round is a pages read and a marks read, about a second or two),
//   and the signal stops it.
// - The leaf count: a deposit writes its precommitment mark, one state leaf and one label leaf (contracts/pool-solana/
//   src/deposit.rs:85, 95-96), a release its spent mark and one state leaf (release.rs:260, 268), and nothing else
//   writes a leaf or a mark. At a read with no new mark the pages hold every leaf of the marks and no other, so the walk
//   runs only when the label leaves number the deposit marks and the state leaves the deposit and spent marks together.
//   An RPC that pages short (a relayer that knows a change commitment can cut just before it) is refused on every
//   device alike, never only on the one whose note the missing leaf is.
// - The never-closed rule (solanaMarksGaps): no mark is ever closed, so a mark one RPC gives at slot s that the other
//   lacks at an equal or later slot is a lie, refused on every device alike; the device never judges an RPC's answer by
//   its own notes. Each RPC's next read is at or past every slot read before it (its pages at or past the merged marks'
//   slot, its marks at or past its pages'), so a mark only one RPC gave is in both reads a round later, or refused. When a
//   read gives no new mark, every mark the walk sees is in both RPCs' last reads: the walk runs only once every late mark
//   (one new after the first read) is held by both RPCs, and a mark one RPC made up never reaches it.
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
/** A release as its spent mark records it: withdrawnValue, then the release's number (how many releases came before it). */
export type SolanaSpentMark = { withdrawn: bigint; number: number };
/** Every mark of the pool: each spent mark's address with its record, each precommitment mark's with its record. */
export type SolanaMarks = { spent: ReadonlyMap<string, SolanaSpentMark>; pre: ReadonlyMap<string, SolanaDepositMark>; slot: number };
/**
 * One getProgramAccounts answer: the slot it was answered at, its bucket (counters 256 bucket to 256 bucket + 255) and
 * the marks' keys it gave. A short answer (open) also says that no counter past its bucket exists at its slot, since
 * counters run with no gap.
 */
export type SolanaMarkCall = { slot: number; bucket: number; open: boolean; keys: ReadonlySet<string> };
/** One read of the marks: their union, and each RPC's answers, [spent, pre], one per bucket. */
export type SolanaMarksRead = SolanaMarks & { calls: SolanaMarkCalls };

/** The kit's one definition of the spent mark's length (src/state.rs SPENT_MARK_LEN). */
export const SOL_SPENT_MARK_LEN = SOLANA_POOL_SPENT_MARK_LEN;
export const SOL_PRE_MARK_LEN = 16;
/** Marks per getProgramAccounts call: one byte of the counter (M376 (1)). */
export const SOL_MARK_BUCKET = 256;
/** Bucket calls in flight on one RPC at most: the waves go 1, 2, 4, then this. */
export const SOL_MARK_WAVE = 8;
/** The counter's offset in a mark, and each size's counter: its width in bytes and its first value. */
const COUNTER_AT = 8;
const COUNTER = { [SOL_SPENT_MARK_LEN]: { width: 4, first: 0 }, [SOL_PRE_MARK_LEN]: { width: 8, first: 1 } } as const;

/** Each RPC's answers, by size: calls[k][z], RPC k's answers of size z (0 spent, 1 pre). */
type SolanaMarkCalls = readonly [readonly [SolanaMarkCall[], SolanaMarkCall[]], readonly [SolanaMarkCall[], SolanaMarkCall[]]];
const solanaMarkCalls = (): SolanaMarkCalls => [[[], []], [[], []]];

/**
 * The never-closed rule. A mark is never closed (contracts/pool-solana/src/state.rs:12 "Nothing is ever removed or
 * closed"; the program's one debit is the pool account's, release.rs:272), so a mark one RPC gives at slot s is in every
 * answer of the other RPC at slot s or later. An answer that lacks it is a lie of one of the two, refused whoever's note
 * it would be: the device never judges an RPC's answer by its own notes. Bucket by bucket, each answer with its own
 * slot: y speaks for x's marks when it is x's bucket, or a short bucket below x's (no counter past it at its slot).
 * next (one read: each RPC's answers of each size) is checked against the other RPC's earlier answers in seen, both
 * ways, and against itself, then added to seen.
 */
function solanaMarksGaps(seen: SolanaMarkCalls, next: SolanaMarkCalls): void {
  const lacks = (i: number, x: SolanaMarkCall, j: number, y: SolanaMarkCall): void => {
    if (y.slot < x.slot || !(y.bucket === x.bucket || (y.open && y.bucket < x.bucket))) return;
    for (const key of x.keys) if (!y.keys.has(key)) throw new Error(`mark ${key}: rpc ${i} gives it at slot ${x.slot} and rpc ${j} lacks it at slot ${y.slot}; a mark is never closed`);
  };
  for (const z of [0, 1] as const)
    for (const [i, j] of [[0, 1], [1, 0]] as const)
      for (const x of next[i][z])
        for (const y of [...seen[j][z], ...next[j][z]]) {
          lacks(i, x, j, y);
          lacks(j, y, i, x);
        }
  next.forEach((cs, k) => cs.forEach((c, z) => seen[k]![z]!.push(...c)));
}

/**
 * Every mark of the pool, the union of two RPCs' whole-set reads, each in buckets (header); a key both hold with
 * different bytes is refused, and a key one RPC gives that the other lacks at an equal or later slot (solanaMarksGaps).
 * minSlots: RPC k answers at or past minSlots[k] (minContextSlot), and an answer below it is refused. only "spent": the
 * spent marks alone (a settle's read), pre then empty. lagWait: tests only.
 */
export async function solanaMarks(rpcs: readonly [SolanaRpc, SolanaRpc], program: string, signal?: AbortSignal, minSlots?: readonly [number, number], lagWait?: SolanaLagWait, only?: "spent"): Promise<SolanaMarksRead> {
  checkSolanaRpcs(rpcs);
  if (minSlots !== undefined && !(Array.isArray(minSlots) && minSlots.length === 2 && minSlots.every((x) => Number.isSafeInteger(x) && x >= 0))) throw new Error("minSlots: two slots");
  if (only !== undefined && only !== "spent") throw new Error("only: spent or nothing");
  // one stop for every call below: the caller's signal, or the first throw on either RPC or size, so no read goes on
  // past the refusal (review S2)
  const stop = new AbortController();
  const onAbort = (): void => stop.abort(signal!.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  // each RPC's marks of each size, address to bytes (base64): marks[k][z]
  const marks = [[new Map<string, string>(), new Map<string, string>()], [new Map<string, string>(), new Map<string, string>()]] as const;
  const calls = solanaMarkCalls();
  // one size on both RPCs, wave by wave together, the never-closed rule after every wave
  const readSize = async (z: 0 | 1): Promise<void> => {
    const size = z === 0 ? SOL_SPENT_MARK_LEN : SOL_PRE_MARK_LEN;
    const { width, first } = COUNTER[size];
    // a counter is one mark's, on both RPCs (review S3): a bucket holds 256 marks at most, and a made-up mark in a bucket
    // the other RPC answered full meets that counter's own mark
    const byCounter = new Map<bigint, string>();
    // one bucket: the counters 256 b to 256 b + 255, the counter's bytes past its low byte equal to b
    const bucket = async (k: 0 | 1, b: number, min: number): Promise<SolanaMarkCall> => {
      const rpc = rpcs[k];
      const m = marks[k][z];
      const high = new Uint8Array(width - 1);
      for (let i = 0, v = b; i < high.length; i++, v = Math.floor(v / 256)) high[i] = v % 256;
      const filters = [{ dataSize: size }, { memcmp: { offset: COUNTER_AT + 1, bytes: base58.encode(high) } }];
      const a = (await solanaLagRetry(() => rpc("getProgramAccounts", [program, { commitment: "finalized", encoding: "base64", withContext: true, ...(min > 0 ? { minContextSlot: min } : {}), filters }]), lagWait, stop.signal)) as { context?: { slot?: unknown }; value?: unknown };
      const slot = a?.context?.slot;
      if (!Number.isSafeInteger(slot) || (slot as number) < 0 || !Array.isArray(a.value)) throw new Error(`rpc ${k}: getProgramAccounts: not a list with its context`);
      if ((slot as number) < min) throw new Error(`rpc ${k}: getProgramAccounts: answered at slot ${slot as number}, below ${min}`);
      const keys = new Set<string>();
      for (const x of a.value as { pubkey?: unknown; account?: { owner?: unknown; data?: unknown } }[]) {
        const d = x?.account?.data;
        if (typeof x?.pubkey !== "string" || x.account?.owner !== program || !Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new Error(`rpc ${k}: getProgramAccounts: not the program's account`);
        if (keys.has(x.pubkey)) throw new Error(`rpc ${k}: getProgramAccounts: an account twice`);
        const bytes = base64.decode(d[0]);
        if (bytes.length !== size) throw new Error(`rpc ${k}: mark ${x.pubkey}: not ${size} bytes`);
        // review S1: a record whose first 8 bytes are 0 is no mark the program wrote (a deposit's value is at least
        // MIN_DEPOSIT, contracts/pool-solana/src/deposit.rs:76; a release's withdrawn is never 0, release.rs:218). Anyone
        // can make a zeroed account of a mark's size that the program owns (the system program's CreateAccount or Assign
        // takes any owner, and only the owner writes its data), so it is passed over before the counter and never counted.
        if (bytes.subarray(0, 8).every((v) => v === 0)) continue;
        const have = m.get(x.pubkey);
        if (have !== undefined && have !== d[0]) throw new Error(`rpc ${k}: mark ${x.pubkey}: two answers differ`);
        // the RPC applies the filter: a mark outside the bucket would speak for counters it was never asked about
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const c = width === 4 ? BigInt(view.getUint32(COUNTER_AT, true)) : view.getBigUint64(COUNTER_AT, true);
        if (c < BigInt(first) || c >> 8n !== BigInt(b)) throw new Error(`rpc ${k}: mark ${x.pubkey}: counter ${c} is not in bucket ${b}`);
        const owner = byCounter.get(c);
        if (owner !== undefined && owner !== x.pubkey) throw new Error(`rpc ${k}: mark ${x.pubkey}: counter ${c} is mark ${owner}'s`);
        byCounter.set(c, x.pubkey);
        m.set(x.pubkey, d[0]);
        keys.add(x.pubkey);
      }
      return { slot: slot as number, bucket: b, open: keys.size < SOL_MARK_BUCKET - (b === 0 ? first : 0), keys };
    };
    // per RPC: the next bucket to read, the buckets it answered full, its lowest bucket not full, and whether it stopped
    // (its last wave's last bucket short)
    const next = [0, 0];
    const full = [new Set<number>(), new Set<number>()] as const;
    const low = [0, 0];
    const stopped = [false, false];
    for (let w = 1; !(stopped[0] && stopped[1]); w = Math.min(2 * w, SOL_MARK_WAVE)) {
      stop.signal.throwIfAborted();
      const top = (k: 0 | 1): number => Math.max(0, ...calls[k][z].map((c) => c.slot));
      const wave = await Promise.all(([0, 1] as const).map(async (k): Promise<SolanaMarkCall[]> => {
        const min = minSlots?.[k] ?? 0;
        if (!stopped[k]) {
          const got = await Promise.all(Array.from({ length: w }, (_, i) => bucket(k, next[k]! + i, min)));
          next[k]! += w;
          return got;
        }
        // review S2: stopped while the other reads on, its lowest bucket not full again, at or past the other's highest
        // slot: a short answer there speaks for every counter from it on at that slot (solanaMarksGaps), so marks the
        // other made up past this RPC's are refused a wave on, never read until the signal. Below it every bucket is
        // full, each counter held by one mark.
        return [await bucket(k, low[k]!, Math.max(min, top(k === 0 ? 1 : 0)))];
      }));
      for (const k of [0, 1] as const) {
        for (const c of wave[k]) if (!c.open) full[k].add(c.bucket);
        while (full[k].has(low[k]!)) low[k]!++;
        const last = wave[k][wave[k].length - 1]!;
        // a re-read bucket answered full: this RPC reads on past it
        if (stopped[k] && !last.open) next[k] = low[k]!;
        stopped[k] = last.open;
      }
      const add = solanaMarkCalls();
      add[0][z].push(...wave[0]);
      add[1][z].push(...wave[1]);
      solanaMarksGaps(calls, add);
    }
  };
  try {
    stop.signal.throwIfAborted();
    await Promise.all((only === "spent" ? [0] : [0, 1]).map((z) => readSize(z as 0 | 1)));
  } catch (e) {
    stop.abort(e);
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const union = (i: 0 | 1): Map<string, Uint8Array> => {
    const out = new Map<string, string>(marks[0][i]);
    for (const [key, d] of marks[1][i]) {
      const have = out.get(key);
      if (have !== undefined && have !== d) throw new Error(`mark ${key}: the two RPCs' bytes differ`);
      out.set(key, d);
    }
    return new Map([...out].map(([key, d]) => [key, base64.decode(d)]));
  };
  const u64 = (d: Uint8Array, at: number): bigint => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(at, true);
  const spent = new Map([...union(0)].map(([key, d]) => [key, { withdrawn: u64(d, 0), number: new DataView(d.buffer, d.byteOffset, d.length).getUint32(8, true) }] as const));
  const pre = new Map([...union(1)].map(([key, d]) => [key, { value: u64(d, 0), nonce: u64(d, 8) }] as const));
  const slot = Math.max(...calls.flat(2).map((c) => c.slot));
  return { spent, pre, slot, calls };
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
    const withdrawn = marks.spent.get(solanaMarkOf(program, "spent", noteSecrets(seed64, ref).nullifierHash))?.withdrawn;
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

/** Two reads of the marks as one: the union, a key both hold with a different record (any field) refused, the higher slot. */
export function solanaMarksUnion(x: SolanaMarks, y: SolanaMarks): SolanaMarks {
  const spent = new Map(x.spent);
  for (const [key, w] of y.spent) {
    const have = spent.get(key);
    if (have !== undefined && (have.withdrawn !== w.withdrawn || have.number !== w.number)) throw new Error(`mark ${key}: two reads differ`);
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

/**
 * Restore of the Solana pool from the 12 words, on two RPCs: the marks, then rounds of the pages and the marks again past
 * them until a read gives no new mark (header), then solanaRestore once on those marks and pages.
 */
export async function solanaRestoreNotes(a: { seed64: Uint8Array; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; signal?: AbortSignal; gap?: number; /** tests only */ lagWait?: SolanaLagWait }) {
  const sync = solanaTreeSync(a.rpcs, a.program, a.lagWait);
  const scope = solanaPoolOf(a.program).scope;
  const first = await solanaMarks(a.rpcs, a.program, a.signal, undefined, a.lagWait);
  let marks: SolanaMarks = first;
  // every answer each RPC gave, for the never-closed rule across reads
  const calls = solanaMarkCalls();
  solanaMarksGaps(calls, first.calls);
  for (;;) {
    const leaves = await sync.leaves(marks.slot, a.signal);
    const read = await solanaMarks(a.rpcs, a.program, a.signal, leaves.slots, a.lagWait);
    solanaMarksGaps(calls, read.calls);
    const again = solanaMarksUnion(marks, read);
    // the one rule, on the RPCs' answers alone: walk at the first read with no new mark; else read again past it
    if ([...again.spent.keys(), ...again.pre.keys()].every((key) => marks.spent.has(key) || marks.pre.has(key))) {
      // the pages hold exactly the marks' leaves (header): pages short of them, or past them, are refused on every device
      if (leaves.label.length !== marks.pre.size || leaves.state.length !== marks.pre.size + marks.spent.size)
        throw new Error(`restore: the pages hold ${leaves.state.length} state and ${leaves.label.length} label leaves for ${marks.pre.size} deposits and ${marks.spent.size} releases`);
      return solanaRestore({ seed64: a.seed64, program: a.program, scope, stateLeaves: leaves.state, labelLeaves: leaves.label, marks, ...(a.gap === undefined ? {} : { gap: a.gap }) });
    }
    marks = again;
  }
}

/** What a refused send's settle found: the note's spend on chain (its change written, the note SPENT), or none. */
export type SolanaSettled = { kind: "spent"; change: NoteRecord; withdrawn: bigint } | { kind: "unspent" };

/**
 * The one place a Solana pool send the chain refused as already spent (the pool's NullifierAlreadySpent, error 16: the
 * note's spent mark exists) is settled, by whatever sends a release. Never on the refusal's word: the helper, the
 * simulation and the send are hostile input, and the nullifier hash is no longer secret once the send has left. The
 * spent marks are read whole on two RPCs (the union, as a restore reads them: no read names the note; the deposit
 * marks are not read, review S4), then the pages past them. Only when the note's spent mark is there and its change note (spentChange: value - withdrawnValue under change
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
  const marks = await solanaMarks(a.rpcs, a.program, a.signal, undefined, a.lagWait, "spent");
  const leaves = await solanaTreeSync(a.rpcs, a.program, a.lagWait).leaves(marks.slot, a.signal);
  const withdrawn = marks.spent.get(solanaMarkOf(a.program, "spent", noteSecrets(a.seed64, note.ref).nullifierHash))?.withdrawn;
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
