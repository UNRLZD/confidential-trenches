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
// - Pace: FAST_MS while a status shows a send in flight or a deposit ran; else SLOW_MS doubling to SLOW_MAX_MS.
// Nothing here logs. Every read names one public account (U_X) or the quote's deposit address; no request carries a
// key, the words, or which note is whose.
import type { PoolChain, PoolDepositStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { ladderSplit, type Ladder } from "../../wallet/src/pool/ladder.ts";
import { followRpc, type MoveRead, type OneClickStatus, readDepositStatus, type StatusRead } from "../../wallet/src/deposit/follow.ts";
import { NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";
import { type BindRpc, RELEASE_RELAYER } from "../../wallet/src/deposit/bind.ts";
import { solanaRentMin } from "../../kit/src/trade/solana/pool-buy.ts";
import { SOLANA_POOL_TAG_DEPOSIT } from "../../kit/src/trade/solana/pool-deposit.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { readSolanaPoolCosts } from "./pool-deposit-address.ts";
import { solanaPoolDepositFloor } from "./pool-deposit-quote.ts";
import { base58, base64, hex } from "@scure/base";
import type { OneClickPricing } from "../../kit/src/checks/oneclick.ts";
import type { HelperSignedIntent } from "../../kit/src/helper/v1.ts";
import { depositId } from "../../wallet/src/derive/keys.ts";
import { type MoveRecord, poolRefundMoveRequest, runRefundMove } from "../../wallet/src/deposit/refund.ts";
import { DEPOSIT_QUOTE_PATH } from "./rules/deposit-dry.ts";
import { checkIdTransferIntent, checkPoolRefundQuote, signIdIntent, type IdIntent, type RefundQuote } from "./rules/refund.ts";

/** What a reload needs to follow the quote again (written in the op under `follow`; nothing secret). */
export interface PoolFollowRecord {
  chain: PoolChain;
  /** The pool's scope and the planned index U_X was named at. */
  s: string;
  i: number;
  /** U_X (base58 on Solana, EIP-55 on EVM) and U_{s,i}'s 64-hex id, where a refund lands. */
  u: string;
  refund_id: string;
  /** The quote's signed deposit address, deadline and origin, and its min out in the pool coin's base units. */
  address: string;
  deadline_ms: number;
  origin: string;
  min_out: string;
  /** The refund carry's last move (poolRefundMover), written before it is sent. */
  move?: PoolMove;
}

/** A refund move's NEAR tx as the relayer answered it (card pool-deposit-op-txs), kept with the move it carried (its
 *  nonce and deadline): heard, never shown; `final` once the device read it final on both RPCs (shown); `dropped` once
 *  let go unread (never shown). */
export type PoolHeardTx = { hash: string; nonce: string; deadline_ms: number; final?: true; dropped?: true };
/** A refund move as the op keeps it: the wallet's record, and every move's heard tx so far (review P3 1: a new move
 *  never drops an earlier move's tx before it is settled). */
export type PoolMove = MoveRecord & { txs?: PoolHeardTx[] };

/** How long past a move's (or the quote's) deadline the device keeps reading a tx that does not read final, or reads
 *  that do not agree, before it lets them go (review P2-b): a follow always ends. */
export const POOL_TX_READ_MARGIN_MS = 10 * 60_000;

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

export interface PoolFollowDeps {
  /** 1Click's status of the quote's address for U_X and U_{s,i} (readDepositStatus with the refund id), or null. */
  status(f: PoolFollowRecord, signal: AbortSignal): Promise<StatusRead | null>;
  /** U_X's balance at finalized on X's two RPCs (each its own read). Throws when a read fails. */
  balances(f: PoolFollowRecord): Promise<readonly [bigint, bigint]>;
  /** The least U_X must hold for one deposit, and what one deposit costs on top of its rung (worst case), and the
   *  rent U_X keeps after it (0 on EVM), read on two RPCs at the round's time. */
  costs(f: PoolFollowRecord): Promise<{ floor: bigint; perRung: bigint; keep: bigint }>;
  /** The pool's ladder on X. */
  ladder: Ladder;
  /** The page's pool.deposit on X from U_X, for `amount`, to its end, with the txs its answer named. */
  deposit(f: PoolFollowRecord, amount: bigint, signal: AbortSignal): Promise<PoolDepositRun>;
  /** The quote's deadline past on both RPCs' clocks. */
  past(f: PoolFollowRecord): Promise<boolean>;
  /** The refund carry: what U_{s,i} holds inside intents.near moved back to X's coin, to U_X; none, and a refund waits.
   *  Its `settle` (poolRefundMover's) reads a heard move tx final; true once nothing is left to read. */
  refund?: ((f: PoolFollowRecord, signal: AbortSignal) => Promise<RefundRead>) & { settle?(f: PoolFollowRecord): Promise<boolean> };
  /** The txs of U_X's deposits into X's pool that both RPCs read landed: `heard` (a run's answer) and U_X's own, less
   *  `known` (already shown). Throws when a read fails (card pool-deposit-op-txs). */
  landed?(f: PoolFollowRecord, heard: readonly TxRef[], known?: ReadonlySet<string>): Promise<TxRef[]>;
  /** The op's stage written (and posted to the app in state.ops). */
  stage(s: PoolFollowStage): Promise<void>;
  /** Txs read landed, added to the op's txs (each once). */
  txs?(t: TxRef[]): Promise<void>;
  /** The device's clock (Date.now unless given): the end's tx read is bounded by the quote's deadline and the margin. */
  now?: () => number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
}

export const POOL_FOLLOW_FAST_MS = 2_000;
export const POOL_FOLLOW_SLOW_MS = 15_000;
export const POOL_FOLLOW_SLOW_MAX_MS = 60_000;

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
  let slow = POOL_FOLLOW_SLOW_MS;
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
  for (;;) {
    if (deps.signal.aborted) return shown;
    let fast = false;
    try {
      // the chain first: U_X's money, the lower of two RPCs at finalized, carried into the pool while it covers a deposit
      const [a, b] = await deps.balances(f);
      const low = a < b ? a : b;
      // the costs' reads only once U_X holds at least the least rung (review L2): none while it holds nothing
      const c = low >= deps.ladder.min ? await deps.costs(f) : null;
      if (c !== null && low >= c.floor) {
        const amount = askOf(deps.ladder, low, c.perRung, c.keep);
        if (amount > 0n) {
          const { end, txs } = await deps.deposit(f, amount, deps.signal);
          // landed: the next round reads what is left at once; anything else (not landed, refused, down) is read again
          // at the slow pace, so a deposit that cannot go is never asked in a tight loop
          if (end === "filled" || end === "part_filled") {
            landed = true;
            fast = true;
            await show("in_pool");
          }
          // its txs as both RPCs read them; a read that fails leaves them to the read before the end
          await carryTxs(txs).catch(() => {});
        }
      } else if (landed) {
        // nothing left under U_X to carry: read on to the quote's deadline, so a late send is carried too
        if (shown !== "in_pool") await show("in_pool");
        if (await deps.past(f)) {
          // the end only once every landed tx is read (a failed read: read again next round, until the margin past the
          // later of the quote's deadline and this follow's first end is past on the device's clock, then the end with
          // the txs read so far; review P2-b, re-check P2), and no refund move's heard tx holds it (poolRefundMover's
          // settle, bounded the same way)
          const read = await carryTxs([]).then(() => true, () => false);
          const t = (deps.now ?? Date.now)();
          endSince ??= t;
          if (!read && t <= Math.max(f.deadline_ms, endSince) + POOL_TX_READ_MARGIN_MS) throw new Error("read the txs again");
          if (!deps.refund?.settle || (await deps.refund.settle(f))) return shown;
        }
      } else {
        const st = await deps.status(f, deps.signal);
        let refund: RefundRead | null = null;
        if (st !== null && "status" in st) {
          // REFUNDED shows nothing the chain has not read: refunded only once the carry's read finds the money under
          // U_{s,i} on both of NEAR's RPCs (a refund being moved stays shown as moved: RANK)
          if (st.status !== "REFUNDED") await show(POOL_STATUS_STAGE[st.status]);
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
        if (shown === "quote_checked" && unseen && (await deps.past(f))) await show("expired");
      }
    } catch {
      if (deps.signal.aborted) return shown;
    }
    if (fast) slow = POOL_FOLLOW_SLOW_MS;
    await deps.sleep(fast ? POOL_FOLLOW_FAST_MS : slow, deps.signal);
    if (!fast) slow = Math.min(slow * 2, POOL_FOLLOW_SLOW_MAX_MS);
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

const FOLLOW_KEYS = ["chain", "s", "i", "u", "refund_id", "address", "deadline_ms", "origin", "min_out"] as const;
const isPoolOp = (v: unknown): v is PoolDepositOp =>
  typeof v === "object" && v !== null && (v as PoolDepositOp).kind === "pool_deposit" && typeof (v as PoolDepositOp).follow === "object" && (v as PoolDepositOp).follow !== null;
/** A pool op's follow ended: in_pool read on past its quote's deadline. Every other op is followed again at each landing. */
export const poolFollowEnded = (op: Pick<PoolDepositOp, "stage" | "final">): boolean => op.stage === "in_pool" && op.final === true;
/** A refund move's heard tx neither read final nor let go (re-check P3-2): an ended op with one is read again at each
 *  landing (its refund carry's settle only), so a move that landed late still shows its tx. */
const openHeard = (op: PoolDepositOp): boolean => (op.follow.move?.txs ?? []).some((t) => t.final !== true && t.dropped !== true);

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
}

export function poolFollows(h: PoolFollowHost) {
  const running = new Map<string, { p: Promise<void>; signal: AbortSignal }>();
  let abort = new AbortController();
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
      const end = await followPoolQuote(f, { ...d, stage, txs, signal }, now.stage);
      // the follow returns past its deadline only at in_pool; a signal's return leaves the op to the next landing
      if (end === "in_pool" && !signal.aborted) await ops.update("ops", id, (v) => (isPoolOp(v) ? { ...withStage(v, "in_pool", (h.now ?? Date.now)()), final: true } : undefined));
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

  return {
    /**
     * pool.address checked `quote` under request `id` for U_X (`u`): the op is written and followed. Throws when it
     * cannot be written, so no address goes out that nothing follows.
     */
    async quoted(id: string, chain: PoolChain, quote: { deposit_address: string; origin_asset: string; min_amount_out: string; deadline: string }, u: { scope: bigint; index: number; wallet: string; refundId: string }): Promise<void> {
      const deadline = Date.parse(quote.deadline);
      if (!Number.isSafeInteger(deadline)) throw new Error("the quote's deadline is not a time");
      const minOut = baseUnits(quote.min_amount_out, h.decimals(chain));
      if (minOut === null) throw new Error("the quote's min_amount_out is not an amount of the pool's coin");
      const f: PoolFollowRecord = { chain, s: u.scope.toString(), i: u.index, u: u.wallet, refund_id: u.refundId, address: quote.deposit_address, deadline_ms: deadline, origin: quote.origin_asset, min_out: minOut.toString() };
      const ops = await h.store();
      // a retry of the same request (the same id) keeps the op it made
      await ops.update("ops", id, (v) => (v === undefined ? { kind: "pool_deposit", stage: "quote_checked", txs: [], created_ms: (h.now ?? Date.now)(), follow: f } : undefined));
      const op = await ops.get("ops", id);
      if (!isPoolOp(op) || FOLLOW_KEYS.some((k) => op.follow[k] !== f[k])) throw new Error("the request's op names another deposit");
      void follow(id, f);
    },
    /** Each signed-in landing: every pool op no follow has ended is followed again. */
    async settle(): Promise<void> {
      const ops = await h.store();
      for (const k of await ops.keys("ops")) {
        const v = await ops.get("ops", k).catch(() => undefined);
        if (isPoolOp(v) && (!poolFollowEnded(v) || openHeard(v))) void follow(k, v.follow);
      }
    },
    /** This tab's sign out, or the store closing: every follow stops; settle() starts them again. */
    stop(): void {
      abort.abort(new Error("stopped"));
      abort = new AbortController();
    },
    /** Tests: the follows running now. */
    idle: (): Promise<unknown> => Promise.all([...running.values()].map((r) => r.p)),
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
  // it and stays open, read again at later landings (re-check P3-2: a move that landed late still shows its tx). `r` is
  // the round's read at the move `m`'s nonce. True: nothing holds the end
  const settleAll = async (f: PoolFollowRecord, m: PoolMove | undefined, r?: MoveRead | null): Promise<boolean> => {
    const open = (m?.txs ?? []).filter((t) => t.final !== true && t.dropped !== true);
    if (m === undefined || open.length === 0) return true;
    const done: PoolHeardTx[] = [];
    let holds = 0;
    for (const t of open) {
      const at = r !== undefined && t.nonce === m.nonce ? r : await h.read(f, t.nonce).catch(() => null);
      const timed = Number.isFinite(t.deadline_ms);
      const late = (clock: number) => !timed || clock > t.deadline_ms + POOL_TX_READ_MARGIN_MS;
      if (at !== null && at.used === true && (await txFinal(t.hash, { signer: f.refund_id, nonce: t.nonce }).catch(() => false))) done.push({ ...t, final: true });
      else if (at !== null && at.used !== true && timed && at.timeMs > t.deadline_ms) done.push({ ...t, dropped: true });
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
          quote: (request, answer) =>
            checkPoolRefundQuote(request, answer, { network: "mainnet", signer, origin: f.origin, chain: f.chain, wallet: f.u, floor, check: { path: DEPOSIT_QUOTE_PATH, pricing: priced.pricing, decimalsIn: priced.decimalsIn, decimalsOut, now: now() } }),
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
    status: (f, signal) => readDepositStatus(f.address, f.u, o.fetch ?? fetch, signal, Date.now(), f.refund_id),
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
    sleep: o.sleep ?? ((ms, signal) => new Promise<void>((ok) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        ok();
      }
      signal.addEventListener("abort", done, { once: true });
    })),
  };
}
