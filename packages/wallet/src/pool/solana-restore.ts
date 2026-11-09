// Restore of the Solana pool's notes from the 12 words (card notes-per-pool-sol; ../notes/restore.ts is the NEAR
// vault's, whose walk and follow rules this keeps).
//
// - No request names a note or a wallet of the user's. The program's marks are its only accounts of 13 and 17 bytes
//   (src/state.rs, M353, M355 (3), M376): a spent mark ["spent", nullifierHash] records the release's withdrawnValue
//   u64 LE then the release's number u32 LE, and a precommitment mark ["pre", precommitment] its deposit, value u64 LE
//   then the nonce u64 LE its label hashes; each ends with the program's tag byte (MARK_TAG, 1).
//   Each mark's public counter sits at offset 8: a deposit's nonce (1..D, no gap) and a release's number (0..R-1, no
//   gap). One RPC, the lister, names the marks' addresses, bucket by bucket: a getProgramAccounts call per 256
//   consecutive counters (card sol-marks-scale, M376 (1); dataSize, a memcmp from offset 9 on the counter's bytes past
//   its low byte and then the tag, card pool-sol-mark-tag), with no data. Nothing it answers counts: each listed address
//   is read by getMultipleAccounts on both RPCs of the pair, which must give the same owner (the program) and the same
//   bytes, a record the program wrote (not zero in its first 8 bytes, the tag last) whose counter is in its bucket and no
//   other mark's (solanaMarksListed). An address the lister makes up is no account on the pair and is refused; a mark it
//   hides leaves a count short (below). Anyone can make a zero-filled account of a mark's size that the program owns
//   (the system program's CreateAccount or Assign takes any owner, and only the owner writes its data): its tag byte is
//   0, so it matches no bucket, and a listed one is refused. A bucket names a range of public counters, never a note or a
//   wallet, and every listed mark is read, so neither RPC learns which notes are the user's; an RPC cannot invent a mark
//   of ours either, since a note's nullifier hash and precommitment stay secret until used. On mainnet the lister is the
//   helper's marks route (no keyless provider answers that scan) and the pair is a provider of its own beside the
//   helper, so the helper alone can list, never make a mark count (review P1 of 369a87a8).
//   Then the pages, on both RPCs at or past the marks' slot (./solana.ts solanaTreeSync leaves), so every deposit and
//   release a mark records has its leaves in them. The device derives its own marks' addresses and looks them up here; a
//   read per mark of its own (a note's own address) would tell the RPC which notes are one user's, so none is made.
// - A mark that lands while the pages are read (card sol-restore-race, review N1): straight after the pages, before any
//   walk, the marks are listed and read again at or past the highest slot each RPC answered its pages at
//   (minContextSlot, and the answer's own slot checked), and merged into the first read by the union rule (a key with
//   two records is refused). A spend or deposit whose leaves are in the pages has its mark in that read.
// - Rounds by one public rule: while a read gives a mark the union did not hold, the pages are read again past the
//   merged marks, then the marks; the walk runs once, at the first read that gives no new mark, on the marks held before
//   it and the pages read just before it. Whether to read again, and so the number of reads and the outcome, depends
//   only on the RPCs' answers, never on the device's notes. No cap and no timer: while marks keep landing the restore
//   reads on as the chain moves, and the signal stops it.
// - The leaf count: a deposit writes its precommitment mark, one state leaf and one label leaf (contracts/pool-solana/
//   src/deposit.rs:85, 95-96), a release its spent mark and one state leaf (release.rs:260, 268), and nothing else
//   writes a leaf or a mark. At a read with no new mark the pages hold every leaf of the marks and no other, so the walk
//   runs only when each RPC's own label leaves number the deposit marks and its own state leaves the deposit and spent
//   marks together, and the counters run with no hole (solanaMarkCounts): the leaves both RPCs agree on end where the
//   shorter RPC's do, so a mark the lister hides and a page one leaf short on one RPC would pass a count of the agreed
//   leaves alone. An RPC that pages short is refused on every device alike, never only on the one whose note the
//   missing leaf is. The settle (solanaSettleSpent) holds the same rule before it decides anything.
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
import { RESTORE_GAP, RESTORE_LANES, type SeedUse, walkLane, withSeed } from "../notes/restore.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../notes/secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "../notes/store.ts";
import { checkSolanaRpcs, type SolanaLagWait, solanaFinalTimes, solanaLagRetry, solanaPda, solanaPoolOf, solanaTreeSync } from "./solana.ts";

