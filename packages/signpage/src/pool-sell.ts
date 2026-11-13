// pool.sell on the Solana pool (card signpage-pool-sell): one tap sells a token a buy's fresh wallet W holds on its venue,
// and the same transaction, signed by W alone, puts what the sale gives back into the pinned pool as a note of the
// user's own; the note is written INCOMING before the send and lands UNSPENT once both RPCs show its deposit.
//
// - W: one of the page's buy wallets (../../wallet/src/pool/buy-wallets.ts ListedBuyWallet: its l, j, address and holdings),
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
//   less what W holds. On devnet no compute budget instruction: no priority fee; on mainnet a limit and a price
//   (solanaSellBudget: SOLANA_POOL_SELL_PRIORITY in all, or what W holds beyond the sell's need under it, none at 0;
//   only on a form with room for it under 1,232 bytes, solanaSellBudgetFits; the limit sized from the simulation; the
//   rule refuses a priority over SOLANA_POOL_SELL_PRIORITY), in
//   the fee both RPCs price, so the reserve, the funds check and the rule count it; a partial sell keeps it on W too. A reserve over SOLANA_POOL_SELL_RESERVE_MAX or
//   at least min out is refused.
// - Built here (the kit's solanaPoolSellSteps; on a partial sell then, last, the tag 1 deposit of the note min out less
//   the reserve makes on the pool's grid, with the return note's precommitment; a full sell carries no deposit, card
//   every-lamport-can-move), checked by the rule (rules/pool.ts checkSolanaSell, against the page's pin read at the check),
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
//   return note, the sale's one note: on the pool's grid, the rest under it one System transfer to the pinned relayer's
//   account in the same transaction (review P3-1; P1-1 of 1d3b96d9c: never the pool's), W at 0 (card every-lamport-can-move). It runs after the sell's stage is told, and never changes it. A partial sell
//   runs neither: after it fills, W's keep sweep (keepSweep, card partial-sell-pays-all-into-cash) deposits all W holds
//   above the next sell's need as W's next return note, so what the venue paid above min out is in Cash too.
// - Every RPC answer is hostile and parsed strictly. Every read names a public account or the transaction itself, one
//   wallet of the user's at most; no request carries a key or the words. Nothing here logs.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { simulateSolanaTeardown, solanaCompileV0, solanaTeardownChecked } from "../../kit/src/trade/solana/build.ts";
import { readSolanaPoolBuyVenue, readSolanaRent, SOLANA_RENT_SYSVAR, SolanaPoolBuyError, SOLANA_POOL_PAGE_ENTRIES, SOLANA_POOL_QUOTE_MAX_AGE_SLOTS, SOLANA_POOL_SELL_FEE, solanaPoolFee, solanaPoolNextPage, solanaPoolPage, solanaPoolSellMinOut, solanaPoolBuySellNeed, solanaPoolSellNeed, solanaPoolSellSteps, solanaRentMin, type SolanaPoolBuyVenue, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SOLANA_POOL_NEXT_PAGE_WINDOW, solanaPoolPreMarkOf, type SolanaPoolPreMark } from "../../kit/src/trade/solana/pool-deposit.ts";
import { solanaDecodeTokenAccount, type SolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { pageReference } from "./page-rpc.ts";
import { SOLANA_MAX_TX_BYTES, solanaAta, solanaDecodeMessage, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_CU_PRICE_MAX, SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, SOLANA_SOL_MINT, SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaTeardownAddresses, solanaTeardownPlan, solanaVolumeAccumulator, solanaVolumeClaimable, type SolanaHeldRead, type SolanaTeardownSimulation, type SolanaTeardownUnclaimed } from "../../kit/src/checks/solana/checks.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { ErrorCode, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { HELPER_SOLANA_BLOCK_HEADER } from "../../kit/src/helper/v1.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { PassFail } from "../../wallet/src/pool/pool.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import { solanaBuyReader, type ListedBuyWallet, type SolanaBuy } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf, solanaTreeSync, type SolanaPoolPin, type SolanaTreeSync } from "../../wallet/src/pool/solana.ts";
import { SOL_GRID } from "../../wallet/src/pool/pieces.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { blockhashOf, blockhashRead, blockhashValid, pastOnBoth, readBack, readBackFailure, readBackMeta, type BuyMints } from "./pool-buy.ts";
import { afterOf, clockOf, keptReads, READ_WAIT, readWaits, forgetYoung, solanaSaleReads, solanaStableReads, tapDone, tapWaits, waitsOn, waitUnless, youngReads, type ReadWaits } from "./read-waits.ts";
import { throttleWaitMs } from "../../wallet/src/throttle.ts";
import { duringTrade, fromRecord, timedStore, TRADE_STORE_MS, tradeLock, tradeRunning, within, type TradeStore } from "./trade.ts";
import { deviceSpacing, POOL_RENT_BACK_SPACE_MAX_MS, POOL_RENT_BACK_SPACE_MIN_MS, spaceOpen, type DeviceSpacing, type RentBackSpacing } from "./device-spacing.ts";
import { checkSolanaKeepSweep, checkSolanaSell, checkSolanaSweep, SOLANA_POOL_SELL_PRIORITY, checkSolanaTeardownFrames, PoolRuleRefused, poolUnits, signSolana, SOLANA_POOL_CU_LIMIT_MAX, SOLANA_POOL_MIN_DEPOSIT, SOLANA_POOL_SELL_RESERVE_MAX, SOLANA_SWEEP_OWED_MAX, solanaDepositRents, solanaNoteOf, solanaSellNoteFloor, solanaSweepFloor, solanaSweepKeep, solanaSweepOf, type PoolAsk, type SolanaDepositHeld } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** What a sell run needs from the page. */
/** A sale's ride's end (pool-withdraw.ts runPoolRide): no piece; landed (W got `got`); stopped (nothing reached W); unsure
 *  (a release that may still land). */
export type PoolRide = { state: "none" } | { state: "landed"; signature: string; got: bigint } | { state: "stopped" } | { state: "unsure"; signature: string };

export type PoolSellHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** A sale's ride (card every-lamport-can-move T3): one spare piece of the pool's own notes released to the sale's W
   *  (pool-withdraw.ts runPoolRide), asked only by a full sale's own rent back whose rest is under the floor; `fits(got)`
   *  whether what W gets lifts its rest to a note. Absent: no ride, W keeps its lamports as before. */
  ride?(to: { address: string; l: bigint; j: number }, fits: (got: bigint) => boolean): Promise<PoolRide>;
  /** The pool's cluster (pool-testnet.ts PAGE_CLUSTER): on mainnet W's sell pays a priority fee (solanaSellBudget). */
  cluster?: "mainnet" | "devnet";
  /** W's buy mint, as the buy wrote it (pool-buy.ts BuyMints): read by the rent back. */
  bought?: BuyMints;
  /** Whether the restore's rebuild read W's history and found no buy (sol-buy-records.ts BUY_NONE_KEY): the rent back
   *  proves it on the public seat before it holds W as its own state (card round-trip-costs-less). */
  buyNone?(address: string): Promise<boolean>;
  /** Holds the positions' passes off while a load's rent backs read their Ws (one finder queue); the hold's end. */
  preempt?(): () => void;
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** Two RPCs of different operators that both answer getTokenAccountsByOwner, for a found W's token accounts
   *  (foundTokenAccounts, ownsNoTokens; pool-testnet.ts pageSolanaTokenRpcs): `rpcs` when absent. */
  tokenRpcs?: readonly [SolanaRpc, SolanaRpc];
  /** The note store, opened top-level. */
  notes(): Promise<NoteStore>;
  /** The 64-byte seed; each copy is zeroed here. */
  seed64(): Promise<Uint8Array>;
  /** The page's buy wallets, each with its holdings as the finder read it when `read` asks for it (with no `read`, the
   *  Ws neither a buy record nor the last whole positions pass names), else as that pass listed it, else holdings null:
   *  not read (shown, never signed on: the run reads again on both RPCs). */
  wallets(read?: (address: string) => boolean | Promise<boolean>): Promise<readonly ListedBuyWallet[]>;
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
  /** How long a store call may take (TRADE_STORE_MS); a test's shorter one. The device's spacing is raced against it: an
   *  IndexedDB open that never answers holds no rent back and no trade lock past it. */
  storeMs?: number;
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
  /** A sign out was asked (pool-testnet.ts signingOut): no sale signs from then on (review P3-5 of 77055f4e); each is
   *  refused "failed" right before its signature, so a sale already sent stands and none after it starts. */
  stopped?(): boolean;
  /** The session's sign out: it ends a wait before a sale's next attempt (read-waits.ts waitUnless). */
  signal?: AbortSignal;
};

/** One wallet's sale in a sell (card pool-sell-share-across-wallets): W's address, the token's base units it sells (a
 *  decimal string, as an answer carries it), its transaction's signature once W signed (null: it ended before signing),
 *  and how it ended: its stage, or the refusal before it signed. */
export type PoolSellLeg = { wallet: string; amount: string; tx: string | null; stage: TradeStage | null; error?: PoolSellError; cause?: string; rule?: string };
type PoolSellError = "not_allowed" | "not_funded" | "quote_check_failed" | "venue_not_built" | "failed" | "down";
/** A sell's answer: its stage over every wallet's sale (filled when each filled, part_filled when some did), each sale's
 *  transaction in `txs`, and every sale in `legs`; or a refusal, nothing signed. */
/** A refusal's `rule` (refusal-rule.ts): the fixed word naming the rule or kit code that refused it, the page's own,
 *  never posted to the app. */
export type PoolSellAnswer = { stage: TradeStage; txs: TxRef[]; legs?: readonly PoolSellLeg[] } | { error: PoolSellError; rule?: string };

/** Verdict reads a sell gets, a second apart: past a blockhash's life (~60 to 90 s) and a finalization. */
export const POOL_SELL_READS = 120;
export const POOL_SELL_WAIT_MS = 1_000;
/** How long a sale's market and blockhash reads (solanaSaleReads) serve its later legs (card pool-sell-legs-side-by-side:
 *  each leg asking them again drew the helper's 429). [design: 4 s, 10 slots at 400 ms: a leg's reference stays under
 *  SOLANA_POOL_QUOTE_MAX_AGE_SLOTS (25) from its read to the leg's send; past it the leg reads its own.] A shared read
 *  made before an earlier leg's sell landed prices the coin higher than it now is, so the leg's floor can only be
 *  stricter: its simulation on both RPCs refuses it, or the chain does, never a sale below the user's slippage. */
export const POOL_SELL_SHARED_READ_MS = 4_000;
/** Two providers a slot apart read the pool account at two states, or the trees grew again since the last read: read
 *  again this long after. */
export const POOL_SELL_SIZE_RETRY_MS = 500;
/** How long a sale's reads wait, POOL_SELL_SIZE_RETRY_MS apart, for its two providers to agree: the pool's trees
 *  holding still (card pool-sell-legs-side-by-side, the finder pass of 11 Nov 09:39Z: the fifth leg of five was refused
 *  when the trees moved under its reads, by the earlier legs' own deposits; on mainnet anyone's deposit moves them), and
 *  what a sale reads right after a buy, which one provider may not show yet: W's token account (wHeld), W's PumpSwap
 *  cashback accounts, the pool's sizes (treeSizes; a buy's change note grows the state tree). [design: 10 s, the quote's age bound
 *  SOLANA_POOL_QUOTE_MAX_AGE_SLOTS (25) at 400 ms a slot: two providers that do not agree that long refuse the sale,
 *  which is never priced on one provider's word.] */
export const POOL_SELL_AGREE_WAIT_MS = SOLANA_POOL_QUOTE_MAX_AGE_SLOTS * 400;
/** One sell at a time on this device, every tab: two runs never pick one return note. */
export const POOL_SELL_LOCK = "ct-pool/sell";
/** The rent back's tries at each step: a provider's throttle, stall or lag is read again from the top (the devnet run at
 *  0068524a lost its whole rent back to one provider's HTTP 429s), after a wait on the page's one rule (read-waits.ts
 *  READ_WAIT: from 1 s, doubling, at most 10 s, a Retry-After honoured to 10 s; card start-reads-wait-out-a-throttle),
 *  within POOL_RENT_BACK_MS. */
