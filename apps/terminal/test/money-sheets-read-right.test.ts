// node --test apps/terminal/test/money-sheets-read-right.test.ts (card app-money-sheets-read-right; the QA walk of the
// live app, 16 Nov 18:00Z):
//   - item 7: a $0 account that types an amount is offered Deposit by the trade box's main button (trade/model.ts
//     offersDeposit), and never while signed out, with money, with nothing typed, while a tap runs or money is coming;
//   - item 13: the deposit sheet's Min draws at most 2 decimals for USDC ("Min 1.015576 USDC" was drawn), rounded up so
//     the minimum drawn is never under the real one; another coin keeps 2 significant digits (deposit/model.ts minShown).
import assert from "node:assert/strict";
import { test } from "node:test";
import { lessThan, minShown } from "../src/screens/deposit/model.ts";
import { offersDeposit } from "../src/screens/trade/model.ts";

const zero = { signedIn: true, running: false, coming: false, amount: 500n, total: 0n };

test("item 7: a $0 account that typed an amount is offered Deposit", () => {
  assert.equal(offersDeposit(zero), true);
});

test("item 7: no Deposit offer signed out, before the balance is read, with money, with no amount, mid-tap or with money coming", () => {
  assert.equal(offersDeposit({ ...zero, signedIn: false }), false);
  assert.equal(offersDeposit({ ...zero, total: null }), false, "the balance not read yet");
  assert.equal(offersDeposit({ ...zero, total: 1n }), false, "a cent anywhere in the account: Buy and its Max speak");
  assert.equal(offersDeposit({ ...zero, amount: null }), false);
  assert.equal(offersDeposit({ ...zero, amount: 0n }), false);
  assert.equal(offersDeposit({ ...zero, running: true }), false);
  assert.equal(offersDeposit({ ...zero, coming: true }), false, "a fresh deposit on its way: Buy's busy look stands");
});

test("item 13: USDC's Min at most 2 decimals, rounded up", () => {
  assert.equal(minShown("1.015576", "USDC"), "1.02");
  assert.equal(minShown("1.015665", "USDC"), "1.02");
  assert.equal(minShown("1.01", "USDC"), "1.01");
  assert.equal(minShown("1.010000", "USDC"), "1.01");
  assert.equal(minShown("1.000001", "USDC"), "1.01");
  assert.equal(minShown("1.5", "USDC"), "1.5");
  assert.equal(minShown("2", "USDC"), "2");
  assert.equal(minShown("1.999", "USDC"), "2");
  assert.equal(minShown("9.995", "USDC"), "10");
  assert.equal(minShown("0.004", "USDC"), "0.01");
});

test("item 13: another coin keeps 2 significant digits, rounded up", () => {
  assert.equal(minShown("0.000523", "ETH"), "0.00053");
  assert.equal(minShown("0.0021", "SOL"), "0.0021");
  assert.equal(minShown("0.015001", "SOL"), "0.016");
  assert.equal(minShown("2.1", "NEAR"), "2.1");
  assert.equal(minShown("2.105", "NEAR"), "2.11");
});

test("item 13: the Min drawn is never under the real one, and at most a cent over for USDC", () => {
  for (let n = 1_000_000; n < 1_100_000; n += 977) {
    const real = `${Math.floor(n / 1e6)}.${String(n % 1e6).padStart(6, "0")}`;
    const shown = minShown(real, "USDC");
    assert.ok((shown.split(".")[1] ?? "").length <= 2, `${real} drawn ${shown}`);
    assert.ok(!lessThan(shown, real), `${real} drawn ${shown}, under it`);
    const cents = BigInt(shown.replace(".", "").padEnd(shown.includes(".") ? shown.split(".")[0]!.length + 2 : shown.length + 2, "0"));
    assert.ok(cents * 10_000n - BigInt(n) < 10_000n, `${real} drawn ${shown}, a cent or more over`);
  }
});