const U32 = 0xffffffff;
const CHAIN_TAGS = /* @__PURE__ */ Object.keys(CHAINS) as Chain[];
const enc = /* @__PURE__ */ new TextEncoder();
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
/** The kit's one definition of the spent mark's length (src/state.rs SPENT_MARK_LEN). */
export const SOL_SPENT_MARK_LEN = SOLANA_POOL_SPENT_MARK_LEN;
export const SOL_PRE_MARK_LEN = 17;
/** Every mark's last byte, right after its counter (src/state.rs MARK_TAG): inside each bucket's memcmp, so a stranger's
 * zero-filled account matches no bucket. */
export const SOL_MARK_TAG = 1;
/** Marks per getProgramAccounts call: one byte of the counter (M376 (1)). */
export const SOL_MARK_BUCKET = 256;
/** The counter's offset in a mark, and each size's counter: its width in bytes and its first value. */
const COUNTER_AT = 8;
const COUNTER = { [SOL_SPENT_MARK_LEN]: { width: 4, first: 0 }, [SOL_PRE_MARK_LEN]: { width: 8, first: 1 } } as const;


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

/** Listed marks per getMultipleAccounts: solana-rpc.publicnode.com takes at most 10 accounts in one call (the kit's
 * trade/solana/flow.ts). */
export const SOL_MARK_READ_BATCH = 10;

/**
 * Every mark of the pool, listed by one RPC and read by two (card exit-pool-notes). `lister` runs the bucket
 * getProgramAccounts calls (the same filters: one size, the counter's bytes past its low byte, then the tag), each at or
 * past the highest slot either RPC has answered at (minContextSlot, the answer's own slot checked), and only names
 * addresses; nothing it answers is a mark. Each bucket's addresses not in `held` are then read by getMultipleAccounts on
 * both `rpcs`, at or past the lister's slot, and each must be on both with the same owner (the program) and the same bytes,
 * a record the program wrote (not zero in its first 8 bytes, its tag last) whose counter is in that bucket and no other
 * mark's. Buckets go on until one lists fewer than it holds; a bucket of 256 is 256 real marks, so a lister cannot list
 * without end. Every mark is read, so neither RPC learns which are the user's, and neither needs to serve
 * getProgramAccounts (solana-rpc.publicnode.com refuses it: "Indexed requests require a personal token", read 9 Nov
 * 2026 18:40Z). A lister that hides marks, or lists none, is found by the leaf count (solanaRestoreNotes): the pages,
 * read on both RPCs, count every deposit and release (solanaMarkCounts), and a mark's bytes come from both RPCs only, so
 * an address the lister makes up is on neither and is refused. held: marks an earlier read took on both RPCs (a mark is never closed
 * or rewritten, contracts/pool-solana/src/state.rs:12), so each mark is read once on each RPC however many rounds a
 * restore takes; a listed mark held is still held to its bucket and its counter.
 */
