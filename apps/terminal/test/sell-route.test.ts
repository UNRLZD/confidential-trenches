// The sell's flow (card sell-box-works-like-the-buy-box, owner 13 Nov 18:11Z: "the same UI/UX animation as the buy
// flow"): the buy's four steps reversed, the coin, its one-time wallet, the pool, Private balance, checked by the same
// events in that order, with the sell's own values (the amount sold, W, the pool, the USD back); and the buy's strip
// unchanged. The box draws it: test/sell-positions/run.mjs reads the four steps in order on screen.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromOutcome, fromProgress, fromStage, IDLE, routeEvent, routeSell, SELL_IDLE, SELL_STEPS, STEPS, stepsOf, stepView } from "../src/screens/trade/route.ts";
import type { Route } from "../src/screens/trade/route.ts";

const T0 = Date.parse("2026-11-13T18:00:00Z");
const W = "3RrvQ4m2x7Vn8Kp3Rt5Yb1Zc6Hf0LsEw9GdUaBEQfn";
const POOL = "Ho1aYh2Wq8Nv4Tp7Kx3Rb5Zm1Dc6Fs0LeAuJgHyeBz";
// in the order the strip draws a sell
const steps = (r: Route) => stepsOf(r).map((s) => stepView(r, s).state);
const values = (r: Route) => stepsOf(r).map((s) => stepView(r, s).value);
const tap = (wallet: string | null = W): Route => routeSell("s1", T0, "32.82", 50n, wallet);

test("a sell runs the buy's flow back: the coin, the one-time wallet, the pool, Private balance", () => {
  assert.deepEqual(SELL_STEPS, ["token", "wallet", "pool", "balance"]);
  // the money's own path (the brief's order): the coin leaves its wallet into the pool, the USD lands in Private balance
  assert.deepEqual(stepsOf(SELL_IDLE), SELL_STEPS);
  assert.deepEqual(stepsOf(IDLE), STEPS);
  assert.equal(SELL_IDLE.walletIn, false);
  assert.deepEqual(steps(SELL_IDLE), ["off", "off", "off", "off"]);
  assert.deepEqual(values(SELL_IDLE), [null, null, null, null]);
});

test("the Sell tap: the wallet step grows in, the coin is the step waiting, nothing checked or shown yet", () => {
  const r = tap();
  assert.equal(r.side, "sell");
  assert.equal(r.walletIn, true);
  assert.deepEqual(steps(r), ["active", "off", "off", "off"]);
  assert.deepEqual(values(r), [null, null, null, null]);
});

test("sent checks the coin and the wallet, the pool waits; the fill checks the pool and Private balance, with the USD back", () => {
  let r = fromStage(tap(), "s1", "sent");
  assert.deepEqual(steps(r), ["done", "done", "active", "off"]);
  assert.deepEqual(r.links, [true, true, false]);
  assert.deepEqual(values(r), ["32.82", "3Rrv…EQfn", null, null]);
  // the page's route event names the pool (and the venue); a page that names none leaves it empty
  r = routeEvent(r, { t: "route", id: "s1", venue: null, pool: POOL });
  assert.deepEqual(values(r), ["32.82", "3Rrv…EQfn", "Ho1a…yeBz", null]);
  r = fromProgress(r, "s1", "filled");
  assert.equal(r.k, "done");
  assert.deepEqual(steps(r), ["done", "done", "done", "done"]);
  assert.deepEqual(r.links, [true, true, true]);
  assert.deepEqual(values(r), ["32.82", "3Rrv…EQfn", "Ho1a…yeBz", "≈ $0.50"]);
});

test("a sale across several wallets names none until the page does; no preview leaves the USD back empty", () => {
  let r = fromStage(routeSell("s2", T0, "10", null, null), "s2", "filled");
  assert.deepEqual(values(r), ["10", null, null, null]);
  r = routeEvent(r, { t: "wallet", id: "s2", address: W });
  assert.equal(stepView(r, "wallet").value, "3Rrv…EQfn");
});

test("a refused sell fails the coin step; one not landed fails the pool, nothing after it checks", () => {
  const refused = fromOutcome(tap(), "s1", { ok: false, error: { code: "quote_check_failed" } });
  assert.deepEqual(steps(refused), ["error", "off", "off", "off"]);
  const lost = fromProgress(fromStage(tap(), "s1", "sent"), "s1", "not_landed");
  assert.deepEqual(steps(lost), ["done", "done", "error", "off"]);
  assert.equal(stepView(lost, "balance").value, null);
  // a client timeout ends nothing
  assert.equal(fromOutcome(tap(), "s1", { ok: false, error: { code: "client_timeout" } }).k, "running");
});

test("another id's events move nothing", () => {
  const r = tap();
  assert.equal(fromStage(r, "other", "filled"), r);
  assert.equal(routeEvent(r, { t: "wallet", id: "other", address: W }), r);
});

test("the buy's strip is unchanged: Private balance first, its spend on it, the amount out on the coin", () => {
  assert.equal(IDLE.side, "buy");
  assert.deepEqual(STEPS, ["balance", "wallet", "pool", "token"]);
});
