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
import { simulateSolanaTeardown, solanaCompileV0, solanaTeardownChecked } from "../../kit/src/trade/solana/build.ts";
import { readSolanaPoolBuyVenue, readSolanaRent, SOLANA_POOL_PAGE_ENTRIES, SOLANA_POOL_SELL_FEE, solanaPoolNextPage, solanaPoolPage, solanaPoolSellMinOut, solanaPoolBuySellNeed, solanaPoolSellNeed, solanaPoolSellSteps, solanaRentMin, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SOLANA_POOL_NEXT_PAGE_WINDOW, solanaPoolNoteFloor, solanaPoolPreMarkOf, type SolanaPoolPreMark } from "../../kit/src/trade/solana/pool-deposit.ts";
import { solanaDecodeTokenAccount } from "../../kit/src/trade/solana/pool.ts";
import { pageReference } from "./page-rpc.ts";
import { SOLANA_MAX_TX_BYTES, solanaAta, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_SOL_MINT, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaTeardownAddresses, solanaTeardownPlan, solanaVolumeAccumulator, solanaVolumeClaimable, type SolanaHeldRead, type SolanaTeardownSimulation, type SolanaTeardownUnclaimed } from "../../kit/src/checks/solana/checks.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { ErrorCode, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf, solanaTreeSync, type SolanaPoolPin, type SolanaTreeSync } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { blockhashOf, pastOnBoth, readBack, readBackFailure, readBackMeta, type BuyMints } from "./pool-buy.ts";
import { fromRecord, timedStore, TRADE_STORE_MS, tradeLock, type TradeStore } from "./trade.ts";
import { checkSolanaSell, checkSolanaSweep, checkSolanaTeardownFrames, PoolRuleRefused, poolUnits, signSolana, SOLANA_POOL_MIN_DEPOSIT, SOLANA_POOL_SELL_RESERVE_MAX, SOLANA_SWEEP_OWED_MAX, solanaDepositRents, solanaSellAfterFull, solanaSweepFloor, solanaSweepKeep, type PoolAsk, type SolanaDepositHeld } from "./rules/pool.ts";
// the full sell's keep is priced by the sell's rule too (rules/pool.ts checkSolanaSell, review L1 of 38faee89)
export { solanaSellAfterFull };
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** What a sell run needs from the page. */
export type PoolSellHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** W's buy mint, as the buy wrote it (pool-buy.ts BuyMints): read by the rent back. */
  bought?: BuyMints;
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
  /** A sell settled (by its note's mark, or a sell with no deposit back by its transaction; this run's, or one a closed
   *  page left): its send's signature and the stage, the request's write of it. Awaited before the sell's record (its
   *  INCOMING note, its kept record) is let go: a write that fails keeps the record, so the next load settles it again
   *  (review P3-1 of 5de2165e: a write swallowed after the record went left the request "sent" for good). */
  settled?(signature: string, stage: TradeStage): void | Promise<void>;
  /** The rent backs owed (card sol-buy-rent-back): written before a full sell leaves the device, dropped once its rent
   *  back ends, run again on the next load (resumeRentBacks) while it is owed. */
  owed?: OwedRentBacks;
  /** The sells with no deposit back (kept on W) sent and not yet settled: written before the send, dropped at their
   *  verdict once its stage is written (settled), settled on the next load (settlePoolSells) while here. */
  kept?: KeptSells;
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

/** One wallet's sale in a sell (card pool-sell-share-across-wallets): W's address, the token's base units it sells (a
 *  decimal string, as an answer carries it), its transaction's signature once W signed (null: it ended before signing),
 *  and how it ended: its stage, or the refusal before it signed. */
export type PoolSellLeg = { wallet: string; amount: string; tx: string | null; stage: TradeStage | null; error?: PoolSellError };
type PoolSellError = "not_allowed" | "not_funded" | "quote_check_failed" | "failed" | "down";
/** A sell's answer: its stage over every wallet's sale (filled when each filled, part_filled when some did), each sale's
 *  transaction in `txs`, and every sale in `legs`; or a refusal, nothing signed. */
export type PoolSellAnswer = { stage: TradeStage; txs: TxRef[]; legs?: readonly PoolSellLeg[] } | { error: PoolSellError };

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
/** The rent back's rules, as what W read as (heldSeen) hashes them: a release bumps it whenever the floor, the least
 *  deposit, the sweep's fee or a reason the kit's teardown keeps an account changes, so a W skipped under the old rules
 *  runs a pass under the new (review 5 of 38e59182, L3). */
export const POOL_RENT_BACK_RULES = 1;
/** The lock one W's rent back holds for its whole pass, sleeps included, so two never run on one W; the sell lock it
 *  holds only between its sleeps (review 5 of 38e59182, M1). */
const backLock = (address: string): string => `ct-pool/back/${address}`;
/** A sell whose deposit met a tree page another deposit filled first (WrongAccount on both RPCs, nothing moved): built
 *  again from new reads, at most this many times (review L2). */
export const POOL_SELL_REBUILDS = 2;
/** contracts/pool-solana/src/error.rs PoolError::WrongAccount. */
const POOL_WRONG_ACCOUNT = 22;

const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const TREE_LEN = 8 + 1 + 33 * 32;
const OFF_TREES = 49;
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

/** One account as an RPC gives it (base64), with the slot it answered at; none when there is no account. `lamports` as
 *  the RPC wrote it, read only where it is priced (W's balance): the pool's, a mint's or a mark's balance is never a
 *  number a sell needs, so no size of it ever refuses one. */