export async function solanaMarksListed(lister: SolanaRpc, rpcs: readonly [SolanaRpc, SolanaRpc], program: string, signal?: AbortSignal, minSlots?: readonly [number, number], lagWait?: SolanaLagWait, held?: SolanaMarks): Promise<SolanaMarks> {
  checkSolanaRpcs(rpcs);
  if (typeof lister !== "function") throw new Error("lister: an rpc");
  if (minSlots !== undefined && !(Array.isArray(minSlots) && minSlots.length === 2 && minSlots.every((x) => Number.isSafeInteger(x) && x >= 0))) throw new Error("minSlots: two slots");
  const slots = [minSlots?.[0] ?? 0, minSlots?.[1] ?? 0];
  const out = [new Map<string, Uint8Array>(), new Map<string, Uint8Array>()] as const;
  // a held mark's bytes, as the program wrote them (its record, then the tag): z 0 spent, 1 pre
  const heldBytes = (z: 0 | 1, key: string): Uint8Array | undefined => {
    if (z === 0) {
      const m = held?.spent.get(key);
      if (m === undefined) return undefined;
      const b = new Uint8Array(SOL_SPENT_MARK_LEN);
      new DataView(b.buffer).setBigUint64(0, m.withdrawn, true);
      new DataView(b.buffer).setUint32(8, m.number, true);
      b[12] = SOL_MARK_TAG;
      return b;
    }
    const m = held?.pre.get(key);
    if (m === undefined) return undefined;
    const b = new Uint8Array(SOL_PRE_MARK_LEN);
    new DataView(b.buffer).setBigUint64(0, m.value, true);
    new DataView(b.buffer).setBigUint64(8, m.nonce, true);
    b[16] = SOL_MARK_TAG;
    return b;
  };
  // both RPCs' bytes of `keys`, each at or past `min` and its own last slot
  const read = async (keys: readonly string[], min: number): Promise<string[]> => {
    const got = await Promise.all(([0, 1] as const).map(async (k) => {
      const datas: string[] = [];
      for (let i = 0; i < keys.length; i += SOL_MARK_READ_BATCH) {
        signal?.throwIfAborted();
        const part = keys.slice(i, i + SOL_MARK_READ_BATCH);
        const at = Math.max(min, slots[k]!);
        const a = (await solanaLagRetry(() => rpcs[k]("getMultipleAccounts", [part, { commitment: "finalized", encoding: "base64", ...(at > 0 ? { minContextSlot: at } : {}) }]), lagWait, signal)) as { context?: { slot?: unknown }; value?: unknown };
        const slot = a?.context?.slot;
        if (!Number.isSafeInteger(slot) || (slot as number) < at || !Array.isArray(a.value) || a.value.length !== part.length) throw new Error(`rpc ${k}: getMultipleAccounts: not one account per listed mark at or past slot ${at}`);
        slots[k] = Math.max(slots[k]!, slot as number);
        (a.value as ({ owner?: unknown; data?: unknown } | null)[]).forEach((x, j) => {
          if (x === null) throw new Error(`rpc ${k}: listed mark ${part[j]} is not on it`);
          const d = x?.data;
          if (x?.owner !== program || !Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new Error(`rpc ${k}: listed mark ${part[j]}: not the program's account`);
          datas.push(d[0]);
        });
      }
      return datas;
    }));
    keys.forEach((key, j) => {
      if (got[0][j] !== got[1][j]) throw new Error(`listed mark ${key}: the two RPCs' bytes differ`);
    });
    return got[0];
  };
  for (const z of [0, 1] as const) {
    const size = z === 0 ? SOL_SPENT_MARK_LEN : SOL_PRE_MARK_LEN;
    const { width, first } = COUNTER[size];
    const byCounter = new Map<bigint, string>();
    for (let b = 0; ; b++) {
      signal?.throwIfAborted();
      const high = new Uint8Array(width);
      for (let i = 0, v = b; i < width - 1; i++, v = Math.floor(v / 256)) high[i] = v % 256;
      high[width - 1] = SOL_MARK_TAG;
      const filters = [{ dataSize: size }, { memcmp: { offset: COUNTER_AT + 1, bytes: base58.encode(high) } }];
      // at or past every slot either RPC has answered at (review P3-2): a lister behind the pages waits, never lists short
      const at = Math.max(slots[0]!, slots[1]!);
      const a = (await solanaLagRetry(() => lister("getProgramAccounts", [program, { commitment: "finalized", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, ...(at > 0 ? { minContextSlot: at } : {}), filters }]), lagWait, signal)) as { context?: { slot?: unknown }; value?: unknown };
      const slot = a?.context?.slot;
      if (!Number.isSafeInteger(slot) || (slot as number) < 0 || !Array.isArray(a.value)) throw new Error("lister: getProgramAccounts: not a list with its context");
      if ((slot as number) < at) throw new Error(`lister: getProgramAccounts: answered at slot ${slot as number}, below ${at}`);
      const keys: string[] = [];
      for (const x of a.value as { pubkey?: unknown }[]) {
        const key = x?.pubkey;
        let ok = false;
        try {
          ok = typeof key === "string" && base58.decode(key).length === 32;
        } catch {}
        if (!ok) throw new Error("lister: getProgramAccounts: not an address");
        if (keys.includes(key as string) || out[z].has(key as string)) throw new Error(`lister: mark ${key as string} listed twice`);
        keys.push(key as string);
      }
      // only the marks not held are read (review P3-5): a mark never changes once written
      const fresh = keys.filter((key) => heldBytes(z, key) === undefined);
      const datas = await read(fresh, slot as number);
      const got = new Map(fresh.map((key, j) => [key, datas[j]!] as const));
      keys.forEach((key) => {
        const bytes = heldBytes(z, key) ?? base64.decode(got.get(key)!);
        if (bytes.length !== size) throw new Error(`listed mark ${key}: not ${size} bytes`);
        if (bytes.subarray(0, 8).every((v) => v === 0) || bytes[size - 1] !== SOL_MARK_TAG) throw new Error(`listed mark ${key}: no record the program wrote`);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const c = width === 4 ? BigInt(view.getUint32(COUNTER_AT, true)) : view.getBigUint64(COUNTER_AT, true);
        if (c < BigInt(first) || c >> 8n !== BigInt(b)) throw new Error(`listed mark ${key}: counter ${c} is not in bucket ${b}`);
        const owner = byCounter.get(c);
        if (owner !== undefined) throw new Error(`listed mark ${key}: counter ${c} is mark ${owner}'s`);
        byCounter.set(c, key);
        out[z].set(key, bytes);
      });
      if (keys.length < SOL_MARK_BUCKET - (b === 0 ? first : 0)) break;
    }
  }
  const u64 = (d: Uint8Array, at: number): bigint => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(at, true);
  const spent = new Map([...out[0]].map(([key, d]) => [key, { withdrawn: u64(d, 0), number: new DataView(d.buffer, d.byteOffset, d.length).getUint32(8, true) }] as const));
  const pre = new Map([...out[1]].map(([key, d]) => [key, { value: u64(d, 0), nonce: u64(d, 8) }] as const));
  return { spent, pre, slot: Math.max(slots[0]!, slots[1]!) };
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
 * The marks' counts against each RPC's own pages (card exit-pool-notes, review P1-1). A deposit writes one precommitment
 * mark, one state leaf and one label leaf; a release one spent mark and one state leaf (contracts/pool-solana/src/
 * deposit.rs, release.rs); so each RPC's own pages hold exactly D label and D + R state leaves for D deposits and R
 * releases. Deposits are numbered by their nonce 1..D and releases 0..R-1 with no gap (src/state.rs), so the marks'
 * counters are exactly those: a hole is a mark left out. Each RPC's own counts, never the leaves both agree on, which
 * end where the shorter RPC's do: a mark hidden by the lister plus one RPC's page a leaf short would pass those.
 */
export function solanaMarkCounts(marks: SolanaMarks, counts: readonly (readonly [number, number])[]): void {
  const d = marks.pre.size;
  const r = marks.spent.size;
  if (counts.some(([state, label]) => label !== d || state !== d + r))
    throw new Error(`the lister listed ${d} deposits and ${r} releases (${d} label and ${d + r} state leaves), but rpc 0's pages hold ${counts[0]![0]} state and ${counts[0]![1]} label leaves and rpc 1's hold ${counts[1]![0]} state and ${counts[1]![1]} label leaves`);
  const nonces = new Set([...marks.pre.values()].map((m) => m.nonce));
  if (nonces.size !== d || [...nonces].some((n) => n < 1n || n > BigInt(d))) throw new Error(`the listed deposits' nonces are not 1 to ${d}`);
  const numbers = new Set([...marks.spent.values()].map((m) => m.number));
  if (numbers.size !== r || [...numbers].some((n) => n < 0 || n >= r)) throw new Error(`the listed releases' numbers are not 0 to ${r - 1}`);
}

/**
 * Restore of the Solana pool from the 12 words, on two RPCs: the marks, then rounds of the pages and the marks again past
 * them until a read gives no new mark (header), then solanaRestore once on those marks and pages.
 */
export async function solanaRestoreNotes(a: {
  /** the seed, or a SeedUse opened only for the walk's match, after every read */ seed64: Uint8Array | SeedUse;
  program: string;
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** lists the marks' addresses; the two RPCs read each one (solanaMarksListed). No mark counts on a list alone. */
  lister: SolanaRpc;
  signal?: AbortSignal;
  gap?: number;
  /** tests only */ lagWait?: SolanaLagWait;
}) {
  const sync = solanaTreeSync(a.rpcs, a.program, a.lagWait);
  const scope = solanaPoolOf(a.program).scope;
  const marksAt = (minSlots?: readonly [number, number]): Promise<SolanaMarks> => solanaMarksListed(a.lister, a.rpcs, a.program, a.signal, minSlots, a.lagWait, held);
  // the marks taken so far, which a listed read does not read again
  let held: SolanaMarks | undefined;
  let marks: SolanaMarks = await marksAt();
  for (;;) {
    const leaves = await sync.leaves(marks.slot, a.signal);
    held = marks;
    const read = await marksAt(leaves.slots);
    const again = solanaMarksUnion(marks, read);
    // the one rule, on the RPCs' answers alone: walk at the first read with no new mark; else read again past it
    if ([...again.spent.keys(), ...again.pre.keys()].every((key) => marks.spent.has(key) || marks.pre.has(key))) {
      // each RPC's own pages hold exactly the marks' leaves, and the counters run with no hole (header; review P1-1): a
      // mark the lister hides, plus one RPC's page a leaf short, is refused on every device alike
      solanaMarkCounts(marks, leaves.counts);
      return withSeed(a.seed64, (seed64) => solanaRestore({ seed64, program: a.program, scope, stateLeaves: leaves.state, labelLeaves: leaves.label, marks, ...(a.gap === undefined ? {} : { gap: a.gap }) }));
    }
    marks = again;
  }
}

/** What a refused send's settle found: the note's spend on chain (its change written, the note SPENT), or none. */
export type SolanaSettled = { kind: "spent"; change: NoteRecord; withdrawn: bigint } | { kind: "unspent" };

/**
 * The one place a Solana pool send the chain refused as already spent (the pool's NullifierAlreadySpent, error 16: the
 * note's spent mark exists) is settled, by whatever sends a release. Never on the refusal's word: the helper, the
 * simulation and the send are hostile input, and the nullifier hash is no longer secret once the send has left. Every
 * mark is listed by `lister` and read by its address on both RPCs (solanaMarksListed, as a restore reads them: no read
 * names the note), then the pages past them, and the marks must count every leaf of each RPC's own pages with no hole in
 * their counters (solanaMarkCounts) before anything is decided. So a mark the lister hides, or lists under an address
 * that is no account, is refused, never read as "no spend". Only when the note's spent mark is there and its change note
 * (spentChange: value - withdrawnValue under change (l, j)) is a leaf both RPCs agree on is the change written UNSPENT
 * through the store's add(child, parent), which moves the note to SPENT, so the queue never offers it again. No spent
 * mark: nothing is written ("unspent"). A spent mark whose change is not in the state tree: a refusal, nothing written.
 * A change another tab wrote first, with this leaf, is taken. The marks and the pages are read whether or not the mark
 * is there, so the reads look the same either way.
 * A deposit or release that lands between the marks and the pages makes a count differ: the settle refuses (held) and the
 * next pass reads again. On a pool so busy that one lands inside every pass the note stays held: the safe direction,
 * accepted (never freed on a count that does not close).
 * The sender treats "unspent" as: the note stays RESERVED, and solanaSettleReserved settles it on a later pass (the marks
 * are read at finalized, so a spend that just landed shows up a few seconds on) or frees it once block time on both
 * RPCs is past its deadline with no spent mark. minSlots: each RPC's reads at or past it (minContextSlot). cache: marks
 * read on both RPCs before (a mark is never closed or rewritten), not read again; set to this read's marks.
 */
export async function solanaSettleSpent(a: { seed64: Uint8Array; notes: NoteStore; noteId: string; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; lister: SolanaRpc; signal?: AbortSignal; minSlots?: readonly [number, number]; cache?: { marks?: SolanaMarks }; /** tests only */ lagWait?: SolanaLagWait }): Promise<SolanaSettled> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  const scope = solanaPoolOf(a.program).scope;
  const note = await a.notes.get(a.noteId);
  if (note === undefined || note.leaf === undefined || note.scope !== scope) throw new Error(`note ${a.noteId}: not a landed note of this pool`);
  const marks = await solanaMarksListed(a.lister, a.rpcs, a.program, a.signal, a.minSlots, a.lagWait, a.cache?.marks);
  if (a.cache !== undefined) a.cache.marks = marks;
  const leaves = await solanaTreeSync(a.rpcs, a.program, a.lagWait).leaves(marks.slot, a.signal);
  // review P2-1 and P1 of 369a87a8: no decision on a list alone; each RPC's own pages, publicnode's among them on mainnet
  solanaMarkCounts(marks, leaves.counts);
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

/** What one pass over the pool's RESERVED notes did with each: settled spent (its change written, the note SPENT),
 *  freed (RESERVED -> UNSPENT) or held (RESERVED, read again on the next pass). */
export type SolanaReservedPass = { spent: string[]; freed: string[]; held: string[] };

/**
 * Every RESERVED note of the Solana pool, settled (card signpage-pool-buy fold 1): the one path that ends a RESERVED
 * Solana pool note, whatever its send did (filled, refused by the helper or the chain, never answered, sent by a page
 * that died). Run on each of the signing page's state reads while such a note is open.
 * - First each RPC's finalized slot and its block time; then, per note, solanaSettleSpent with the marks listed and read
 *   on each RPC at or past that slot. A release lands only while the Clock's unix_timestamp * 1000 is at most deadline_ms
 *   (contracts/pool-solana src/release.rs:179-183, row 2), so once both RPCs' finalized block time is past deadline_ms,
 *   any release of the note is in a block before the ones whose time was read, and so in both marks reads that follow.
 *   That rests on two facts of the Solana validator, read in agave at 8fcd3dde0442c47e0ef0caa1fdee8400eb480181 (master,
 *   4 Nov 2026), https://github.com/anza-xyz/agave/blob/8fcd3dde0442c47e0ef0caa1fdee8400eb480181/<path>#L<line>:
 *   (1) the Clock's unix_timestamp never decreases from a bank to its child: runtime/src/bank.rs:2567-2574
 *       (update_clock: an estimate below the ancestor's unix_timestamp is raised to it); under Alpenglow the footer's
 *       time must be at least the parent's + 1 ns (runtime/src/block_component_processor.rs:715-742
 *       enforce_nanosecond_clock_bounds, :774 nanosecond_time_bounds), and the Clock takes it in whole seconds
 *       (runtime/src/bank.rs:3659, :3674);
 *   (2) getBlockTime(slot) is that bank's Clock unix_timestamp: rpc/src/rpc.rs:1742-1773 (get_block_time: a rooted
 *       slot's from the blockstore, which rpc/src/transaction_status_service.rs:385 writes as
 *       bank.clock().unix_timestamp; a newer slot's from bank.clock().unix_timestamp, :1769).
 * - A spent mark (listed, and read with the same bytes on both RPCs): settled through solanaSettleSpent, whose change both
 *   RPCs' pages must hold; a mark whose change is not yet on both is held, never freed. Marks that do not count each
 *   RPC's own pages with no hole (solanaMarkCounts) hold every note.
 * - No spent mark, and the lower of the two block times past deadline_ms: RESERVED -> UNSPENT (the store's own rule,
 *   blockTimeMs past deadline_ms), so the queue proves the note again. Before that the note is held: its send may still
 *   be in flight.
 * - A read or write that fails holds that note; the others still run. Nothing here names a note to an RPC.
 */
export async function solanaSettleReserved(a: { seed64: Uint8Array; notes: NoteStore; program: string; rpcs: readonly [SolanaRpc, SolanaRpc]; lister: SolanaRpc; signal?: AbortSignal; cache?: { marks?: SolanaMarks }; /** tests only */ lagWait?: SolanaLagWait }): Promise<SolanaReservedPass> {
  const scope = solanaPoolOf(a.program).scope;
  const out: SolanaReservedPass = { spent: [], freed: [], held: [] };
  const reserved = (await a.notes.list()).filter((n) => n.scope === scope && n.state === "RESERVED");
  if (reserved.length === 0) return out;
  const times = await solanaFinalTimes(a.rpcs, a.signal);
  const timeMs = times[0].ms < times[1].ms ? times[0].ms : times[1].ms;
  const minSlots = [times[0].slot, times[1].slot] as const;
  // the marks read for one note are not read again for the next (a mark is never closed or rewritten)
  const cache = a.cache ?? {};
  for (const n of reserved) {
    try {
      const s = await solanaSettleSpent({ seed64: a.seed64, notes: a.notes, noteId: n.id, program: a.program, rpcs: a.rpcs, lister: a.lister, signal: a.signal, minSlots, cache, lagWait: a.lagWait });
      if (s.kind === "spent") out.spent.push(n.id);
      else if (n.deadlineMs !== undefined && timeMs > n.deadlineMs) {
        await a.notes.move(n.id, "RESERVED", "UNSPENT", { blockTimeMs: timeMs });
        out.freed.push(n.id);
      } else out.held.push(n.id);
    } catch {
      out.held.push(n.id);
    }
  }
  return out;
}
