// pool.sell on the Solana pool (card signpage-pool-sell): one tap sells a token a buy's fresh wallet W holds on its venue,
// and the same transaction, signed by W alone, puts what the sale gives back into the pinned pool as a note of the
// user's own; the note is written INCOMING before the send and lands UNSPENT once both RPCs show its deposit.
//
// - W: one of the page's buy wallets (../../wallet/src/pool/buy-wallets.ts BuyWallet: its l, j, address and holdings),
//   the one holding the token, not frozen, with the smallest holding that covers the amount. The pick reads nothing;
//   none: not_funded with no read at all.
// - The gating reads, each on both RPCs: the Rent sysvar; the pool account (the same bytes on both, read again once
//   when they differ: a leaf landed between the two reads) for its trees' sizes; the token's mint (its owner, the token
//   program, the same on both) and W's associated token account under it (the kit's solanaDecodeTokenAccount: W's, of
//   the token; the amount, the same on both (read again once when they differ, then failed), must cover the amount,
//   else not_funded; frozen: not_allowed); W's lamports,
//   the lower of the two. W pays the fee before anything runs, so W must hold what its sell needs up front (the kit's
//   solanaPoolSellNeed: the fee and rent(0) on pump's curve, the fee and the wrapped-SOL account's rent on PumpSwap,
//   which that sell makes before any proceeds arrive, and on a cashback coin the rent of W's PumpSwap volume account
//   and its wrapped-SOL account when W lacks either on both RPCs, as a curve buy leaves it: the re-review of 3bdca74):
//   short of it, not_funded before anything is built, never a failed simulation (the review of 4b6223a). That rent is
//   kept on W, out of the deposit, with the reserve's. The kit's buy rule leaves every bought W at least the largest
//   need of any venue its coin sells on, a graduated curve coin's PumpSwap one included.
// - The return note: the first of W's return note (return, c "sol", l, j) and its second arrivals (R, n = 0, 1, ...)
//   that has not landed and whose precommitment mark is on neither RPC (at finalized): one the store does not hold, or
//   holds PLANNED (a sell that never landed: the next one deposits on the same note, so the walk below has no gap); one
//   it holds INCOMING (a sell a closed page sent) is settled first, and while it may still land the sell is failed. A
//   mark on both RPCs for a ref the store does not hold as landed is the user's own note (its precommitment comes from the seed, so no one else can
//   name it before it lands): it is stored UNSPENT with its leaf, as pool-deposit.ts's verdict reads one, and the walk
//   goes on. A mark on one RPC only is that RPC's word against the other's: failed. The same order is what the restore
//   walks (../../wallet/src/pool/solana-restore.ts: every spent note's return and R second arrivals), so a note this
//   page never stored is found there.
// - The quote, last, so it is fresh when W signs (the rule refuses a reference over 25 slots behind the device's own
//   slot): the reference for exactly this sell (the kit's readSolanaReference, side "sell") names the venue that gives
//   the most, readSolanaPoolBuyVenue reads it (its token program must be the one read above), then the blockhash
//   (pool-buy.ts blockhashOf: its slot is the device's own). Min out is the kit's solanaPoolSellMinOut.
// - The reserve, the lamports W keeps out of the deposit: the costs (the tx fee both RPCs price the message at, the
//   mark's rent and each tree page's growth, as pool-deposit.ts counts them) and an empty account's rent W must keep,
//   less what W holds. No compute budget instruction: no priority fee. A reserve over SOLANA_POOL_SELL_RESERVE_MAX or
//   at least min out is refused.
// - Built here (the kit's solanaPoolSellSteps, then the tag 1 deposit of min out less the reserve with the return note's
//   precommitment, last), checked by the rule (rules/pool.ts checkSolanaSell, against the page's pin read at the check),
//   simulated unsigned on both RPCs (sigVerify off, so neither can send it), which must both pass; only then is W
//   derived from the seed (freshWallet, l and j) and must be the W the bytes were built for, and it signs through
//   signSolana (it signs nothing a check did not pass). The key and every seed copy are zeroed on every path.
// - Before it is sent, the note is written INCOMING with W's send (signature, value, the blockhash's last valid
//   height), as pool-deposit.ts writes a deposit's (the review of 4b6223a: a page closed between the send and
//   finality lost the note). Sent on both RPCs. W pays the fee, so the tx id is W's own signature: the kind answers
//   with it. The verdict reads, a second apart (settleSellNote, the one rule for the run, the next sell and the load):
//   both RPCs' finalized height first, then the mark at finalized. The mark on both with its leaf in the state tree:
//   the note UNSPENT, filled when its value is the deposit's (a mark of another value is the user's own note too: a
//   deposit that took the precommitment first; the sell is refused or not_landed). No mark on either and both past the
//   blockhash's last valid height, or this very transaction failed on both (the sale and the deposit are one
//   transaction, so nothing moved): the note PLANNED again, its send dropped, not_landed or refused. Past the reads:
//   "sent", the note INCOMING; each state read of the page settles it (settlePoolSells, src/pool-testnet.ts).
// - After a full sell filled (W holds none of the token), the rent back (card sol-buy-rent-back, rentBack below): the
//   kit's teardown frames close W's emptied accounts to W, then W's sweep deposits every lamport W holds as its next
//   return note. It runs after the sell's stage is told, and never changes it. A partial sell runs neither.
// - Every RPC answer is hostile and parsed strictly. Every read names a public account or the transaction itself, one
//   wallet of the user's at most; no request carries a key or the words. Nothing here logs.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { buildSolanaTeardown, simulateSolanaTeardown, solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { readSolanaPoolBuyVenue, readSolanaRent, SOLANA_POOL_SELL_FEE, solanaPoolPage, solanaPoolSellMinOut, solanaPoolBuySellNeed, solanaPoolSellNeed, solanaPoolSellSteps, solanaRentMin, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaDecodeTokenAccount } from "../../kit/src/trade/solana/pool.ts";
import { pageReference } from "./page-rpc.ts";
import { solanaAta, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_PUMP_AMM_PROGRAM, SOLANA_SOL_MINT, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaTeardownAddresses, solanaTeardownPlan, solanaVolumeAccumulator, type SolanaHeldRead, type SolanaTeardownSimulation } from "../../kit/src/checks/solana/checks.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { ErrorCode, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf, solanaTreeSync, type SolanaPoolPin, type SolanaTreeSync } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { blockhashOf, pastOnBoth, readBack, readBackFailure } from "./pool-buy.ts";
import { fromRecord, timedStore, TRADE_STORE_MS, tradeLock, type TradeStore } from "./trade.ts";
import { checkSolanaSell, checkSolanaSweep, checkSolanaTeardownFrames, PoolRuleRefused, signSolana, SOLANA_POOL_MIN_DEPOSIT, SOLANA_POOL_SELL_RESERVE_MAX, solanaDepositRents, solanaSweepFloor, type PoolAsk, type SolanaDepositHeld } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** What a sell run needs from the page. */
export type PoolSellHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The note store, opened top-level. */
  notes(): Promise<NoteStore>;
  /** The 64-byte seed; each copy is zeroed here. */
  seed64(): Promise<Uint8Array>;
  /** The page's buy wallets with their holdings (shown, never signed on: the run reads again on both RPCs). */
  wallets(): Promise<readonly BuyWallet[]>;
  /** The transaction is signed and about to leave the device (its note already INCOMING with it): W's signature. The
   *  send waits for it; a throw sends nothing. */
  signed?(signature: string): Promise<void> | void;
  /** The transaction was sent: W's signature. */
  sent?(signature: string): void;
  /** After a full sell filled (card sol-buy-rent-back): each rent-back transaction W sent, in order (the teardown's
   *  frames, then the sweep into the pool): W's signature. */
  back?(signature: string): void;
  /** A sell's note settled by its mark (this run's, or one a closed page left): its send's signature and the stage. */
  settled?(signature: string, stage: TradeStage): void;
  /** The rent backs owed (card sol-buy-rent-back): written before a full sell leaves the device, dropped once its rent
   *  back ends, run again on the next load (resumeRentBacks) while it is owed. */
  owed?: OwedRentBacks;
  /** Each rent-back step's fault, and how the rent back ended: public words only (addresses, a fault's name). */
  told?(t: RentBackTold): void;
  /** The device's clock, ms. */
  now?(): bigint;
  /** Verdict reads and the wait between them. */
  reads?: number;
  wait?(ms: number): Promise<void>;
  /** Tests only: the venue's buyback recipient, else random. */
  pick?: (n: number) => number;
};

