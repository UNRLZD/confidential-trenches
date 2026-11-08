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
//   read again next round; only the signal (a sign out) ends a follow early.
// - REFUNDED: refunded is shown; the money is under U_{s,i} inside intents.near, and the refund carry (`refund`: moved
//   with the same signer back to X's coin, to U_X, and carried on by the rounds above) is asked once per round while the
//   status reads REFUNDED. With no `refund` given the stage stays refunded and the follow does not end (followed on at
//   every landing), so no refund is left as if done.
// - Pace: FAST_MS while a status shows a send in flight or a deposit ran; else SLOW_MS doubling to SLOW_MAX_MS.
// Nothing here logs. Every read names one public account (U_X) or the quote's deposit address; no request carries a
// key, the words, or which note is whose.
import type { PoolChain } from "../../kit/src/signpage/messages.ts";
import { ladderSplit, type Ladder } from "../../wallet/src/pool/ladder.ts";
import type { OneClickStatus, StatusRead } from "../../wallet/src/deposit/follow.ts";

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
}

/** The pool follow's stages, as kit messages.ts PoolDepositStage names them. */
export type PoolFollowStage = "quote_checked" | "waiting" | "in_transit" | "in_pool" | "refunded" | "refund_move" | "failed" | "short" | "expired";

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
const RANK: Partial<Record<PoolFollowStage, number>> = { quote_checked: 0, expired: 0, waiting: 1, in_transit: 2, failed: 2, short: 2 };

/** A deposit run's end as the page's pool.deposit kind tells it (pool-deposit.ts poolDepositKind: the answer, then its
 *  end as progress), or its refusal code. */
export type PoolDepositEnd = "filled" | "part_filled" | "not_landed" | "sent" | "not_allowed" | "not_funded" | "failed" | "down";

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
  /** The page's pool.deposit on X from U_X, for `amount`, to its end. */
  deposit(f: PoolFollowRecord, amount: bigint, signal: AbortSignal): Promise<PoolDepositEnd>;
  /** The quote's deadline past on both RPCs' clocks. */
  past(f: PoolFollowRecord): Promise<boolean>;
  /** The refund carry: what U_{s,i} holds inside intents.near moved back to X's coin, to U_X; none, and a refund waits. */
  refund?(f: PoolFollowRecord, signal: AbortSignal): Promise<"moved" | "none" | "wait">;
  /** The op's stage written (and posted to the app in state.ops). */
  stage(s: PoolFollowStage): Promise<void>;
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
  for (;;) {
    if (deps.signal.aborted) return shown;
    let fast = false;
    try {
      // the chain first: U_X's money, the lower of two RPCs at finalized, carried into the pool while it covers a deposit
      const [a, b] = await deps.balances(f);
      const low = a < b ? a : b;
      const c = await deps.costs(f);
      if (low >= c.floor) {
        const amount = askOf(deps.ladder, low, c.perRung, c.keep);
        if (amount > 0n) {
          const end = await deps.deposit(f, amount, deps.signal);
          // landed: the next round reads what is left at once; anything else (not landed, refused, down) is read again
          // at the slow pace, so a deposit that cannot go is never asked in a tight loop
          if (end === "filled" || end === "part_filled") {
            landed = true;
            fast = true;
            await show("in_pool");
          }
        }
      } else if (landed) {
        // nothing left under U_X to carry: read on to the quote's deadline, so a late send is carried too
        if (shown !== "in_pool") await show("in_pool");
        if (await deps.past(f)) return shown;
      } else {
        const st = await deps.status(f, deps.signal);
        if (st !== null && "status" in st) {
          // a refund being moved stays shown as moved while 1Click still reads REFUNDED
          if (!(shown === "refund_move" && st.status === "REFUNDED")) await show(POOL_STATUS_STAGE[st.status]);
          if (st.status === "KNOWN_DEPOSIT_TX" || st.status === "PROCESSING" || st.status === "SUCCESS") fast = true;
          if (st.status === "REFUNDED" && deps.refund) {
            const r = await deps.refund(f, deps.signal);
            if (r === "moved") {
              await show("refund_move");
              fast = true;
            }
          }
        } else if (shown === "quote_checked" && (await deps.past(f))) await show("expired");
      }
    } catch {
      if (deps.signal.aborted) return shown;
    }
    if (fast) slow = POOL_FOLLOW_SLOW_MS;
    await deps.sleep(fast ? POOL_FOLLOW_FAST_MS : slow, deps.signal);
    if (!fast) slow = Math.min(slow * 2, POOL_FOLLOW_SLOW_MAX_MS);
  }
}
