// The buy route strip's state machine (card app-buy-route-strip; spec in the research repo docs/drafts/
// buy-route-strip-spec.md, on the locked design's P.pvTrade path, design-lock-r5 assets/private.js:78): four steps for a
// buy, Private balance, the buy's one-time wallet, the pool, the token. Pure functions; the strip draws what they say.
//
// The events are the pool buy's own:
// - the tap (the Buy release): the wallet step grows in, Private balance is the step waiting;
// - `taken`: the amount left the private balance. The signing page awaits the pool's take (the note HELD -> RESERVED)
//   before the transaction leaves the device (packages/signpage/src/pool-buy.ts, "The take"), so the kit's `sent` answer
//   proves it: the app has no earlier event for it;
// - `sent`: the buy's one-time wallet signed and the transaction went out (the kit's `sent`, with its tx);
// - `filled`: the transaction read back on chain as the buy (the kit's `filled`); the pool and the token check on it.
// - `out` (card pool-buy-filled-2s): a pool buy's amount W received, which the page tells only once both RPCs read this
//   very transaction at confirmed with no error, the same amount on both and at least the min out: the buy is Filled, so
//   the pool and the token check on it (and the take and the send before it), the strip done at the kit's `filled`
//   (Final). A run that then ends not known (the page's progress "sent") puts the pool back to waiting; one that ends
//   with no fill fails the pool step (fromProgress).
// - data: the buy's wallet, the quote's venue and pool address, the filled amount: the signing page's route events for
//   the buy's id (the kit's BuyRoute, card signpage-buy-route-events), through TradeKit.route (fromBuyRoute). A page of
//   an earlier release sends none: a step checks and its value stays empty, never made up. The route's `tx` (card
//   pool-buy-send-fast) is the toast link's transaction when the answer that names it was dropped at the client's 10 s.
// - `move` (card one-balance-buys-on-every-chain): a Solana tap above what one tap spends moves its shortfall from Cash
//   into the pool first (the page's route { move: "cash" }, packages/signpage/src/cash-to-pool.ts cashFirst), about
//   40-60 s. The strip draws it as its own step before the one-time wallet, its running time from the moment the page
//   told it (stamped by the screen as it arrives, else the tap's), checked by the take with the time it took, or marked
//   the error with it when the buy ends first. A buy with no move draws no move step. The time is the move's own, read
//   from the screen's clock at its two events, never a fixed one.
// A step checks only when it is the one waiting and its own event comes: an event out of order is ignored. A failure
// marks the step that was waiting and nothing after it ever checks. No time is held here: an animation runs on its own
// clock from the event, and the times on the button and the toast are the buy's own measured ones (model.ts).
import type { BuyRoute, Stage } from "@blindfill/kit";
import { padOf } from "../market/pads.ts";
import { centsToDecimal, secs } from "./model.ts";
import type { Cents } from "./model.ts";
import { WORDS } from "./words.ts";

export type StepId = "balance" | "wallet" | "pool" | "token";
export const STEPS: readonly StepId[] = ["balance", "wallet", "pool", "token"];
export type StepState = "off" | "active" | "done" | "error";

export interface Route {
  k: "idle" | "running" | "done" | "failed";
  id: string | null;
  /** The tap's time, Unix ms. */
  at: number;
  /** The buy amount, in cents. */
  cents: Cents | null;
  /** The wallet step exists: it grows in at the tap. */
  walletIn: boolean;
  st: readonly [StepState, StepState, StepState, StepState];
  /** Each link is full once the step before it has checked. */
  links: readonly [boolean, boolean, boolean];
  wallet: string | null;
  venue: string | null;
  pool: string | null;
  out: string | null;
  tx: string | null;
  /** The move from Cash before the buy (card one-balance-buys-on-every-chain): null when none was told; its state, when
   *  it started (Unix ms) and, once it ended, how long it ran (null when its end came with no time). */
  move: { st: "active" | "done" | "error"; at: number; ms: number | null } | null;
}

export const IDLE: Route = { k: "idle", id: null, at: 0, cents: null, walletIn: false, st: ["off", "off", "off", "off"], links: [false, false, false], wallet: null, venue: null, pool: null, out: null, tx: null, move: null };

/** `at` on taken, fail and move: the screen's time of the event, Unix ms, for the move step's time. */
export type RouteEvent =
  | { t: "taken"; id: string; at?: number }
  | { t: "sent"; id: string; tx?: string }
  | { t: "filled"; id: string }
  | { t: "fail"; id: string; at?: number }
  | { t: "move"; id: string; at?: number }
  | { t: "wallet"; id: string; address: string }
  | { t: "route"; id: string; venue: string | null; pool: string }
  | { t: "out"; id: string; amount: string }
  | { t: "tx"; id: string; tx: string };

/** The Buy release: a new strip, the wallet step grown in, Private balance waiting. */
export function routeTap(id: string, at: number, cents: Cents): Route {
  return { ...IDLE, k: "running", id, at, cents, walletIn: true, st: ["active", "off", "off", "off"] };
}

