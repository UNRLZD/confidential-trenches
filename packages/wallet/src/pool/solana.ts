// The Solana pool as a pool of the proof queue (card notes-per-pool-sol; architecture v2, M349-M352). It implements
// ./pool.ts with the rules of contracts/pool-solana, read from its source:
//
// - scope: keccak256(borsh(SCOPE_TAG, program, pool, the wrapped-SOL mint)) mod p (src/context.rs scope_of), with the
//   pool at the program's PDA ["pool"] (src/deposit.rs init).
// - W: W_{sol, l, j}, base58 of its ed25519 public key; bind refuses an address that is not that.
// - now: the newest finalized block's time on each of two RPCs (getSlot finalized, then getBlockTime), the lower one, in
//   ms. The program's own time is the Clock's unix_timestamp, whole seconds, and a release is refused once
//   unix_timestamp * 1000 is past deadline_ms (src/release.rs row 2).
// - trees(beforeMs), duty 2 of pool.ts: the pages ["page", tree, page_no u32 LE] of both trees, read on two RPCs at
//   finalized commitment and kept once both agree (finalized entries never change): a full page is read once, and each
//   call reads the newest page held and any after it, refusing one whose entries held before have changed. Each entry is (leaf, root, unix_timestamp i64 LE) in insert order (src/state.rs); the cut
//   keeps the entries with unix_timestamp * 1000 below beforeMs. It refuses when either RPC's read is at a block whose
//   time is below beforeMs (a later insert could still land under the cut), when the two cuts differ in any byte, when
//   times go back, and when the root the device builds from the cut's leaves is not the root the page holds at the
//   cut's last entry: the root the program reads by index at the tap.
// - bind: the program's context (src/context.rs context_of): keccak256(program ‖ pool ‖ W ‖ fee payer ‖ relay_fee_cap
//   u64 LE ‖ tip_cap u64 LE ‖ deadline_ms u64 LE ‖ salt (16) ‖ scope_be32) mod p. relay_fee_cap is the relayer's epoch
//   fee itself (duty 1: one fee per epoch for every user, on a 100,000-lamport step); tip_cap is this file's one
//   constant; the fee payer is the one the device was given, never the helper's word; deadline_ms is the epoch grid's.
//   Every one of them is public at the tap (the release's data carries them), so none may differ between users.
// - The epoch fee, "never sign on a server's word" (M355 (2)): the device computes it itself, once per epoch, from the
//   Rent sysvar and the base fee read on two RPCs that must agree: the kit's solanaPoolReleaseCost (the spent mark's
//   rent(8), the change note's 72-byte entry, two signatures), 1,066,640 lamports at mainnet rent, rounded up to the
//   100,000 step, plus two steps, the kit's solanaPoolFee: 1,300,000 at mainnet rent. W's priority budget is that less
//   the cost and the page reserve (solanaPoolPriorityBudget, M356 (5)), 232,645. The kit holds the one definition the
//   helper imports too (M356 (6)). The helper's
//   answer must be exactly that fee, or bind refuses: a fee the helper could pick per request would mark one user. The
//   base fee is read with a fixed message whose two signers are the pool and the fee payer (M355 (1)): no read names W.
// - The chunk: the program pays W chunk - fee - tip, and the runtime refuses a W left under rent(0); the backstop needs
//   2 x fee at most the chunk. bind refuses a chunk where either fails at the fee and the tip cap.
// - No refund note: the release pays W in the same transaction (lib.rs), so refundPrecommitment is not bound.
// - Epochs of 60 s (the helper's grid, apps/helper pool/fee.ts) and a life of 2E + 90 s + 2 TAKE_SLACK_MS = 240 s: the
//   kit's send margin SOLANA_POOL_SEND_MARGIN_MS is 90 s (M356 (1)), longer than a blockhash lives (150 blocks, ~60 s),
//   so a send the device hands out lands or expires before its deadline; the helper refuses a deadline under it too.
// - A deposit's own note proves at once on the newest root (pool.ts): that read is at confirmed on both RPCs, and is
//   never kept; epoch roots stay finalized (M355 (5)). A rollback under a confirmed root only fails that one send.
// - Two RPCs are two providers: the kit's solanaSameProvider refuses one passed twice, by function or by URL.
// Nothing here holds a secret, and no read names a note or a wallet of the user's: only the pool's own accounts.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { readSolanaRent, SOLANA_POOL_FEE_STEP, SOLANA_POOL_SEND_MARGIN_MS, solanaPoolFee, solanaPoolReleaseCost, solanaRentMin, solanaSameProvider, VAULT_FIELD_P, VaultTree, type SolanaRent, type SolanaRpc } from "@blindfill/kit";
import type { Ladder } from "./ladder.ts";
import { TAKE_SLACK_MS, type Pool, type PoolTrees } from "./pool.ts";

