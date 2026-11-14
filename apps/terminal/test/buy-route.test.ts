// The buy route strip's state machine (card app-buy-route-strip; the spec in the research repo,
// docs/drafts/buy-route-strip-spec.md; locked design design-lock-r5, P.pvTrade): four steps, Private balance, the
// buy's one-time wallet, the pool, the token. Each step checks only on its own event from the pool buy, a failure stops
// at the step that was waiting, a value is hidden until its step has happened, and nothing here is a fixed time: the
// times on the button and the toast are the buy's own measured ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBuyRoute, fromOutcome, fromProgress, fromStage, IDLE, liveRoute, moveView, routeEvent, routeTap, stepView, toastLine } from "../src/screens/trade/route.ts";
import type { BuyRoute } from "@blindfill/kit";
import type { Route } from "../src/screens/trade/route.ts";

const T0 = Date.parse("2026-11-04T16:00:00Z");
const WALLET = "9DJaQ4m2x7Vn8Kp3Rt5Yb1Zc6Hf0LsEw9GdUaBZst6";
const POOL = "G19cYh2Wq8Nv4Tp7Kx3Rb5Zm1Dc6Fs0LeAuJgHhTQki";
const steps = (r: Route) => (["balance", "wallet", "pool", "token"] as const).map((s) => stepView(r, s).state);
const values = (r: Route) => (["balance", "wallet", "pool", "token"] as const).map((s) => stepView(r, s).value);
const tap = (): Route => routeTap("b1", T0, 2_500n);

test("before the tap: three steps, no wallet step, nothing checked, no values, no link filled", () => {
  assert.equal(IDLE.walletIn, false);
  assert.deepEqual(steps(IDLE), ["off", "off", "off", "off"]);
  assert.deepEqual(values(IDLE), [null, null, null, null]);
  assert.deepEqual(IDLE.links, [false, false, false]);
});

test("the tap: the wallet step grows in, Private balance is the step waiting, nothing is checked yet", () => {
  const r = tap();
  assert.equal(r.walletIn, true);
  assert.deepEqual(steps(r), ["active", "off", "off", "off"]);
  assert.deepEqual(values(r), [null, null, null, null]);
});

test("each step checks only on its own event", () => {
  let r = tap();
  // the wallet, the venue and the pool are data: none of them checks a step (the filled amount is the pool's and the
  // token's event, card pool-buy-filled-2s: its test below)
  r = routeEvent(r, { t: "wallet", id: "b1", address: WALLET });
  r = routeEvent(r, { t: "route", id: "b1", venue: "Raydium", pool: POOL });
  assert.deepEqual(steps(r), ["active", "off", "off", "off"]);
  // sent before the amount was taken is not the wallet's event: ignored
  assert.deepEqual(steps(routeEvent(r, { t: "sent", id: "b1", tx: "sig" })), ["active", "off", "off", "off"]);
  // filled before sent: ignored
  assert.deepEqual(steps(routeEvent(r, { t: "filled", id: "b1" })), ["active", "off", "off", "off"]);
  r = routeEvent(r, { t: "taken", id: "b1" });
  assert.deepEqual(steps(r), ["done", "active", "off", "off"]);
  assert.deepEqual(steps(routeEvent(r, { t: "filled", id: "b1" })), ["done", "active", "off", "off"]);
  r = routeEvent(r, { t: "sent", id: "b1", tx: "sig" });
  assert.deepEqual(steps(r), ["done", "done", "active", "off"]);
  r = routeEvent(r, { t: "filled", id: "b1" });
  assert.deepEqual(steps(r), ["done", "done", "done", "done"]);
  assert.deepEqual(r.links, [true, true, true]);
  assert.equal(r.k, "done");
});