export type PoolSellAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "failed" | "down" };

/** Verdict reads a sell gets, a second apart: past a blockhash's life (~60 to 90 s) and a finalization. */
export const POOL_SELL_READS = 120;
export const POOL_SELL_WAIT_MS = 1_000;
/** Two providers a slot apart read the pool account at two states: read again once, this long after. */
export const POOL_SELL_SIZE_RETRY_MS = 500;
/** One sell at a time on this device, every tab: two runs never pick one return note. */
export const POOL_SELL_LOCK = "ct-pool/sell";
/** The rent back's tries at each step, POOL_SELL_WAIT_MS apart: a provider's throttle, stall or lag is read again from
 *  the top (the devnet run at 0068524a lost its whole rent back to one provider's HTTP 429s). */
export const POOL_RENT_BACK_TRIES = 30;
/** The rent back's one wall-clock bound, every step and read-back in it (review M2): the sell's own verdict budget. */
export const POOL_RENT_BACK_MS = POOL_SELL_READS * POOL_SELL_WAIT_MS;
/** Rent backs a W may start (its sell's, then one per page load) before the device stops owing it and tells so. */
export const POOL_RENT_BACK_PASSES = 5;
/** A sell whose deposit met a tree page another deposit filled first (WrongAccount on both RPCs, nothing moved): built
 *  again from new reads, at most this many times (review L2). */
export const POOL_SELL_REBUILDS = 2;
/** contracts/pool-solana/src/error.rs PoolError::WrongAccount. */
const POOL_WRONG_ACCOUNT = 22;

const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const TREE_LEN = 8 + 1 + 33 * 32;
const OFF_TREES = 49;
const PRE_MARK_LEN = 17;
const MARK_TAG = 1;
const U32 = 0xffff_ffff;
const enc = /* @__PURE__ */ new TextEncoder();

type Code = "not_allowed" | "not_funded" | "quote_check_failed" | "failed";
class Refused extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}
const no = (code: Code = "failed"): never => {
  throw new Refused(code);
};
const int = (x: unknown): number => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : no());
const be32 = (x: bigint): Uint8Array => {
  if (x < 0n || x >= 1n << 256n) no();
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const u64le = (x: bigint): Uint8Array => {
  if (x <= 0n || x >= 1n << 64n) no();
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
};
const lower = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const both = <T>(rpcs: readonly [SolanaRpc, SolanaRpc], f: (rpc: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
type Rpcs = readonly [SolanaRpc, SolanaRpc];

/** One account as an RPC gives it (base64), with the slot it answered at; none when there is no account. */
async function account(rpc: SolanaRpc, address: string, commitment: "confirmed" | "finalized", minContextSlot?: number): Promise<{ slot: number; owner: string; data: Uint8Array; lamports: bigint } | { slot: number; none: true }> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment, ...(minContextSlot === undefined ? {} : { minContextSlot }) }])) as { context?: { slot?: unknown }; value?: unknown };
  const slot = int(r?.context?.slot);
  const v = r?.value as { owner?: unknown; data?: unknown; lamports?: unknown } | null | undefined;
  if (v === null) return { slot, none: true };
  if (typeof v?.owner !== "string" || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return no();
  return { slot, owner: v.owner, data: base64.decode(v.data[0]), lamports: BigInt(int(v.lamports)) };
}

/** Up to 10 accounts in one getMultipleAccounts call (one provider's cap), all at one slot; null: no account. */
async function accountsOf(rpc: SolanaRpc, addresses: readonly string[]): Promise<(SolanaHeldRead | null)[]> {
  const r = (await rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown };
  if (!Array.isArray(r?.value) || r.value.length !== addresses.length) return no();
  return r.value.map((a: { owner?: unknown; data?: unknown; lamports?: unknown } | null) => {
    if (a === null) return null;
    if (typeof a?.owner !== "string" || !Array.isArray(a.data) || a.data[1] !== "base64" || typeof a.data[0] !== "string") return no();
    return { owner: a.owner, lamports: BigInt(int(a.lamports)), data: base64.decode(a.data[0]) };
  });
}

/** The pool account on both RPCs, the same bytes (read again once when they differ): its two tree sizes. */
async function treeSizes(rpcs: Rpcs, program: string, pool: string, wait: (ms: number) => Promise<void>): Promise<{ stateSize: number; labelSize: number }> {
  for (let round = 0; ; round++) {
    const [a, b] = await both(rpcs, (r) => account(r, pool, "confirmed"));
    if ("none" in a || "none" in b) return no("not_allowed");
    if (a.owner !== program || b.owner !== program) return no();
    if (!sameBytes(a.data, b.data)) {
      if (round > 0) return no();
      await wait(POOL_SELL_SIZE_RETRY_MS);
      continue;
    }
    const d = a.data;
    if (d.length !== POOL_LEN || !sameBytes(d.subarray(0, 8), POOL_DISC)) return no();
    const size = (at: number): number => int(Number(new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true)));
    return { stateSize: size(OFF_TREES), labelSize: size(OFF_TREES + TREE_LEN) };
  }
}

/** The token's program (the mint's owner, the same on both RPCs) and W's associated token account under it: its
 *  amount, the same on both RPCs (two that differ are read again once, then failed: neither RPC's word alone sets what
 *  the sell takes or what W keeps after it). None on either RPC holds nothing; frozen on either: not_allowed. */
async function tokenHeld(rpcs: Rpcs, w: string, mint: string): Promise<{ program: string; amount: bigint }> {
  const mints = await both(rpcs, (r) => account(r, mint, "confirmed"));
  const programs = mints.map((m) => ("none" in m ? no() : m.owner));
  const program = programs[0]!;
  if (programs[1] !== program || (program !== SOLANA_TOKEN_PROGRAM && program !== SOLANA_TOKEN_2022_PROGRAM)) return no();
  const ata = solanaAta(w, mint, program);
  const read = async () => (await both(rpcs, (r) => account(r, ata, "confirmed"))).map((a) => {
    if ("none" in a) return 0n;
    if (a.owner !== program) return no();
    let t: ReturnType<typeof solanaDecodeTokenAccount>;
    try {
      t = solanaDecodeTokenAccount({ owner: a.owner, data: a.data });
    } catch {
      return no();
    }
    if (t.mint !== mint || t.owner !== w) return no();
    if (t.state === 2) return no("not_allowed");
    return t.amount;
  });
  for (let i = 0; i < 2; i++) {
    const [a, b] = await read();
    if (a === b) return { program, amount: a! };
  }
  return no();
}

type Mark = { value: bigint; nonce: bigint; slot: number };
/** The precommitment's mark at finalized: null when on neither RPC, "one" when on one only, else both's record (the
 *  same bytes) and the higher slot. `at`: each RPC's read at that slot or later (minContextSlot). */
async function markOf(rpcs: Rpcs, program: string, precommitment: bigint, at?: readonly [number, number]): Promise<Mark | "one" | null> {
  const address = solanaProgramAddress([enc.encode("pre"), be32(precommitment)], program);
  const [a, b] = await Promise.all([account(rpcs[0], address, "finalized", at?.[0]), account(rpcs[1], address, "finalized", at?.[1])]);
  if ("none" in a && "none" in b) return null;
  if ("none" in a || "none" in b) return "one";
  if (a.owner !== program || b.owner !== program || !sameBytes(a.data, b.data)) return no();
  const d = a.data;
  if (d.length !== PRE_MARK_LEN || d[16] !== MARK_TAG) return no();
  const v = new DataView(d.buffer, d.byteOffset, 16);
  return { value: v.getBigUint64(0, true), nonce: v.getBigUint64(8, true), slot: Math.max(a.slot, b.slot) };
}

/** A mark's leaf, as pool-deposit.ts's verdict reads it: its label the label tree's leaf nonce - 1, and the commitment
 *  Poseidon(value, label, precommitment) a leaf of the state tree, once. */
