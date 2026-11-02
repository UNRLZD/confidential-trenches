// The Solana pool as a pool of the proof queue (card notes-per-pool-sol; architecture v2, M349-M352). It implements
// ./pool.ts with the rules of contracts/pool-solana, read from its source:
//
// - scope: keccak256(borsh(SCOPE_TAG, program, pool, the wrapped-SOL mint)) mod p (src/context.rs scope_of), with the
//   pool at the program's PDA ["pool"] (src/deposit.rs init).
// - W: W_{sol, l, j}, base58 of its ed25519 public key; bind refuses an address that is not that.
// - now: the newest finalized block's time on each of two RPCs (getSlot finalized, then getBlockTime), the lower one, in
//   ms. The program's own time is the Clock's unix_timestamp, whole seconds, and a release is refused once
//   unix_timestamp * 1000 is past deadline_ms (src/release.rs row 2).
// - trees(beforeMs), duty 2 of pool.ts: the pages ["page", tree, page_no u32 LE] of both trees, read whole on two RPCs
//   at finalized commitment. Each entry is (leaf, root, unix_timestamp i64 LE) in insert order (src/state.rs); the cut
//   keeps the entries with unix_timestamp * 1000 below beforeMs. It refuses when either RPC's read is at a block whose
//   time is below beforeMs (a later insert could still land under the cut), when the two cuts differ in any byte, when
//   times go back, and when the root the device builds from the cut's leaves is not the root the page holds at the
//   cut's last entry: the root the program reads by index at the tap.
// - bind: the program's context (src/context.rs context_of): keccak256(program ‖ pool ‖ W ‖ fee payer ‖ relay_fee_cap
//   u64 LE ‖ tip_cap u64 LE ‖ deadline_ms u64 LE ‖ salt (16) ‖ scope_be32) mod p. relay_fee_cap is the relayer's epoch
//   fee itself (duty 1: one fee per epoch for every user, on a 100,000-lamport step); tip_cap is this file's one
//   constant; the fee payer is the one the device was given, never the helper's word; deadline_ms is the epoch grid's.
//   Every one of them is public at the tap (the release's data carries them), so none may differ between users.
// - The fee bound, "never sign on a server's word": the device reads on two RPCs the rent of an empty account and of a
//   72-byte one and the base fee of a two-signature message, which must agree, and computes the fee payer's cost of an
//   ordinary release, the spent mark rent(0) + the change entry's growth rent(72) - rent(0) + the base fee, 1,026,000
//   lamports at mainnet rent (release.rs row 8, M352 (1)). It refuses a fee below that cost, off the step, or above the
//   cost rounded up to the step plus SOL_FEE_HEADROOM (two steps: W's priority fee and the one release in 1,024 whose
//   change opens a page, which the helper carries). At mainnet rent the bound is 1,300,000 lamports.
// - The chunk: the program pays W chunk - fee - tip, and the runtime refuses a W left under rent(0); the backstop needs
//   2 x fee at most the chunk. bind refuses a chunk where either fails at the fee and the tip cap.
// - No refund note: the release pays W in the same transaction (lib.rs), so refundPrecommitment is not bound.
// - Epochs of 60 s (the helper's grid, apps/helper pool/fee.ts) and a life of 2E + 30 s + 2 TAKE_SLACK_MS = 180 s: the
//   relayer sends at once and a Solana transaction lands or expires within its blockhash's ~60-90 s, so 30 s of margin.
// Nothing here holds a secret: the reads name only the pool's own accounts, never a note or a wallet of the user's
// (the fee read's message names W's address and the fee payer; it is the same shape for every user and is made at bind,
// when W's address is already bound to be public at the tap).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { VAULT_FIELD_P, VaultTree, type SolanaRpc } from "@blindfill/kit";
import type { Ladder } from "./ladder.ts";
import { TAKE_SLACK_MS, type Pool, type PoolTrees } from "./pool.ts";

