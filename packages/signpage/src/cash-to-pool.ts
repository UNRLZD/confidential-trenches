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
import { chunkOf, type Ladder } from "../../wallet/src/pool/ladder.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";
import type { PoolAsk } from "./rules/pool.ts";
import type { CheckedWithdraw } from "./withdraw/form.ts";
import type { HandoffEnd } from "./withdraw/handoff.ts";
import type { PoolToCash } from "./pool-to-cash.ts";

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
const LADDER: Readonly<Record<PoolChain, Ladder>> = { solana: SOL_LADDER, base: EVM_LADDER, robinhood: EVM_LADDER };
const isPoolChain = (c: unknown): c is PoolChain => typeof c === "string" && Object.hasOwn(LADDER, c);
/** Whether `x` is a rung of `chain`'s ladder: an EVM tap spends one whole note, so only a rung can be made for it. */
const isRung = (chain: PoolChain, x: bigint): boolean => x > 0n && x < 1n << 128n && chunkOf(LADDER[chain], x) === x;
/** pool.buy.dry's with_cash on Base and Robinhood (kit 1.15), in whole ETH as tap_max is: an EVM tap spends one whole
 *  note, so the larger of the ready note (tap_max) and the largest rung the largest Cash note less `fee` makes at the
 *  device's price, CASH_MARGIN_BPS and one deposit's `gas` under it; null when tap_max is not an amount. */