async function leafOf(sync: SolanaTreeSync, scope: bigint, precommitment: bigint, m: Mark): Promise<Leaf> {
  if (m.nonce === 0n) return no();
  const leaves = await sync.leaves(m.slot);
  const label = vaultLabelOf(keccak_256, scope, m.nonce);
  if (leaves.label[Number(m.nonce - 1n)] !== label) return no();
  const commitment = noteCommitment(m.value, label, precommitment);
  const at = leaves.state.indexOf(commitment);
  if (at < 0 || leaves.state.indexOf(commitment, at + 1) >= 0) return no();
  return { value: m.value, label, commitment, leafIndex: BigInt(at) };
}

/** A sell's note (card signpage-pool-sell): W's return note or one of its R second arrivals. */
const sellRef = (ref: NoteRef): boolean => ref.kind === "return" || (ref.kind === "second" && ref.id.id === "R");

type SellEnd = "filled" | "taken" | "dropped" | "pending";
/**
 * A sell's INCOMING note, read once, as the run's verdict reads it (the chain's word on its mark, never an RPC's tx
 * history alone): both RPCs' finalized height first, then the mark at finalized. The mark on both: the note goes
 * UNSPENT with its leaf, "filled" when its value is the send's, else "taken" (a deposit of another value used the
 * precommitment first: the user's own note all the same, since only the seed names it, and the sell can never land).
 * No mark on either and both past the send's last valid height, or `dead` (the transaction failed on both, so nothing
 * moved): the send is dropped, the note PLANNED again for the next sell of this W ("dropped"). Else "pending".
 */
async function settleSellNote(rpcs: Rpcs, program: string, scope: bigint, sync: SolanaTreeSync, store: NoteStore, n: NoteRecord, dead = false): Promise<{ end: SellEnd; signature: string | null }> {
  const send = n.sends?.at(-1);
  const signature = send?.signature ?? null;
  // no send: a page closed between an adoption's two moves; nothing was sent with it, so it is past at once
  const seen = dead || send === undefined ? null : await pastAt(rpcs, Number(send.last_valid_block_height));
  const past = dead || send === undefined || seen !== null;
  // past: the mark read on each RPC at the slot it was past at or later, so a deposit final by then is in the read
  const m = await markOf(rpcs, program, n.precommitment, seen ?? undefined).catch(() => "one" as const);
  if (m !== null && m !== "one") {
    const leaf = await leafOf(sync, scope, n.precommitment, m).catch(() => null);
    if (leaf === null) return { end: "pending", signature };
    await store.move(n.id, "INCOMING", "UNSPENT", { leaf });
    // our transaction failed on both: a mark of any value is another deposit's (the user's note all the same), never
    // the sale's, so the sell is refused even at exactly its value
    return { end: !dead && send !== undefined && m.value === send.value ? "filled" : "taken", signature };
  }
  if (m === null && past) {
    await store.move(n.id, "INCOMING", "PLANNED");
    return { end: "dropped", signature };
  }
  return { end: "pending", signature };
}

/** Each RPC's finalized slot once both are past `last`: one getEpochInfo at finalized per RPC, so the block height and
 *  the slot are one node's, of one block; null while either is not past, or a read fails. */
async function pastAt(rpcs: Rpcs, last: number): Promise<[number, number] | null> {
  try {
    const got = await Promise.all(rpcs.map(async (r) => {
      const e = (await r("getEpochInfo", [{ commitment: "finalized" }])) as { blockHeight?: unknown; absoluteSlot?: unknown } | null;
      return int(e?.blockHeight) > last ? int(e?.absoluteSlot) : null;
    }));
    return got[0] !== null && got[1] !== null ? [got[0], got[1]] : null;
  } catch {
    return null;
  }
}

/** The stage a settled sell answers: its transaction failed on both (`dead`), or the chain's word on its note. */
const stageOf = (end: Exclude<SellEnd, "pending">, dead: boolean): TradeStage => (end === "filled" ? "filled" : dead ? "refused" : "not_landed");

/**
 * The note the sale's deposit makes: W's return note, then its R second arrivals in order; the first that has not
 * landed and whose mark is on neither RPC, with its PLANNED record when the store holds one (a sell that never
 * landed). A mark on both for one the store does not hold as landed is the user's own note, stored UNSPENT with its
 * leaf; on one RPC only: failed. An INCOMING one (a sell a closed page sent) is settled first: still landing, failed.
 */
async function returnNote(rpcs: Rpcs, program: string, scope: bigint, store: NoteStore, sync: SolanaTreeSync, seed64: Uint8Array, l: bigint, j: number, settled?: (signature: string, stage: TradeStage) => void): Promise<{ ref: NoteRef; precommitment: bigint; planned: string | null }> {
  const held = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  for (let n = -1; n <= U32; n++) {
    const ref: NoteRef = n < 0 ? { kind: "return", c: "sol", l, j } : { kind: "second", id: { id: "R", c: "sol", l, j }, n };
    const precommitment = noteSecrets(seed64, ref).precommitment;
    const h = held.get(refKey(ref));
    if (h !== undefined && (h.precommitment !== precommitment || h.scope !== scope)) return no();
    if (h?.state === "INCOMING") {
      const got = await settleSellNote(rpcs, program, scope, sync, store, h);
      if (got.end === "pending") return no();
      if (got.signature !== null) settled?.(got.signature, stageOf(got.end, false));
      if (got.end === "dropped") return { ref, precommitment, planned: h.id };
      continue;
    }
    if (h !== undefined && h.state !== "PLANNED") continue;
    const m = await markOf(rpcs, program, precommitment);
    if (m === null) return { ref, precommitment, planned: h?.id ?? null };
    if (m === "one") return no();
    const leaf = await leafOf(sync, scope, precommitment, m);
    if (h === undefined) await store.add({ ref, scope, precommitment, state: "UNSPENT", leaf });
    else await store.move((await store.move(h.id, "PLANNED", "INCOMING")).id, "INCOMING", "UNSPENT", { leaf });
  }
  return no();
}

/**
 * Settles the sells a closed or reloaded page left INCOMING (on load and at each state read, src/pool-testnet.ts):
 * each of the pool's INCOMING return and R notes read once by the run's own verdict rules. Under the sell lock, so it
 * never reads a note a running sell holds; one that is running is skipped (that run settles its own note).
 */
export async function settlePoolSells(h: Pick<PoolSellHost, "pin" | "rpcs" | "notes" | "settled">, locks: Locks | null = globalThis.navigator?.locks ?? null): Promise<void> {
  if (!locks) return;
  await locks.request(POOL_SELL_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const program = h.pin.program;
    const { scope } = solanaPoolOf(program);
    const store = await h.notes();
    const sync = solanaTreeSync(h.rpcs, program);
    for (const n of await store.list()) {
      if (n.state !== "INCOMING" || n.scope !== scope || !sellRef(n.ref)) continue;
      const got = await settleSellNote(h.rpcs, program, scope, sync, store, n).catch(() => ({ end: "pending" as const, signature: null }));
      if (got.end !== "pending" && got.signature !== null) h.settled?.(got.signature, stageOf(got.end, false));
    }
  });
}

/** What a sell leaves to run after its answer: the rent back, after a full sell filled; or the sell built again, its
 *  deposit having met a page another deposit filled first. */
type Later = { back?: () => Promise<void>; rebuild?: true };

/** One W's rent back owed: W, its l and j (W again from the seed), the mints it traded, and its passes so far. */
export type OwedRentBack = { address: string; l: string; j: number; mints: { mint: string; program: string }[]; passes: number };
export type OwedRentBacks = { list(): Promise<OwedRentBack[]>; put(r: OwedRentBack): Promise<void>; drop(address: string): Promise<void> };
/** How a rent back ended: its sweep sent; nothing left on W; W under the smallest note (solanaSweepFloor), its lamports
 *  kept on W; an account the plan keeps (so W keeps the fee to close it later); W holding a token; or it gave up. */
export type RentBackEnd = "sent" | "nothing" | "floor" | "kept" | "holds" | "gave_up";
export type RentBackTold = { address: string; step: "teardown" | "sweep" | "rent_back"; state: "fault" | "gave_up" | RentBackEnd; detail: string };