test("a value is hidden until its step has happened, then shows what the events carried", () => {
  let r = tap();
  r = routeEvent(r, { t: "wallet", id: "b1", address: WALLET });
  r = routeEvent(r, { t: "route", id: "b1", venue: "Raydium", pool: POOL });
  // the data came early: nothing shows yet
  assert.deepEqual(values(r), [null, null, null, null]);
  r = routeEvent(r, { t: "taken", id: "b1" });
  assert.deepEqual(values(r), ["$25.00", "9DJa…Zst6", null, null]);
  r = routeEvent(r, { t: "sent", id: "b1", tx: "sig" });
  assert.deepEqual(values(r), ["$25.00", "9DJa…Zst6", "G19c…TQki", null]);
  r = routeEvent(r, { t: "out", id: "b1", amount: "10600" });
  assert.deepEqual(values(r), ["$25.00", "9DJa…Zst6", "G19c…TQki", "10600"]);
  r = routeEvent(r, { t: "filled", id: "b1" });
  assert.deepEqual(values(r), ["$25.00", "9DJa…Zst6", "G19c…TQki", "10600"]);
  assert.equal(r.venue, "Raydium");
});

test("what no event carried stays empty: a step checks, its value is not made up", () => {
  let r = tap();
  r = routeEvent(r, { t: "taken", id: "b1" });
  r = routeEvent(r, { t: "sent", id: "b1", tx: "sig" });
  r = routeEvent(r, { t: "filled", id: "b1" });
  assert.deepEqual(steps(r), ["done", "done", "done", "done"]);
  assert.deepEqual(values(r), ["$25.00", null, null, null]);
  assert.equal(r.venue, null);
});

test("a failure stops at the step that was waiting; the steps before it keep their checks, none after is ever checked", () => {
  // refused at the tap: the amount was never taken
  let r = fromStage(tap(), "b1", "refused");
  assert.deepEqual(steps(r), ["error", "off", "off", "off"]);
  assert.equal(r.k, "failed");
  // sent, then not landed: Private balance and the wallet keep their checks, the pool is the error
  r = fromStage(fromStage(tap(), "b1", "sent"), "b1", "not_landed");
  assert.deepEqual(steps(r), ["done", "done", "error", "off"]);
  assert.deepEqual(r.links, [true, true, false]);
  // nothing after a failure moves it again
  assert.deepEqual(steps(routeEvent(r, { t: "filled", id: "b1" })), ["done", "done", "error", "off"]);
  assert.deepEqual(steps(fromStage(r, "b1", "filled")), ["done", "done", "error", "off"]);
  // a part fill is not a complete fill: the pool step is the error, the token is not checked
  assert.deepEqual(steps(fromStage(fromStage(tap(), "b1", "sent"), "b1", "part_filled")), ["done", "done", "error", "off"]);
});

test("the kit's stages map to events: signed moves nothing, sent is taken and sent, filled is every step", () => {
  assert.deepEqual(steps(fromStage(tap(), "b1", "signed")), ["active", "off", "off", "off"]);
  assert.deepEqual(steps(fromStage(tap(), "b1", "sent")), ["done", "done", "active", "off"]);
  assert.deepEqual(steps(fromStage(fromStage(tap(), "b1", "sent"), "b1", "filled")), ["done", "done", "done", "done"]);
  // an answer of filled with no sent before it: the transaction that filled was taken and sent, so every step in order
  assert.deepEqual(steps(fromStage(tap(), "b1", "filled")), ["done", "done", "done", "done"]);
  // another buy's id moves nothing
  assert.deepEqual(steps(fromStage(tap(), "other", "filled")), ["active", "off", "off", "off"]);
  assert.deepEqual(steps(routeEvent(tap(), { t: "taken", id: "other" })), ["active", "off", "off", "off"]);
});