export const POOL_RENT_BACK_TRIES = 30;
/** The rent back's one wall-clock bound, every step and read-back in it (review M2): the sell's own verdict budget. */
export const POOL_RENT_BACK_MS = POOL_SELL_READS * POOL_SELL_WAIT_MS;
/** The rent back's rules, as what W read as (findOn) hashes them: a release bumps it whenever the floor, the least
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
/** Which check of a sale refused it "failed", named in the leg's cause (legCause) and nowhere a user reads. */
type Check = "venue_program" | "volume_split" | "fee_split" | "fee_moved" | "sim" | "stopped" | "wallet" | "pool_owner" | "sizes_moved" | "sizes_split" | "held_split" | "mint_program" | "tap_bound";
class Refused extends Error {
  readonly code: Code;
  readonly check: Check | undefined;
  /** What the check saw, public data only (a provider's simulation error and its program's error line), made safe by
   *  safeDetail; kept in the leg's cause on the device, never sent. */
  readonly detail: string | undefined;
  constructor(code: Code, check?: Check, detail?: string) {
    super(code);
    this.code = code;
    this.check = check;
    this.detail = detail;
  }
}
const no = (code: Code = "failed", check?: Check, detail?: string): never => {
  throw new Refused(code, check, detail);
};
/** A provider's text as a cause may hold it: at most 160 characters of letters, digits and JSON's punctuation. */
const safeDetail = (x: unknown): string => {
  let t: string;
  try {
    t = typeof x === "string" ? JSON.stringify(x) : (JSON.stringify(x) ?? "none");
  } catch {
    t = "unreadable";
  }
  return t.replace(/[^\w{}[\]":,. -]/g, "").slice(0, 160);
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

/** Up to 10 accounts in one getMultipleAccounts call (one provider's cap), all at one slot; null: no account.
 *  `lamports` as the RPC wrote it (accountsOf prices it). */
async function accountsRaw(rpc: SolanaRpc, addresses: readonly string[]): Promise<({ owner: string; lamports: unknown; data: Uint8Array } | null)[]> {
  const r = (await rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown };
  if (!Array.isArray(r?.value) || r.value.length !== addresses.length) return no();
  return r.value.map((a: { owner?: unknown; data?: unknown; lamports?: unknown } | null) => {
    if (a === null) return null;
    if (typeof a?.owner !== "string" || !Array.isArray(a.data) || a.data[1] !== "base64" || typeof a.data[0] !== "string") return no();
    return { owner: a.owner, lamports: a.lamports, data: base64.decode(a.data[0]) };
  });
}

/** accountsRaw, each account's lamports priced. */
async function accountsOf(rpc: SolanaRpc, addresses: readonly string[]): Promise<(SolanaHeldRead | null)[]> {
  return (await accountsRaw(rpc, addresses)).map((a) => (a === null ? null : { ...a, lamports: BigInt(int(a.lamports)) }));
}

/** A read the two providers answer apart: read again after a wait (agreed). */
const SPLIT = Symbol("split");
/** `read` again POOL_SELL_SIZE_RETRY_MS on while it answers SPLIT, up to POOL_SELL_AGREE_WAIT_MS of waits in all, then
 *  refused failed with `check`: what both providers answer alike, never one provider's word alone. */
async function agreed<T>(read: () => Promise<T | typeof SPLIT>, wait: (ms: number) => Promise<void>, check: Check): Promise<T> {
  for (let waited = 0; ; ) {
    const r = await read();
    if (r !== SPLIT) return r;
    if (waited >= POOL_SELL_AGREE_WAIT_MS) return no("failed", check);
    waited += POOL_SELL_SIZE_RETRY_MS;
    await wait(POOL_SELL_SIZE_RETRY_MS);
  }
}

/** The pool account on both RPCs, the same bytes (two that differ read again until they agree, agreed): its two tree sizes. */
async function treeSizes(rpcs: Rpcs, program: string, pool: string, wait: (ms: number) => Promise<void>): Promise<{ stateSize: number; labelSize: number }> {
  return agreed(
    async () => {
      const [a, b] = await both(rpcs, (r) => account(r, pool, "confirmed"));
      if ("none" in a || "none" in b) return no("not_allowed");
      if (a.owner !== program || b.owner !== program) return no("failed", "pool_owner");
      // two providers a slot apart (a buy's change note, anyone's deposit): read again after a wait
      return sameBytes(a.data, b.data) ? sizesOf(a.data) : SPLIT;
    },
    wait,
    "sizes_split",
  );
}

/** The pool account's two tree sizes. */
export function sizesOf(d: Uint8Array): { stateSize: number; labelSize: number } {
  if (d.length !== POOL_LEN || !sameBytes(d.subarray(0, 8), POOL_DISC)) return no();
  const size = (at: number): number => int(Number(new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true)));
  return { stateSize: size(OFF_TREES), labelSize: size(OFF_TREES + TREE_LEN) };
}

/** The token's program: the mint's owner, the same on both RPCs, the token program or Token-2022 (a buy never
 *  changes the mint, so two RPCs apart on it are refused at once). */
async function mintProgram(rpcs: Rpcs, mint: string): Promise<string> {
  const mints = await both(rpcs, (r) => account(r, mint, "confirmed"));
  const programs = mints.map((m) => ("none" in m ? no("failed", "mint_program") : m.owner));
  const program = programs[0]!;
  if (programs[1] !== program || (program !== SOLANA_TOKEN_PROGRAM && program !== SOLANA_TOKEN_2022_PROGRAM)) return no("failed", "mint_program");
  return program;
}

/** What W holds, as a sale prices it: the token's program, W's token amount, W's lamports (the lower of the two RPCs'),
 *  and for pump and PumpSwap in that order whether W's volume account there owes a claim on either RPC's read. */
export type WHeld = { program: string; amount: bigint; lamports: bigint; owes: readonly [boolean, boolean] };

/** W's own accounts in one getMultipleAccounts call on each RPC (card pool-sell-legs-side-by-side; every address in it
 *  is W's, so a read still names one W of the user's at most): its associated token account of `mint` under `program`,
 *  W itself, and its volume accounts on pump and PumpSwap.
 *  - The token amount, the same on both RPCs: two that differ (one RPC not showing W's token account yet, right after
 *    its buy) are read again POOL_SELL_SIZE_RETRY_MS on, up to POOL_SELL_AGREE_WAIT_MS of waits (agreed), then failed
 *    held_split: neither RPC's word alone sets what the sell takes or what W keeps after it. None on both holds nothing
 *    (the sale refuses it at once, not_funded). Frozen on both:
 *    not_allowed; frozen on one RPC alone is two RPCs that differ (review P3-3 of 77055f4e: one RPC's word that W is
 *    frozen never leaves W out of a sell of all of it).
 *  - W's lamports: the lower of the two RPCs' (none: 0).
 *  - A volume account owes a claim when either RPC's read of it pays out (solanaVolumeClaimable: one RPC's word that
 *    nothing is owed never lowers what W keeps after the sell, review L3 of 38faee89). */
async function wHeld(rpcs: Rpcs, w: string, mint: string, program: string, wait: (ms: number) => Promise<void>): Promise<WHeld> {
  const ata = solanaAta(w, mint, program);
  const vps = [SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM] as const;
  const keys = [ata, w, ...vps.map((vp) => solanaVolumeAccumulator(w, vp))];
  const tokenOf = (a: { owner: string; data: Uint8Array } | null): bigint | "frozen" => {
    if (a === null) return 0n;
    if (a.owner !== program) return no();
    let t: ReturnType<typeof solanaDecodeTokenAccount>;
    try {
      t = solanaDecodeTokenAccount({ owner: a.owner, data: a.data });
    } catch {
      return no();
    }
    if (t.mint !== mint || t.owner !== w) return no();
    if (t.state === 2) return "frozen";
    return t.amount;
  };
  return agreed(
    async () => {
      const reads = await both(rpcs, (r) => accountsRaw(r, keys));
      const [a, b] = reads.map((x) => tokenOf(x[0]!));
      if (a !== b) return SPLIT;
      if (a === "frozen") return no("not_allowed");
      const lamports = lower(...(reads.map((x) => (x[1] == null ? 0n : BigInt(int(x[1].lamports)))) as [bigint, bigint]));
      const owes = vps.map((vp, k) => reads.some((x) => x[2 + k] != null && x[2 + k]!.owner === vp && solanaVolumeClaimable(vp, x[2 + k]!.data) > 0n)) as [boolean, boolean];
      return { program, amount: a!, lamports, owes };
    },
    wait,
    "held_split",
  );
}
/** W's own read as a sale's plan takes it (wHeld), for the sell box's preview (pool-sell-dry.ts, card
 *  app-sell-shows-what-you-receive): the same call, W's addresses only; with no wait, so two RPCs that answer apart end it
 *  at once ("split", the preview's "not now"); frozen on both: "frozen", which the plan counts as nothing held. */
export async function wHeldNow(rpcs: Rpcs, w: string, mint: string, program: string): Promise<WHeld | "split" | "frozen"> {
  const now = new Error("split");
  try {
    return await wHeld(rpcs, w, mint, program, () => Promise.reject(now));
  } catch (e) {
    if (e === now) return "split";
    if (e instanceof Refused && e.code === "not_allowed") return "frozen";
    throw e;
  }
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
type Later = { back?: (locks: Locks | null) => Promise<unknown>; rebuild?: true; last?: boolean; fault?: unknown; reprice?: true; simWaited?: number; stamp?: Promise<unknown> };

/** Each sale's stamp of the device's spacing (sellRun) in the store, or its bound passed (a write that fails or runs out
 *  leaves the last stamp): awaited before a run's rent backs and before it lets go of POOL_TRADE_LOCK, which holds every
 *  leftover pass, in any tab, until then. */
const stamped = (laters: readonly Later[], ms: number): Promise<unknown> => Promise.all(laters.map((l) => l.stamp && within(l.stamp, ms, "the device's spacing").catch(() => {})));

// A provider read that still fails past the page's own retry before any signature (kit send.ts SolanaRpcTransportError:
// a 429, a 5xx, a throttle code, no answer in time) makes the step it failed (the plan, or one wallet's sale from its
// first read) again after a wait on the page's one rule (read-waits.ts readWaits: from 1 s, doubling, at most 10 s, a
// Retry-After honoured to 10 s), until the waits would pass READ_WAIT_TOTAL_MS; then "down", nothing signed (card
// start-reads-wait-out-a-throttle: the app's devnet run 6 met three flat 1 s waits that never outlasted the provider's
// window). Each attempt reads its quote, venue and blockhash again; the Rent sysvar and the mint are kept per provider
// across the attempts of one sell (keptReads), so a provider that answered them is not asked again.

/** One W's rent back owed: W, its l and j (W again from the seed), the mints it traded, and its passes so far; `seen`,
 *  what the helper read W as (findOn) before its last pass, when that pass ended on W's own state (under the floor,
 *  holding, an account kept), so a load whose read of W is the same skips W with no other read. Card
 *  round-trip-costs-less: `buy`, W's coin as the restore's rebuild read it and the public seat read it the same
 *  (provenBuy; null: W's note paid a plain release, no buy), so it is read once. `found`: a W the device found holding
 *  SOL with no buy of its recorded (card buy-spends-several-pieces: the own W of an UNSPENT note, after a restore): swept
 *  only once both RPCs read it owning no token account at all, so a coin is never swept with it. */
/** `lamports`: what W's last pass read on W, alike on both RPCs, its buy proven (src/positions.ts returningWallets lists
 *  W on its way at it); `sweep`: its last sweep's signature, so W stays listed until the note that sweep wrote is counted
 *  (never twice: the list reads the same notes the balance does); `spaced`: when W's own last rent-back send was, so W is
 *  never spaced against itself (RentBackSpacing). */
export type OwedRentBack = { address: string; l: string; j: number; mints: { mint: string; program: string }[]; passes: number; seen?: string; sell?: Readonly<Record<string, SoldBy>>; buy?: SolanaBuy | null; lamports?: string; sweep?: string; spaced?: number; found?: true; floor?: true; differs?: number };
/** A full sell of one mint, as W's owed record keeps it (card sol-rent-back-dust-burn): its signed bytes (base64) and its
 *  blockhash's last valid height, so a balance W's account of that mint holds after this very transaction landed
 *  leaving it none is a stranger's, burned by the rent back. */
type SoldBy = { tx: string; last: number };
/** `empty`/`markEmpty` (card round-trip-costs-less): the account's Ws a pass read empty for good (nothing on W, no
 *  account, or no buy at all), each with the rules it was read under (POOL_RENT_BACK_RULES), so a load lists them and
 *  reads none of them again. */
export type OwedRentBacks = { list(): Promise<OwedRentBack[]>; put(r: OwedRentBack): Promise<void>; drop(address: string): Promise<void>; empty?(): Promise<ReadonlySet<string>>; markEmpty?(address: string): Promise<void>; spacing?(): Promise<RentBackSpacing | undefined>; space?(v: RentBackSpacing): Promise<void>; claim?(v: RentBackSpacing, own?: number): Promise<boolean>; rideAt?(): Promise<number | undefined>; bookRide?(at: number): Promise<void>; rode?(at: number): Promise<void>; tail?(t: WTail): Promise<void>; untail?(address: string): Promise<void> };
/** A W's leftover under the pool's least standard size (card pool-amounts-are-standard-sizes; pick (c), 13 Nov
 *  20:4xZ): meta w-tail/sol/<address>, the record wallet's pool-to-Cash carries to Cash and the balance counts. Written
 *  by a rent back that ends at the floor (`amount`: what W adds once moved, lamports, a decimal string), deleted by one
 *  that reads W empty or sends its sweep; never deposited off the ladder, never paid away. */
export type WTail = { chain: "sol"; address: string; l: string; j: number; amount: string };
export const wTailKey = (address: string): string => `w-tail/sol/${address}`;
export { POOL_RENT_BACK_SPACE_MAX_MS, POOL_RENT_BACK_SPACE_MIN_MS, spaceOpen, type RentBackSpacing } from "./device-spacing.ts";
/** How a rent back ended: its sweep sent; nothing left on W; W under the smallest note (solanaSweepFloor), its lamports
 *  kept on W; an account the plan keeps (so W keeps the fee to close it later); W holding a token; or it gave up. */
// "owed": W keeps what a later claim of its owed cashback needs: an account whose claim did not simulate on either RPC
// this pass (review M1 of 11c963f9), with the rest under the floor once that claim's cost is kept (solanaSweepKeep,
// card sol-w-sweep); nothing is swept this pass and the record stays, so a later pass claims it and sweeps
// "refused": the kit's plan refuses W's accounts as both RPCs read them alike, byte for byte (review 5 of 38e59182, M1):
// the same reads plan the same refusal, so the pass ends at once, W keeping all, and waits for W to read otherwise
export type RentBackEnd = "sent" | "nothing" | "floor" | "owed" | "kept" | "holds" | "refused" | "gave_up";
export type RentBackTold = { address: string; step: "teardown" | "sweep" | "rent_back"; state: "fault" | "gave_up" | RentBackEnd; detail: string };

/** The rent backs owed, in the wallet store's meta/owed/rentback-sol (meta/owed/ is never read or listed by the frame);
 *  the spacing in the device's own database (src/device-spacing.ts), which sign out leaves. */
export const owedRentBacks = (store: () => Promise<Pick<TradeStore, "get" | "update"> & { delete?(s: "meta", k: string): Promise<void> }>, device: DeviceSpacing = deviceSpacing()): OwedRentBacks => {
  const KEY = "owed/rentback-sol";
  type All = Record<string, OwedRentBack>;
  return {
    list: async () => Object.values(((await (await store()).get("meta", KEY)) as All | undefined) ?? {}),
    // the list's order is the load's own, drawn at random (resumeRentBacks; review 5 of 38e59182, L2: a W that ends its
    // pass without progress never holds the rest behind it)
    put: async (r) => void (await (await store()).update("meta", KEY, (v) => ({ ...((v as All | undefined) ?? {}), [r.address]: r }))),
    drop: async (address) =>
      void (await (await store()).update("meta", KEY, (v) => {
        const all = { ...((v as All | undefined) ?? {}) };
        if (!Object.hasOwn(all, address)) return undefined;
        delete all[address];
        return all;
      })),
    empty: async () => {
      const all = ((await (await store()).get("meta", EMPTY)) as Record<string, number> | undefined) ?? {};
      return new Set(Object.keys(all).filter((a) => all[a] === POOL_RENT_BACK_RULES));
    },
    markEmpty: async (address) => void (await (await store()).update("meta", EMPTY, (v) => ({ ...((v as Record<string, number> | undefined) ?? {}), [address]: POOL_RENT_BACK_RULES }))),
    // the device's last rent-back send and its gap (RentBackSpacing), and a leftover pass's slot taken in one
    // compare-and-set so two tabs never both take it: the device's, not the account's, so a sign out and in keeps it
    spacing: () => device.spacing(),
    space: (v) => device.space(v),
    claim: (v, own) => device.claim(v, own),
    // the ride a tap booked, a time (ms) and nothing else, so a page closed before it is due rides at a later load
    // (review P2-1 of 1d3b96d9c); 0 when none
    rideAt: async () => {
      const v = (await (await store()).get("meta", RIDE)) as unknown;
      return Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined;
    },
    bookRide: async (at) => void (await (await store()).update("meta", RIDE, (v) => (Number.isSafeInteger(v) && (v as number) >= at ? undefined : at))),
    rode: async (at) => void (await (await store()).update("meta", RIDE, (v) => (v === at ? 0 : undefined))),
    tail: async (t) => void (await (await store()).update("meta", wTailKey(t.address), () => ({ chain: t.chain, address: t.address, l: t.l, j: t.j, amount: t.amount }))),
    // a tail gone: its record deleted (the page's wallet store deletes; the store's update writes a value or nothing)
    untail: async (address) => {
      const s = await store();
      if ((await s.get("meta", wTailKey(address))) !== undefined) await s.delete?.("meta", wTailKey(address));
    },
  };
};
const EMPTY = "owed/rentback-sol-empty";
const RIDE = "owed/rentback-sol-ride";

/** Where W's buy mints are: the wallet store's meta, by W's address; the key buyMints writes (its own literal there is
 *  the shape scripts/live-checks/sol-w-sweep.mjs reads in the bundle; positions.test holds the two the same). */
export const BUY_MINTS_KEY = "owed/buy-sol";
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

/** A later leg's venue: the one it read at its turn when that is the venue its own reference chose (the leg before it
 *  chose it too), else the chosen venue read now; a guess not taken is never used, its failure never this sale's. */
export function legVenue<V>(guess: { kind: "pump-curve" | "pumpswap"; read: Promise<V> } | null, chose: "pump-curve" | "pumpswap", venueOf: (kind: "pump-curve" | "pumpswap") => Promise<V>): Promise<V> {
  if (guess?.kind === chose) return guess.read;
  guess?.read.catch(() => {});
  return venueOf(chose);
}

/** One W's sale, built again (POOL_SELL_REBUILDS at most) while its deposit meets a page another deposit filled first. */
async function sellRuns(h: PoolSellHost, ask: PoolAsk, later: Later, w: ListedBuyWallet, waits: ReadWaits, early?: Early, turn?: LegTurn): Promise<LegAnswer> {
  for (let i = 0; ; ) {
    delete later.rebuild;
    delete later.fault;
    delete later.reprice;
    later.last = i >= POOL_SELL_REBUILDS;
    // the sell's earlier reads are the first attempt's alone: every attempt after it reads from its first read
    const a = await sellRun(h, ask, later, w, waits, early, turn);
    early = undefined;
    // its price may be old (a wait after its quote was asked; its simulation refused while an earlier leg of the sale was
    // in flight): read and priced again from its first read, nothing signed; each such attempt followed a wait the tap's
    // bound counted (sellRun's wait), so the bound ends them
    if (later.reprice && !h.stopped?.()) {
      forgetYoung(h.rpcs);
      continue;
    }
    // a provider read that failed before W signed: the sale again from its first read, after the rule's wait
    if ("error" in a && "fault" in later && !h.stopped?.()) {
      const ms = waits.next(later.fault);
      if (ms !== null) {
        await waitUnless(h.wait, ms, h.signal);
        // a sign out during the wait: the sale never starts again (nothing signed)
        if (h.stopped?.() || h.signal?.aborted) return { error: "failed" };
        // every read after the wait its own: none of the sale's young reads from before it
        forgetYoung(h.rpcs);
        continue;
      }
    }
    if (!later.rebuild || i >= POOL_SELL_REBUILDS) return a;
    forgetYoung(h.rpcs);
    i++;
  }
}

/** One wallet's sale as its run answers it. */
type LegAnswer = { stage: TradeStage; txs: TxRef[] } | { error: PoolSellError; cause?: string };

/** Why a leg was refused, in public words only (card pool-sell-legs-side-by-side: the paid pass of 11 Nov 07:36Z ended
 *  a leg "failed" and nothing kept why): the error's name; its code (a refusal's, a provider fault's, or the JSON-RPC or
 *  HTTP code its text names, digits only); and the two functions it was thrown in, from its stack. Never its text, which can
 *  name a URL or a key. */
export function legCause(e: unknown): string {
  // a proof pass's tag (PassFail) names its cause: the cause's class, code and frames, never the wrap's
  if (e instanceof PassFail) return legCause(e.cause);
  try {
    const x = e as { name?: unknown; code?: unknown; fault?: unknown; message?: unknown; stack?: unknown } | null;
    const name = typeof x?.name === "string" && /^[\w$]{1,40}$/.test(x.name) ? x.name : "thrown";
    const text = typeof x?.message === "string" ? x.message : "";
    const own = typeof x?.code === "string" || typeof x?.code === "number" ? String(x.code) : typeof x?.fault === "string" ? x.fault : undefined;
    // a sale's own check that refused it (Refused's check: fee_split, sim, sizes_moved...)
    const check = e instanceof Refused && e.check !== undefined ? `check ${e.check}${e.detail === undefined ? "" : ` ${e.detail}`}` : undefined;
    const code = own !== undefined && /^[\w-]{1,40}$/.test(own) ? own : (/RPC error (-?\d{1,6})\b/.exec(text)?.[1] ?? /\bHTTP (\d{3})\b/.exec(text)?.[1]);
    // the two innermost named frames (a refusal is thrown in its helper, no(): the second is where it was refused)
    const frames = typeof x?.stack === "string" ? [...x.stack.matchAll(/\n\s*at (?:async )?([\w$.]{1,60}) \(/g)].slice(0, 2).map((m) => m[1]) : [];
    return [name, code, check, frames.length === 0 ? undefined : `at ${frames.join(" < ")}`].filter((v) => v !== undefined).join(" ");
  } catch {
    return "thrown";
  }
}

/** A sell's plan: the units it sells over every wallet, and each wallet's sale in the order they run. `frozen`: a W
 *  both RPCs read frozen was left out, so a share of the holding never sells all of it. */
export type PoolSellPlan = { units: bigint; total: bigint; legs: readonly { w: ListedBuyWallet; units: bigint; held: bigint }[]; frozen: boolean };

/**
 * The sell's plan (card pool-sell-share-across-wallets), from the device's own reads alone. Every buy of a token lands in
 * its own fresh wallet W, so the user's holding of it is spread over several.
 * - The Ws: the page's buy wallets (h.wallets(): every W the pool's spent notes paid, derived from the seed) that its own
 *   buy record names for this token (h.bought, written by the buy before its send) or that the listed holdings show
 *   holding it: the last whole positions pass's listing, and the finder's read (on mainnet the helper's one read,
 *   paced) of only the Ws neither names (a buy from before the record, a restored device). The fast path, so a token
 *   held in 1 W of 100 past buys costs that one W's reads (card wallets-found-in-one-read). When those do not cover the
 *   sale (none holds the token, or a typed amount is past what they hold), the finder reads every other W, one per
 *   request, and those it lists holding the token join (a token sent to a W whose record names another: an airdrop).
 *   The listed holdings only add a W to read; no amount of theirs is used. A W whose record could not be read is the
 *   finder's to read even when the others cover the sale, never left out in silence. A W listed twice is read once.
 * - Each W's holding: its token account on both RPCs, the same on both (ataHeld: read again once, then failed), each W
 *   in requests of its own (a read names one W of the user's at most); the mint once, on both RPCs. An account both
 *   RPCs read frozen is not sold (holds 0 here; a sell it leaves short is not_allowed; a share then ends part_filled at
 *   best, never filled). A W that cannot be read, or that one RPC alone reads frozen, fails the whole sell before
 *   anything is signed: a share of a total that misses a W would sell less than the user asked. A W reading 0 is no
 *   sale. A W whose full sale of the token was sent before (its owed record names it) is read like any other: that
 *   record outlives a sale that never landed, so only the chain says W is sold out.
 * - The units: a share's, the total times the share in basis points, rounded down (10,000: the whole total, every unit);
 *   a typed amount's, the amount, refused not_funded when it is over the total. Zero: not_funded.
 * - One W holding at least the units: one sale, from the smallest such W (review P2-3 of 77055f4e), for a share and a
 *   typed amount alike: one transaction, one fee, the fewest Ws touched.
 * - Else the walk, smallest holding first (then by address, so one read gives one plan). Each W the units still cover is
 *   sold whole (the full sell: its accounts closed and every lamport back as a note, the rent back); the first W they do
 *   not cover is sold in part, and the walk ends. Smallest first closes the most Ws and leaves the one part sale where
 *   the most is held.
 */
export async function planPoolSell(h: Pick<PoolSellHost, "rpcs" | "wallets" | "bought" | "wait" | "signal" | "stopped">, ask: PoolAsk): Promise<PoolSellPlan> {
  return (await planReads(h, ask)).plan;
}

/** The Ws a sale's plan reads at once, and the time between its steps (planReads). */
export const PLAN_W_STEP = 12;
export const PLAN_STEP_MS = 1_000;

/** planPoolSell, with each W's read (wHeld) by address, and `listed` told the Ws it reads before it reads them (sellAll
 *  starts a lone W's own sale reads beside them). No W: no read at all. Else the mint is read beside each W's own
 *  accounts, under the program W's own buy record names for the token (pool-buy.ts BuyMints) when it names one: the
 *  mint's program on both RPCs decides, and a W read under another program is read again under the mint's (card
 *  pool-sell-legs-side-by-side: one round for the plan's reads). */
async function planReads(h: Pick<PoolSellHost, "rpcs" | "wallets" | "bought" | "wait" | "signal" | "stopped">, ask: PoolAsk, listed?: (ws: readonly ListedBuyWallet[]) => void, wait?: (ms: number) => Promise<void>): Promise<{ plan: PoolSellPlan; seen: ReadonlyMap<string, WHeld> }> {
  if (ask.kind !== "pool.sell" || ask.chain !== "solana" || ask.token === null) return no("not_allowed");
  const token = ask.token;
  // each W's buy record, read once; one that does not read is unknown, never empty: the finder reads that W
  const unknown = new Set<string>();
  const seen = new Set<string>();
  // the Ws of a list to read: those a buy record names for the token, or that the list shows holding it; each W once,
  // however often a list names it
  const pick = async (xs: readonly ListedBuyWallet[]): Promise<{ w: ListedBuyWallet; guess: string | null }[]> => {
    const ws: { w: ListedBuyWallet; guess: string | null }[] = [];
    for (const x of xs) {
      if (x.chain !== "sol" || seen.has(x.address)) continue;
      const bought = await Promise.resolve(h.bought?.get(x.address)).catch(() => void unknown.add(x.address));
      if (bought?.mint !== token && !x.holdings?.tokens.has(token)) continue;
      seen.add(x.address);
      ws.push({ w: x, guess: bought?.mint === token && typeof bought.program === "string" ? bought.program : null });
    }
    return ws;
  };
  // a read the two providers answer apart waits on the sale's own wait, ended by a sign out
  const planWait = wait ?? ((ms: number) => waitUnless(h.wait, ms, h.signal));
  let mint: Promise<string> | null = null;
  const reads = new Map<string, WHeld>();
  const one = async ({ w, guess }: { w: ListedBuyWallet; guess: string | null }): Promise<{ w: ListedBuyWallet; held: bigint; frozen?: true }> => {
    try {
      let r: WHeld;
      if (guess === null) r = await wHeld(h.rpcs, w.address, token, await mint!, planWait);
      else {
        const g = wHeld(h.rpcs, w.address, token, guess, planWait);
        g.catch(() => {});
        const program = await mint!;
        r = program === guess ? await g : (await g.catch(() => null), await wHeld(h.rpcs, w.address, token, program, planWait));
      }
      reads.set(w.address, r);
      return { w, held: r.amount };
    } catch (e) {
      // frozen on both RPCs: never sold, so none of it counts
      if (e instanceof Refused && e.code === "not_allowed") return { w, held: 0n, frozen: true as const };
      throw e;
    }
  };
  // the Ws' reads in steps of PLAN_W_STEP a PLAN_STEP_MS apart: one sale never puts more than 20 reads on one provider
  // inside 1 s (the helper's keyed provider is paced at 10 a second upstream; a public one counts connections), with the
  // mint, rent and sizes reads beside the first step; a sale of up to PLAN_W_STEP Ws is one step. A step starts once
  // the wait has passed and the step before it answered, so a read that failed starts no later step; a sign out at the
  // wait asks nothing more (review of 55d4c6eb, P3-C).
  const readAll = async (ws: readonly { w: ListedBuyWallet; guess: string | null }[]): Promise<{ w: ListedBuyWallet; held: bigint; frozen?: true }[]> => {
    if (ws.length === 0) return [];
    if (mint === null) {
      mint = mintProgram(h.rpcs, token);
      mint.catch(() => {});
    }
    const asked: Promise<{ w: ListedBuyWallet; held: bigint; frozen?: true }>[] = [];
    let failed = false;
    for (let i = 0; i < ws.length && !failed; i += PLAN_W_STEP) {
      if (i > 0) {
        await Promise.all([waitUnless(h.wait, PLAN_STEP_MS, h.signal), Promise.allSettled(asked)]);
        if (h.signal?.aborted || h.stopped?.()) return no();
        if (failed) break;
      }
      for (const x of ws.slice(i, i + PLAN_W_STEP)) {
        const p = one(x);
        p.catch(() => void (failed = true));
        asked.push(p);
      }
    }
    return Promise.all(asked);
  };
  // the fast path (card wallets-found-in-one-read): every W from the device, the finder reading only those no buy record
  // or kept pass names (the host's list, h.wallets()), each W picked read here on both RPCs
  const first = await pick(await h.wallets());
  listed?.(first.map((x) => x.w));
  const held = await readAll(first);
  const total0 = held.reduce((t, x) => t + x.held, 0n);
  // not covered (no W read holds it, or they hold less than a typed amount): every other W through the finder, one per
  // request, and each it lists holding the token is read and added (an airdrop to a W recorded for another mint): what
  // that cost before, never a refusal. Covered: only the Ws whose record could not be read, so a share is never taken
  // of a total that misses one in silence
  const covered = total0 > 0n && poolSellUnits(total0, ask) <= total0;
  if (!covered || unknown.size > 0) held.push(...(await readAll(await pick(await h.wallets((a) => (covered ? unknown.has(a) : !seen.has(a)))))));
  const plan = planOf(ask, held);
  return { plan, seen: reads };
}

/** The plan from each W's holding (planPoolSell's rules). */
function planOf(ask: PoolAsk, held: readonly { w: ListedBuyWallet; held: bigint; frozen?: true }[]): PoolSellPlan {
  const frozen = held.some((x) => "frozen" in x);
  const order = held.filter((x) => x.held > 0n).sort((x, y) => (x.held < y.held ? -1 : x.held > y.held ? 1 : x.w.address < y.w.address ? -1 : x.w.address > y.w.address ? 1 : 0));
  const total = order.reduce((t, x) => t + x.held, 0n);
  const units = poolSellUnits(total, ask);
  // short of the units: a frozen account among the Ws is why (not_allowed, as one W's frozen sale is), else not_funded
  if (units <= 0n || units > total) return no(frozen ? "not_allowed" : "not_funded");
  const one = order.find((x) => x.held >= units);
  if (one) return { units, total, legs: [{ w: one.w, units, held: one.held }], frozen };
  const legs: { w: ListedBuyWallet; units: bigint; held: bigint }[] = [];
  let left = units;
  for (const x of order) {
    if (left === 0n) break;
    const take = left < x.held ? left : x.held;
    legs.push({ w: x.w, units: take, held: x.held });
    left -= take;
  }
  return { units, total, legs, frozen };
}

/** The units a sell takes of a holding of `total` base units: a share's, the total times the share in basis points,
 *  rounded down (10,000: the whole total, every unit); a typed amount's, the amount. The plan (planPoolSell) and the
 *  sell box's preview (pool-sell-dry.ts) both take it from here. */
export const poolSellUnits = (total: bigint, ask: Pick<PoolAsk, "amount" | "shareBps">): bigint =>
  ask.shareBps === undefined ? ask.amount : ask.shareBps === 10_000 ? total : (total * BigInt(ask.shareBps)) / 10_000n;

/** The quote a sale of `amount` signs on: the reference for exactly this sell on both RPCs (the kit's
 *  readSolanaReference, side "sell", through pageReference) and the venue in it that gives the most; null when there is
 *  none. Every sale (sellRun) and the sell box's preview (pool-sell-dry.ts) read it here, so the preview is the sale's
 *  own quote on the same reads. A provider's fault is thrown (pageReference). */
export async function poolSellReference(rpcs: Rpcs, token: string, amount: bigint): Promise<{ reference: SolanaReference; best: SolanaReference["pools"][number] } | null> {
  const reference = await pageReference(rpcs, { side: "sell", token, amount });
  const best = reference?.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];
  return reference && best ? { reference, best } : null;
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
async function sellAll(host: PoolSellHost, ask: PoolAsk, laters: Later[], hooks: LegHooks = {}, waits: ReadWaits = readWaits(clockOf(host))): Promise<PoolSellAnswer> {
  let plan: PoolSellPlan;
  // the sell's reads that cannot change while it waits, kept per provider across its attempts (read-waits.ts)
  // and its market and blockhash reads, shared by its legs while young (youngReads)
  const clock = (): number => Number(host.now?.() ?? BigInt(Date.now()));
  const h: PoolSellHost = Object.assign(Object.create(host) as PoolSellHost, { rpcs: youngReads(keptReads(host.rpcs, solanaStableReads(ask.token)), solanaSaleReads(ask.token), POOL_SELL_SHARED_READ_MS, clock) });
  // one tap's waits: its plan's and every sale's share the rule's one bound (READ_WAIT_TOTAL_MS on the clock)
  // an ask that is not a Solana sell of a token: refused before any read (planPoolSell's own refusal)
  if (ask.kind !== "pool.sell" || ask.chain !== "solana" || ask.token === null) return { error: "not_allowed" };
  // the first sale's reads that need no plan, started beside the plan's own once it has a W to read (card
  // pool-sell-legs-side-by-side): the Rent sysvar and the pool's sizes; for a lone W (the only one the plan can sell from), its note and the price
  // reference at the units the plan gives when the reads agree (a typed amount; a share of the listed holding), so its
  // sale's first round is the plan's own. A sale's units other than the guess read their reference again
  let early: Early = {};
  let lone: string | null = null;
  // the plan's waits for two providers to agree (W's accounts, the pool's sizes): on the tap's one bound, ended at a sign
  // out; one after the plan's reference was asked makes it old, so the first sale prices on its own (Early.waited)
  let planWaited = false;
  const planWait = async (ms: number): Promise<void> => {
    if (!waits.hold(ms)) return no("failed", "tap_bound");
    planWaited = true;
    await waitUnless(h.wait, ms, h.signal);
    if (h.stopped?.() || h.signal?.aborted) return no("failed", "stopped");
  };
  const quiet = <T>(p: Promise<T>): Promise<T> => (p.catch(() => {}), p);
  for (;;) {
    try {
      // the pin, read once for the plan's attempt: the first sale reads and builds on this one (its rule reads the
      // page's pin again at its check)
      const program = h.pin.program;
      const { pool, scope } = solanaPoolOf(program);
      lone = null;
      early = { program };
      const got = await planReads(h, ask, (ws) => {
        if (ws.length === 0) return;
        early.rent = quiet(readSolanaRent(h.rpcs));
        early.sizes = quiet(treeSizes(h.rpcs, program, pool, planWait));
        const w = ws[0];
        if (ws.length !== 1 || ask.token === null) return;
        lone = w!.address;
        const listed = w!.holdings?.tokens.get(ask.token)?.amount;
        const units = ask.shareBps === undefined ? ask.amount : listed === undefined ? 0n : ask.shareBps === 10_000 ? listed : (listed * BigInt(ask.shareBps)) / 10_000n;
        const seeds: Uint8Array[] = [];
        const seed = async (): Promise<Uint8Array> => {
          const s = await h.seed64();
          seeds.push(s);
          return s;
        };
        early.note = quiet(h.notes().then((store) => noteFor(h, h.rpcs, program, scope, store, solanaTreeSync(h.rpcs, program), w!, seed)).finally(() => seeds.forEach((s) => s.fill(0))));
        if (units > 0n) early.reference = { amount: units, read: quiet(poolSellReference(h.rpcs, ask.token, units)) };
      }, planWait);
      plan = got.plan;
      const held = got.seen.get(plan.legs[0]!.w.address);
      if (held) early.held = Promise.resolve(held);
      break;
    } catch (e) {
      // the reads beside a plan that did not stand end before the sell answers or reads again: none outlives its
      // attempt, and the note's seed copy is zeroed by then
      await Promise.allSettled([early.rent, early.sizes, early.note, early.reference?.read]);
      if (e instanceof Refused) return { error: e.code };
      // a provider read that failed: the plan read again after the rule's wait, then "down"; a sign out during the
      // wait ends it, nothing run
      if (waitsOn(e)) {
        const ms = h.stopped?.() ? null : waits.next(e);
        if (ms === null) return { error: "down" };
        await waitUnless(h.wait, ms, h.signal);
        if (h.stopped?.() || h.signal?.aborted) return { error: "failed" };
        forgetYoung(h.rpcs);
        continue;
      }
      return { error: "failed" };
    }
  }
  // the plan's first leg takes the reads made beside the plan (its note only when it is the lone W they were read for)
  const first: Early = { ...early, ...(early.note && lone !== plan.legs[0]!.w.address ? { note: undefined } : {}), waited: () => planWaited };
  await hooks.planned?.(plan);
  const legs: PoolSellLeg[] = plan.legs.map((l) => ({ wallet: l.w.address, amount: l.units.toString(), tx: null, stage: null }));
  // each leg's turn: the one before it sent, or ended before sending. Every leg starts at once (card
  // pool-sell-legs-side-by-side): its reads that no other leg's sale changes (the Rent sysvar and the pool's sizes,
  // read once for every leg's first attempt; its own note; the mint's program) before its turn, every read its sale
  // prices on after it (sellRun)
  let turn: Promise<void> = Promise.resolve();
  // the venue the last leg's reference chose, so a leg after it reads that venue beside its own reference
  const venues: { kind?: "pump-curve" | "pumpswap" } = {};
  const shared: Early = { ...(first.program === undefined ? {} : { program: first.program }), ...(first.rent ? { rent: first.rent } : {}), ...(first.sizes ? { sizes: first.sizes } : {}) };
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
    return Promise.resolve()
      // a wallet whose turn comes once the tap's waits are spent (another wallet's sale was refused its next wait):
      // down without its priced reads, nothing signed (review of f0e7bd38, P2-2; sellRun checks again at its turn)
      .then((): Promise<LegAnswer> | LegAnswer => (h.stopped?.() ? { error: "failed" } : waits.spent() ? { error: "down" } : sellRuns(leg, { ...ask, amount: l.units, shareBps: undefined }, later, l.w, waits, i === 0 ? first : shared, { ...(i === 0 ? {} : { opened: prior }), venues, spent: () => waits.spent(), inFlight: () => legs.slice(0, i).some((x) => x.stage === "signed" || x.stage === "sent") })))
      .catch((e: unknown): LegAnswer => ({ error: "failed", cause: legCause(e) }))
      .then((a) => {
        open();
        legs[i] = "error" in a ? { ...legs[i]!, tx: null, stage: null, error: a.error, ...(a.cause === undefined ? {} : { cause: a.cause }) } : { ...legs[i]!, tx: a.txs.at(-1)?.hash ?? legs[i]!.tx, stage: a.stage };
        hooks.ended?.(i, legs[i]!);
        return a;
      });
  });
  const got = await Promise.all(runs);
  // a refusal's cause stays on its leg (the record's, the console's): the sale's answer is its code alone
  if (got.length === 1 && "error" in got[0]!) return { error: got[0].error };
  if (got.every((a) => "error" in a)) return { error: (got[0] as { error: PoolSellError }).error };
  const txs: TxRef[] = legs.flatMap((l) => (l.tx === null ? [] : [{ chain: "solana" as const, hash: l.tx }]));
  return { stage: shortOf(stageOfLegs(legs), plan.frozen && ask.shareBps !== undefined), txs, legs };
}

/** A sell's stage when part of the holding it was asked a share of could not be sold (`short`: a W both RPCs read
 *  frozen was left out): filled becomes part_filled, every other stage stays. */
const shortOf = (stage: TradeStage, short: boolean): TradeStage => (short && stage === "filled" ? "part_filled" : stage);

/** One pool.sell: the ask is the user's own (rules/pool.ts checkPoolRequest passed it, with the token's decimals): its
 *  units, or its share of the whole holding (planPoolSell). After the sales, each full sale's rent back (rentBack) runs,
 *  one W after another, before this answers; none changes the answer. */
export async function runPoolSell(h: PoolSellHost, ask: PoolAsk, waits?: ReadWaits): Promise<PoolSellAnswer> {
  const laters: Later[] = [];
  const a = await sellAll(h, ask, laters, {}, waits);
  await stamped(laters, h.storeMs ?? TRADE_STORE_MS);
  for (const later of laters) await later.back?.(null);
  return a;
}

/** A sale's first-round reads the sell made before the sale itself, in the same attempt with no wait since (sellAll):
 *  each taken by the sale's first attempt alone, never by one after a wait or a rebuild. `reference`: read at
 *  `amount`, taken only when the sale's units are exactly that. */
type Early = {
  /** The pin's program the reads below were made for: the sale reads and builds on it. */
  program?: string;
  rent?: Promise<SolanaRent>;
  sizes?: Promise<{ stateSize: number; labelSize: number }>;
  held?: Promise<WHeld>;
  note?: Promise<{ ref: NoteRef; precommitment: bigint; planned: string | null }>;
  reference?: { amount: bigint; read: ReturnType<typeof poolSellReference> };
  /** Whether the plan waited for its providers to agree: its reference (asked before that) is then old. */
  waited?: () => boolean;
};

/** W's note for the sale's deposit (returnNote), the seed copy for its precommitment zeroed at once. */
async function noteFor(h: Pick<PoolSellHost, "settled" | "stopped">, rpcs: Rpcs, program: string, scope: bigint, store: NoteStore, sync: SolanaTreeSync, w: ListedBuyWallet, seed: () => Promise<Uint8Array>): Promise<{ ref: NoteRef; precommitment: bigint; planned: string | null }> {
  const s = await seed();
  try {
    // a sign out while the seed was read: the note's reads are never asked
    if (h.stopped?.()) return no("failed", "stopped");
    return await returnNote(rpcs, program, scope, store, sync, s, w.l, w.j, h.settled);
  } finally {
    s.fill(0);
  }
}

/** A leg's turn (sellAll): `opened` once the leg before it sent or ended (none for the first leg); `venues`, the venue the
 *  last leg's reference chose, which a leg after it reads beside its own reference and keeps only when its own chose it. */
type LegTurn = { opened?: Promise<void>; venues: { kind?: "pump-curve" | "pumpswap" }; spent?: () => boolean; inFlight?: () => boolean };

/** A refused simulation's program error line (the last log line that names an error), made safe, or nothing. */
const simError = (v: { logs?: unknown } | null | undefined): string => {
  const logs = Array.isArray(v?.logs) ? v.logs.slice(-50) : [];
  const line = logs.findLast((l): l is string => typeof l === "string" && /error/i.test(l));
  return line === undefined ? "" : ` ${safeDetail(line)}`;
};

async function sellRun(h: PoolSellHost, ask: PoolAsk, later: Later, w: ListedBuyWallet, waits: ReadWaits, early?: Early, turn?: LegTurn): Promise<LegAnswer> {
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
  // the sale's price must be new when it signs (review of 55d4c6eb..dbf63c98, P2-1): once its quote is asked (`asked`),
  // any wait (two providers apart on W's accounts, the deposit's reads, the cashback accounts) makes it old (`stale`),
  // and the sale is read and priced again before the quote's age rule judges it (sellRuns, later.reprice). Every wait
  // counts on the tap's one bound (READ_WAIT_TOTAL_MS: refused tap_bound past it) and ends at a sign out (P3-1/P3-2)
  let asked = false;
  let stale = false;
  const wait = async (ms: number): Promise<void> => {
    if (!waits.hold(ms)) return no("failed", "tap_bound");
    if (asked) stale = true;
    await waitUnless(h.wait, ms, h.signal);
    if (h.stopped?.() || h.signal?.aborted) return no("failed", "stopped");
  };
  try {
    if (ask.kind !== "pool.sell" || ask.chain !== "solana" || ask.token === null || ask.shareBps !== undefined || w.chain !== "sol") return no("not_allowed");
    const token = ask.token;
    const amount = ask.amount;
    // W: the plan's (planPoolSell), from the device's own reads; read again here, as every sale does
    // the pin, read once for every read and the build; the rule reads the page's pin again at the check
    const program = early?.program ?? h.pin.program;
    const { pool, scope } = solanaPoolOf(program);
    const rpcs = h.rpcs;
    const store = await h.notes();
    const sync = solanaTreeSync(rpcs, program);
    const quiet = <T>(p: Promise<T>): Promise<T> => (p.catch(() => {}), p);
    // before the leg's turn: what no other leg's sale changes (the Rent sysvar; the pool's sizes, read again with the
    // deposit's pages after the turn, depositHeld; W's note; the mint's program)
    // a later leg's Rent and pool sizes are the plan's when they were read; when the plan's read failed, its own read
    // again, never the plan's failure (review of 55d4c6eb, P2-B: one 429 there was every leg's fault); the first leg's
    // are its own attempt's, as before
    const own = turn?.opened !== undefined;
    const rentP = quiet(early?.rent ? (own ? early.rent.catch(() => readSolanaRent(rpcs)) : early.rent) : readSolanaRent(rpcs));
    const sizesP = quiet(early?.sizes ? (own ? early.sizes.catch(() => treeSizes(rpcs, program, pool, wait)) : early.sizes) : treeSizes(rpcs, program, pool, wait));
    const noteP = quiet(early?.note ?? noteFor(h, rpcs, program, scope, store, sync, w, seed));
    const mintP = early?.held ? null : quiet(mintProgram(rpcs, token));
    // a leg after the first: every read its sale prices on (W's accounts, the reference, the blockhash, the deposit's
    // pages, the venue) only once the leg before it sent or ended, so the quote, the blockhash and W's balance it signs
    // on are read after that wait; a sign out asked meanwhile ends it, nothing read past it
    const opened = turn?.opened;
    if (opened) {
      await opened;
      if (h.stopped?.()) return { error: "failed" };
      // the tap's waits spent while it waited its turn (another wallet's sale was refused its next wait): down, none of
      // its priced reads asked, nothing signed (review of f0e7bd38, P2-2)
      if (turn!.spent?.()) return { error: "down" };
      // the market and the blockhash it prices on read after the leg before it sent: none of the sale's young reads from
      // before that sale (review of 55d4c6eb..dbf63c98, P2-1)
      forgetYoung(rpcs);
    }
    asked = true;
    const venueOf = (kind: "pump-curve" | "pumpswap") => readSolanaPoolBuyVenue(rpcs, kind, token, ...(h.pick ? [h.pick] : []));
    // after its turn, a leg after the first asks all of them in one round: the blockhash (its check on RPC 1 as soon as
    // RPC 0 answered), the deposit's pages at the sizes read before the turn, and the venue the last leg chose
    let first: Promise<{ blockhash: string; lastValidBlockHeight: number; slot: number }> | null = null;
    let depositP: ReturnType<typeof depositHeld> | null = null;
    let guess: { kind: "pump-curve" | "pumpswap"; read: Promise<SolanaPoolBuyVenue> } | null = null;
    if (opened) {
      first = quiet(blockhashRead(rpcs));
      depositP = quiet(Promise.all([sizesP, noteP]).then(([s, n]) => depositHeld(rpcs, program, pool, s, be32(n.precommitment), wait)));
      const kind = turn!.venues.kind;
      if (kind) guess = { kind, read: quiet(venueOf(kind)) };
    }
    // the reads side by side (card pool-sell-legs-side-by-side), in three rounds, each on both RPCs; a read the sell
    // made earlier in this very attempt, with no wait since (`early`, sellAll's), is taken, never asked again:
    // 1. the Rent sysvar; the pool there, the same on both RPCs (the sizes the deposit is priced on are read again with
    //    its pages, depositHeld, so an earlier sale's deposit landing in between never leaves them apart, review P2-1 of
    //    77055f4e); W's own accounts (wHeld: the token, W's lamports, its volume accounts) under the mint's program; the
    //    note the deposit makes (returnNote; the seed copy for its precommitment zeroed at once); the price reference at
    //    the sale's units
    const [rent, sizes0, tokens, rn, quoted] = await Promise.all([
      rentP,
      sizesP,
      early?.held ?? mintP!.then((p) => wHeld(rpcs, w.address, token, p, wait)),
      noteP,
      // a reference read at other units (sellAll's guess for a lone W's share) is never this sale's: read at its units
      early?.reference?.amount === amount ? early.reference.read : poolSellReference(rpcs, token, amount),
    ]);
    let sizes = sizes0;
    if (tokens.amount < amount) return no("not_funded");
    const lamports = tokens.lamports;
    // W pays the sell's fee before anything runs, and must hold what the sell makes before any proceeds arrive (the
    // kit's solanaPoolSellNeed): short of the cheaper venue's need, no venue can take it, refused before anything is built
    if (lamports < solanaPoolSellNeed({ kind: "pump-curve", cashback: false }, rent)) return no("not_funded");
    const { ref, precommitment, planned } = rn;
    const pre = be32(precommitment);
    if (!quoted) return no("quote_check_failed");
    const { reference, best } = quoted;
    const chose = best.venue as "pump-curve" | "pumpswap";
    if (turn) turn.venues.kind = chose;
    // 2. after the reference (the quote's age counts from it): its venue (a leg after the first: the one read beside its
    //    reference when the reference chose it, else read now), the device's blockhash and slot on RPC 0, and the
    //    lamports the deposit's mark and both pages hold with the pool's sizes (depositHeld); the blockhash's check on
    //    RPC 1 starts as soon as RPC 0 answered and is awaited before W signs
    first ??= blockhashRead(rpcs);
    const valid = first.then((r) => blockhashValid(rpcs, r));
    valid.catch(() => {});
    const [venue, bh0, deposit] = await Promise.all([legVenue(guess, chose, venueOf), first, depositP ?? depositHeld(rpcs, program, pool, sizes, pre, wait)]);
    if (venue.tokenProgram !== tokens.program) return no("failed", "venue_program");
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
      // made by W's buy moments before: one RPC may not show them yet, read again after a wait (agreed)
      const owned = (address: string, owner: string): Promise<boolean> =>
        agreed(
          async () => {
            const [a, b] = (await both(rpcs, (r) => account(r, address, "confirmed"))).map((x) => !("none" in x) && x.owner === owner);
            return a === b ? a! : SPLIT;
          },
          wait,
          "volume_split",
        );
      [has.ammVolume, has.ammVolumeAta] = await Promise.all([owned(vol, SOLANA_PUMP_AMM_PROGRAM), owned(ata, SOLANA_TOKEN_PROGRAM)]);
    }
    const need = solanaPoolSellNeed(venue, rent, has);
    // what the sell makes and keeps at W's cost (those cashback accounts): kept out of the deposit too
    const made = need - solanaPoolSellNeed(venue, rent, { ammVolume: true, ammVolumeAta: true });
    if (lamports < need) return no("not_funded");
    // a wait since the quote was asked (the plan's included, when this sale took the plan's reads): priced again from new
    // reads, nothing built on these
    if (stale || early?.waited?.()) {
      later.reprice = true;
      return { error: "failed" };
    }
    const bh = bh0;
    const quote = { amount, ref: reference, slippageBps: ask.slippageBps };
    let minOut: bigint;
    try {
      minOut = solanaPoolSellMinOut(venue, amount, quote, bh.slot);
    } catch {
      return no("quote_check_failed");
    }
    // the transaction: the venue's sell, then last the deposit of `value` with the note's precommitment, W the payer
    const steps = solanaPoolSellSteps(venue, w.address, amount, minOut);
    // what W holds after the sell, at least: rent(0), the runtime's floor, when the sell empties W's holding; while W
    // keeps any of the token (the amount both RPCs read), what the next sell of it needs up front on every
    // venue the coin can reach, the buy's rule (solanaPoolBuySellNeed: a curve coin's PumpSwap need, cashback accounts
    // included), so no sell leaves tokens on a W that cannot pay to sell them (the re-review of 40cdc3e)
    const keeps = tokens.amount > amount;
    // the lamports the deposit's mark and both pages hold, read on both RPCs with the pool's tree sizes in one call
    // (round 2): the same for either form
    // a partial sell keeps on W the next sell's need; a full sell makes no note (card every-lamport-can-move: W's sweep
    // after the teardown makes the sale's one note, on the grid)
    const after = solanaPoolBuySellNeed(venue, rent);
    // on mainnet a partial sell keeps the next sell's priority on W too, so the rest sells with it
    const keepPriority = keeps && h.cluster === "mainnet" ? SOLANA_POOL_SELL_PRIORITY : 0n;
    const holds = deposit.held;
    sizes = deposit.sizes;
    // mainnet: W's compute budget first (solanaSellBudget), its limit sized once the simulation has read the units, for
    // what W holds beyond the sell's need, at most SOLANA_POOL_SELL_PRIORITY (never a reason to refuse: none, no budget),
    // and only on a form with room for it (solanaSellBudgetFits, the preview's decision too)
    const room = h.cluster === "mainnet" && solanaSellBudgetFits(venue.kind, venue.cashback) ? lamports - need : 0n;
    let budget = solanaSellBudget(null, solanaSellPriority(room));
    const cap = budget === null ? 0n : solanaSellPriority(room);
    // the largest form decides (above); this sell's own six, compiled, never over the size with it either
    if (budget !== null && wireOf(solanaCompileV0(w.address, [...budgetIxs(budget), ...steps, depositIx(program, pool, w.address, sizes, pre, minOut, false)], bh.blockhash, []).message).length > SOLANA_MAX_TX_BYTES) budget = null;
    // the deposit's form: the eight names each tree's next page, so it lands when inserts that land first carry an entry
    // onto that page; the six (as before d3edab1) then fails WrongAccount and is rebuilt from new reads (below). The
    // eight only when the transaction still fits 1,232 bytes with it (a PumpSwap cashback sell with no lookup table
    // does not; the size does not depend on the value), and on a partial sell only when both trees sit within
    // SOLANA_POOL_NEXT_PAGE_WINDOW of their page's end: the reserve prices a next page's opening only there, and a tree
    // further out that more inserts turn would open its next page out of what W keeps for its next sell (review LOW 1)
    const near = (size: number): boolean => SOLANA_POOL_PAGE_ENTRIES - (size % SOLANA_POOL_PAGE_ENTRIES) <= SOLANA_POOL_NEXT_PAGE_WINDOW;
    const fits = wireOf(solanaCompileV0(w.address, [...budgetIxs(budget), ...steps, depositIx(program, pool, w.address, sizes, pre, minOut, true)], bh.blockhash, []).message).length <= SOLANA_MAX_TX_BYTES;
    const eight = fits && (!keeps || (near(sizes.stateSize) && near(sizes.labelSize)));
    // the smallest note the deposit back makes (solanaSellNoteFloor: the pool's piece floor, or the kit's release floor
    // at the rent both RPCs read up to the grid; card sol-sell-deposit-back-floor): under it, no deposit, the sale's
    // lamports stay on W
    const noteFloor = solanaSellNoteFloor(rent);
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: 0n, solana: h.pin, precommitment };
    const build = (next: boolean, value: bigint): { message: Uint8Array; wire: Uint8Array } => {
      const { message } = solanaCompileV0(w.address, [...budgetIxs(budget), ...(value === 0n ? steps : [...steps, depositIx(program, pool, w.address, sizes, pre, value, next)])], bh.blockhash, []);
      return { message, wire: wireOf(message) };
    };
    /** The sell with the deposit in form `next` (the eight, or the six), its reserve priced for that form at fee `fa`,
     *  checked by the sell's rule; refused (thrown) when it cannot go. A value of 0: the venue's sell alone, no deposit:
     *  a full sell (card every-lamport-can-move: its one note is W's sweep after the teardown, every lamport of the sale
     *  in it), or a partial sell's deposit back that would land under noteFloor. Nothing is read, signed or sent here. */
    const form = (next: boolean, fa: bigint): { wire: Uint8Array; value: bigint } => {
      // the need again at the fee this very message is priced at
      if (lamports < need - SOLANA_POOL_SELL_FEE + fa) return no("not_funded");
      const reads = { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize };
      if (!keeps) {
        const { wire } = build(next, 0n);
        checkSolanaSell(wire, ask, ctx, venue, quote, bh.slot, reads, 0n, { full: true, fee: fa, rent });
        return { wire, value: 0n };
      }
      // the rents the deposit takes from W, as the program prices them (review L1): its mark and both pages topped up to
      // their rent at their new length, less what each holds (anyone may send lamports to one), read on both RPCs;
      // the eight priced at the kit's window (an insert landing first can carry an entry onto the next page, which the
      // deposit then opens at W's cost); what it does not spend stays on W for its next sell
      const r = solanaSellReserve({ fee: fa, made, rents: solanaDepositRents(rent, sizes, holds, next), after: after + keepPriority, lamports, minOut, noteFloor });
      if ("refused" in r) return no(r.refused);
      // the eight's deposit back under noteFloor: refused here, so the six, priced exactly, is tried for a note
      if (next && r.value === 0n) return no("quote_check_failed");
      const { reserve, value } = r;
      const { wire } = build(next, value);
      checkSolanaSell(wire, ask, ctx, venue, quote, bh.slot, reads, reserve, { full: false, fee: fa, rent });
      return { wire, value };
    };
    // the fee both RPCs price the form's message at: per signature and the compute budget's priority, so the deposit's
    // value (the one thing the reserve changes) changes nothing it prices
    const feeOf = (next: boolean): Promise<[bigint, bigint]> => both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(build(next, keeps ? minOut : 0n).message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
    // unsigned: an RPC cannot send what it simulates
    const simulate = (wire: Uint8Array) => both(rpcs, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown; logs?: unknown } } | null)?.value);
    // round 3: the wire built at the kit's fee (SOLANA_POOL_SELL_FEE: one signature, no compute budget), its fee read on
    // both RPCs beside both simulations; signed only when both RPCs price it at exactly that fee. A fee both read
    // otherwise: built again at it and simulated again (its fee read again with it), once; two RPCs that differ: failed.
    // The eight first; refused before signing (its reserve, priced at the window, over min out or the cap, or its deposit
    // back under noteFloor), the six priced exactly, so no sell the six carries is refused (review LOW 3) and no note the
    // six can make is left on W
    let next = eight;
    let fee = SOLANA_POOL_SELL_FEE + (budget?.priority ?? 0n);
    let built: { wire: Uint8Array; value: bigint };
    let sized = budget === null;
    for (let moved = 0; ; ) {
      let b: { wire: Uint8Array; value: bigint } | null = null;
      try {
        b = form(next, fee);
      } catch (e) {
        if (!next || !(e instanceof Refused || e instanceof PoolRuleRefused)) throw e;
      }
      if (b === null) {
        next = false;
        continue;
      }
      const [[fa, fb], sims] = await Promise.all([feeOf(next), simulate(b.wire)]);
      if (fa !== fb) return no("failed", "fee_split");
      if (fa !== fee) {
        if (moved++ > 0) return no("failed", "fee_moved");
        fee = fa;
        continue;
      }
      if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) {
        // an earlier leg of this sale still in flight (sent, not yet read back): the chain may not show it yet, so this
        // leg is read and priced again after a wait, up to POOL_SELL_AGREE_WAIT_MS of such waits, then refused
        if (turn?.inFlight?.() && (later.simWaited ?? 0) < POOL_SELL_AGREE_WAIT_MS) {
          later.simWaited = (later.simWaited ?? 0) + POOL_SELL_SIZE_RETRY_MS;
          await wait(POOL_SELL_SIZE_RETRY_MS);
          later.reprice = true;
          return { error: "failed" };
        }
        // the cause names each provider whose simulation refused it and what it said (public data, kept on the device)
        return no("failed", "sim", sims.flatMap((v, k) => (v !== undefined && v !== null && v.err === null ? [] : [`RPC ${k} ${safeDetail(v?.err ?? null)}${simError(v)}`])).join("; "));
      }
      // mainnet: the limit sized from the units both simulations used, then built, priced and simulated again at it
      if (!sized) {
        sized = true;
        const units = sims.map((v) => (v as { unitsConsumed?: unknown }).unitsConsumed);
        const again = solanaSellBudget(units.every((u) => Number.isSafeInteger(u)) ? Math.max(...(units as number[])) : null, cap);
        if (again?.limit !== budget?.limit || again?.price !== budget?.price) {
          budget = again;
          fee = SOLANA_POOL_SELL_FEE + (again?.priority ?? 0n);
          continue;
        }
      }
      built = b;
      break;
    }
    const { wire, value } = built;
    // the blockhash valid on RPC 1 (round 2's check), before W signs
    const bhv = await valid;
    // a sign out asked while this sale was built: nothing signs from here (review P3-5 of 77055f4e)
    if (h.stopped?.()) return no("failed", "stopped");
    // W, from the seed, right before it signs: it must be the W the bytes were built and checked for
    signing = true;
    const fw = freshWallet(await seed(), "sol", w.l, w.j);
    key = fw.secretKey;
    for (const x of seeds) x.fill(0);
    if (fw.address !== w.address) return no("failed", "wallet");
    const sig = signSolana(key, wire);
    key.fill(0);
    key = null;
    const signed = wire.slice();
    signed.set(sig, 1);
    const signature = base58.encode(sig);
    // the form sent, for the page's console: the priority it pays (none: no compute budget) and the deposit's accounts
    if (h.cluster === "mainnet") console.info(`sell form: priority ${budget?.priority ?? 0n}${budget === null ? " (no compute budget)" : ""}, deposit ${value === 0n ? "none" : next ? "eight" : "six"}`);
    // written before the signed transaction leaves the device: the note INCOMING with W's send, so a page closed or
    // reloaded from here on leaves a record its next load settles (settlePoolSells) by the same verdict rules. No
    // deposit back (value 0, under noteFloor): no note, the return note left as it was for the next sell
    const kept = value === 0n;
    const note = kept ? null : await store.move(planned ?? (await store.add({ ref, scope, precommitment, state: "PLANNED" })).id, "PLANNED", "INCOMING", { send: { signature, value, last_valid_block_height: BigInt(bhv.lastHeight) } });
    // no deposit back (review F4 of b38cd8c2): its transaction written before it leaves the device and before the
    // request's record names it (as the note above), so a page closed from here on leaves a record its next load settles
    // (settlePoolSells) by the same verdict; a record with no op is harmless; a write that fails sends nothing
    if (kept) await h.kept?.put({ signature, tx: base64.encode(signed), last: bhv.lastHeight });
    // a full sell owes W's rent back from here: written before the send, so a page closed from here on runs it at its
    // next load (resumeRentBacks); a sell that never lands leaves W holding the token, and that rent back ends "kept"
    // W's record keeps every mint W traded (review 5 of 38e59182, info: a W that fully sells a second mint keeps its
    // first mint's accounts in its rent back)
    const owedRec: OwedRentBack = { address: w.address, l: w.l.toString(), j: w.j, mints: [{ mint: token, program: tokens.program }], passes: 0 };
    // the sale is a send from W into the pool as a rent back's is (review P2-1 of 024e8a89d): it stamps the device's
    // spacing before it goes, W's record keeping the time as its own, so no leftover W's pass sends within the gap after
    // it and the sale's own rent back is W's own last send; the trade itself never waits on the gap
    const saleAt = Number(h.now?.() ?? BigInt(Date.now()));
    if (!keeps) {
      owedRec.spaced = saleAt;
      const prior = await Promise.resolve(h.owed?.list()).then((l) => l?.find((r) => r.address === w.address), () => undefined);
      owedRec.mints = mintsOf(prior?.mints, owedRec.mints);
      // this sell, by its mint: what a balance after it is checked against (card sol-rent-back-dust-burn)
      owedRec.sell = { ...prior?.sell, [token]: { tx: base64.encode(signed), last: bhv.lastHeight } };
      // W's proven buy carried, so it is not read again; what the record's last pass settled on is not: this sale changes
      // W, so the next load's pass reads it (card round-trip-costs-less)
      if (prior?.buy !== undefined) owedRec.buy = prior.buy;
      // a record that cannot be written sends nothing: a sale with none would leave W's SOL to no later pass
      await h.owed?.put(owedRec);
    }
    // the request's record names the signature before it leaves the device (a write that fails sends nothing)
    await h.signed?.(signature);
    // the stamp's write starts here and the send goes at once: a trade never waits on the spacing store, whose IndexedDB
    // open may never answer. The run awaits it, bounded, before it lets go of POOL_TRADE_LOCK (stamped), and that lock
    // holds every leftover pass meanwhile; a write that fails or runs out leaves the last stamp
    later.stamp = Promise.all([later.stamp, (async () => h.owed?.space?.({ at: saleAt, gap: gapDrawn() }))().catch(() => {})]);
    sent = signature;
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    h.sent?.(signature);
    const txs: TxRef[] = [{ chain: "solana", hash: signature }];
    // a full sell filled, with its deposit back or without one: W holds none of the token, so the rent its accounts lock
    // and every lamport it keeps go back, the sell's record with it (what a balance after it is checked against)
    // with what the helper reads W as before it (seenOf), kept on a steady end, so the next load skips a W left as it is
    // a partial sell filled (card partial-sell-pays-all-into-cash): what the venue paid above min out, and anything else
    // W holds above its keep, goes into the pool right after, under W's lock and the sell lock held throughout
    const keep = after + keepPriority;
    const swept: NonNullable<typeof later.back> = (locks) => withHolds(locks, w.address, false, wait, async () => keepSweep(h, { rpcs, program, pool, scope, rent, store, sync, w, keep, wait: (ms) => waitUnless(h.wait, ms, h.signal) }));
    const back: NonNullable<typeof later.back> = (locks) => withHolds(locks, w.address, false, wait, async (hold) => void (await rentBackOwed(h, { rpcs, program, pool, scope, rent, store, sync, w, mints: owedRec.mints, wait, sale: true, ride: true, ...(owedRec.sell ? { sell: owedRec.sell } : {}) }, owedRec, hold, await seenOf(h, w.address, owedRec.mints))));
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
        const v = await keptVerdict(rpcs, { signature, tx: base64.encode(signed), last: bhv.lastHeight });
        if (v === "pending") continue;
        // the request's stage before the record goes: a write that fails throws, answered "sent" below, the record
        // kept for the next load (review P3-1 of 5de2165e)
        await h.settled?.(signature, v);
        await h.kept?.drop(signature).catch(() => {});
        if (v === "filled") later.back = keeps ? swept : back;
        return { stage: v, txs };
      }
      const got = await both(rpcs, (r) => readBackFailure(r, signature, signed)).catch((): { got: "none"; err?: unknown }[] => [{ got: "none" }, { got: "none" }]);
      // this very transaction failed on chain, on both RPCs: the sale and the deposit are one, nothing moved
      const dead = got[0].got === "failed" && got[1].got === "failed";
      // the request's stage before the note leaves INCOMING (a write that fails throws, answered "sent" below, the
      // note settled at the next load), but for a sell built again: the next attempt's record names its own signature
      // the deposit's index, read from the message W signed: the last instruction, when it is the pool's deposit
      const depositAt = depositIndex(signed, program);
      const again = dead && !later.last && got.every((g) => wrongAccount(g.err, depositAt));
      const { end } = await settleSellNote(rpcs, program, scope, sync, store, note, dead, (sig, stage, e) => (again && e === "dropped" ? undefined : h.settled?.(sig, stage)));
      // its deposit (the last instruction) met a page another deposit filled first, and its note is PLANNED again (the
      // settle dropped it, review L-A): built again from new reads
      if (dead && end === "dropped" && got.every((g) => wrongAccount(g.err, depositAt))) later.rebuild = true;
      if (end === "filled") later.back = keeps ? swept : back;
      if (end !== "pending") return { stage: stageOf(end, dead), txs };
      // failed on both, its note's mark on one RPC only: refused; the note settles at the next load or sell
      if (dead) return { stage: "refused", txs };
    }
    return { stage: "sent", txs };
  } catch (e) {
    // past the send nothing is refused: the transaction may land, so the answer is "sent" with its signature, and the
    // note, INCOMING, settles at the next load or sell
    if (sent !== null) return { stage: "sent", txs: [{ chain: "solana", hash: sent }] };
    const cause = legCause(e);
    if (e instanceof Refused) return { error: e.code, cause };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed", cause };
    // both RPCs read a coin this build does not trade (a curve quoted in another mint): by name, nothing built
    if (e instanceof SolanaPoolBuyError && e.code === "venue_not_built") return { error: "venue_not_built", cause };
    // a provider read that still fails after the page's own retry, before W signs: "not now" (card pool-read-down)
    if (!signing && e instanceof SolanaRpcTransportError) {
      later.fault = e;
      return { error: "down", cause };
    }
    return { error: "failed", cause };
  } finally {
    for (const x of seeds) x.fill(0);
    key?.fill(0);
  }
}