/** SOL's ladder: one = 0.001 SOL (the program's MIN_DEPOSIT), from 0.01 SOL [design: the owner's $2 floor, OD:268, in kind]. */
export const SOL_LADDER: Ladder = Object.freeze({ one: 1_000_000n, min: 10_000_000n });
export const SOL_EPOCH_MS = 60_000n;
/** The kit's send margin (M356 (1)): 90 s. */
export const SOL_SEND_MARGIN_MS = SOLANA_POOL_SEND_MARGIN_MS;
export const SOL_LIFE_MS = 2n * SOL_EPOCH_MS + SOL_SEND_MARGIN_MS + 2n * TAKE_SLACK_MS;
/** The relayer's fee step, lamports: the kit's (M352 (1), M356 (6)). */
export const SOL_FEE_STEP = SOLANA_POOL_FEE_STEP;
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

/** The fee payer's cost of a release and the epoch fee the device computes from it: the kit's one definition. */
export const solanaEpochFee = (rent: SolanaRent): { cost: bigint; fee: bigint } => ({ cost: solanaPoolReleaseCost(rent), fee: solanaPoolFee(rent) });

/** A cluster's pool, pinned on the device: its program id and the relayer's fee payer, which every proof binds. */
export type SolanaPoolPin = { readonly program: string; readonly feePayer: string };
/** The pinned pools by cluster: pool-sol-deploy writes each one (a fresh program id per cluster, lib.rs deploy rule). */
export const SOL_POOLS: Readonly<Partial<Record<"devnet" | "mainnet", SolanaPoolPin>>> = Object.freeze({});