/** The rent backs owed, in the wallet store's meta/owed/rentback-sol (meta/owed/ is never read or listed by the frame). */
export const owedRentBacks = (store: () => Promise<Pick<TradeStore, "get" | "update">>): OwedRentBacks => {
  const KEY = "owed/rentback-sol";
  type All = Record<string, OwedRentBack>;
  return {
    list: async () => Object.values(((await (await store()).get("meta", KEY)) as All | undefined) ?? {}),
    put: async (r) => void (await (await store()).update("meta", KEY, (v) => ({ ...((v as All | undefined) ?? {}), [r.address]: r }))),
    drop: async (address) =>
      void (await (await store()).update("meta", KEY, (v) => {
        const all = { ...((v as All | undefined) ?? {}) };
        if (!Object.hasOwn(all, address)) return undefined;
        delete all[address];
        return all;
      })),
  };
};

/** A sell, built again (POOL_SELL_REBUILDS at most) while its deposit meets a page another deposit filled first. */
async function sellRuns(h: PoolSellHost, ask: PoolAsk, later: Later): Promise<PoolSellAnswer> {
  for (let i = 0; ; i++) {
    delete later.rebuild;
    const a = await sellRun(h, ask, later);
    if (!later.rebuild || i >= POOL_SELL_REBUILDS) return a;
  }
}

/** One pool.sell: the ask is the user's own (rules/pool.ts checkPoolRequest passed it, with the token's decimals). After
 *  a full sell filled, the rent back (rentBack) runs before this answers; it never changes the answer. */
export async function runPoolSell(h: PoolSellHost, ask: PoolAsk): Promise<PoolSellAnswer> {
  const later: Later = {};
  const a = await sellRuns(h, ask, later);
  await later.back?.();
  return a;
}

async function sellRun(h: PoolSellHost, ask: PoolAsk, later: Later): Promise<PoolSellAnswer> {
  const seeds: Uint8Array[] = [];
  let key: Uint8Array | null = null;
  let sent: string | null = null;
  // from here on W signs: a provider that fails past this is never "down" (the transaction may land)
  let signing = false;
  const seed = async (): Promise<Uint8Array> => {
    const s = await h.seed64();
    seeds.push(s);
    return s;
  };
  const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  try {
    if (ask.kind !== "pool.sell" || ask.chain !== "solana" || ask.token === null) return no("not_allowed");
    const token = ask.token;
    const amount = ask.amount;
    // W: the smallest holding of the token that covers the amount, not frozen; the pick reads nothing
    const held = (x: BuyWallet) => x.holdings.tokens.get(token);
    const w = (await h.wallets())
      .filter((x) => x.chain === "sol" && held(x) !== undefined && !held(x)!.frozen && held(x)!.amount >= amount)
      .sort((x, y) => (held(x)!.amount < held(y)!.amount ? -1 : held(x)!.amount > held(y)!.amount ? 1 : 0))[0];
    if (w === undefined) return no("not_funded");
    // the pin, read once for every read and the build; the rule reads the page's pin again at the check
    const program = h.pin.program;
    const { pool, scope } = solanaPoolOf(program);
    const rpcs = h.rpcs;
    // the gating reads, each on both RPCs
    const rent: SolanaRent = await readSolanaRent(rpcs);
    const sizes = await treeSizes(rpcs, program, pool, wait);
    const tokens = await tokenHeld(rpcs, w.address, token);
    if (tokens.amount < amount) return no("not_funded");
    const lamports = lower(...(await both(rpcs, async (r) => {
      const a = await account(r, w.address, "confirmed");
      return "none" in a ? 0n : a.lamports;
    })));
    // W pays the sell's fee before anything runs, and must hold what the sell makes before any proceeds arrive (the
    // kit's solanaPoolSellNeed): short of the cheaper venue's need, no venue can take it, refused before any other read
    if (lamports < solanaPoolSellNeed({ kind: "pump-curve", cashback: false }, rent)) return no("not_funded");
    // the note the deposit makes; the seed copy for its precommitment is zeroed at once
    const store = await h.notes();
    const sync = solanaTreeSync(rpcs, program);
    const s = await seed();
    const { ref, precommitment, planned } = await returnNote(rpcs, program, scope, store, sync, s, w.l, w.j, h.settled);
    s.fill(0);
    // last, the reads the quote's age counts from: the reference, its venue, then the device's blockhash and slot
    const reference = await pageReference(rpcs, { side: "sell", token, amount });
    const best = reference?.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];
    if (!reference || !best) return no("quote_check_failed");
    const venue = await readSolanaPoolBuyVenue(rpcs, best.venue as "pump-curve" | "pumpswap", token, ...(h.pick ? [h.pick] : []));
    if (venue.tokenProgram !== tokens.program) return no();
    // the venue's own need up front (PumpSwap: the wrapped-SOL account its sell makes first), before anything is built
    // a cashback coin on PumpSwap: the sell names W's PumpSwap volume account and its wrapped-SOL account, which a curve
    // buy never made, and makes each one missing at W's cost (release.rs venue_pumpswap_cashback_sell_makes_ws_cashback_
    // accounts). Each is counted on its own: there only when both RPCs show it owned by its program (the PumpSwap
    // program; the token program), else made. Two RPCs that differ are read again once, then failed: one RPC's word
    // that it is there would keep its rent off W's budget, and a sell that still simulates would leave W under the next
    // sell's need (the re-review of fd5eec3)
    const has = { ammVolume: false, ammVolumeAta: false };
    if (venue.kind === "pumpswap" && venue.cashback) {
      const vol = solanaVolumeAccumulator(w.address, SOLANA_PUMP_AMM_PROGRAM);
      const ata = solanaAta(vol, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
      const owned = async (address: string, owner: string): Promise<boolean> => {
        for (let i = 0; i < 2; i++) {
          const [a, b] = (await both(rpcs, (r) => account(r, address, "confirmed"))).map((x) => !("none" in x) && x.owner === owner);
          if (a === b) return a!;
        }
        return no();
      };
      [has.ammVolume, has.ammVolumeAta] = await Promise.all([owned(vol, SOLANA_PUMP_AMM_PROGRAM), owned(ata, SOLANA_TOKEN_PROGRAM)]);
    }
    const need = solanaPoolSellNeed(venue, rent, has);
    // what the sell makes and keeps at W's cost (those cashback accounts): kept out of the deposit too
    const made = need - solanaPoolSellNeed(venue, rent, { ammVolume: true, ammVolumeAta: true });
    if (lamports < need) return no("not_funded");
    const bh = await blockhashOf(rpcs);
    const quote = { amount, ref: reference, slippageBps: ask.slippageBps };
    let minOut: bigint;
    try {
      minOut = solanaPoolSellMinOut(venue, amount, quote, bh.slot);
    } catch {
      return no("quote_check_failed");
    }
    // the transaction: the venue's sell, then last the deposit of `value` with the note's precommitment, W the payer
    const steps = solanaPoolSellSteps(venue, w.address, amount, minOut);
    const pre = be32(precommitment);
    const build = (value: bigint): { message: Uint8Array; wire: Uint8Array } => {
      const { message } = solanaCompileV0(w.address, [...steps, depositIx(program, pool, w.address, sizes, pre, value)], bh.blockhash, []);
      return { message, wire: wireOf(message) };
    };
    // the fee both RPCs price the message at: per signature, with no compute budget, so the deposit's value (the one
    // thing the reserve changes) changes nothing it prices
    const [fa, fb] = await both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(build(minOut).message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
    if (fa !== fb) return no();
    // the need again at the fee both RPCs price this very message at
    if (lamports < need - SOLANA_POOL_SELL_FEE + fa) return no("not_funded");
    // what W holds after the sell, at least: rent(0), the runtime's floor, when the sell empties W's holding; while W
    // keeps any of the token (the amount both RPCs read), what the next sell of it needs up front on every
    // venue the coin can reach, the buy's rule (solanaPoolBuySellNeed: a curve coin's PumpSwap need, cashback accounts
    // included), so no sell leaves tokens on a W that cannot pay to sell them (the re-review of 40cdc3e)
    const keeps = tokens.amount > amount;
    const after = keeps ? solanaPoolBuySellNeed(venue, rent) : solanaRentMin(rent, 0);
    // the rents the deposit takes from W, as the program prices them (review L1): its mark and both pages topped up to
    // their rent at their new length, less what each holds (anyone may send lamports to one), read on both RPCs
    const rents = solanaDepositRents(rent, sizes, await depositHeld(rpcs, program, sizes, pre, wait));
    const short = fa + made + rents + after - lamports;
    const reserve = short > 0n ? short : 0n;
    // a partial sell whose reserve passes the cap is refused, never shrunk: the rest would be stranded on W; selling more
    // than the user asked is never the device's call (a sell of the whole holding needs only rent(0))
    if (keeps && reserve > SOLANA_POOL_SELL_RESERVE_MAX) return no("not_funded");
    if (reserve > SOLANA_POOL_SELL_RESERVE_MAX || reserve >= minOut) return no("quote_check_failed");
    const value = minOut - reserve;
    const { wire } = build(value);
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: 0n, solana: h.pin, precommitment };
    checkSolanaSell(wire, ask, ctx, venue, quote, bh.slot, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize }, reserve);
    // unsigned: an RPC cannot send what it simulates
    const sims = await both(rpcs, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } } | null)?.value);
    if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) return no();
    // W, from the seed, right before it signs: it must be the W the bytes were built and checked for
    signing = true;
    const fw = freshWallet(await seed(), "sol", w.l, w.j);
    key = fw.secretKey;
    for (const x of seeds) x.fill(0);
    if (fw.address !== w.address) return no();
    const sig = signSolana(key, wire);
    key.fill(0);
    key = null;
    const signed = wire.slice();
    signed.set(sig, 1);
    const signature = base58.encode(sig);
    // written before the signed transaction leaves the device: the note INCOMING with W's send, so a page closed or
    // reloaded from here on leaves a record its next load settles (settlePoolSells) by the same verdict rules
    const id = planned ?? (await store.add({ ref, scope, precommitment, state: "PLANNED" })).id;
    const note = await store.move(id, "PLANNED", "INCOMING", { send: { signature, value, last_valid_block_height: BigInt(bh.lastHeight) } });
    // a full sell owes W's rent back from here: written before the send, so a page closed from here on runs it at its
    // next load (resumeRentBacks); a sell that never lands leaves W holding the token, and that rent back ends "kept"
    if (!keeps) await h.owed?.put({ address: w.address, l: w.l.toString(), j: w.j, mints: [{ mint: token, program: tokens.program }], passes: 0 }).catch(() => {});
    // the request's record names the signature before it leaves the device (a write that fails sends nothing)
    await h.signed?.(signature);
    sent = signature;
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    h.sent?.(signature);
    const txs: TxRef[] = [{ chain: "solana", hash: signature }];
    // the verdict: the chain's word on the note's mark, never an RPC's tx history alone
    const reads = h.reads ?? POOL_SELL_READS;
    // the reads are a time budget too (POOL_SELL_READS a second apart): one RPC down, each read's retry its own 3.5 s,
    // never holds the seed's lock past it; the note, INCOMING, settles at the next load or sell
    const clock = (): number => Number(h.now?.() ?? BigInt(Date.now()));
    const sentAt = clock();
    for (let i = 0; i < reads && (i === 0 || clock() - sentAt < POOL_SELL_READS * POOL_SELL_WAIT_MS); i++) {
      if (i > 0) await wait(POOL_SELL_WAIT_MS);
      const got = await both(rpcs, (r) => readBackFailure(r, signature, signed)).catch((): { got: "none"; err?: unknown }[] => [{ got: "none" }, { got: "none" }]);
      // this very transaction failed on chain, on both RPCs: the sale and the deposit are one, nothing moved
      const dead = got[0].got === "failed" && got[1].got === "failed";
      const { end } = await settleSellNote(rpcs, program, scope, sync, store, note, dead);
      // its deposit (the last instruction) met a page another deposit filled first, and its note is PLANNED again (the
      // settle dropped it, review L-A): built again from new reads
      if (dead && end === "dropped" && got.every((g) => wrongAccount(g.err, steps.length))) later.rebuild = true;
      // a full sell filled: W holds none of the token, so the rent its accounts lock and every lamport it keeps go back
      if (end === "filled" && !keeps) later.back = () => rentBackOwed(h, { rpcs, program, pool, scope, rent, store, sync, w, mints: [{ mint: token, program: tokens.program }], wait }, { address: w.address, l: w.l.toString(), j: w.j, mints: [{ mint: token, program: tokens.program }], passes: 0 });
      if (end !== "pending") return { stage: stageOf(end, dead), txs };
      // failed on both, its note's mark on one RPC only: refused; the note settles at the next load or sell
      if (dead) return { stage: "refused", txs };
    }
    return { stage: "sent", txs };
  } catch (e) {
    // past the send nothing is refused: the transaction may land, so the answer is "sent" with its signature, and the
    // note, INCOMING, settles at the next load or sell
    if (sent !== null) return { stage: "sent", txs: [{ chain: "solana", hash: sent }] };
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    // a provider read that still fails after the page's own retry, before W signs: "not now" (card pool-read-down)
    if (!signing && e instanceof SolanaRpcTransportError) return { error: "down" };
    return { error: "failed" };
  } finally {
    for (const x of seeds) x.fill(0);
    key?.fill(0);
  }
}