/** W's priority fee on a mainnet sell, lamports (card sol-pool-buy-lands-on-mainnet): a sell with none can sit unlanded on
 *  a busy leader while the blockhash dies. W pays it up front from what it holds beyond the sell's need: a mainnet buy
 *  leaves W the sell's need on every venue (solanaPoolBuySellNeed) and what the proof's tip cap held beyond the tip it
 *  paid (1,000,000 less 100,000), and a partial sell keeps it on W for the next. Never a reason to refuse: a W with less
 *  pays that, one with none sends without it, as before (solanaSellPriority); the reserve takes it back out of the sale.
 *  The sell's rule holds it too (rules/pool.ts, where it is defined). */
export { SOLANA_POOL_SELL_PRIORITY };
/** A mainnet sell's compute budget for a priority of at most `cap` lamports: the limit 1.2x the units its simulation used
 *  (the larger of both RPCs'; unread, the runtime's most, SOLANA_POOL_CU_LIMIT_MAX), never under SOLANA_POOL_SELL_CU_MIN,
 *  and the price that makes limit x price `cap` at most (never over SOLANA_CU_PRICE_MAX), with the priority fee the
 *  runtime charges for them (rounded up): `cap` itself at any limit up to 1,000,000, a lamport under it at most past
 *  that. null when it buys no price (a `cap` of 0): the sell goes without a compute budget. */