export type SolanaPoolArgs = {
  /** The cluster's pin (SOL_POOLS[cluster]): the program id and the fee payer, never the helper's word. */
  pin: SolanaPoolPin;
  /** Two RPCs of different operators on the pool's cluster. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
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

/** One slot's block time, ms. */
async function blockTime(rpc: SolanaRpc, slot: number): Promise<{ slot: number; ms: bigint }> {
  const t = await rpc("getBlockTime", [slot]);
  return { slot, ms: BigInt(int(t, `getBlockTime(${slot})`)) * 1000n };
}
/** One RPC's finalized slot and its block time, ms. */
const finalTime = async (rpc: SolanaRpc): Promise<{ slot: number; ms: bigint }> => blockTime(rpc, int(await rpc("getSlot", [FINAL]), "getSlot"));

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

type Commitment = "finalized" | "confirmed";

/**
 * One RPC's read of both trees from page `from[tree]` on: every entry of each page, in insert order, until a page is
 * missing or short, and the lowest slot it read at. The pages before `from` are the sync's, read and agreed before.
 * minContextSlot: the RPC must answer from that slot or a later one (an RPC behind it refuses, never serves older pages).
 */
async function readPages(rpc: SolanaRpc, program: string, from: readonly [number, number], commitment: Commitment, minContextSlot: number, signal?: AbortSignal): Promise<{ pages: [Entry[], Entry[]]; slot: number }> {
  const pages: [Entry[], Entry[]] = [[], []];
  const open = [true, true];
  let slot = Number.MAX_SAFE_INTEGER;
  for (let step = 0; open[0] || open[1]; step += BATCH / 2) {
    signal?.throwIfAborted();
    const want: { tree: 0 | 1; pageNo: number }[] = [];
    for (const tree of [TREE_STATE, TREE_LABEL] as const) if (open[tree]) for (let k = 0; k < BATCH / 2; k++) want.push({ tree, pageNo: from[tree] + step + k });
    const cfg = { commitment, encoding: "base64", ...(minContextSlot > 0 ? { minContextSlot } : {}) };
    const a = (await rpc("getMultipleAccounts", [want.map((w) => solanaPageOf(program, w.tree, w.pageNo)), cfg])) as { context?: { slot?: unknown }; value?: unknown };
    const at = int(a?.context?.slot, "getMultipleAccounts context slot");
    if (at < minContextSlot) throw new Error(`getMultipleAccounts: answered at slot ${at}, below ${minContextSlot}`);
    slot = Math.min(slot, at);
    const got = a?.value;
    if (!Array.isArray(got) || got.length !== want.length) throw new Error("getMultipleAccounts: not one answer per page");
    want.forEach((w, i) => {
      if (!open[w.tree]) return;
      const page = decodePage(got[i], program, w.tree, w.pageNo, `page ${w.pageNo} of tree ${w.tree}`);
      if (page === null) return void (open[w.tree] = false);
      // pages are read in order and a short page closes its tree, so this page follows full ones only
      pages[w.tree].push(...page);
      if (page.length < SOL_PAGE_ENTRIES) open[w.tree] = false;
    });
  }
  return { pages, slot };
}

/** What a trees() call may ask beyond the cut: the newest root of a deposit's own note, read at confirmed (M355 (5)). */
export type SolanaTreesOpts = { newest?: boolean };

/**
 * The pool's tree sync on two RPCs. Every entry read at finalized commitment on both RPCs, and the same on both, is
 * kept: it can never change. A full page is read once; each call reads the newest page the sync holds (it may have
 * grown) and any page after it, on both RPCs, each at or past the slot that RPC last answered at, and refuses a read
 * whose entries already held differ. An RPC whose read stops short of what the sync holds is behind, not changed: its
 * entries must match, and it must still have reached the cut. A newest read (confirmed) is checked the same way and is
 * never kept, since a confirmed block can still be rolled back.
 */
export type SolanaTreeSync = {
  trees(beforeMs: bigint, signal?: AbortSignal, opts?: SolanaTreesOpts): Promise<PoolTrees>;
  /** Every leaf of both trees both RPCs agree on, each RPC read at or past minContextSlot (a restore's marks' slot). */
  leaves(minContextSlot: number, signal?: AbortSignal): Promise<{ state: bigint[]; label: bigint[] }>;
};

export function solanaTreeSync(rpcs: readonly [SolanaRpc, SolanaRpc], program: string): SolanaTreeSync {
  checkSolanaRpcs(rpcs);
  const held: [Entry[], Entry[]] = [[], []];
  const lastSlot = [0, 0];
  // beforeMs null: no cut, no reached check, every agreed entry
  async function run(beforeMs: bigint | null, commitment: Commitment, minSlot: number, signal?: AbortSignal): Promise<Entry[][]> {
    const base = [held[0], held[1]] as const;
    const from = [Math.floor(base[0].length / SOL_PAGE_ENTRIES), Math.floor(base[1].length / SOL_PAGE_ENTRIES)] as const;
    const reads = await both(rpcs, async (rpc, k) => {
      const r = await readPages(rpc, program, from, commitment, Math.max(minSlot, lastSlot[k]!), signal);
      // every leaf under the cut is in only once the block read at is at or past beforeMs: a later block's time is too
      if (beforeMs !== null) {
        const { ms } = await blockTime(rpc, r.slot);
        if (ms < beforeMs) throw new Error(`rpc ${k}: its read at slot ${r.slot} (${ms} ms) has not reached ${beforeMs}`);
      }
      return r;
    }, signal);
    const next: Entry[][] = [];
    const cuts: Entry[][] = [];
    for (const tree of [TREE_STATE, TREE_LABEL]) {
      const kept = base[tree]!;
      const start = from[tree]! * SOL_PAGE_ENTRIES;
      const lists = reads.map(({ pages }) => {
        const fresh = pages[tree]!;
        // the entries held past the last full page were read before: a later read that holds them holds them unchanged
        for (let i = start; i < kept.length && i - start < fresh.length; i++)
          if (!same(fresh[i - start]!.bytes, kept[i]!.bytes)) throw new Error(`tree ${tree}: page ${Math.floor(i / SOL_PAGE_ENTRIES)} changed since it was read`);
        return [...kept.slice(0, start), ...fresh];
      });
      const [x, y] = lists as [Entry[], Entry[]];
      const common = Math.min(x.length, y.length);
      for (let i = start; i < common; i++) if (!same(x[i]!.bytes, y[i]!.bytes)) throw new Error(`tree ${tree}: the two RPCs differ at leaf ${i}`);
      for (const l of lists) for (let i = Math.max(1, start); i < l.length; i++) if (l[i]!.t < l[i - 1]!.t) throw new Error(`tree ${tree}: a time goes back at leaf ${i}`);
      const agreed = x.slice(0, common);
      next.push(agreed);
      if (beforeMs === null) continue;
      // the cut: every entry below beforeMs, which both RPCs must hold, since both read past beforeMs
      let n = 0;
      while (n < agreed.length && agreed[n]!.t < beforeMs) n++;
      if ((x.length > n && x[n]!.t < beforeMs) || (y.length > n && y[n]!.t < beforeMs)) throw new Error(`tree ${tree}: the two RPCs differ below the cut`);
      if (n === 0) throw new Error(`tree ${tree}: no leaf before ${beforeMs}`);
      cuts.push(agreed.slice(0, n));
    }
    if (commitment === "finalized") {
      // a slower call that read less never shrinks what a faster one kept
      for (const tree of [TREE_STATE, TREE_LABEL]) if (next[tree]!.length > held[tree]!.length) held[tree] = next[tree]!;
      reads.forEach((r, k) => (lastSlot[k] = Math.max(lastSlot[k]!, r.slot)));
    }
    return beforeMs === null ? next : cuts;
  }
  return {
    async trees(beforeMs, signal, opts) {
      if (typeof beforeMs !== "bigint" || beforeMs <= 0n) throw new Error("beforeMs: a bigint above 0");
      const out = (await run(beforeMs, opts?.newest === true ? "confirmed" : "finalized", 0, signal)).map((cut, tree) => {
        const t = new VaultTree(cut.map((e) => e.leaf));
        if (t.root !== cut[cut.length - 1]!.root) throw new Error(`tree ${tree}: the root built from the leaves is not the page's root at leaf ${cut.length - 1}`);
        return { tree: t, root: t.root };
      });
      return { stateTree: out[0]!.tree, labelTree: out[1]!.tree, stateRoot: out[0]!.root, labelRoot: out[1]!.root };
    },
    async leaves(minContextSlot, signal) {
      if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0) throw new Error("minContextSlot: a slot");
      const [state, label] = await run(null, "finalized", minContextSlot, signal);
      return { state: state!.map((e) => e.leaf), label: label!.map((e) => e.leaf) };
    },
  };
}