/** SOL's ladder: one = 0.001 SOL (the program's MIN_DEPOSIT), from 0.01 SOL [design: the owner's $2 floor, OD:268, in kind]. */
export const SOL_LADDER: Ladder = Object.freeze({ one: 1_000_000n, min: 10_000_000n });
export const SOL_EPOCH_MS = 60_000n;
export const SOL_SEND_MARGIN_MS = 30_000n;
export const SOL_LIFE_MS = 2n * SOL_EPOCH_MS + SOL_SEND_MARGIN_MS + 2n * TAKE_SLACK_MS;
/** The relayer's fee step, lamports (M352 (1); apps/helper pool/fee.ts POOL_FEE_STEP). */
export const SOL_FEE_STEP = 100_000n;
/** What the device allows above the ordinary release's cost rounded up to the step: two steps. */
export const SOL_FEE_HEADROOM = 2n * SOL_FEE_STEP;
/** The most a landing tip may take from a chunk, lamports: one value for every user, since the release's data shows it. */
export const SOL_TIP_CAP = 1_000_000n;
/** The program's backstop: relay_fee x 10,000 at most withdrawnValue x 5,000 (lib.rs MAX_RELAY_FEE_BPS). */
const MAX_RELAY_FEE_BPS = 5_000n;

export const SOL_SCOPE_TAG = "blindfill-pool-solana-v1";
export const SOL_NATIVE_MINT = "So11111111111111111111111111111111111111112";
export const SOL_PAGE_ENTRIES = 1024;
const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_DISC = new TextEncoder().encode("bfpage01");
const TREE_STATE = 0;
const TREE_LABEL = 1;
/** Accounts per getMultipleAccounts (the RPC's limit is 100). */
const BATCH = 50;
const U64 = (1n << 64n) - 1n;

const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};
const u32le = (n: number): Uint8Array => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const u64le = (x: bigint): Uint8Array => {
  if (typeof x !== "bigint" || x < 0n || x > U64) throw new Error("not a u64");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
};
const be32 = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const beInt = (b: Uint8Array): bigint => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
const fieldOf = (...parts: Uint8Array[]): bigint => beInt(keccak_256(cat(...parts))) % VAULT_FIELD_P;
const key32 = (s: string, what: string): Uint8Array => {
  let b: Uint8Array;
  try {
    b = base58.decode(s);
  } catch {
    throw new Error(`${what}: not base58`);
  }
  if (b.length !== 32) throw new Error(`${what}: not 32 bytes`);
  return b;
};
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether 32 bytes decode to a point of ed25519 (curve25519-dalek's decompress, which Solana's is_on_curve uses). */
function onCurve(b: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(b, true);
    return true;
  } catch {
    return false;
  }
}

/** Solana's find_program_address: the first bump from 255 down whose sha256(seeds ‖ bump ‖ program ‖ marker) is off the curve. */
export function solanaPda(seeds: readonly Uint8Array[], program: Uint8Array): { address: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(cat(...seeds, Uint8Array.of(bump), program, enc.encode("ProgramDerivedAddress")));
    if (!onCurve(h)) return { address: h, bump };
  }
  throw new Error("no program address");
}

/** The pool's address and scope, as the program computes them (deposit.rs init, context.rs scope_of). */
export function solanaPoolOf(program: string): { pool: string; scope: bigint } {
  const p = key32(program, "program");
  const pool = solanaPda([enc.encode("pool")], p).address;
  const scope = fieldOf(u32le(SOL_SCOPE_TAG.length), enc.encode(SOL_SCOPE_TAG), p, pool, base58.decode(SOL_NATIVE_MINT));
  return { pool: base58.encode(pool), scope };
}

/** The page holding leaf `pageNo * 1,024` onward of one tree (0 state, 1 label). */
export function solanaPageOf(program: string, tree: 0 | 1, pageNo: number): string {
  return base58.encode(solanaPda([enc.encode("page"), Uint8Array.of(tree), u32le(pageNo)], key32(program, "program")).address);
}

