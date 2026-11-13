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
// - The quote's deposit address must be a NEAR implicit account (64 hex: 1Click's NEAR deposit addresses, read on a
//   live quote 13 Nov 19:2xZ), never the vault, intents.near or the token, else quote_check_failed, nothing withdrawn.
// - Then the tap waits, a read each CASH_MOVE_POLL_MS, until one tap spends the whole ask, and buys it once. Past
//   CASH_MOVE_WAIT_MS from the withdrawal's arrival (or the quote's deadline, if sooner) with no such tap: not_funded,
//   never a smaller buy than the one asked. What landed stays in the pool, the user's.
// - The app is told the move runs (route { move: "cash" }) before the pool buy's own route, so its flow shows the move
//   as its own step.
// - A page that dies mid-move loses nothing: the quote's op is written before its address is used (the follow resumes
//   it on the next load), and the withdrawal's note is RESERVED with its request (withdrawSettle resumes it). Only the
//   buy is not made; the money is in the pool for the next tap.
// Every input here is hostile until checked: the quote's numbers are checked against the shortfall, the withdrawal's end
// read on two RPCs by the hand-off. Nothing here logs.
import type { ErrorCode, PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import type { PoolAsk } from "./rules/pool.ts";
import type { CheckedWithdraw } from "./withdraw/form.ts";
import type { HandoffEnd } from "./withdraw/handoff.ts";

/** How often a moved tap reads whether one tap now spends the ask. */
export const CASH_MOVE_POLL_MS = 2_000;
/** How long, from the withdrawal's arrival at 1Click, the tap waits for one tap to spend the ask: 1Click's NEAR to
 *  Solana leg measured at 38.9 s (perf/runs/solana-intents-out-2026-10-26.json), the follow's deposit from U_X and the
 *  queue's proofs of the new notes, about four times over. */
export const CASH_MOVE_WAIT_MS = 180_000;
const IMPLICIT = /^[0-9a-f]{64}$/;

/** The margin a move's USDC carries over the shortfall at the device's price: 1Click's slippage (the deposit quote's
 *  100 bps), its fee and withdraw fee, and the follow's per-rung deposit cost, with room. */
export const CASH_MARGIN_BPS = 300n;
/** USDC (6 decimals) a move asks 1Click to swap for `short` lamports at the device's SOL price: the shortfall plus the
 *  ladder's least rung (what a 1-2-5 split may leave at U_X under it), plus CASH_MARGIN_BPS, rounded up. */
export function cashUsdcFor(short: bigint, p: Pick<PoolStatePrice, "price" | "expo">): bigint | null {
  const px = priceOf(p);
  if (px === null || short <= 0n) return null;
  const num = (short + SOL_LADDER.min) * px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS);
  const den = px.d * 10n ** 9n * 10_000n;
  return (num + den - 1n) / den;
}
/** The lamports a move of `usdc` buys a tap at most (cashUsdcFor's inverse, rounded down); 0n when it buys none. */
export function cashLamportsFor(usdc: bigint, p: Pick<PoolStatePrice, "price" | "expo">): bigint {
  const px = priceOf(p);
  if (px === null || usdc <= 0n) return 0n;
  const gross = (usdc * px.d * 10n ** 9n * 10_000n) / (px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS));
  return gross > SOL_LADDER.min ? gross - SOL_LADDER.min : 0n;
}
const priceOf = (p: Pick<PoolStatePrice, "price" | "expo">): { n: bigint; d: bigint } | null => {
  if (typeof p.price !== "string" || !/^[1-9][0-9]{0,30}$/.test(p.price) || !Number.isInteger(p.expo) || p.expo > 0 || p.expo < -30) return null;
  return { n: BigInt(p.price), d: 10n ** BigInt(-p.expo) };
};

/** The hop's rail (card one-balance-buys-on-every-chain, CO 13 Nov): Relay first wherever it quotes the pair, NEAR
 *  Intents' 1Click as the fallback and wherever Relay does not. Relay lists no NEAR chain (api.relay.link/chains, read
 *  13 Nov 19:22Z: 58 chains, Solana, Base and Robinhood among them), so a move from Cash goes on 1Click alone. */