/** A transaction error that is the pool program's WrongAccount at instruction `ix`. */
const wrongAccount = (err: unknown, ix: number): boolean => {
  const e = (err as { InstructionError?: unknown } | null | undefined)?.InstructionError;
  return Array.isArray(e) && e[0] === ix && (e[1] as { Custom?: unknown } | null)?.Custom === POOL_WRONG_ACCOUNT;
};

/** The mark a tag 1 deposit on `pre` makes. */
const markAddress = (program: string, pre: Uint8Array): string => solanaProgramAddress([enc.encode("pre"), pre], program);

/** The lamports the deposit's mark and two pages hold, on both RPCs at one slot each, the same on both (read again
 *  once, POOL_SELL_SIZE_RETRY_MS on: two RPCs a slot apart). */
async function depositHeld(rpcs: Rpcs, program: string, sizes: { stateSize: number; labelSize: number }, pre: Uint8Array, wait: (ms: number) => Promise<void>): Promise<SolanaDepositHeld> {
  const keys = [solanaPoolPage(program, 0, sizes.stateSize), solanaPoolPage(program, 1, sizes.labelSize), markAddress(program, pre)];
  for (let i = 0; ; i++) {
    const [a, b] = await both(rpcs, (r) => accountsOf(r, keys));
    const pair = (k: number) => [a[k]?.lamports ?? null, b[k]?.lamports ?? null] as const;
    const held = { state: pair(0), label: pair(1), mark: pair(2) };
    if ([held.state, held.label, held.mark].every(([x, y]) => x === y)) return held;
    if (i > 0) return no();
    await wait(POOL_SELL_SIZE_RETRY_MS);
  }
}

/** A fault's public name: a provider's fault and host, a refusal's code, a check's rule, else the error's own words. */
const faultOf = (e: unknown): string =>
  e instanceof SolanaRpcTransportError ? `${e.fault} at ${e.host}` : e instanceof Refused ? `refused ${e.code}` : e instanceof PoolRuleRefused ? `check ${e.rule}` : e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : "unknown";

/** The tag 1 deposit of `value` from W into the pinned pool on `pre`, at the tree sizes read. */
const depositIx = (program: string, pool: string, wallet: string, sizes: { stateSize: number; labelSize: number }, pre: Uint8Array, value: bigint) => ({
  program,
  accounts: [
    { key: pool, signer: false, writable: true },
    { key: wallet, signer: true, writable: true },
    { key: solanaPoolPage(program, 0, sizes.stateSize), signer: false, writable: true },
    { key: solanaPoolPage(program, 1, sizes.labelSize), signer: false, writable: true },
    { key: markAddress(program, pre), signer: false, writable: true },
    { key: SOLANA_SYSTEM_PROGRAM, signer: false, writable: false },
  ],
  data: Uint8Array.of(1, ...u64le(value), ...pre),
});