export function solanaSellBudget(units: number | null, cap: bigint = SOLANA_POOL_SELL_PRIORITY): { limit: number; price: bigint; priority: bigint } | null {
  const sized = units !== null && Number.isSafeInteger(units) && units > 0 ? Math.ceil((units * 6) / 5) : SOLANA_POOL_CU_LIMIT_MAX;
  const limit = Math.min(Math.max(sized, SOLANA_POOL_SELL_CU_MIN), SOLANA_POOL_CU_LIMIT_MAX);
  const fit = cap > 0n ? (cap * 1_000_000n) / BigInt(limit) : 0n;
  const price = fit < SOLANA_CU_PRICE_MAX ? fit : SOLANA_CU_PRICE_MAX;
  return price === 0n ? null : { limit, price, priority: (BigInt(limit) * price + 999_999n) / 1_000_000n };
}
/** A fresh page load: nothing of the load's is kept yet (a test's reload). */
export const forgetPageLoad = (): void => {
};
/** The rent-back transactions this page sent from a W (rentBack's send), so a pass knows whether it sent one. */
let rentBackSends = 0;
/** The priority a mainnet sell from a W holding `room` lamports beyond the sell's need pays, on a form with room for the
 *  compute budget (solanaSellBudgetFits): SOLANA_POOL_SELL_PRIORITY, or all of `room` under it, or none when that buys
 *  no price (solanaSellBudget). The sale pays it (to the lamport at any limit up to 1,000,000) and the preview counts it. */
