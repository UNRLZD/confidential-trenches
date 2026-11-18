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
// cashFirst, at a tap: a pool.buy above what one tap spends now (tap_max) asks `need` for the shortfall the page sizes
// (Solana's solanaMoveShort, Base's and Robinhood's evmMoveShort: the notes the move brings pay their own costs) and,
// while money is on its way, waits for it (card cash-buy-waits-for-its-move: the move's own landing, every part in the
// pool or stopped, then the chain's landing notes and their proofs, read each CASH_MOVE_POLL_MS; no clock from the tap)
// and buys the whole ask once one tap spends it. The app is told the tap waits on the move (route { move: "cash", op }, op
// the move op's id in state.ops), so its flow shows the move as its own step. With nothing on its way: the pool buy's
// own answer.
//
// pool.move (poolMoveKinds): the same mover's `move`, an exact amount of Cash into a pool with every check above, its
// move op written under the request's id: leaving once the quote is checked, in_transit once the vault's withdraw
// landed, then the quote's follow op's stage (moveStageOfFollow). The amount is planned over every Cash note (card
// move-from-cash-spends-every-note: planCashExact, one withdrawal a note), its dry, Max and Fee from that one plan, and
// sent as a buy's parts are (sendParts: every part's quote checked before any note leaves Cash). A buy's shortfall
// writes the same op under its own id (cash/<chain>/<ms>).
// Nothing here logs but the trace (./trace.ts, card buy-shows-every-step): one line per step of a move and of a buy
// that waits on one, public ids and the error's words only, its last step and error kept in the move's record (`last`).
import { HELPER_FETCH_INIT } from "../../kit/src/helper/v1.ts";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { DEPOSIT_QUOTE_DEADLINE_MS, DEPOSIT_QUOTE_URL } from "../../wallet/src/deposit/quote.ts";
import { DEPOSIT_DRY_PLACEHOLDER, TRADE_CHAINS, type ErrorCode, type MoveStage, type PoolChain, type PoolMoveDry, type PoolStatePrice, type TradeChain, type TxRef } from "../../kit/src/signpage/messages.ts";
import { SOL_EPOCH_MS, SOL_LADDER, SOL_PIECES } from "../../wallet/src/pool/solana.ts";
import { EVM_EPOCH_MS, EVM_LADDER, EVM_PIECES } from "../../wallet/src/pool/evm.ts";
import { pieceChunk, type PieceRule } from "../../wallet/src/pool/pieces.ts";
import { ladderSplit, type Ladder } from "../../wallet/src/pool/ladder.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import type { PoolAsk } from "./rules/pool.ts";
import type { CheckedWithdraw } from "./withdraw/form.ts";
import type { HandoffEnd } from "./withdraw/handoff.ts";
import type { PoolToCash } from "./pool-to-cash.ts";
import { nearestPlannable, withdrawNoteFloor } from "./pool-withdraw.ts";
import { cashCosts, cashSendable, planCashWithdraw } from "./withdraw/checks.ts";
import type { HandoffMark } from "./withdraw/handoff.ts";
import { errorText, trace, traceAlias, traceBegin, type TraceFields, type TraceLast, type TraceStep } from "./trace.ts";

/** How often a moved tap reads whether one tap now spends the ask. */
export const CASH_MOVE_POLL_MS = 2_000;
/** The longest one read of what one tap spends may take while a tap waits on a move: one that does not answer by then
 *  counts as nothing yet, and the wait reads again (card cash-buy-waits-for-its-move: the wait itself has no clock). */
export const CASH_TAP_READ_MS = 30_000;
/** How long past its quote's deadline a part with nothing delivered still holds a tap: the follow's own end (expired,
 *  read on both RPCs' clocks) comes first; this is the stop when no follow writes one. */
export const CASH_MOVE_DEADLINE_MARGIN_MS = 60_000;
const IMPLICIT = /^[0-9a-f]{64}$/;

/** The margin Cash is counted at in a tap's most (with_cash) under the device's price: 1Click's slippage (the deposit
 *  quote's 100 bps), its fee and withdraw fee, and the follow's per-rung deposit cost, with room. */
export const CASH_MARGIN_BPS = 300n;
/** A whole-SOL decimal (at most 9 fraction digits) in lamports; null when it is not one. */
const lamportsOf = (sol: string): bigint | null => {
  const m = /^(\d{1,30})(?:\.(\d{1,9}))?$/.exec(sol);
  return m === null ? null : BigInt(m[1]!) * 10n ** 9n + BigInt((m[2] ?? "").padEnd(9, "0"));
};
/** Solana's CashToPoolDeps.tapMax (card solana-buy-never-moves-cash-for-a-coin-it-cannot-buy): the coin's pool.buy.dry,
 *  its tap_max on the coin's venue in lamports, 0n when the pool holds nothing a tap spends (not_funded). Any other
 *  refusal throws: the coin's venue was not read (src/pools.ts poolBuyDryKind: quote_check_failed for a coin with no
 *  pump.fun curve or PumpSwap pool, down for a provider that failed), so cashFirst moves nothing from Cash for it. */
export async function solanaTapMaxOf(r: HostRefusal | Running<"pool.buy.dry">): Promise<bigint> {
  if (!("running" in r)) throw new Error(r.error);
  await r.after;
  const a = r.answer();
  if (a !== null && "result" in a) return lamportsOf(a.result.tap_max) ?? 0n;
  if (a?.error === "not_funded") return 0n;
  throw new Error(a?.error ?? "failed");
}
/** pool.buy.dry's with_cash (kit 1.15), in whole SOL as tap_max is: tap_max, plus what the moves on their way bring,
 *  plus what a move of Cash brings a tap at most (card cash-buys-spend-every-note: every note a part may be made of,
 *  each whole less its relay fee, cashMoveMost under the Solana model at the pool's quote `floor` and 1Click's least
 *  `leastIn`, never only the largest note); null when tap_max is not an amount. */
export function withCash(tapMax: string, coming: bigint, notes: readonly CashNote[], fee: bigint, p: Pick<PoolStatePrice, "price" | "expo"> | null, floor: bigint | null = null, leastIn: bigint | null = null): string | null {
  const tap = lamportsOf(tapMax);
  if (tap === null) return null;
  const all = tap + coming + (p === null ? 0n : cashMoveMost(notes, fee, solanaMoveModel(p, floor, leastIn)));
  const t = all.toString().padStart(10, "0");
  const f = t.slice(-9).replace(/0+$/, "");
  return f ? `${t.slice(0, -9)}.${f}` : t.slice(0, -9);
}

/** Cash's fee read kept as a value (withdraw/form.ts fee), so a plan can tell a failed read from a fee. */
export type CashFeeRead = { fee: bigint } | { error: unknown };
export const cashFeeRead = (p: Promise<bigint>): Promise<CashFeeRead> => p.then((fee) => ({ fee }), (error: unknown) => ({ error }));
/** The vault payout's fee a plan over Cash's `notes` is made at: the fee read, or with no Cash note 0n (card
 *  buy-quote-before-any-note): a plan over no note pays no fee, and the fee read asks a quote sized by Cash's largest
 *  note, which a user with none has not, so it refuses. A failed read with a note: thrown, as before. */
export function cashPlanFee(notes: readonly CashNote[], read: CashFeeRead): bigint {
  if ("fee" in read) return read.fee;
  if (notes.length === 0) return 0n;
  throw read.error;
}

/** The reads a plan over Cash is made on (card buy-quote-before-any-note, round 2): Cash's notes first (the device's own
 *  store), then, only with a note, the fee, the pool's floor and 1Click's least, side by side. With no Cash note none of
 *  them is read or waited on: a plan over no note moves nothing (fee 0n, cashPlanFee), and a fresh account's dry waited
 *  27 s on Robinhood's floor read for it (16 Nov). A failed fee read with a note throws, as cashPlanFee. */
export async function cashPlanReads<F, L>(notes: () => Promise<readonly CashNote[]>, rest: () => readonly [Promise<CashFeeRead>, Promise<F>, Promise<L>]): Promise<{ notes: readonly CashNote[]; fee: bigint; floor: F | null; leastIn: L | null }> {
  const all = await notes();
  if (all.length === 0) return { notes: all, fee: 0n, floor: null, leastIn: null };
  const [read, floor, leastIn] = await Promise.all(rest());
  return { notes: all, fee: cashPlanFee(all, read), floor, leastIn };
}

/** One Base or Robinhood dry's reads over Cash (card buy-quote-before-any-note, round 2): Cash's notes read once (the
 *  device's own store); from that one read, the plan over them (its fee, floor and least) and, only with a note, the
 *  epoch's fee, side by side, so a dry with Cash waits for the slower of the two, never their sum (Robinhood's floor
 *  read took 27-30 s on 16 Nov), and one with none reads no fee. Each read once per dry, however many deps ask it. */
export function evmDryCashReads<P>(notes: () => Promise<readonly CashNote[]>, plan: (notes: readonly CashNote[]) => Promise<P>, fee: () => Promise<bigint | null>): { plan: () => Promise<P>; fee: () => Promise<bigint | null> } {
  let read: Promise<readonly CashNote[]> | undefined;
  let planRead: Promise<P> | undefined;
  let feeRead: Promise<bigint | null> | undefined;
  const notesOnce = () => (read ??= notes());
  return {
    plan: () => (planRead ??= notesOnce().then(plan)),
    fee: () => (feeRead ??= notesOnce().then((n) => (n.length === 0 ? null : fee()))),
  };
}

/** A plan over no Cash note (cashPlanReads with none): no part, no rung, no cost, nothing on top of the tap. */
export const NO_CASH_EVM_PLAN: EvmCashPlan = Object.freeze({ parts: () => null, rungs: () => null, cost: () => null, top: 0n });

/** pool.buy.dry with with_cash on Solana (card buy-quote-before-any-note, round 2): the dry `r` and Cash's reads `cash`
 *  side by side, so the answer comes at the slower of the two, never their sum; with_cash only on a dry's result and a
 *  `cash` that gives one (a read that fails leaves it out). */
export function dryBesideCash(r: Running<"pool.buy.dry">, cash: Promise<((tapMax: string) => string | null) | null>): Running<"pool.buy.dry"> {
  let extra: string | null = null;
  const after = Promise.all([r.after, cash])
    .then(([, of]) => {
      const a = r.answer();
      if (a !== null && "result" in a && of !== null) extra = of(a.result.tap_max);
    })
    .catch(() => {});
  return {
    running: true as const,
    after,
    answer: () => {
      const a = r.answer();
      return a !== null && "result" in a && extra !== null ? { ...a, result: { ...a.result, with_cash: extra } } : a;
    },
  };
}

/** Each pool's coin: its decimals and the least rung its deposit ladder splits into (what a 1-2-5 split may leave at
 *  U_X under it): SOL on Solana, ETH on Base and Robinhood. */