/** One read of the pool's two trees cut at beforeMs (a sync with nothing held). */
export function solanaPoolTrees(rpcs: readonly [SolanaRpc, SolanaRpc], program: string, beforeMs: bigint, signal?: AbortSignal): Promise<PoolTrees> {
  return solanaTreeSync(rpcs, program).trees(beforeMs, signal);
}

/** The pool's time: the lower of two RPCs' finalized block times, ms. */
export async function solanaNow(rpcs: readonly [SolanaRpc, SolanaRpc], signal?: AbortSignal): Promise<bigint> {
  checkSolanaRpcs(rpcs);
  const [a, b] = await both(rpcs, (rpc) => finalTime(rpc), signal);
  return a.ms < b.ms ? a.ms : b.ms;
}

// A legacy message of two signers (the fee payer, then the pool) and no instruction: getFeeForMessage prices its base
// fee. Both signers are public and the same for every user (M355 (1)).
function feeMessage(feePayer: Uint8Array, pool: Uint8Array, blockhash: Uint8Array): string {
  return base64.encode(cat(Uint8Array.of(2, 0, 0, 2), feePayer, pool, blockhash, Uint8Array.of(0)));
}

/** What the kit's release cost takes for two signatures: 5,000 lamports each. */
const SOL_TWO_SIGNATURES = 10_000n;

