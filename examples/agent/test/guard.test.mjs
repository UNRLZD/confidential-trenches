// node --test examples/agent/test/guard.test.mjs: the agent taps Confirm only when no amount on the sheet is above --max.
import assert from "node:assert/strict";
import { test } from "node:test";
import { amountOf, confirmOk } from "../guard.mjs";

const sheet = (amount) => ({ lines: [["Chain", "near"], ["Token", "touched.tkn.near"], ["Amount", amount], ["Slippage", "3%"]] });

test("amounts read from the sheet's values", () => {
  assert.equal(amountOf("5 USDC"), 5);
  assert.equal(amountOf("$1,250.50"), 1250.5);
  assert.equal(amountOf("All"), null);
});

test("an amount at or under --max: Confirm", () => {
  assert.equal(confirmOk(sheet("5 USDC"), { max: 6 }).ok, true);
  assert.equal(confirmOk(sheet("6"), { max: 6 }).ok, true);
  assert.equal(confirmOk({ lines: [["Share", "100%"]] }, { max: 6 }).ok, true);
});

test("an amount above --max: not confirmed", () => {
  assert.match(confirmOk(sheet("7 USDC"), { max: 6 }).why, /Amount 7 USDC is above --max 6/);
});

test("All is read as the balance it sends", () => {
  assert.equal(confirmOk(sheet("All"), { max: 6, balance: "5.5" }).ok, true);
  assert.match(confirmOk(sheet("All"), { max: 6, balance: "9" }).why, /above --max 6/);
  assert.match(confirmOk(sheet("All"), { max: 6 }).why, /not an amount/);
});