/** The fields a release carries that its context hashes (context.rs ContextFields), as the device sends them at the tap. */
export type SolanaReleaseRequest = {
  program: string;
  pool: string;
  /** W, base58 */
  recipient: string;
  feePayer: string;
  /** the relay fee the tap sends: the epoch's fee, equal to the cap */
  relayFee: bigint;
  relayFeeCap: bigint;
  tipCap: bigint;
  deadlineMs: bigint;
  /** 16 bytes, hex */
  salt: string;
};

/** The program's context of a release (context.rs context_of), from the request fields and the scope. */
export function solanaContextOf(r: SolanaReleaseRequest, scope: bigint): bigint {
  const salt = Uint8Array.from((r.salt.match(/^[0-9a-f]{32}$/) ? r.salt.match(/../g)! : []).map((h) => parseInt(h, 16)));
  if (salt.length !== 16) throw new Error("salt: not 16 bytes of lowercase hex");
  return fieldOf(
    key32(r.program, "program"),
    key32(r.pool, "pool"),
    key32(r.recipient, "recipient"),
    key32(r.feePayer, "feePayer"),
    u64le(r.relayFeeCap),
    u64le(r.tipCap),
    u64le(r.deadlineMs),
    salt,
    be32(scope),
  );
}

/** GET /v1/pool/fee's answer for a Solana pool (apps/helper pool/fee.ts PoolFeeAnswer). */
export type SolanaFeeAnswer = { chain: string; program: string; pool: string; fee_payer: string; epoch_ms: number; epoch_start_ms: number; fee: string; step: string };

/** The rent and base fee reads the fee bound comes from, as both RPCs agreed. */
export type SolanaCostReads = { rent0: bigint; rent72: bigint; baseFee: bigint };

/** The fee payer's cost of an ordinary release and the most the device lets a relayer charge, from the reads. */
export function solanaFeeBound(c: SolanaCostReads): { cost: bigint; bound: bigint } {
  const cost = c.rent0 + (c.rent72 - c.rent0) + c.baseFee;
  return { cost, bound: ((cost + SOL_FEE_STEP - 1n) / SOL_FEE_STEP) * SOL_FEE_STEP + SOL_FEE_HEADROOM };
}

export type SolanaPoolArgs = {
  /** The pool program's id, base58 (one per cluster: lib.rs deploy rule). */
  program: string;
  /** Two RPCs of different operators on the pool's cluster. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The relayer's fee payer, base58, pinned on the device: the proof binds it, so it is never the helper's word. */
  feePayer: string;
  /** GET /v1/pool/fee?pool=&epoch= on the helper: its answer, refused unless every field is this pool's. */
  relayFee: (epochStartMs: bigint, signal?: AbortSignal) => Promise<SolanaFeeAnswer>;
  /** tests only: the salt source (16 random bytes unless given) */
  salt?: () => Uint8Array;
};

type Rpcs = readonly [SolanaRpc, SolanaRpc];
const FINAL = { commitment: "finalized" } as const;

async function both<T>(rpcs: Rpcs, f: (rpc: SolanaRpc, k: number) => Promise<T>, signal?: AbortSignal): Promise<[T, T]> {
  signal?.throwIfAborted();
  const r = await Promise.all([f(rpcs[0], 0), f(rpcs[1], 1)]);
  signal?.throwIfAborted();
  return r;
}

const int = (x: unknown, what: string): number => {
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new Error(`${what}: not a whole number`);
  return x as number;
};

/** One RPC's finalized slot and its block time, ms. */
async function finalTime(rpc: SolanaRpc, slot?: number): Promise<{ slot: number; ms: bigint }> {
  const s = slot ?? int(await rpc("getSlot", [FINAL]), "getSlot");
  const t = await rpc("getBlockTime", [s]);
  return { slot: s, ms: BigInt(int(t, `getBlockTime(${s})`)) * 1000n };
}

/** One page entry, as stored. */
type Entry = { leaf: bigint; root: bigint; t: bigint; bytes: Uint8Array };