/** The Rent sysvar (the kit's readSolanaRent) and the base fee of the fixed message, read on two RPCs that must agree. */
export async function solanaCostReads(rpcs: Rpcs, pin: SolanaPoolPin, signal?: AbortSignal): Promise<{ rent: SolanaRent; baseFee: bigint }> {
  const fp = key32(pin.feePayer, "feePayer");
  const pool = key32(solanaPoolOf(pin.program).pool, "pool");
  signal?.throwIfAborted();
  const rent = await readSolanaRent(rpcs);
  const [a, b] = await both(rpcs, async (rpc, k) => {
    const bh = (await rpc("getLatestBlockhash", [FINAL])) as { value?: { blockhash?: unknown } };
    if (typeof bh?.value?.blockhash !== "string") throw new Error(`rpc ${k}: getLatestBlockhash: no blockhash`);
    const f = (await rpc("getFeeForMessage", [feeMessage(fp, pool, key32(bh.value.blockhash, "blockhash")), FINAL])) as { value?: unknown };
    return BigInt(int(f?.value, `rpc ${k} getFeeForMessage`));
  }, signal);
  if (a !== b) throw new Error("the two RPCs' base fee differ");
  // the kit's cost counts two signatures at 5,000: a chain that charges otherwise needs a new cost, not a guess
  if (a !== SOL_TWO_SIGNATURES) throw new Error(`the base fee of two signatures is ${a}, not the ${SOL_TWO_SIGNATURES} the release cost counts`);
  return { rent, baseFee: a };
}

/** Refuses two RPCs that are one provider (the kit's solanaSameProvider: one function, or one URL). */
export function checkSolanaRpcs(rpcs: unknown): asserts rpcs is Rpcs {
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || typeof rpcs[0] !== "function" || typeof rpcs[1] !== "function") throw new Error("rpcs: two");
  if (solanaSameProvider(rpcs[0], rpcs[1])) throw new Error("rpcs: one provider twice is one read");
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function solanaPool(a: SolanaPoolArgs): Pool<SolanaReleaseRequest> {
  checkSolanaRpcs(a.rpcs);
  key32(a.pin?.feePayer, "feePayer");
  const { program, feePayer } = a.pin;
  const { pool, scope } = solanaPoolOf(program);
  if (feePayer === pool) throw new Error("feePayer: the pool");
  const sync = solanaTreeSync(a.rpcs, program);
  // the epoch's fee, computed once per epoch from the device's own reads
  const fees = new Map<bigint, Promise<{ rent: SolanaRent; cost: bigint; fee: bigint }>>();
  const feeOf = (epochStartMs: bigint, signal?: AbortSignal) => {
    let f = fees.get(epochStartMs);
    if (f === undefined) {
      f = solanaCostReads(a.rpcs, a.pin, signal).then(({ rent }) => ({ rent, ...solanaEpochFee(rent) }));
      f.catch(() => fees.delete(epochStartMs));
      for (const k of fees.keys()) if (k < epochStartMs - SOL_LIFE_MS) fees.delete(k);
      fees.set(epochStartMs, f);
    }
    return f;
  };
  return {
    id: `sol:${program}`,
    chain: "sol",
    scope,
    ladder: SOL_LADDER,
    epochMs: SOL_EPOCH_MS,
    lifeMs: SOL_LIFE_MS,
    sendMarginMs: SOL_SEND_MARGIN_MS,
    now: (signal) => solanaNow(a.rpcs, signal),
    trees: (beforeMs, signal, opts) => sync.trees(beforeMs, signal, opts),
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
      const { rent, fee } = await feeOf(epochStartMs, signal);
      if (typeof f.fee !== "string" || f.fee !== fee.toString()) throw new Error(`relayFee: the helper's ${String(f.fee)} is not the epoch's fee ${fee}`);
      if (fee * 10_000n > chunk * MAX_RELAY_FEE_BPS) throw new Error("chunk: under the program's backstop at this fee");
      if (chunk - fee - SOL_TIP_CAP < solanaRentMin(rent, 0)) throw new Error("chunk: W would end under rent(0) at this fee and the tip cap");
      const salt = (a.salt ?? (() => crypto.getRandomValues(new Uint8Array(16))))();
      if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error("salt: not 16 bytes");
      const request: SolanaReleaseRequest = { program, pool, recipient: wallet.address, feePayer, relayFee: fee, relayFeeCap: fee, tipCap: SOL_TIP_CAP, deadlineMs, salt: hex(salt) };
      return { context: solanaContextOf(request, scope), feeCap: fee, request };
    },
  };
}