export type CashRail = "relay" | "1click";

/** The rail's quote of Cash's USDC on NEAR into the pool's U_X, checked and followed under its request id: the rail's
 *  deposit address (a NEAR implicit account), the USDC it takes (6 decimals), the least SOL it delivers (lamports), its
 *  deadline (ms). */
export type CashQuote = { address: string; amountIn: bigint; minOut: bigint; deadlineMs: number };
type Refusal = { error: ErrorCode };

export type CashToPoolDeps = {
  /** Lamports one pool.buy of `token` spends now (pool.buy.dry's tap_max on the coin's venue); 0n when none. */
  tapMax(token: string): Promise<bigint>;
  /** The most one withdrawal of Cash carries (USDC base units): the largest UNSPENT note of the vault's scope. */
  cash(): Promise<bigint>;
  /** The rails to ask, in order: the first that quotes carries the move; each refusal asks the next. */
  rails: readonly CashRail[];
  /** `rail`'s quote for `short` lamports into the pool, or its refusal. */
  quote(short: bigint, id: string, rail: CashRail): Promise<CashQuote | Refusal>;
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

/** The pool.buy kind with Cash first: `inner` (the pool buy) once one tap spends the ask, after a move when it did not.
 *  No async function here returns an answer: a HostAnswer's `then` would make it a thenable (pools.ts). */
export function cashFirst(inner: Inner, deps: () => CashToPoolDeps): Inner {
  return (ask, ctx) => {
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || ask.token === null) return inner(ask, ctx);
    const token = ask.token;
    let answer: Answer = { error: "failed" };
    const after = (async () => {
      const d = deps();
      const now = await d.tapMax(token);
      if (now < ask.amount) {
        const refused = await move(d, token, ask.amount, ask.amount - now, ctx);
        if (refused !== null) return void (answer = refused);
      }
      const r = inner(ask, ctx);
      if (!("after" in r)) return void (answer = r);
      await r.after;
      answer = r.answer() ?? { error: "failed" };
    })().catch(() => void (answer = { error: "failed" }));
    return { running: true, after, answer: () => answer };
  };
}

// The move and its wait: null once one tap spends `amount`, else the tap's refusal.
async function move(d: CashToPoolDeps, token: string, amount: bigint, short: bigint, ctx: KindContext | null): Promise<Refusal | null> {
  if (d.handoff === null || d.rails.length === 0) return { error: "not_funded" };
  const id = ctx === null ? "cash" : `${ctx.id}/cash`;
  let q: CashQuote | Refusal = { error: "not_allowed" };
  for (const rail of d.rails) {
    q = await d.quote(short, rail === d.rails[0] ? id : `${id}/${rail}`, rail);
    if (!("error" in q)) break;
  }
  if ("error" in q) return { error: q.error };
  // the quote against the user's own request: it must deliver at least the shortfall, from a NEAR implicit account
  if (q.minOut < short || q.amountIn <= 0n || !IMPLICIT.test(q.address)) return { error: "quote_check_failed" };
  const fee = await d.fee();
  if (q.amountIn + fee > (await d.cash())) return { error: "not_funded" };
  try {
    ctx?.route?.({ move: "cash" });
  } catch {
    /* the app's display never stops a buy */
  }
  const end = await d.handoff({ recipient: q.address, amount: q.amountIn }, fee);
  if (end.kind !== "arrived" && end.kind !== "landed") return { error: "failed" };
  const until = Math.min(q.deadlineMs, d.now() + CASH_MOVE_WAIT_MS);
  for (;;) {
    if (d.signal?.aborted) return { error: "failed" };
    if ((await d.tapMax(token)) >= amount) return null;
    if (d.now() >= until) return { error: "not_funded" };
    await d.wait(CASH_MOVE_POLL_MS);
  }
}