export function solanaSellPriority(room: bigint): bigint {
  const cap = room <= 0n ? 0n : room < SOLANA_POOL_SELL_PRIORITY ? room : SOLANA_POOL_SELL_PRIORITY;
  return solanaSellBudget(null, cap) === null ? 0n : cap;
}
/** The least compute unit limit a sell's budget asks: at a limit of at least SOLANA_POOL_SELL_PRIORITY's count the price
 *  is under SOLANA_CU_PRICE_MAX, so the priority is the cap the preview counts, not the limit. */
export const SOLANA_POOL_SELL_CU_MIN = Number(SOLANA_POOL_SELL_PRIORITY);
/** Whether a sell on `kind` (a `cashback` coin's or not) has room under 1,232 bytes for the compute budget: its largest
 *  form, the six-account deposit with Token-2022, every account its own, compiled with the budget. The sale and the
 *  preview both decide on it, so You receive counts the priority exactly where the sale pays it. A PumpSwap cashback
 *  coin's sell has none (it compiles to 1,268 bytes with it). */
export function solanaSellBudgetFits(kind: "pump-curve" | "pumpswap", cashback: boolean): boolean {
  const key = (k: number): string => base58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? k : i === 1 ? 0xb5 : 3)));
  const v: SolanaPoolBuyVenue =
    kind === "pump-curve"
      ? { kind, mint: key(1), tokenProgram: SOLANA_TOKEN_2022_PROGRAM, tokenAccountSize: 165, curve: key(2), creator: key(3), feeRecipient: key(4), cashback, buybackFeeRecipients: [key(5)], buybackFeeRecipient: key(5) }
      : { kind, mint: key(1), tokenProgram: SOLANA_TOKEN_2022_PROGRAM, tokenAccountSize: 165, pool: key(2), baseVault: key(3), quoteVault: key(4), coinCreator: key(6), cashback, protocolFeeRecipient: key(7), buybackFeeRecipients: [key(5)], buybackFeeRecipient: key(5) };
  const w = key(8);
  const deposit = { program: key(9), accounts: [key(10), w, key(11), key(12), key(13), SOLANA_SYSTEM_PROGRAM].map((k, i) => ({ key: k, signer: i === 1, writable: i !== 5 })), data: new Uint8Array(1 + 8 + 32) };
  const budget = budgetIxs({ limit: SOLANA_POOL_CU_LIMIT_MAX, price: SOLANA_CU_PRICE_MAX });
  return wireOf(solanaCompileV0(w, [...budget, ...solanaPoolSellSteps(v, w, 1n, 1n), deposit], key(14), []).message).length <= SOLANA_MAX_TX_BYTES;
}
/** The compute budget instruction `tag` with `n` in `width` little-endian bytes. */
const le = (tag: number, n: number | bigint, width: number): Uint8Array => Uint8Array.from([tag, ...Array.from({ length: width }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn))]);
/** One System transfer of `v` lamports from W to the pinned relayer's account (the sweep's rest under the grid, review
 *  P3-1; never the pool's account, which holds no lamport past its books: review P1-1 of 1d3b96d9c). */
const tailTransferIx = (from: string, to: string, v: bigint) => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, v, true);
  return { program: SOLANA_SYSTEM_PROGRAM, accounts: [{ key: from, signer: true, writable: true }, { key: to, signer: false, writable: true }], data };
};
const budgetIxs = (b: { limit: number; price: bigint } | null) =>
  b === null
    ? []
    : [
        { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: le(2, b.limit, 4) },
        { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: le(3, b.price, 8) },
      ];

/**
 * A partial sell's reserve for one deposit form and the deposit's value (review LOW 3): what W lacks, on top of what it
 * holds, to pay the fee, what the sell makes at W's cost (`made`), the deposit's rents for that form (`rents`,
 * solanaDepositRents) and what W must keep after (`after`: the next sell's need); never under 0 (W's surplus stays on
 * W for its next sell). A reserve past the cap is refused not_funded, never shrunk: the rest would be stranded on W, and
 * selling more than the user asked is never the device's call; one at or over the min out, quote_check_failed. The
 * deposit's value is the note min out less the reserve makes on the pool's grid (card every-lamport-can-move: solanaNoteOf,
 * noteOf at SOL_PIECES; the rest under the grid stays on W, which still holds tokens and sells again); under `noteFloor`
 * (solanaSellNoteFloor at the rent read on two RPCs, card sol-sell-deposit-back-floor: a note no release can take
 * whole) it is never built: the value is 0 and the sale's whole min out stays on W. A full sell has no reserve: it makes
 * no note (its sweep does).
 */
export function solanaSellReserve(p: { fee: bigint; made: bigint; rents: bigint; after: bigint; lamports: bigint; minOut: bigint; noteFloor: bigint }): { reserve: bigint; value: bigint } | { refused: "not_funded" | "quote_check_failed" } {
  const short = p.fee + p.made + p.rents + p.after - p.lamports;
  const reserve = short > 0n ? short : 0n;
  if (reserve > SOLANA_POOL_SELL_RESERVE_MAX) return { refused: "not_funded" };
  if (reserve >= p.minOut) return { refused: "quote_check_failed" };
  // the floor is never under the program's least deposit (lib.rs MIN_DEPOSIT), so no deposit the program refuses is built
  if (typeof p.noteFloor !== "bigint" || p.noteFloor < SOLANA_POOL_MIN_DEPOSIT) return { refused: "quote_check_failed" };
  const note = solanaNoteOf(p.minOut - reserve);
  return { reserve, value: note < p.noteFloor ? 0n : note };
}

/** The index of the pool's deposit in the message `wire` carries: its last instruction when that is `program`'s, else -1
 *  (a sell with no deposit back). */
const depositIndex = (wire: Uint8Array, program: string): number => {
  const m = solanaDecodeMessage(wire.subarray(65));
  const last = m.instructions.at(-1);
  return last !== undefined && m.staticKeys[last.programIndex] === program ? m.instructions.length - 1 : -1;
};
/** A transaction error that is the pool program's WrongAccount at instruction `ix`. */
const wrongAccount = (err: unknown, ix: number): boolean => {
  const e = (err as { InstructionError?: unknown } | null | undefined)?.InstructionError;
  return Array.isArray(e) && e[0] === ix && (e[1] as { Custom?: unknown } | null)?.Custom === POOL_WRONG_ACCOUNT;
};

/** The mark a tag 1 deposit on `pre` makes. */
const markAddress = (program: string, pre: Uint8Array): string => solanaProgramAddress([enc.encode("pre"), pre], program);

/** The pool's two tree sizes and the lamports the deposit's mark and the two pages at those sizes hold, in one
 *  getMultipleAccounts call on each RPC (one slot each), the same on both (review P2-1 of 77055f4e: sizes read before an
 *  earlier sale's deposit landed priced pages read after it). Sizes other than the ones asked, the same on both: read
 *  again at them, at once the first time, then POOL_SELL_SIZE_RETRY_MS on each time they move again (an earlier leg's
 *  deposit or anyone's landing between the reads); two RPCs that differ: read again POOL_SELL_SIZE_RETRY_MS on (two RPCs
 *  a slot apart). The waits stop at POOL_SELL_AGREE_WAIT_MS in all, then failed. What it gives back is one read that
 *  both RPCs answer alike, at the sizes that read names: the deposit is priced and its pages named from it alone. */
async function depositHeld(rpcs: Rpcs, program: string, pool: string, sizes: { stateSize: number; labelSize: number }, pre: Uint8Array, wait: (ms: number) => Promise<void>): Promise<{ held: SolanaDepositHeld; sizes: { stateSize: number; labelSize: number } }> {
  let at = sizes;
  for (let moved = 0, waited = 0; ; ) {
    const keys = [pool, solanaPoolPage(program, 0, at.stateSize), solanaPoolPage(program, 1, at.labelSize), markAddress(program, pre)];
    // the pool's balance is never priced (card pool-answer-unknown F5: past 2^53 it is never parsed)
    const [a, b] = await both(rpcs, (r) => accountsRaw(r, keys));
    const [pa, pb] = [a[0], b[0]].map((p) => (p == null ? no("not_allowed") : p.owner !== program ? no("failed", "pool_owner") : sizesOf(p.data)));
    const lam = (x: { lamports: unknown } | null | undefined): bigint | null => (x == null ? null : BigInt(int(x.lamports)));
    const pair = (k: number) => [lam(a[k]), lam(b[k])] as const;
    const held = { state: pair(1), label: pair(2), mark: pair(3) };
    const agree = pa!.stateSize === pb!.stateSize && pa!.labelSize === pb!.labelSize && [held.state, held.label, held.mark].every(([x, y]) => x === y);
    if (agree && pa!.stateSize === at.stateSize && pa!.labelSize === at.labelSize) return { held, sizes: at };
    if (agree) {
      // both RPCs read the trees at other sizes: the pages at those, at once the first time, then after a wait
      at = pa!;
      if (moved++ === 0) continue;
      if (waited >= POOL_SELL_AGREE_WAIT_MS) return no("failed", "sizes_moved");
    } else if (waited >= POOL_SELL_AGREE_WAIT_MS) return no("failed", "sizes_split");
    waited += POOL_SELL_SIZE_RETRY_MS;
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

/** What W's rest (its lamports less the sweep's fee, the deposit's rents and the keep) adds to the user's notes once
 *  moved (card every-lamport-can-move T3; pick (a), 13 Nov): its own sweep's note when that is at the floor or
 *  over; else what a ride adds, floorG(rest - fee): a ride's piece Q (every size of the closed list on the grid, at the
 *  floor or over) reaches W less the relay fee `fee`, so the sweep makes a note of Q + floorG(rest - fee), the same gain
 *  whatever Q the pick takes; else 0 (a stranger's dust, a found W holding little: no tap ever burns more than it brings
 *  back). What W is listed at (its RETURNING row, the balance), never W's lamports or its raw rest; at 0 not listed. */
export function restAdds(rest: bigint, fee: bigint, floor: bigint): bigint {
  const own = solanaSweepOf(rest).value;
  if (own >= floor) return own;
  const lift = rest - fee;
  return lift >= SOL_GRID ? lift - (lift % SOL_GRID) : 0n;
}

/**
 * W's sweep after a partial sell filled (card partial-sell-pays-all-into-cash): the sale's deposit back was signed before
 * the sale landed, so it carries min out less the reserve, and what the venue paid above min out lands on W. Right after
 * the fill, everything W holds above `keep` (the next sell's need, and on mainnet its priority: the sale's own `after`)
 * goes into the pool as W's next return note (returnNote's walk: the sale's note is UNSPENT, so its R second arrival),
 * on the grid, the rest under the grid left on W with the keep (W still holds tokens and sells again; the full sell's
 * sweep takes it then). Under the floor nothing is sent. W's lamports alike on both RPCs, the deposit priced as the
 * program prices it (solanaDepositRents), checked by the rule (checkSolanaKeepSweep, the keep its hold), simulated
 * unsigned on both, signed by W, its note INCOMING before the send, then read to its verdict under the sell lock (the
 * caller holds it throughout), so the next sell of W never meets it landing. Every fault is told and ends the sweep:
 * what it did not move stays on W, W's own, and goes with W's next sell's sweep or its full sell's.
 */
type KeepSweep = { rpcs: Rpcs; program: string; pool: string; scope: bigint; rent: SolanaRent; store: NoteStore; sync: SolanaTreeSync; w: ListedBuyWallet; keep: bigint; wait: (ms: number) => Promise<void> };
async function keepSweep(h: PoolSellHost, x: KeepSweep): Promise<void> {
  const { rpcs, w, rent } = x;
  const tell = (state: RentBackTold["state"], detail: string): void => {
    try {
      h.told?.({ address: w.address, step: "sweep", state, detail });
    } catch {
      // a host that cannot be told changes nothing here
    }
  };
  const seeds: Uint8Array[] = [];
  let key: Uint8Array | null = null;
  try {
    if (h.stopped?.()) return;
    const [a, b] = await both(rpcs, (r) => account(r, w.address, "confirmed"));
    const lam = (v: Awaited<ReturnType<typeof account>>): bigint => ("none" in v ? 0n : BigInt(int(v.lamports)));
    if (lam(a!) !== lam(b!)) return tell("gave_up", "W's lamports differ on the two RPCs: kept on W for its next sale");
    const lamports = lam(a!);
    let sizes = await treeSizes(rpcs, x.program, x.pool, x.wait);
    const s = await h.seed64();
    seeds.push(s);
    let found: Awaited<ReturnType<typeof returnNote>>;
    try {
      found = await returnNote(rpcs, x.program, x.scope, x.store, x.sync, s, w.l, w.j, h.settled);
    } finally {
      s.fill(0);
    }
    const { ref, precommitment, planned } = found;
    const pre = be32(precommitment);
    const deposit = await depositHeld(rpcs, x.program, x.pool, sizes, pre, x.wait);
    sizes = deposit.sizes;
    const rest = lamports - SOLANA_POOL_SELL_FEE - solanaDepositRents(rent, sizes, deposit.held) - x.keep;
    const value = solanaNoteOf(rest);
    const floor = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
    if (value < floor) return tell("floor", `W's ${lamports} over its keep ${x.keep} would make ${rest}, under ${floor}: kept on W for its next sale`);
    const bh = await blockhashOf(rpcs);
    const { message } = solanaCompileV0(w.address, [depositIx(x.program, x.pool, w.address, sizes, pre, value)], bh.blockhash, []);
    const wire = wireOf(message);
    const fees = await both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
    if (fees[0] !== SOLANA_POOL_SELL_FEE || fees[1] !== SOLANA_POOL_SELL_FEE) return tell("gave_up", `the sweep's fee reads ${fees[0]} and ${fees[1]}`);
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: 0n, solana: h.pin, precommitment };
    checkSolanaKeepSweep(wire, ctx, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize }, lamports, rent, deposit.held, x.keep);
    const sims = await both(rpcs, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } } | null)?.value);
    if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) return tell("gave_up", `the sweep simulates ${safeDetail(JSON.stringify(sims.map((v) => v?.err ?? null)))}`);
    if (h.stopped?.()) return;
    const fw = freshWallet(await h.seed64().then((z) => (seeds.push(z), z)), "sol", w.l, w.j);
    key = fw.secretKey;
    for (const z of seeds) z.fill(0);
    if (fw.address !== w.address) return tell("gave_up", "the seed's W is not the W the sweep was built for");
    const sig = signSolana(key, wire);
    key.fill(0);
    key = null;
    const signed = wire.slice();
    signed.set(sig, 1);
    const signature = base58.encode(sig);
    // the note INCOMING with W's send before it leaves the device: a page closed from here on settles it at its next
    // load (settlePoolSells), as every sell's and sweep's note
    const id = planned ?? (await x.store.add({ ref, scope: x.scope, precommitment, state: "PLANNED" })).id;
    const note = await x.store.move(id, "PLANNED", "INCOMING", { send: { signature, value, last_valid_block_height: BigInt(bh.lastHeight) } });
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    h.back?.(signature);
    const reads = h.reads ?? POOL_SELL_READS;
    const clock = (): number => Number(h.now?.() ?? BigInt(Date.now()));
    const sentAt = clock();
    for (let i = 0; i < reads && (i === 0 || clock() - sentAt < POOL_SELL_READS * POOL_SELL_WAIT_MS); i++) {
      if (i > 0) await x.wait(POOL_SELL_WAIT_MS);
      const { end } = await settleSellNote(rpcs, x.program, x.scope, x.sync, x.store, note);
      if (end !== "pending") return tell(end === "filled" ? "sent" : "gave_up", `${signature} ${end}`);
    }
    tell("sent", `${signature} still landing: settled at the next state read`);
  } catch (e) {
    tell("gave_up", faultOf(e));
  } finally {
    for (const z of seeds) z.fill(0);
    key?.fill(0);
  }
}

/** `unproven`: no buy of W's proven this time (no record, or the public seat read W's history otherwise than the
 *  rebuild): the pass holds as with no buy, read again on a later state read ("again") until its POOL_RENT_BACK_
 *  UNPROVEN_PASSES-th pass, then as W's own state ("steady"; card round-trip-costs-less, review of 20ba2481b P2-6). */
type RentBack = { rpcs: Rpcs; program: string; pool: string; scope: bigint; rent: SolanaRent; store: NoteStore; sync: SolanaTreeSync; w: ListedBuyWallet; mints: readonly { mint: string; program: string }[]; wait: (ms: number) => Promise<void>; sell?: Readonly<Record<string, SoldBy>>; buy?: { mint: string; program: string } | null; bare?: true; unproven?: "again" | "steady"; read?: (lamports: bigint) => void; own?: number; sale?: true; ride?: true; unlisted?: () => void; stamped?: (at: number) => void; swept?: (signature: string, value: bigint) => Promise<void> };

