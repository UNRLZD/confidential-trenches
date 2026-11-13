// One balance buys on every chain (card one-balance-buys-on-every-chain, part 1: Cash to a Solana buy; the design: the
// Blindfill v2 lite paper §3-4, every move between chains stops in the NEAR vault, never at a tap's hop that ties two
// chains together).
//
// cashMover.need(chain, short): money for a buy on `chain` whose pool one tap cannot pay. It joins the moves already on
// their way into that pool when they cover the shortfall, else starts one more for what is left: the deposit sheet's
// own quote of Cash's USDC on NEAR into the pool's U_X (./pool-deposit-address.ts poolAddressHost: checked against the
// device's price reads and floor, its op written for the follow before its address is used), sized to the shortfall
// plus the ladder's least rung and CASH_MARGIN_BPS at the device's price (cashUsdcFor), then the vault pays that
// quote's deposit address straight with a proof made on this device (./withdraw/handoff.ts withdrawHandoff: the
// smallest note that covers it and the relay fee). The follow carries what lands at U_X into the pool in the ladder's
// standard sizes (./pool-deposit-follow.ts) and the queue proves the new notes. A move counts as on its way from its
// quote until its follow op ends (`landed`), so the same shortfall is never moved twice. Called when the user types an
// amount (the move starts then) and again at the tap.
// - The rails, in order: NEAR Intents' 1Click only (no Relay: a hop between pools would tie two chains' money together,
//   lite paper v2 §4; Relay lists no NEAR chain either, api.relay.link/chains read 13 Nov 19:22Z).
// - Every quote is hostile: its deposit address must be a NEAR implicit account (1Click's NEAR deposit addresses are,
//   read on a live quote 13 Nov 19:2xZ), its amount in exactly the USDC asked and its min out at least the shortfall,
//   else nothing is withdrawn.
// - Into the pool, never straight to a buy's W: an odd size beside the pool's pieces in one W would tie the user's
//   vault spend to their pool spend.
// - A page that dies mid-move loses nothing: the follow resumes the quote's op on the next load, and withdrawSettle the
//   RESERVED note; the money is in the pool for the next tap.
//
// cashFirst, at a tap: a Solana pool.buy above what one tap spends now (pool.buy.dry's tap_max) asks `need` for the
// shortfall and, while money is on its way, waits for it (a read each CASH_MOVE_POLL_MS, CASH_MOVE_WAIT_MS at most) and
// buys the whole ask once one tap spends it. The app is told the tap waits on the move (route { move: "cash" }), so its
// flow shows the move as its own step. With nothing on its way: the pool buy's own answer.
// Nothing here logs.
import type { ErrorCode, PoolChain, PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import type { PoolAsk } from "./rules/pool.ts";
import type { CheckedWithdraw } from "./withdraw/form.ts";
import type { HandoffEnd } from "./withdraw/handoff.ts";

/** How often a moved tap reads whether one tap now spends the ask. */
export const CASH_MOVE_POLL_MS = 2_000;
/** How long a tap waits for one tap to spend the ask: 1Click's NEAR to
 *  Solana leg measured at 38.9 s (perf/runs/solana-intents-out-2026-10-26.json), the follow's deposit from U_X and the
 *  queue's proofs of the new notes, about four times over. */
export const CASH_MOVE_WAIT_MS = 180_000;
const IMPLICIT = /^[0-9a-f]{64}$/;

/** The margin Cash is counted at in a tap's most (with_cash) under the device's price: 1Click's slippage (the deposit
 *  quote's 100 bps), its fee and withdraw fee, and the follow's per-rung deposit cost, with room. */
export const CASH_MARGIN_BPS = 300n;
/** pool.buy.dry's with_cash (kit 1.15), in whole SOL as tap_max is: tap_max, plus what the moves on their way bring,
 *  plus what the largest Cash note less the relay fee gives a tap (cashLamportsFor); null when tap_max is not an amount. */
export function withCash(tapMax: string, coming: bigint, cash: bigint, fee: bigint, p: Pick<PoolStatePrice, "price" | "expo"> | null): string | null {
  const m = /^(\d{1,30})(?:\.(\d{1,9}))?$/.exec(tapMax);
  if (m === null) return null;
  const tap = BigInt(m[1]!) * 10n ** 9n + BigInt((m[2] ?? "").padEnd(9, "0"));
  const all = tap + coming + (p === null || cash <= fee ? 0n : cashLamportsFor(cash - fee, p));
  const t = all.toString().padStart(10, "0");
  const f = t.slice(-9).replace(/0+$/, "");
  return f ? `${t.slice(0, -9)}.${f}` : t.slice(0, -9);
}

/** USDC (6 decimals) a move asks for `short` base units of the pool's coin (lamports on Solana) at the device's price:
 *  the shortfall plus the ladder's least rung (what a 1-2-5 split may leave at U_X under it), plus CASH_MARGIN_BPS,
 *  rounded up; null with no price or no shortfall. */
export function cashUsdcFor(short: bigint, p: Pick<PoolStatePrice, "price" | "expo">): bigint | null {
  const px = priceOf(p);
  if (px === null || short <= 0n) return null;
  const num = (short + SOL_LADDER.min) * px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS);
  const den = px.d * 10n ** 9n * 10_000n;
  return (num + den - 1n) / den;
}
/** The lamports a move of `usdc` gives a tap at most, at the device's SOL price: less CASH_MARGIN_BPS and the ladder's
 *  least rung (what a 1-2-5 split may leave at U_X under it), rounded down; 0n when it gives none. */
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