test("the answer and the progress event both say sent, in either order: the transaction is kept, no step checks twice", () => {
  const a = fromOutcome(fromStage(tap(), "b1", "sent"), "b1", { ok: true, result: { stage: "sent", txs: [{ hash: "sig" }] } });
  assert.equal(a.tx, "sig");
  assert.deepEqual(steps(a), ["done", "done", "active", "off"]);
  const b = fromStage(fromOutcome(tap(), "b1", { ok: true, result: { stage: "sent", txs: [{ hash: "sig" }] } }), "b1", "sent");
  assert.equal(b.tx, "sig");
  assert.deepEqual(steps(b), ["done", "done", "active", "off"]);
});

test("a refusal ends the strip at its step; the client's own timeout ends nothing", () => {
  assert.deepEqual(steps(fromOutcome(tap(), "b1", { ok: false, error: { code: "quote_check_failed" } })), ["error", "off", "off", "off"]);
  assert.deepEqual(steps(fromOutcome(tap(), "b1", { ok: false, error: { code: "client_timeout" } })), ["active", "off", "off", "off"]);
});

test("a new tap starts a new strip: nothing of the last buy stays", () => {
  const done = fromStage(tap(), "b1", "filled");
  const next = routeTap("b2", T0 + 60_000, 1_000n);
  assert.deepEqual(steps(next), ["active", "off", "off", "off"]);
  assert.deepEqual(values(next), [null, null, null, null]);
  assert.notEqual(next.id, done.id);
});

test("the toast carries this buy's own time, never a fixed one, and only what is known", () => {
  assert.equal(toastLine(1_234, "10.6K", "NEARKAT", "$25.00"), "Filled 1.2s · 10.6K NEARKAT · $25.00");
  assert.equal(toastLine(3_777, "10.6K", "NEARKAT", "$25.00"), "Filled 3.7s · 10.6K NEARKAT · $25.00");
  assert.equal(toastLine(3_777, null, "NEARKAT", "$25.00"), "Filled 3.7s · $25.00");
});

// Card signpage-buy-route-events: the live source reads the kit's route events (client.onRoute), each by its buy's id.
test("the live seam: the kit's route events by id become the strip's wallet, venue and pool, and filled amount", () => {
  const subs = new Set<(id: string, r: BuyRoute) => void>();
  const route = liveRoute((fn) => (subs.add(fn), () => void subs.delete(fn)));
  let r = tap();
  const off = route((d) => (r = routeEvent(r, d)));
  const post = (id: string, x: BuyRoute) => subs.forEach((f) => f(id, x));
  post("b1", { wallet: WALLET });
  post("b1", { venue: "pump-curve", pool: POOL });
  post("other", { out: "1" });
  r = fromStage(r, "b1", "sent", "sig");
  post("b1", { out: "10600.5" });
  r = fromStage(r, "b1", "filled");
  assert.deepEqual(values(r), ["$25.00", "9DJa…Zst6", "G19c…TQki", "10600.5"]);
  assert.equal(r.venue, "pump.fun");
  off();
  assert.equal(subs.size, 0);
});

test("a venue id with no name already on screen names no venue (the bare label), never the raw id", () => {
  assert.deepEqual(fromBuyRoute("b1", { venue: "pump-curve", pool: POOL }), { t: "route", id: "b1", venue: "pump.fun", pool: POOL });
  for (const venue of ["pumpswap", "Raydium", "__proto__", "constructor", ""]) {
    assert.deepEqual(fromBuyRoute("b1", { venue, pool: POOL }), { t: "route", id: "b1", venue: null, pool: POOL });
  }
  assert.deepEqual(fromBuyRoute("b1", { wallet: WALLET }), { t: "wallet", id: "b1", address: WALLET });
  assert.deepEqual(fromBuyRoute("b1", { out: "7" }), { t: "out", id: "b1", amount: "7" });
});