/**
 * W's rent back (card sol-buy-rent-back), after a full sell filled or at a later load while it is owed: what W's
 * accounts lock comes back to W, then everything W holds goes into the pool as W's next return note. Runs under W's own
 * lock (backLock) for the whole pass and under the sell lock between its sleeps only (`hold`: it lets the sell lock go
 * for each sleep and takes it again if it is free; a sell that took it ends the pass, "gave_up", W kept for the next
 * load; review 5 of 38e59182, M1: a tap waits for one try at most, never a sleep), never throws, and ends in a RentBackEnd the host is told, as it is told each step's fault: the sell has
 * landed, and whatever this does not finish stays on W, W's own, and owed (resumeRentBacks).
 * Each step up to its send is tried again from its first read on any fault (a provider's throttle, stall, or a slot's
 * lag between the two), after the page's one wait (READ_WAIT: 1 s, doubling to 10 s), POOL_RENT_BACK_TRIES times at
 * most, and the whole rent back, read-backs
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
 *    (tag 1) as the note that makes on the pool's grid (solanaSweepOf, card every-lamport-can-move: the rest under the
 *    grid one System transfer from W to the pinned relayer's account in the same transaction, review P3-1) on the next of W's
 *    return notes (returnNote's walk: the sell's return note, or after a partial sell's deposit its R second
 *    arrivals), checked by the rule (checkSolanaSweep: W ends at exactly that keep, 0 when nothing is owed), simulated
 *    unsigned on both, then signed; a sweep that leaves an owed claim ends "sent", so W stays owed and the next pass
 *    claims it; its note INCOMING with the send before it leaves, then the sell
 *    lock is free (review L6): the settle at the next state read (settlePoolSells) gives its verdict. A rest that makes
 *    no note (under SOL_NOTE_FLOOR on the grid, solanaSweepOf): a pass flagged `ride` (the sale's own, a tap's pass over
 *    the leftover Ws) first releases one spare piece of the pool's notes to W (h.ride, card every-lamport-can-move T3)
 *    and sweeps again; with none, or on a load's own pass, nothing is sent: W keeps its lamports, listed on its record.
 * W's own coin is its one buy's mint, which the buy writes before its send (h.bought): it joins the record's mints, so W
 * holding any unit of it holds the pass and keeps every lamport its sell needs (delta review 7 of 08290868). Any other
 * mint (an airdrop, a stranger's token) never holds the pass back: its account is not among the addresses the plan
 * reads, so it is never burned or closed, its tokens stay W's under the 12 words, and W's SOL is swept as usual (review 6
 * of 13898c19, F2). A W with no proven buy (no record, or a rebuilt record the public seat does not read the same:
 * rentBackOwed) holds: its own coin is never stranded, at worst its rent waits.
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
  // a found W's token accounts: on a pair that answers getTokenAccountsByOwner (card
  // found-wallet-sweep-reads-on-a-pair-that-answers: the page's public seat answers none on mainnet)
  const tokens = h.tokenRpcs ?? rpcs;
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
  // the gap every later leftover pass waits out (RentBackSpacing), drawn afresh, and W's own record of it (`own`); a
  // store that cannot be written leaves the last one
  const stamp = async (v: RentBackSpacing): Promise<void> => {
    try {
      if (!h.owed?.space) return;
      await h.owed.space(v);
      x.stamped?.(v.at);
    } catch {
      // the last stamp stands
    }
  };
  const send = async (signed: Uint8Array, signature: string): Promise<void> => {
    // stamped before the send, so a leftover pass's claim meanwhile never goes seconds after it
    await stamp({ at: clock(), gap: gapDrawn() });
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    rentBackSends++;
    h.back?.(signature);
  };
  // every leftover pass, before its first send and before the sweep's note is written: it takes the device's slot in the
  // store (claim), held while a gap is open that is not W's own last send (`own`), so another tab whose load read the
  // store before this send never sends within the gap; a store that cannot answer holds it. A sale's own rent back
  // (`sale`) claims nothing and is never held: its W's sale is on chain already, so holding it hides nothing and only
  // keeps the user's SOL on W; its sends still stamp the device, so leftover passes wait out a gap after them
  let claimed = false;
  const spaced = async (): Promise<void> => {
    if (claimed || x.sale === true || h.owed?.claim === undefined) return;
    const v = { at: clock(), gap: gapDrawn() };
    if (!(await h.owed.claim(v, x.own).catch(() => false))) throw HELD;
    x.stamped?.(v.at);
    claimed = true;
  };
  // a step up to its send, again from its first read on a fault, each fault told; null: it gave up
  const again = async <T>(step: "teardown" | "sweep", f: () => Promise<T>): Promise<{ ok: T } | null> => {
    for (let i = 0, pause = 0, last: unknown = null; i < POOL_RENT_BACK_TRIES && (i === 0 || clock() < deadline); i++) {
      // a provider's fault doubles the wait on the rule; any other failure waits its first step
      if (i > 0) await wait(waitsOn(last) ? (pause = throttleWaitMs(pause, afterOf(last), READ_WAIT)) : READ_WAIT.firstMs);
      try {
        return { ok: await f() };
      } catch (e) {
        if (e === BUSY || e === HELD) throw e;
        last = e;
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
    if (!x.buy && x.bare !== true) return end("holds", "no buy of W's is recorded", x.unproven !== "again");
    // the accounts the plan reads: W's of each mint it traded and the teardown's own (solanaTeardownAddresses), and on a
    // found W each token account both RPCs list it owning (foundTokenAccounts, `extra`), so a zero-balance one, which
    // anyone can open for W, is closed to W, never a hold for good (review P2 of c7b85ba3a)
    // the accounts whose tokens hold the sweep (keepOf, review P1-2 of 1d3b96d9c): W's account of each of its own coins,
    // the mints its buy record names; on a found W, whose record names none, any (a coin W holds may be its own; the
    // found W's rule, foundPast, holds such a W before this anyway)
    const mine = new Set(x.mints.map((m) => solanaAta(w.address, m.mint, m.program)));
    const ownAccounts = (address: string): boolean => x.bare === true || mine.has(address);
    const addressesOf = (extra: readonly string[]): string[] => [...new Set([...solanaTeardownAddresses(w.address, x.mints), ...extra])];
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
    const readW = async (unclaimed: SolanaTeardownUnclaimed | undefined, extra: readonly string[]) => {
      const addresses = addressesOf(extra);
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
        return { k: "plan" as const, held, accounts, addresses, burn, plan: solanaTeardownPlan(w.address, accounts, unclaimed, burn) };
      } catch (e) {
        // the plan's refusal of reads both RPCs answered alike, byte for byte: the same reads refuse the same way, so it
        // ends the pass (review 5 of 38e59182, M1); reads that differ are a fault, read again
        if (held[0].every((t, i) => sameRead(t, held[1][i] ?? null))) return { k: "refused" as const, why: faultOf(e) };
        throw e;
      }
    };
    // 1. the teardown
    const teardown = await again("teardown", async () => {
      // a found W: nothing is signed for it, a close included, before the found W's rule's time part holds on both RPCs
      // (foundPast: no buy signed before W's latest transaction can still land); `since` is that transaction, the one
      // the sweep then reads W's history from
      // each way short of the rule names why W holds, a read's fault with its provider (card
      // found-wallet-sweep-reads-on-a-pair-that-answers: a refused read held W with no reason given)
      let why = "";
      const since = x.bare === true ? await foundPast(rpcs, w.address).catch((e: unknown) => ((why = `its latest transaction not read on both RPCs (${faultOf(e)})`), null)) : undefined;
      if (since === null) return { young: why || "not yet past its last transaction's blockhash on both RPCs, or the two not reading that transaction alike", keep: [], signed: [], last: 0, unclaimed: undefined, since: undefined };
      const extra = since === undefined ? [] : await foundTokenAccounts(tokens, w.address).catch((e: unknown) => ((why = `its token accounts not read alike on both RPCs (${faultOf(e)})`), null));
      if (extra === null) return { young: why, keep: [], signed: [], last: 0, unclaimed: undefined, since: undefined };
      const read = await readW(undefined, extra);
      // W still holds what it sold: its sell has not filled, so its volume and wrapped-SOL accounts are what that sell
      // (or its next) still uses; nothing is closed
      if (read.k === "holds") return { holds: read.steady, keep: [], signed: [], last: 0, unclaimed: undefined, since };
      if (read.k === "refused") return { refused: read.why, keep: [], signed: [], last: 0, unclaimed: undefined, since };
      const { held, accounts, addresses, plan } = read;
      // what W holds as both RPCs read it, its buy proven or, a found W, the found W's rule's time part passed on both
      // (`since`; review P2-4b of 024e8a89d): the size the page shows it returning (returningWallets); the sweep's read
      // below follows the closes. A found W still young carries none
      const [la, lb] = held.map((v) => v[0]?.lamports ?? 0n);
      if ((x.buy || since !== undefined) && la === lb) x.read?.(la!);
      if (plan.close.length === 0) return { keep: plan.keep, signed: [], last: 0, unclaimed: undefined, since };
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
      const signed = await signAll(t.wires);
      // a found W's latest transaction read again on both RPCs: one landed since the rule's read drops the closes
      if (since !== undefined && (await latestOf(rpcs, w.address).catch(() => null)) !== since) return { young: "a transaction landed on W since the rule's read", keep: [], signed: [], last: 0, unclaimed: undefined, since: undefined };
      return { keep: t.plan.keep, signed, last: bh.lastHeight, unclaimed: t.reads.unclaimed, since };
    });
    if (teardown === null) return end("gave_up", "the teardown");
    if (teardown.ok.young !== undefined) return end("holds", `a found W: ${teardown.ok.young}`, false);
    if (teardown.ok.holds !== undefined) return end("holds", teardown.ok.holds ? "W holds a token it traded: no full sell of it landed" : "W holds a token it traded: its sell not final yet", teardown.ok.holds);
    if (teardown.ok.refused !== undefined) return end("refused", teardown.ok.refused);
    if (teardown.ok.signed.length > 0) await spaced();
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
    if (keepOf(teardown.ok.keep, ownAccounts) === null) return end(teardown.ok.unclaimed === undefined ? "kept" : "owed", teardown.ok.keep.map((k) => `${k.address}: ${k.why}`).join("; "));
    // 2. the sweep
    const unclaimed = teardown.ok.unclaimed;
    // a found W: the rule's transaction, and the teardown's own frames, the only transactions W may show after it
    const since = teardown.ok.since;
    const own = new Set(teardown.ok.signed.map((f) => f.signature));
    const floor = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
    // `rode`: the sale's ride came first (card every-lamport-can-move T3), so a rest still under the floor ends there
    const sweepTry = (rode: boolean) => again("sweep", async () => {
      // W and its accounts read again, after the frames (review M-A: a frame that failed on chain, a token sent to W's
      // account meanwhile, leaves an account open): the sweep only when the plan now closes nothing and keeps nothing,
      // so W keeps the fee for what is still open; a claim the teardown planned around stays planned around (card
      // sol-w-sweep: it is the next pass's to try again, from the claim's cost the sweep leaves on W)
      let why = "";
      const extra = since === undefined ? [] : await foundTokenAccounts(tokens, w.address).catch((e: unknown) => ((why = faultOf(e)), null));
      if (extra === null) return { end: "holds" as const, steady: false, detail: `a found W: its token accounts not read alike on both RPCs (${why})` };
      const now = await readW(unclaimed, extra);
      if (now.k === "holds") return { end: "kept" as const, steady: now.steady, detail: "W holds a token it traded" };
      if (now.k === "refused") return { end: "refused" as const, detail: now.why };
      const keep = keepOf(now.plan.keep, ownAccounts);
      if (keep === null) return { end: "kept" as const, detail: now.plan.keep.map((k) => `${k.address}: ${k.why}`).join("; ") };
      // review P2-1 of T1+T2: a kept account counts as an owed claim counts, its cost to close later left on W
      const { owed, kept } = keep;
      if (now.plan.close.length > 0) return { end: "gave_up" as const, detail: `still open after the teardown: ${now.plan.close.map((c) => c.address).join(", ")}` };
      const [a, b] = now.held.map((v) => v[0]?.lamports ?? 0n);
      if (a !== b) throw new Error("W's lamports differ on the two RPCs");
      const lamports = a!;
      // what W holds as both RPCs read it, its buy proven or the found W's time part passed: the size the page shows it
      // returning (returningWallets)
      if (x.buy || since !== undefined) x.read?.(lamports);
      // W at 0 with a claim still owed is owed, never dropped (review 5 of 38e59182, info)
      // (and W at 0 with an account kept: the record stays, so a later pass closes it, review P2-1 of T1+T2)
      if (lamports === 0n) return { end: owed + kept > 0 ? ("owed" as const) : ("nothing" as const), detail: owed > 0 ? `W holds nothing, owed ${owed} cashback claim${owed > 1 ? "s" : ""}` : kept > 0 ? `W holds nothing, ${kept} account${kept > 1 ? "s" : ""} kept` : "W holds nothing" };
      // a found W (no buy recorded, card buy-spends-several-pieces): swept only on the found W's rule, its time part read
      // before the teardown and the rest here, in the pass that reads the lamports the sweep signs for (foundSince);
      // short of it W holds, not as its own state, so every later pass reads it again
      const rule = since === undefined ? true : await foundSince(tokens, rpcs, w.address, since, own).catch((e: unknown) => faultOf(e));
      if (rule !== true) return { end: "holds" as const, steady: false, detail: `a found W: ${rule === false ? "owning a token account, or a transaction on W since the rule's read, on either RPC" : `its token accounts or history since the rule's read not read on both RPCs (${rule})`}` };
      // the gate; the sizes the sweep is priced on are read again with its pages (depositHeld, review P2-1 of 77055f4e)
      let sizes = await treeSizes(rpcs, x.program, x.pool, wait);
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
      const deposit = await depositHeld(rpcs, x.program, x.pool, sizes, pre, wait);
      const held = deposit.held;
      sizes = deposit.sizes;
      // what W holds past the sweep's signature fee, the deposit's rents and the owed claims' keep
      const rest = lamports - SOLANA_POOL_SELL_FEE - solanaDepositRents(rent, sizes, held) - solanaSweepKeep(rent, owed, kept);
      // under the floor: steady (its `seen` kept) only when W stays under it at the cheapest deposit, both pages already
      // open, so a page another deposit opens meanwhile runs the pass again (review 5 of 38e59182, L3)
      const cheapRest = lamports - SOLANA_POOL_SELL_FEE - solanaDepositRents(rent, sizes, { ...held, state: [OPEN, OPEN], label: [OPEN, OPEN] }) - solanaSweepKeep(rent, owed, kept);
      // the note on the pool's grid (card every-lamport-can-move: never an exact lamport amount, whose rest would
      // reappear in a later release and tie it to this sale), and the rest under the grid paid to the pinned relayer's
      // account in the same transaction (review P3-1 of T1+T2), so W still ends at the keep (0 when nothing is kept); 0 under
      // the floor
      const { value, under } = solanaSweepOf(rest);
      const cheapest = solanaSweepOf(cheapRest).value;
      // a pass that carries the ride (`ride`: a full sale's own rent back, or a tap's pass over the leftover Ws, never a
      // load's own pass) with no claim owed: one spare piece of the pool's notes released to W first (h.ride), so W's
      // rest reaches a note and W ends at 0 (card every-lamport-can-move T3)
      // under the floor W is listed at what it adds once moved (restAdds, pick (a)), never its lamports or its raw
      // rest, a claim owed or not (the fee, the deposit's rents and the keep are not on their way); a rest that adds
      // nothing is not listed (no RETURNING row, nothing in the balance) and never rides
      const adds = restAdds(rest, solanaPoolFee(rent), floor);
      if (value < floor && adds === 0n) x.unlisted?.();
      if (value < floor && adds > 0n && (x.buy || since !== undefined)) x.read?.(adds);
      if (value < floor && owed === 0 && adds > 0n && x.ride === true && !rode && h.ride !== undefined) return { end: "ride" as const, rest, lamports, steady: cheapest < floor };
      if (value < floor) return { end: owed > 0 ? ("owed" as const) : ("floor" as const), steady: cheapest < floor, detail: `W's ${lamports} would leave ${rest} for a note, under ${floor}: kept on W${owed > 0 ? `, owed ${owed} cashback claim${owed > 1 ? "s" : ""}` : ""}` };
      const bh = await blockhashOf(rpcs);
      // the deposit, then the rest under the grid as one System transfer to the pinned relayer's account, the relay fee's
      // own payee every release names (none at a rest of 0; review P1-1 of 1d3b96d9c: the pool's account would hold it
      // past its books for good); no compute budget, so a sweep that fails on chain costs W its one signature
      const pay = under === 0n ? [] : [tailTransferIx(w.address, ctx.solana.feePayer, under)];
      const { message } = solanaCompileV0(w.address, [depositIx(x.program, x.pool, w.address, sizes, pre, value), ...pay], bh.blockhash, []);
      const wire = wireOf(message);
      // the one signature's fee, as both RPCs price this very message: anything else would leave W short or holding some
      const fees = await both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
      if (fees[0] !== SOLANA_POOL_SELL_FEE || fees[1] !== SOLANA_POOL_SELL_FEE) throw new Error(`the sweep's fee reads ${fees[0]} and ${fees[1]}`);
      checkSolanaSweep(wire, { ...ctx, precommitment }, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize }, lamports, rent, held, owed, kept);
      const sims = await both(rpcs, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } } | null)?.value);
      // a simulation that fails on either RPC (one a slot behind, a page another deposit just filled): read again
      if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) throw new Error(`the sweep simulates ${JSON.stringify(sims.map((v) => v?.err ?? null))}`);
      const [one] = await signAll([wire]);
      // a found W's history since the rule's read again on both RPCs: any transaction but the teardown's drops the sweep
      if (since !== undefined && !(await onlyOwnSince(rpcs, w.address, since, own).catch(() => false))) return { end: "holds" as const, steady: false, detail: "a found W: a transaction landed on W after the rule's read" };
      return { end: "sent" as const, ref, precommitment, planned, value, one: one!, last: bh.lastHeight };
    });
    let sweep = await sweepTry(false);
    if (sweep !== null && sweep.ok.end === "ride") {
      const { rest, lamports, steady } = sweep.ok;
      // what W gets lifts the rest, priced as this try priced the sweep, to a note on the grid at the floor or over (the
      // gain itself is restAdds', which let this ride run)
      const fits = (got: bigint): boolean => solanaSweepOf(rest + got).value >= floor;
      // a leftover pass's spacing claimed before the release, so a pass the gap holds moves nothing to W
      await spaced();
      const rode = await h.ride!({ address: w.address, l: w.l, j: w.j }, fits).catch((e: unknown) => ({ state: "fault" as const, why: faultOf(e) }));
      if (rode.state === "none") return end("floor", `W's ${lamports} would leave ${rest} for a note, under ${floor}: kept on W; no spare piece in the pool lifts it`, steady);
      if (rode.state !== "landed") return end("gave_up", rode.state === "fault" ? `the ride: ${rode.why}` : rode.state === "unsure" ? "the ride's release may still land: W waits for the next load" : "the ride's release did not land: W keeps its lamports");
      sweep = await sweepTry(true);
    }
    if (sweep === null) return end("gave_up", "the sweep");
    const sw = sweep.ok;
    if (sw.end === "ride") return end("gave_up", "the sweep");
    if (sw.end !== "sent") return "steady" in sw && sw.steady !== undefined ? end(sw.end, sw.detail, (sw.end === "floor" || sw.end === "kept") && sw.steady) : end(sw.end, sw.detail);
    // held (resumeRentBacks' spacing): before the note is written or anything sent
    await spaced();
    const id = sw.planned ?? (await x.store.add({ ref: sw.ref, scope: x.scope, precommitment: sw.precommitment, state: "PLANNED" })).id;
    await x.store.move(id, "PLANNED", "INCOMING", { send: { signature: sw.one.signature, value: sw.value, last_valid_block_height: BigInt(sw.last) } });
    // W's record names the sweep before its send, as the note does (review P3-10 of 024e8a89d): a page closed during the
    // send leaves both, so the next load counts W's SOL once, as the note; a record not written sends nothing
    await x.swept?.(sw.one.signature, sw.value);
    await send(sw.one.signed, sw.one.signature);
    return end("sent", sw.one.signature);
  } catch (e) {
    // the sell has landed; what is not closed or swept stays on W, owed, and its note, if sent, settles at the next read
    return end("gave_up", e === BUSY ? "a sell took the sell lock between tries: W waits for the next load" : e === HELD ? "spaced: another of the device's Ws closed or swept within the gap, or this load's one did: W waits" : faultOf(e));
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
 * W's kept accounts as the sweep counts them: `owed`, the volume accounts owed only cashback a claim could not take this
 * time (the kit's plan marks them `cashback`), and `kept`, every other one (incentives owed, volume not yet settled, a
 * close authority outside W, a frozen or confidential account, a burn the token blocks, the USDC account that takes
 * stable cashback, tokens on any account but W's own coins'): the sweep leaves what claiming or closing them later
 * costs (solanaSweepKeep) and carries the rest (card every-lamport-can-move, review P2-1 of T1+T2). null, W keeping
 * everything, when one of W's own coins' accounts (`own`: W's account of each mint its buy record names, x.mints; on a
 * found W any token account) holds tokens W could still sell (`tokens`: selling them needs W's SOL), or more claims are owed than the rule bounds. Tokens
 * on any other account hold nothing (review P1-2 of 1d3b96d9c: W's address is public, so a stranger's unit of USDC in
 * W's USDC account, which every rent back reads, would otherwise keep a whole sale on W for good).
 */
export function keepOf(keep: readonly { address: string; cashback?: true; tokens?: true }[], own: (address: string) => boolean): { owed: number; kept: number } | null {
  const owed = keep.filter((k) => k.cashback === true).length;
  if (owed > SOLANA_SWEEP_OWED_MAX || keep.some((k) => k.tokens === true && own(k.address))) return null;
  return { owed, kept: keep.length - owed };
}

/** One W's buy evidence on this device, read from the store and never from a provider: its own buy record (written by
 *  this device's buy before its send), a record the restore's rebuild wrote (`rebuilt`: one provider's word), or the
 *  rebuild's "read, no buy" mark (h.buyNone). */
type Evidence = { rec: { mint: string; program: string; rebuilt?: unknown } | undefined; none: boolean };
async function evidenceOf(h: PoolSellHost, address: string): Promise<Evidence> {
  const rec = (await Promise.resolve(h.bought?.get(address)).catch(() => undefined)) as Evidence["rec"];
  const none = rec === undefined && (await Promise.resolve(h.buyNone?.(address)).catch(() => false)) === true;
  return { rec, none };
}
const evidenceKey = (e: Evidence): string => (e.rec ? `${e.rec.mint}:${e.rec.program}:${e.rec.rebuilt === true ? "rebuilt" : "own"}` : e.none ? "none" : "-");

/** The most addresses one getMultipleAccounts names (agave MAX_MULTIPLE_ACCOUNTS, the wallet's SOL_MARK_READ_BATCH_MAX):
 *  the rent backs' finding read, on the helper's seat. */
const FIND_BATCH = 100;
/** Between two Ws' passes, each the only W its public-seat requests name: this, and up to as much again at random, so no
 *  two of the account's Ws are read back to back (review of 20ba2481b, P1-2). */
export const POOL_RENT_BACK_GAP_MS = 1_000;
/** A W whose coin no buy proves holds, read again on each load until this many passes, then as its own state: re-armed
 *  when the helper reads it otherwise or its buy evidence changes (review of 20ba2481b, P2-6). */
export const POOL_RENT_BACK_UNPROVEN_PASSES = 3;