async function account(rpc: SolanaRpc, address: string, commitment: "confirmed" | "finalized", minContextSlot?: number): Promise<{ slot: number; owner: string; data: Uint8Array; lamports: unknown } | { slot: number; none: true }> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment, ...(minContextSlot === undefined ? {} : { minContextSlot }) }])) as { context?: { slot?: unknown }; value?: unknown };
  const slot = int(r?.context?.slot);
  const v = r?.value as { owner?: unknown; data?: unknown; lamports?: unknown } | null | undefined;
  if (v === null) return { slot, none: true };
  if (typeof v?.owner !== "string" || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return no();
  return { slot, owner: v.owner, data: base64.decode(v.data[0]), lamports: v.lamports };
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
  // the kit's parse: a stranger's system account at the address is no mark (the deposit takes it over; card
  // pool-deposits I-3), anything but the program's 17-byte mark refused
  const mark = (x: typeof a): SolanaPoolPreMark | null => {
    if ("none" in x) return null;
    try {
      return solanaPoolPreMarkOf(x, program);
    } catch {
      return no();
    }
  };
  const [ma, mb] = [mark(a), mark(b)];
  if (ma === null && mb === null) return null;
  if (ma === null || mb === null) return "one";
  if (ma.value !== mb.value || ma.nonce !== mb.nonce) return no();
  return { value: ma.value, nonce: ma.nonce, slot: Math.max(a.slot, b.slot) };
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
async function settleSellNote(rpcs: Rpcs, program: string, scope: bigint, sync: SolanaTreeSync, store: NoteStore, n: NoteRecord, dead = false, settled?: (signature: string, stage: TradeStage, end: Exclude<SellEnd, "pending">) => void | Promise<void>): Promise<{ end: SellEnd; signature: string | null }> {
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
    // our transaction failed on both: a mark of any value is another deposit's (the user's note all the same), never
    // the sale's, so the sell is refused even at exactly its value
    const end = !dead && send !== undefined && m.value === send.value ? "filled" : "taken";
    // the request's stage first: a write that fails leaves the note INCOMING, settled again at the next load
    if (signature !== null) await settled?.(signature, stageOf(end, dead), end);
    await store.move(n.id, "INCOMING", "UNSPENT", { leaf });
    return { end, signature };
  }
  if (m === null && past) {
    if (signature !== null) await settled?.(signature, stageOf("dropped", dead), "dropped");
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
async function returnNote(rpcs: Rpcs, program: string, scope: bigint, store: NoteStore, sync: SolanaTreeSync, seed64: Uint8Array, l: bigint, j: number, settled?: (signature: string, stage: TradeStage) => void | Promise<void>): Promise<{ ref: NoteRef; precommitment: bigint; planned: string | null }> {
  const held = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  for (let n = -1; n <= U32; n++) {
    const ref: NoteRef = n < 0 ? { kind: "return", c: "sol", l, j } : { kind: "second", id: { id: "R", c: "sol", l, j }, n };
    const precommitment = noteSecrets(seed64, ref).precommitment;
    const h = held.get(refKey(ref));
    if (h !== undefined && (h.precommitment !== precommitment || h.scope !== scope)) return no();
    if (h?.state === "INCOMING") {
      const got = await settleSellNote(rpcs, program, scope, sync, store, h, false, settled);
      if (got.end === "pending") return no();
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
export async function settlePoolSells(h: Pick<PoolSellHost, "pin" | "rpcs" | "notes" | "settled" | "kept">, locks: Locks | null = globalThis.navigator?.locks ?? null): Promise<void> {
  if (!locks) return;
  await locks.request(POOL_SELL_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const program = h.pin.program;
    const { scope } = solanaPoolOf(program);
    const store = await h.notes();
    const sync = solanaTreeSync(h.rpcs, program);
    for (const n of await store.list()) {
      if (n.state !== "INCOMING" || n.scope !== scope || !sellRef(n.ref)) continue;
      // a stage that cannot be written leaves the note INCOMING (pending), for the next load
      await settleSellNote(h.rpcs, program, scope, sync, store, n, false, h.settled).catch(() => {});
    }
    // the sells with no deposit back a closed page left sent (review F4 of b38cd8c2): each by its own transaction's
    // verdict, its record dropped once it ends
    for (const k of (await Promise.resolve(h.kept?.list()).catch(() => undefined)) ?? []) {
      const v = await keptVerdict(h.rpcs, k).catch(() => "pending" as const);
      if (v === "pending") continue;
      // the request's stage first, then the record dropped: a write that fails keeps it for the next load
      try {
        await h.settled?.(k.signature, v);
        await h.kept?.drop(k.signature);
      } catch {
        // kept: the next load settles it again (settleSellOps skips a request already at its end)
      }
    }
  });
}

/** A sell with no deposit back, as its record keeps it: the signature, the signed bytes (base64) and its blockhash's
 *  last valid height. */
export type KeptSell = { signature: string; tx: string; last: number };
export type KeptSells = { list(): Promise<KeptSell[]>; put(r: KeptSell): Promise<void>; drop(signature: string): Promise<void> };

/** The sells kept on W, in the wallet store's meta/owed/kept-sell-sol, by signature. */
export const keptSells = (store: () => Promise<Pick<TradeStore, "get" | "update">>): KeptSells => {
  const KEY = "owed/kept-sell-sol";
  type All = Record<string, KeptSell>;
  return {
    list: async () => Object.values(((await (await store()).get("meta", KEY)) as All | undefined) ?? {}),
    put: async (r) => void (await (await store()).update("meta", KEY, (v) => ({ ...((v as All | undefined) ?? {}), [r.signature]: r }))),
    drop: async (signature) =>
      void (await (await store()).update("meta", KEY, (v) => {
        const all = { ...((v as All | undefined) ?? {}) };
        if (!Object.hasOwn(all, signature)) return undefined;
        delete all[signature];
        return all;
      })),
  };
};

/**
 * A sell with no deposit back, read once (no mark to read: the verdict is this very transaction on both RPCs, as
 * pool-buy.ts reads a buy): ok on both, filled; failed on both, refused (nothing moved); on neither, not_landed only once
 * goneOnBoth proves it can never land; anything else, pending. A read that throws on either RPC is no RPC's word
 * (review F1 of b38cd8c2: a 429 or junk from one RPC never reads a landed sell as none), so pending too.
 */
async function keptVerdict(rpcs: Rpcs, k: KeptSell): Promise<"filled" | "refused" | "not_landed" | "pending"> {
  const signed = base64.decode(k.tx);
  const got = await both(rpcs, (r) => readBackFailure(r, k.signature, signed)).catch(() => null);
  if (got === null) return "pending";
  if (got[0].got === "ok" && got[1].got === "ok") return "filled";
  if (got[0].got === "failed" && got[1].got === "failed") return "refused";
  if (got[0].got === "none" && got[1].got === "none" && (await goneOnBoth(rpcs, k.signature, k.last))) return "not_landed";
  return "pending";
}

/**
 * True only when `signature` can never land and has not: both RPCs' finalized height past `last` (pastAt, each RPC's
 * slot of that block), then each RPC's status of the signature, over its whole history, null at a context slot at or
 * past that RPC's own (review F3 of b38cd8c2: a backend lagging behind a balancer never reads a landed transaction as
 * none, as the note's mark is read at minContextSlot). A read that fails, or a slot behind, is "not yet".
 */
async function goneOnBoth(rpcs: Rpcs, signature: string, last: number): Promise<boolean> {
  const at = await pastAt(rpcs, last);
  if (at === null) return false;
  try {
    const got = await Promise.all(rpcs.map(async (r, i) => {
      const s = (await r("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])) as { context?: { slot?: unknown }; value?: unknown } | null;
      return int(s?.context?.slot) >= at[i]! && Array.isArray(s?.value) && s.value.length === 1 && s.value[0] === null;
    }));
    return got[0] === true && got[1] === true;
  } catch {
    return false;
  }
}

/** What a sell leaves to run after its answer: the rent back, after a full sell filled; or the sell built again, its
 *  deposit having met a page another deposit filled first. */
type Later = { back?: (locks: Locks | null) => Promise<unknown>; rebuild?: true; last?: boolean };

/** One W's rent back owed: W, its l and j (W again from the seed), the mints it traded, and its passes so far; `seen`,
 *  what W read as (heldSeen) when its last pass ended on W's own state (under the floor, holding, an account kept), so
 *  a load that reads W the same skips the pass. */
export type OwedRentBack = { address: string; l: string; j: number; mints: { mint: string; program: string }[]; passes: number; seen?: string; sell?: Readonly<Record<string, SoldBy>> };
/** A full sell of one mint, as W's owed record keeps it (card sol-rent-back-dust-burn): its signed bytes (base64) and its
 *  blockhash's last valid height, so a balance W's account of that mint holds after this very transaction landed
 *  leaving it none is a stranger's, burned by the rent back. */
type SoldBy = { tx: string; last: number };
export type OwedRentBacks = { list(): Promise<OwedRentBack[]>; put(r: OwedRentBack): Promise<void>; drop(address: string): Promise<void> };
/** How a rent back ended: its sweep sent; nothing left on W; W under the smallest note (solanaSweepFloor), its lamports
 *  kept on W; an account the plan keeps (so W keeps the fee to close it later); W holding a token; or it gave up. */
// "owed": W keeps what a later claim of its owed cashback needs: an account whose claim did not simulate on either RPC
// this pass (review M1 of 11c963f9), with the rest under the floor once that claim's cost is kept (solanaSweepKeep,
// card sol-w-sweep); nothing is swept this pass and the record stays, so a later pass claims it and sweeps
// "refused": the kit's plan refuses W's accounts as both RPCs read them alike, byte for byte (review 5 of 38e59182, M1):
// the same reads plan the same refusal, so the pass ends at once, W keeping all, and waits for W to read otherwise
export type RentBackEnd = "sent" | "nothing" | "floor" | "owed" | "kept" | "holds" | "refused" | "gave_up";
export type RentBackTold = { address: string; step: "teardown" | "sweep" | "rent_back"; state: "fault" | "gave_up" | RentBackEnd; detail: string };

/** The rent backs owed, in the wallet store's meta/owed/rentback-sol (meta/owed/ is never read or listed by the frame). */
export const owedRentBacks = (store: () => Promise<Pick<TradeStore, "get" | "update">>): OwedRentBacks => {
  const KEY = "owed/rentback-sol";
  type All = Record<string, OwedRentBack>;
  return {
    list: async () => Object.values(((await (await store()).get("meta", KEY)) as All | undefined) ?? {}),
    // a record written goes to the end of the list, so a load tries the least recently tried W first (review 5 of
    // 38e59182, L2: a W that ends its pass without progress never holds the rest behind it)
    put: async (r) =>
      void (await (await store()).update("meta", KEY, (v) => {
        const all = { ...((v as All | undefined) ?? {}) };
        delete all[r.address];
        all[r.address] = r;
        return all;
      })),
    drop: async (address) =>
      void (await (await store()).update("meta", KEY, (v) => {
        const all = { ...((v as All | undefined) ?? {}) };
        if (!Object.hasOwn(all, address)) return undefined;
        delete all[address];
        return all;
      })),
  };
};

/** W's buy mints, in the wallet store's meta/owed/buy-sol, by W's address (pool-buy.ts BuyMints). */
export const buyMints = (store: () => Promise<Pick<TradeStore, "get" | "update">>): BuyMints => {
  const KEY = "owed/buy-sol";
  type All = Record<string, { mint: string; program: string }>;
  return {
    get: async (address) => {
      const all = ((await (await store()).get("meta", KEY)) as All | undefined) ?? {};
      return Object.hasOwn(all, address) ? all[address] : undefined;
    },
    put: async (address, m) => void (await (await store()).update("meta", KEY, (v) => ({ ...((v as All | undefined) ?? {}), [address]: { mint: m.mint, program: m.program } }))),
  };
};

/** One W's sale, built again (POOL_SELL_REBUILDS at most) while its deposit meets a page another deposit filled first. */
async function sellRuns(h: PoolSellHost, ask: PoolAsk, later: Later, w: BuyWallet): Promise<LegAnswer> {
  for (let i = 0; ; i++) {
    delete later.rebuild;
    later.last = i >= POOL_SELL_REBUILDS;
    const a = await sellRun(h, ask, later, w);
    if (!later.rebuild || i >= POOL_SELL_REBUILDS) return a;
  }
}

/** One wallet's sale as its run answers it. */
type LegAnswer = { stage: TradeStage; txs: TxRef[] } | { error: PoolSellError };

/** A sell's plan: the units it sells over every wallet, and each wallet's sale in the order they run. */
export type PoolSellPlan = { units: bigint; total: bigint; legs: readonly { w: BuyWallet; units: bigint; held: bigint }[] };

/**
 * The sell's plan (card pool-sell-share-across-wallets), from the device's own reads alone. Every buy of a token lands in
 * its own fresh wallet W, so the user's holding of it is spread over several.
 * - The Ws: the page's buy wallets (h.wallets(): every W the pool's spent notes paid, derived from the seed) that its own
 *   buy record names for this token (h.bought, written by the buy before its send) or that the listed holdings show
 *   holding it. The listed holdings (on mainnet the helper's one read) only add a W to read; no amount of theirs is used.
 * - Each W's holding: its token account on both RPCs, the same on both (tokenHeld: read again once, then failed), each W
 *   in requests of its own (a read names one W of the user's at most). A frozen account is not sold (holds 0 here; a
 *   sell it leaves short is not_allowed). A W
 *   that cannot be read fails the whole sell before anything is signed: a share of a total that misses a W would sell
 *   less than the user asked.
 * - The units: a share's, the total times the share in basis points, rounded down (10,000: the whole total, every unit);
 *   a typed amount's, the amount, refused not_funded when it is over the total. Zero: not_funded.
 * - The order: smallest holding first (then by address, so one read gives one plan). Each W the units still cover is
 *   sold whole (the full sell: its accounts closed and every lamport back as a note, the rent back); the first W they do
 *   not cover is sold in part, and the walk ends. Smallest first closes the most Ws and leaves the one part sale where
 *   the most is held.
 */
export async function planPoolSell(h: Pick<PoolSellHost, "rpcs" | "wallets" | "bought">, ask: PoolAsk): Promise<PoolSellPlan> {
  if (ask.kind !== "pool.sell" || ask.chain !== "solana" || ask.token === null) return no("not_allowed");
  const token = ask.token;
  const listed = (await h.wallets()).filter((x) => x.chain === "sol");
  const seen = new Set<string>();
  const ws: BuyWallet[] = [];
  for (const x of listed) {
    if (seen.has(x.address)) continue;
    const bought = await Promise.resolve(h.bought?.get(x.address)).catch(() => undefined);
    if (bought?.mint !== token && !x.holdings.tokens.has(token)) continue;
    seen.add(x.address);
    ws.push(x);
  }
  const held = await Promise.all(
    ws.map(async (w) => {
      try {
        return { w, held: (await tokenHeld(h.rpcs, w.address, token)).amount };
      } catch (e) {
        // frozen on either RPC: never sold, so none of it counts
        if (e instanceof Refused && e.code === "not_allowed") return { w, held: 0n, frozen: true };
        throw e;
      }
    }),
  );
  const order = held.filter((x) => x.held > 0n).sort((x, y) => (x.held < y.held ? -1 : x.held > y.held ? 1 : x.w.address < y.w.address ? -1 : x.w.address > y.w.address ? 1 : 0));
  const total = order.reduce((t, x) => t + x.held, 0n);
  const units = ask.shareBps === undefined ? ask.amount : ask.shareBps === 10_000 ? total : (total * BigInt(ask.shareBps)) / 10_000n;
  // short of the units: a frozen account among the Ws is why (not_allowed, as one W's frozen sale is), else not_funded
  if (units <= 0n || units > total) return no(held.some((x) => "frozen" in x) ? "not_allowed" : "not_funded");
  const legs: { w: BuyWallet; units: bigint; held: bigint }[] = [];
  let left = units;
  for (const x of order) {
    if (left === 0n) break;
    const take = left < x.held ? left : x.held;
    legs.push({ w: x.w, units: take, held: x.held });
    left -= take;
  }
  return { units, total, legs };
}

/** What each wallet's sale is told beyond the run's host: which leg it is, for the host's record. */
export type LegHooks = {
  /** The plan is made: the units the sell takes and each leg's W and units, before any leg runs. */
  planned?(plan: PoolSellPlan): void | Promise<void>;
  /** Leg `i` is signed and about to leave the device: its signature (awaited before the send; a throw sends nothing). */
  signed?(i: number, signature: string): Promise<void> | void;
  /** Leg `i` was sent. */
  sent?(i: number, signature: string): void;
  /** Leg `i` ended (its stage, or its refusal before it signed). */
  ended?(i: number, leg: PoolSellLeg): void;
};

/** The stage of a sell over its legs: filled when each filled; part_filled when some filled and the rest ended without
 *  filling; while any leg may still land, sent; with none filled, refused when any was refused on chain, else not_landed. */
export function stageOfLegs(legs: readonly Pick<PoolSellLeg, "stage" | "error">[]): TradeStage {
  const ended = (l: Pick<PoolSellLeg, "stage" | "error">) => l.error !== undefined || (l.stage !== null && l.stage !== "signed" && l.stage !== "sent");
  if (!legs.every(ended)) return "sent";
  const filled = legs.filter((l) => l.stage === "filled").length;
  if (filled === legs.length) return "filled";
  if (filled > 0) return "part_filled";
  return legs.some((l) => l.stage === "refused" || l.error !== undefined) ? "refused" : "not_landed";
}

/**
 * Every wallet's sale of one sell (card pool-sell-share-across-wallets): the plan (planPoolSell), then each leg as today's
 * complete sell of one W (sellRuns: its own reads, quote check, return note, owed record written before its send, its
 * rent back after a full sale), never changed by the others. The legs take turns up to their send, so each reads its own
 * quote after the one before it left and the page's paced RPCs carry one leg's reads at a time; their verdicts are read
 * side by side. A leg that fails ends alone: nothing is retried, the others' results stand, and the answer names every
 * leg. One leg's refusal before it signed, with no other leg, is the sell's own refusal, as before.
 */
async function sellAll(h: PoolSellHost, ask: PoolAsk, laters: Later[], hooks: LegHooks = {}): Promise<PoolSellAnswer> {
  let plan: PoolSellPlan;
  try {
    plan = await planPoolSell(h, ask);
  } catch (e) {
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof SolanaRpcTransportError) return { error: "down" };
    return { error: "failed" };
  }
  await hooks.planned?.(plan);
  const legs: PoolSellLeg[] = plan.legs.map((l) => ({ wallet: l.w.address, amount: l.units.toString(), tx: null, stage: null }));
  // each leg's turn: the one before it sent, or ended before sending
  let turn: Promise<void> = Promise.resolve();
  const runs = plan.legs.map((l, i) => {
    const later: Later = {};
    laters.push(later);
    let open!: () => void;
    const mine = new Promise<void>((r) => (open = r));
    const prior = turn;
    turn = mine;
    // the run's host with this leg's two hooks; every other field read from `h` when it is read (never a copy taken
    // here: the rule reads the page's pin again at its check)
    const leg: PoolSellHost = Object.assign(Object.create(h) as PoolSellHost, {
      signed: async (signature: string) => {
        legs[i] = { ...legs[i]!, tx: signature, stage: "signed" };
        await hooks.signed?.(i, signature);
        await h.signed?.(signature);
      },
      sent: (signature: string) => {
        legs[i] = { ...legs[i]!, tx: signature, stage: "sent" };
        open();
        hooks.sent?.(i, signature);
        h.sent?.(signature);
      },
    });
    return prior
      .then(() => sellRuns(leg, { ...ask, amount: l.units, shareBps: undefined }, later, l.w))
      .catch((): LegAnswer => ({ error: "failed" }))
      .then((a) => {
        open();
        legs[i] = "error" in a ? { ...legs[i]!, tx: null, stage: null, error: a.error } : { ...legs[i]!, tx: a.txs.at(-1)?.hash ?? legs[i]!.tx, stage: a.stage };
        hooks.ended?.(i, legs[i]!);
        return a;
      });
  });
  const got = await Promise.all(runs);
  if (got.length === 1 && "error" in got[0]!) return got[0]!;
  if (got.every((a) => "error" in a)) return got[0]!;
  const txs: TxRef[] = legs.flatMap((l) => (l.tx === null ? [] : [{ chain: "solana" as const, hash: l.tx }]));
  return { stage: stageOfLegs(legs), txs, legs };
}

/** One pool.sell: the ask is the user's own (rules/pool.ts checkPoolRequest passed it, with the token's decimals): its
 *  units, or its share of the whole holding (planPoolSell). After the sales, each full sale's rent back (rentBack) runs,
 *  one W after another, before this answers; none changes the answer. */
export async function runPoolSell(h: PoolSellHost, ask: PoolAsk): Promise<PoolSellAnswer> {
  const laters: Later[] = [];
  const a = await sellAll(h, ask, laters);
  for (const later of laters) await later.back?.(null);
  return a;
}

async function sellRun(h: PoolSellHost, ask: PoolAsk, later: Later, w: BuyWallet): Promise<LegAnswer> {
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
    if (ask.kind !== "pool.sell" || ask.chain !== "solana" || ask.token === null || ask.shareBps !== undefined || w.chain !== "sol") return no("not_allowed");
    const token = ask.token;
    const amount = ask.amount;
    // W: the plan's (planPoolSell), from the device's own reads; read again here, as every sale does
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
      return "none" in a ? 0n : BigInt(int(a.lamports));
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
    // what W holds after the sell, at least: rent(0), the runtime's floor, when the sell empties W's holding; while W
    // keeps any of the token (the amount both RPCs read), what the next sell of it needs up front on every
    // venue the coin can reach, the buy's rule (solanaPoolBuySellNeed: a curve coin's PumpSwap need, cashback accounts
    // included), so no sell leaves tokens on a W that cannot pay to sell them (the re-review of 40cdc3e)
    const keeps = tokens.amount > amount;
    // the deposit's form: the eight names each tree's next page, so it lands when inserts that land first carry an entry
    // onto that page; the six (as before d3edab1) then fails WrongAccount and is rebuilt from new reads (below). The
    // eight only when the transaction still fits 1,232 bytes with it (a PumpSwap cashback sell with no lookup table
    // does not; the size does not depend on the value), and on a partial sell only when both trees sit within
    // SOLANA_POOL_NEXT_PAGE_WINDOW of their page's end: the reserve prices a next page's opening only there, and a tree
    // further out that more inserts turn would open its next page out of what W keeps for its next sell (review LOW 1)
    const near = (size: number): boolean => SOLANA_POOL_PAGE_ENTRIES - (size % SOLANA_POOL_PAGE_ENTRIES) <= SOLANA_POOL_NEXT_PAGE_WINDOW;
    const fits = wireOf(solanaCompileV0(w.address, [...steps, depositIx(program, pool, w.address, sizes, pre, minOut, true)], bh.blockhash, []).message).length <= SOLANA_MAX_TX_BYTES;
    const eight = fits && (!keeps || (near(sizes.stateSize) && near(sizes.labelSize)));
    // the lamports the deposit's mark and both pages hold, read on both RPCs: the same for either form; with them, W's
    // volume accounts owed a claim after the sell (review L3 of 38faee89): each pump program's whose claim pays out on
    // either RPC's read (solanaVolumeClaimable: one RPC's word that nothing is owed never lowers what W keeps), or the
    // venue's own on a cashback coin, whose sell earns cashback there
    const venueProgram = venue.kind === "pumpswap" ? SOLANA_PUMP_AMM_PROGRAM : SOLANA_PUMP_PROGRAM;
    const owesOn = async (vp: string): Promise<boolean> => {
      if (venue.cashback && vp === venueProgram) return true;
      const reads = await both(rpcs, (r) => account(r, solanaVolumeAccumulator(w.address, vp), "confirmed"));
      return reads.some((a) => !("none" in a) && a.owner === vp && solanaVolumeClaimable(vp, a.data) > 0n);
    };
    const [holds, owed] = await Promise.all([depositHeld(rpcs, program, sizes, pre, wait), Promise.all([SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM].map(owesOn)).then((o) => o.filter(Boolean).length)]);
    // a sell that empties W's holding keeps what lets the rent back's sweep reach the floor (solanaSellAfterFull, card
    // sol-w-sweep): every lamport over it goes into this sell's note
    const after = keeps ? solanaPoolBuySellNeed(venue, rent) : solanaSellAfterFull(rent, owed);
    const floor = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
    // the smallest note the deposit back makes (the kit's solanaPoolNoteFloor at the rent both RPCs read, card
    // sol-sell-deposit-back-floor): under it, no deposit, the sale's lamports stay on W
    const noteFloor = solanaPoolNoteFloor(rent);
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: 0n, solana: h.pin, precommitment };
    /** The sell with the deposit in form `next` (the eight, or the six), its reserve priced for that form, checked by
     *  the sell's rule; refused (thrown) when it cannot go. A value of 0: the venue's sell alone, no deposit (the deposit
     *  back would land under noteFloor). Nothing is signed or sent here. */
    const form = async (next: boolean): Promise<{ wire: Uint8Array; value: bigint }> => {
      const build = (value: bigint): { message: Uint8Array; wire: Uint8Array } => {
        const { message } = solanaCompileV0(w.address, value === 0n ? steps : [...steps, depositIx(program, pool, w.address, sizes, pre, value, next)], bh.blockhash, []);
        return { message, wire: wireOf(message) };
      };
      // the fee both RPCs price the message at: per signature, with no compute budget, so the deposit's value (the one
      // thing the reserve changes) changes nothing it prices
      const [fa, fb] = await both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(build(minOut).message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
      if (fa !== fb) return no();
      // the need again at the fee both RPCs price this very message at
      if (lamports < need - SOLANA_POOL_SELL_FEE + fa) return no("not_funded");
      // the rents the deposit takes from W, as the program prices them (review L1): its mark and both pages topped up to
      // their rent at their new length, less what each holds (anyone may send lamports to one), read on both RPCs;
      // the eight priced at the kit's window (an insert landing first can carry an entry onto the next page, which the
      // deposit then opens at W's cost); what it does not spend stays on W for its next sell or the sweep
      const r0 = solanaRentMin(rent, 0);
      const r = solanaSellReserve({ fee: fa, made, rents: solanaDepositRents(rent, sizes, holds, next), after, lamports, minOut, keeps, noteFloor, ...(keeps ? {} : { swept: after - r0, base: r0, floor }) });
      if ("refused" in r) return no(r.refused);
      // the eight's deposit back under noteFloor: refused here, so the six, priced exactly, is tried for a note
      if (next && r.value === 0n) return no("quote_check_failed");
      const { reserve, value } = r;
      const { wire } = build(value);
      checkSolanaSell(wire, ask, ctx, venue, quote, bh.slot, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize }, reserve, { full: !keeps, lamports, fee: fa, made, rent, held: holds, next, owed });
      return { wire, value };
    };
    // the eight first; refused before signing (its reserve, priced at the window, over min out or the cap, or its
    // deposit back under noteFloor), the six priced exactly, so no sell the six carries is refused (review LOW 3) and
    // no note the six can make is left on W
    let built: { wire: Uint8Array; value: bigint } | null = null;
    if (eight)
      try {
        built = await form(true);
      } catch (e) {
        if (!(e instanceof Refused || e instanceof PoolRuleRefused)) throw e;
      }
    const { wire, value } = built ?? (await form(false));
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
    // reloaded from here on leaves a record its next load settles (settlePoolSells) by the same verdict rules. No
    // deposit back (value 0, under noteFloor): no note, the return note left as it was for the next sell
    const kept = value === 0n;
    const note = kept ? null : await store.move(planned ?? (await store.add({ ref, scope, precommitment, state: "PLANNED" })).id, "PLANNED", "INCOMING", { send: { signature, value, last_valid_block_height: BigInt(bh.lastHeight) } });
    // no deposit back (review F4 of b38cd8c2): its transaction written before it leaves the device and before the
    // request's record names it (as the note above), so a page closed from here on leaves a record its next load settles
    // (settlePoolSells) by the same verdict; a record with no op is harmless; a write that fails sends nothing
    if (kept) await h.kept?.put({ signature, tx: base64.encode(signed), last: bh.lastHeight });
    // a full sell owes W's rent back from here: written before the send, so a page closed from here on runs it at its
    // next load (resumeRentBacks); a sell that never lands leaves W holding the token, and that rent back ends "kept"
    // W's record keeps every mint W traded (review 5 of 38e59182, info: a W that fully sells a second mint keeps its
    // first mint's accounts in its rent back)
    const owedRec: OwedRentBack = { address: w.address, l: w.l.toString(), j: w.j, mints: [{ mint: token, program: tokens.program }], passes: 0 };
    if (!keeps) {
      const prior = await Promise.resolve(h.owed?.list()).then((l) => l?.find((r) => r.address === w.address), () => undefined);
      owedRec.mints = mintsOf(prior?.mints, owedRec.mints);
      // this sell, by its mint: what a balance after it is checked against (card sol-rent-back-dust-burn)
      owedRec.sell = { ...prior?.sell, [token]: { tx: base64.encode(signed), last: bh.lastHeight } };
      await h.owed?.put(owedRec).catch(() => {});
    }
    // the request's record names the signature before it leaves the device (a write that fails sends nothing)
    await h.signed?.(signature);
    sent = signature;
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    h.sent?.(signature);
    const txs: TxRef[] = [{ chain: "solana", hash: signature }];
    // a full sell filled, with its deposit back or without one: W holds none of the token, so the rent its accounts lock
    // and every lamport it keeps go back, the sell's record with it (what a balance after it is checked against)
    const back: NonNullable<typeof later.back> = (locks) => withHolds(locks, w.address, false, wait, (hold) => rentBackOwed(h, { rpcs, program, pool, scope, rent, store, sync, w, mints: owedRec.mints, wait, ...(owedRec.sell ? { sell: owedRec.sell } : {}) }, owedRec, hold));
    // the verdict: the chain's word on the note's mark, never an RPC's tx history alone
    const reads = h.reads ?? POOL_SELL_READS;
    // the reads are a time budget too (POOL_SELL_READS a second apart): one RPC down, each read's retry its own 3.5 s,
    // never holds the seed's lock past it; the note, INCOMING, settles at the next load or sell
    const clock = (): number => Number(h.now?.() ?? BigInt(Date.now()));
    const sentAt = clock();
    for (let i = 0; i < reads && (i === 0 || clock() - sentAt < POOL_SELL_READS * POOL_SELL_WAIT_MS); i++) {
      if (i > 0) await wait(POOL_SELL_WAIT_MS);
      // no deposit back: no mark to read, so the verdict is this very transaction's on both RPCs (keptVerdict); its
      // record dropped once it ends, so a load leaves it be
      if (note === null) {
        const v = await keptVerdict(rpcs, { signature, tx: base64.encode(signed), last: bh.lastHeight });
        if (v === "pending") continue;
        // the request's stage before the record goes: a write that fails throws, answered "sent" below, the record
        // kept for the next load (review P3-1 of 5de2165e)
        await h.settled?.(signature, v);
        await h.kept?.drop(signature).catch(() => {});
        if (v === "filled" && !keeps) later.back = back;
        return { stage: v, txs };
      }
      const got = await both(rpcs, (r) => readBackFailure(r, signature, signed)).catch((): { got: "none"; err?: unknown }[] => [{ got: "none" }, { got: "none" }]);
      // this very transaction failed on chain, on both RPCs: the sale and the deposit are one, nothing moved
      const dead = got[0].got === "failed" && got[1].got === "failed";
      // the request's stage before the note leaves INCOMING (a write that fails throws, answered "sent" below, the
      // note settled at the next load), but for a sell built again: the next attempt's record names its own signature
      const again = dead && !later.last && got.every((g) => wrongAccount(g.err, steps.length));
      const { end } = await settleSellNote(rpcs, program, scope, sync, store, note, dead, (sig, stage, e) => (again && e === "dropped" ? undefined : h.settled?.(sig, stage)));
      // its deposit (the last instruction) met a page another deposit filled first, and its note is PLANNED again (the
      // settle dropped it, review L-A): built again from new reads
      if (dead && end === "dropped" && got.every((g) => wrongAccount(g.err, steps.length))) later.rebuild = true;
      if (end === "filled" && !keeps) later.back = back;
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

/**
 * A sell's reserve for one deposit form and the deposit's value (review LOW 3): what W lacks, on top of what it holds,
 * to pay the fee, what the sell makes at W's cost (`made`), the deposit's rents for that form (`rents`,
 * solanaDepositRents) and what W must keep after (`after`). A partial sell (`keeps`) whose reserve passes the cap is
 * refused not_funded, never shrunk: the rest would be stranded on W, and selling more than the user asked is never the
 * device's call. A reserve over the cap (less `swept`, what of a full sell's keep the rent back's sweep carries into the
 * user's note) or at or over the min out is refused quote_check_failed. A deposit back under `noteFloor` (the kit's
 * solanaPoolNoteFloor at the rent read on two RPCs, card sol-sell-deposit-back-floor: a note no release can take whole,
 * which with no ragequit and no merge would stay in the pool at a loss) is never built: the answer's value is 0, the
 * sale's whole min out stays on W, where the next sell or the rent back's sweep carries it into a note.
 */
export function solanaSellReserve(p: { fee: bigint; made: bigint; rents: bigint; after: bigint; lamports: bigint; minOut: bigint; keeps: boolean; noteFloor: bigint; swept?: bigint; base?: bigint; floor?: bigint }): { reserve: bigint; value: bigint } | { refused: "not_funded" | "quote_check_failed" } {
  // a full sell too small to hold the sweep's keep back keeps `base` (rent(0)) only, as before: its rents then stay on
  // W; so does one whose own note would land under `floor`, which no withdraw or buy could spend (review M1 of
  // 38faee89: min out 4,000,000 from W at a curve buy's 1,493,440 made a 1,430,640 note; rent(0) makes it 3,370,080)
  if (!p.keeps && p.base !== undefined) {
    const r = solanaSellReserve({ ...p, base: undefined });
    return "refused" in r || r.value < (p.floor ?? 0n) ? solanaSellReserve({ ...p, after: p.base, swept: 0n, base: undefined }) : r;
  }
  const short = p.fee + p.made + p.rents + p.after - p.lamports;
  // a sell that empties W's holding deposits W's surplus too (a reserve under 0, card sol-w-sweep); a partial sell
  // leaves it on W for the next sell
  const reserve = short > 0n || !p.keeps ? short : 0n;
  if (p.keeps && reserve > SOLANA_POOL_SELL_RESERVE_MAX) return { refused: "not_funded" };
  // the cap bounds what is held out of the user's notes: of `after`, what the rent back's sweep carries into one
  // (`swept`, a full sell's keep over rent(0)) is not
  if (reserve - (p.swept ?? 0n) > SOLANA_POOL_SELL_RESERVE_MAX || reserve >= p.minOut) return { refused: "quote_check_failed" };
  // the floor is never under the program's least deposit (lib.rs MIN_DEPOSIT), so no deposit the program refuses is built
  if (typeof p.noteFloor !== "bigint" || p.noteFloor < SOLANA_POOL_MIN_DEPOSIT) return { refused: "quote_check_failed" };
  return { reserve, value: p.minOut - reserve < p.noteFloor ? 0n : p.minOut - reserve };
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

/** The tag 1 deposit of `value` from W into the pinned pool on `pre`, at the tree sizes read: the six accounts, then with
 *  `next` each tree's next page (contracts/pool-solana/src/deposit.rs:72-76 since d3edab1), so an insert that lands first
 *  and turns a page does not fail it (state.rs page_for). */
const depositIx = (program: string, pool: string, wallet: string, sizes: { stateSize: number; labelSize: number }, pre: Uint8Array, value: bigint, next = true) => ({
  program,
  accounts: [
    { key: pool, signer: false, writable: true },
    { key: wallet, signer: true, writable: true },
    { key: solanaPoolPage(program, 0, sizes.stateSize), signer: false, writable: true },
    { key: solanaPoolPage(program, 1, sizes.labelSize), signer: false, writable: true },
    { key: markAddress(program, pre), signer: false, writable: true },
    { key: SOLANA_SYSTEM_PROGRAM, signer: false, writable: false },
    ...(next
      ? [
          { key: solanaPoolNextPage(program, 0, sizes.stateSize), signer: false, writable: true },
          { key: solanaPoolNextPage(program, 1, sizes.labelSize), signer: false, writable: true },
        ]
      : []),
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

type RentBack = { rpcs: Rpcs; program: string; pool: string; scope: bigint; rent: SolanaRent; store: NoteStore; sync: SolanaTreeSync; w: BuyWallet; mints: readonly { mint: string; program: string }[]; wait: (ms: number) => Promise<void>; sell?: Readonly<Record<string, SoldBy>>; buy?: { mint: string; program: string } | null };

/**
 * W's rent back (card sol-buy-rent-back), after a full sell filled or at a later load while it is owed: what W's
 * accounts lock comes back to W, then everything W holds goes into the pool as W's next return note. Runs under W's own
 * lock (backLock) for the whole pass and under the sell lock between its sleeps only (`hold`: it lets the sell lock go
 * for each sleep and takes it again if it is free; a sell that took it ends the pass, "gave_up", W kept for the next
 * load; review 5 of 38e59182, M1: a tap waits for one try at most, never a sleep), never throws, and ends in a RentBackEnd the host is told, as it is told each step's fault: the sell has
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
 *    is on both RPCs, failed on both, or past its blockhash on both. A cashback claim whose frame errs on both RPCs
 *    while every other frame is clean on both is planned around, its program's claims off (the kit's
 *    solanaTeardownChecked; one RPC's error is a fault, read again): its volume account stays open, with the reason,
 *    every other close still goes, and the rent back ends "owed", so W stays owed and a later pass claims it.
 * 2. The sweep, only when the plan keeps nothing but volume accounts owed cashback a claim could not take this time
 *    (review L4: an account kept holding tokens, or owing incentives or volume, needs W's fee to be claimed or closed
 *    later, so W keeps all) and every frame read back: W's lamports, the same on both RPCs, less its one fee, the rents
 *    the deposit takes as the program prices them (solanaDepositRents: its mark and both pages, from their lamports on
 *    both RPCs) and, per volume account still owed cashback, what its later claim costs (solanaSweepKeep, card
 *    sol-w-sweep: that claim's frame fee and the claim account's rent, and rent(0) so W stays an account), deposited
 *    (tag 1) on the next of W's return notes (returnNote's walk: the sell's return note has landed, so its R second
 *    arrivals), checked by the rule (checkSolanaSweep: W ends at exactly that keep, 0 when nothing is owed), simulated
 *    unsigned on both, then signed; a sweep that leaves an owed claim ends "sent", so W stays owed and the next pass
 *    claims it; its note INCOMING with the send before it leaves, then the sell
 *    lock is free (review L6): the settle at the next state read (settlePoolSells) gives its verdict. Under the smallest
 *    note the device spends (solanaSweepFloor, review M1), nothing is sent: W keeps its lamports.
 * W's own coin is its one buy's mint, which the buy writes before its send (h.bought): it joins the record's mints, so W
 * holding any unit of it holds the pass and keeps every lamport its sell needs (delta review 7 of 08290868). Any other
 * mint (an airdrop, a stranger's token) never holds the pass back: its account is not among the addresses the plan
 * reads, so it is never burned or closed, its tokens stay W's under the 12 words, and W's SOL is swept as usual (review 6
 * of 13898c19, F2). A W with no buy record (a buy from before the record, or a restored device) holds while the page's
 * holdings show any token the record does not name: its own coin is never stranded, at worst its rent waits.
 */
async function rentBack(h: PoolSellHost, x: RentBack, hold?: Hold): Promise<Ended> {
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
  const { rpcs, w, rent } = x;
  // every sleep of the pass: the sell lock let go for it and taken again only if it is free
  const wait = async (ms: number): Promise<void> => {
    if (!hold) return x.wait(ms);
    if (!(await hold.nap(ms))) throw BUSY;
  };
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
  // how the pass ended, and whether it ended on W's own state (W kept as it reads: under the floor at the cheapest
  // deposit, holding, an account kept, refused alike by both RPCs' reads), the ends whose `seen` a load skips on
  const end = (e: RentBackEnd, detail: string, steady = e === "holds" || e === "kept" || e === "refused"): Ended => (tell("rent_back", e, detail), { end: e, steady });
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
        if (e === BUSY) throw e;
        tell(step, "fault", faultOf(e));
      }
    }
    tell(step, "gave_up", `no try passed in ${POOL_RENT_BACK_TRIES} tries or ${POOL_RENT_BACK_MS} ms`);
    return null;
  };
  try {
    // no buy record of W's (a buy from before it was written, or a restored device): the pass holds, W's SOL kept on W
    // under the 12 words (delta review 8 of 5697d7a1, F1). Only the record names W's own coin: on mainnet the page's
    // holdings are the helper's word (pool-testnet.ts, solanaHelperHoldings), and a sweep is never signed on it. With
    // the record, W's buy mint is among x.mints (rentBackOwed) and a stranger's mint never holds the pass back
    if (!x.buy) return end("holds", "no buy of W's is recorded");
    const addresses = solanaTeardownAddresses(w.address, x.mints);
    // W's accounts and W, in one getMultipleAccounts call on each RPC (one slot each): the plan over them, and whether
    // W still holds a mint it traded (review M-B: an owed record from a sell that never filled, or not yet); planned with
    // claims off and `unclaimed` the reason when the teardown's claim did not simulate (the kit's solanaTeardownChecked)
    // one mint's full sell (the owed record's `sell`), on both RPCs at finalized: "yes" when this very transaction is
    // final and ok, its meta saying plainly what W's account of that mint held after it, so what W holds of it now came
    // after, a stranger's (a full sell sells exactly the balance both RPCs read, and W gets its own units only from its
    // one buy: whatever it left, a front-run unit included, is a stranger's; review of bf467ae7, F1); "no" when both say
    // plainly the balance is W's own (no record of the sell, as one written before this card; it failed; it never
    // landed, past its blockhash on both); "unsure" while neither has it final yet and its blockhash still runs (it may
    // land or be landing: W holds, not as its own state, so the next load reads it again, at chain finality); anything
    // else (another transaction, the RPCs differ, a meta that does not say it, an RPC down) throws, a fault read again
    const soldOne = async (m: string): Promise<"yes" | "no" | "unsure"> => {
      const by = x.sell?.[m];
      if (by === undefined) return "no";
      const signed = base64.decode(by.tx);
      if (signed.length < 65 || signed[0] !== 1) throw new Error("the owed record's sell is not one signed transaction");
      const got = await both(rpcs, (r) => readBackMeta(r, base58.encode(signed.subarray(1, 65)), signed, "finalized"));
      if (got.every((g) => g.got === "failed")) return "no";
      if (got.every((g) => g.got === "none")) return (await goneOnBoth(rpcs, base58.encode(signed.subarray(1, 65)), by.last)) ? "no" : "unsure";
      if (!got.every((g) => g.got === "ok")) throw new Error(`the sell reads ${got.map((g) => g.got).join("/")}`);
      const [a, b] = got.map((g) => leftAfter(g.meta, w.address, m));
      if (a === null || b === null || a !== b) throw new Error("the sell's meta does not say plainly what W's account held after it");
      return "yes";
    };
    const readW = async (unclaimed?: SolanaTeardownUnclaimed) => {
      // each recorded sell read before W's accounts (review of bf467ae7, F5): a sell final before them left W's account
      // as the sell's meta says, so a balance read after it is a stranger's; a sell landing between the two reads is not
      // final at the first, reads unsure, and W holds to the next load. What a sell read throws counts only for a mint
      // W still holds.
      const sells = new Map<string, "yes" | "no" | "unsure" | { fault: unknown }>();
      for (const m of x.mints) if (x.sell?.[m.mint] !== undefined) sells.set(m.mint, await soldOne(m.mint).catch((e: unknown) => ({ fault: e })));
      const held = await both(rpcs, (r) => accountsOf(r, [w.address, ...addresses]));
      const accounts = Object.fromEntries(addresses.map((a, i) => [a, [held[0][i + 1]!, held[1][i + 1]!] as const]));
      const holding = x.mints.flatMap((m) => {
        const ata = solanaAta(w.address, m.mint, m.program);
        const pair = accounts[ata] ?? [null, null];
        const [a, b] = pair.map((t) => (t !== null && t.data.length >= 72 && (t.owner === SOLANA_TOKEN_PROGRAM || t.owner === SOLANA_TOKEN_2022_PROGRAM) ? new DataView(t.data.buffer, t.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n));
        if ((a! > 0n) !== (b! > 0n)) throw new Error(`W's account of ${m.mint} holds tokens on one RPC only`);
        return a! > 0n ? [{ ata, mint: m.mint }] : [];
      });
      // a W that holds is never planned (nothing of it is closed, whatever its other accounts read), unless what it holds
      // is a balance its full sell did not leave (card sol-rent-back-dust-burn: soldOut), which the kit's teardown burns,
      // exactly the balance both RPCs read, before the close
      let sold: "yes" | "no" | "unsure" = "yes";
      for (const t of holding) {
        const s = sells.get(t.mint) ?? "no";
        if (typeof s === "object") throw s.fault;
        if (s === "no") sold = "no";
        else if (s === "unsure" && sold === "yes") sold = "unsure";
      }
      if (sold !== "yes") return { k: "holds" as const, steady: sold === "no" };
      const burn = holding.map((t) => t.ata);
      try {
        return { k: "plan" as const, held, accounts, burn, plan: solanaTeardownPlan(w.address, accounts, unclaimed, burn) };
      } catch (e) {
        // the plan's refusal of reads both RPCs answered alike, byte for byte: the same reads refuse the same way, so it
        // ends the pass (review 5 of 38e59182, M1); reads that differ are a fault, read again
        if (held[0].every((t, i) => sameRead(t, held[1][i] ?? null))) return { k: "refused" as const, why: faultOf(e) };
        throw e;
      }
    };
    // 1. the teardown
    const teardown = await again("teardown", async () => {
      const read = await readW();
      // W still holds what it sold: its sell has not filled, so its volume and wrapped-SOL accounts are what that sell
      // (or its next) still uses; nothing is closed
      if (read.k === "holds") return { holds: read.steady, keep: [], signed: [], last: 0, unclaimed: undefined };
      if (read.k === "refused") return { refused: read.why, keep: [], signed: [], last: 0, unclaimed: undefined };
      const { held, accounts, plan } = read;
      if (plan.close.length === 0) return { keep: plan.keep, signed: [], last: 0, unclaimed: undefined };
      const bh = await blockhashOf(rpcs);
      // one frame at a time on each RPC: a public provider throttles a burst; a claim that does not simulate is planned
      // around once, claims off (the kit's solanaTeardownChecked), so the closes still go and the owed account stays
      const simulate = async (fs: readonly { wire: Uint8Array }[]) => {
        const simulations: [SolanaTeardownSimulation, SolanaTeardownSimulation][] = [];
        for (const f of fs) simulations.push(await both(rpcs, (r) => simulateSolanaTeardown(r, f.wire, w.address, addresses)));
        return simulations;
      };
      const t = await solanaTeardownChecked(w.address, plan, accounts, [held[0][0]?.lamports ?? 0n, held[1][0]?.lamports ?? 0n], { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastHeight }, simulate, read.burn);
      // the copies the kit checked, handed to no one, are the bytes checked again here and signed (card signers-own-bytes)
      checkSolanaTeardownFrames(t.wires, ctx, t.reads);
      return { keep: t.plan.keep, signed: await signAll(t.wires), last: bh.lastHeight, unclaimed: t.reads.unclaimed };
    });
    if (teardown === null) return end("gave_up", "the teardown");
    if (teardown.ok.holds !== undefined) return end("holds", teardown.ok.holds ? "W holds a token it traded: no full sell of it landed" : "W holds a token it traded: its sell not final yet", teardown.ok.holds);
    if (teardown.ok.refused !== undefined) return end("refused", teardown.ok.refused);
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
    if (owedOf(teardown.ok.keep) === null) return end(teardown.ok.unclaimed === undefined ? "kept" : "owed", teardown.ok.keep.map((k) => `${k.address}: ${k.why}`).join("; "));
    // 2. the sweep
    const unclaimed = teardown.ok.unclaimed;
    const floor = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
    const sweep = await again("sweep", async () => {
      // W and its accounts read again, after the frames (review M-A: a frame that failed on chain, a token sent to W's
      // account meanwhile, leaves an account open): the sweep only when the plan now closes nothing and keeps nothing,
      // so W keeps the fee for what is still open; a claim the teardown planned around stays planned around (card
      // sol-w-sweep: it is the next pass's to try again, from the claim's cost the sweep leaves on W)
      const now = await readW(unclaimed);
      if (now.k === "holds") return { end: "kept" as const, steady: now.steady, detail: "W holds a token it traded" };
      if (now.k === "refused") return { end: "refused" as const, detail: now.why };
      const owed = owedOf(now.plan.keep);
      if (owed === null) return { end: "kept" as const, detail: now.plan.keep.map((k) => `${k.address}: ${k.why}`).join("; ") };
      if (now.plan.close.length > 0) return { end: "gave_up" as const, detail: `still open after the teardown: ${now.plan.close.map((c) => c.address).join(", ")}` };
      const [a, b] = now.held.map((v) => v[0]?.lamports ?? 0n);
      if (a !== b) throw new Error("W's lamports differ on the two RPCs");
      const lamports = a!;
      // W at 0 with a claim still owed is owed, never dropped (review 5 of 38e59182, info)
      if (lamports === 0n) return { end: owed > 0 ? ("owed" as const) : ("nothing" as const), detail: owed > 0 ? `W holds nothing, owed ${owed} cashback claim${owed > 1 ? "s" : ""}` : "W holds nothing" };
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
      const value = lamports - SOLANA_POOL_SELL_FEE - solanaDepositRents(rent, sizes, held) - solanaSweepKeep(rent, owed);
      // under the floor: steady (its `seen` kept) only when W stays under it at the cheapest deposit, both pages already
      // open, so a page another deposit opens meanwhile runs the pass again (review 5 of 38e59182, L3)
      const cheapest = lamports - SOLANA_POOL_SELL_FEE - solanaDepositRents(rent, sizes, { ...held, state: [OPEN, OPEN], label: [OPEN, OPEN] }) - solanaSweepKeep(rent, owed);
      if (value < floor) return { end: owed > 0 ? ("owed" as const) : ("floor" as const), steady: cheapest < floor, detail: `W's ${lamports} would make a note of ${value}, under ${floor}: kept on W${owed > 0 ? `, owed ${owed} cashback claim${owed > 1 ? "s" : ""}` : ""}` };
      const bh = await blockhashOf(rpcs);
      const { message } = solanaCompileV0(w.address, [depositIx(x.program, x.pool, w.address, sizes, pre, value)], bh.blockhash, []);
      const wire = wireOf(message);
      // the one signature's fee, as both RPCs price this very message: anything else would leave W short or holding some
      const fees = await both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
      if (fees[0] !== SOLANA_POOL_SELL_FEE || fees[1] !== SOLANA_POOL_SELL_FEE) throw new Error(`the sweep's fee reads ${fees[0]} and ${fees[1]}`);
      checkSolanaSweep(wire, { ...ctx, precommitment }, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize }, lamports, rent, held, owed);
      const sims = await both(rpcs, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } } | null)?.value);
      // a simulation that fails on either RPC (one a slot behind, a page another deposit just filled): read again
      if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) throw new Error(`the sweep simulates ${JSON.stringify(sims.map((v) => v?.err ?? null))}`);
      const [one] = await signAll([wire]);
      return { end: "sent" as const, ref, precommitment, planned, value, one: one!, last: bh.lastHeight };
    });
    if (sweep === null) return end("gave_up", "the sweep");
    const sw = sweep.ok;
    if (sw.end !== "sent") return "steady" in sw && sw.steady !== undefined ? end(sw.end, sw.detail, (sw.end === "floor" || sw.end === "kept") && sw.steady) : end(sw.end, sw.detail);
    const id = sw.planned ?? (await x.store.add({ ref: sw.ref, scope: x.scope, precommitment: sw.precommitment, state: "PLANNED" })).id;
    await x.store.move(id, "PLANNED", "INCOMING", { send: { signature: sw.one.signature, value: sw.value, last_valid_block_height: BigInt(sw.last) } });
    await send(sw.one.signed, sw.one.signature);
    return end("sent", sw.one.signature);
  } catch (e) {
    // the sell has landed; what is not closed or swept stays on W, owed, and its note, if sent, settles at the next read
    return end("gave_up", e === BUSY ? "a sell took the sell lock between tries: W waits for the next load" : faultOf(e));
  } finally {
    for (const s of seeds) s.fill(0);
  }
}

/** What `owner` holds of `mint` after one transaction, from its meta's post token balances (its accounts of that mint,
 *  summed): null when the meta does not say it plainly (no list, an entry malformed, none of `owner`'s of `mint`). */
export function leftAfter(meta: Record<string, unknown> | undefined, owner: string, mint: string): bigint | null {
  const list = meta?.postTokenBalances;
  if (!Array.isArray(list)) return null;
  let total: bigint | null = null;
  for (const e of list as unknown[]) {
    const b = e as { mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown } } | null;
    if (typeof b !== "object" || b === null) return null;
    if (b.mint !== mint || b.owner !== owner) continue;
    const amount = b.uiTokenAmount?.amount;
    if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(amount)) return null;
    total = (total ?? 0n) + BigInt(amount);
  }
  return total;
}

/**
 * How many of W's kept accounts are volume accounts owed only cashback a claim could not take this time (the kit's
 * plan marks them `cashback`), when every kept account is one: the sweep then leaves what their later claims need
 * (solanaSweepKeep). null when any kept account is something else (tokens, incentives, volume, a frozen or confidential
 * account, the USDC account that takes stable cashback) or more are kept than the rule bounds: W keeps everything.
 */
export function owedOf(keep: readonly { cashback?: true }[]): number | null {
  if (keep.length > SOLANA_SWEEP_OWED_MAX || keep.some((k) => k.cashback !== true)) return null;
  return keep.length;
}

/** What W reads as for its rent back: W and its accounts of the record's mints, the same bytes on both RPCs (one
 *  getMultipleAccounts call on each), the rent both RPCs read this load and
 *  the rules' version (POOL_RENT_BACK_RULES; review 5 of 38e59182, L3); undefined when the two RPCs differ. Nothing is
 *  decided on it but whether a pass runs. */
async function heldSeen(x: RentBack): Promise<string | undefined> {
  const addresses = [x.w.address, ...solanaTeardownAddresses(x.w.address, x.mints)];
  const [a, b] = (await both(x.rpcs, (r) => accountsOf(r, addresses))).map((reads) => reads.map((t) => (t === null ? "-" : `${t.owner}:${t.lamports}:${base64.encode(t.data)}`)).join("|"));
  if (a !== b) return undefined;
  return base64.encode(keccak_256(new TextEncoder().encode(`${a}#${x.rent.lamportsPerByte}:${x.rent.factor}#${POOL_RENT_BACK_RULES}`)));
}

/** A rent back, then its owed record: none when W reads as it did when its last pass ended on W's own state (review 3
 *  of c1fd2d20, 2b: a steady W costs one read a load, not a pass). */
async function rentBackOwed(h: PoolSellHost, given: RentBack, o: OwedRentBack, hold?: Hold): Promise<void> {
  // W's buy mint joins the mints the pass reads (delta review 7 of 08290868): W holding any of it holds the pass, its
  // account closed with the rest once empty; a record that cannot be read is no record (the safe side)
  const buy = await Promise.resolve(h.bought?.get(given.w.address)).catch(() => undefined);
  const x: RentBack = buy ? { ...given, mints: mintsOf(given.mints, [buy]), buy } : { ...given, buy: null };
  const seen = await heldSeen(x).catch(() => undefined);
  if (seen !== undefined && seen === o.seen) return;
  const r = await rentBack(h, x, hold);
  await owedAfter(h, o, r.end, r.steady ? seen : undefined);
}

/** The owed record after a pass that ended `e` (review of c1fd2d20, 2a: no lamport on W goes untracked): dropped only
 *  once both RPCs read W empty ("nothing"); every other end keeps it with one pass more (a pass bound dropped Ws whose
 *  passes faulted, both RPCs down, and one reader's word that W holds a token dropped it too), with what W read as when
 *  the pass ended on W's own state (under the floor, holding, an account kept), so the next load that reads W the same
 *  skips it. */
async function owedAfter(h: PoolSellHost, o: OwedRentBack, e: RentBackEnd, seen?: string): Promise<void> {
  try {
    if (e === "nothing") return await h.owed?.drop(o.address);
    // the record as it is now (a sell meanwhile may have written W's again, with another mint), its mints kept
    const now = (await h.owed?.list())?.find((r) => r.address === o.address) ?? o;
    const { seen: _last, ...rest } = now;
    await h.owed?.put({ ...rest, mints: mintsOf(now.mints, o.mints), passes: now.passes + 1, ...(seen !== undefined && (e === "floor" || e === "holds" || e === "kept" || e === "refused") ? { seen } : {}) });
  } catch {
    // an owed record that cannot be written: the rent back runs again only while one is stored
  }
}

/**
 * The rent backs owed (a page closed, a provider down past the bound, a sweep not yet confirmed), run again: once per
 * page load (pool-testnet.ts), after the sells settle, under the seed's shared lock (the caller's), one W at a time,
 * least recently tried first: each W under its own lock (backLock, skipped when another pass holds it) and the sell
 * lock between the pass's sleeps (withHolds); the list stops at the first W the sell lock is taken for (a sell runs) and
 * the rest wait for the next load. A W whose holdings were not read this load waits for the next.
 */
export async function resumeRentBacks(h: PoolSellHost, locks: Locks | null = globalThis.navigator?.locks ?? null): Promise<void> {
  if (!locks || !h.owed) return;
  const owed = await h.owed.list();
  if (owed.length === 0) return;
  const program = h.pin.program;
  const { pool, scope } = solanaPoolOf(program);
  const rpcs = h.rpcs;
  const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  let setup: { store: NoteStore; sync: SolanaTreeSync; rent: SolanaRent; wallets: readonly BuyWallet[] };
  try {
    setup = { store: await h.notes(), sync: solanaTreeSync(rpcs, program), rent: await readSolanaRent(rpcs), wallets: await h.wallets() };
  } catch (e) {
    // this load's own reads failed (a provider down): told, each record kept for the next load, written under the sell
    // lock from the record as it is then (review 5 of 38e59182, info)
    for (const { address } of owed) {
      const go = await withHolds(locks, address, true, wait, async () => {
        const o = (await h.owed!.list()).find((r) => r.address === address);
        if (!o) return;
        h.told?.({ address, step: "rent_back", state: "gave_up", detail: `this load's reads: ${faultOf(e)}` });
        await owedAfter(h, o, "gave_up");
      });
      if (!go) return;
    }
    return;
  }
  const { store, sync, rent, wallets } = setup;
  // the sell lock for one W at a time, never around the list (review of c1fd2d20, 2c): a sell tapped meanwhile waits
  // for the one W in flight, and the rest of the list waits for the next load
  for (const { address } of owed) {
    const go = await withHolds(locks, address, true, wait, async (hold) => {
      // the record as it is now: a sell meanwhile may have written W's again or dropped it
      const o = (await h.owed!.list()).find((r) => r.address === address);
      const w = o && wallets.find((x) => x.chain === "sol" && x.address === o.address && x.l.toString() === o.l && x.j === o.j);
      if (o && w) await rentBackOwed(h, { rpcs, program, pool, scope, rent, store, sync, w, mints: o.mints, wait, ...(o.sell ? { sell: o.sell } : {}) }, o, hold);
    });
    if (!go) return;
  }
}

/** How a pass ended, and whether on W's own state (its `seen` then kept). */
type Ended = { end: RentBackEnd; steady: boolean };
/** A pass that met a sell holding the sell lock between its tries. */
const BUSY = new Error("a sell took the sell lock");
/** Any page that is open: a deposit then opens none (the cheapest deposit, for the floor end's steadiness). */
const OPEN = 1n << 62n;
/** The sell lock as a rent back holds it: let go for each sleep, taken again only if it is free (false: a sell has it). */
type Hold = { nap(ms: number): Promise<boolean>; release(): void };
/** `name` taken (waiting for it, or only if it is free), with the function that lets it go; null when it is not free. */
function take(locks: Locks, name: string, ifAvailable: boolean): Promise<(() => void) | null> {
  return new Promise((res, rej) => {
    locks
      .request(name, ifAvailable ? { mode: "exclusive", ifAvailable: true } : { mode: "exclusive" }, (lock: Lock | null) => {
        if (!lock) return void res(null);
        return new Promise<void>((done) => res(done));
      })
      .catch(rej);
  });
}
/**
 * `f` for W at `address` under W's own lock (backLock) and the sell lock (`hold`, let go for each of the pass's sleeps):
 * both waited for (a sell's own rent back, right after its fill) or taken only if free (a load's). False when the sell
 * lock was not free (a sell runs); true otherwise, W's own lock not free included (another pass on W runs: skipped).
 * With no lock manager (a host that gives none), `f` runs with no hold.
 */
async function withHolds(locks: Locks | null, address: string, ifAvailable: boolean, wait: (ms: number) => Promise<void>, f: (hold?: Hold) => Promise<void>): Promise<boolean> {
  if (!locks) return await f(), true;
  const own = await take(locks, backLock(address), ifAvailable);
  if (!own) return true;
  try {
    let sell = await take(locks, POOL_SELL_LOCK, ifAvailable);
    if (!sell) return false;
    const hold: Hold = {
      release: () => {
        sell?.();
        sell = null;
      },
      nap: async (ms) => {
        hold.release();
        await wait(ms);
        sell = await take(locks, POOL_SELL_LOCK, true);
        return sell !== null;
      },
    };
    try {
      await f(hold);
    } finally {
      hold.release();
    }
    return true;
  } finally {
    own();
  }
}

/** Two mint lists, as one: each mint once, the first list's order first. */
function mintsOf(a: readonly { mint: string; program: string }[] | undefined, b: readonly { mint: string; program: string }[]): { mint: string; program: string }[] {
  const out = [...(a ?? [])];
  for (const m of b) if (!out.some((x) => x.mint === m.mint)) out.push(m);
  return out;
}

/** Two providers' reads of one account, alike: both none, or the same owner, lamports and bytes. */
function sameRead(a: SolanaHeldRead | null, b: SolanaHeldRead | null): boolean {
  if (a === null || b === null) return a === b;
  return a.owner === b.owner && a.lamports === b.lamports && a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);
}