const set = (st: Route["st"], i: number, s: StepState): Route["st"] => st.map((x, j) => (j === i ? s : x)) as unknown as Route["st"];
const link = (l: Route["links"], i: number): Route["links"] => l.map((x, j) => (j === i ? true : x)) as unknown as Route["links"];
/** The running move ended at `at` as `st`: its time kept; a strip with no running move as it is. */
const endMove = (m: Route["move"], st: "done" | "error", at: number | undefined): Route["move"] =>
  m === null || m.st !== "active" ? m : { st, at: m.at, ms: at === undefined ? null : Math.max(0, at - m.at) };

export function routeEvent(r: Route, ev: RouteEvent): Route {
  if (r.k === "idle" || r.id !== ev.id) return r;
  // the buy's data may follow its answer (the page queues it with the stages, the answer is posted on its own): it fills
  // its value on the strip of its own id, done or failed; it checks nothing
  if (ev.t === "wallet") return { ...r, wallet: ev.address };
  if (ev.t === "route") return { ...r, venue: ev.venue, pool: ev.pool };
  if (ev.t === "out") {
    if (r.k !== "running") return { ...r, out: ev.amount };
    let n = r;
    if (n.st[0] === "active") n = routeEvent(n, { t: "taken", id: ev.id });
    if (n.st[1] === "active") n = routeEvent(n, { t: "sent", id: ev.id });
    return n.st[2] === "active" ? { ...n, out: ev.amount, st: set(set(n.st, 2, "done"), 3, "done"), links: link(n.links, 2) } : { ...n, out: ev.amount };
  }
  // the transaction the answer named stays; the route's names it when the answer came too late to be read
  if (ev.t === "tx") return r.tx ? r : { ...r, tx: ev.tx };
  if (r.k !== "running") return r;
  switch (ev.t) {
    case "move":
      // told once, before the take: a second one, or one after the take, draws nothing new
      return r.move === null && r.st[0] === "active" ? { ...r, move: { st: "active", at: ev.at ?? r.at, ms: null } } : r;
    case "taken":
      return r.st[0] === "active" ? { ...r, st: set(set(r.st, 0, "done"), 1, "active"), links: link(r.links, 0), move: endMove(r.move, "done", ev.at) } : r;
    case "sent":
      // the same stage comes twice, as the request's answer (with the transaction) and as a progress event (without one),
      // in either order: the second only gives the transaction, it checks nothing
      if (r.st[1] === "active") return { ...r, st: set(set(r.st, 1, "done"), 2, "active"), links: link(r.links, 1), tx: ev.tx ?? r.tx };
      return ev.tx && !r.tx ? { ...r, tx: ev.tx } : r;
    case "filled":
      if (filledOnly(r)) return { ...r, k: "done" };
      return r.st[2] === "active" ? { ...r, k: "done", st: set(set(r.st, 2, "done"), 3, "done"), links: link(r.links, 2) } : r;
    case "fail": {
      if (filledOnly(r)) return { ...unfill(r), k: "failed", st: set(unfill(r).st, 2, "error") };
      const i = r.st.indexOf("active");
      return i < 0 ? r : { ...r, k: "failed", st: set(r.st, i, "error"), move: endMove(r.move, "error", ev.at) };
    }
  }
}

/** Filled by the route's amount out, not Final yet: every step checked, the strip still running. */
const filledOnly = (r: Route): boolean => r.k === "running" && r.st[3] === "done";
/** The pool waiting again, the token not reached: the strip as it was before the amount out. */
const unfill = (r: Route): Route => ({ ...r, st: set(set(r.st, 2, "active"), 3, "off"), links: [r.links[0], r.links[1], false] });

/**
 * The kit's progress event for the buy: its stage, except that a run the page ends not known (its final progress
 * "sent", pool-buy.ts poolBuyKind) after the amount out puts the strip back to the pool waiting, as the button goes
 * back to Landing (model.ts progress). The request's answer "sent" is the early one and never does (fromOutcome).
 */
export function fromProgress(r: Route, id: string, stage: Stage | "refused", at?: number): Route {
  if (stage === "sent" && r.id === id && filledOnly(r)) return unfill(r);
  return fromStage(r, id, stage, undefined, at);
}

/**
 * The kit's stage for the running buy as events. `sent` is taken and sent (the take comes before the send). A `filled`
 * with no `sent` before it (the answer came at the run's end) is a transaction that was taken and sent, in that order.
 * `signed` moves nothing; the stages that end a buy without a complete fill fail the step that was waiting. `at`: the
 * screen's time of the stage, the end of a running move from Cash.
 */