type Findable = { address: string; mints: readonly { mint: string; program: string }[]; evidence: Evidence };
/** What the rent backs read of the account's Ws, on the second seat alone (h.rpcs[1]: the helper's keyed route on
 *  mainnet, its devnet route on devnet), never the public one, as main's pool-found.ts reads by its written rule. The
 *  Ws it names: every W of the account (each owed record here, and every W derived from the pool's spent notes that
 *  has no record and is not listed empty), W's own and teardown addresses for each, with the Rent sysvar, in
 *  getMultipleAccounts calls of FIND_BATCH addresses: the helper, and the provider upstream of it, see that set of Ws
 *  as one request (up to FIND_BATCH addresses a request). Per W: whether any of them is an account, `seen`, what W
 *  reads as there (their bytes, the rent, the rules' version, W's buy evidence), and W's own lamports (a held W's
 *  RETURNING row, display only). It is the helper's alone: a helper that lies can hide a W (read empty, or as it read
 *  before: no pass), show a held W's amount wrong, or run a pass for nothing (its reads then on both seats, one W a
 *  request), never move one. Nothing is signed on it. */
async function findOn(rpc: SolanaRpc, ws: readonly Findable[]): Promise<Map<string, { any: boolean; seen: string; lamports: bigint | undefined }>> {
  const per = ws.map((w) => {
    try {
      return [w.address, ...solanaTeardownAddresses(w.address, w.mints)];
    } catch {
      // a mint of a program the plan refuses: W's own address alone
      return [w.address];
    }
  });
  const all = [SOLANA_RENT_SYSVAR, ...per.flat()];
  const got: ({ owner: string; lamports: unknown; data: Uint8Array } | null)[] = [];
  for (let i = 0; i < all.length; i += FIND_BATCH) got.push(...(await accountsRaw(rpc, all.slice(i, i + FIND_BATCH))));
  const text = (t: (typeof got)[number]): string => (t === null ? "-" : `${t.owner}:${String(t.lamports)}:${base64.encode(t.data)}`);
  const rent = text(got[0] ?? null);
  let at = 1;
  return new Map(
    ws.map((w, k) => {
      const reads = got.slice(at, at + per[k]!.length);
      at += per[k]!.length;
      const own = reads[0]?.lamports;
      return [w.address, { any: reads.some((t) => t !== null), seen: base64.encode(keccak_256(enc.encode(`${reads.map(text).join("|")}#${rent}#${POOL_RENT_BACK_RULES}#${evidenceKey(w.evidence)}`))), lamports: reads[0] === null ? 0n : typeof own === "number" && Number.isSafeInteger(own) && own >= 0 ? BigInt(own) : typeof own === "bigint" && own >= 0n ? own : undefined }] as const;
    }),
  );
}

/** W's buy, as the public seat alone reads W's own transactions at finalized (the restore's reader, buy-wallets.ts
 *  solanaBuyReader: W signs it, the pinned pool's tag 3 names W, one mint rises in W's account), checked against what the
 *  restore's rebuild already read on the helper's route (review of 20ba2481b, P1-2: that read kept, not made twice):
 *  `claimed`, the rebuilt record's coin, or null for its "no buy" mark. The claim when the public seat reads the same;
 *  "differs" when it plainly reads otherwise (another coin, a buy where the mark says none, none where the record names
 *  one); undefined when it gives no answer (a fault, a read that cannot tell): no proof this time, and no count either
 *  (review of T1+T2, P1: a throttled seat never marks W held for good). Its requests name W alone. */
async function provenBuy(rpc: SolanaRpc, program: string, address: string, claimed: SolanaBuy | null): Promise<SolanaBuy | null | "differs" | undefined> {
  let a: SolanaBuy | "none" | null;
  try {
    a = await solanaBuyReader(rpc, program).read(address);
  } catch {
    // a provider's fault: no answer
    return undefined;
  }
  if (a === null) return undefined;
  if (claimed === null) return a === "none" ? null : "differs";
  if (a !== "none" && a.mint === claimed.mint && a.program === claimed.program) return { mint: a.mint, program: a.program };
  return "differs";
}

/** A rent back, then its owed record, with `seen` (what the helper read W as before the pass, findOn) kept when the pass
 *  ends on W's own state. True when a later state read should try W again (card round-trip-costs-less): its pass gave
 *  up, sent a sweep whose verdict comes later, kept a claim owed, or W's buy is not proven yet (POOL_RENT_BACK_UNPROVEN_
 *  PASSES); false when it ended on what W holds (under the floor, holding, an account kept, empty), which only W's own
 *  change moves. */
async function rentBackOwed(h: PoolSellHost, given: RentBack, o: OwedRentBack, hold?: Hold, seen?: string): Promise<boolean> {
  // W's buy mint joins the mints the pass reads (delta review 7 of 08290868): W holding any of it holds the pass, its
  // account closed with the rest once empty. This device's buy record names W's own coin; a record the restore rebuilt
  // (sol-buy-records.ts, `rebuilt`: the helper's word, review of 42a99f81, P1) or the rebuild's "no buy" mark only once
  // the public seat reads W's history the same (provenBuy), kept on W's record so it is read once. With neither, no
  // provider is asked: the pass holds, W's lamports kept on W under the 12 words, until the rebuild writes its record
  const ev = await evidenceOf(h, given.w.address);
  let buy: SolanaBuy | undefined = ev.rec && ev.rec.rebuilt !== true ? { mint: ev.rec.mint, program: ev.rec.program } : undefined;
  let proven = o.buy;
  // the reads that plainly disagreed so far (`differs`), this pass's among them: only they count toward the passes (with
  // no evidence at all no read is made, and each pass counts, as before)
  let differs = o.differs ?? 0;
  if (buy === undefined && proven === undefined && (ev.rec !== undefined || ev.none)) {
    const p = await provenBuy(given.rpcs[0], given.program, given.w.address, ev.rec ? { mint: ev.rec.mint, program: ev.rec.program } : null);
    if (p === "differs") differs++;
    else proven = p;
  }
  if (buy === undefined && proven) buy = proven;
  // no proof: held, read again on each load to its third pass, then as W's own state. W's note paid a plain release with
  // no buy (proven null): held as W's own state at once, its record kept and never listed empty, so a W holding more than
  // its rent with no proven buy is never dropped (review of 20ba2481b, P2-6: a buy in several pieces can leave released
  // SOL on a W whose buy never landed; that card's own record sweeps it)
  // a W found holding SOL with no buy recorded (o.found, card buy-spends-several-pieces): the pass runs, and its sweep is
  // built only on the found W's rule (foundPast before its teardown, foundSince in its sweep); its reads name token
  // accounts the finding read does not, so no `seen` of it is kept and every load passes it
  const unproven = buy === undefined && proven === undefined && o.found !== true ? ((ev.rec === undefined && !ev.none ? o.passes + 1 : differs) >= POOL_RENT_BACK_UNPROVEN_PASSES ? ("steady" as const) : ("again" as const)) : undefined;
  const x: RentBack = buy ? { ...given, mints: mintsOf(given.mints, [buy]), buy } : { ...given, buy: null, ...(o.found === true ? { bare: true as const } : unproven ? { unproven } : {}) };
  let lamports: bigint | undefined;
  let unlisted = false;
  let spaced: number | undefined;
  let sweep: string | undefined;
  const r = await rentBack(h, { ...x, ...(o.spaced === undefined ? {} : { own: o.spaced }), read: (v) => ((lamports = v), (unlisted = false)), unlisted: () => ((lamports = undefined), (unlisted = true)), stamped: (at) => (spaced = at), swept: async (s, v) => {
    sweep = s;
    // what reaches the pool: the sweep's note value (a found W's sweep is built only past its rule)
    if (x.buy || x.bare === true) lamports = v;
    const now = (await h.owed!.list()).find((r) => r.address === o.address) ?? o;
    await h.owed!.put({ ...now, sweep: s, ...(lamports === undefined ? {} : { lamports: lamports.toString() }) });
  } }, hold);
  await owedAfter(h, o, r.end, r.steady && x.bare !== true ? seen : undefined, { ...(differs === (o.differs ?? 0) ? {} : { differs }), ...(proven === undefined ? {} : { buy: proven }), ...(lamports === undefined ? {} : { lamports }), ...(unlisted ? { unlisted: true as const } : {}), ...(spaced === undefined ? {} : { spaced }), ...(sweep === undefined ? {} : { sweep }) });
  return r.end === "gave_up" || r.end === "sent" || r.end === "owed" || unproven === "again";
}

/** What the helper reads one W as (findOn) before its pass: a sale's own rent back keeps it on a steady end. */
async function seenOf(h: PoolSellHost, address: string, mints: readonly { mint: string; program: string }[]): Promise<string | undefined> {
  const evidence = await evidenceOf(h, address);
  const m = evidence.rec ? mintsOf(mints, [{ mint: evidence.rec.mint, program: evidence.rec.program }]) : [...mints];
  return (await findOn(h.rpcs[1], [{ address, mints: m, evidence }]).catch(() => undefined))?.get(address)?.seen;
}

/** The owed record after a pass that ended `e` (review of c1fd2d20, 2a: no lamport on W goes untracked): dropped only
 *  once both RPCs read W empty ("nothing"), W then listed empty so no load reads it again; every other end keeps it with
 *  one pass more (a pass bound dropped Ws whose passes faulted, both RPCs down, and one reader's word that W holds a
 *  token dropped it too), with what the helper read W as when the pass ended on W's own state (under the floor, holding,
 *  an account kept), so a load whose read of W is the same skips it, and W's proven buy. */
export async function owedAfter(h: PoolSellHost, o: OwedRentBack, e: RentBackEnd, seen?: string, kept: { buy?: SolanaBuy | null; lamports?: bigint; spaced?: number; sweep?: string; differs?: number; unlisted?: true } = {}): Promise<void> {
  try {
    // W's tail (WTail): written at the floor with what W adds once moved; gone once W reads empty or its sweep is sent
    if (e === "floor" && kept.unlisted !== true && kept.lamports !== undefined && kept.lamports > 0n) await Promise.resolve(h.owed?.tail?.({ chain: "sol", address: o.address, l: o.l, j: o.j, amount: kept.lamports.toString() })).catch(() => {});
    else if (e === "nothing" || e === "sent" || (e === "floor" && kept.unlisted === true)) await Promise.resolve(h.owed?.untail?.(o.address)).catch(() => {});
    if (e === "nothing") {
      await Promise.resolve(h.owed?.markEmpty?.(o.address)).catch(() => {});
      return await h.owed?.drop(o.address);
    }
    // the record as it is now (a sell meanwhile may have written W's again, with another mint), its mints kept; a
    // record written before review of 20ba2481b may carry `left`, no longer kept
    const now = (await h.owed?.list())?.find((r) => r.address === o.address) ?? o;
    const { seen: _last, left: _left, lamports: last, sweep: lastSweep, spaced: lastSpaced, floor: _floor, ...rest } = now as OwedRentBack & { left?: string };
    // what W holds (returningWallets): this pass's read, else the last, kept once its sweep is sent with the sweep's
    // signature: listed until the note it wrote is counted (never twice); a later read of W stands on its own
    // a pass that ended at the floor carries this pass's read alone (13 Nov 09:31Z: a leftover is counted in the
    // balance): W's lamports as both RPCs read them, listed until a ride sweeps them (card every-lamport-can-move T3);
    // `floor` marks the end, so a tap's ride passes W again while its `seen` holds every load's pass off
    // and a pass whose rest adds nothing once moved (restAdds, pick (a)) carries none, on any end
    const lamports = kept.unlisted === true ? undefined : e === "floor" ? kept.lamports?.toString() : kept.lamports !== undefined ? kept.lamports.toString() : last;
    // a later pass that gave up keeps the sweep's signature (review P3-10 of 024e8a89d): its read may be W from before
    // the sweep landed, so dropping it would count W's SOL beside the note
    const sweep = e === "sent" ? kept.sweep : kept.lamports !== undefined && e !== "gave_up" ? undefined : lastSweep;
    const spaced = kept.spaced ?? lastSpaced;
    await h.owed?.put({ ...rest, mints: mintsOf(now.mints, o.mints), passes: now.passes + 1, ...(seen !== undefined && (e === "floor" || e === "holds" || e === "kept" || e === "refused") ? { seen } : {}), ...(kept.buy === undefined ? {} : { buy: kept.buy }), ...(kept.differs === undefined ? {} : { differs: kept.differs }), ...(lamports === undefined ? {} : { lamports }), ...(sweep === undefined ? {} : { sweep }), ...(spaced === undefined ? {} : { spaced }), ...(e === "floor" ? { floor: true as const } : {}) });
  } catch {
    // an owed record that cannot be written: the rent back runs again only while one is stored
  }
}

/** A held W's amount for its RETURNING row (review P2-4b and P2-6 of 024e8a89d), from the helper's find read, found or
 *  bought: none for a W whose last pass ended at the floor (its `seen` kept with no amount: no pass moves it while W
 *  stays as it is), or a W this device has its own buy record for and no owed record (the buy's own W: shown as the
 *  buy, never beside it). A found W mid a buy in several pieces on another device shows its SOL here until that buy
 *  lands. */
function heldListing(o: OwedRentBack, account: boolean, evidence: Evidence | undefined, lamports: bigint | undefined): bigint | undefined {
  if (lamports === undefined) return undefined;
  if (o.seen !== undefined && o.lamports === undefined) return undefined;
  if (account && evidence?.rec !== undefined && evidence.rec.rebuilt !== true) return undefined;
  return lamports;
}

/** What a rent back's list asks the page's wallets for (h.wallets): no W read, so the positions' passes are not held for
 *  it (review of 20ba2481b, P3-8; the host holds them, h.preempt, only while a W is to be read). */
export const READS_NONE = (): boolean => false;

/**
 * The rent backs owed (a page closed, a provider down past the bound, a sweep not yet confirmed), run again, after the
 * sells settle, under the seed's shared lock (the caller's), one W at a time, in an order drawn at random each load: each
 * W under its own lock (backLock, skipped when another pass holds it) and the sell lock between the pass's sleeps
 * (withHolds); the list stops at the first W the sell lock is taken for (a sell runs) and the rest wait for the next run.
 * Card round-trip-costs-less: the list is also every W of the account's own (h.wallets: derived from the pool's spent
 * notes, no read) with no record here and not listed empty (OwedRentBacks.empty), so a W bought or sold in another
 * browser of the account is finished by any of them.
 * What it reads (review of 20ba2481b, P1-2, P2-4): first every listed W on the helper's seat alone, batched (findOn).
 * A record whose last pass ended on W's own state and that the helper reads the same (`seen`) is settled: no read of it
 * on the public seat, no pass. A W of the account's with no record that the helper reads empty is listed empty. Every
 * other W gets its pass, the public seat's requests naming it alone, the Ws apart by POOL_RENT_BACK_GAP_MS or more; with
 * no answer from the helper, only the records not settled at their last pass. Its own buy proof is one more read on the
 * public seat, once (provenBuy).
 * True when a W's pass is to be tried again (rentBackOwed: a fault, a sweep sent, a claim owed, its buy not proven yet),
 * the helper's read failed, or the list stopped for a sell: the caller runs it again later, on its backoff
 * (pool-testnet.ts); false when nothing is left to try before W itself changes (read again at the next load).
 */
export async function resumeRentBacks(h: PoolSellHost, locks: Locks | null = globalThis.navigator?.locks ?? null, opts: { ride?: true; held?: () => void } = {}): Promise<boolean> {
  if (!locks || !h.owed) return false;
  const owed = await h.owed.list();
  const program = h.pin.program;
  const { pool, scope } = solanaPoolOf(program);
  const rpcs = h.rpcs;
  const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  // the account's own Ws, derived with nothing read; those listed empty, read under these rules already
  let wallets: readonly ListedBuyWallet[] | null = null;
  let fault: unknown = null;
  try {
    wallets = await h.wallets(READS_NONE);
  } catch (e) {
    fault = e;
  }
  const empty = (await Promise.resolve(h.owed.empty?.()).catch(() => undefined)) ?? new Set<string>();
  const found = [...new Map((wallets ?? []).filter((w) => w.chain === "sol" && !empty.has(w.address) && !owed.some((r) => r.address === w.address)).map((w) => [w.address, w] as const)).values()];
  if (owed.length === 0 && found.length === 0) return fault !== null;
  const listed: Findable[] = [];
  for (const { address, mints } of [...owed, ...found.map((w) => ({ address: w.address, mints: [] }))]) {
    const evidence = await evidenceOf(h, address);
    listed.push({ address, evidence, mints: evidence.rec ? mintsOf(mints, [{ mint: evidence.rec.mint, program: evidence.rec.program }]) : mints });
  }
  const read = await findOn(rpcs[1], listed).catch(() => null);
  // a W read empty is listed empty for good only once its notes are settled spent (review P3-9 of 024e8a89d): a W is
  // derived from SPENT and RESERVED notes (spentNotesOf), and a RESERVED note's release may land on W after this read;
  // with the store unread, none is listed
  let reserved: Set<string> | null | undefined;
  const settledSpent = async (address: string): Promise<boolean> => {
    if (reserved === undefined) reserved = await h.notes().then(async (s) => new Set((await s.list()).filter((n) => n.state === "RESERVED").map((n) => refKey(n.ref)))).catch(() => null);
    return reserved !== null && (wallets ?? []).every((w) => w.address !== address || !reserved!.has(w.note));
  };
  const todo: string[] = [];
  for (const { address } of listed) {
    const o = owed.find((r) => r.address === address);
    const r = read?.get(address);
    if (o) {
      // a tap's ride (`opts.ride`): a W whose last pass ended at the floor (owedAfter's `floor`) is passed again, read the
      // same, read otherwise or not read at all (the helper's read of W missing: review P3 2 of 1d3b96d9c), for its ride
      // to carry it
      const floored = opts.ride === true && o.floor === true;
      if (floored || (r === undefined ? o.seen === undefined : o.seen !== r.seen)) todo.push(address);
      continue;
    }
    if (r === undefined) continue;
    if (!r.any) {
      if (await settledSpent(address)) await Promise.resolve(h.owed.markEmpty?.(address)).catch(() => {});
      continue;
    }
    todo.push(address);
  }
  if (todo.length === 0) return fault !== null || read === null;
  // spaced (review 2 P3-e of c0dd55d02): one leftover W's pass that sends a transaction a load, none before the gap after
  // the device's last rent-back send has passed, so no two of the device's Ws close or sweep close together
  // (RentBackSpacing): a pass held so (`quiet`) reads and settles as any, and ends before it would send (HELD)
  let space: RentBackSpacing | undefined;
  let spaceRead = true;
  try {
    space = await h.owed.spacing?.();
  } catch {
    spaceRead = false;
  }
  // the W whose leftover pass of this run sent a transaction: no other W's pass sends in this run (review 2 P3-e of
  // c0dd55d02). The run's own (review P3-7 of 024e8a89d: kept for the page's session, a page left open never swept a
  // second leftover W): a later run reads the device's spacing again, and the claim holds the gap the send opened
  let leftoverSent: string | null = null;
  // per W: another W's send this run, a store that could not be read, or an open gap that is not W's own
  const quiet = (o: OwedRentBack): boolean => (leftoverSent !== null && leftoverSent !== o.address) || !spaceRead || spaceOpen(space, Number(h.now?.() ?? BigInt(Date.now())), o.spaced);
  // the order drawn at random each load (review of 20ba2481b, P1-2), so a W whose pass never progresses never holds the
  // rest behind it (review 5 of 38e59182, L2) and no fixed order ties the account's Ws together
  for (let i = todo.length - 1; i > 0; i--) {
    const k = randomBelow(i + 1);
    [todo[i], todo[k]] = [todo[k]!, todo[i]!];
  }
  let setup: { store: NoteStore; sync: SolanaTreeSync; rent: SolanaRent; wallets: readonly ListedBuyWallet[] };
  try {
    if (wallets === null) throw fault;
    setup = { store: await h.notes(), sync: solanaTreeSync(rpcs, program), rent: await readSolanaRent(rpcs), wallets: withOwedWs(wallets, owed, program) };
  } catch (e) {
    // this load's own reads failed (a provider down): told, each record to be passed kept for the next load, written
    // under the sell lock from the record as it is then (review 5 of 38e59182, info)
    for (const address of todo) {
      const go = await withHolds(locks, address, true, wait, async () => {
        const o = (await h.owed!.list()).find((r) => r.address === address);
        if (!o) return;
        h.told?.({ address, step: "rent_back", state: "gave_up", detail: `this load's reads: ${faultOf(e)}` });
        await owedAfter(h, o, "gave_up");
      });
      if (!go) return true;
    }
    return true;
  }
  const { store, sync, rent } = setup;
  let more = read === null;
  // the positions' passes held while the Ws are read (one finder queue), given back however the list ends
  const release = h.preempt?.();
  try {
    // the sell lock for one W at a time, never around the list (review of c1fd2d20, 2c): a sell tapped meanwhile waits
    // for the one W in flight, and the rest of the list waits for the next run
    let passed = 0;
    for (const address of todo) {
      // the record as it is now: a sell meanwhile may have written W's again or dropped it; a W of the account's with
      // none, its first pass's record
      const f = found.find((x) => x.address === address);
      const current = async () => (await h.owed!.list()).find((r) => r.address === address) ?? (f ? { address, l: f.l.toString(), j: f.j, mints: [], passes: 0 } : undefined);
      // held (review P2-6 of 024e8a89d): not passed, so no read that gates no signature names W to the public seat; its
      // record takes W's lamports from the helper's find read above, for the RETURNING row alone: that read gates no
      // signature and no send (the helper's one keyed reader already reads every W's holdings), and a pass past the gap
      // reads W on both RPCs before it signs anything
      const first = owed.find((r) => r.address === address) ?? (f ? { address, l: f.l.toString(), j: f.j, mints: [], passes: 0 } : undefined);
      if (first && quiet(first)) {
        const go = await withHolds(locks, address, true, wait, async () => {
          const o = await current();
          if (!o) return;
          h.told?.({ address, step: "rent_back", state: "gave_up", detail: "spaced: another of the device's Ws closed or swept within the gap, or this run's one did: W waits" });
          const lamports = heldListing(o, f !== undefined, listed.find((x) => x.address === address)?.evidence, read?.get(address)?.lamports);
          await owedAfter(h, o, "gave_up", undefined, lamports === undefined ? {} : { lamports });
        });
        if (!go) return true;
        more = true;
        opts.held?.();
        continue;
      }
      if (passed++ > 0) await wait(POOL_RENT_BACK_GAP_MS + randomBelow(POOL_RENT_BACK_GAP_MS));
      // a pool buy or sell between its tap and its end, in any tab (POOL_TRADE_LOCK; review P2-1 of 024e8a89d): this W's
      // pass and the rest wait for a later run, so no W's close or sweep goes beside a trade
      if (await tradeRunning(locks, h.storeMs ?? TRADE_STORE_MS)) {
        more = true;
        opts.held?.();
        break;
      }
      const sends = rentBackSends;
      const go = await withHolds(locks, address, true, wait, async (hold) => {
        const o = await current();
        const w = o && setup.wallets.find((x) => x.chain === "sol" && x.address === o.address && x.l.toString() === o.l && x.j === o.j);
        if (o && w && (await rentBackOwed(h, { rpcs, program, pool, scope, rent, store, sync, w, mints: o.mints, wait, ...(o.sell ? { sell: o.sell } : {}), ...(opts.ride === true ? { ride: true as const } : {}) }, o, hold, read?.get(address)?.seen))) more = true;
      });
      if (!go) return true;
      // this pass sent from its W: the run's one; the rest send nothing in this run
      if (rentBackSends > sends) leftoverSent = address;
    }
  } finally {
    release?.();
  }
  return more;
}

