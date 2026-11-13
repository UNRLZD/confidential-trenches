// One balance buys on every chain (card one-balance-buys-on-every-chain, part 1: Cash to a Solana buy). A pool.buy on
// Solana above what one tap of the pool's ready proofs spends now moves the shortfall from Cash into the Solana pool
// inside the same tap, then buys the whole ask from the pool. The user takes no separate step.
//
// The route, by measurement (the card's plan): the vault pays a 1Click deposit address straight (the withdraw form's
// hand-off, ./withdraw/handoff.ts withdrawHandoff, a proof made on this device), 1Click swaps Cash's USDC on NEAR to SOL
// at the pool's U_X (the deposit sheet's own quote, ./pool-deposit-address.ts poolAddressHost, checked against the
// device's price reads and floor and followed under its request id before its address is used), the follow carries
// what lands at U_X into the pool in the ladder's standard sizes (./pool-deposit-follow.ts), the queue proves the new
// notes, and the pool buy (./pool-buy.ts) spends them. Never W straight from 1Click: an odd size beside the pool's
// pieces in one W would tie the user's vault spend to their pool spend.
//
// - The shortfall is the ask less what one tap spends now (`tapMax`: pool.buy.dry's tap_max on this coin's venue, in
//   lamports). None: the pool buy alone, nothing asked.
// - The quote is the deposit sheet's, for that shortfall (`quote`): its min out must cover the shortfall, the user's own
//   request, or it is refused quote_check_failed before anything is withdrawn. Its refusal is the tap's answer.
// - Cash pays it only when one note covers the amount and the relayer's fee (`cash`: the largest note, ./withdraw/
//   checks.ts withdrawable); else not_funded, nothing withdrawn. A withdrawal that did not pay the deposit address
//   (expired, refunded, paid elsewhere, unmatched, a fee above the one read) ends the tap "failed", with no buy: what
//   the vault paid is the follow's and the refund's (1Click refunds into the user's refund id inside intents.near,
//   which the follow moves back), never lost.
// - Then the tap waits, a read each CASH_MOVE_POLL_MS, until one tap spends the whole ask, and buys it once. Past the
//   quote's deadline and the follow's margin with no such tap: not_funded, never a smaller buy than the one asked. What
//   landed stays in the pool, the user's.
// - The app is told the move runs (route { move: "cash" }) before the pool buy's own route, so its flow shows the move
//   as its own step.
// - A page that dies mid-move loses nothing: the quote's op is written before its address is used (the follow resumes
//   it on the next load), and the withdrawal's note is RESERVED with its request (withdrawSettle resumes it). Only the
//   buy is not made; the money is in the pool for the next tap.
// Every input here is hostile until checked: the quote's numbers are checked against the shortfall, the withdrawal's end
// read on two RPCs by the hand-off. Nothing here logs.
import type { ErrorCode } from "../../kit/src/signpage/messages.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import type { PoolAsk } from "./rules/pool.ts";
import type { CheckedWithdraw } from "./withdraw/form.ts";
import type { HandoffEnd } from "./withdraw/handoff.ts";

/** How often a moved tap reads whether one tap now spends the ask. */
export const CASH_MOVE_POLL_MS = 2_000;
/** How long past the quote's deadline the tap still waits for the follow to carry the money into the pool and the
 *  queue to prove it: the follow's own deposit and one proof each of four pieces. */
export const CASH_MOVE_MARGIN_MS = 120_000;

/** The deposit sheet's quote of Cash's USDC on NEAR into the pool's U_X, checked and followed under its request id:
 *  1Click's deposit address (a NEAR account), the USDC it takes (6 decimals), the least SOL it delivers (lamports), its
 *  deadline (ms). */
export type CashQuote = { address: string; amountIn: bigint; minOut: bigint; deadlineMs: number };

export type CashToPoolDeps = {
  /** Lamports one pool.buy of `token` spends now (pool.buy.dry's tap_max on the coin's venue); 0n when none. */
  tapMax(token: string): Promise<bigint>;
  /** The most one withdrawal of Cash carries (USDC base units): the largest UNSPENT note of the vault's scope. */
  cash(): Promise<bigint>;
  /** The quote for `short` lamports into the pool, or the pool.address refusal. */
  quote(short: bigint): Promise<CashQuote | { error: ErrorCode }>;
  /** The relayer's fee, bounded by the device's fee_max (withdrawFormDeps.fee). */
  fee(): Promise<bigint>;
  /** The vault's hand-off (withdrawHandoff); null where the network names no vault or relayer. */
  handoff: ((w: CheckedWithdraw, drawnFee: bigint) => Promise<HandoffEnd>) | null;
  wait(ms: number): Promise<void>;
  now(): number;
  signal?: AbortSignal;
};

type Inner = (ask: PoolAsk, ctx: KindContext | null) => HostRefusal | Running<"pool.buy">;
type Answer = HostAnswer<"pool.buy"> | HostRefusal;

/** The pool.buy kind with Cash first: `inner` (the pool buy) once one tap spends the ask, after a move when it did not. */
export function cashFirst(inner: Inner, deps: () => CashToPoolDeps): Inner {
  return (ask, ctx) => {
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || ask.token === null) return inner(ask, ctx);
    const token = ask.token;
    let answer: Answer = { error: "failed" };
    const after = (async () => {
      const d = deps();
      const now = await d.tapMax(token);
      if (now < ask.amount) {
        const moved = await move(d, token, ask.amount, ask.amount - now, ctx);
        if (moved !== null) return void (answer = moved);
      }
      answer = await ran(inner(ask, ctx));
    })().catch(() => void (answer = { error: "failed" }));
    return { running: true, after, answer: () => answer };
  };
}

async function ran(r: HostRefusal | Running<"pool.buy">): Promise<Answer> {
  if (!("running" in r)) return r;
  await r.after;
  return r.answer();
}

// The move and its wait: null once one tap spends `amount`, else the tap's answer.
async function move(d: CashToPoolDeps, token: string, amount: bigint, short: bigint, ctx: KindContext | null): Promise<Answer | null> {
  if (d.handoff === null) return { error: "not_funded" };
  const q = await d.quote(short);
  if ("error" in q) return { error: q.error };
  // the quote against the user's own request: it must deliver at least the shortfall
  if (q.minOut < short || q.amountIn <= 0n) return { error: "quote_check_failed" };
  const fee = await d.fee();
  if (q.amountIn + fee > (await d.cash())) return { error: "not_funded" };
  try {
    ctx?.route?.({ move: "cash" });
  } catch {
    /* the app's display never stops a buy */
  }
  const end = await d.handoff({ recipient: q.address, amount: q.amountIn }, fee);
  if (end.kind !== "arrived" && end.kind !== "landed") return { error: "failed" };
  const until = q.deadlineMs + CASH_MOVE_MARGIN_MS;
  for (;;) {
    if (d.signal?.aborted) return { error: "failed" };
    if ((await d.tapMax(token)) >= amount) return null;
    if (d.now() >= until) return { error: "not_funded" };
    await d.wait(CASH_MOVE_POLL_MS);
  }
}
