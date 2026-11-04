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
// - data: the buy's wallet, the quote's venue and pool address, the filled amount: the signing page's route events for
//   the buy's id (the kit's BuyRoute, card signpage-buy-route-events), through TradeKit.route (fromBuyRoute). A page of
//   an earlier release sends none: a step checks and its value stays empty, never made up.
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
}

export const IDLE: Route = { k: "idle", id: null, at: 0, cents: null, walletIn: false, st: ["off", "off", "off", "off"], links: [false, false, false], wallet: null, venue: null, pool: null, out: null, tx: null };

export type RouteEvent =
  | { t: "taken"; id: string }
  | { t: "sent"; id: string; tx?: string }
  | { t: "filled"; id: string }
  | { t: "fail"; id: string }
  | { t: "wallet"; id: string; address: string }
  | { t: "route"; id: string; venue: string | null; pool: string }
  | { t: "out"; id: string; amount: string };

/** The Buy release: a new strip, the wallet step grown in, Private balance waiting. */
export function routeTap(id: string, at: number, cents: Cents): Route {
  return { ...IDLE, k: "running", id, at, cents, walletIn: true, st: ["active", "off", "off", "off"] };
}

const set = (st: Route["st"], i: number, s: StepState): Route["st"] => st.map((x, j) => (j === i ? s : x)) as unknown as Route["st"];
const link = (l: Route["links"], i: number): Route["links"] => l.map((x, j) => (j === i ? true : x)) as unknown as Route["links"];

export function routeEvent(r: Route, ev: RouteEvent): Route {
  if (r.k !== "running" || r.id !== ev.id) return r;
  switch (ev.t) {
    case "wallet":
      return { ...r, wallet: ev.address };
    case "route":
      return { ...r, venue: ev.venue, pool: ev.pool };
    case "out":
      return { ...r, out: ev.amount };
    case "taken":
      return r.st[0] === "active" ? { ...r, st: set(set(r.st, 0, "done"), 1, "active"), links: link(r.links, 0) } : r;
    case "sent":
      // the same stage comes twice, as the request's answer (with the transaction) and as a progress event (without one),
      // in either order: the second only gives the transaction, it checks nothing
      if (r.st[1] === "active") return { ...r, st: set(set(r.st, 1, "done"), 2, "active"), links: link(r.links, 1), tx: ev.tx ?? r.tx };
      return ev.tx && !r.tx ? { ...r, tx: ev.tx } : r;
    case "filled":
      return r.st[2] === "active" ? { ...r, k: "done", st: set(set(r.st, 2, "done"), 3, "done"), links: link(r.links, 2) } : r;
    case "fail": {
      const i = r.st.indexOf("active");
      return i < 0 ? r : { ...r, k: "failed", st: set(r.st, i, "error") };
    }
  }
}

/**
 * The kit's stage for the running buy as events. `sent` is taken and sent (the take comes before the send). A `filled`
 * with no `sent` before it (the answer came at the run's end) is a transaction that was taken and sent, in that order.
 * `signed` moves nothing; the stages that end a buy without a complete fill fail the step that was waiting.
 */
export function fromStage(r: Route, id: string, stage: Stage | "refused", tx?: string): Route {
  let n = r;
  const ev = (e: RouteEvent) => (n = routeEvent(n, e));
  if (stage === "sent") {
    ev({ t: "taken", id });
    ev({ t: "sent", id, ...(tx ? { tx } : {}) });
  } else if (stage === "filled") {
    ev({ t: "taken", id });
    ev({ t: "sent", id, ...(tx ? { tx } : {}) });
    ev({ t: "filled", id });
  } else if (stage === "part_filled" || stage === "not_landed" || stage === "refused") ev({ t: "fail", id });
  return n;
}

/** The buy request's own answer as events: its stage (with the transaction it names), or a refusal. The client's own
 *  timeout ends nothing: the page may still run the buy, so the strip waits for its events (as model.ts outcome does). */
export function fromOutcome(
  r: Route,
  id: string,
  o: { ok: true; result: { stage: Stage; txs?: readonly { hash: string }[] } } | { ok: false; error: { code: string } },
): Route {
  if (o.ok) return fromStage(r, id, o.result.stage, o.result.txs?.[0]?.hash);
  return o.error.code === "client_timeout" ? r : fromStage(r, id, "refused");
}

/** What the signing page tells the app of a buy besides its stage (TradeKit.route). */
export type RouteData = Extract<RouteEvent, { t: "wallet" | "route" | "out" }>;

/** The kit's venue ids the strip names, each by a name already on screen (market/pads.ts): the bonding curve is
 *  pump.fun's own. An id with none names no venue, so the pool's label stays the bare one: never the raw id. */
const VENUE_PAD: Readonly<Record<string, string>> = { "pump-curve": "pump.fun" };

/** One route event of the kit (the signing page's own reads, by the buy's id) as the strip's data. */
export function fromBuyRoute(id: string, r: BuyRoute): RouteData {
  if ("wallet" in r) return { t: "wallet", id, address: r.wallet };
  if ("venue" in r) {
    const pad = Object.hasOwn(VENUE_PAD, r.venue) ? padOf(VENUE_PAD[r.venue]) : null;
    return { t: "route", id, venue: pad ? pad.name : null, pool: r.pool };
  }
  return { t: "out", id, amount: r.out };
}

/** TradeKit.route on the kit's route events (client.onRoute): each one, by its buy's id, as the strip's data. */
export const liveRoute =
  (onRoute: (fn: (id: string, r: BuyRoute) => void) => () => void) =>
  (on: (d: RouteData) => void): (() => void) =>
    onRoute((id, r) => on(fromBuyRoute(id, r)));

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

/** The toast's second line: this buy's measured time, the filled amount when an event gave it, the buy amount. */
export function toastLine(ms: number, outText: string | null, symbol: string, usd: string): string {
  return [`${WORDS.filled.text} ${secs(ms)}`, ...(outText ? [`${outText} ${symbol}`] : []), usd].join(" · ");
}
