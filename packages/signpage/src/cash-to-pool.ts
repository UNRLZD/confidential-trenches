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
// buys the whole ask once one tap spends it. The app is told the tap waits on the move (route { move: "cash", op }, op
// the move op's id in state.ops), so its flow shows the move as its own step. With nothing on its way: the pool buy's
// own answer.
//
// pool.move (poolMoveKinds): the same mover's `move`, an exact amount of Cash into the Solana pool with every check
// above, its move op written under the request's id: leaving once the quote is checked, in_transit once the vault's
// withdraw landed, then the quote's follow op's stage (moveStageOfFollow). Every other pair is refused not_allowed for
// now, its dry too. A buy's shortfall writes the same op under its own id (cash/<chain>/<ms>).
// Nothing here logs.
import { TRADE_CHAINS, type ErrorCode, type MoveStage, type PoolChain, type PoolMoveDry, type PoolStatePrice, type TradeChain, type TxRef } from "../../kit/src/signpage/messages.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { EVM_LADDER } from "../../wallet/src/pool/evm.ts";
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

/** Each pool's coin: its decimals and the least rung its deposit ladder splits into (what a 1-2-5 split may leave at
 *  U_X under it): SOL on Solana, ETH on Base and Robinhood. */
const POOL_DECIMALS: Readonly<Record<PoolChain, number>> = { solana: 9, base: 18, robinhood: 18 };
const RUNG: Readonly<Record<PoolChain, bigint>> = { solana: SOL_LADDER.min, base: EVM_LADDER.min, robinhood: EVM_LADDER.min };

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
 *  units of each side's asset. Nothing secret: no key, note, address of the user's or which note is whose. */
export type MoveOpRecord = { kind: "move"; from: TradeChain; to: TradeChain; stage: MoveStage; txs: TxRef[]; amount: string; out?: string; created_ms: number };
/** What a move's follow op (the quote's pool_deposit op, pool-deposit-follow.ts PoolDepositOp) says, read from the store. */
export type MoveFollow = { stage: string; final?: true; txs?: readonly TxRef[] };

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
  /** Writes the move op under its id (the store's "ops"); none: no op is written. */
  put?(id: string, rec: MoveOpRecord): Promise<void>;
  /** The quote's follow op under `id`, read from the store; none: the move op stops at in_transit. */
  follow?(id: string): Promise<MoveFollow | undefined>;
  /** The wait between two reads of the follow op (setTimeout otherwise). */
  wait?(ms: number): Promise<void>;
  /** The sign out: a move op's follow reads stop. */
  signal?: AbortSignal;
};

type Way = { chain: PoolChain; id: string; op: string; lamports: bigint; going: Promise<boolean>; since: number };

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

/** A move out of Cash: refused, or on its way under its op id with the least it delivers. */
export type MoveSent = Refusal | { op: string; minOut: bigint };
export type CashMover = {
  /** Starts or joins a move for a buy's shortfall on `chain`: the op id of a move on its way for it, else null. */
  need(chain: PoolChain, short: bigint): Promise<string | null>;
  /** Moves exactly `usdc` of Cash into `chain`'s pool under the op id `id` (pool.move): every check `need`'s move has,
   *  the quote's least at least what `usdc` buys at the device's price less CASH_MARGIN_BPS and the least rung. */
  move(chain: PoolChain, usdc: bigint, id: string): Promise<MoveSent>;
  /** What a move of `usdc` would give: the least it takes from a quote (cashLamportsFor) and the withdraw fee. */
  dry(chain: PoolChain, usdc: bigint): Promise<Refusal | { out: bigint; fee: bigint }>;
  ways(): number;
  coming(chain: PoolChain): bigint;
  /** Settles once every move op this mover follows has stopped (tests). */
  idle(): Promise<void>;
};