// fold 1 (L2): the page queues a buy's route events with its stages but posts the answer on its own, so a route event may
// come after the answer: it still fills its value on the strip of its own id, done or failed, and checks nothing.
test("a route event after the answer still fills its value, done or failed; another buy's never does", () => {
  let r = fromStage(tap(), "b1", "filled", "sig");
  assert.equal(r.k, "done");
  r = routeEvent(r, { t: "wallet", id: "b1", address: WALLET });
  r = routeEvent(r, { t: "route", id: "b1", venue: "pump.fun", pool: POOL });
  r = routeEvent(r, { t: "out", id: "b1", amount: "10600" });
  assert.deepEqual(values(r), ["$25.00", "9DJa…Zst6", "G19c…TQki", "10600"]);
  assert.deepEqual(steps(r), ["done", "done", "done", "done"], "data checks nothing");
  let f = fromStage(fromStage(tap(), "b1", "sent", "sig"), "b1", "not_landed");
  assert.equal(f.k, "failed");
  f = routeEvent(f, { t: "route", id: "b1", venue: null, pool: POOL });
  assert.equal(f.pool, POOL);
  assert.deepEqual(steps(f), ["done", "done", "error", "off"]);
  assert.equal(routeEvent(r, { t: "out", id: "b2", amount: "1" }).out, "10600", "another buy's id");
  assert.equal(routeEvent(IDLE, { t: "wallet", id: "b1", address: WALLET }), IDLE, "no strip before a tap");
});

// card pool-buy-send-fast: a buy whose answer came past the kit client's 10 s (a mainnet bundle landing late) is
// dropped as client_timeout and its final stage comes as progress with no transaction; the page's route event { tx }
// still names it, so the toast links it ("Filled with no link" before)
test("the route's tx: after a client_timeout and a filled with no transaction, the route event gives the link's transaction; it never replaces one", () => {
  const SIG = "48Xv1SNVzuNDAaB6FXW5MNUjCMW5LArZdeqJahVeQ3DrsXzBSPQQxiNjiV2wvuF5v58AXjSECU5LHuYfKb4nNBEv";
  let r = fromOutcome(tap(), "b1", { ok: false, error: { code: "client_timeout" } });
  const subs = new Set<(id: string, r: BuyRoute) => void>();
  const route = liveRoute((fn) => (subs.add(fn), () => void subs.delete(fn)));
  route((d) => void (r = routeEvent(r, d)));
  for (const f of subs) f("b1", { tx: SIG } as BuyRoute);
  r = fromStage(r, "b1", "filled");
  assert.equal(r.k, "done");
  assert.equal(r.tx, SIG);
  // filled first, then the tx: the same link
  let late = fromStage(tap(), "b1", "filled");
  assert.equal(late.tx, null);
  late = routeEvent(late, fromBuyRoute("b1", { tx: SIG } as BuyRoute)!);
  assert.equal(late.tx, SIG);
  assert.deepEqual(steps(late), ["done", "done", "done", "done"], "the tx checks nothing");
  // the answer's transaction is kept; another buy's tx names nothing; an inherited tx is nothing
  assert.equal(routeEvent(fromStage(tap(), "b1", "sent", "ans"), { t: "tx", id: "b1", tx: SIG }).tx, "ans");
  assert.equal(routeEvent(late, { t: "tx", id: "b2", tx: "other" }).tx, SIG);
  // review: another buy's tx names nothing on a strip with no tx yet, done or running
  assert.equal(routeEvent(fromStage(tap(), "b1", "filled"), { t: "tx", id: "b2", tx: SIG }).tx, null);
  assert.equal(routeEvent(tap(), { t: "tx", id: "b2", tx: SIG }).tx, null);
  assert.equal(fromBuyRoute("b1", Object.create({ tx: SIG }) as BuyRoute), null);
});

// fold 1 (L3): the kit's own keys only: an inherited field names nothing, and nothing reaches the strip
test("fromBuyRoute reads only the event's own keys: an inherited wallet, venue or out names nothing", () => {
  for (const proto of [{ wallet: WALLET }, { venue: "pump-curve", pool: POOL }, { out: "7" }]) {
    assert.equal(fromBuyRoute("b1", Object.create(proto) as BuyRoute), null, JSON.stringify(proto));
  }
  const seen: unknown[] = [];
  const route = liveRoute((fn) => (fn("b1", Object.create({ wallet: WALLET }) as BuyRoute), () => {}));
  route((d) => void seen.push(d));
  assert.deepEqual(seen, []);
});