/** One message W alone signs, as a wire with one empty signature slot. */
const wireOf = (message: Uint8Array): Uint8Array => {
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  return wire;
};

type RentBack = { rpcs: Rpcs; program: string; pool: string; scope: bigint; rent: SolanaRent; store: NoteStore; sync: SolanaTreeSync; w: BuyWallet; mints: readonly { mint: string; program: string }[]; wait: (ms: number) => Promise<void> };

/**
 * W's rent back (card sol-buy-rent-back), after a full sell filled or at a later load while it is owed: what W's
 * accounts lock comes back to W, then everything W holds goes into the pool as W's next return note. Runs under the
 * sell lock, never throws, and ends in a RentBackEnd the host is told, as it is told each step's fault: the sell has
 * landed, and whatever this does not finish stays on W, W's own, and owed (resumeRentBacks).
 * Each step up to its send is tried again from its first read on any fault (a provider's throttle, stall, or a slot's
 * lag between the two), POOL_SELL_WAIT_MS apart, POOL_RENT_BACK_TRIES times, and the whole rent back, read-backs
 * included, ends at POOL_RENT_BACK_MS on the wall clock; nothing is signed before every check passes on that try's reads,
 * and each key is zeroed the moment its signing ends, a signing that throws included.
 * 1. The teardown (06c A9: no sell transaction closes an account; the closes are their own frames, after the fill, so a
 *    close that fails never holds back a sell): the kit's solanaTeardownPlan over W's token account of each mint, its
 *    wrapped-SOL account and its volume account under each pump program, read with W in one call on each RPC (one
 *    slot); every account the plan finds closable (a token account holding none, a volume account owing nothing) is
 *    closed to W by the kit's buildSolanaTeardown frames, checked by the rule (checkSolanaTeardownFrames: the kit's
 *    checkSolanaTeardown, both RPCs' simulations included), signed by W and sent on both; each frame read back until it
 *    is on both RPCs, failed on both, or past its blockhash on both.
 * 2. The sweep, only when the plan keeps nothing (review L4: an account kept, holding tokens or owing cashback or
 *    incentives, needs W's fee to be claimed or closed later) and every frame read back: W's lamports, the same on both
 *    RPCs, less its one fee and the rents the deposit takes as the program prices them (solanaDepositRents: its mark
 *    and both pages, from their lamports on both RPCs), deposited (tag 1) on the next of W's return notes (returnNote's
 *    walk: the sell's return note has landed, so its R second arrivals), checked by the rule (checkSolanaSweep: W ends
 *    at 0), simulated unsigned on both, then signed; its note INCOMING with the send before it leaves, then the sell
 *    lock is free (review L6): the settle at the next state read (settlePoolSells) gives its verdict. Under the smallest
 *    note the device spends (solanaSweepFloor, review M1), nothing is sent: W keeps its lamports.
 * A W that holds another token runs neither: its volume accounts and lamports are what that token's sell needs.
 */
async function rentBack(h: PoolSellHost, x: RentBack): Promise<RentBackEnd> {
  const seeds: Uint8Array[] = [];
  const seed = async (): Promise<Uint8Array> => {
    const s = await h.seed64();
    seeds.push(s);
    return s;
  };
  // W's key, from the seed, right before it signs: it must be the W every byte was built and checked for
  const keyOf = async (): Promise<Uint8Array> => {
    const fw = freshWallet(await seed(), "sol", x.w.l, x.w.j);
    for (const s of seeds) s.fill(0);
    if (fw.address !== x.w.address) {
      fw.secretKey.fill(0);
      return no();
    }
    return fw.secretKey;
  };
  // W signs `wires`; its key zeroed when the signing ends, however it ends (review L3)
  const signAll = async (wires: readonly Uint8Array[]): Promise<{ wire: Uint8Array; signed: Uint8Array; signature: string }[]> => {
    const key = await keyOf();
    try {
      return wires.map((wire) => {
        const sig = signSolana(key, wire);
        const signed = wire.slice();
        signed.set(sig, 1);
        return { wire, signed, signature: base58.encode(sig) };
      });
    } finally {
      key.fill(0);
    }
  };
  const { rpcs, w, wait, rent } = x;
  const reads = h.reads ?? POOL_SELL_READS;
  const clock = (): number => Number(h.now?.() ?? BigInt(Date.now()));
  const deadline = clock() + POOL_RENT_BACK_MS;
  const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: 0n, solana: h.pin };
  const tell = (step: RentBackTold["step"], state: RentBackTold["state"], detail: string): void => {
    try {
      h.told?.({ address: w.address, step, state, detail });
    } catch {
      // a host that cannot be told changes nothing here
    }
  };
  const end = (e: RentBackEnd, detail: string): RentBackEnd => (tell("rent_back", e, detail), e);
  const send = async (signed: Uint8Array, signature: string): Promise<void> => {
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    h.back?.(signature);
  };
  // a step up to its send, again from its first read on a fault, each fault told; null: it gave up
  const again = async <T>(step: "teardown" | "sweep", f: () => Promise<T>): Promise<{ ok: T } | null> => {
    for (let i = 0; i < POOL_RENT_BACK_TRIES && (i === 0 || clock() < deadline); i++) {
      if (i > 0) await wait(POOL_SELL_WAIT_MS);
      try {
        return { ok: await f() };
      } catch (e) {
        tell(step, "fault", faultOf(e));
      }
    }
    tell(step, "gave_up", `no try passed in ${POOL_RENT_BACK_TRIES} tries or ${POOL_RENT_BACK_MS} ms`);
    return null;
  };
  try {
    // W holding another token (the page's holdings: a skip is the safe side) keeps everything its next sell needs
    const mints = new Set(x.mints.map((m) => m.mint));
    if ([...w.holdings.tokens].some(([mint, t]) => !mints.has(mint) && t.amount > 0n)) return end("holds", "W holds another token");
    const addresses = solanaTeardownAddresses(w.address, x.mints);
    // W's accounts and W, in one getMultipleAccounts call on each RPC (one slot each): the plan over them, and whether
    // W still holds a mint it traded (review M-B: an owed record from a sell that never filled, or not yet)
    const readW = async () => {
      const held = await both(rpcs, (r) => accountsOf(r, [w.address, ...addresses]));
      const accounts = Object.fromEntries(addresses.map((a, i) => [a, [held[0][i + 1]!, held[1][i + 1]!] as const]));
      const holding = x.mints.map((m) => {
        const pair = accounts[solanaAta(w.address, m.mint, m.program)] ?? [null, null];
        const [a, b] = pair.map((t) => (t !== null && t.data.length >= 72 && (t.owner === SOLANA_TOKEN_PROGRAM || t.owner === SOLANA_TOKEN_2022_PROGRAM) ? new DataView(t.data.buffer, t.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n));
        if ((a! > 0n) !== (b! > 0n)) throw new Error(`W's account of ${m.mint} holds tokens on one RPC only`);
        return a! > 0n;
      });
      // a W that holds is never planned: nothing of it is closed, whatever its other accounts read
      if (holding.some(Boolean)) return { holds: true as const };
      return { holds: false as const, held, accounts, plan: solanaTeardownPlan(w.address, accounts) };
    };
    // 1. the teardown
    const teardown = await again("teardown", async () => {
      const read = await readW();
      // W still holds what it sold: its sell has not filled, so its volume and wrapped-SOL accounts are what that sell
      // (or its next) still uses; nothing is closed
      if (read.holds) return null;
      const { held, accounts, plan } = read;
      if (plan.close.length === 0) return { keep: plan.keep, signed: [], last: 0 };
      const bh = await blockhashOf(rpcs);
      const frames = buildSolanaTeardown(w.address, plan, { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastHeight });
      // one frame at a time on each RPC: a public provider throttles a burst
      const simulations: [SolanaTeardownSimulation, SolanaTeardownSimulation][] = [];
      for (const f of frames) simulations.push(await both(rpcs, (r) => simulateSolanaTeardown(r, f.wire, w.address, addresses)));
      checkSolanaTeardownFrames(frames.map((f) => f.wire), ctx, { accounts, wallet: [held[0][0]?.lamports ?? 0n, held[1][0]?.lamports ?? 0n], simulations });
      return { keep: plan.keep, signed: await signAll(frames.map((f) => f.wire)), last: bh.lastHeight };
    });
    if (teardown === null) return end("gave_up", "the teardown");
    if (teardown.ok === null) return end("holds", "W holds a token it traded: its sell has not filled");
    for (const f of teardown.ok.signed) await send(f.signed, f.signature);
    // each frame on both RPCs, failed on both, or past its blockhash on both, within the rent back's one bound
    const open = new Set(teardown.ok.signed);
    for (let i = 0; i < reads && open.size > 0 && (i === 0 || clock() < deadline); i++) {
      if (i > 0) await wait(POOL_SELL_WAIT_MS);
      for (const f of [...open]) {
        const got = await both(rpcs, (r) => readBack(r, f.signature, f.wire)).catch(() => ["none", "none"] as const);
        if ((got[0] === "ok" && got[1] === "ok") || (got[0] === "failed" && got[1] === "failed")) open.delete(f);
      }
      if (open.size > 0 && (await pastOnBoth(rpcs, teardown.ok.last))) break;
    }
    // a frame still unread: W's lamports are not yet what they stay, so no sweep is priced on them
    if (open.size > 0) return end("gave_up", "a teardown frame was not read back");
    if (teardown.ok.keep.length > 0) return end("kept", teardown.ok.keep.map((k) => `${k.address}: ${k.why}`).join("; "));
    // 2. the sweep
    const floor = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
    const sweep = await again("sweep", async () => {
      // W and its accounts read again, after the frames (review M-A: a frame that failed on chain, a token sent to W's
      // account meanwhile, leaves an account open): the sweep only when the plan now closes nothing and keeps nothing,
      // so W keeps the fee for what is still open
      const now = await readW();
      if (now.holds) return { end: "kept" as const, detail: "W holds a token it traded" };
      if (now.plan.keep.length > 0) return { end: "kept" as const, detail: now.plan.keep.map((k) => `${k.address}: ${k.why}`).join("; ") };
      if (now.plan.close.length > 0) return { end: "gave_up" as const, detail: `still open after the teardown: ${now.plan.close.map((c) => c.address).join(", ")}` };
      const [a, b] = now.held.map((v) => v[0]?.lamports ?? 0n);
      if (a !== b) throw new Error("W's lamports differ on the two RPCs");
      const lamports = a!;
      if (lamports === 0n) return { end: "nothing" as const, detail: "W holds nothing" };
      const sizes = await treeSizes(rpcs, x.program, x.pool, wait);
      const s = await seed();
      let found: Awaited<ReturnType<typeof returnNote>>;
      try {
        found = await returnNote(rpcs, x.program, x.scope, x.store, x.sync, s, w.l, w.j, h.settled);
      } finally {
        // zeroed however the walk ends (review L-C: it throws while the sell's note is pending)
        s.fill(0);
      }
      const { ref, precommitment, planned } = found;
      const pre = be32(precommitment);
      const held = await depositHeld(rpcs, x.program, sizes, pre, wait);
      const value = lamports - SOLANA_POOL_SELL_FEE - solanaDepositRents(rent, sizes, held);
      if (value < floor) return { end: "floor" as const, detail: `W's ${lamports} would make a note of ${value}, under ${floor}: kept on W` };
      const bh = await blockhashOf(rpcs);
      const { message } = solanaCompileV0(w.address, [depositIx(x.program, x.pool, w.address, sizes, pre, value)], bh.blockhash, []);
      const wire = wireOf(message);
      // the one signature's fee, as both RPCs price this very message: anything else would leave W short or holding some
      const fees = await both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
      if (fees[0] !== SOLANA_POOL_SELL_FEE || fees[1] !== SOLANA_POOL_SELL_FEE) throw new Error(`the sweep's fee reads ${fees[0]} and ${fees[1]}`);
      checkSolanaSweep(wire, { ...ctx, precommitment }, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize }, lamports, rent, held);
      const sims = await both(rpcs, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } } | null)?.value);
      // a simulation that fails on either RPC (one a slot behind, a page another deposit just filled): read again
      if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) throw new Error(`the sweep simulates ${JSON.stringify(sims.map((v) => v?.err ?? null))}`);
      const [one] = await signAll([wire]);
      return { end: "sent" as const, ref, precommitment, planned, value, one: one!, last: bh.lastHeight };
    });
    if (sweep === null) return end("gave_up", "the sweep");
    const sw = sweep.ok;
    if (sw.end !== "sent") return end(sw.end, sw.detail);
    const id = sw.planned ?? (await x.store.add({ ref: sw.ref, scope: x.scope, precommitment: sw.precommitment, state: "PLANNED" })).id;
    await x.store.move(id, "PLANNED", "INCOMING", { send: { signature: sw.one.signature, value: sw.value, last_valid_block_height: BigInt(sw.last) } });
    await send(sw.one.signed, sw.one.signature);
    return end("sent", sw.one.signature);
  } catch (e) {
    // the sell has landed; what is not closed or swept stays on W, owed, and its note, if sent, settles at the next read
    return end("gave_up", faultOf(e));
  } finally {
    for (const s of seeds) s.fill(0);
  }
}