function decodePage(raw: unknown, program: string, tree: number, pageNo: number, what: string): Entry[] | null {
  if (raw === null) return null;
  const a = raw as { owner?: unknown; data?: unknown };
  if (a?.owner !== program) throw new Error(`${what}: not the program's account`);
  if (!Array.isArray(a.data) || a.data[1] !== "base64" || typeof a.data[0] !== "string") throw new Error(`${what}: not base64 data`);
  const d = base64.decode(a.data[0]);
  if (d.length < PAGE_HEADER || (d.length - PAGE_HEADER) % PAGE_ENTRY !== 0) throw new Error(`${what}: not a page's length`);
  if (!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree || !same(d.subarray(9, 13), u32le(pageNo))) throw new Error(`${what}: not page ${pageNo} of tree ${tree}`);
  const n = (d.length - PAGE_HEADER) / PAGE_ENTRY;
  if (n === 0 || n > SOL_PAGE_ENTRIES) throw new Error(`${what}: ${n} entries`);
  const out: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const e = d.subarray(PAGE_HEADER + i * PAGE_ENTRY, PAGE_HEADER + (i + 1) * PAGE_ENTRY);
    const t = new DataView(e.buffer, e.byteOffset + 64, 8).getBigInt64(0, true);
    out.push({ leaf: beInt(e.subarray(0, 32)), root: beInt(e.subarray(32, 64)), t: t * 1000n, bytes: e.slice() });
  }
  return out;
}

/**
 * One RPC's cut of both trees: every entry whose time is below beforeMs, in insert order, and the lowest slot it read
 * at. Pages are read in order until one is missing, short, or holds an entry at or past beforeMs.
 */
async function readCut(rpc: SolanaRpc, program: string, beforeMs: bigint, signal?: AbortSignal): Promise<{ cut: [Entry[], Entry[]]; slot: number }> {
  const cut: [Entry[], Entry[]] = [[], []];
  const open = [true, true];
  let slot = Number.MAX_SAFE_INTEGER;
  for (let from = 0; open[0] || open[1]; from += BATCH / 2) {
    signal?.throwIfAborted();
    const want: { tree: 0 | 1; pageNo: number }[] = [];
    for (const tree of [TREE_STATE, TREE_LABEL] as const) if (open[tree]) for (let k = from; k < from + BATCH / 2; k++) want.push({ tree, pageNo: k });
    const a = (await rpc("getMultipleAccounts", [want.map((w) => solanaPageOf(program, w.tree, w.pageNo)), { ...FINAL, encoding: "base64" }])) as { context?: { slot?: unknown }; value?: unknown };
    slot = Math.min(slot, int(a?.context?.slot, "getMultipleAccounts context slot"));
    const got = a?.value;
    if (!Array.isArray(got) || got.length !== want.length) throw new Error("getMultipleAccounts: not one answer per page");
    want.forEach((w, i) => {
      if (!open[w.tree]) return;
      const page = decodePage(got[i], program, w.tree, w.pageNo, `page ${w.pageNo} of tree ${w.tree}`);
      if (page === null) return void (open[w.tree] = false);
      const into = cut[w.tree];
      if (into.length !== w.pageNo * SOL_PAGE_ENTRIES) throw new Error(`page ${w.pageNo} of tree ${w.tree}: the page before it is not full`);
      for (const e of page) {
        if (into.length > 0 && e.t < into[into.length - 1]!.t) throw new Error(`tree ${w.tree}: a time goes back at leaf ${into.length}`);
        if (e.t >= beforeMs) return void (open[w.tree] = false);
        into.push(e);
      }
      if (page.length < SOL_PAGE_ENTRIES) open[w.tree] = false;
    });
  }
  return { cut, slot };
}