const POOL_DECIMALS: Readonly<Record<PoolChain, number>> = { solana: 9, base: 18, robinhood: 18 };
const RUNG: Readonly<Record<PoolChain, bigint>> = { solana: SOL_LADDER.min, base: EVM_LADDER.min, robinhood: EVM_LADDER.min };
const LADDER: Readonly<Record<PoolChain, Ladder>> = { solana: SOL_LADDER, base: EVM_LADDER, robinhood: EVM_LADDER };
const isPoolChain = (c: unknown): c is PoolChain => typeof c === "string" && Object.hasOwn(LADDER, c);
/** The wei `usdc` of Cash buys at the device's ETH price, rounded down, with no margin: a bound above what any move of it
 *  brings (pool.buy.dry's with_cash on Base and Robinhood is searched under it, pool-buy-evm.ts evmMostWithCash); 0n with
 *  no price. */
export function evmCashWei(usdc: bigint, p: Pick<PoolStatePrice, "price" | "expo">): bigint {
  const px = priceOf(p);
  return px === null || usdc <= 0n ? 0n : (usdc * px.d * 10n ** BigInt(POOL_DECIMALS.base)) / (px.n * 10n ** 6n);
}
/** USDC (6 decimals) that buys `units` of `chain`'s pool coin at the device's price, CASH_MARGIN_BPS over, rounded up. */
function cashUsdcExact(units: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: PoolChain): bigint | null {
  const px = priceOf(p);
  if (px === null || units <= 0n) return null;
  const num = units * px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS);
  const den = px.d * 10n ** BigInt(POOL_DECIMALS[chain]) * 10_000n;
  return (num + den - 1n) / den;
}

/** What a move of Cash for `short` base units of `chain`'s pool coin costs for good (card you-receive-on-every-chain: a
 *  buy above one tap's spend moves it first, cashFirst), in that coin's base units at the device's price, rounded up so
 *  a Fee never reads under: the vault withdraw's relay `fee` (USDC) and the margin the move asks Cash at
 *  (CASH_MARGIN_BPS of cashUsdcFor's USDC: 1Click's slippage and fees and the follow's deposit costs, with room). The
 *  rest of the USDC arrives in the pool as the user's own. Null with no price or no shortfall. */
export function moveCostOf(short: bigint, fee: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: PoolChain = "solana"): bigint | null {
  const usdc = cashUsdcFor(short, p, chain);
  const px = priceOf(p);
  if (usdc === null || px === null || fee < 0n) return null;
  const margin = (usdc * CASH_MARGIN_BPS + 10_000n + CASH_MARGIN_BPS - 1n) / (10_000n + CASH_MARGIN_BPS);
  const num = (fee + margin) * px.d * 10n ** BigInt(POOL_DECIMALS[chain]);
  const den = px.n * 10n ** 6n;
  return (num + den - 1n) / den;
}

/** A move from Cash into Base's or Robinhood's pool that lands `short` wei of notes (card evm-cash-move-brings-its-fee;
 *  pool-buy-evm.ts evmMoveShort sizes it): `short` up to a whole number of the least rung, so every wei is a rung, and
 *  `notes` of them as the follow deposits them from U_X (ladderSplit), each with one deposit's `gas` (the pool's floor
 *  less its least rung); `left`, the least its quote must bring (the rungs and every deposit's gas), and `usdc`, what it
 *  asks Cash at the device's price, CASH_MARGIN_BPS over. Null with no price or nothing to move. One model: the mover's
 *  move, pool.buy.dry's Fee above tap_max (evmMoveCostOf) and its Cash check (main.ts) all read it. */
export function evmMoveOf(short: bigint, gas: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: "base" | "robinhood"): { left: bigint; notes: number; usdc: bigint } | null {
  const min = RUNG[chain];
  if (short <= 0n || gas < 0n || short >= 1n << 127n) return null;
  const rungs = ((short + min - 1n) / min) * min;
  const notes = ladderSplit(LADDER[chain], rungs).notes.length;
  const left = rungs + BigInt(notes) * gas;
  const usdc = cashUsdcExact(left, p, chain);
  return usdc === null ? null : { left, notes, usdc };
}
/** What that move costs for good, in wei at the device's price, rounded up (moveCostOf's sum on Base and Robinhood): the
 *  vault withdraw's relay `fee` (USDC), the CASH_MARGIN_BPS margin of the USDC it asks, and every deposit's gas from
 *  U_X. The rest arrives in the pool as the user's own notes. Null as evmMoveOf. */
export function evmMoveCostOf(short: bigint, gas: bigint, fee: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: "base" | "robinhood"): bigint | null {
  const m = evmMoveOf(short, gas, p, chain);
  const px = priceOf(p);
  if (m === null || px === null || fee < 0n) return null;
  const margin = (m.usdc * CASH_MARGIN_BPS + 10_000n + CASH_MARGIN_BPS - 1n) / (10_000n + CASH_MARGIN_BPS);
  const num = (fee + margin) * px.d * 10n ** BigInt(POOL_DECIMALS[chain]);
  const den = px.n * 10n ** 6n;
  return (num + den - 1n) / den + BigInt(m.notes) * gas;
}

/** USDC (6 decimals) a move asks for `short` base units of `chain`'s pool coin (lamports on Solana, wei on Base and
 *  Robinhood) at the device's price: the shortfall plus the ladder's least rung, plus CASH_MARGIN_BPS, rounded up; null
 *  with no price or no shortfall. */
export function cashUsdcFor(short: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: PoolChain = "solana"): bigint | null {
  const px = priceOf(p);
  if (px === null || short <= 0n) return null;
  const num = (short + RUNG[chain]) * px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS);
  const den = px.d * 10n ** BigInt(POOL_DECIMALS[chain]) * 10_000n;
  return (num + den - 1n) / den;
}
/** The base units of `chain`'s pool coin a move of `usdc` gives at most, at the device's price: less CASH_MARGIN_BPS
 *  and the ladder's least rung, rounded down; 0n when it gives none. */
export function cashLamportsFor(usdc: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: PoolChain = "solana"): bigint {
  const px = priceOf(p);
  if (px === null || usdc <= 0n) return 0n;
  const gross = (usdc * px.d * 10n ** BigInt(POOL_DECIMALS[chain]) * 10_000n) / (px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS));
  return gross > RUNG[chain] ? gross - RUNG[chain] : 0n;
}
/** A Cash note a move may spend: its id and value (USDC base units), as the withdraw form reads it (withdraw/checks.ts
 *  cashNotes). */
export type CashNote = { readonly id: string; readonly value: bigint };
/** One part of a move out of Cash (card cash-buys-spend-every-note): one withdrawal of note `note` (one note a proof:
 *  the vault's withdraw proof spends one commitment, contracts/vault/src/verifier.rs verify_withdraw), `usdc` into its own
 *  1Click quote and its own one-time address, `least` what that quote must bring of the pool's coin, `units` the part of
 *  the shortfall it covers. */
export type CashMovePart = { note: string; usdc: bigint; least: bigint; units: bigint };
/** How a chain's move of Cash prices a shortfall: `of(units)`, the USDC a move covering `units` asks and the least its
 *  quote must bring (null with none); `step`, the units a part covers in (1 on Solana, a rung on Base and Robinhood);
 *  `min`, the least units a part may cover (the pool's quote floor, as pool.address holds a quote to it); `leastIn`,
 *  the least USDC 1Click takes for the route, read live (0n with no read: each part's own quote is still asked before
 *  any part is sent). */
export type CashMoveModel = { of(units: bigint): { usdc: bigint; least: bigint } | null; step: bigint; min: bigint; leastIn: bigint };
/** Solana's model: a move covering `units` lamports asks cashUsdcFor (the units, one rung and CASH_MARGIN_BPS over) and
 *  must bring the units; a part covers at least the pool's `floor` less the rung its quote brings over (none read: one
 *  lamport). */
export function solanaMoveModel(p: Pick<PoolStatePrice, "price" | "expo">, floor: bigint | null, leastIn: bigint | null): CashMoveModel {
  return {
    of: (units) => {
      const usdc = cashUsdcFor(units, p, "solana");
      return usdc === null ? null : { usdc, least: units };
    },
    step: 1n,
    min: floor === null || floor - RUNG.solana < 1n ? 1n : floor - RUNG.solana,
    leastIn: leastIn ?? 0n,
  };
}
/** Base's and Robinhood's model (card cash-buys-spend-every-note-evm): a part covering `units` wei asks evmMoveOf's USDC
 *  (its rungs, each note the follow deposits from its one-time address with one deposit's gas: the pool's `floor` less
 *  its least rung) and must bring evmMoveOf's `left`; it covers whole least rungs (`step`), at least one (`min`), so its
 *  quote's least is at least `floor`, the least rung and one deposit's gas, as pool.address holds a quote to it. */
export function evmMoveModel(p: Pick<PoolStatePrice, "price" | "expo">, floor: bigint, leastIn: bigint | null, chain: "base" | "robinhood"): CashMoveModel {
  const gas = floor > RUNG[chain] ? floor - RUNG[chain] : 0n;
  return {
    of: (units) => {
      const m = evmMoveOf(units, gas, p, chain);
      return m === null || m.left < floor ? null : { usdc: m.usdc, least: m.left };
    },
    step: RUNG[chain],
    min: RUNG[chain],
    leastIn: leastIn ?? 0n,
  };
}
/** A Base or Robinhood move out of Cash as the page plans it (card cash-buys-spend-every-note-evm), one model for the
 *  mover's move, the tap's sizing (pool-buy-evm.ts evmMoveShort's rungs), its Fee and its Max: `parts`, planCashMove of
 *  `short` wei of rungs over every Cash note under evmMoveModel (kept per short, as a search asks the same size again);
 *  `rungs`, the rungs those parts land (each part's one-time address deposits its own ladderSplit); `cost`, what the
 *  move costs for good in wei (cashMoveCost, plus every landed note's deposit gas), null when Cash cannot make it;
 *  `top`, a bound above every wei the move brings (each note less its fee at the device's price, no margin). */
export type EvmCashPlan = { parts(short: bigint): CashMovePart[] | null; rungs(short: bigint): bigint[] | null; cost(short: bigint): bigint | null; top: bigint };
export function evmCashPlan(notes: readonly CashNote[], fee: bigint, p: Pick<PoolStatePrice, "price" | "expo">, floor: bigint, leastIn: bigint | null, chain: "base" | "robinhood"): EvmCashPlan {
  const model = evmMoveModel(p, floor, leastIn, chain);
  const gas = floor > RUNG[chain] ? floor - RUNG[chain] : 0n;
  const kept = new Map<bigint, CashMovePart[] | null>();
  const parts = (short: bigint): CashMovePart[] | null => {
    if (!kept.has(short)) kept.set(short, planCashMove(notes, fee, short, model));
    return kept.get(short)!;
  };
  const rungs = (short: bigint): bigint[] | null => parts(short)?.flatMap((x) => ladderSplit(LADDER[chain], x.units).notes) ?? null;
  return {
    parts,
    rungs,
    cost: (short) => {
      const x = parts(short);
      const c = x === null ? null : cashMoveCost(x, fee, p, chain);
      return c === null ? null : c + BigInt(rungs(short)!.length) * gas;
    },
    top: notes.reduce((t, n) => t + (n.value > fee ? evmCashWei(n.value - fee, p) : 0n), 0n),
  };
}
/** The most units a part of at most `usdc` covers under `m` (a whole number of steps, at least m.min, its USDC at least
 *  m.leastIn), with the USDC and least that cover asks; null when it covers none. */