// Card pool-buy-filled-2s and the review of 418af7d5: the route's amount out (this very transaction read at confirmed on
// both RPCs, at least the min out) is the buy Filled, as the button says: the pool and the token check, the amount shows,
// the strip is not done until the kit's filled (Final). A run that then ends not known (the page's progress "sent") puts
// the strip back where the button is, the pool waiting and the token not shown; one that ends with no fill fails the pool
// step, nothing after it checked. The request's early answer "sent" never undoes it.
test("card pool-buy-filled-2s: the amount out checks the pool and the token; the kit's filled ends the strip done", () => {
  const sent = fromStage(tap(), "b1", "sent");
  const f = routeEvent(sent, { t: "out", id: "b1", amount: "10600" });
  assert.deepEqual(steps(f), ["done", "done", "done", "done"]);
  assert.deepEqual(f.links, [true, true, true]);
  assert.equal(values(f)[3], "10600");
  assert.equal(f.k, "running", "not Final yet");
  const fin = fromStage(f, "b1", "filled");
  assert.deepEqual(steps(fin), ["done", "done", "done", "done"]);
  assert.equal(fin.k, "done");
  // the out before the answer's sent reached the app (the answer is posted on its own): the take and the send happened
  assert.deepEqual(steps(routeEvent(tap(), { t: "out", id: "b1", amount: "10600" })), ["done", "done", "done", "done"]);
  // another buy's out moves nothing
  assert.deepEqual(steps(routeEvent(sent, { t: "out", id: "b2", amount: "10600" })), ["done", "done", "active", "off"]);
});

test("review of 418af7d5: after the amount out, a run that ends not known is the pool waiting again; one with no fill fails the pool step", () => {
  const f = routeEvent(fromStage(tap(), "b1", "sent"), { t: "out", id: "b1", amount: "10600" });
  const back = fromProgress(f, "b1", "sent");
  assert.deepEqual(steps(back), ["done", "done", "active", "off"]);
  assert.deepEqual(back.links, [true, true, false]);
  assert.deepEqual(values(back).slice(3), [null]);
  assert.equal(back.k, "running");
  assert.equal(fromProgress(back, "b1", "filled").k, "done");
  // the early answer "sent" after the out moves nothing
  assert.deepEqual(fromOutcome(f, "b1", { ok: true, result: { stage: "sent", txs: [{ hash: "sig" }] } }), { ...f, tx: f.tx ?? "sig" });
  for (const s of ["not_landed", "part_filled", "refused"] as const) {
    const nl = fromProgress(f, "b1", s);
    assert.deepEqual(steps(nl), ["done", "done", "error", "off"], s);
    assert.deepEqual(nl.links, [true, true, false], s);
    assert.equal(nl.k, "failed", s);
  }
  assert.equal(fromOutcome(f, "b1", { ok: false, error: { code: "failed" } }).k, "failed");
  // another buy's end never moves it
  assert.deepEqual(fromProgress(f, "b2", "not_landed"), f);
  assert.deepEqual(fromProgress(f, "b2", "sent"), f);
});