type Locks = Pick<LockManager, "request">;

/** A "sent" answer: the one a later attempt or the run's end replaces. */
const sentAnswer = (a: HostAnswer<"pool.sell"> | HostRefusal): boolean => "result" in a && a.result.stage === "sent";

/** A pool sell's ops record (src/state.ts's op contract: nothing secret), keyed by its request's id: kind "sell", as
 *  the app reads a trade's; `pool` marks it as this kind's, so the settle on load finds it by its transaction. */
/** A pool sell's ops record: its chain, token and the token amount it asks, whole units at the token's decimals, kept
 *  from the request so state.ops names them (kit messages.ts OpDetail, card kit-portfolio-reads). */
type SellOp = { kind: "sell"; pool: "sol"; sha: string; stage: "pending" | TradeStage; txs: TxRef[]; code?: ErrorCode; created_ms: number; chain?: "solana"; token?: string; units?: string; legs?: SellOpLeg[] };
/** One wallet's sale as the record keeps it (card pool-sell-share-across-wallets; never sent to the app: state.ts reads
 *  only the op contract's keys): W, the units it sells in whole units, its signature once signed, and its stage
 *  ("pending" until it runs; refused with the code of a refusal before it signed). */
type SellOpLeg = { wallet: string; units: string; tx: string | null; stage: "pending" | TradeStage; code?: ErrorCode };
/** The record's stage over its legs (stageOfLegs): a leg still "pending" is one that never ran when `dead`. */
const recordStage = (legs: readonly SellOpLeg[], dead: boolean): TradeStage =>
  stageOfLegs(legs.map((l) => (l.stage === "pending" ? (dead ? { stage: null, error: "failed" as const } : { stage: null }) : { stage: l.stage, ...(l.code === undefined ? {} : { error: "failed" as const }) })));

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
 *  or "sent"); a record already at an end stays. A record of several wallets' sales (card pool-sell-share-across-wallets)
 *  writes the stage to the leg that names the transaction, and the record's stage over its legs: filled once each leg
 *  filled, part_filled when some did. Settled at a load (no sell runs then: settlePoolSells holds the sell lock), a leg
 *  still "pending" never ran: its page closed first, so nothing was sent for it. `live`: the run's own settle, its legs
 *  still to run. */