/** The pool's two trees cut at beforeMs, read on two RPCs that agree on every entry, each read at or past beforeMs. */
export async function solanaPoolTrees(rpcs: Rpcs, program: string, beforeMs: bigint, signal?: AbortSignal): Promise<PoolTrees> {
  if (typeof beforeMs !== "bigint" || beforeMs <= 0n) throw new Error("beforeMs: a bigint above 0");
  const reads = await both(rpcs, async (rpc, k) => {
    const r = await readCut(rpc, program, beforeMs, signal);
    // every leaf under the cut is final only once the block read at is at or past beforeMs: a later block's time is too
    const { ms } = await finalTime(rpc, r.slot);
    if (ms < beforeMs) throw new Error(`rpc ${k}: its read at slot ${r.slot} (${ms} ms) has not reached ${beforeMs}`);
    return r.cut;
  }, signal);
  const trees: VaultTree[] = [];
  const roots: bigint[] = [];
  for (const tree of [TREE_STATE, TREE_LABEL]) {
    const [x, y] = [reads[0][tree]!, reads[1][tree]!];
    if (x.length !== y.length || !x.every((e, i) => same(e.bytes, y[i]!.bytes))) throw new Error(`tree ${tree}: the two RPCs differ`);
    if (x.length === 0) throw new Error(`tree ${tree}: no leaf before ${beforeMs}`);
    const t = new VaultTree(x.map((e) => e.leaf));
    if (t.root !== x[x.length - 1]!.root) throw new Error(`tree ${tree}: the root built from the leaves is not the page's root at leaf ${x.length - 1}`);
    trees.push(t);
    roots.push(t.root);
  }
  return { stateTree: trees[0]!, labelTree: trees[1]!, stateRoot: roots[0]!, labelRoot: roots[1]! };
}

/** The pool's time: the lower of two RPCs' finalized block times, ms. */
export async function solanaNow(rpcs: Rpcs, signal?: AbortSignal): Promise<bigint> {
  const [a, b] = await both(rpcs, (rpc) => finalTime(rpc), signal);
  return a.ms < b.ms ? a.ms : b.ms;
}

// A legacy message of two signers (fee payer, W) and no instruction: getFeeForMessage prices its base fee
function feeMessage(feePayer: Uint8Array, w: Uint8Array, blockhash: Uint8Array): string {
  return base64.encode(cat(Uint8Array.of(2, 0, 0, 2), feePayer, w, blockhash, Uint8Array.of(0)));
}