export function fromStage(r: Route, id: string, stage: Stage | "refused", tx?: string, at?: number): Route {
  let n = r;
  const ev = (e: RouteEvent) => (n = routeEvent(n, e));
  const when = at === undefined ? {} : { at };
  if (stage === "sent") {
    ev({ t: "taken", id, ...when });
    ev({ t: "sent", id, ...(tx ? { tx } : {}) });
  } else if (stage === "filled") {
    ev({ t: "taken", id, ...when });
    ev({ t: "sent", id, ...(tx ? { tx } : {}) });
    ev({ t: "filled", id });
  } else if (stage === "part_filled" || stage === "not_landed" || stage === "refused") ev({ t: "fail", id, ...when });
  return n;
}

/** The buy request's own answer as events: its stage (with the transaction it names), or a refusal. The client's own
 *  timeout ends nothing: the page may still run the buy, so the strip waits for its events (as model.ts outcome does). */
export function fromOutcome(
  r: Route,
  id: string,
  o: { ok: true; result: { stage: Stage; txs?: readonly { hash: string }[] } } | { ok: false; error: { code: string } },
  at?: number,
): Route {
  if (o.ok) return fromStage(r, id, o.result.stage, o.result.txs?.[0]?.hash, at);
  return o.error.code === "client_timeout" ? r : fromStage(r, id, "refused", undefined, at);
}

/** What the signing page tells the app of a buy besides its stage (TradeKit.route). */
export type RouteData = Extract<RouteEvent, { t: "wallet" | "route" | "out" | "tx" | "move" }>;

/** The kit's venue ids the strip names, each by a name already on screen (market/pads.ts): the bonding curve is
 *  pump.fun's own. An id with none names no venue, so the pool's label stays the bare one: never the raw id. */
const VENUE_PAD: Readonly<Record<string, string>> = { "pump-curve": "pump.fun" };

/** One route event of the kit (the signing page's own reads, by the buy's id) as the strip's data. */
export function fromBuyRoute(id: string, r: BuyRoute): RouteData | null {
  // the kit's own keys only (its client checked the shape): an inherited field names nothing
  const x = r as Partial<Record<"wallet" | "venue" | "pool" | "out" | "tx" | "move", string>>;
  if (Object.hasOwn(r, "wallet") && x.wallet) return { t: "wallet", id, address: x.wallet };
  if (Object.hasOwn(r, "venue") && Object.hasOwn(r, "pool") && x.venue !== undefined && x.pool) {
    const pad = Object.hasOwn(VENUE_PAD, x.venue) ? padOf(VENUE_PAD[x.venue]) : null;
    return { t: "route", id, venue: pad ? pad.name : null, pool: x.pool };
  }
  if (Object.hasOwn(r, "out") && x.out) return { t: "out", id, amount: x.out };
  if (Object.hasOwn(r, "tx") && x.tx) return { t: "tx", id, tx: x.tx };
  if (Object.hasOwn(r, "move") && x.move === "cash") return { t: "move", id };
  return null;
}

/** TradeKit.route on the kit's route events (client.onRoute): each one, by its buy's id, as the strip's data. */
export const liveRoute =
  (onRoute: (fn: (id: string, r: BuyRoute) => void) => () => void) =>
  (on: (d: RouteData) => void): (() => void) =>
    onRoute((id, r) => {
      const d = fromBuyRoute(id, r);
      if (d) on(d);
    });

const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Cents as the strip draws the amount: "$25.00", grouped, always two decimals. */
export const usd2 = (c: Cents): string => `$${(c / 100n).toLocaleString("en-US")}.${centsToDecimal(c).slice(-2)}`;

/** A step's state and its value, hidden until its step has happened: Private balance's amount once taken, the others once
 *  they are the step waiting (their value fades in before their check). */
export function stepView(r: Route, step: StepId): { state: StepState; value: string | null } {
  const i = STEPS.indexOf(step);
  const state = r.st[i]!;
  const shown = state === "done" || (i > 0 && (state === "active" || state === "error"));
  let value: string | null = null;
  if (shown) {
    if (step === "balance") value = r.cents === null ? null : usd2(r.cents);
    else if (step === "wallet") value = r.wallet ? short(r.wallet) : null;
    else if (step === "pool") value = r.pool ? short(r.pool) : null;
    else value = r.out;
  }
  return { state, value };
}

/** The move step (card one-balance-buys-on-every-chain): its state and its time, running from its start while it runs
 *  (`now`, the screen's clock), the time it took once it ended; null when the buy moves nothing from Cash. */
export function moveView(r: Route, now: number): { state: "active" | "done" | "error"; value: string | null } | null {
  const m = r.move;
  if (m === null) return null;
  return { state: m.st, value: m.st === "active" ? secs(now - m.at) : m.ms === null ? null : secs(m.ms) };
}

/** The toast's second line: this buy's measured time, the filled amount when an event gave it, the buy amount. */
export function toastLine(ms: number, outText: string | null, symbol: string, usd: string): string {
  return [`${WORDS.filled.text} ${secs(ms)}`, ...(outText ? [`${outText} ${symbol}`] : []), usd].join(" · ");
}