/** A rent back's gap (RentBackSpacing), drawn from [POOL_RENT_BACK_SPACE_MIN_MS, POOL_RENT_BACK_SPACE_MAX_MS]. */
const gapDrawn = (): number => POOL_RENT_BACK_SPACE_MIN_MS + randomBelow(POOL_RENT_BACK_SPACE_MAX_MS - POOL_RENT_BACK_SPACE_MIN_MS + 1);
export const rentBackGapDrawn = gapDrawn;

/** A uniform integer in [0, n), from the device's random source. */
function randomBelow(n: number): number {
  if (n <= 1) return 0;
  const lim = Math.floor(0x1_0000_0000 / n) * n;
  const a = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(a);
    if (a[0]! < lim) return a[0]! % n;
  }
}

/**
 * The found W's rule (card buy-spends-several-pieces): a W the device found holding SOL with no buy of its recorded (the
 * own W of an UNSPENT note: a buy of several pieces whose pieces paid W and whose buy, maybe still in flight on another
 * device on the same 12 words, has not landed) is swept only when, on both RPCs:
 *  - W owns no token account of either token program (getTokenAccountsByOwner, W alone): the teardown before it closes
 *    to W each one both RPCs list holding none, any mint, so a stranger's (anyone can open one for W) never holds the
 *    sweep for good (review P2 of c7b85ba3a); one holding tokens is kept, and W with it;
 *  - W's latest transaction (getSignaturesForAddress, W alone, the same signature on both) is in a finalized block, and
 *    each RPC's finalized block height is past that block's height + 151: past the life of any blockhash a transaction
 *    signed before it carries, so no buy that relies on the SOL already on W can still land (its tag 3 was signed
 *    before its pieces landed). A later buy is paid by its own pieces and never relies on what W holds.
 * The second is read first, before the teardown signs anything for W (foundPast), and the first in the sweep's pass
 * (foundSince), with W's history since that latest transaction holding only the teardown's own frames: a close the device
 * signed after the rule held is no buy's, and any other transaction on W since drops the sweep.
 * Either RPC failing, lagging or disagreeing: W holds. The chain's own bound, no clock.
 */
/** The found W's rule's time part: W's latest signature when it holds on both RPCs, or null. */
async function foundPast(rpcs: Rpcs, owner: string): Promise<string | null> {
  const last = await latestAt(rpcs, owner);
  if (last === null) return null;
  const blocks = await both(rpcs, async (r) => (await r("getBlock", [last.slot, HELPER_SOLANA_BLOCK_HEADER])) as { blockHeight?: unknown } | null);
  const heights = blocks.map((b) => b?.blockHeight);
  if (!heights.every((x) => Number.isSafeInteger(x)) || heights[0] !== heights[1]) return null;
  const past = await both(rpcs, async (r) => (await r("getBlockHeight", [{ commitment: "finalized" }])) as unknown);
  return past.every((x) => Number.isSafeInteger(x) && (x as number) > (heights[0] as number) + FOUND_BLOCKHASH_LIFE) ? last.signature : null;
}
/** A blockhash's life in block heights, as the buy reads it (pool-buy.ts BLOCKHASH_LIFE). */
const FOUND_BLOCKHASH_LIFE = 151;
/** W's latest transaction on both RPCs (getSignaturesForAddress, W alone): the same signature and slot on both, or null. */
async function latestAt(rpcs: Rpcs, owner: string): Promise<{ signature: string; slot: number } | null> {
  const got = await both(rpcs, async (r) => (await r("getSignaturesForAddress", [owner, { limit: 1, commitment: "confirmed" }])) as unknown);
  const one = got.map((x) => {
    const e = Array.isArray(x) && x.length === 1 ? (x[0] as { signature?: unknown; slot?: unknown } | null) : null;
    return e && typeof e.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(e.signature) && Number.isSafeInteger(e.slot) && (e.slot as number) >= 0 ? { signature: e.signature, slot: e.slot as number } : null;
  });
  return one[0] && one[1] && one[0].signature === one[1].signature && one[0].slot === one[1].slot ? one[0] : null;
}
const latestOf = async (rpcs: Rpcs, owner: string): Promise<string | null> => (await latestAt(rpcs, owner))?.signature ?? null;
/** The found W's rule's other part, in the sweep's pass: W owns no token account and shows nothing since `since` but
 *  `own`, on both RPCs. */
async function foundSince(tokens: Rpcs, rpcs: Rpcs, owner: string, since: string, own: ReadonlySet<string>): Promise<boolean> {
  return (await ownsNoTokens(tokens, owner)) && (await onlyOwnSince(rpcs, owner, since, own));
}
/** Every transaction on `owner` after `since` is one of `own`, on both RPCs (getSignaturesForAddress until `since`, W
 *  alone, at most one more than `own` asked for): an RPC that does not know `since` lists what came before it, which is
 *  none of `own`, so W holds. */
async function onlyOwnSince(rpcs: Rpcs, owner: string, since: string, own: ReadonlySet<string>): Promise<boolean> {
  const got = await both(rpcs, async (r) => (await r("getSignaturesForAddress", [owner, { until: since, limit: own.size + 1, commitment: "confirmed" }])) as unknown);
  return got.every((x) => Array.isArray(x) && x.length <= own.size && x.every((e: { signature?: unknown } | null) => typeof e?.signature === "string" && own.has(e.signature)));
}

/** The most token accounts of a found W one pass reads and closes: the rest are the next pass's (one getMultipleAccounts
 *  call reads them with W and the teardown's own, under the providers' 100). */
export const FOUND_CLOSE_MAX = 16;
/** A Solana address: base58 of 32 bytes. */
const isAddress = (v: string): boolean => {
  if (v.length < 32 || v.length > 44) return false;
  try {
    return base58.decode(v).length === 32;
  } catch {
    return false;
  }
};
/** The token accounts `owner` owns under either token program, the same set on both RPCs (getTokenAccountsByOwner, W
 *  alone, four calls), sorted, the first FOUND_CLOSE_MAX: a found W's teardown reads them and the kit's plan closes each
 *  one holding none to W, any mint; one holding tokens is kept and W holds. An answer out of shape, an address that is
 *  not one, or the two RPCs listing apart: throws. */
async function foundTokenAccounts(rpcs: Rpcs, owner: string): Promise<string[]> {
  const lists = await both(rpcs, async (r) => {
    const out = new Set<string>();
    for (const programId of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) {
      const got = (await r("getTokenAccountsByOwner", [owner, { programId }, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown } | null;
      if (!Array.isArray(got?.value)) throw new Error("getTokenAccountsByOwner answered no list");
      for (const e of got.value as unknown[]) {
        const k = (e as { pubkey?: unknown } | null)?.pubkey;
        if (typeof k !== "string" || !isAddress(k)) throw new Error("getTokenAccountsByOwner answered an entry with no address");
        out.add(k);
      }
    }
    return [...out].sort();
  });
  if (lists[0].join(",") !== lists[1].join(",")) throw new Error("the two RPCs list W's token accounts apart");
  return lists[0].slice(0, FOUND_CLOSE_MAX);
}
/** Both RPCs read `owner` owning no token account of either token program (four calls, each naming W alone). */
async function ownsNoTokens(rpcs: Rpcs, owner: string): Promise<boolean> {
  const reads = await Promise.all(
    rpcs.flatMap((r) => [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM].map((programId) => r("getTokenAccountsByOwner", [owner, { programId }, { encoding: "base64", commitment: "confirmed" }]))),
  );
  return reads.every((x) => Array.isArray((x as { value?: unknown } | null)?.value) && ((x as { value: unknown[] }).value.length === 0));
}

/** The listed buy wallets, then each owed record's W that none of them names (ownW). */
function withOwedWs(listed: readonly ListedBuyWallet[], owed: readonly OwedRentBack[], program: string): readonly ListedBuyWallet[] {
  const out = [...listed];
  for (const o of owed) {
    if (out.some((x) => x.chain === "sol" && x.address === o.address)) continue;
    const w = ownW(o, program);
    if (w) out.push(w);
  }
  return out;
}

/** An owed record's W with no spent note naming it (resumeRentBacks): its l and j as written, never read (holdings null). */
function ownW(o: OwedRentBack, program: string): ListedBuyWallet | undefined {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(o.l) || !Number.isSafeInteger(o.j) || o.j < 0) return undefined;
  return { pool: program, chain: "sol", note: "", l: BigInt(o.l), j: o.j, path: "", address: o.address, holdings: null };
}

/** How a pass ended, and whether on W's own state (its `seen` then kept). */
type Ended = { end: RentBackEnd; steady: boolean };
/** A pass that met a sell holding the sell lock between its tries. */
const BUSY = new Error("a sell took the sell lock");
/** A leftover pass held by the spacing (resumeRentBacks, RentBackSpacing): it ends before it would send. */
const HELD = new Error("a leftover pass held by the spacing");
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
type SellOp = { kind: "sell"; pool: "sol"; sha: string; stage: "pending" | TradeStage; txs: TxRef[]; code?: ErrorCode; created_ms: number; chain?: "solana"; token?: string; units?: string; legs?: SellOpLeg[]; short?: true };
/** One wallet's sale as the record keeps it (card pool-sell-share-across-wallets; never sent to the app: state.ts reads
 *  only the op contract's keys): W, the units it sells in whole units, its signature once signed, and its stage
 *  ("pending" until it runs; refused with the code of a refusal before it signed). */
type SellOpLeg = { wallet: string; units: string; tx: string | null; stage: "pending" | TradeStage; code?: ErrorCode; cause?: string };
/** The record's stage over its legs (stageOfLegs): a leg still "pending" is one that never ran when `dead`; `short`, a
 *  share that left a frozen W out (shortOf). */
const recordStage = (legs: readonly SellOpLeg[], dead: boolean, short = false): TradeStage =>
  shortOf(stageOfLegs(legs.map((l) => (l.stage === "pending" ? (dead ? { stage: null, error: "failed" as const } : { stage: null }) : { stage: l.stage, ...(l.code === undefined ? {} : { error: "failed" as const }) }))), short);

/** A record its request's run left before its end: "pending" (written before the run), or "signed"/"sent" with a leg
 *  that never ran or with every leg ended (review P1-1 of 77055f4e: a page closed between two sales, the sent one
 *  settled live, left a record "sent" that no settle by signature ever ended, and it locked every sell button). */
const unfinished = (r: Partial<SellOp> | undefined): boolean =>
  r?.kind === "sell" &&
  r.pool === "sol" &&
  (r.stage === "pending" || ((r.stage === "signed" || r.stage === "sent") && Array.isArray(r.legs) && r.legs.length > 0 && (r.legs.some((l) => l.stage === "pending") || r.legs.every((l) => l.stage !== "signed" && l.stage !== "sent"))));

/** What the kind needs beyond a run's host: the wallet store its ops records go in, and the end of the run. */
export type PoolSellKindHost = PoolSellHost & { ops(): Promise<TradeStore>; end?(): void };

/** A dead record (written under its request's lock, so with that lock free its page closed before the run ended):
 *  "pending", nothing was sent, so it is refused "failed"; "signed" or "sent", each leg that never ran is refused
 *  "failed" (nothing was sent for it) and the record's stage is its legs' (recordStage): a leg still signed or sent
 *  keeps it open until that sale settles by its signature (settlePoolSells), every other record ends here. */
const settleDead = (ops: TradeStore, k: string): Promise<unknown> =>
  ops.update("ops", k, (v) => {
    const r = v as SellOp | undefined;
    if (!unfinished(r)) return v;
    if (r!.stage === "pending") return { ...r!, stage: "refused", code: "failed" };
    const legs = r!.legs!.map((l) => (l.stage === "pending" ? { ...l, stage: "refused" as const, code: "failed" as const } : l));
    const stage = recordStage(legs, true, r!.short === true);
    return { ...r!, legs, stage: stage === "sent" ? r!.stage : stage };
  });

/** Pool sell records their requests' pages left before the run's end (unfinished): "pending" ones refused "failed", so
 *  their ids answer that, never id_reused for good; "signed" or "sent" ones with a leg that never ran, that leg refused
 *  and the record at its legs' stage (settleDead). Run once per page load (pool-testnet.ts). It takes no lock, so a
 *  re-ask never meets one it holds. The order is what makes that safe: first the unfinished records, then which request
 *  locks are held (LockManager.query), and only the records read before that query and not held are settled. A live
 *  request takes its lock before it writes "pending" and holds it until its record's end is written, so a record read
 *  before the query is either held at the query or dead; one written after the first read is never touched (the
 *  re-review of fd5eec3). A request that takes a dead record's lock first settles it the same way (poolSellKind). */
export async function settleDeadSellOps(ops: TradeStore, locks: Pick<LockManager, "query">): Promise<void> {
  const pending: string[] = [];
  for (const k of await ops.keys("ops")) {
    const rec = (await ops.get("ops", k)) as Partial<SellOp> | undefined;
    if (unfinished(rec)) pending.push(k);
  }
  if (pending.length === 0) return;
  const held = new Set(((await locks.query()).held ?? []).map((l) => l.name));
  for (const k of pending) if (!held.has(tradeLock(k))) await settleDead(ops, k);
}

/** Writes a settled sell's stage to the pool sell record that names its transaction (one a closed page left "signed"
 *  or "sent"); a record already at an end stays. A record of several wallets' sales (card pool-sell-share-across-wallets)
 *  writes the stage to the leg that names the transaction, and the record's stage over its legs: filled once each leg
 *  filled, part_filled when some did. Settled at a load (no sell runs then: settlePoolSells holds the sell lock), a leg
 *  still "pending" never ran: its page closed first, so nothing was sent for it. `liveId`: the running request's id,
 *  the one record whose legs are still to run (review P3-2 of 77055f4e: a run's settle of another record's sale, an
 *  older note it settles first, treats that record as dead). */
export async function settleSellOps(ops: TradeStore, signature: string, stage: TradeStage, liveId?: string): Promise<void> {
  for (const k of await ops.keys("ops")) {
    const live = k === liveId;
    const rec = (await ops.get("ops", k)) as Partial<SellOp> | undefined;
    if (rec?.kind !== "sell" || rec.pool !== "sol" || (rec.stage !== "signed" && rec.stage !== "sent")) continue;
    if (Array.isArray(rec.legs) && rec.legs.length > 0) {
      if (!rec.legs.some((l) => l.tx === signature && (l.stage === "signed" || l.stage === "sent"))) continue;
      await ops.update("ops", k, (v) => {
        const r = v as SellOp;
        if (r.stage !== "signed" && r.stage !== "sent") return undefined;
        const legs = r.legs!.map((l) => (l.tx === signature && (l.stage === "signed" || l.stage === "sent") ? { ...l, stage } : !live && l.stage === "pending" ? { ...l, stage: "refused" as const, code: "failed" as const } : l));
        return { ...r, legs, stage: recordStage(legs, !live, r.short === true) };
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
    // the tap's one bound, from its arrival (pool-kinds started it already when the sell came through its decimals read)
    const waits = tapWaits(ctx);
    let answer: HostAnswer<"pool.sell"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    // after a full sale filled, its W's rent back: run once the sell's stage is told and its request's lock is free (an id
    // seen again is answered from its record, never id_reused), under the seed's shared lock and the sell lock again;
    // one per leg (card pool-sell-share-across-wallets)
    const laters: Later[] = [];
    let ran: PoolSellKindHost | null = null;
    const run = duringTrade(locks, () =>
      locks.request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
        try {
          await locks.request(tradeLock(ctx.id), { mode: "exclusive", ifAvailable: true }, async (own) => {
            if (!own) return void (answer ??= { error: "id_reused" });
            const h = (ran = host());
            const ms = h.storeMs ?? TRADE_STORE_MS;
            const ops = timedStore(await h.ops(), ms);
            // the record first, under the request's own lock and before the wait for the sell lock (a sell before it
            // may hold that lock through its verdict): an id seen before is answered from it, never run again
            let prior = await ops.get("ops", ctx.id);
            // unfinished under the lock this request now holds: its writer's page closed before the run ended (settleDead)
            if (unfinished(prior as Partial<SellOp> | undefined)) {
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
                  // this run's own sale: its leg in the record the run writes next too, so no later write of it puts the
                  // leg back (review P3-1 of 77055f4e)
                  const i = (op.legs ?? []).findIndex((l) => l.tx === signature && (l.stage === "signed" || l.stage === "sent"));
                  if (i >= 0) setLeg(i, { stage });
                  const w = writes.then(() => settleSellOps(ops, signature, stage, ctx.id));
                  writes = w.catch(() => {});
                  return w;
                },
              }, ask, laters, {
                // the units the plan read and each leg, before any leg runs
                planned: (plan) => write({ units: poolUnits(plan.units, ask.decimals), legs: plan.legs.map((l) => ({ wallet: l.w.address, units: poolUnits(l.units, ask.decimals), tx: null, stage: "pending" })), ...(plan.frozen && ask.shareBps !== undefined ? { short: true as const } : {}) }),
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
                ended: (i, leg) => {
                  // a refusal's cause, on the record and the page's console (public words only: legCause)
                  if (leg.error !== undefined) console.warn(`sell leg ${i + 1} refused ${leg.error}${leg.cause === undefined ? "" : `: ${leg.cause}`}`);
                  setLeg(i, leg.error !== undefined ? { tx: null, stage: "refused", code: leg.error, ...(leg.cause === undefined ? {} : { cause: leg.cause }) } : { tx: leg.tx, stage: leg.stage ?? "refused" });
                },
              }, waits);
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
          }).finally(() => stamped(laters, ran?.storeMs ?? TRADE_STORE_MS));
          // each sale's stamp is in (stamped, the sale ended or thrown) before its own rent back claims and before
          // POOL_TRADE_LOCK goes
          // each full sale's rent back, one W after another: each takes W's own lock and the sell lock itself, the sell
          // lock only between its sleeps (two at once would each find the other holding it and give up)
          for (const later of laters) await later.back?.(locks);
        } finally {
          // the run's end (the page closes its note store): after the rent back, which writes its note there
          ran?.end?.();
        }
      }))
      .catch(() => {
        if (!answer) answer = { error: "failed" };
      })
      .finally(give);
    void run;
    // the request's run ended: its bound dropped (read-waits.ts tapDone)
    void run.then(() => tapDone(ctx, waits), () => tapDone(ctx, waits));
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