/** Rent of 0 and 72 bytes and the base fee of a two-signature message, read on two RPCs, which must agree. */
export async function solanaCostReads(rpcs: Rpcs, feePayer: string, w: string, signal?: AbortSignal): Promise<SolanaCostReads> {
  const fp = key32(feePayer, "feePayer");
  const wk = key32(w, "W");
  const [a, b] = await both(rpcs, async (rpc, k) => {
    const rent0 = int(await rpc("getMinimumBalanceForRentExemption", [0, FINAL]), `rpc ${k} rent(0)`);
    const rent72 = int(await rpc("getMinimumBalanceForRentExemption", [PAGE_ENTRY, FINAL]), `rpc ${k} rent(72)`);
    const bh = (await rpc("getLatestBlockhash", [FINAL])) as { value?: { blockhash?: unknown } };
    if (typeof bh?.value?.blockhash !== "string") throw new Error(`rpc ${k}: getLatestBlockhash: no blockhash`);
    const f = (await rpc("getFeeForMessage", [feeMessage(fp, wk, key32(bh.value.blockhash, "blockhash")), FINAL])) as { value?: unknown };
    return { rent0: BigInt(rent0), rent72: BigInt(rent72), baseFee: BigInt(int(f?.value, `rpc ${k} getFeeForMessage`)) };
  }, signal);
  if (a.rent0 !== b.rent0 || a.rent72 !== b.rent72 || a.baseFee !== b.baseFee) throw new Error("the two RPCs' rent or base fee differ");
  if (a.rent72 < a.rent0) throw new Error("rent(72) is below rent(0)");
  return a;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function solanaPool(a: SolanaPoolArgs): Pool<SolanaReleaseRequest> {
  if (!Array.isArray(a.rpcs) || a.rpcs.length !== 2 || typeof a.rpcs[0] !== "function" || typeof a.rpcs[1] !== "function") throw new Error("rpcs: two");
  if (a.rpcs[0].url !== undefined && a.rpcs[0].url === a.rpcs[1].url) throw new Error("rpcs: one URL twice is one read");
  key32(a.feePayer, "feePayer");
  const { program, feePayer } = a;
  const { pool, scope } = solanaPoolOf(program);
  if (feePayer === pool) throw new Error("feePayer: the pool");
  return {
    id: `sol:${program}`,
    chain: "sol",
    scope,
    ladder: SOL_LADDER,
    epochMs: SOL_EPOCH_MS,
    lifeMs: SOL_LIFE_MS,
    sendMarginMs: SOL_SEND_MARGIN_MS,
    now: (signal) => solanaNow(a.rpcs, signal),
    trees: (beforeMs, signal) => solanaPoolTrees(a.rpcs, program, beforeMs, signal),
    async bind({ chunk, wallet, epochStartMs, deadlineMs }, signal) {
      if (!(wallet.publicKey instanceof Uint8Array) || wallet.publicKey.length !== 32 || wallet.address !== base58.encode(wallet.publicKey))
        throw new Error("wallet: a Solana W is base58 of its ed25519 public key");
      if (wallet.address === pool || wallet.address === feePayer) throw new Error("wallet: W is the pool or the fee payer");
      if (typeof chunk !== "bigint" || chunk <= 0n || chunk > U64) throw new Error("chunk: a u64 above 0");
      if (typeof epochStartMs !== "bigint" || epochStartMs % SOL_EPOCH_MS !== 0n) throw new Error("epochStartMs: not on the epoch grid");
      const nowMs = await solanaNow(a.rpcs, signal);
      if (typeof deadlineMs !== "bigint" || deadlineMs !== epochStartMs + SOL_LIFE_MS || deadlineMs <= nowMs + SOL_SEND_MARGIN_MS)
        throw new Error("deadlineMs: not on the epoch grid, or too close to send");
      const f = await a.relayFee(epochStartMs, signal);
      if (f?.chain !== "solana" || f.program !== program || f.pool !== pool || f.fee_payer !== feePayer) throw new Error("relayFee: not this pool's or this fee payer's answer");
      if (f.epoch_ms !== Number(SOL_EPOCH_MS) || f.epoch_start_ms !== Number(epochStartMs) || f.step !== SOL_FEE_STEP.toString()) throw new Error("relayFee: not this epoch's, or not on the step");
      if (typeof f.fee !== "string" || !/^[1-9][0-9]{0,18}$/.test(f.fee)) throw new Error("relayFee: not whole lamports");
      const fee = BigInt(f.fee);
      if (fee % SOL_FEE_STEP !== 0n) throw new Error("relayFee: off the 100,000-lamport step");
      const reads = await solanaCostReads(a.rpcs, feePayer, wallet.address, signal);
      const { cost, bound } = solanaFeeBound(reads);
      if (fee < cost) throw new Error(`relayFee: ${fee} is below a release's cost ${cost}`);
      if (fee > bound) throw new Error(`relayFee: ${fee} is above the device's bound ${bound}`);
      if (fee * 10_000n > chunk * MAX_RELAY_FEE_BPS) throw new Error("chunk: under the program's backstop at this fee");
      if (chunk - fee - SOL_TIP_CAP < reads.rent0) throw new Error("chunk: W would end under rent(0) at this fee and the tip cap");
      const salt = (a.salt ?? (() => crypto.getRandomValues(new Uint8Array(16))))();
      if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error("salt: not 16 bytes");
      const request: SolanaReleaseRequest = { program, pool, recipient: wallet.address, feePayer, relayFee: fee, relayFeeCap: fee, tipCap: SOL_TIP_CAP, deadlineMs, salt: hex(salt) };
      return { context: solanaContextOf(request, scope), feeCap: fee, request };
    },
  };
}
