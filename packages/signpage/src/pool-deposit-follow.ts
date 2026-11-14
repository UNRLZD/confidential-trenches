// The follow of a pool deposit quote (card pool-deposit-follow): money 1Click delivers to U_X, chain X's one-time
// deposit wallet that pool.address showed, is carried on into X's pool with no tap. The vault's follow
// (../../wallet/src/deposit/follow.ts followDeposit) is the pattern: a status answer from the server moves only the stage
// shown and never ends a follow; the device's own chain reads decide.
// - Each round reads the chain first: U_X's balance at finalized on X's two RPCs, the lower of the two counted. While
//   it covers one deposit (`floor`: the rung, one deposit's worst-case cost and, on Solana, the rent U_X keeps; the
//   floor the quote was held to, pool-deposit-quote.ts), pool.deposit runs from U_X (`deposit`, the page's own kind,
//   under pool-deposit-sent-end's end rules: its answer at its first send, its end as progress), for the largest ask
//   that U_X's lower balance pays with each rung's worst-case cost and the rent kept (askOf). Anything that credits U_X,
//   a stranger's gift or a late second send too, is carried on, so nothing under U_X is left unfollowed.
// - 1Click's status of the quote's deposit address (`status`, read through the helper) is hostile: it counts only for
//   our address with U_X as its recipient and U_{s,i} as its refund (readDepositStatus), and then it moves only the
//   stage shown, never back. SUCCESS shows nothing the chain has not read: in_transit until U_X's balance reads.
// - The end: in_pool once a deposit from U_X ended filled (or part_filled with nothing of the ask open) and U_X's lower
//   balance no longer covers one more deposit; the follow then reads on to the quote's deadline past on both RPCs'
//   clocks (`past`), so a late second send to U_X is carried too. A deposit that ends not_landed, or a provider down, is
//   read again next round; only the signal (a sign out) ends a follow early. A quote with nothing seen sent by its
//   deadline shows expired and is read on (a late send is refunded by 1Click and carried); a stale status never shows
//   it live again.
// - REFUNDED shows nothing the chain has not read (the vault's rule, ../../wallet/src/deposit/follow.ts; card
//   pool-deposit-stages review P2): while the status reads REFUNDED the refund carry (`refund`, poolRefundMover below)
//   reads what U_{s,i} holds inside intents.near at one block on NEAR's two RPCs, once per round. refunded is shown only
//   once that read finds money there ("held", or "moved": moved with the same signer back to X's coin, to U_X, and
//   carried on by the rounds above, refund_move). A REFUNDED with nothing read there moves no stage: an unsent quote
//   still shows expired past its deadline, and a delivery that lands normally never reads as refunded. With no `refund`
//   given nothing is read, so nothing is shown for it, and the follow does not end (followed on at every landing).
// - The txs (card pool-deposit-op-txs): the op's txs hold each tx that moved its money, and only once the device read it
//   on both RPCs. After each deposit run, and once more before the follow ends, `landed` reads U_X's own deposits into
//   X's pool (on Solana: U_X's finalized signatures and the txs the run's answer named, each kept only when both RPCs
//   read it finalized, paid by U_X, with no error, running the pool program), so a later rung's send, which the kind
//   tells only as a stage, is shown too. A refund move's NEAR tx, as the relayer answered it, is kept on the move and
//   shown only once its nonce reads used and the tx reads FINAL with success on FastNEAR and dRPC, sent by the release's
//   relayer (poolRefundMover's settle); the follow ends only once that is read or the move's deadline is past.
// - A plain send (card deposit-takes-each-pools-own-coin: X's own coin sent straight to U_X, pool-deposit-address.ts)
//   has no 1Click quote: its record's address is U_X itself, and 1Click is asked nothing for it. The chain alone moves
//   its stage: in_transit once U_X's lower balance covers a deposit (written before the carry, so a reload mid-carry
//   counts U_X's landed note as this send's), short while U_X holds money under one deposit's floor and nothing of U_X's
//   is landing (a top-up carries it), expired past its deadline with nothing seen (read on: a late send is carried).
// - Pace: FAST_MS while a status shows a send in flight or a deposit ran; else SLOW_MS doubling to SLOW_MAX_MS (a plain
//   send waiting for its money: SLOW_MS, no doubling, until its deadline).
// Nothing here logs. Every read names one public account (U_X) or the quote's deposit address; no request carries a
// key, the words, or which note is whose.
import type { PoolAsset, PoolChain, PoolDepositStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { ladderSplit, type Ladder } from "../../wallet/src/pool/ladder.ts";
import type { NoteRecord, NoteState } from "../../wallet/src/notes/store.ts";
import { followRpc, type MoveRead, type OneClickStatus, readDepositStatus, type StatusRead } from "../../wallet/src/deposit/follow.ts";
import { NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";
import { type BindRpc, RELEASE_RELAYER } from "../../wallet/src/deposit/bind.ts";
import { solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { SOLANA_POOL_TAG_DEPOSIT } from "../../kit/src/trade/solana/pool-deposit.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { readEvmPoolFloor, readSolanaPoolCosts } from "./pool-deposit-address.ts";
import { EVM_LADDER, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { solanaPoolDepositFloor } from "./pool-deposit-quote.ts";
import { base58, base64, hex } from "@scure/base";
import type { OneClickPricing } from "../../kit/src/checks/oneclick.ts";
import type { HelperSignedIntent } from "../../kit/src/helper/v1.ts";
import { depositId } from "../../wallet/src/derive/keys.ts";
import { type MoveRecord, poolRefundMoveRequest, runRefundMove } from "../../wallet/src/deposit/refund.ts";
import { DEPOSIT_QUOTE_PATH } from "./rules/deposit-dry.ts";
import { checkIdTransferIntent, checkPoolRefundQuote, RefundRuleRefused, signIdIntent, type IdIntent, type RefundQuote } from "./rules/refund.ts";

/** What a reload needs to follow the quote again (written in the op under `follow`; nothing secret). */
export interface PoolFollowRecord {
  chain: PoolChain;
  /** The pool's scope and the planned index U_X was named at. */
  s: string;
  i: number;
  /** U_X (base58 on Solana, EIP-55 on EVM) and U_{s,i}'s 64-hex id, where a refund lands. */
  u: string;
  refund_id: string;
  /** A Move from another pool (card refunds-land-on-the-devices-own-wallet): the address on the origin coin's chain the
   *  quote refunds to (ORIGIN_CHAIN), U_{s,i}'s own key there; absent, the refund is INTENTS under refund_id. */
  refund_to?: string;
  /** The quote's signed deposit address, deadline and origin, and its min out in the pool coin's base units. */
  address: string;
  deadline_ms: number;
  origin: string;
  min_out: string;
  /** The refund carry's last move (poolRefundMover), written before it is sent. */
  move?: PoolMove;
  /** A plain send's: U_X's lower balance as its follow began (card deposit-takes-each-pools-own-coin, review P3-a), in
   *  base units. Only money over it is this send's: a remainder a follow before left, or a neighbour's delivery to the
   *  same U_X, is carried but never shows this send as sent. */
  base?: string;
  /** At the follow's end (review P2-a): U_X's lower balance on its end read, and one deposit's worst-case cost with the
   *  rent U_X keeps (keep + perRung) as that follow last read them, in base units. The namer decides from these whether
   *  U_X still holds money (uxHeldOf), with no read naming U_X. */
  left?: string;
  cost?: string;
}

/** A refund move's NEAR tx as the relayer answered it (card pool-deposit-op-txs), kept with the move it carried (its
 *  nonce and deadline): heard, never shown; `final` once the device read it final on both RPCs (shown); `dropped` once
 *  its nonce read unused past its deadline (never shown); `unread` once not read final by POOL_TX_READ_LIMIT_MS past its
 *  deadline (never shown, never read again; re-check 2 P3). */
export type PoolHeardTx = { hash: string; nonce: string; deadline_ms: number; final?: true; dropped?: true; unread?: true };
/** A refund move as the op keeps it: the wallet's record, and every move's heard tx so far (review P3 1: a new move
 *  never drops an earlier move's tx before it is settled). */
export type PoolMove = MoveRecord & { txs?: PoolHeardTx[] };

/** How long past a move's (or the quote's) deadline the device keeps reading a tx that does not read final, or reads
 *  that do not agree, before it lets them go (review P2-b): a follow always ends. */
export const POOL_TX_READ_MARGIN_MS = 10 * 60_000;
/** How long past its move's deadline a heard tx is read at all (re-check 2 P3): past it, on the chain's clock only
 *  (re-check 3 P3: never the device's), a tx not read final is never read again. Non-archival NEAR nodes keep a tx's
 *  result about 5 epochs (about 2.5 days). */
export const POOL_TX_READ_LIMIT_MS = 48 * 3_600_000;
/** A heard tx still to read: neither final, dropped nor unread. */
const openTx = (t: PoolHeardTx): boolean => t.final !== true && t.dropped !== true && t.unread !== true;

/** The pool follow's stages: kit messages.ts PoolDepositStage, the stages the app reads on the op (card pool-deposit-stages). */
export type PoolFollowStage = PoolDepositStage;

/** Each 1Click status's stage before the device's own reads (as the vault's STATUS_STAGE). */
export const POOL_STATUS_STAGE: Readonly<Record<OneClickStatus, PoolFollowStage>> = Object.freeze({
  PENDING_DEPOSIT: "quote_checked",
  KNOWN_DEPOSIT_TX: "waiting",
  PROCESSING: "in_transit",
  INCOMPLETE_DEPOSIT: "short",
  SUCCESS: "in_transit",
  REFUNDED: "refunded",
  FAILED: "failed",
});
// expired ranks with waiting: a stale PENDING_DEPOSIT never shows a quote past its deadline as live again, and a send
// seen after it (waiting, in transit) still shows. refunded and then refund_move rank above every status before them
// (review L1): a stale PENDING_DEPOSIT or KNOWN_DEPOSIT_TX after a refund never steps the stage back
const RANK: Partial<Record<PoolFollowStage, number>> = { quote_checked: 0, expired: 1, waiting: 1, in_transit: 2, failed: 2, short: 2, refunded: 3, refund_move: 4 };

/** A deposit run's end as the page's pool.deposit kind tells it (pool-deposit.ts poolDepositKind: the answer, then its
 *  end as progress), or its refusal code. */
export type PoolDepositEnd = "filled" | "part_filled" | "not_landed" | "sent" | "not_allowed" | "not_funded" | "failed" | "down";
/** A deposit run (depositToEnd): its end, and the txs its answer named, as heard (card pool-deposit-op-txs): the direct
 *  answer's landed txs, or the sent answer's sends. Heard, never shown: the follow shows only what `landed` reads. */
export type PoolDepositRun = { end: PoolDepositEnd; txs: TxRef[] };

/** The refund carry's answer (poolRefundMover): "moved" and "held" read money under U_{s,i} inside intents.near on both
 *  of NEAR's RPCs (moved on, or not moved this round); "none" read nothing there; "wait" read nothing that counts (the
 *  reads did not agree, or a recorded move is still in its window). */
export type RefundRead = "moved" | "held" | "none" | "wait";

/** One U_X: its chain, the pool's scope and index it was named at, its address on X and U_{s,i}'s 64-hex id. */
export type PoolUx = Pick<PoolFollowRecord, "chain" | "s" | "i" | "u" | "refund_id">;

/**
 * U_X's reads on X and its carry into X's pool: the follow's, and a restore's (src/pool-restore.ts step 5, card
 * wallet-restore-reads-ux: src/main.ts hands it these of the follow's own deps), so a live deposit and a restore read
 * U_X and carry it the same way.
 */
export interface PoolUxReads {
  /** U_X's balance at finalized on X's two RPCs (each its own read, one U_X per request), or one reader's reading as
   *  both (`chainBalances` then given). Throws when a read fails. */
  balances(f: Pick<PoolUx, "u">): Promise<readonly [bigint, bigint]>;
  /** U_X's balance on X's two pool RPCs, each alone in its request, when `balances` is one reader's word (card
   *  evm-deposit-route-mainnet review P1): only these end a follow. Throws when a read fails. */
  chainBalances?(f: Pick<PoolUx, "u">): Promise<readonly [bigint, bigint]>;
  /** The least U_X must hold for one deposit, and what one deposit costs on top of its rung (worst case), and the
   *  rent U_X keeps after it (0 on EVM), read on two RPCs at the round's time. */
  costs(f: PoolUx): Promise<{ floor: bigint; perRung: bigint; keep: bigint }>;
  /** The pool's ladder on X. */
  ladder: Ladder;
  /** The page's pool.deposit on X from U_X, for `amount`, to its end, with the txs its answer named. */
  deposit(f: PoolUx, amount: bigint, signal: AbortSignal): Promise<PoolDepositRun>;
  /** A restore's: what it read U_X holds, written as U_X's newest ended op's `left` (poolFollows' left; review r3 P2-1):
   *  0 before a carry from it is sent, its last read once the carry is done. */
  leftAt?(f: PoolUx, low: bigint): Promise<void>;
}

export interface PoolFollowDeps extends PoolUxReads {
  /** 1Click's status of the quote's address for U_X and U_{s,i} (readDepositStatus with the refund id), or null. */
  status(f: PoolFollowRecord, signal: AbortSignal): Promise<StatusRead | null>;
  /** The quote's deadline past on both RPCs' clocks. */
  past(f: PoolFollowRecord): Promise<boolean>;
  /** The refund carry: what U_{s,i} holds inside intents.near moved back to X's coin, to U_X; none, and a refund waits.
   *  Its `settle` (poolRefundMover's) reads a heard move tx final; true once nothing is left to read. */
  refund?: ((f: PoolFollowRecord, signal: AbortSignal) => Promise<RefundRead>) & { settle?(f: PoolFollowRecord): Promise<boolean> };
  /** The txs of U_X's deposits into X's pool that both RPCs read landed: `heard` (a run's answer) and U_X's own, less
   *  `known` (already shown). Throws when a read fails (card pool-deposit-op-txs). */
  landed?(f: PoolFollowRecord, heard: readonly TxRef[], known?: ReadonlySet<string>): Promise<TxRef[]>;
  /** Whether the store holds a landed note of U_X's own (uxNoteLanded: its deposit note at (s, i) or one of its second
   *  arrivals), read each round until one is (card evm-deposit-route-mainnet review P2a): a follow resumed while its
   *  only rung, or a later one, was landing reaches its end once that note settles. Read only once this quote's own
   *  status read SUCCESS, or its stage is in_pool (re-read P2-1): the note is U_X's, not the quote's. */
  noted?(f: PoolFollowRecord): Promise<boolean>;
  /** Whether the store holds a note of U_X's own still landing (uxNoteOpen: INCOMING, sent and not yet final; card
   *  evm-deposit-route-mainnet review): while one is, nothing shows in_pool and the follow never ends, so a later rung
   *  that fails to land is never shown deposited, and what it leaves in U_X is carried again. The page's own pass of the
   *  pool's INCOMING notes lands or retires it. */
  open?(f: PoolFollowRecord): Promise<boolean>;
  /** The op's stage written (and posted to the app in state.ops). */
  stage(s: PoolFollowStage): Promise<void>;
  /** At the end, before it returns (review P2-a): U_X's lower balance on the end read and keep + perRung as last read. */
  left?(low: bigint, cost: bigint): Promise<void>;
  /** Before the end (card one-balance-buys-on-every-chain): what U_X holds under one deposit's floor each round the op
   *  shows in_pool, written as the op's `left` so the balance counts it at once; 0 before any carry from U_X, so the
   *  money a carry turns into a note is never counted twice. */
  holds?(low: bigint): Promise<void>;
  /** Txs read landed, added to the op's txs (each once). */
  txs?(t: TxRef[]): Promise<void>;
  /** The device's clock (Date.now unless given): the end's tx read is bounded by the quote's deadline and the margin. */
  now?: () => number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
}

// a note read landed on chain (the store's LANDED, wallet notes/store.ts)
const NOTE_LANDED: readonly NoteState[] = ["UNSPENT", "HELD", "RESERVED", "SPENT"];
const ofUx = (n: Pick<NoteRecord, "ref" | "scope">, f: Pick<PoolFollowRecord, "s" | "i">): boolean => {
  const s = BigInt(f.s);
  return n.scope === s && ((n.ref.kind === "deposit" && n.ref.s === s && n.ref.i === f.i) || (n.ref.kind === "second" && n.ref.id.id === "U" && n.ref.id.s === s && n.ref.id.i === f.i));
};
/** Whether `notes` hold a landed note of U_X's own: its deposit note at (s, i) or one of that id's second arrivals. */
export function uxNoteLanded(notes: readonly Pick<NoteRecord, "ref" | "scope" | "state">[], f: Pick<PoolFollowRecord, "s" | "i">): boolean {
  return notes.some((n) => NOTE_LANDED.includes(n.state) && ofUx(n, f));
}
/** Whether `notes` hold a note of U_X's own still landing: sent (INCOMING) and not final yet. */
export function uxNoteOpen(notes: readonly Pick<NoteRecord, "ref" | "scope" | "state">[], f: Pick<PoolFollowRecord, "s" | "i">): boolean {
  return notes.some((n) => n.state === "INCOMING" && ofUx(n, f));
}

export const POOL_FOLLOW_FAST_MS = 2_000;
export const POOL_FOLLOW_SLOW_MS = 15_000;
export const POOL_FOLLOW_SLOW_MAX_MS = 60_000;
/** How long a round under the floor keeps the costs it read while U_X's balance stays the one they were read at (card
 *  evm-first-proof-inside-ten-seconds): a fee that falls under that balance is carried within this. */
export const POOL_FOLLOW_COSTS_MS = 15_000;

/**
 * The largest ask U_X pays from `have` (its lower balance): rungs whose sum, with `perRung` for each and `keep` left,
 * fits; 0n when not even one rung does.
 */
export function askOf(ladder: Ladder, have: bigint, perRung: bigint, keep: bigint): bigint {
  for (let k = 1n; ; k++) {
    const room = have - keep - k * perRung;
    if (room < ladder.min) return 0n;
    const { notes } = ladderSplit(ladder, room);
    if (BigInt(notes.length) <= k) return notes.reduce((a, b) => a + b, 0n);
  }
}

/**
 * Whether U_X still holds money a follow left there (card deposit-takes-each-pools-own-coin, review P1): a send that is
 * not a sum of rungs leaves its remainder, since only whole rungs go into the pool. True while U_X's lower balance is
 * over the rent it keeps and one deposit's worst-case cost (dust under that cannot pay its own deposit); the namer then
 * keeps naming U_X (src/deposit-name.ts), so the next send tops it up and its follow carries both. Throws when a read
 * fails.
 */
export async function uxHeld(r: Pick<PoolUxReads, "balances" | "costs">, ux: PoolUx): Promise<boolean> {
  const [a, b] = await r.balances(ux);
  const low = a < b ? a : b;
  if (low === 0n) return false;
  const c = await r.costs(ux);
  return low > c.keep + c.perRung;
}

/**
 * state.deposit_wallets (card deposit-takes-each-pools-own-coin; the kit's SignpageState.deposit_wallets): each U_X whose
 * newest op ended with money left there, at what that end read (`left`, any amount over 0), in whole units of the pool's
 * coin. From the store alone: no read names U_X. Never in the pool balance and here at once: an op's end is read only
 * with no note of U_X's landing and U_X under one deposit's floor on the chain, so `left` is what stayed after every
 * carry the pool counts; and money that arrives later reopens the op (followAgain), which then shows none here until its
 * own end. The caller reads the notes first and the ops after, so a carry the notes count is one whose op was reopened
 * by then. A U_X still followed shows none (its op's stage tells it).
 */
export function depositWalletsOf(ops: readonly unknown[], decimals: (chain: PoolChain) => number, asset: (chain: PoolChain) => PoolAsset): { chain: PoolChain; address: string; asset: PoolAsset; amount: string }[] {
  const newest = new Map<string, PoolDepositOp>();
  for (const v of ops) {
    if (!isPoolOp(v)) continue;
    const k = `${v.follow.chain}\n${v.follow.u}`;
    const had = newest.get(k);
    if (had === undefined || v.created_ms > had.created_ms) newest.set(k, v);
  }
  const out: { chain: PoolChain; address: string; asset: PoolAsset; amount: string }[] = [];
  for (const v of newest.values()) {
    // an in_pool op's left, ended or still read on to its deadline (its follow writes what U_X holds each round, 0 before a
    // carry: card one-balance-buys-on-every-chain)
    // and a short deposit's (card leftovers-carry-to-cash: written each round it shows short)
    if ((v.stage !== "in_pool" && v.stage !== "short") || v.follow.left === undefined || !/^[0-9]{1,78}$/.test(v.follow.left)) continue;
    const units = BigInt(v.follow.left);
    if (units === 0n) continue;
    const d = decimals(v.follow.chain);
    const t = units.toString().padStart(d + 1, "0");
    const frac = t.slice(t.length - d).replace(/0+$/, "");
    out.push({ chain: v.follow.chain, address: v.follow.u, asset: asset(v.follow.chain), amount: frac === "" ? t.slice(0, t.length - d) : `${t.slice(0, t.length - d)}.${frac}` });
  }
  return out;
}

/**
 * uxHeld from the store alone (review P2-a: the namer runs at every note change, a buy's and a sell's included, and a
 * read naming U_X then ties U_X to W): the newest op of U_X on `chain` decides. One still followed holds it (its follow
 * carries what arrives); one ended holds it while what its end read left there is over keep + perRung. No op: false.
 */
export function uxHeldOf(ops: readonly unknown[], chain: PoolChain, u: string): boolean {
  let newest: PoolDepositOp | undefined;
  for (const v of ops) if (isPoolOp(v) && v.follow.chain === chain && v.follow.u === u && (newest === undefined || v.created_ms > newest.created_ms)) newest = v;
  if (newest === undefined) return false;
  if (!poolFollowEnded(newest)) return true;
  try {
    return newest.follow.left !== undefined && newest.follow.cost !== undefined && BigInt(newest.follow.left) > BigInt(newest.follow.cost);
  } catch {
    return false;
  }
}

/** Follows one pool quote to its end (in_pool past the deadline), or until the signal stops it; returns the last stage. */
export async function followPoolQuote(f: PoolFollowRecord, deps: PoolFollowDeps, from: PoolFollowStage = "quote_checked"): Promise<PoolFollowStage> {
  let shown: PoolFollowStage = from;
  const show = async (s: PoolFollowStage): Promise<void> => {
    if (s === shown) return;
    // a status moves the stage shown forward only (a stale answer never steps it back); the device's own reads may
    if (RANK[s] !== undefined && RANK[shown] !== undefined && RANK[s]! < RANK[shown]!) return;
    shown = s;
    await deps.stage(s);
  };
  let landed = shown === "in_pool";
  // a plain send: no 1Click address, U_X itself (card deposit-takes-each-pools-own-coin)
  const plain = f.address === f.u;
  // this quote's own payment read (card evm-deposit-route-mainnet re-read P2-1): 1Click's SUCCESS for its own address, or
  // its stage already in_pool. Only then does a landed note of U_X's count as this quote's: U_X is per (s, i), not per
  // quote, so a neighbour's note never shows an unpaid or expired quote in the pool, nor ends a paid one before its own
  // delivery is carried
  // A plain send has no status: the money this follow (or the one before a reload) saw at U_X is its payment
  let paid = shown === "in_pool" || (plain && (shown === "in_transit" || shown === "short"));
  // a plain send's own money is what U_X holds over `base` (review P3-a): its lower balance as the follow began, lowered
  // to what U_X reads after money left it (a remainder carried with a neighbour's), never raised
  let base = ((): bigint => {
    try {
      return plain && f.base !== undefined ? BigInt(f.base) : 0n;
    } catch {
      return 0n;
    }
  })();
  // the pool's own two RPCs read before a plain send shows expired (review P3-b), until they read nothing over its base:
  // one reader's word (the helper's on EVM mainnet) never shows a send expired that landed
  let chainSeen = false;
  let slow = POOL_FOLLOW_SLOW_MS;
  // the costs a round under the floor read, at U_X's lower balance then and the device's clock (card
  // evm-first-proof-inside-ten-seconds): read again only once that balance moves or POOL_FOLLOW_COSTS_MS passed, so a
  // follow held under the floor is no fee oracle read every round on the pool's hosts (a Base mainnet copy of 13 Nov:
  // 30 requests per 10 s on each, every pass's budget there); a carry is only ever decided on costs read in its round
  type Under = { low: bigint; at: number; c: { floor: bigint; perRung: bigint; keep: bigint } };
  let under: Under | null = null;
  // the device's clock at this follow's first end attempt (re-check P2): a page opened long past the quote's deadline
  // still reads a failing tx read again for the whole margin
  let endSince: number | null = null;
  // the txs written this follow (card pool-deposit-op-txs): each written once, and never read again
  const written = new Set<string>();
  const carryTxs = async (heard: readonly TxRef[]): Promise<void> => {
    if (!deps.landed || !deps.txs) return;
    const t = (await deps.landed(f, heard, written)).filter((x) => !written.has(x.hash));
    if (t.length === 0) return;
    await deps.txs(t);
    for (const x of t) written.add(x.hash);
  };
  // the quote's own floor (card evm-deposit-route-mainnet review P2b): the device held min_out at or above the floor
  // when it checked the quote, so what U_X holds up to it is carried in even after fees rose since (the deposit prices
  // itself at its own gas and tells short if it cannot pay); over it, the floor read now
  const quoted = ((): bigint | null => {
    try {
      const m = BigInt(f.min_out);
      return m >= deps.ladder.min ? m : null;
    } catch {
      return null;
    }
  })();
  const gated = (c: { floor: bigint; perRung: bigint; keep: bigint }) => {
    if (quoted === null || quoted >= c.floor || quoted - deps.ladder.min - c.keep < 0n) return c;
    const per = quoted - deps.ladder.min - c.keep;
    return { floor: quoted, perRung: per < c.perRung ? per : c.perRung, keep: c.keep };
  };
  // one deposit from U_X for the largest ask `low` pays; true when it landed (the next round reads what is left at once;
  // anything else, not landed, refused or down, is read again at the slow pace, so a deposit that cannot go is never
  // asked in a tight loop)
  const isOpen = async (): Promise<boolean> => deps.open !== undefined && (await deps.open(f));
  // a deposit of this round's carry filled (its note may still be landing)
  let filledNow = false;
  const carry = async (low: bigint, c: { perRung: bigint; keep: bigint }): Promise<boolean> => {
    const amount = askOf(deps.ladder, low, c.perRung, c.keep);
    if (amount === 0n) return false;
    const { end, txs } = await deps.deposit(f, amount, deps.signal);
    if (end === "filled" || end === "part_filled") filledNow = true;
    // landed only with nothing of U_X's still landing: a rung sent after the one that landed is followed first
    const went = (end === "filled" || end === "part_filled") && !(await isOpen());
    // a plain send's carry of money that is not its own (nothing over its base seen yet) never shows it in the pool
    if (went && (!plain || paid)) {
      landed = true;
      await show("in_pool");
    }
    // U_X holds over the quote's own floor but cannot pay a rung and its fee now (fees rose since the quote): the
    // existing short stage, so the screen tells it (re-read P3-2), until a top-up to U_X or lower fees let it go; never
    // once a rung of this follow is in the pool
    // what U_X holds is written as the op's left (card leftovers-carry-to-cash): a short deposit's money is counted and
    // carried to Cash while no top-up comes
    if (end === "not_funded" && !landed) {
      await show("short");
      await deps.holds?.(low);
    }
    // its txs as both RPCs read them; a read that fails leaves them to the read before the end
    await carryTxs(txs).catch(() => {});
    return went;
  };
  // the end's own read (card evm-deposit-route-mainnet review P1): U_X on the pool's two RPCs, each alone in its request
  // (`chainBalances`, or `balances` where those are already the two), ends a follow only when BOTH read it under one
  // deposit's floor. One reader's low word (the helper's) never ends one: what the two hold over the floor is carried
  // (the deposit reads U_X again itself), and two that read apart are read again
  // keep + perRung as this follow last read them (review P2-a: written with what the end leaves at U_X)
  const last: { cost: bigint | null } = { cost: null };
  const costsNow = async () => {
    const c = gated(await deps.costs(f));
    last.cost = c.keep + c.perRung;
    return c;
  };
  const emptyOnChain = async (): Promise<{ empty: boolean; went: boolean; low: bigint }> => {
    const [x, y] = await (deps.chainBalances ?? deps.balances)(f);
    const high = x > y ? x : y;
    const low = x < y ? x : y;
    if (high < deps.ladder.min) return { empty: true, went: false, low };
    const c = await costsNow();
    if (high < c.floor) return { empty: true, went: false, low };
    return { empty: false, went: low >= c.floor ? await carry(low, c) : false, low };
  };
  for (;;) {
    if (deps.signal.aborted) return shown;
    let fast = false;
    filledNow = false;
    try {
      const opened = await isOpen();
      // a note of U_X's landing, or a deposit that just filled, is read at the fast pace (card
      // deposit-takes-each-pools-own-coin: a plain send has no status to speed the rounds, and its EVM copy run read in_pool
      // 64 s after in_transit, the rounds backing off to a minute while its note landed)
      if (opened) fast = true;
      if (!landed && !opened && paid && deps.noted !== undefined && (await deps.noted(f))) landed = true;
      // the chain first: U_X's money, the lower of two RPCs at finalized, carried into the pool while it covers a deposit
      // (with one reader, its one reading: it only starts a deposit, which reads U_X on the pool's two RPCs itself)
      const [a, b] = await deps.balances(f);
      const low = a < b ? a : b;
      if (plain && low < base) base = low;
      // the costs' reads only once U_X holds at least the least rung (review L2): none while it holds nothing
      const t = (deps.now ?? Date.now)();
      const was = under as Under | null;
      const keep = was !== null && was.low === low && t >= was.at && t - was.at < POOL_FOLLOW_COSTS_MS ? was : null;
      const c: Under["c"] | null = low >= deps.ladder.min ? (keep?.c ?? (await costsNow())) : null;
      under = c !== null && low < c.floor ? (keep ?? { low, at: t, c }) : null;
      if (c !== null && low >= c.floor) {
        await deps.holds?.(0n);
        if (plain && !landed && low > base) {
          await show("in_transit");
          paid = true;
        }
        if (await carry(low, c)) fast = true;
        if (filledNow) fast = true;
      } else if (landed) {
        // nothing left under U_X to carry: read on to the quote's deadline, so a late send is carried too; while a note of
        // U_X's is still landing, nothing more (no in_pool, no end): its landing, or what it leaves in U_X, comes first
        if (!opened && shown !== "in_pool") await show("in_pool");
        if (!opened) await deps.holds?.(low);
        if (!opened && (await deps.past(f))) {
          const e = await emptyOnChain();
          if (e.went) fast = true;
          else if (e.empty) {
            // the end only once every landed tx is read (a failed read: read again next round, until the margin past the
            // later of the quote's deadline and this follow's first end is past on the device's clock, then the end with
            // the txs read so far; review P2-b, re-check P2), and no refund move's heard tx holds it (poolRefundMover's
            // settle, bounded the same way)
            const read = await carryTxs([]).then(() => true, () => false);
            const t = (deps.now ?? Date.now)();
            endSince ??= t;
            if (!read && t <= Math.max(f.deadline_ms, endSince) + POOL_TX_READ_MARGIN_MS) throw new Error("read the txs again");
            if (!deps.refund?.settle || (await deps.refund.settle(f))) {
              // what the end leaves at U_X, with the costs last read (none read this follow: read once now, U_X holding
              // anything), so the namer decides from the store (review P2-a)
              if (deps.left !== undefined) {
                let cost: bigint = 0n;
                if (last.cost !== null) cost = last.cost;
                else if (e.low > 0n) cost = await costsNow().then((c) => c.keep + c.perRung);
                await deps.left(e.low, cost);
              }
              return shown;
            }
          }
        }
      } else {
        // a plain send asks 1Click nothing: money under one deposit's floor at U_X, with nothing of U_X's landing, is short
        if (plain && low > base && !opened) {
          await show("short");
          await deps.holds?.(low);
          paid = true;
        }
        const st = plain ? null : await deps.status(f, deps.signal);
        let refund: RefundRead | null = null;
        if (st !== null && "status" in st) {
          // REFUNDED shows nothing the chain has not read: refunded only once the carry's read finds the money under
          // U_{s,i} on both of NEAR's RPCs (a refund being moved stays shown as moved: RANK)
          if (st.status !== "REFUNDED") await show(POOL_STATUS_STAGE[st.status]);
          if (st.status === "SUCCESS") paid = true;
          if (st.status === "KNOWN_DEPOSIT_TX" || st.status === "PROCESSING" || st.status === "SUCCESS") fast = true;
          if (st.status === "REFUNDED" && deps.refund) {
            refund = await deps.refund(f, deps.signal);
            if (refund === "held" || refund === "moved") await show("refunded");
            if (refund === "moved") {
              await show("refund_move");
              fast = true;
            }
          }
        }
        // nothing seen sent by the deadline on both RPCs' clocks: expired, and read on (a late send to the address is
        // refunded by 1Click, and that refund is carried as any other). A REFUNDED whose read found nothing under U_{s,i}
        // is no send seen; one whose read did not count ("wait") is read again first
        const unseen = st === null || ("status" in st && (st.status === "PENDING_DEPOSIT" || (st.status === "REFUNDED" && (refund === null || refund === "none"))));
        if (shown === "quote_checked" && unseen && (await deps.past(f))) {
          // on Solana the follow's own pair (review P3-b of the delta: one RPC lagging at 0 is no expired send either)
          if (plain && !chainSeen) {
            const [x, y] = await (deps.chainBalances ?? deps.balances)(f);
            // money there on either: not expired, read again next round (the helper's reading catches up)
            if ((x > y ? x : y) > base) throw new Error("U_X holds money on the pool's RPCs: read again");
            chainSeen = true;
          }
          await show("expired");
        }
      }
    } catch {
      if (deps.signal.aborted) return shown;
    }
    if (fast) slow = POOL_FOLLOW_SLOW_MS;
    await deps.sleep(fast ? POOL_FOLLOW_FAST_MS : slow, deps.signal);
    if (!fast && !(plain && shown === "quote_checked")) slow = Math.min(slow * 2, POOL_FOLLOW_SLOW_MAX_MS);
  }
}

// ---------------------------------------------------------------------------------------------- on SIGN_HOST's page

/** The op a pool quote's follow keeps in the wallet store's "ops" under its request's id (src/state.ts op contract):
 *  nothing secret. `final` once in_pool is read on past the quote's deadline. `since_ms` is the device's clock when a
 *  stage first said the money was sent (any stage but quote_checked and expired), `refunded` true from the refunded
 *  stage on (card pool-deposit-stages): the facts src/state.ts opOf sends the app on the stages they belong to (kit
 *  messages.ts PoolDepositFacts). */
export type PoolDepositOp = { kind: "pool_deposit"; stage: PoolFollowStage; txs: TxRef[]; created_ms: number; follow: PoolFollowRecord; final?: true; since_ms?: number; refunded?: true; untimed?: true };

/** The op with `t` added to its txs, each hash once; the op itself when nothing is new (no write). */
export function withTxs(op: PoolDepositOp, t: readonly TxRef[]): PoolDepositOp {
  const had = Array.isArray(op.txs) ? op.txs : [];
  const add = t.filter((x, k) => !had.some((y) => y.hash === x.hash) && t.findIndex((y) => y.hash === x.hash) === k).map((x) => ({ chain: x.chain, hash: x.hash }));
  return add.length === 0 ? op : { ...op, txs: [...had, ...add] };
}

/** The op with its refund move `m` kept, every heard tx of earlier moves kept beside `m`'s (each by its hash, its
 *  settled flags kept), and each tx read final added to its txs (card pool-deposit-op-txs): a tx only heard, or let go,
 *  is never shown. */
export function withMove(op: PoolDepositOp, m: PoolMove): PoolDepositOp {
  const txs: PoolHeardTx[] = [...(op.follow.move?.txs ?? [])];
  for (const t of m.txs ?? []) {
    const k = txs.findIndex((x) => x.hash === t.hash);
    if (k < 0) txs.push({ ...t });
    else txs[k] = { ...txs[k]!, ...t };
  }
  const { txs: _drop, ...move } = m;
  const next: PoolDepositOp = { ...op, follow: { ...op.follow, move: txs.length === 0 ? move : { ...move, txs } } };
  const shown = txs.filter((t) => t.final === true && t.dropped !== true && typeof t.hash === "string").map((t) => ({ chain: "near" as const, hash: t.hash }));
  return shown.length === 0 ? next : withTxs(next, shown);
}

/** A stage that says the money was sent: any but quote_checked and expired. */
const SENT = (s: PoolFollowStage): boolean => s !== "quote_checked" && s !== "expired";

/**
 * The op with `s` written: its stage, and the facts the step to it sets, each kept after (review P3 1):
 * - since_ms only on the step out of quote_checked or expired to a stage that says the money was sent, so the time is
 *   when the device first saw the send. A record of release-94 to 107 already past that step has none and gets none (a
 *   reload's time is not the send's), nor one marked `untimed` (a legacy refunded op read again from quote_checked);
 * - refunded at refunded or refund_move (each shown only once the chain read the money under U_{s,i}), and on the step
 *   on from refund_move, so a legacy refund_move record (which has no refunded) keeps it into the pool.
 */
export function withStage(op: PoolDepositOp, s: PoolFollowStage, now: number): PoolDepositOp {
  const next: PoolDepositOp = { ...op, stage: s };
  if (op.since_ms === undefined && op.untimed !== true && !SENT(op.stage) && SENT(s)) next.since_ms = now;
  if (s === "refunded" || s === "refund_move" || op.stage === "refund_move") next.refunded = true;
  return next;
}

/**
 * A record to follow on from (review P2): a refunded record with no refunded fact was written by release-94 to 107 on
 * the helper's REFUNDED alone, so it is read again from quote_checked (marked untimed: its send's time is unknown), and
 * shows refunded again only once the chain reads the money under U_{s,i}. Every other record as it is. The one rule,
 * refundedOnWord, also holds what src/state.ts opOf sends the app (the framed page runs no follow).
 */
export const refundedOnWord = (r: { stage?: unknown; refunded?: unknown }): boolean => r.stage === "refunded" && r.refunded !== true;
export function resumeOf(op: PoolDepositOp): PoolDepositOp {
  return refundedOnWord(op) ? { ...op, stage: "quote_checked", untimed: true } : op;
}

/** One follower per op across tabs: POOL_FOLLOW_LOCK/<op id>, held while it is followed. */
export const POOL_FOLLOW_LOCK = "ct-wallet/pool-follow/";

const FOLLOW_KEYS = ["chain", "s", "i", "u", "refund_id", "refund_to", "address", "deadline_ms", "origin", "min_out"] as const;
const isPoolOp = (v: unknown): v is PoolDepositOp =>
  typeof v === "object" && v !== null && (v as PoolDepositOp).kind === "pool_deposit" && typeof (v as PoolDepositOp).follow === "object" && (v as PoolDepositOp).follow !== null;
/** A pool op's follow ended: in_pool read on past its quote's deadline. Every other op is followed again at each landing. */
export const poolFollowEnded = (op: Pick<PoolDepositOp, "stage" | "final">): boolean => op.stage === "in_pool" && op.final === true;
/** A refund move's heard tx neither read final nor let go (re-check P3-2): an ended op with one is read again at each
 *  landing (its refund carry's settle only), so a move that landed late still shows its tx. */
const openHeard = (op: PoolDepositOp): boolean => (op.follow.move?.txs ?? []).some(openTx);

const DEC = /^[0-9]+(\.[0-9]+)?$/;
/** A decimal at `decimals` in base units, exactly; null otherwise. */
function baseUnits(v: unknown, decimals: number): bigint | null {
  if (typeof v !== "string" || !DEC.test(v)) return null;
  const [i = "", f = ""] = v.split(".");
  return f.length > decimals ? null : BigInt(i + f.padEnd(decimals, "0"));
}

export interface PoolFollowHost {
  store(): Promise<{ get(s: "ops", k: string): Promise<unknown>; update(s: "ops", k: string, change: (v: unknown) => unknown): Promise<unknown>; keys(s: "ops"): Promise<string[]> }>;
  /** The chain reads and the deposit for X's pool (its pinned pair, the page's pool.deposit), or null when the page
   *  pins no pool there: the op waits, followed again at the next landing. */
  deps(f: PoolFollowRecord, op: { move(): Promise<PoolMove | undefined>; record(m: PoolMove): Promise<void> }): Omit<PoolFollowDeps, "stage" | "signal" | "txs"> | null;
  /** The decimals of X's coin (kit POOL_ASSET_DECIMALS). */
  decimals(chain: PoolChain): number;
  locks?: () => Pick<LockManager, "request"> | null;
  now?: () => number;
  /** An ended op's U_X read again at a landing (review P2-b of the delta): X's reads on restore's paced queue
   *  (src/pool-restore.ts restoreUxOf), never the follow's burst; none given: the follow's own (tests). */
  again?(chain: PoolChain): Pick<PoolUxReads, "balances" | "costs" | "ladder"> | null;
  /** The wait before each of those reads, drawn (as the W passes' load start); none given: no wait (tests). */
  againWait?(signal: AbortSignal): Promise<void>;
  /** The random source their order is drawn from (crypto.getRandomValues when not given). */
  random?: (out: Uint32Array<ArrayBuffer>) => void;
}

/** `xs` in an order drawn from `random` (Fisher-Yates, each draw unbiased). */
function shuffledBy<T>(xs: readonly T[], random: (out: Uint32Array<ArrayBuffer>) => void = (out) => void globalThis.crypto.getRandomValues(out)): T[] {
  const out = [...xs];
  const b = new Uint32Array(1);
  for (let i = out.length - 1; i > 0; i--) {
    const span = i + 1, max = Math.floor(0x1_0000_0000 / span) * span;
    do random(b);
    while (b[0]! >= max);
    const j = b[0]! % span;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** How long an ended op's U_X is read again at each landing (review P2-b of the delta: the set never grows for good):
 *  POOL_TX_READ_LIMIT_MS from the op's quote, or while its end left money there over one deposit's cost (uxHeldOf). */
export const POOL_AGAIN_FOR_MS = POOL_TX_READ_LIMIT_MS;
/** The drawn wait before a run of them (the W passes' load start span, src/pool-testnet.ts BACKS_LOAD_*): no read of a
 *  user's U_X goes at the instant a landing is read, which a network could tie to that landing's own reads. */
export const POOL_AGAIN_WAIT_MIN_MS = 15_000;
export const POOL_AGAIN_WAIT_MAX_MS = 60_000;
export function poolAgainWait(signal: AbortSignal, random: (out: Uint32Array<ArrayBuffer>) => void = (out) => void globalThis.crypto.getRandomValues(out)): Promise<void> {
  const span = POOL_AGAIN_WAIT_MAX_MS - POOL_AGAIN_WAIT_MIN_MS + 1;
  const b = new Uint32Array(1);
  const max = Math.floor(0x1_0000_0000 / span) * span;
  do random(b);
  while (b[0]! >= max);
  return followSleep(POOL_AGAIN_WAIT_MIN_MS + (b[0]! % span), signal);
}

export function poolFollows(h: PoolFollowHost) {
  const running = new Map<string, { p: Promise<void>; signal: AbortSignal }>();
  let abort = new AbortController();
  // settle's run of ended U_X reads, and the list a landing during it leaves for its next turn
  let againRun: Promise<void> | null = null;
  let againDue: { k: string; v: PoolDepositOp }[] | null = null;
  const locks = h.locks ?? (() => (typeof navigator !== "undefined" ? (navigator.locks ?? null) : null));

  const follow = (id: string, f: PoolFollowRecord): Promise<void> => {
    const had = running.get(id);
    if (had && !had.signal.aborted) return had.p;
    const signal = abort.signal;
    const body = async () => {
      const ops = await h.store();
      const read = await ops.get("ops", id);
      if (!isPoolOp(read)) return;
      const ended = poolFollowEnded(read);
      if (ended && !openHeard(read)) return;
      const now = resumeOf(read);
      if (now !== read) await ops.update("ops", id, (v) => (isPoolOp(v) ? resumeOf(v) : undefined));
      // the refund carry's move, kept in the op's follow record (written before its send)
      const d = h.deps(f, {
        move: async () => {
          const v = await ops.get("ops", id);
          return isPoolOp(v) ? v.follow.move : undefined;
        },
        record: async (m) => void (await ops.update("ops", id, (v) => (isPoolOp(v) ? withMove(v, m) : undefined))),
      });
      if (d === null) return;
      if (ended) return void (await d.refund?.settle?.(f).catch(() => {}));
      // a plain send's base (review P3-a): U_X's lower balance as its follow first began, kept with the op; a read that
      // fails writes none (read again at the next start)
      let g: PoolFollowRecord = read.follow.base === undefined ? f : { ...f, base: read.follow.base };
      if (g.address === g.u && g.base === undefined && now.stage === "quote_checked") {
        const low = await d.balances(g).then(([a, b]) => (a < b ? a : b), () => null);
        if (low !== null) {
          await ops.update("ops", id, (v) => (isPoolOp(v) && v.follow.base === undefined ? { ...v, follow: { ...v.follow, base: low.toString() } } : undefined));
          const v = await ops.get("ops", id);
          if (isPoolOp(v) && v.follow.base !== undefined) g = { ...g, base: v.follow.base };
        }
      }
      const stage = async (s: PoolFollowStage) => {
        await ops.update("ops", id, (v) => (isPoolOp(v) ? withStage(v, s, (h.now ?? Date.now)()) : undefined));
      };
      const txs = async (t: TxRef[]) => {
        await ops.update("ops", id, (v) => {
          if (!isPoolOp(v)) return undefined;
          const next = withTxs(v, t);
          return next === v ? undefined : next;
        });
      };
      // what the end left at U_X and one deposit's cost, written with `final` in the same write (review P2-a)
      let endLeft: { left: string; cost: string } | null = null;
      const left = async (low: bigint, cost: bigint) => void (endLeft = { left: low.toString(), cost: cost.toString() });
      // what U_X holds each round before the end, written as the op's left when it differs (none written for a 0 with none)
      const holds = async (low: bigint) => {
        const l = low.toString();
        await ops.update("ops", id, (v) => (isPoolOp(v) && v.follow.left !== l && !(low === 0n && v.follow.left === undefined) ? { ...v, follow: { ...v.follow, left: l } } : undefined));
      };
      const end = await followPoolQuote(g, { ...d, stage, txs, left, holds, signal }, now.stage);
      // the follow returns past its deadline only at in_pool; a signal's return leaves the op to the next landing
      if (end === "in_pool" && !signal.aborted) await ops.update("ops", id, (v) => (isPoolOp(v) ? { ...withStage(v, "in_pool", (h.now ?? Date.now)()), final: true, ...(endLeft === null ? {} : { follow: { ...v.follow, ...endLeft } }) } : undefined));
    };
    const lm = locks();
    // one follower per op across tabs; two ops of one U_X may run at once, since each deposit from U_X is the page's
    // pool.deposit, one at a time on the device (POOL_DEPOSIT_LOCK), priced on U's own balance read then
    const p: Promise<void> = (lm ? (lm.request(`${POOL_FOLLOW_LOCK}${id}`, { mode: "exclusive", signal }, body) as Promise<void>) : body())
      .catch(() => {})
      .finally(() => {
        if (running.get(id)?.p === p) running.delete(id);
      });
    running.set(id, { p, signal });
    return p;
  };

  // an ended op's U_X read once: covering one deposit's floor, the op is followed again from in_pool (its money read as
  // landed before, so what arrives is carried and the op ends again past its deadline once U_X is under the floor)
  // what U_X holds now, written as its newest op's `left` when that op has ended and the value differs (an op still
  // followed writes its own at its end)
  const writeLeft = async (chain: PoolChain, u: string, low: bigint): Promise<void> => {
    const ops = await h.store();
    let newest: { k: string; v: PoolDepositOp } | undefined;
    for (const k of await ops.keys("ops")) {
      const v = await ops.get("ops", k).catch(() => undefined);
      if (isPoolOp(v) && v.follow.chain === chain && v.follow.u === u && (newest === undefined || v.created_ms > newest.v.created_ms)) newest = { k, v };
    }
    if (newest === undefined || !poolFollowEnded(newest.v) || newest.v.follow.left === low.toString()) return;
    await ops.update("ops", newest.k, (x) => (isPoolOp(x) && poolFollowEnded(x) && x.follow.left !== low.toString() ? { ...x, follow: { ...x.follow, left: low.toString() } } : undefined));
  };
  const followAgain = async (id: string, v: PoolDepositOp): Promise<void> => {
    if (running.get(id)?.signal.aborted === false) return;
    const d = h.again ? h.again(v.follow.chain) : h.deps(v.follow, { move: async () => v.follow.move, record: async () => Promise.reject(new Error("a read records no refund move")) });
    if (d === null) return;
    try {
      const [a, b] = await d.balances(v.follow);
      const low = a < b ? a : b;
      // under one deposit's floor: nothing to carry, and what U_X holds now is its `left` (review r3 P2-1: a restore's
      // carry of a top-up leaves no stale row)
      if (low < d.ladder.min || low < (await d.costs(v.follow)).floor) return void (await writeLeft(v.follow.chain, v.follow.u, low));
    } catch {
      return;
    }
    const ops = await h.store();
    await ops.update("ops", id, (x) => {
      if (!isPoolOp(x) || !poolFollowEnded(x)) return undefined;
      const { final: _final, ...open } = x;
      return open;
    });
    void follow(id, v.follow);
  };

  return {
    /**
     * pool.address checked `quote` under request `id` for U_X (`u`): the op is written and followed. Throws when it
     * cannot be written, so no address goes out that nothing follows.
     */
    async quoted(id: string, chain: PoolChain, quote: { deposit_address: string; origin_asset: string; min_amount_out: string; deadline: string }, u: { scope: bigint; index: number; wallet: string; refundId: string; refund_to?: string }): Promise<void> {
      const deadline = Date.parse(quote.deadline);
      if (!Number.isSafeInteger(deadline)) throw new Error("the quote's deadline is not a time");
      const minOut = baseUnits(quote.min_amount_out, h.decimals(chain));
      if (minOut === null) throw new Error("the quote's min_amount_out is not an amount of the pool's coin");
      const f: PoolFollowRecord = { chain, s: u.scope.toString(), i: u.index, u: u.wallet, refund_id: u.refundId, address: quote.deposit_address, deadline_ms: deadline, origin: quote.origin_asset, min_out: minOut.toString(), ...(u.refund_to === undefined ? {} : { refund_to: u.refund_to }) };
      const ops = await h.store();
      // a plain send's base, read before its address goes out (review P2-c): one read after it, at a later start, would
      // count a send that landed meanwhile as what U_X held before. A read that fails throws, so the address is refused
      // ("down"), as an op that cannot be written is. A retry of the same request keeps the base its op has
      let base: string | undefined;
      if (f.address === f.u && !isPoolOp(await ops.get("ops", id))) {
        const d = h.deps(f, { move: async () => undefined, record: async () => Promise.reject(new Error("a read records no refund move")) });
        if (d === null) throw new Error("no reads for U_X on this page");
        const [a, b] = await d.balances(f);
        base = (a < b ? a : b).toString();
      }
      // a retry of the same request (the same id) keeps the op it made
      await ops.update("ops", id, (v) => (v === undefined ? { kind: "pool_deposit", stage: "quote_checked", txs: [], created_ms: (h.now ?? Date.now)(), follow: base === undefined ? f : { ...f, base } } : undefined));
      const op = await ops.get("ops", id);
      if (!isPoolOp(op) || FOLLOW_KEYS.some((k) => op.follow[k] !== f[k])) throw new Error("the request's op names another deposit");
      void follow(id, f);
    },
    /**
     * Each signed-in landing (`load`: a page load, a sign-in, a resync) and each reopen of the store (no `load`): every
     * pool op no follow has ended is followed again. And each U_X whose ops have all ended is read once (review P2-b of
     * card deposit-takes-each-pools-own-coin): money sent to it after its last op ended (an address used again, a late
     * send) that covers one deposit's floor follows that U_X's newest op again, so it is carried in; under the floor,
     * what it holds is written as that op's `left`. Those reads run one U_X at a time on the host's paced reads, in a
     * drawn order, each after its own drawn wait (review r3 P2-2): at a landing, every one; at a store reopen, those
     * within POOL_AGAIN_FOR_MS of the op's quote or whose end left money there.
     */
    async settle(o: { load?: boolean } = {}): Promise<void> {
      const ops = await h.store();
      const live = new Set<string>();
      const ended = new Map<string, { k: string; v: PoolDepositOp }>();
      for (const k of await ops.keys("ops")) {
        const v = await ops.get("ops", k).catch(() => undefined);
        if (!isPoolOp(v)) continue;
        const ux = `${v.follow.chain}/${v.follow.u}`;
        if (!poolFollowEnded(v) || openHeard(v)) {
          live.add(ux);
          void follow(k, v.follow);
          continue;
        }
        const had = ended.get(ux);
        if (had === undefined || v.created_ms > had.v.created_ms) ended.set(ux, { k, v });
      }
      const t = (h.now ?? Date.now)();
      // a landing reads every ended U_X (a send to an old address is found at the next load: a load's restore reads
      // the U_X only while its step 5 is owed, src/pool-restore.ts resume); a store reopen only the recent and held ones
      const due = [...ended].filter(([ux, { v }]) => !live.has(ux) && (o.load === true || t - v.created_ms <= POOL_AGAIN_FOR_MS || uxHeldOf([v], v.follow.chain, v.follow.u)));
      if (due.length === 0) return;
      // one run at a time, one U_X at a time (review P2-b of the delta), each after a drawn wait: never a user's U_X read in
      // one burst, nor at the instant a landing is read. A landing during a run reads again once it ends
      againDue = due.map(([, x]) => x);
      if (againRun !== null) return;
      const signal = abort.signal;
      againRun = (async () => {
        while (againDue !== null && !signal.aborted) {
          // in a drawn order, each U_X after its own drawn wait (review r3 P2-2): no two of a user's U_X read back to
          // back, and a page closed mid-run reaches the others over the next loads
          const list = shuffledBy(againDue, h.random);
          againDue = null;
          for (const { k, v } of list) {
            if (signal.aborted) break;
            await (h.againWait?.(signal) ?? Promise.resolve()).catch(() => {});
            if (signal.aborted) break;
            await followAgain(k, v);
          }
        }
      })().finally(() => (againRun = null));
    },
    /** A U_X's lower balance read by a restore's carry (src/pool-restore.ts carryUx): its newest ended op's `left`. */
    left: (chain: PoolChain, u: string, low: bigint): Promise<void> => writeLeft(chain, u, low),
    /** This tab's sign out, or the store closing: every follow stops; settle() starts them again. */
    stop(): void {
      abort.abort(new Error("stopped"));
      abort = new AbortController();
    },
    /** Tests: the follows running now. */
    idle: async (): Promise<unknown> => {
      await againRun;
      return Promise.all([...running.values()].map((r) => r.p));
    },
  };
}

/**
 * The page's pool.deposit handler (src/pool-kinds.ts poolKinds, the kind the app asks) run to its end for the follow:
 * its answer, and when that is "sent", the end it posts as progress (filled, part_filled, not_landed; card
 * pool-deposit-sent-end). A kind that posts no end before the signal stops it reads "down" (read again next round).
 */
export function depositToEnd(
  kind: (params: Record<string, unknown>, ctx: { id: string; sha: string; progress(s: string): void; route(): void }) => unknown,
  chain: PoolChain,
  decimals: number,
  amount: bigint,
  signal: AbortSignal,
): Promise<PoolDepositRun> {
  return new Promise<PoolDepositRun>((resolve) => {
    let done = false;
    // the txs the answer named (card pool-deposit-op-txs): the direct answer's landed txs, or the sent answer's sends,
    // whose end then comes as a stage-only progress event. Heard: the follow shows only what its own reads find
    let heard: TxRef[] = [];
    const fin = (e: PoolDepositEnd): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", stop);
      resolve({ end: e, txs: heard });
    };
    const stop = (): void => fin("down");
    if (signal.aborted) return fin("down");
    signal.addEventListener("abort", stop, { once: true });
    const ENDS = new Set(["filled", "part_filled", "not_landed"]);
    const codeOf = (c: unknown): PoolDepositEnd => (c === "not_allowed" || c === "not_funded" || c === "failed" ? c : "down");
    type Answer = { result: { stage: string; txs?: unknown } } | { error: string };
    const read = (a: Answer | null | undefined): void => {
      if (!a) return fin("not_allowed");
      if ("error" in a) return fin(codeOf(a.error));
      heard = Array.isArray(a.result.txs) ? a.result.txs.filter((t): t is TxRef => typeof t === "object" && t !== null && (t as TxRef).chain === chain && typeof (t as TxRef).hash === "string").map((t) => ({ chain: t.chain, hash: t.hash })) : [];
      if (ENDS.has(a.result.stage)) fin(a.result.stage as PoolDepositEnd);
      // "sent": its end comes as progress
    };
    const s = amount.toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
    let r: unknown;
    try {
      r = kind({ chain, amount: frac ? `${whole}.${frac}` : whole }, {
        id: `pool-follow-${chain}`,
        sha: "",
        progress: (st) => void (ENDS.has(st) && fin(st as PoolDepositEnd)),
        route: () => {},
      });
    } catch {
      return fin("down");
    }
    if (r === null || typeof r !== "object") return fin("not_allowed");
    if ("after" in r) {
      const d = r as { after: Promise<void>; answer(): Answer | null };
      d.after.then(() => read(d.answer()), () => fin("down"));
    } else read(r as Answer);
  });
}

// ------------------------------------------------------------------------------------------------ the refund carry

/**
 * The refund carry for one pool op (the follow's `refund`): what U_{s,i} holds of the quote's origin inside intents.near,
 * read at one block on NEAR's two RPCs (the wallet's readMoveAt), moved by the wallet's runRefundMove with U_{s,i} as
 * the signer under this page's rules: the request poolRefundMoveRequest's (X's coin, to U_X, refunded under the id),
 * its quote checkPoolRefundQuote's (min out over the pool's floor read now), its intent checkIdTransferIntent's, signed
 * by signIdIntent with the key opened only for the signature (the seed under its lock, U_{s,i} checked, both zeroed).
 * - The move is recorded in the op (`record`) before it is sent. While a recorded move's nonce reads unused at a block
 *   inside its deadline, nothing new is signed ("wait"); its nonce read used, the money is on its way to U_X ("moved",
 *   the rounds carry it); past its deadline unused, a new move may go, the earlier deadline handed to the rule.
 * - Nothing held: "none". A read that does not agree: "wait", read again next round. Money read under U_{s,i} on both
 *   RPCs that is not moved this round (no price read, a quote that fails a check, one under the pool's floor among them:
 *   it waits under U_{s,i}, a relayer that refuses, a seed that is not U_{s,i}'s): "held", read again next round; the
 *   follow shows refunded on "held" and "moved" alone (review P2).
 */
export interface PoolRefundHost {
  /** NEAR mainnet's two RPCs (FastNEAR and dRPC) and intents.near. */
  read(f: PoolFollowRecord, nonce: string | null): Promise<MoveRead | null>;
  /** The pool's floor now (solanaPoolDepositFloor or evmPoolDepositFloor at reads made now). */
  floor(f: PoolFollowRecord): Promise<bigint>;
  /** The device's own two price reads of the origin and X's coin, and the origin's decimals; null when it has none. */
  priced(f: PoolFollowRecord): { decimalsIn: number; pricing: Exclude<OneClickPricing, "usdc"> } | null;
  decimals(chain: PoolChain): number;
  /** The 64-byte seed, opened under the wallet's seed lock (shared), zeroed here. */
  seed64(): Promise<Uint8Array>;
  seedLock<T>(fn: () => Promise<T>): Promise<T>;
  /** The op's recorded move, and its write (before the send; and the move's tx as heard, then read final). */
  move(): Promise<PoolMove | undefined>;
  record(m: PoolMove): Promise<void>;
  /** A heard move tx read FINAL with success on both of NEAR's RPCs, sent by the release's relayer, carrying `intent`
   *  alone (nearTxFinal on FastNEAR and dRPC unless given). */
  tx?(hash: string, intent: { signer: string; nonce: string }): Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** `intent` (its signer and nonce) is the one intent `action` carries: the relayer carries each intent in its own tx
 *  (apps/helper/src/intents/carry.ts: execute_intents with args {signed: [one]}). */
function carriesIntent(action: unknown, intent: { signer: string; nonce: string }): boolean {
  const call = action !== null && typeof action === "object" ? (action as { FunctionCall?: unknown }).FunctionCall : undefined;
  if (call === null || typeof call !== "object") return false;
  const { method_name, args } = call as { method_name?: unknown; args?: unknown };
  if (method_name !== "execute_intents" || typeof args !== "string") return false;
  const a = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64.decode(args))) as { signed?: unknown } | null;
  if (a === null || typeof a !== "object" || !Array.isArray(a.signed) || a.signed.length !== 1) return false;
  const s = a.signed[0] as { payload?: unknown } | null;
  if (s === null || typeof s !== "object" || typeof s.payload !== "string") return false;
  const p = JSON.parse(s.payload) as { signer_id?: unknown; nonce?: unknown } | null;
  return p !== null && typeof p === "object" && p.signer_id === intent.signer && p.nonce === intent.nonce;
}

/**
 * True only when both RPCs read the NEAR tx `hash` FINAL (every receipt done) with a success status, the tx itself
 * (its hash) sent by the release's relayer (RELEASE_RELAYER.mainnet, which carries every id's intent from
 * bind.<ours>.near) to intents.near, as one execute_intents call that carries `intent` alone (its signer U_{s,i} and its
 * nonce; review P1: never another move the same relayer carried). Anything else, an error or no answer on either, is
 * false (card pool-deposit-op-txs).
 */
export async function nearTxFinal(rpcs: readonly [Pick<BindRpc, "tx">, Pick<BindRpc, "tx">], hash: string, intent: { signer: string; nonce: string }): Promise<boolean> {
  const relayer = RELEASE_RELAYER.mainnet;
  if (relayer === null) return false;
  const one = async (rpc: Pick<BindRpc, "tx">): Promise<boolean> => {
    try {
      const a = (await rpc.tx({ tx_hash: hash, sender_account_id: relayer, wait_until: "FINAL" })) as { error?: unknown; result?: unknown } | null;
      const r = a !== null && typeof a === "object" && a.error === undefined ? (a.result as Record<string, unknown> | undefined) : undefined;
      if (r === null || typeof r !== "object" || r.final_execution_status !== "FINAL") return false;
      const st = r.status as Record<string, unknown> | null;
      if (st === null || typeof st !== "object" || !Object.hasOwn(st, "SuccessValue") || Object.hasOwn(st, "Failure")) return false;
      const t = r.transaction as Record<string, unknown> | null;
      if (t === null || typeof t !== "object" || t.hash !== hash || t.signer_id !== relayer || t.receiver_id !== "intents.near") return false;
      return Array.isArray(t.actions) && t.actions.length === 1 && carriesIntent(t.actions[0], intent);
    } catch {
      return false;
    }
  };
  const [a, b] = await Promise.all([one(rpcs[0]), one(rpcs[1])]);
  return a && b;
}

/** The refund carry, and its `settle`: a heard move tx read final (true once nothing is left to read). */
export type PoolRefundMover = ((f: PoolFollowRecord, signal: AbortSignal) => Promise<RefundRead>) & { settle(f: PoolFollowRecord): Promise<boolean> };

export function poolRefundMover(h: PoolRefundHost): PoolRefundMover {
  const now = h.now ?? Date.now;
  const txFinal = h.tx ?? ((hash: string, intent: { signer: string; nonce: string }) => nearTxFinal([followRpc(NEAR_NETWORKS.mainnet.fastnear[0]), followRpc(NEAR_NETWORKS.mainnet.drpc)], hash, intent));
  // each heard move tx, on its own (card pool-deposit-op-txs; review P3 1): final once its move's nonce reads used on
  // both RPCs at one block and the tx reads FINAL with success on both, carrying that move's intent alone (review P1).
  // Let go (dropped, never shown) only when its nonce reads unused past its deadline on the chain's clock: it can never
  // land. It holds the end while it may still settle: past its deadline and the margin (the chain's clock, or the
  // device's when the reads do not agree; review P2-b), or with no finite deadline (re-check P3-1), it no longer holds
  // it and stays open, read again at later landings (re-check P3-2: a move that landed late still shows its tx), until
  // POOL_TX_READ_LIMIT_MS past its deadline on the chain's clock (or at once with no finite deadline): then unread, never
  // read again (re-check 2 and 3 P3). `r` is the round's read at the move `m`'s nonce. True: nothing holds the end
  const settleAll = async (f: PoolFollowRecord, m: PoolMove | undefined, r?: MoveRead | null): Promise<boolean> => {
    const open = (m?.txs ?? []).filter(openTx);
    if (m === undefined || open.length === 0) return true;
    const done: PoolHeardTx[] = [];
    let holds = 0;
    for (const t of open) {
      const at = r !== undefined && t.nonce === m.nonce ? r : await h.read(f, t.nonce).catch(() => null);
      const timed = Number.isFinite(t.deadline_ms);
      const late = (clock: number) => !timed || clock > t.deadline_ms + POOL_TX_READ_MARGIN_MS;
      if (at !== null && at.used === true && (await txFinal(t.hash, { signer: f.refund_id, nonce: t.nonce }).catch(() => false))) done.push({ ...t, final: true });
      else if (at !== null && at.used !== true && timed && at.timeMs > t.deadline_ms) done.push({ ...t, dropped: true });
      // unread on the chain's clock only (re-check 3 P3): a device clock set ahead never retires a live tx
      else if (!timed || (at !== null && at.timeMs > t.deadline_ms + POOL_TX_READ_LIMIT_MS)) done.push({ ...t, unread: true });
      else if (!late(at === null ? now() : at.timeMs)) holds++;
    }
    if (done.length > 0) await h.record({ ...m, txs: done });
    return holds === 0;
  };
  const mover = async (f: PoolFollowRecord, signal: AbortSignal): Promise<RefundRead> => {
    const m = await h.move();
    const r = await h.read(f, m?.nonce ?? null);
    if (r === null) return "wait";
    await settleAll(f, m, r).catch(() => false);
    let prior: number | null = null;
    if (m !== undefined) {
      // through on its nonce: that money is on its way to U_X (the rounds carry it); anything held now is other money
      // (a second refund), moved by a new move
      if (r.used !== true) {
        if (r.timeMs <= m.deadline_ms) return "wait"; // in its window: never a second intent for the same money
        prior = m.deadline_ms;
      }
    }
    if (r.held === 0n) return "none";
    // money under U_{s,i} on both RPCs from here: "held" unless it moves
    const priced = h.priced(f);
    if (priced === null) return "held";
    const floor = await h.floor(f).catch(() => null);
    if (floor === null) return "held";
    const signer = { role: "U" as const, id: f.refund_id, publicKey: hex.decode(f.refund_id) };
    const decimalsOut = h.decimals(f.chain);
    const res = await runRefundMove<RefundQuote, IdIntent>(
      { u: f.refund_id, asset: f.origin, reads: r.reads, height: r.height, salt: r.salt, priorMs: prior },
      {
        request: (u, asset, amount, at) => poolRefundMoveRequest(f.chain, f.u, u, asset, amount, at),
        check: {
          quote: (request, answer) => {
            // the price as it is at the check (card pool-usd-price-never-stale, review P1): the floor read and the quote took
            // seconds, and the price taken before them may be past its bound by now. None, or other decimals: refused
            const atCheck = h.priced(f);
            if (atCheck === null || atCheck.decimalsIn !== priced.decimalsIn) throw new RefundRuleRefused("price");
            return checkPoolRefundQuote(request, answer, { network: "mainnet", signer, origin: f.origin, chain: f.chain, wallet: f.u, floor, check: { path: DEPOSIT_QUOTE_PATH, pricing: atCheck.pricing, decimalsIn: atCheck.decimalsIn, decimalsOut, now: now() } });
          },
          read: (q) => ({ depositAddress: q.depositAddress as string, amountIn: q.amountIn, deadlineMs: Date.parse(q.deadline as string) }),
          intent: (payload, q, reads, priorDeadline) => checkIdTransferIntent(payload, q, { network: "mainnet", signer, reads, priorDeadline }),
          sign: (secretKey, intent) => signIdIntent(secretKey, intent) as HelperSignedIntent,
        },
        openKey: <T,>(fn: (secretKey: Uint8Array) => T) =>
          h.seedLock(async () => {
            const seed = await h.seed64();
            try {
              if (!(seed instanceof Uint8Array) || seed.length !== 64) throw new Error("seed64 must be 64 bytes");
              const k = depositId(seed, BigInt(f.s), f.i);
              try {
                if (k.id !== f.refund_id) throw new Error("the seed's U_{s,i} is not the op's refund id");
                return fn(k.secretKey);
              } finally {
                k.secretKey.fill(0);
              }
            } finally {
              seed.fill(0);
            }
          }),
        record: (mv) => h.record(mv),
        now,
        signal,
        ...(h.fetch ? { fetchFn: h.fetch } : {}),
      },
    ).catch(() => null);
    // the relayer's tx as heard, kept with the move it carried (never shown until settle reads it final); a write that
    // fails changes nothing of the move's outcome
    if (res !== null && res.kind === "sent" && res.tx !== null) await h.record({ ...res.move, txs: [{ hash: res.tx, nonce: res.move.nonce, deadline_ms: res.move.deadline_ms }] }).catch(() => {});
    return res !== null && res.kind === "sent" && res.status >= 200 && res.status < 300 ? "moved" : "held";
  };
  return Object.assign(mover, {
    settle: async (f: PoolFollowRecord): Promise<boolean> => settleAll(f, await h.move()),
  });
}

// ------------------------------------------------------------------------------------------------ Solana's reads

const lamports = (v: unknown): bigint => {
  const x = (v as { value?: unknown } | null)?.value;
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new Error("not a balance");
  return BigInt(x as number);
};

/** A Solana signature: base58 of 64 bytes. */
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** U_X's signatures both RPCs answered as finalized txs that are no deposit into the pool (review P3 2), by pool, U_X
 *  and signature: never read again on this page (a finalized tx never changes). */
const NOT_DEPOSIT = new Set<string>();

/** A top-level instruction's data (base58 in the json encoding) that starts with the pool's deposit tag (review P3 3). */
const isDepositData = (d: unknown): boolean => {
  if (typeof d !== "string") return false;
  try {
    return base58.decode(d)[0] === SOLANA_POOL_TAG_DEPOSIT;
  } catch {
    return false;
  }
};

/**
 * A finalized getTransaction answer (json encoding) of `sig` that is a deposit from U_X into the pool: its first
 * signature is `sig`, U_X its fee payer (solanaPoolDepositTx: the depositor is its one signer and fee payer), no error,
 * and a top-level instruction of `program` whose data is the deposit's (SOLANA_POOL_TAG_DEPOSIT first). Anything else is
 * not.
 */
function isPoolDepositTx(t: unknown, sig: string, u: string, program: string): boolean {
  if (t === null || typeof t !== "object") return false;
  const meta = (t as { meta?: unknown }).meta as { err?: unknown } | null | undefined;
  const tx = (t as { transaction?: unknown }).transaction as { signatures?: unknown; message?: unknown } | null | undefined;
  if (meta === null || typeof meta !== "object" || meta.err !== null || tx === null || typeof tx !== "object") return false;
  if (!Array.isArray(tx.signatures) || tx.signatures[0] !== sig) return false;
  const msg = tx.message as { accountKeys?: unknown; instructions?: unknown } | null | undefined;
  if (msg === null || typeof msg !== "object" || !Array.isArray(msg.accountKeys) || msg.accountKeys[0] !== u || !Array.isArray(msg.instructions)) return false;
  const keys = msg.accountKeys;
  return msg.instructions.some(
    (ix) => ix !== null && typeof ix === "object" && Number.isSafeInteger((ix as { programIdIndex?: unknown }).programIdIndex) && keys[(ix as { programIdIndex: number }).programIdIndex] === program && isDepositData((ix as { data?: unknown }).data),
  );
}

/**
 * The follow's reads on Solana (the pool kinds' own pair, two operators): 1Click's status through the helper for U_X
 * and U_{s,i}; U_X's balance at finalized on each RPC; one deposit's costs from the fee and the Rent sysvar read now
 * (readSolanaPoolCosts: the floor the quote was held to, its worst-case cost per rung and the rent U_X keeps); the
 * quote's deadline past on both RPCs' finalized block time; U_X's deposits into the pool that both RPCs read landed
 * (`landed`, isPoolDepositTx). `deposit` is the page's pool.deposit (depositToEnd).
 */
export function solanaPoolFollowDeps(o: { rpcs: readonly [SolanaRpc, SolanaRpc]; program: string; deposit: PoolFollowDeps["deposit"]; refund?: PoolFollowDeps["refund"]; fetch?: typeof fetch; sleep?: PoolFollowDeps["sleep"] }): Omit<PoolFollowDeps, "stage" | "signal" | "txs"> {
  const both = <T,>(f: (r: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(o.rpcs[0]), f(o.rpcs[1])]);
  return {
    status: (f, signal) => readDepositStatus(f.address, f.u, o.fetch ?? fetch, signal, Date.now(), f.refund_to ?? f.refund_id),
    balances: (f) => both(async (r) => lamports(await r("getBalance", [f.u, { commitment: "finalized" }]))),
    costs: async (f) => {
      const { fee, rent } = await readSolanaPoolCosts(o.rpcs, o.program, f.u);
      const floor = solanaPoolDepositFloor(fee, rent), keep = solanaRentMin(rent, 0);
      return { floor, perRung: floor - SOL_LADDER.min - keep, keep };
    },
    ladder: SOL_LADDER,
    deposit: o.deposit,
    past: async (f) => {
      const times = await both(async (r) => {
        const slot = await r("getSlot", [{ commitment: "finalized" }]);
        const t = await r("getBlockTime", [slot]);
        if (!Number.isSafeInteger(t)) throw new Error("no block time");
        return (t as number) * 1000;
      });
      return times.every((t) => t > f.deadline_ms);
    },
    landed: async (f, heard, known) => {
      const skip = known ?? new Set<string>();
      // U_X's own finalized signatures on both RPCs (a listing that fails throws: read again), and the run's heard ones
      const lists = await both((r) => r("getSignaturesForAddress", [f.u, { commitment: "finalized", limit: 1000 }]));
      const cands: string[] = [];
      const add = (h: unknown) => void (typeof h === "string" && SOL_SIG.test(h) && !skip.has(h) && !cands.includes(h) && cands.push(h));
      for (const t of heard) if (t.chain === "solana") add(t.hash);
      for (const l of lists) if (Array.isArray(l)) for (const x of l) if (x !== null && typeof x === "object" && (x as { err?: unknown }).err === null) add((x as { signature?: unknown }).signature);
      const out: TxRef[] = [];
      for (const sig of cands) {
        const key = `${o.program}/${f.u}/${sig}`;
        if (NOT_DEPOSIT.has(key)) continue;
        // review P2-a: a read that fails or answers null (not indexed yet) on either RPC is no answer, and two answers
        // that disagree are none either: landed throws, read again. A tx is rejected only once both answered no deposit
        const reads = await both((r) => r("getTransaction", [sig, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]));
        if (reads.some((t) => t === null || typeof t !== "object")) throw new Error("a tx not read on both RPCs");
        const [a, b] = reads.map((t) => isPoolDepositTx(t, sig, f.u, o.program));
        if (a !== b) throw new Error("the RPCs disagree on a tx");
        if (a) out.push({ chain: "solana", hash: sig });
        else NOT_DEPOSIT.add(key);
      }
      return out;
    },
    ...(o.refund ? { refund: o.refund } : {}),
    sleep: o.sleep ?? followSleep,
  };
}

/** The follow's wait between rounds: `ms`, or until the signal (a sign out). */
const followSleep: PoolFollowDeps["sleep"] = (ms, signal) => new Promise<void>((ok) => {
  const t = setTimeout(done, ms);
  function done() {
    clearTimeout(t);
    signal.removeEventListener("abort", done);
    ok();
  }
  signal.addEventListener("abort", done, { once: true });
});

// -------------------------------------------------------------------------------------------- Base's and Robinhood's

/** A JSON-RPC quantity from a provider: hostile until read. */
const evmQuantity = (x: unknown, what: string): bigint => {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(x)) throw new Error(`${what}: not a quantity`);
  return BigInt(x);
};

/**
 * The follow's reads on Base and Robinhood (card evm-deposit-route-mainnet), as solanaPoolFollowDeps on Solana:
 * 1Click's status through the helper for U_X and U_{s,i}; U_X's balance at the latest block (Robinhood serves no
 * finalized state), polled on `wallet` alone when given (its one reading as both: the helper's POST /v1/rpc/{chain} on
 * mainnet, decision M359: a one-time account's holdings never reach a public provider from the device), else on each
 * of the pool's two RPCs (a testnet page). The poll only starts a deposit: pool.deposit (`deposit`, from U_X alone)
 * reads U_X again on the pool's two RPCs before U_X signs. One deposit's costs: the quote's floor read now on the
 * pool's two RPCs (readEvmPoolFloor: the rung, the capped gas with the tree's headroom at 2 x base fee + tip, the L1
 * fee; names no account), its per-rung cost the floor less the rung, nothing kept (an EVM account has no rent). The
 * quote's deadline past on both RPCs' latest block time. With the page's notes (`notes`), `landed` as Solana's (card
 * evm-deposit-route-mainnet review): the txs of U_X's deposits into the pinned pool that both of the pool's RPCs read
 * succeeded, from U_X, at or under each one's finalized block, the two alike: each landed note of U_X's own its one send
 * that did, and the run's heard txs. One hash a request; a read that fails, or a heard tx not read yet, throws (read
 * again); a send no RPC holds (one it replaced landed) is passed.
 */
export function evmPoolFollowDeps(o: { rpcs: readonly [EvmRpc, EvmRpc]; pin: EvmPoolPin; wallet?: EvmRpc; deposit: PoolFollowDeps["deposit"]; refund?: PoolFollowDeps["refund"]; notes?: () => Promise<readonly NoteRecord[]>; fetch?: typeof fetch; sleep?: PoolFollowDeps["sleep"] }): Omit<PoolFollowDeps, "stage" | "signal" | "txs"> {
  const both = <T,>(f: (r: EvmRpc, k: number) => Promise<T>): Promise<[T, T]> => Promise.all([f(o.rpcs[0], 0), f(o.rpcs[1], 1)]);
  const balanceOn = async (r: EvmRpc, u: string, what: string) => evmQuantity(await r("eth_getBalance", [u, "latest"]), what);
  return {
    status: (f, signal) => readDepositStatus(f.address, f.u, o.fetch ?? fetch, signal, Date.now(), f.refund_to ?? f.refund_id),
    balances: async (f) => {
      if (o.wallet === undefined) return both((r, k) => balanceOn(r, f.u, `rpc ${k} U_X balance`));
      const b = await balanceOn(o.wallet, f.u, "U_X balance");
      return [b, b] as const;
    },
    // the end's read (review P1): the pool's two RPCs, U_X alone in each request; never the wallet reader
    ...(o.wallet === undefined ? {} : { chainBalances: (f: Pick<PoolUx, "u">) => both((r, k) => balanceOn(r, f.u, `rpc ${k} U_X balance`)) }),
    costs: async () => {
      const floor = await readEvmPoolFloor(o.rpcs, o.pin);
      return { floor, perRung: floor - EVM_LADDER.min, keep: 0n };
    },
    ladder: EVM_LADDER,
    deposit: o.deposit,
    past: async (f) => {
      const times = await both(async (r, k) => evmQuantity(((await r("eth_getBlockByNumber", ["latest", false])) as { timestamp?: unknown } | null)?.timestamp, `rpc ${k} block time`) * 1000n);
      return times.every((t) => t > BigInt(f.deadline_ms));
    },
    ...(o.refund ? { refund: o.refund } : {}),
    ...(o.notes === undefined ? {} : { landed: (f: PoolFollowRecord, heard: readonly TxRef[], known?: ReadonlySet<string>) => evmLanded(o.rpcs, o.pin, o.notes!, f, heard, known) }),
    sleep: o.sleep ?? followSleep,
  };
}

const EVM_HASH = /^0x[0-9a-f]{64}$/;
/** One tx's read on one RPC: a deposit landed (succeeded from U_X to the pool, at or under its finalized block), not one
 *  (failed, or another sender or target), or not held (null). */
async function evmTxRead(r: EvmRpc, hash: string, u: string, pool: string): Promise<"landed" | "not" | null> {
  const [rc, fin] = await Promise.all([r("eth_getTransactionReceipt", [hash]), r("eth_getBlockByNumber", ["finalized", false])]);
  if (rc === null) return null;
  const x = rc as { status?: unknown; from?: unknown; to?: unknown; blockNumber?: unknown };
  const at = evmQuantity(x.blockNumber, "receipt block");
  const final = evmQuantity((fin as { number?: unknown } | null)?.number, "finalized block");
  if (at > final) return null;
  return x.status === "0x1" && typeof x.from === "string" && x.from.toLowerCase() === u.toLowerCase() && typeof x.to === "string" && x.to.toLowerCase() === pool.toLowerCase() ? "landed" : "not";
}
async function evmLanded(rpcs: readonly [EvmRpc, EvmRpc], pin: EvmPoolPin, notes: () => Promise<readonly NoteRecord[]>, f: PoolFollowRecord, heard: readonly TxRef[], known?: ReadonlySet<string>): Promise<TxRef[]> {
  const skip = known ?? new Set<string>();
  const both = async (h: string) => {
    const [a, b] = await Promise.all([evmTxRead(rpcs[0], h, f.u, pin.pool), evmTxRead(rpcs[1], h, f.u, pin.pool)]);
    if (a !== b) throw new Error("the RPCs read a deposit tx apart");
    return a;
  };
  const out: TxRef[] = [];
  const add = (h: string) => void (!skip.has(h) && !out.some((t) => t.hash === h) && out.push({ chain: f.chain, hash: h }));
  for (const t of heard) {
    if (t.chain !== f.chain || !EVM_HASH.test(t.hash) || skip.has(t.hash)) continue;
    const r = await both(t.hash);
    if (r === null) throw new Error("a heard deposit tx not read final yet");
    if (r === "landed") add(t.hash);
  }
  for (const n of await notes()) {
    if (!NOTE_LANDED.includes(n.state) || !ofUx(n, f)) continue;
    const sends = (n.evmSends ?? []).map((x) => x.hash).filter((h) => EVM_HASH.test(h));
    if (sends.some((h) => skip.has(h) || out.some((t) => t.hash === h))) continue;
    let found = false;
    for (const h of sends) if ((await both(h)) === "landed") ((found = true), add(h));
    if (!found && sends.length > 0) throw new Error("a landed note's send not read yet");
  }
  return out;
}

/**
 * Base's and Robinhood's route for a pool quote into U_X on this page (card evm-deposit-route-mainnet; src/main.ts):
 * the pool the page pins on the chain (`pool`: its pin and the deposit's own pair) and the one reader U_X's balance is
 * polled on (`wallet`: on mainnet the helper's POST /v1/rpc/{chain}, decision M359: a one-time account's holdings never
 * reach a public provider from the device). A testnet page polls the pool's pair (1Click pays out on mainnet only, so no
 * quote is asked there). With no pool, or on any page not testnet with no reader: no floor (so pool.address shows no
 * address, pool-deposit-address.ts) and no follow.
 */
export function evmQuoteRoute(o: { network: string; pool(chain: "base" | "robinhood"): { pin: EvmPoolPin; rpcs: readonly [EvmRpc, EvmRpc] } | null; wallet(chain: "base" | "robinhood"): EvmRpc | undefined; notes?: () => Promise<readonly NoteRecord[]> }) {
  const poolOf = (chain: PoolChain) => {
    if (chain === "solana") return null;
    const e = o.pool(chain);
    if (e === null) return null;
    const wallet = o.wallet(chain);
    if (o.network !== "testnet" && wallet === undefined) return null;
    return { ...e, ...(wallet === undefined ? {} : { wallet }) };
  };
  return {
    /** The quote's floor on X's pool, read now on its two RPCs; null with no route. */
    floor: async (chain: PoolChain): Promise<bigint | null> => {
      const e = poolOf(chain);
      return e === null ? null : readEvmPoolFloor(e.rpcs, e.pin);
    },
    /** The follow's reads on X, with the deposit from U_X and the refund carry at that floor; null with no route. */
    deps: (chain: PoolChain, deposit: PoolFollowDeps["deposit"], refundAt: (floor: () => Promise<bigint>) => NonNullable<PoolFollowDeps["refund"]>) => {
      const e = poolOf(chain);
      return e === null ? null : evmPoolFollowDeps({ ...e, deposit, refund: refundAt(() => readEvmPoolFloor(e.rpcs, e.pin)), ...(o.notes === undefined ? {} : { notes: o.notes }) });
    },
  };
}