/** A rent back, then its owed record. */
async function rentBackOwed(h: PoolSellHost, x: RentBack, o: OwedRentBack): Promise<void> {
  const e = await rentBack(h, x);
  // W's sell note still INCOMING: its sell may land yet (review M-B), so a W that holds is owed until it settles
  const sending = async (): Promise<boolean> => (await x.store.list()).some((n) => n.state === "INCOMING" && n.scope === x.scope && sellRef(n.ref) && sellOwner(n.ref, x.w.l, x.w.j));
  await owedAfter(h, o, e, sending);
}

const sellOwner = (ref: NoteRef, l: bigint, j: number): boolean => (ref.kind === "return" ? ref.l === l && ref.j === j : ref.kind === "second" && ref.id.id === "R" && ref.id.l === l && ref.id.j === j);

/** The owed record after a pass that ended `e`: dropped once nothing is left to do for W (or after
 *  POOL_RENT_BACK_PASSES passes, told), kept with one pass more while its sweep is unconfirmed or it gave up, so the
 *  next load runs it again; a W that holds is kept as it is while its sell note is INCOMING (`sending`), and dropped
 *  once that note is PLANNED again (its sell never landed: W's next sell owes its own). */
async function owedAfter(h: PoolSellHost, o: OwedRentBack, e: RentBackEnd, sending?: () => Promise<boolean>): Promise<void> {
  try {
    if (e === "holds" && (await sending?.())) return;
    if (e !== "sent" && e !== "gave_up") return await h.owed?.drop(o.address);
    if (o.passes + 1 >= POOL_RENT_BACK_PASSES) {
      h.told?.({ address: o.address, step: "rent_back", state: "gave_up", detail: `owed no more after ${POOL_RENT_BACK_PASSES} passes: what is left stays on W` });
      return await h.owed?.drop(o.address);
    }
    await h.owed?.put({ ...o, passes: o.passes + 1 });
  } catch {
    // an owed record that cannot be written: the rent back runs again only while one is stored
  }
}

/**
 * The rent backs owed (a page closed, a provider down past the bound, a sweep not yet confirmed), run again: once per
 * page load (pool-testnet.ts), after the sells settle, under the seed's shared lock (the caller's) and the sell lock,
 * skipped when a sell holds it. A W whose holdings were not read this load waits for the next.
 */
export async function resumeRentBacks(h: PoolSellHost, locks: Locks | null = globalThis.navigator?.locks ?? null): Promise<void> {
  if (!locks || !h.owed) return;
  await locks.request(POOL_SELL_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const owed = await h.owed!.list();
    if (owed.length === 0) return;
    const program = h.pin.program;
    const { pool, scope } = solanaPoolOf(program);
    const rpcs = h.rpcs;
    const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    let setup: { store: NoteStore; sync: SolanaTreeSync; rent: SolanaRent; wallets: readonly BuyWallet[] };
    try {
      setup = { store: await h.notes(), sync: solanaTreeSync(rpcs, program), rent: await readSolanaRent(rpcs), wallets: await h.wallets() };
    } catch (e) {
      // this load's own reads failed (a provider down): a pass for each, told
      for (const o of owed) {
        h.told?.({ address: o.address, step: "rent_back", state: "gave_up", detail: `this load's reads: ${faultOf(e)}` });
        await owedAfter(h, o, "gave_up");
      }
      return;
    }
    const { store, sync, rent, wallets } = setup;
    for (const o of owed) {
      const w = wallets.find((x) => x.chain === "sol" && x.address === o.address && x.l.toString() === o.l && x.j === o.j);
      if (w === undefined) continue;
      await rentBackOwed(h, { rpcs, program, pool, scope, rent, store, sync, w, mints: o.mints, wait }, o);
    }
  });
}