/** The hop's rail: NEAR Intents' 1Click (no Relay, lite paper v2 §4). */
export type CashRail = "1click";
/** A rail's quote of USDC on NEAR into a pool's U_X, checked and followed under its id: its deposit address, the USDC it
 *  takes (6 decimals), the least of the pool's coin it delivers (base units). */
export type CashQuote = { address: string; amountIn: bigint; minOut: bigint };
type Refusal = { error: ErrorCode };

export type CashMoverDeps = {
  /** The device's price of `chain`'s pool coin (src/pool-price.ts), null past its bound. */
  price(chain: PoolChain): Pick<PoolStatePrice, "price" | "expo"> | null;
  rails: readonly CashRail[];
  /** `rail`'s quote of `usdc` into `chain`'s pool, its op written for the follow under `id`; or its refusal. */
  quote(chain: PoolChain, usdc: bigint, id: string, rail: CashRail): Promise<CashQuote | Refusal>;
  /** The relayer's fee for a withdrawal, bounded by the device's fee_max (withdrawFormDeps.fee). */
  fee(): Promise<bigint>;
  /** The most one withdrawal of Cash carries (USDC base units): the largest UNSPENT note of the vault's scope. */
  cash(): Promise<bigint>;
  /** The vault's hand-off (withdrawHandoff); null where the network names no vault or relayer. */
  handoff: ((w: CheckedWithdraw, drawnFee: bigint) => Promise<HandoffEnd>) | null;
  /** Whether the follow op under `id` has ended (its money in the pool, or refunded): no longer on its way. */
  landed(id: string): Promise<boolean>;
  now(): number;
};

type Way = { chain: PoolChain; id: string; lamports: bigint; going: Promise<boolean>; since: number };