function partOf(m: CashMoveModel, usdc: bigint): { units: bigint; usdc: bigint; least: bigint } | null {
  const fits = (k: bigint) => {
    const o = m.of(k * m.step);
    return o !== null && o.usdc <= usdc;
  };
  if (usdc <= 0n || !fits(1n)) return null;
  let lo = 1n;
  let hi = 2n;
  while (fits(hi)) {
    lo = hi;
    if (hi >= 1n << 128n) break;
    hi *= 2n;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const units = lo * m.step;
  const o = m.of(units)!;
  return units < m.min || o.usdc < m.leastIn ? null : { units, ...o };
}
/**
 * The parts of a move out of Cash that covers `short` units of a pool's coin (card cash-buys-spend-every-note): over every
 * UNSPENT note, never only the largest. One note that pays the whole move and its `fee`, with no change or change above
 * two fees (the note floor), pays it alone, the smallest such (the move before this card). Else the notes largest first,
 * each spent whole (no change note: its value less the fee, all of it moved, so nothing is left in Cash under a fee),
 * until the next note pays what is left with a valid change; a note whose part would cover none of the shortfall, clear
 * no quote floor or bring less than 1Click takes (CashMoveModel min, leastIn) is never asked: it stays in Cash. Null when
 * Cash cannot cover `short`.
 *
 * Not withdraw/checks.ts planCashSpend (NEAR's planner): that plans a fixed USDC sum, and a move's USDC grows with its
 * parts (each its own quote brings a rung over and must clear the quote's floor and 1Click's least on its own).
 */
export function planCashMove(notes: readonly CashNote[], fee: bigint, short: bigint, m: CashMoveModel): CashMovePart[] | null {
  if (short <= 0n || fee < 0n) return null;
  const change = (value: bigint, usdc: bigint) => value - usdc - fee === 0n || value - usdc - fee > 2n * fee;
  const lastOf = (n: CashNote, left: bigint): CashMovePart | null => {
    const units = left < m.min ? m.min : ((left + m.step - 1n) / m.step) * m.step;
    const o = m.of(units);
    if (o === null || o.usdc < m.leastIn || o.usdc + fee > n.value) return null;
    // a change under the note floor: the note goes whole, its rest moved too
    return change(n.value, o.usdc) ? { note: n.id, usdc: o.usdc, least: o.least, units } : { note: n.id, usdc: n.value - fee, least: o.least, units };
  };
  const asc = [...notes].sort((x, y) => (x.value !== y.value ? (x.value < y.value ? -1 : 1) : x.id < y.id ? -1 : 1));
  for (const n of asc) {
    const one = lastOf(n, short);
    if (one !== null && change(n.value, one.usdc)) return [one];
  }
  const parts: CashMovePart[] = [];
  let left = short;
  const desc = [...asc].reverse();
  for (let i = 0; i < desc.length; i++) {
    const n = desc[i]!;
    const last = lastOf(n, left);
    if (last !== null) return [...parts, last];
    const whole = partOf(m, n.value - fee);
    if (whole === null) continue;
    parts.push({ note: n.id, usdc: n.value - fee, least: whole.least, units: whole.units });
    left -= whole.units;
    if (left <= 0n) return parts;
  }
  return null;
}
/** The most a move out of Cash covers under `m` (Max with Cash): every note a part may be made of, each whole. */
export function cashMoveMost(notes: readonly CashNote[], fee: bigint, m: CashMoveModel): bigint {
  return notes.reduce((t, n) => t + (partOf(m, n.value - fee)?.units ?? 0n), 0n);
}
/** What a move of `parts` costs for good, in the pool coin's base units at the device's price, rounded up per part (a
 *  one-part move: moveCostOf): each part's withdraw relay `fee` and the CASH_MARGIN_BPS margin of its USDC. Null with no
 *  price. */
export function cashMoveCost(parts: readonly CashMovePart[], fee: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: PoolChain): bigint | null {
  const px = priceOf(p);
  if (px === null || fee < 0n) return null;
  let t = 0n;
  for (const x of parts) {
    const margin = (x.usdc * CASH_MARGIN_BPS + 10_000n + CASH_MARGIN_BPS - 1n) / (10_000n + CASH_MARGIN_BPS);
    const num = (fee + margin) * px.d * 10n ** BigInt(POOL_DECIMALS[chain]);
    const den = px.n * 10n ** 6n;
    t += (num + den - 1n) / den;
  }
  return t;
}
/** pool.move of exactly `usdc` out of Cash, planned over every UNSPENT note (card move-from-cash-spends-every-note: a
 *  withdraw proof spends one note, so Cash split over notes each under the move was refused against its largest note):
 *  `parts`, one withdrawal a note, each part its own quote of its USDC that must bring `least` of it (the pool coin's
 *  least at the device's price, cashLamportsFor), null when no plan sends `usdc` exactly; `fee`, the relay fee a part;
 *  `max`, every note whole less its fee, each one that gives a part (the whole of Cash); `min`, for an amount under the
 *  least part, that least; `below` and `above`, for one no plan sends, the nearest a plan sends.
 *  The least part (`part`) clears the request's own rule (above its fee), 1Click's least for the route (`leastIn`, read
 *  live) and the pool's quote `floor` (its least at least the floor, as pool.address holds a quote to), so no part is
 *  asked that its quote refuses. One note that pays it with no change or a change a later move can send (the note floor
 *  at that least part) pays it alone, the smallest such: the larger notes stay whole. Else the Cash form's own planner
 *  of an exact sum (withdraw/checks.ts planCashWithdraw: the fewest parts, every change 0 or above that floor), not
 *  planCashMove, which sizes a pool coin's shortfall and may take more USDC than asked. Null with no least part. */
export type CashExact = { fee: bigint; max: bigint; part: bigint; parts: CashMovePart[] | null; min?: bigint; below?: bigint; above?: bigint };
export function planCashExact(notes: readonly CashNote[], fee: bigint, usdc: bigint, least: (usdc: bigint) => bigint, floor: bigint, leastIn: bigint | null): CashExact | null {
  if (fee < 0n || usdc <= 0n) return null;
  const part = leastWhere((u) => u > fee && u >= (leastIn ?? 0n) && least(u) >= floor);
  if (part === null) return null;
  const max = cashSendable(notes, fee, part);
  const of = (plan: readonly { noteId: string; part: bigint }[]): CashMovePart[] => plan.map((x) => ({ note: x.noteId, usdc: x.part, least: least(x.part), units: least(x.part) }));
  if (usdc > max) return { fee, max, part, parts: null };
  if (usdc < part) return { fee, max, part, parts: null, min: part };
  const room = withdrawNoteFloor(cashCosts(fee, part));
  const one = [...notes]
    .filter((n) => n.value - fee >= usdc && (n.value - fee === usdc || n.value - fee - usdc >= room))
    .sort((x, y) => (x.value !== y.value ? (x.value < y.value ? -1 : 1) : x.id < y.id ? -1 : 1))[0];
  if (one !== undefined) return { fee, max, part, parts: of([{ noteId: one.id, part: usdc }]) };
  const plan = planCashWithdraw(notes, usdc, fee, part);
  if (plan !== null) return { fee, max, part, parts: of(plan) };
  return { fee, max, part, parts: null, ...nearestPlannable(notes, usdc, cashCosts(fee, part)) };
}
/** 1Click's least amount in (USDC base units) for a move of Cash into `chain`'s pool, read live: a dry quote through the
 *  helper's 1Click proxy (nothing is made, nothing sent), whose refusal names it ("Amount is too low for bridge, try at
 *  least N", 13:0xZ 15 Nov: 75,621 into SOL, 18,533 into Robinhood's ETH). One unit first; where 1Click cannot price so
 *  little it answers "Failed to get quote" (into Base's ETH at one unit, 15 Nov 13:30Z, "try at least 1042" at ten;
 *  into Robinhood's the same by 13:31Z), and the read asks again at ten times as much, up to one USDC (card
 *  cash-buys-spend-every-note-evm). An amount it quotes is one it takes: that amount.
 *  An answer that is neither (card cash-least-read-again: sign live run 44300899132, 18 Nov 12:09Z, read "Failed to get
 *  quote" and "No liquidity available" over seconds in which 1Click named its least before and after) is a blip when it
 *  is "Failed to get quote" at one USDC, "No liquidity available", a 429, a 5xx or no answer: the same amount is asked
 *  again, LEAST_READ_TRIES tries of it in all. Any other refusal names no least and is never asked again. With no least
 *  the read throws naming why, so no move is planned without it (cashMover: down). `sleep` and `signal` are the injected
 *  clock's wait and the read's budget (default: setTimeout, and LEAST_READ_BUDGET_MS from now). */
export async function readOneClickLeast(chain: PoolChain, fetchFn: typeof fetch, now: number, o: { sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}): Promise<bigint> {
  const signal = o.signal ?? AbortSignal.timeout(LEAST_READ_BUDGET_MS);
  const sleep =
    o.sleep ??
    ((ms: number) =>
      new Promise<void>((ok) => {
        // a budget that ended before the wait (inside the read just made) never fires again: no backoff on it
        if (signal.aborted) return ok();
        const t = setTimeout(ok, ms);
        signal.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
      }));
  const late = () => new Error(`1Click gave no least within ${LEAST_READ_BUDGET_MS} ms`);
  const top = 10n ** BigInt(USDC_DECIMALS);
  let amount = 1n;
  let tries = 0;
  for (;;) {
    if (signal.aborted) throw late();
    const body = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: `nep141:${NEAR_NETWORKS.mainnet.usdc}`, depositType: "INTENTS", destinationAsset: POOL_COIN_ONECLICK[chain],
      amount: amount.toString(), refundTo: DEPOSIT_DRY_PLACEHOLDER, refundType: "INTENTS", recipient: LEAST_RECIPIENT[chain], recipientType: "DESTINATION_CHAIN", deadline: new Date(now + 600_000).toISOString(),
    };
    let blip: string;
    try {
      const r = await fetchFn(DEPOSIT_QUOTE_URL, { ...HELPER_FETCH_INIT, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
      const text = (await r.text()).slice(0, 4096);
      const m = /"message"\s*:\s*"Amount is too low for bridge, try at least (\d{1,30})"/.exec(text);
      if (m !== null && BigInt(m[1]!) > 0n) return BigInt(m[1]!);
      if (m === null && (r.status === 200 || r.status === 201)) return amount;
      const failed = /"message"\s*:\s*"Failed to get quote"/.test(text);
      // where 1Click cannot price so little: ten times as much, up to one USDC
      if (failed && amount < top) {
        amount *= 10n;
        continue;
      }
      const said = `HTTP ${r.status} ${/"message"\s*:\s*"([^"]{0,120})"/.exec(text)?.[1] ?? text.slice(0, 120).replace(/\s+/g, " ")}`;
      const again = failed || /"message"\s*:\s*"No liquidity available"/.test(text) || r.status === 429 || r.status >= 500;
      if (m !== null || !again) throw new LeastRefused(`1Click names no least: ${said}`);
      blip = said;
    } catch (e) {
      if (e instanceof LeastRefused) throw e;
      if (signal.aborted) throw late();
      blip = `no answer (${e instanceof Error ? e.name : "failed"})`;
    }
    if (++tries >= LEAST_READ_TRIES) throw new Error(`1Click gave no least in ${LEAST_READ_TRIES} tries: ${blip}`);
    await sleep(LEAST_READ_BACKOFF_MS[tries - 1]!);
  }
}
/** The least read's bound (card cash-least-read-again): the industry's standard retry (the AWS SDKs' "standard" mode:
 *  three attempts in all, exponential backoff), its waits short enough that the whole read, every request and wait, ends
 *  within LEAST_READ_BUDGET_MS: the 10 s the kit gives pool.buy.dry and pool.move.dry an answer (SIGNPAGE_TIMEOUT_MS),
 *  the reads this one runs beside, so it adds no wait the user sees past theirs. A blip longer than that leaves the move
 *  down for now, and the next dry or tap reads again (main.ts keeps no failed read). */
export const LEAST_READ_TRIES = 3;
export const LEAST_READ_BACKOFF_MS: readonly number[] = Object.freeze([500, 1_500]);
export const LEAST_READ_BUDGET_MS = 10_000;
/** 1Click's answer that names no least and is no blip: never asked again. */
class LeastRefused extends Error {}
/** Each pool's coin, 1Click's id (as src/pool-to-cash.ts POOL_COIN_ASSET, which imports this module). */
const POOL_COIN_ONECLICK: Readonly<Record<PoolChain, string>> = { solana: "nep141:sol.omft.near", base: "nep141:base.omft.near", robinhood: "nep141:hood.omft.near" };
/** A dry read's recipient, an address of no one's: the wrapped-SOL mint (1Click refuses the system program as one: "recipient is not valid", 15 Nov 12:49Z), an EVM address of ones. */
const LEAST_RECIPIENT: Readonly<Record<PoolChain, string>> = { solana: "So11111111111111111111111111111111111111112", base: "0x1111111111111111111111111111111111111111", robinhood: "0x1111111111111111111111111111111111111111" };
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

/** A move's op record in the store's "ops" (kit messages.ts Operation kind "move"), under its op id: amounts in whole
 *  units of each side's asset; `cash` (pool to pool, src/pool-to-cash.ts): the deposit quote's least USDC in base units,
 *  what its onward move from Cash is sized by (kept in the store, never in state.ops). Nothing secret: no key, note,
 *  address of the user's or which note is whose. */
/** A move op's record. A move out of a pool (src/pool-to-cash.ts, card move-sends-or-says-why) also keeps `send_by_ms`,
 *  the time its source release must have been claimed by; `claimed_ms`, the run's claim, written by compare-and-set right
 *  before anything leaves the device; and `error`, the refusal a move that failed before it sent ends with. */
export type MoveOpRecord = { kind: "move"; from: TradeChain; to: TradeChain; stage: MoveStage; txs: TxRef[]; amount: string; out?: string; created_ms: number; cash?: string; send_by_ms?: number; claimed_ms?: number; error?: ErrorCode; last?: TraceLast };
/** How long a move has, from its tap, to start sending (card move-sends-or-says-why). Out of a pool: its quote (one
 *  1Click round trip and its keyless tell), then a withdraw part's reads, its wait for an epoch's root (one 60 s epoch
 *  and WITHDRAW_BOUNDARY_LAG_MS 30 s), its proof (6.7 s on a laptop, several times that on a phone) and its bind, about
 *  twice over. Out of Cash: its quote, the vault's trees and the relayer's fee, and its proof, well inside the same.
 *  Far inside the quote's 30 min deadline (DEPOSIT_QUOTE_DEADLINE_MS), so a send claimed at the last moment still lands
 *  in time. */
export const MOVE_SEND_MS = 300_000;

/** A move's send-by: its own send_by_ms, or, for a move written before this card (release 137 and earlier, no
 *  send_by_ms), its tap's time plus MOVE_SEND_MS. */
export const sendByOf = (rec: MoveOpRecord): number => rec.send_by_ms ?? rec.created_ms + MOVE_SEND_MS;

/** The claim's compare-and-set on a move record (card move-sends-or-says-why): claimed once already, or still leaving
 *  inside its send-by; never a move ended, nor one past its send-by with no claim. */
export function claimed(rec: MoveOpRecord | undefined, now: number): MoveOpRecord | null {
  if (rec === undefined || rec.kind !== "move" || rec.stage === "failed" || rec.stage === "done") return null;
  if (rec.claimed_ms !== undefined) return rec;
  if (rec.stage === "leaving" && now >= sendByOf(rec)) return null;
  return { ...rec, claimed_ms: now };
}

/** Whether a move's pool run (its op under <id>/out) shows no release sent: no record, or one still before its send or
 *  stopped, with no tx. in_transit is written before a release leaves (pool-testnet.ts owe), so it counts as sent. */
export const nothingSent = (out: { stage?: unknown; txs?: readonly unknown[] } | undefined): boolean =>
  out === undefined || ((out.stage === "proving" || out.stage === "stopped") && (!Array.isArray(out.txs) || out.txs.length === 0));

/** The follow's end of a move nothing sent for in time: failed only while still leaving, unclaimed and past its
 *  send-by. A move written before this card had no claim to write, so it ends only while its run (`out`) shows no
 *  release sent; one whose run sent is followed on as before. */
export function expired(rec: MoveOpRecord | undefined, now: number, out?: { stage?: unknown; txs?: readonly unknown[] }): MoveOpRecord | null {
  if (rec === undefined || rec.kind !== "move" || rec.stage !== "leaving" || rec.claimed_ms !== undefined || now < sendByOf(rec)) return null;
  if (rec.send_by_ms === undefined && !nothingSent(out)) return null;
  return { ...rec, stage: "failed", error: "not_sent" };
}

/** What a move's follow op (the quote's pool_deposit op, pool-deposit-follow.ts PoolDepositOp) says, read from the store. */
export type MoveFollow = { stage: string; final?: true; txs?: readonly TxRef[]; follow?: { deadline_ms?: unknown } };
/** A part of a move out of Cash, at its stop (card cash-buy-waits-for-its-move): its money reached the pool (the follow's
 *  in_pool), or it stopped with why (its withdraw failed or was not sent by its send-by, its quote's follow failed or was
 *  refunded, its quote's deadline passed with nothing delivered, the sign out). */
export type MoveReach = { landed: true } | { landed: false; error: string };
/** A follow stage that says nothing reached U_X yet: past the quote's deadline, the part stops. */
const UNDELIVERED = new Set(["quote_checked", "waiting", "expired"]);

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
  /** Every UNSPENT note of the vault's scope (withdraw/checks.ts cashNotes), which a buy's move plans its parts over
   *  (planCashMove: cards cash-buys-spend-every-note on Solana, cash-buys-spend-every-note-evm on Base and Robinhood);
   *  none: the one note `cash` names. */
  notes?(): Promise<readonly CashNote[]>;
  /** 1Click's least amount in for a move into `chain`'s pool, read live (readOneClickLeast); none or null: no bound but
   *  each part's own quote. A read that throws (no least, card cash-least-read-again): no move is planned, down. */
  least?(chain: PoolChain): Promise<bigint | null>;
  /** The vault's hand-off (withdrawHandoff); null where the network names no vault or relayer. `note`, when given, is the
   *  note the withdrawal spends (a part's, planCashMove); none: the request's own pick. `claim`, when given, is awaited
   *  right before its note goes RESERVED (wallet withdraw/request.ts): a throw ends it with nothing sent. `mark` hears its
   *  proof start and end and its relay's send (the trace, card buy-shows-every-step). */
  handoff: ((w: CheckedWithdraw, drawnFee: bigint, note?: string, claim?: () => Promise<void>, mark?: HandoffMark) => Promise<HandoffEnd>) | null;
  /** The quote's floor on a pool (pool.address's: on an EVM pool its least rung plus one deposit's gas, on Solana the
   *  rung, one deposit's cost and the rent U_X keeps; read now), null with no read: a note made for an EVM tap is quoted
   *  at the rung plus that gas, and a move's dry is held to it (bounds). */
  floor?(chain: PoolChain): Promise<bigint | null>;
  /** Whether the follow op under `id` has ended (its money in the pool, or refunded): no longer on its way. */
  landed(id: string): Promise<boolean>;
  now(): number;
  /** Writes the move op under its id (the store's "ops"); none: no op is written. */
  put?(id: string, rec: MoveOpRecord): Promise<void>;
  /** The move op's compare-and-set (the wallet store's update: `change` gets the stored record and gives the next, or
   *  undefined to write nothing; resolves with what it wrote). Given, every write goes through it and the move keeps a
   *  send-by (card move-sends-or-says-why): its claim before the vault's note goes RESERVED, its end past it unclaimed. */
  update?(id: string, change: (rec: MoveOpRecord | undefined) => MoveOpRecord | undefined): Promise<unknown>;
  /** The quote's follow op under `id`, read from the store; none: the move op stops at in_transit. */
  follow?(id: string): Promise<MoveFollow | undefined>;
  /** The wait between two reads of the follow op (setTimeout otherwise). */
  wait?(ms: number): Promise<void>;
  /** The sign out: a move op's follow reads stop. */
  signal?: AbortSignal;
};

// a part on its way: counted (coming) and joined (need) until it reaches the pool or stops (`reached`), never by a clock
type Way = { chain: PoolChain; id: string; op: string; lamports: bigint; reached: MoveReach | null };

/** A move op's stage from its follow op's (pool-deposit-follow.ts): done once the follow ended in the pool (in_pool
 *  final), into_pool while the money that reached U_X goes into the pool, refunded while 1Click's refund is carried on,
 *  failed when the quote expired, in_transit while 1Click carries it (its failed and short are still 1Click's). */
export function moveStageOfFollow(f: MoveFollow): MoveStage {
  if (f.stage === "in_pool") return f.final === true ? "done" : "into_pool";
  if (f.stage === "refunded" || f.stage === "refund_move") return "refunded";
  if (f.stage === "expired") return "failed";
  return "in_transit";
}

/** `x` base units at `d` decimals as a decimal string, no trailing zero. */
export function unitsText(x: bigint, d: number): string {
  const t = x.toString().padStart(d + 1, "0");
  const f = t.slice(t.length - d).replace(/0+$/, "");
  return f ? `${t.slice(0, t.length - d)}.${f}` : t.slice(0, t.length - d);
}
const USDC_DECIMALS = 6;
/** unitsText's inverse: a decimal of at most `d` fraction digits in base units; null when it is not one. */
export function unitsOf(x: string, d: number): bigint | null {
  const m = new RegExp(`^(0|[1-9]\\d{0,40})(?:\\.(\\d{1,${d}}))?$`).exec(x);
  return m === null ? null : BigInt(m[1]!) * 10n ** BigInt(d) + BigInt((m[2] ?? "").padEnd(d, "0"));
}

/** A move out of Cash: refused, or on its way under its op id with the least it delivers. */
export type MoveSent = Refusal | { op: string; minOut: bigint };
export type CashMover = {
  /** Starts or joins a move for a buy's shortfall on `chain`: the op id of a move on its way for it, else null. */
  need(chain: PoolChain, short: bigint): Promise<string | null>;
  /** Moves exactly `usdc` of Cash into `chain`'s pool under the op id `id` (pool.move): `plan`'s parts, every check
   *  `need`'s move has, each part's quote's least at least what its USDC buys at the device's price less
   *  CASH_MARGIN_BPS and the least rung; refused with nothing sent when no plan sends `usdc` (not_funded above Max,
   *  below_min under the least part, not_allowed otherwise). */
  move(chain: PoolChain, usdc: bigint, id: string): Promise<MoveSent>;
  /** The plan `move` sends for `usdc` (planCashExact over every Cash note, read now), which pool.move.dry prices; down
   *  when the pool's floor cannot be read now. */
  plan(chain: PoolChain, usdc: bigint): Promise<Refusal | CashExact>;
  /** What an onward move into `chain` is held to before anything moves (card move-sends-what-it-shows): the vault
   *  withdraw's fee and the least of `chain`'s coin a quote into its pool may bring (`floor`: the pool's deposit floor,
   *  as pool.address checks it; null with no read). Cash is not read here: a move out of another pool brings its USDC
   *  first. */
  bounds(chain: PoolChain): Promise<Refusal | { fee: bigint; floor: bigint | null }>;
  /** The least of `chain`'s coin a quote for `usdc` must bring (cashLamportsFor at the device's price); 0n with none. */
  least(chain: PoolChain, usdc: bigint): bigint;
  ways(): number;
  coming(chain: PoolChain): bigint;
  /** Settles once every part of the move under `op` (need's or move's op id) reached the pool or stopped (card
   *  cash-buy-waits-for-its-move): `landed` when any part's money is in the pool, else the first stop's words. An op
   *  this mover started no part for: stopped. */
  landing(op: string): Promise<{ landed: boolean; error?: string }>;
  /** After a reload (main.ts, at sign-in): each move op not yet done or failed follows its quote's follow op
   *  (`<op>/1click`, the one rail) on from its last stage; nothing is quoted or withdrawn again. */
  resume(moves: readonly { id: string; rec: MoveOpRecord }[]): void;
  /** Settles once every move op this mover follows has stopped (tests). */
  idle(): Promise<void>;
};

/** The mover: one code path for every move out of Cash, a buy's shortfall (`need`) and pool.move (`move`). */
export function cashMover(d: CashMoverDeps): CashMover {
  let ways: Way[] = [];
  let turn: Promise<unknown> = Promise.resolve();
  const tracks: Promise<void>[] = [];
  // each part's stop, once (card cash-buy-waits-for-its-move): its way leaves `coming` then, and a tap waiting on its
  // move (landing) hears it; `moves`, every part's stop under its move's op
  const reachers = new Map<string, (r: MoveReach, counted: boolean) => void>();
  const moves = new Map<string, Promise<MoveReach>[]>();
  // `counted`: the way still counts as on its way (a mover with no follow to read: only `landed` ends it)
  const reach = (op: string, r: MoveReach, counted = false): void => {
    reachers.get(op)?.(r, counted);
    reachers.delete(op);
  };
  const way = (chain: PoolChain, id: string, op: string, lamports: bigint, root: string): void => {
    const w: Way = { chain, id, op, lamports, reached: null };
    const p = new Promise<MoveReach>((r) => reachers.set(op, (x, counted) => (counted || (w.reached = x), r(x))));
    ways.push(w);
    moves.set(root, [...(moves.get(root) ?? []), p]);
  };
  const put = async (id: string, rec: MoveOpRecord): Promise<void> => {
    try {
      // with a compare-and-set: the stored claim and send-by kept, and a move that ended failed (its send-by passed
      // unclaimed) never written back to a live stage
      if (d.update) await d.update(id, (v) => (v?.stage === "failed" && rec.stage !== "failed" ? undefined : { ...rec, ...(v?.claimed_ms === undefined ? {} : { claimed_ms: v.claimed_ms }), ...(v?.send_by_ms === undefined || rec.send_by_ms !== undefined ? {} : { send_by_ms: v.send_by_ms }), ...(v?.last === undefined || rec.last !== undefined ? {} : { last: v.last }) }));
      else await d.put?.(id, rec);
    } catch {
      /* a write that fails costs the display, never the move */
    }
  };
  // the hand-off's claim, right before the vault's note goes RESERVED: refused (a throw) once the move ended or passed
  // its send_by_ms with no claim, so the note goes back UNSPENT and nothing is sent
  const claimOf = (id: string): (() => Promise<void>) | undefined =>
    d.update === undefined
      ? undefined
      : async () => {
          const now = d.now();
          let ok = false;
          await d.update!(id, (v) => {
            const c = claimed(v, now);
            ok = c !== null;
            return c === null || c === v ? undefined : c;
          });
          if (!ok) throw new Error("the move may no longer send");
        };
  // past its send_by_ms with no claim, a move still leaving ends failed, its refusal not_sent (true when written). Only
  // a move written with a send_by_ms: one from before it never claimed, so leaving tells nothing of what it sent
  const expire = async (id: string): Promise<boolean> => {
    if (d.update === undefined) return false;
    const now = d.now();
    return (await d.update(id, (v) => (v?.send_by_ms === undefined ? undefined : (expired(v, now) ?? undefined))).catch(() => undefined)) !== undefined;
  };
  // the trace's last line of a part's op, kept in its record alone (card buy-shows-every-step): a compare-and-set of
  // that one field, so a line never steps a stage back
  const keepLast = (id: string, last: TraceLast): void => {
    if (d.update) void d.update(id, (v) => (v === undefined || v.kind !== "move" ? undefined : { ...v, last })).catch(() => {});
  };
  const lastOf = (last: TraceLast): { last?: TraceLast } => (d.update ? { last } : {});
  // the move op's stages after the hand-off: in_transit once the vault's withdraw landed, then the follow op's. A
  // hand-off that ends any other way, or throws (`thrown`, its words), fails the move with why: withdraw_<its end>
  const track = async (op: string, followId: string, rec: MoveOpRecord, ended: Promise<HandoffEnd | null>, thrown: () => string | undefined = () => undefined): Promise<void> => {
    const e = await ended;
    const txs: TxRef[] = e !== null && "tx" in e && typeof e.tx === "string" ? [{ chain: "near", hash: e.tx }] : [];
    const tx: TraceFields = txs[0] ? { tx: txs[0].hash } : {};
    if (e === null || !(e.kind === "arrived" || e.kind === "landed")) {
      const error: ErrorCode = e === null ? "withdraw_failed" : `withdraw_${e.kind}`;
      const words = e === null ? (thrown() ?? "the vault's withdraw threw") : `the vault's withdraw ended ${e.kind}${e.kind === "fee" && "fee" in e ? ` (the relayer's fee now ${e.fee}, above the fee drawn)` : ""}`;
      const last = trace(op, null, "end", { stage: "failed", ...tx, error: words });
      await put(op, { ...rec, stage: "failed", txs, ...(d.update ? { error } : {}), ...lastOf(last) });
      return reach(op, { landed: false, error: words });
    }
    const cur: MoveOpRecord = { ...rec, stage: "in_transit", txs, ...lastOf(trace(op, null, "vault_payout", { stage: e.kind, ...tx })) };
    await put(op, cur);
    return followOn(op, followId, cur);
  };
  // the follow op's stages from `cur` on, until the move is done or failed (or the sign out). Its stop for a tap that
  // waits on it (card cash-buy-waits-for-its-move): its money in the pool (into_pool or done); failed or refunded; its
  // quote's deadline past with nothing delivered; the sign out
  const followOn = async (op: string, followId: string, from: MoveOpRecord): Promise<void> => {
    // no follow to read: the vault's payout is the last the mover sees, and what one tap spends tells the rest
    if (!d.follow) return reach(op, { landed: true }, true);
    let cur = from;
    const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (!d.signal?.aborted) {
      // a move still leaving (a reload's: its hand-off is gone) ends at its send-by unless its claim came first
      if (cur.stage === "leaving" && (await expire(op))) return reach(op, { landed: false, error: "the vault's withdraw was not sent by its send-by" });
      const f = await d.follow(followId).catch(() => undefined);
      if (f !== undefined) {
        const stage = moveStageOfFollow(f);
        const add = (f.txs ?? []).filter((t, k, all) => typeof t?.hash === "string" && !cur.txs.some((x) => x.hash === t.hash) && all.findIndex((y) => y.hash === t.hash) === k).map((t) => ({ chain: t.chain, hash: t.hash }));
        if (stage !== cur.stage || add.length > 0) {
          cur = { ...cur, stage, txs: [...cur.txs, ...add] };
          if (stage === "done" || stage === "failed" || stage === "refunded") cur = { ...cur, ...lastOf(trace(op, null, "end", { stage, ...(stage === "done" ? {} : { error: `the quote's follow ended ${f.stage}` }) })) };
          await put(op, cur);
        }
        if (stage === "into_pool" || stage === "done") reach(op, { landed: true });
        else if (stage === "failed" || stage === "refunded") reach(op, { landed: false, error: `the quote's follow ended ${f.stage}` });
        if (stage === "done" || stage === "failed") return;
      }
      // its quote's deadline past with nothing delivered: the tap stops waiting on it, its words kept as the part's last
      // step; the follow reads on (a late send is still carried into the pool or refunded)
      const deadline = typeof f?.follow?.deadline_ms === "number" ? f.follow.deadline_ms : cur.created_ms + DEPOSIT_QUOTE_DEADLINE_MS;
      if (reachers.has(op) && (f === undefined || UNDELIVERED.has(f.stage)) && d.now() > deadline + CASH_MOVE_DEADLINE_MARGIN_MS) {
        const words = "the quote's deadline passed with nothing delivered";
        keepLast(op, trace(op, null, "end", { stage: cur.stage, error: words }));
        reach(op, { landed: false, error: words });
      }
      await wait(CASH_MOVE_POLL_MS);
    }
    reach(op, { landed: false, error: "signed out" });
  };
  // a move's parts (card cash-buys-spend-every-note): every part's quote first, each held to every check, and only when
  // every one passed does any note leave Cash, each part's withdrawal of its own note to its own quote's address; a part
  // refused fails every part's op with its refusal, nothing sent. The first part's op is the move's.
  const sendParts = async (chain: PoolChain, parts: readonly CashMovePart[], op: string, fee: bigint): Promise<MoveSent> => {
    const quoted: Quoted[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const a = await quoteOne(chain, p.usdc, p.least, i === 0 ? op : `${op}/${i}`, unitsText(p.usdc, USDC_DECIMALS), p.note === "" ? undefined : p.note, op, i);
      if ("error" in a) {
        for (const q of quoted) await put(q.op, { ...q.rec, stage: "failed", ...(d.update ? { error: a.error } : {}) });
        return { error: a.error };
      }
      quoted.push(a);
    }
    return quoted.map((q) => handOne(chain, q, fee, op))[0]!;
  };
  type Quoted = { op: string; rec: MoveOpRecord; q: CashQuote; used: string; note?: string };
  const quoteOne = async (chain: PoolChain, usdc: bigint, least: bigint, op: string, amount: string, note: string | undefined, root: string, part: number): Promise<Quoted | Refusal> => {
    // the trace's time 0 and the part's ids (its op, its follow's) read as the move's, part `part`
    traceBegin(root);
    traceAlias(op, root, part);
    // the move's record, leaving with its send_by_ms, written before its quote is asked (card move-sends-or-says-why):
    // from the tap on, the app follows an op that ends, never a request with nothing behind it
    const now = d.now();
    const rec: MoveOpRecord = { kind: "move", from: "near", to: chain, stage: "leaving", txs: [], amount, created_ms: now, ...(d.update ? { send_by_ms: now + MOVE_SEND_MS } : {}) };
    await put(op, rec);
    let q: CashQuote | Refusal = { error: "not_allowed" };
    let used = `${op}/${d.rails[0]}`;
    // the rails' quotes, all of them by the move's send-by: past it the rail is down and nothing is paid
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Refusal>((r) => (t = setTimeout(() => r({ error: "down" }), Math.max(0, sendByOf(rec) - d.now()))));
    q = await Promise.race([
      (async () => {
        let a: CashQuote | Refusal = { error: "not_allowed" };
        for (const rail of d.rails) {
          used = `${op}/${rail}`;
          a = await d.quote(chain, usdc, used, rail);
          if (!("error" in a)) break;
        }
        return a;
      })(),
      late,
    ]).finally(() => clearTimeout(t));
    traceAlias(used, root, part);
    if ("error" in q || !IMPLICIT.test(q.address) || q.amountIn !== usdc || q.minOut < least) {
      const error = "error" in q ? q.error : "quote_check_failed";
      const why = "error" in q ? `the quote was refused: ${q.error}` : !IMPLICIT.test(q.address) ? "the quote's deposit address is not a NEAR implicit account" : q.amountIn !== usdc ? `the quote takes ${q.amountIn}, not the ${usdc} asked` : `the quote's least out ${q.minOut} is under the ${least} the move needs`;
      const last = trace(op, null, "quote", { quote: used, ...("address" in q && typeof q.address === "string" ? { address: q.address } : {}), error: why });
      await put(op, { ...rec, stage: "failed", ...(d.update ? { error } : {}), ...lastOf(last) });
      return { error };
    }
    const leaving: MoveOpRecord = { ...rec, out: unitsText(q.minOut, POOL_DECIMALS[chain]), ...lastOf(trace(op, null, "quote", { quote: used, address: q.address, amount: unitsText(q.minOut, POOL_DECIMALS[chain]) })) };
    await put(op, leaving);
    return { op, rec: leaving, q, used, ...(note === undefined ? {} : { note }) };
  };
  const handOne = (chain: PoolChain, a: Quoted, fee: bigint, root: string): MoveSent => {
    const { op, rec: leaving, q, used } = a;
    const rec = leaving;
    const usdc = q.amountIn;
    const claim = claimOf(op);
    // the hand-off's steps as trace lines, each kept as the part's last (a hand-off that hangs shows where); its throw's
    // words kept for the failed move's line
    let thrown: string | undefined;
    const mark: HandoffMark = (step, f) => keepLast(op, trace(op, null, step, f ?? {}));
    const ended = d.handoff!({ recipient: q.address, amount: usdc }, fee, a.note, claim, mark).catch((x: unknown) => ((thrown = errorText(x)), null));
    // the send-by while the hand-off runs: a hand-off that has not claimed by then ends the move failed, not_sent, and
    // its claim is refused after it
    if (d.update) {
      let s: ReturnType<typeof setTimeout> | undefined;
      const at = new Promise<void>((r) => (s = setTimeout(r, Math.max(0, sendByOf(rec) - d.now()))));
      void Promise.race([ended.then(() => false), at.then(() => true)])
        .then((due) => (clearTimeout(s), due ? expire(op) : false))
        .then((ended) => ended && reach(op, { landed: false, error: "the vault's withdraw was not sent by its send-by" }));
    }
    way(chain, used, op, q.minOut, root);
    tracks.push(track(op, used, leaving, ended, () => thrown).catch(() => {}));
    return { op, minOut: q.minOut };
  };
  const prune = async (): Promise<void> => {
    // what is on its way already: a part whose money reached the pool (its notes are the pool's now), or that stopped,
    // or whose follow ended, no longer counts; one still on its way counts however long it takes (card
    // cash-buy-waits-for-its-move: never dropped by a clock, so its money is never counted nowhere, nor moved twice)
    const kept: Way[] = [];
    for (const w of ways) if (w.reached === null && !(await d.landed(w.id).catch(() => false))) kept.push(w);
    ways = kept;
  };
  // 1Click's least read now: null with none given (no bound but each part's own quote), undefined when the read gave
  // none (readOneClickLeast threw): no plan
  const leastNow = (chain: PoolChain): Promise<bigint | null | undefined> => (d.least ? d.least(chain).catch(() => undefined) : Promise.resolve(null));
  const start = async (chain: PoolChain, short: bigint): Promise<string | null> => {
    await prune();
    const mine = ways.filter((w) => w.chain === chain);
    const coming = mine.reduce((a, w) => a + w.lamports, 0n);
    const joined = mine.length > 0 ? mine[mine.length - 1]!.op : null;
    if (coming >= short) return joined;
    const p = d.price(chain);
    if (p === null || d.handoff === null || d.rails.length === 0) return joined;
    const fee = await d.fee();
    // the shortfall planned over every Cash note (cards cash-buys-spend-every-note, cash-buys-spend-every-note-evm), one
    // withdrawal a note, each part its own quote held to the pool's quote floor and 1Click's least, read now; with no
    // least read (card cash-least-read-again), no move
    const [notes, floor, leastIn] = await Promise.all([
      d.notes ? d.notes() : d.cash().then((value): CashNote[] => [{ id: "", value }]),
      d.floor ? d.floor(chain).catch(() => null) : Promise.resolve(null),
      leastNow(chain),
    ]);
    if (leastIn === undefined) return joined;
    // Solana: what one tap still lacks, the ladder's least rung over each part; Base and Robinhood (card
    // evm-cash-move-brings-its-fee): `short`'s rungs as the tap's own plan sized them on the rungs these parts land
    // (pool-buy-evm.ts evmMoveShort over evmCashPlan's rungs), each note with one deposit's gas (evmMoveOf), so the
    // follow lands every one of them; with no floor read no move
    const parts = chain === "solana" ? planCashMove(notes, fee, short - coming, solanaMoveModel(p, floor, leastIn)) : typeof floor === "bigint" ? evmCashPlan(notes, fee, p, floor, leastIn, chain).parts(short) : null;
    if (parts === null) return joined;
    const sent = await sendParts(chain, parts, `cash/${chain}/${d.now()}`, fee);
    return "error" in sent ? joined : sent.op;
  };
  // the one plan every exact move and its dry share (card move-from-cash-spends-every-note): a price, a hand-off, a
  // rail, then `usdc` over every Cash note at the fee, the pool's floor and 1Click's least, all read now; a floor
  // given but not read now is down (none given: no floor but each part's own quote), and so is a least given but not
  // read now (card cash-least-read-again)
  const planned = async (chain: PoolChain, usdc: bigint): Promise<Refusal | CashExact> => {
    const p = d.price(chain);
    if (p === null || usdc <= 0n || d.handoff === null || d.rails.length === 0) return { error: "not_allowed" };
    const [fee, notes, floor, leastIn] = await Promise.all([
      d.fee(),
      d.notes ? d.notes() : d.cash().then((value): CashNote[] => [{ id: "", value }]),
      d.floor ? d.floor(chain).catch(() => null) : Promise.resolve(0n),
      leastNow(chain),
    ]);
    if (typeof floor !== "bigint" || leastIn === undefined) return { error: "down" };
    return planCashExact(notes, fee, usdc, (u) => cashLamportsFor(u, p, chain), floor, leastIn) ?? { error: "not_allowed" };
  };
  // one at a time: a second need (the tap after the typing), or a move, reads the first's move as on its way
  const queued = <T>(f: () => Promise<T>, failed: T): Promise<T> => {
    const r = turn.then(f);
    turn = r.catch(() => {});
    return r.catch(() => failed);
  };
  return {
    need: (chain, short) => queued(() => start(chain, short), null),
    move: (chain, usdc, id) =>
      queued(async () => {
        const r = await planned(chain, usdc);
        if ("error" in r) return r;
        if (r.parts === null) return { error: usdc > r.max ? "not_funded" : r.min !== undefined ? "below_min" : "not_allowed" };
        const sent = await sendParts(chain, r.parts, id, r.fee);
        return "error" in sent ? { error: sent.error } : { op: sent.op, minOut: sent.minOut };
      }, { error: "failed" }),
    plan: (chain, usdc) => planned(chain, usdc).catch((): Refusal => ({ error: "failed" })),
    bounds: async (chain) => {
      if (d.price(chain) === null || d.handoff === null || d.rails.length === 0) return { error: "not_allowed" };
      const [fee, floor] = await Promise.all([d.fee(), d.floor ? d.floor(chain).catch(() => null) : Promise.resolve(null)]);
      return { fee, floor: typeof floor === "bigint" ? floor : null };
    },
    least: (chain, usdc) => {
      const p = d.price(chain);
      return p === null ? 0n : cashLamportsFor(usdc, p, chain);
    },
    ways: () => ways.length,
    // the least of the pool's coin the moves on their way still bring (display only: a tap's most counts it)
    coming: (chain) => ways.filter((w) => w.chain === chain && w.reached === null).reduce((a, w) => a + w.lamports, 0n),
    landing: async (op) => {
      const all = await Promise.all(moves.get(op) ?? []);
      if (all.length === 0) return { landed: false, error: "no part of this move is on its way" };
      const stop = all.find((r): r is { landed: false; error: string } => !r.landed);
      return all.some((r) => r.landed) ? { landed: true } : { landed: false, error: stop!.error };
    },
    resume: (recs) => {
      // Cash's own moves only: a move out of a pool is src/pool-to-cash.ts's, its `<op>/1click` a vault deposit's op.
      // One still before the pool counts as on its way again (card cash-buy-waits-for-its-move: after a reload its money
      // is never moved twice), what its quote brings at least (`out`)
      for (const { id, rec } of recs) {
        if (rec.kind !== "move" || rec.from !== "near" || rec.stage === "done" || rec.stage === "failed") continue;
        const followId = `${id}/${d.rails[0] ?? "1click"}`;
        const out = isPoolChain(rec.to) && typeof rec.out === "string" ? unitsOf(rec.out, POOL_DECIMALS[rec.to]) : null;
        if (isPoolChain(rec.to) && out !== null && (rec.stage === "leaving" || rec.stage === "in_transit") && !ways.some((w) => w.op === id)) way(rec.to, followId, id, out, id);
        tracks.push(followOn(id, followId, rec).catch(() => {}));
      }
    },
    idle: async () => {
      await turn;
      await Promise.all(tracks);
    },
  };
}

/** The steps of a move from Cash to pool X (kit messages.ts MoveStep; lite paper v2 §3-4): out of the vault, NEAR
 *  Intents to X, into X's pool. */
const CASH_TO_POOL_STEPS = (x: PoolChain): PoolMoveDry["steps"] => [{ step: "vault_out", chain: "near" }, { step: "intents", chain: x }, { step: "pool_in", chain: x }];
/** Pool X to Cash: out of X's pool, NEAR Intents to NEAR, into the vault. */
const POOL_TO_CASH_STEPS = (x: PoolChain): PoolMoveDry["steps"] => [{ step: "pool_out", chain: x }, { step: "intents", chain: "near" }, { step: "vault_in", chain: "near" }];
/** Pool X to pool Y in one confidential swap (card move-one-confidential-swap): out of X's pool, NEAR Intents to Y, into Y's pool. */
const POOL_TO_POOL_STEPS = (x: PoolChain, y: PoolChain): PoolMoveDry["steps"] => [{ step: "pool_out", chain: x }, { step: "intents", chain: y }, { step: "pool_in", chain: y }];
const isTrade = (c: unknown): c is TradeChain => (TRADE_CHAINS as readonly unknown[]).includes(c);

/** The pair and the amount of a pool.move or pool.move.dry the page runs, or its refusal: Cash (near) to a pool, the
 *  amount in USDC; a pool to Cash or to another pool (src/pool-to-cash.ts), the amount in the pool's coin; each above 0
 *  at no more than its asset's decimals. */
function moveAsk(params: Record<string, unknown>): Refusal | { from: "near"; to: PoolChain; usdc: bigint } | { from: PoolChain; to: PoolChain | "near"; units: bigint } {
  const { from, to, amount } = params;
  if (!isTrade(from) || !isTrade(to) || from === to || typeof amount !== "string") return { error: "not_allowed" };
  const d = from === "near" ? USDC_DECIMALS : POOL_DECIMALS[from];
  const m = new RegExp(`^(0|[1-9]\\d{0,29})(?:\\.(\\d{1,${d}}))?$`).exec(amount);
  if (m === null) return { error: "not_allowed" };
  const x = BigInt(m[1]!) * 10n ** BigInt(d) + BigInt((m[2] ?? "").padEnd(d, "0"));
  if (x <= 0n) return { error: "not_allowed" };
  return from === "near" ? { from, to: to as PoolChain, usdc: x } : { from: from as PoolChain, to: to as PoolChain | "near", units: x };
}

/** The least `x` in 1..2^128 for which `ok` holds (`ok` true from some x on, as every amount a move brings rises with what
 *  it takes); null when even 2^128 is not enough. */
export function leastWhere(ok: (x: bigint) => boolean): bigint | null {
  let hi = 1n;
  while (!ok(hi)) {
    if (hi >= 1n << 128n) return null;
    hi *= 2n;
  }
  let lo = 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Not a HostAnswer, whose `then` would make an async function's answer a thenable. */
type DryAnswer = { result: PoolMoveDry } | { error: ErrorCode };

/** pool.move.dry's answer (card move-sends-what-it-shows, kit 1.16): what the move of `ask` gives, with `max`, what the
 *  move can send now; or, for an amount it cannot send, `max` and the nearest amounts it can (`below`, `above`: the
 *  amounts its plan sends exactly) or the least that clears every floor on the way (`min`: one withdrawal's least part,
 *  and the destination pool's deposit floor at the end of the route, as pool.address holds its quote to), each in whole
 *  units of `from`'s asset. Nothing moves for an answer with no `out`, so no move ends with its money parked between
 *  two legs. A floor that cannot be read now is down. */
async function moveDry(mover: CashMover, toCash: PoolToCash | null, ask: { from: "near"; to: PoolChain; usdc: bigint } | { from: PoolChain; to: PoolChain | "near"; units: bigint }): Promise<DryAnswer> {
  const fromD = ask.from === "near" ? USDC_DECIMALS : POOL_DECIMALS[ask.from];
  const text = (x: bigint) => unitsText(x, fromD);
  const limits = (steps: PoolMoveDry["steps"], max: bigint, o: { min?: bigint; below?: bigint; above?: bigint }): DryAnswer => ({
    result: { max: text(max), steps, ...(o.min === undefined ? {} : { min: text(o.min) }), ...(o.below === undefined ? {} : { below: text(o.below) }), ...(o.above === undefined ? {} : { above: text(o.above) }) },
  });
  if (ask.from === "near") {
    const to = ask.to;
    const steps = CASH_TO_POOL_STEPS(to);
    // the plan the move sends (card move-from-cash-spends-every-note): over every Cash note, its out each part's least
    // and its Fee a relay fee a part
    const r = await mover.plan(to, ask.usdc);
    if ("error" in r) return r;
    if (r.parts === null) return limits(steps, r.max, r);
    const out = r.parts.reduce((t, x) => t + x.least, 0n);
    const fee = r.fee * BigInt(r.parts.length);
    return { result: { out: unitsText(out, POOL_DECIMALS[to]), fee: unitsText(fee, USDC_DECIMALS), steps, max: text(r.max) } };
  }
  const from = ask.from;
  const to = ask.to;
  if (toCash === null) return { error: "not_allowed" };
  if (to !== "near" && toCash.direct()) {
    // one confidential swap, no vault stop: the run's sum, the least of `to`'s coin, held to `to`'s pool floor
    const steps = POOL_TO_POOL_STEPS(from, to);
    const r = await toCash.dry(from, ask.units, to);
    if ("error" in r) return r;
    if ("limits" in r) return limits(steps, r.limits.max, r.limits);
    return { result: { out: unitsText(r.out, POOL_DECIMALS[to]), fee: unitsText(r.fee, POOL_DECIMALS[from]), steps, max: text(r.max) } };
  }
  const steps = to === "near" ? POOL_TO_CASH_STEPS(from) : [...POOL_TO_CASH_STEPS(from), ...CASH_TO_POOL_STEPS(to)];
  const r = await toCash.dry(from, ask.units);
  if ("error" in r) return r;
  if ("limits" in r) return limits(steps, r.limits.max, r.limits);
  const fee = unitsText(r.fee, POOL_DECIMALS[from]);
  if (to === "near") return { result: { out: unitsText(r.out, USDC_DECIMALS), fee, steps, max: text(r.max) } };
  // on to pool `to`: what Cash's move of the deposit's least USDC, less the vault withdraw's fee, brings there; Cash
  // itself is not read, the USDC comes from this move
  const b = await mover.bounds(to);
  if ("error" in b) return b;
  if (b.floor === null) return { error: "down" };
  const floor = b.floor;
  const onward = (x: bigint): bigint => {
    const usdc = toCash.usdcOf(from, x);
    return usdc > b.fee ? mover.least(to, usdc - b.fee) : 0n;
  };
  if (onward(r.sum) < floor) return limits(steps, r.max, { min: (await toCash.least(from, (x) => onward(x) >= floor)) ?? undefined });
  return { result: { out: unitsText(onward(r.sum), POOL_DECIMALS[to]), fee, steps, max: text(r.max) } };
}

/** pool.move and pool.move.dry (card one-balance-buys-on-every-chain): each checked here, then the mover's one move
 *  path. pool.move is answered once the move has left (leaving), its later stages in its op; its dry is refused as it
 *  is, so a dry never promises a move the page cannot run. Every move is held to its dry first (card
 *  move-sends-what-it-shows): an amount the dry answers no `out` for is refused, before anything moves. */
export function poolMoveKinds(mover: () => CashMover, toCash?: () => PoolToCash): {
  "pool.move": (params: Record<string, unknown>, ctx: KindContext) => HostRefusal | Running<"pool.move">;
  "pool.move.dry": (params: Record<string, unknown>, ctx: KindContext) => HostRefusal | Running<"pool.move.dry">;
} {
  return {
    "pool.move": (params, ctx) => {
      const ask = moveAsk(params);
      if ("error" in ask) return ask;
      if (ask.from !== "near" && toCash === undefined) return { error: "not_allowed" };
      let answer: HostAnswer<"pool.move"> | HostRefusal = { error: "failed" };
      // every move held to its dry first, so none starts that the dry would not price: under a floor below_min, over
      // what it can send not_funded, an amount its plan cannot send not_allowed
      const run = async (): Promise<MoveSent | Refusal | { op: string }> => {
        const dry = await moveDry(mover(), toCash === undefined ? null : toCash(), ask);
        if ("error" in dry) return dry;
        if (!("out" in dry.result)) return { error: dry.result.min !== undefined ? "below_min" : dry.result.below !== undefined || dry.result.above !== undefined ? "not_allowed" : "not_funded" };
        if (ask.from === "near") return mover().move(ask.to, ask.usdc, ctx.id);
        return toCash!().move(ask.from, ask.units, ctx.id, ask.to);
      };
      const after = run().then((r) => void (answer = "error" in r ? { error: r.error } : { result: { stage: "leaving", txs: [] } }), () => void (answer = { error: "failed" }));
      return { running: true, after, answer: () => answer };
    },
    "pool.move.dry": (params) => {
      const ask = moveAsk(params);
      if ("error" in ask) return ask;
      if (ask.from !== "near" && toCash === undefined) return { error: "not_allowed" };
      let answer: HostAnswer<"pool.move.dry"> | HostRefusal = { error: "failed" };
      const after = moveDry(mover(), toCash === undefined ? null : toCash(), ask).then((a) => void (answer = a), () => void (answer = { error: "failed" }));
      return { running: true, after, answer: () => answer };
    },
  };
}

export type CashToPoolDeps = {
  /** Cash holds money that can move or a move is on its way to `chain`: read on the device alone. With neither, a tap
   *  goes straight to the pool buy, with no read of the coin's venue. */
  any(chain: PoolChain): Promise<boolean>;
  /** Base units one pool.buy of `token` on `chain` spends now (Solana: pool.buy.dry's tap_max on the coin's venue,
   *  solanaTapMaxOf; Base and Robinhood: the largest ready note, state.pools' tap_max); 0n when none. Throws when the
   *  coin's venue is not read: the tap then moves nothing from Cash. */
  tapMax(chain: PoolChain, token: string): Promise<bigint>;
  /** The least shortfall a move must bring so one tap pays `amount`, the size pool.buy.dry prices: on Solana (card
   *  you-receive-on-every-chain) src/pools.ts solanaMoveShort, each note the move brings its own W with its own relay
   *  fee, tip and rent, null: `amount` less tapMax; on Base and Robinhood (card evm-cash-move-brings-its-fee)
   *  pool-buy-evm.ts evmMoveShort, the wei of rungs the move lands, each note paying its own relay fee, null: no move. */
  short?(chain: PoolChain, token: string, amount: bigint): Promise<bigint | null>;
  /** cashMover's need: the op id of the move on its way for it, or null. */
  need(chain: PoolChain, short: bigint): Promise<string | null>;
  /** cashMover's landing (card cash-buy-waits-for-its-move): settles once every part of the move `op` reached the pool
   *  or stopped. */
  moved(op: string): Promise<{ landed: boolean; error?: string }>;
  /** Whether money is still on its way into what one tap spends on `chain` (provingOn over the page's notes and its
   *  queues' proofs, read now): a note of the chain's pool landing, one its queue makes a proof for, or one landed that
   *  waits for its queue's next epoch turn (`seen`: the tap's own first sight of each such note, kept between reads). */
  proving(chain: PoolChain, seen: Map<string, number>): Promise<boolean>;
  wait(ms: number): Promise<void>;
  /** The bound on one read of what one tap spends while a move is on its way (CASH_TAP_READ_MS unless given; tests). */
  readMs?: number;
  now(): number;
  signal?: AbortSignal;
};

type Inner = (ask: PoolAsk, ctx: KindContext | null) => HostRefusal | Running<"pool.buy">;
type Answer = HostAnswer<"pool.buy"> | HostRefusal;

/** How long past its chain's epoch a landed note with no proof still holds a tap's wait (card cash-buy-waits-for-its-move):
 *  the EVM turn pass reads a period's fee EVM_TURN_PASS_MS (3 s) past its turn plus up to EVM_TURN_SPREAD_MS (2 s), then
 *  the queue's pass starts the proof (its note HELD, `making`, from then on); twice that, for the pass's own reads. */
export const PROOF_TURN_MARGIN_MS = 10_000;
/** Each pool chain's queue schedule and the rule it proves a note by: its epoch (a landed note is proved at once on the
 *  newest root, or at the latest at the next epoch's pass: wallet/src/pool/queue.ts:15-18, 543-546) and its piece rule
 *  (queue.ts:501 usable: a note whose pieceChunk is null is never proved). */
const PROOF_RULES: Readonly<Record<PoolChain, { epochMs: number; pieces: PieceRule }>> = {
  solana: { epochMs: Number(SOL_EPOCH_MS), pieces: SOL_PIECES },
  base: { epochMs: Number(EVM_EPOCH_MS), pieces: EVM_PIECES },
  robinhood: { epochMs: Number(EVM_EPOCH_MS), pieces: EVM_PIECES },
};
/** A landed note's wait for its queue (provingOn's `turn`): the chain, whether its queue is open now, the tap's first
 *  sight of each such note (written here), and the time now. */
export type ProofTurn = { chain: PoolChain; open: boolean; seen: Map<string, number>; now: number };
/**
 * Money on its way into what one tap spends on a chain (CashToPoolDeps.proving, card cash-buy-waits-for-its-move): of
 * the chain's pools' scopes, a note landing (INCOMING), one the queue makes a proof for now (`making`), or one HELD with
 * no ready proof (a proof begun). And, with `turn`, a landed note (UNSPENT) with no ready proof while the chain's queue
 * is open, from the tap's first sight of it until the chain's next epoch turn and PROOF_TURN_MARGIN_MS: the queue proves
 * it then at the latest (an EVM note waits for the period's turn, UNSPENT, outside `making` and not HELD:
 * wallet/src/pool/queue.ts:623 marks a note in flight only when its proof starts, :715 `making` is those, :589 a leaf
 * past the newest trees "waits for the next pass"). Past that bound, or with the queue closed, or a note the queue never
 * proves (its piece rule gives it no chunk: below the floor, queue.ts:501), or another pool's, it is not: the money is
 * the pool's, counted once proved.
 */
export function provingOn(notes: readonly { id: string; scope: bigint; state: string; leaf?: { value: bigint } }[], scopes: ReadonlySet<bigint>, ready: readonly { noteId: string }[], making?: ReadonlySet<string>, turn?: ProofTurn): boolean {
  const proved = new Set(ready.map((r) => r.noteId));
  let on = false;
  for (const n of notes) {
    if (!scopes.has(n.scope) || proved.has(n.id)) continue;
    if (n.state === "INCOMING" || making?.has(n.id) === true || n.state === "HELD") on = true;
    else if (turn !== undefined && turn.open && n.state === "UNSPENT" && n.leaf !== undefined && pieceChunk(PROOF_RULES[turn.chain].pieces, n.leaf.value) !== null) {
      // every such note's first sight is written on this read, not only the first one's
      if (!turn.seen.has(n.id)) turn.seen.set(n.id, turn.now);
      if (turn.now < turn.seen.get(n.id)! + PROOF_RULES[turn.chain].epochMs + PROOF_TURN_MARGIN_MS) on = true;
    }
  }
  return on;
}

/** The tap's deps as cashFirst reads them (card buy-shows-every-step): each tap read that throws says why in a trace
 *  line; the move asked of the mover, or none, said too; and once a move is on its way, each read of what one tap
 *  spends is bounded by CASH_TAP_READ_MS (card cash-buy-waits-for-its-move: the wait has no clock of its own), and one
 *  that throws or never answers counts as nothing yet, so the wait reads again: never a tap that fails with its money
 *  already moved, or holds on one read, with nothing said. `last()`: the last read. */
function steadyTap(d: CashToPoolDeps, t: (step: TraceStep, f?: TraceFields) => void): CashToPoolDeps & { last(): bigint } {
  let moving = false;
  let move: string | null = null;
  let last = 0n;
  const said = (e: unknown): TraceFields => ({ ...(move === null ? {} : { move }), stage: "tap_unread", error: errorText(e) });
  return {
    ...d,
    tapMax: async (chain, token) => {
      if (!moving) {
        last = await d.tapMax(chain, token).catch((e: unknown) => {
          t("move", said(e));
          throw e;
        });
        return last;
      }
      let s: ReturnType<typeof setTimeout> | undefined;
      const ms = d.readMs ?? CASH_TAP_READ_MS;
      const late = new Promise<null>((r) => (s = setTimeout(() => r(null), ms)));
      const got = await Promise.race([d.tapMax(chain, token).catch((e: unknown) => (t("move", said(e)), 0n)), late]).finally(() => clearTimeout(s));
      if (got === null) t("move", said(`the read of what one tap spends did not answer in ${ms} ms`));
      last = got ?? 0n;
      return last;
    },
    need: async (chain, short) => {
      const op = await d.need(chain, short);
      t("move", op === null ? { stage: "none", amount: short.toString(), error: "no move from Cash started or on its way for the shortfall" } : { move: op, amount: short.toString() });
      if (op !== null) {
        move = op;
        moving = true;
      }
      return op;
    },
    last: () => last,
  };
}

/** `p`, or null at the sign out. */
const unlessOut = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T | null> =>
  signal === undefined ? p : signal.aborted ? Promise.resolve(null) : Promise.race([p, new Promise<null>((r) => signal.addEventListener("abort", () => r(null), { once: true }))]);

/** The pool.buy kind that waits for Cash on its way: `inner` (the pool buy) once one tap spends the ask, or at once when
 *  nothing is on its way. No async function here returns an answer: a HostAnswer's `then` would make it a thenable. */
export function cashFirst(inner: Inner, deps: () => CashToPoolDeps): Inner {
  return (ask, ctx) => {
    if (ask.kind !== "pool.buy" || !isPoolChain(ask.chain) || ask.token === null) return inner(ask, ctx);
    const token = ask.token;
    const chain = ask.chain;
    // with no size from the page: on Solana the gap to one tap's spend; on Base and Robinhood nothing, since a move of the
    // bare gap or of the asked rung brings notes that each pay their own relay fee, short of the ask (card
    // evm-cash-move-brings-its-fee), and the tap answers its own refusal at once
    const want = (now: bigint): bigint | null => (chain === "solana" ? ask.amount - now : null);
    let answer: Answer = { error: "failed" };
    // the buy's trace lines (card buy-shows-every-step), under the request's id: the move it waits on, the wait's end,
    // the pool buy's answer and the end
    const t = (step: TraceStep, f: TraceFields = {}): void => void (ctx ? trace(ctx.id, null, step, f) : undefined);
    if (ctx) traceBegin(ctx.id);
    const after = (async () => {
      const d = steadyTap(deps(), t);
      // a tap read that throws (Solana: the coin's venue not read, solanaTapMaxOf) moves nothing from Cash: the pool buy
      // reads the venue itself and answers its refusal at once
      const now = (await d.any(chain)) ? await d.tapMax(chain, token).catch(() => null) : ask.amount;
      // sized as pool.buy.dry prices it, so the notes the move brings pay the rest with their own costs: on Solana each
      // W's relay fee, tip and rent (solanaMoveShort), on Base and Robinhood each note's relay fee (evmMoveShort)
      const sized = now !== null && now < ask.amount && d.short ? await d.short(chain, token, ask.amount).catch(() => null) : null;
      const short = now !== null && now < ask.amount ? (sized ?? want(now)) : null;
      const op = short === null ? null : await d.need(chain, short);
      if (op !== null) {
        try {
          ctx?.route?.({ move: "cash", op });
        } catch {
          /* the app's display never stops a buy */
        }
        // the wait follows the move, never a clock from the tap (card cash-buy-waits-for-its-move): first its landing,
        // every part in the pool or stopped (the mover's own follow of each part: its withdraw, 1Click's delivery, the
        // follow's deposits, its quote's deadline); then, while one tap still spends less than the ask, the chain's
        // landing notes and their proofs, until none is on its way (two reads in a row, CASH_MOVE_POLL_MS apart, so a
        // note between its landing and its proof's start is not missed)
        const moved = await unlessOut(d.moved(op).catch((e: unknown) => ({ landed: false, error: errorText(e) })), d.signal);
        if (moved !== null) t("move", { move: op, stage: moved.landed ? "landed" : "stopped", ...(moved.error === undefined ? {} : { error: moved.error }) });
        let still = 0;
        const seen = new Map<string, number>();
        while (moved?.landed === true && !d.signal?.aborted && (await d.tapMax(chain, token)) < ask.amount) {
          still = (await d.proving(chain, seen).catch(() => false)) ? 0 : still + 1;
          if (still >= 2) break;
          await d.wait(CASH_MOVE_POLL_MS);
        }
        // what one tap spends when the wait ended, against the ask: "ready"; the move stopped; its money in the pool and
        // nothing more on its way into one tap; or the sign out
        const have = d.last();
        const stage = have >= ask.amount ? "ready" : d.signal?.aborted || moved === null ? "signed_out" : moved.landed ? "settled" : "stopped";
        const why = stage === "settled" ? `one tap spends ${have} of the ${ask.amount} asked, with nothing more landing or proving` : stage === "stopped" ? (moved?.error ?? "the move stopped") : stage === "signed_out" ? "signed out" : undefined;
        t("move", { move: op, stage, amount: have.toString(), ...(why === undefined ? {} : { error: why }) });
      }
      // the pool buy's stages as trace lines too (sent, filled, not_landed: its answer comes at its first send), each to the
      // api with its transactions (card evm-buy-end-carries-its-tx: a Base or Robinhood buy's late end names its tx)
      const seen: KindContext | null = ctx === null ? null : { ...ctx, progress: (s, txs) => (t("swap", { stage: s }), ctx.progress(s, txs)) };
      const r = inner(ask, seen);
      if (!("after" in r)) {
        answer = r;
        t("swap", { error: r.error });
        return void t("end", { stage: "refused", error: r.error });
      }
      await r.after;
      answer = r.answer() ?? { error: "failed" };
      const a = answer as Partial<{ result: { stage: string; txs?: readonly { hash: string }[] }; error: string }>;
      const tx = a.result?.txs?.[0]?.hash;
      t("swap", a.result ? { stage: a.result.stage, ...(tx ? { tx } : {}) } : { error: a.error ?? "no answer" });
      t("end", a.result ? { stage: a.result.stage, ...(tx ? { tx } : {}) } : { stage: "refused", error: a.error ?? "no answer" });
    })().catch((e: unknown) => {
      answer = { error: "failed" };
      t("end", { stage: "failed", error: errorText(e) });
    });
    return { running: true, after, answer: () => answer };
  };
}