/** The mover: one code path for every move out of Cash, a buy's shortfall (`need`) and pool.move (`move`). */
export function cashMover(d: CashMoverDeps): CashMover {
  let ways: Way[] = [];
  let turn: Promise<unknown> = Promise.resolve();
  const tracks: Promise<void>[] = [];
  const put = async (id: string, rec: MoveOpRecord): Promise<void> => {
    try {
      await d.put?.(id, rec);
    } catch {
      /* a write that fails costs the display, never the move */
    }
  };
  // the move op's stages after the hand-off: in_transit once the vault's withdraw landed, then the follow op's
  const track = async (op: string, followId: string, rec: MoveOpRecord, ended: Promise<HandoffEnd | null>): Promise<void> => {
    const e = await ended;
    const txs: TxRef[] = e !== null && "tx" in e && typeof e.tx === "string" ? [{ chain: "near", hash: e.tx }] : [];
    if (e === null || !(e.kind === "arrived" || e.kind === "landed")) return put(op, { ...rec, stage: "failed", txs });
    let cur: MoveOpRecord = { ...rec, stage: "in_transit", txs };
    await put(op, cur);
    if (!d.follow) return;
    const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (!d.signal?.aborted) {
      const f = await d.follow(followId).catch(() => undefined);
      if (f !== undefined) {
        const stage = moveStageOfFollow(f);
        const add = (f.txs ?? []).filter((t, k, all) => typeof t?.hash === "string" && !cur.txs.some((x) => x.hash === t.hash) && all.findIndex((y) => y.hash === t.hash) === k).map((t) => ({ chain: t.chain, hash: t.hash }));
        if (stage !== cur.stage || add.length > 0) {
          cur = { ...cur, stage, txs: [...cur.txs, ...add] };
          await put(op, cur);
        }
        if (stage === "done" || stage === "failed") return;
      }
      await wait(CASH_MOVE_POLL_MS);
    }
  };
  // one move: the rail's quote of exactly `usdc`, held to every check, then the vault pays its deposit address
  const send = async (chain: PoolChain, usdc: bigint, least: bigint, op: string, fee: bigint, amount: string): Promise<MoveSent & { going?: Promise<boolean>; used?: string }> => {
    let q: CashQuote | Refusal = { error: "not_allowed" };
    let used = `${op}/${d.rails[0]}`;
    for (const rail of d.rails) {
      used = `${op}/${rail}`;
      q = await d.quote(chain, usdc, used, rail);
      if (!("error" in q)) break;
    }
    const rec: MoveOpRecord = { kind: "move", from: "near", to: chain, stage: "leaving", txs: [], amount, created_ms: d.now() };
    if ("error" in q || !IMPLICIT.test(q.address) || q.amountIn !== usdc || q.minOut < least) {
      await put(op, { ...rec, stage: "failed" });
      return { error: "error" in q ? q.error : "quote_check_failed" };
    }
    const leaving: MoveOpRecord = { ...rec, out: unitsText(q.minOut, POOL_DECIMALS[chain]) };
    await put(op, leaving);
    const ended = d.handoff!({ recipient: q.address, amount: usdc }, fee).catch(() => null);
    const going = ended.then((e) => e !== null && (e.kind === "arrived" || e.kind === "landed"));
    tracks.push(track(op, used, leaving, ended).catch(() => {}));
    ways.push({ chain, id: used, op, lamports: q.minOut, going, since: d.now() });
    return { op, minOut: q.minOut };
  };
  const prune = async (): Promise<void> => {
    // what is on its way already: a move that failed, landed, or outlived CASH_MOVE_WAIT_MS no longer counts
    const kept: Way[] = [];
    for (const w of ways) {
      const settled = await Promise.race([w.going, Promise.resolve(null)]);
      if (settled === false || d.now() - w.since > CASH_MOVE_WAIT_MS || (settled === true && (await d.landed(w.id)))) continue;
      kept.push(w);
    }
    ways = kept;
  };
  const start = async (chain: PoolChain, short: bigint): Promise<string | null> => {
    await prune();
    const mine = ways.filter((w) => w.chain === chain);
    const coming = mine.reduce((a, w) => a + w.lamports, 0n);
    const joined = mine.length > 0 ? mine[mine.length - 1]!.op : null;
    if (coming >= short) return joined;
    const left = short - coming;
    const p = d.price(chain);
    const usdc = p === null ? null : cashUsdcFor(left, p, chain);
    if (usdc === null || d.handoff === null || d.rails.length === 0) return joined;
    const fee = await d.fee();
    if (usdc + fee > (await d.cash())) return joined;
    const sent = await send(chain, usdc, left, `cash/${chain}/${d.now()}`, fee, unitsText(usdc, USDC_DECIMALS));
    return "error" in sent ? joined : sent.op;
  };
  // the checks every exact move shares, its own and its dry's: a price, a hand-off, a rail, Cash for it and its fee
  const ready = async (chain: PoolChain, usdc: bigint): Promise<Refusal | { least: bigint; fee: bigint }> => {
    const p = d.price(chain);
    const least = p === null ? 0n : cashLamportsFor(usdc, p, chain);
    if (usdc <= 0n || least <= 0n || d.handoff === null || d.rails.length === 0) return { error: "not_allowed" };
    const fee = await d.fee();
    if (usdc + fee > (await d.cash())) return { error: "not_funded" };
    return { least, fee };
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
        const r = await ready(chain, usdc);
        if ("error" in r) return r;
        const sent = await send(chain, usdc, r.least, id, r.fee, unitsText(usdc, USDC_DECIMALS));
        return "error" in sent ? { error: sent.error } : { op: sent.op, minOut: sent.minOut };
      }, { error: "failed" }),
    dry: async (chain, usdc) => {
      const r = await ready(chain, usdc).catch((): Refusal => ({ error: "failed" }));
      return "error" in r ? r : { out: r.least, fee: r.fee };
    },
    ways: () => ways.length,
    // the least of the pool's coin the moves on their way still bring (display only: a tap's most counts it)
    coming: (chain) => ways.filter((w) => w.chain === chain && d.now() - w.since <= CASH_MOVE_WAIT_MS).reduce((a, w) => a + w.lamports, 0n),
    idle: async () => {
      await turn;
      await Promise.all(tracks);
    },
  };
}