/** The mover: `need` starts or joins a move for a shortfall, true while money for it is on its way. */
export function cashMover(d: CashMoverDeps): { need(chain: PoolChain, short: bigint): Promise<boolean>; ways(): number; coming(chain: PoolChain): bigint } {
  let ways: Way[] = [];
  let turn: Promise<unknown> = Promise.resolve();
  const start = async (chain: PoolChain, short: bigint): Promise<boolean> => {
    // what is on its way already: a move that failed, landed, or outlived CASH_MOVE_WAIT_MS no longer counts
    const kept: Way[] = [];
    for (const w of ways) {
      const settled = await Promise.race([w.going, Promise.resolve(null)]);
      if (settled === false || d.now() - w.since > CASH_MOVE_WAIT_MS || (settled === true && (await d.landed(w.id)))) continue;
      kept.push(w);
    }
    ways = kept;
    const coming = ways.filter((w) => w.chain === chain).reduce((a, w) => a + w.lamports, 0n);
    if (coming >= short) return coming > 0n;
    const left = short - coming;
    const p = d.price(chain);
    const usdc = p === null ? null : cashUsdcFor(left, p);
    if (usdc === null || d.handoff === null || d.rails.length === 0) return coming > 0n;
    const fee = await d.fee();
    if (usdc + fee > (await d.cash())) return coming > 0n;
    const id = `cash/${chain}/${d.now()}`;
    let q: CashQuote | Refusal = { error: "not_allowed" };
    let used = `${id}/${d.rails[0]}`;
    for (const rail of d.rails) {
      used = `${id}/${rail}`;
      q = await d.quote(chain, usdc, used, rail);
      if (!("error" in q)) break;
    }
    if ("error" in q || !IMPLICIT.test(q.address) || q.amountIn !== usdc || q.minOut < left) return coming > 0n;
    const handoff = d.handoff;
    const to = q.address;
    const going = handoff({ recipient: to, amount: usdc }, fee).then((e) => e.kind === "arrived" || e.kind === "landed", () => false);
    ways.push({ chain, id: used, lamports: q.minOut, going, since: d.now() });
    return true;
  };
  return {
    // one at a time: a second need (the tap after the typing) reads the first's move as on its way
    need: (chain, short) => {
      const r = turn.then(() => start(chain, short));
      turn = r.catch(() => {});
      return r.catch(() => false);
    },
    ways: () => ways.length,
    // the least of the pool's coin the moves on their way still bring (display only: a tap's most counts it)
    coming: (chain) => ways.filter((w) => w.chain === chain && d.now() - w.since <= CASH_MOVE_WAIT_MS).reduce((a, w) => a + w.lamports, 0n),
  };
}

export type CashToPoolDeps = {
  /** Lamports one pool.buy of `token` spends now (pool.buy.dry's tap_max on the coin's venue); 0n when none. */
  tapMax(token: string): Promise<bigint>;
  /** cashMover's need on Solana. */
  need(short: bigint): Promise<boolean>;
  wait(ms: number): Promise<void>;
  now(): number;
  signal?: AbortSignal;
};

type Inner = (ask: PoolAsk, ctx: KindContext | null) => HostRefusal | Running<"pool.buy">;
type Answer = HostAnswer<"pool.buy"> | HostRefusal;

/** The pool.buy kind that waits for Cash on its way: `inner` (the pool buy) once one tap spends the ask, or at once when
 *  nothing is on its way. No async function here returns an answer: a HostAnswer's `then` would make it a thenable. */
export function cashFirst(inner: Inner, deps: () => CashToPoolDeps): Inner {
  return (ask, ctx) => {
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || ask.token === null) return inner(ask, ctx);
    const token = ask.token;
    let answer: Answer = { error: "failed" };
    const after = (async () => {
      const d = deps();
      const now = await d.tapMax(token);
      if (now < ask.amount && (await d.need(ask.amount - now))) {
        try {
          ctx?.route?.({ move: "cash" });
        } catch {
          /* the app's display never stops a buy */
        }
        const until = d.now() + CASH_MOVE_WAIT_MS;
        while (!d.signal?.aborted && d.now() < until && (await d.tapMax(token)) < ask.amount) await d.wait(CASH_MOVE_POLL_MS);
      }
      const r = inner(ask, ctx);
      if (!("after" in r)) return void (answer = r);
      await r.after;
      answer = r.answer() ?? { error: "failed" };
    })().catch(() => void (answer = { error: "failed" }));
    return { running: true, after, answer: () => answer };
  };
}