export async function settleSellOps(ops: TradeStore, signature: string, stage: TradeStage, live = false): Promise<void> {
  for (const k of await ops.keys("ops")) {
    const rec = (await ops.get("ops", k)) as Partial<SellOp> | undefined;
    if (rec?.kind !== "sell" || rec.pool !== "sol" || (rec.stage !== "signed" && rec.stage !== "sent")) continue;
    if (Array.isArray(rec.legs) && rec.legs.length > 0) {
      if (!rec.legs.some((l) => l.tx === signature && (l.stage === "signed" || l.stage === "sent"))) continue;
      await ops.update("ops", k, (v) => {
        const r = v as SellOp;
        if (r.stage !== "signed" && r.stage !== "sent") return undefined;
        const legs = r.legs!.map((l) => (l.tx === signature && (l.stage === "signed" || l.stage === "sent") ? { ...l, stage } : !live && l.stage === "pending" ? { ...l, stage: "refused" as const, code: "failed" as const } : l));
        return { ...r, legs, stage: recordStage(legs, !live) };
      });
      continue;
    }
    if (rec.txs?.[0]?.hash !== signature) continue;
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
    // after a full sale filled, its W's rent back: run once the sell's stage is told and its request's lock is free (an id
    // seen again is answered from its record, never id_reused), under the seed's shared lock and the sell lock again;
    // one per leg (card pool-sell-share-across-wallets)
    const laters: Later[] = [];
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
            // a sell by share names its units once the plan has read them (planned, below)
            const op: SellOp = { kind: "sell", pool: "sol", sha: ctx.sha, stage: "pending", txs: [], created_ms: Number(h.now?.() ?? BigInt(Date.now())), ...(ask.token === null ? {} : { chain: "solana" as const, token: ask.token, ...(ask.shareBps === undefined ? { units: poolUnits(ask.amount, ask.decimals) } : {}) }) };
            await ops.put("ops", ctx.id, { ...op });
            let writes: Promise<void> = Promise.resolve();
            const snap = () => ({ ...op, txs: op.txs.map((t) => ({ ...t })), ...(op.legs ? { legs: op.legs.map((l) => ({ ...l })) } : {}) });
            const write = (patch: Partial<SellOp>): void => {
              Object.assign(op, patch);
              const v = snap();
              writes = writes.then(() => ops.put("ops", ctx.id, v)).catch(() => {});
            };
            // every leg's signature so far, in leg order (card pool-sell-share-across-wallets)
            const legTxs = (): TxRef[] => (op.legs ?? []).flatMap((l) => (l.tx === null ? [] : [{ chain: "solana" as const, hash: l.tx }]));
            const setLeg = (i: number, patch: Partial<SellOpLeg>): void => {
              op.legs = (op.legs ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l));
            };
            await locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, async () => {
              const a = await sellAll({
                ...h,
                // in order after the record's writes, and not swallowed: the sell's record is let go only once it lands
                settled: (signature, stage) => {
                  const w = writes.then(() => settleSellOps(ops, signature, stage, true));
                  writes = w.catch(() => {});
                  return w;
                },
              }, ask, laters, {
                // the units the plan read and each leg, before any leg runs
                planned: (plan) => write({ units: poolUnits(plan.units, ask.decimals), legs: plan.legs.map((l) => ({ wallet: l.w.address, units: poolUnits(l.units, ask.decimals), tx: null, stage: "pending" })) }),
                // awaited before the send, and not swallowed: a record that cannot name the signature sends nothing
                signed: async (i, signature) => {
                  await writes;
                  setLeg(i, { tx: signature, stage: "signed" });
                  Object.assign(op, { stage: op.stage === "pending" ? "signed" : op.stage, txs: legTxs() });
                  await ops.put("ops", ctx.id, snap());
                },
                // each attempt's send names its own signature: a sale built again (L2) answers with the one it sent last,
                // never the attempt that failed (review L-B)
                sent: (i, signature) => {
                  setLeg(i, { tx: signature, stage: "sent" });
                  write({ stage: "sent", txs: legTxs() });
                  if (!answer || sentAnswer(answer)) answer = { result: { stage: "sent", txs: legTxs() } };
                  give();
                },
                ended: (i, leg) => setLeg(i, leg.error !== undefined ? { tx: null, stage: "refused", code: leg.error } : { tx: leg.tx, stage: leg.stage ?? "refused" }),
              });
              if ("error" in a) write({ stage: "refused", code: a.error });
              else write({ stage: a.stage, txs: a.txs });
              await writes;
              const result = "error" in a ? null : { stage: a.stage, txs: a.txs };
              if (!answer) answer = result === null ? { error: (a as { error: PoolSellError }).error } : { result };
              else {
                // the message api.ts posted at the first send names that attempt (the kit never sends the id again:
                // after its timeout it asks for state, client.ts REASK_STATE); answer() from here on, like the record
                // state.ops reads, names the end and every signature sent
                if (result !== null && sentAnswer(answer)) answer = { result };
                if (result !== null) ctx.progress(result.stage);
              }
            });
          });
          // each full sale's rent back, one W after another: each takes W's own lock and the sell lock itself, the sell
          // lock only between its sleeps (two at once would each find the other holding it and give up)
          for (const later of laters) await later.back?.(locks);
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
