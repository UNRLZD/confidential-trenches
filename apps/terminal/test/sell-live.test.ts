// The trade box's Sell side turns on from the state SIGN_HOST sends after a pool buy (card signpage-state-holdings), with
// no made-up account: sell-positions/live-state.json is the signing page's own answer, recorded and held equal to it by
// packages/signpage/test/positions.test.ts (the page's positions pass over a fake chain, W of the all-zero test seed).
// Red before that card: the page sent positions: [] on every signed-in state, so no row, no Sell (app-a2-e2e run 5).
//   node --test test/sell-live.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { heldOf, NO_DATA, portfolio } from "../src/screens/portfolio/model.ts";
import { sellAmount } from "../src/screens/positions/model.ts";

const STATE = JSON.parse(readFileSync(new URL("./sell-positions/live-state.json", import.meta.url), "utf8")) as SignpageState;
const snap = (state: SignpageState): SignpageClientSnapshot => ({ status: "ready", release: "signpage-v1", state, stale: false });

test("the page's state after a pool buy: Portfolio draws the position and the Sell side has it to sell, in whole and in part", () => {
  const [p] = STATE.positions;
  assert.ok(p, "the page sends the position");
  const rows = portfolio(snap(STATE), NO_DATA, Date.now()).rows;
  const row = heldOf(rows, p.chain, p.token);
  assert.ok(row, "Sell turns on");
  assert.equal(row.units, p.amount);
  assert.equal(row.decimals, p.decimals);
  assert.equal(row.cost, 0n, "no buy record: cost unknown");
  assert.equal(sellAmount(row.units, 10_000, row.decimals), p.amount, "100% sells what W holds");
  assert.equal(sellAmount(row.units, 5_000, row.decimals), "540795.106782", "50% at the token's own decimals");
});

test("the page's state before the card, positions: [] after the same buy: no row and no Sell side", () => {
  const before = { ...STATE, positions: [] };
  const [p] = STATE.positions;
  assert.equal(heldOf(portfolio(snap(before), NO_DATA, Date.now()).rows, p!.chain, p!.token), null);
});