// Card one-balance-buys-on-every-chain: a Solana tap above what one tap spends moves its shortfall from Cash first and
// the page tells it (route { move: "cash" }, packages/signpage/src/cash-to-pool.ts cashFirst). The strip draws the move
// as its own step before the one-time wallet, with its running time from the moment the page told it, until the take
// (the kit's sent) checks it with the time it took; a buy that ends while it moves marks it the error. A buy with no
// move draws no move step.
test("card one-balance-buys-on-every-chain: the move from Cash is its own step with its running time; the take checks it, an end while moving fails it", () => {
  assert.equal(moveView(tap(), T0 + 1_000), null, "no move told: no move step");
  assert.equal(moveView(IDLE, T0), null);
  const moved = routeEvent(tap(), { t: "move", id: "b1", at: T0 + 200 });
  assert.deepEqual(moveView(moved, T0 + 12_500), { state: "active", value: "12.3s" });
  assert.deepEqual(steps(moved), ["active", "off", "off", "off"], "the move checks no other step");
  // another buy's move, and a second move of the same buy, keep what is drawn
  assert.equal(moveView(routeEvent(tap(), { t: "move", id: "b2", at: T0 + 200 }), T0 + 1_000), null);
  assert.deepEqual(moveView(routeEvent(moved, { t: "move", id: "b1", at: T0 + 9_000 }), T0 + 12_500), { state: "active", value: "12.3s" });
  // the move landed and the buy went out (the kit's sent): the move checks with the time it took, then the buy runs on
  const sent = fromProgress(moved, "b1", "sent", T0 + 45_200);
  assert.deepEqual(moveView(sent, T0 + 60_000), { state: "done", value: "45.0s" });
  assert.deepEqual(steps(sent), ["done", "done", "active", "off"]);
  const done = fromStage(sent, "b1", "filled", undefined, T0 + 46_000);
  assert.deepEqual(moveView(done, T0 + 90_000), { state: "done", value: "45.0s" });
  assert.equal(done.k, "done");
  // the request's own answer checks it the same way
  assert.deepEqual(moveView(fromOutcome(moved, "b1", { ok: true, result: { stage: "sent", txs: [{ hash: "sig" }] } }, T0 + 40_200), T0 + 50_000), { state: "done", value: "40.0s" });
  // a move told after the take draws nothing new
  assert.equal(moveView(routeEvent(fromStage(tap(), "b1", "sent", "sig", T0 + 900), { t: "move", id: "b1", at: T0 + 1_000 }), T0 + 2_000), null);
  // the buy ends while it moves (the move never landed in time, or was refused): the move step is the error, with its time
  const failed = fromOutcome(moved, "b1", { ok: false, error: { code: "not_funded" } }, T0 + 180_200);
  assert.deepEqual(moveView(failed, T0 + 200_000), { state: "error", value: "180.0s" });
  assert.deepEqual(steps(failed), ["error", "off", "off", "off"]);
  assert.equal(failed.k, "failed");
  // the client's own timeout ends nothing: the move still runs
  assert.deepEqual(moveView(fromOutcome(moved, "b1", { ok: false, error: { code: "client_timeout" } }, T0 + 10_200), T0 + 12_500), { state: "active", value: "12.3s" });
  // a new tap starts with no move
  assert.equal(moveView(routeTap("b2", T0 + 300_000, 1_000n), T0 + 300_500), null);
});

test("card one-balance-buys-on-every-chain: the kit's route event { move: \"cash\" } is the strip's move, by its buy's id; any other move or an inherited one is nothing", () => {
  assert.deepEqual(fromBuyRoute("b1", { move: "cash" }), { t: "move", id: "b1" });
  assert.equal(fromBuyRoute("b1", { move: "card" } as unknown as BuyRoute), null);
  assert.equal(fromBuyRoute("b1", Object.create({ move: "cash" }) as BuyRoute), null);
  // through the live seam: the move told for b1 draws on b1's strip, from the tap's time when no time was stamped
  const subs = new Set<(id: string, r: BuyRoute) => void>();
  const route = liveRoute((fn) => (subs.add(fn), () => void subs.delete(fn)));
  let r = tap();
  route((d) => void (r = routeEvent(r, d)));
  subs.forEach((f) => f("other", { move: "cash" }));
  assert.equal(moveView(r, T0 + 1_000), null);
  subs.forEach((f) => f("b1", { move: "cash" }));
  assert.deepEqual(moveView(r, T0 + 1_000), { state: "active", value: "1.0s" });
});