export function withCashNote(tapMax: string, cash: bigint, fee: bigint, p: Pick<PoolStatePrice, "price" | "expo"> | null, chain: "base" | "robinhood", gas: bigint): string | null {
  const d = POOL_DECIMALS[chain];
  const m = new RegExp(`^(\\d{1,30})(?:\\.(\\d{1,${d}}))?$`).exec(tapMax);
  if (m === null) return null;
  const tap = BigInt(m[1]!) * 10n ** BigInt(d) + BigInt((m[2] ?? "").padEnd(d, "0"));
  const px = p === null ? null : priceOf(p);
  const gross = px === null || cash <= fee ? 0n : ((cash - fee) * px.d * 10n ** BigInt(d) * 10_000n) / (px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS));
  const note = gross > gas ? (chunkOf(LADDER[chain], gross - gas) ?? 0n) : 0n;
  return unitsText(note > tap ? note : tap, d);
}
/** USDC (6 decimals) that buys `units` of `chain`'s pool coin at the device's price, CASH_MARGIN_BPS over, rounded up. */
function cashUsdcExact(units: bigint, p: Pick<PoolStatePrice, "price" | "expo">, chain: PoolChain): bigint | null {
  const px = priceOf(p);
  if (px === null || units <= 0n) return null;
  const num = units * px.n * 10n ** 6n * (10_000n + CASH_MARGIN_BPS);
  const den = px.d * 10n ** BigInt(POOL_DECIMALS[chain]) * 10_000n;
  return (num + den - 1n) / den;
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
export type MoveOpRecord = { kind: "move"; from: TradeChain; to: TradeChain; stage: MoveStage; txs: TxRef[]; amount: string; out?: string; created_ms: number; cash?: string };
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
  /** The quote's floor on a pool (pool.address's: on an EVM pool its least rung plus one deposit's gas, on Solana the
   *  rung, one deposit's cost and the rent U_X keeps; read now), null with no read: a note made for an EVM tap is quoted
   *  at the rung plus that gas, and a move's dry is held to it (bounds). */
  floor?(chain: PoolChain): Promise<bigint | null>;
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
  /** What a move into `chain` is held to before anything moves (card move-sends-what-it-shows): the vault withdraw's fee,
   *  the most one withdrawal of Cash carries (`cash`), and the least of `chain`'s coin a quote into its pool may bring
   *  (`floor`: the pool's deposit floor, as pool.address checks it; null with no read). Cash is not checked here: a move
   *  out of another pool brings its USDC first. */
  bounds(chain: PoolChain): Promise<Refusal | { fee: bigint; cash: bigint; floor: bigint | null }>;
  /** The least of `chain`'s coin a quote for `usdc` must bring (cashLamportsFor at the device's price); 0n with none. */
  least(chain: PoolChain, usdc: bigint): bigint;
  ways(): number;
  coming(chain: PoolChain): bigint;
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
    const cur: MoveOpRecord = { ...rec, stage: "in_transit", txs };
    await put(op, cur);
    return followOn(op, followId, cur);
  };
  // the follow op's stages from `cur` on, until the move is done or failed (or the sign out)
  const followOn = async (op: string, followId: string, from: MoveOpRecord): Promise<void> => {
    if (!d.follow) return;
    let cur = from;
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
    const p = d.price(chain);
    // Solana: what one tap still lacks, the ladder's least rung over it; Base and Robinhood: the whole note of `short`, a
    // rung (an EVM tap spends one whole note), plus one deposit's gas, so the deposit lands that note
    let left = short - coming;
    let usdc: bigint | null = p === null ? null : cashUsdcFor(left, p, chain);
    if (chain !== "solana") {
      const floor = p === null ? null : await d.floor?.(chain).catch(() => null);
      left = short + (typeof floor === "bigint" && floor > RUNG[chain] ? floor - RUNG[chain] : 0n);
      usdc = p === null || typeof floor !== "bigint" ? null : cashUsdcExact(left, p, chain);
    }
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
    bounds: async (chain) => {
      if (d.price(chain) === null || d.handoff === null || d.rails.length === 0) return { error: "not_allowed" };
      const [fee, cash, floor] = await Promise.all([d.fee(), d.cash(), d.floor ? d.floor(chain).catch(() => null) : Promise.resolve(null)]);
      return { fee, cash, floor: typeof floor === "bigint" ? floor : null };
    },
    least: (chain, usdc) => {
      const p = d.price(chain);
      return p === null ? 0n : cashLamportsFor(usdc, p, chain);
    },
    ways: () => ways.length,
    // the least of the pool's coin the moves on their way still bring (display only: a tap's most counts it)
    coming: (chain) => ways.filter((w) => w.chain === chain && d.now() - w.since <= CASH_MOVE_WAIT_MS).reduce((a, w) => a + w.lamports, 0n),
    resume: (moves) => {
      // Cash's own moves only: a move out of a pool is src/pool-to-cash.ts's, its `<op>/1click` a vault deposit's op
      for (const { id, rec } of moves) if (rec.kind === "move" && rec.from === "near" && rec.stage !== "done" && rec.stage !== "failed") tracks.push(followOn(id, `${id}/${d.rails[0] ?? "1click"}`, rec).catch(() => {}));
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
    const b = await mover.bounds(to);
    if ("error" in b) return b;
    const max = b.cash > b.fee ? b.cash - b.fee : 0n;
    if (ask.usdc > max) return limits(steps, max, {});
    if (b.floor === null) return { error: "down" };
    const floor = b.floor;
    if (mover.least(to, ask.usdc) < floor) return limits(steps, max, { min: leastWhere((u) => mover.least(to, u) >= floor) ?? undefined });
    return { result: { out: unitsText(mover.least(to, ask.usdc), POOL_DECIMALS[to]), fee: unitsText(b.fee, USDC_DECIMALS), steps, max: text(max) } };
  }
  const from = ask.from;
  const to = ask.to;
  if (toCash === null) return { error: "not_allowed" };
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
  /** Base units one pool.buy of `token` on `chain` spends now (Solana: pool.buy.dry's tap_max on the coin's venue; Base
   *  and Robinhood: the largest ready note, state.pools' tap_max); 0n when none. */
  tapMax(chain: PoolChain, token: string): Promise<bigint>;
  /** cashMover's need: the op id of the move on its way for it, or null. */
  need(chain: PoolChain, short: bigint): Promise<string | null>;
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
    if (ask.kind !== "pool.buy" || !isPoolChain(ask.chain) || ask.token === null) return inner(ask, ctx);
    const token = ask.token;
    const chain = ask.chain;
    // Solana: the gap to one tap's spend; Base and Robinhood: the whole asked note, only when it is a rung
    const want = (now: bigint): bigint | null => (chain === "solana" ? ask.amount - now : isRung(chain, ask.amount) ? ask.amount : null);
    let answer: Answer = { error: "failed" };
    const after = (async () => {
      const d = deps();
      const now = (await d.any(chain)) ? await d.tapMax(chain, token) : ask.amount;
      const short = now < ask.amount ? want(now) : null;
      const op = short === null ? null : await d.need(chain, short);
      if (op !== null) {
        try {
          ctx?.route?.({ move: "cash", op });
        } catch {
          /* the app's display never stops a buy */
        }
        const until = d.now() + CASH_MOVE_WAIT_MS;
        while (!d.signal?.aborted && d.now() < until && (await d.tapMax(chain, token)) < ask.amount) await d.wait(CASH_MOVE_POLL_MS);
      }
      const r = inner(ask, ctx);
      if (!("after" in r)) return void (answer = r);
      await r.after;
      answer = r.answer() ?? { error: "failed" };
    })().catch(() => void (answer = { error: "failed" }));
    return { running: true, after, answer: () => answer };
  };
}