/** The steps of a move from Cash to pool X (kit messages.ts MoveStep; lite paper v2 §3-4): out of the vault, NEAR
 *  Intents to X, into X's pool. */
const CASH_TO_POOL_STEPS = (x: PoolChain): PoolMoveDry["steps"] => [{ step: "vault_out", chain: "near" }, { step: "intents", chain: x }, { step: "pool_in", chain: x }];
const MOVE_AMOUNT = /^(0|[1-9]\d{0,29})(?:\.(\d{1,6}))?$/;
const isTrade = (c: unknown): c is TradeChain => (TRADE_CHAINS as readonly unknown[]).includes(c);

/** The pair and the USDC of a pool.move or pool.move.dry the page runs, or its refusal: Cash (near) to a pool for now
 *  (pool to Cash and pool to pool build next), an amount in USDC above 0 at no more than its 6 decimals. */
function moveAsk(params: Record<string, unknown>): Refusal | { to: PoolChain; usdc: bigint } {
  const { from, to, amount } = params;
  if (!isTrade(from) || !isTrade(to) || from === to || typeof amount !== "string") return { error: "not_allowed" };
  // Cash to any pool (to is a pool chain once from is near); pool to Cash and pool to pool build next
  if (from !== "near" || to === "near") return { error: "not_allowed" };
  const m = MOVE_AMOUNT.exec(amount);
  if (m === null) return { error: "not_allowed" };
  const usdc = BigInt(m[1]!) * 10n ** 6n + BigInt((m[2] ?? "").padEnd(6, "0"));
  return usdc > 0n ? { to, usdc } : { error: "not_allowed" };
}

/** pool.move and pool.move.dry (card one-balance-buys-on-every-chain): each checked here, then the mover's one move
 *  path. pool.move is answered once the move has left (leaving), its later stages in its op; its dry is refused as it
 *  is, so a dry never promises a move the page cannot run. */
export function poolMoveKinds(mover: () => CashMover): {
  "pool.move": (params: Record<string, unknown>, ctx: KindContext) => HostRefusal | Running<"pool.move">;
  "pool.move.dry": (params: Record<string, unknown>, ctx: KindContext) => HostRefusal | Running<"pool.move.dry">;
} {
  return {
    "pool.move": (params, ctx) => {
      const ask = moveAsk(params);
      if ("error" in ask) return ask;
      let answer: HostAnswer<"pool.move"> | HostRefusal = { error: "failed" };
      const after = mover()
        .move(ask.to, ask.usdc, ctx.id)
        .then((r) => void (answer = "error" in r ? { error: r.error } : { result: { stage: "leaving", txs: [] } }), () => void (answer = { error: "failed" }));
      return { running: true, after, answer: () => answer };
    },
    "pool.move.dry": (params) => {
      const ask = moveAsk(params);
      if ("error" in ask) return ask;
      let answer: HostAnswer<"pool.move.dry"> | HostRefusal = { error: "failed" };
      const after = mover()
        .dry(ask.to, ask.usdc)
        .then(
          (r) => void (answer = "error" in r ? { error: r.error } : { result: { out: unitsText(r.out, POOL_DECIMALS[ask.to]), fee: unitsText(r.fee, USDC_DECIMALS), steps: CASH_TO_POOL_STEPS(ask.to) } }),
          () => void (answer = { error: "failed" }),
        );
      return { running: true, after, answer: () => answer };
    },
  };
}

export type CashToPoolDeps = {
  /** Cash holds money that can move or a move is on its way: read on the device alone. With neither, a tap goes straight
   *  to the pool buy, with no read of the coin's venue. */
  any(): Promise<boolean>;
  /** Lamports one pool.buy of `token` spends now (pool.buy.dry's tap_max on the coin's venue); 0n when none. */
  tapMax(token: string): Promise<bigint>;
  /** cashMover's need on Solana: the op id of the move on its way for the shortfall, or null. */
  need(short: bigint): Promise<string | null>;
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
      const now = (await d.any()) ? await d.tapMax(token) : ask.amount;
      const op = now < ask.amount ? await d.need(ask.amount - now) : null;
      if (op !== null) {
        try {
          ctx?.route?.({ move: "cash", op });
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