type Locks = Pick<LockManager, "request">;

/** A "sent" answer: the one a later attempt or the run's end replaces. */
const sentAnswer = (a: HostAnswer<"pool.sell"> | HostRefusal): boolean => "result" in a && a.result.stage === "sent";

/** A pool sell's ops record (src/state.ts's op contract: nothing secret), keyed by its request's id: kind "sell", as
 *  the app reads a trade's; `pool` marks it as this kind's, so the settle on load finds it by its transaction. */
type SellOp = { kind: "sell"; pool: "sol"; sha: string; stage: "pending" | TradeStage; txs: TxRef[]; code?: ErrorCode; created_ms: number };

/** What the kind needs beyond a run's host: the wallet store its ops records go in, and the end of the run. */
export type PoolSellKindHost = PoolSellHost & { ops(): Promise<TradeStore>; end?(): void; storeMs?: number };

/** A dead "pending" record (written under its request's lock before the run, so with that lock free its page closed
 *  before it signed): nothing was sent, so it is refused "failed". */
const settleDead = (ops: TradeStore, k: string): Promise<unknown> =>
  ops.update("ops", k, (v) => ((v as SellOp | undefined)?.stage === "pending" ? { ...(v as SellOp), stage: "refused", code: "failed" } : v));

/** Pool sell records left "pending" by requests whose page closed before they signed: refused "failed", so their ids
 *  answer that, never id_reused for good. Run once per page load (pool-testnet.ts). It takes no lock, so a re-ask never
 *  meets one it holds. The order is what makes that safe: first the "pending" records, then which request locks are
 *  held (LockManager.query), and only the records read before that query and not held are settled. A live request
 *  takes its lock before it writes "pending", so a record read before the query is either held at the query or dead;
 *  one written after the first read is never touched (the re-review of fd5eec3). A request that takes a dead record's
 *  lock first settles it the same way (poolSellKind). */
export async function settleDeadSellOps(ops: TradeStore, locks: Pick<LockManager, "query">): Promise<void> {
  const pending: string[] = [];
  for (const k of await ops.keys("ops")) {
    const rec = (await ops.get("ops", k)) as Partial<SellOp> | undefined;
    if (rec?.kind === "sell" && rec.pool === "sol" && rec.stage === "pending") pending.push(k);
  }
  if (pending.length === 0) return;
  const held = new Set(((await locks.query()).held ?? []).map((l) => l.name));
  for (const k of pending) if (!held.has(tradeLock(k))) await settleDead(ops, k);
}

/** Writes a settled sell's stage to the pool sell record that names its transaction (one a closed page left "signed"
 *  or "sent"); a record already at an end stays. */
export async function settleSellOps(ops: TradeStore, signature: string, stage: TradeStage): Promise<void> {
  for (const k of await ops.keys("ops")) {
    const rec = (await ops.get("ops", k)) as Partial<SellOp> | undefined;
    if (rec?.kind !== "sell" || rec.pool !== "sol" || rec.txs?.[0]?.hash !== signature || (rec.stage !== "signed" && rec.stage !== "sent")) continue;
    await ops.update("ops", k, (v) => ({ ...(v as SellOp), stage }));
  }
}

/**
 * The pool.sell kind: one run per tap under the seed's shared lock (a sign out, in any tab, waits for it), the
 * request's own lock (the same id in another tab at once: id_reused) and POOL_SELL_LOCK, answered at the send (W's
 * signature) or at the run's end, then its stage as it comes. Its ops record is written first, under the sell lock, as
 * trade.ts writes a trade's: an id seen before (a reload, a retry after client_timeout) is answered from its record and
 * never runs twice, and the app reads the running sell's stage in state.ops: "signed" with W's signature before the
 * send, "sent", then its end (a closed page's end is written by the settle on load, settleSellOps).
 */
export function poolSellKind(host: () => PoolSellKindHost, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.sell"> => {
    if (ask.kind !== "pool.sell" || ask.chain !== "solana" || !locks || !ctx) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.sell"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    // after a full sell filled, the rent back: run once the sell's stage is told and its request's lock is free (an id
    // seen again is answered from its record, never id_reused), under the seed's shared lock and the sell lock again
    const later: Later = {};
    let ran: PoolSellKindHost | null = null;
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
        try {
          await locks.request(tradeLock(ctx.id), { mode: "exclusive", ifAvailable: true }, async (own) => {
            if (!own) return void (answer ??= { error: "id_reused" });
            const h = (ran = host());
            const ms = h.storeMs ?? TRADE_STORE_MS;
            const ops = timedStore(await h.ops(), ms);
            // the record first, under the request's own lock and before the wait for the sell lock (a sell before it
            // may hold that lock through its verdict): an id seen before is answered from it, never run again
            let prior = await ops.get("ops", ctx.id);
            // "pending" under the lock this request now holds: its writer's page closed before it signed (settleDead)
            if ((prior as Partial<SellOp> | undefined)?.stage === "pending" && (prior as Partial<SellOp>).pool === "sol") {
              await settleDead(ops, ctx.id);
              prior = await ops.get("ops", ctx.id);
            }
            if (prior !== undefined) return void (answer ??= fromRecord(prior, ctx.sha) as HostAnswer<"pool.sell"> | HostRefusal);
            const op: SellOp = { kind: "sell", pool: "sol", sha: ctx.sha, stage: "pending", txs: [], created_ms: Number(h.now?.() ?? BigInt(Date.now())) };
            await ops.put("ops", ctx.id, { ...op });
            let writes: Promise<void> = Promise.resolve();
            const snap = () => ({ ...op, txs: op.txs.map((t) => ({ ...t })) });
            const write = (patch: Partial<SellOp>): void => {
              Object.assign(op, patch);
              const v = snap();
              writes = writes.then(() => ops.put("ops", ctx.id, v)).catch(() => {});
            };
            const txs = (signature: string): TxRef[] => [{ chain: "solana", hash: signature }];
            await locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, async () => {
              const a = await sellRuns({
                ...h,
                // awaited before the send, and not swallowed: a record that cannot name the signature sends nothing
                signed: async (signature) => {
                  await writes;
                  Object.assign(op, { stage: "signed", txs: txs(signature) });
                  await ops.put("ops", ctx.id, snap());
                },
                // each attempt's send names its own signature: a sell built again (L2) answers with the one it sent last,
                // never the attempt that failed (review L-B)
                sent: (signature) => {
                  write({ stage: "sent", txs: txs(signature) });
                  if (!answer || sentAnswer(answer)) answer = { result: { stage: "sent", txs: txs(signature) } };
                  give();
                },
                settled: (signature, stage) => void (writes = writes.then(() => settleSellOps(ops, signature, stage)).catch(() => {})),
              }, ask, later);
              if ("error" in a) write({ stage: "refused", code: a.error });
              else write({ stage: a.stage, txs: a.txs });
              await writes;
              if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
              else {
                // the message api.ts posted at the first send names that attempt (the kit never sends the id again:
                // after its timeout it asks for state, client.ts REASK_STATE); answer() from here on, like the record
                // state.ops reads, names the end and the signature that landed
                if ("stage" in a && sentAnswer(answer)) answer = { result: a };
                if ("stage" in a) ctx.progress(a.stage);
              }
            });
          });
          const back = later.back;
          if (back) await locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, () => back());
        } finally {
          // the run's end (the page closes its note store): after the rent back, which writes its note there
          ran?.end?.();
        }
      })
      .catch(() => {
        if (!answer) answer = { error: "failed" };
      })
      .finally(give);
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
