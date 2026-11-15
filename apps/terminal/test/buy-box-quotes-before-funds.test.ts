// Card buy-box-quotes-before-funds: a fresh account with $0 sees its Max ($0.00) in the buy box, so a grey Buy has its
// reason. The signing page lists such an account's pools with a balance of "0" and no ready or tap_max (its proof
// queue opens at a first landing, none has come), as a live read of release 156 on 15 Nov 20:23Z gave:
//   [{"chain":"solana","asset":"SOL","balance":"0","price":{...}},{"chain":"base","asset":"ETH","balance":"0",...},...]
// so Max had nothing to read and the box drew no Max line at all. Bal is $0 there, and a tap spends no more than Bal.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { amountOk, cashMax, poolMax, poolView, presetOn, spendSoon, tradeBal } from "../src/screens/trade/model.ts";

type Pool = NonNullable<SignpageState["pools"]>[number];
// Pyth SOL/USD and ETH/USD as that read gave them
const SOL = { price: 7_137_485_968n, expo: -8, decimals: 9 };
const ETH = { price: 182_109_000_000n, expo: -8, decimals: 18 };
const FRESH: Pool[] = [
  { chain: "solana", asset: "SOL", balance: "0" },
  { chain: "base", asset: "ETH", balance: "0" },
  { chain: "robinhood", asset: "ETH", balance: "0" },
];

test("a fresh account's pool chain: Bal $0 and Max $0.00, not no Max; a $5 amount is over it and Buy stays off", () => {
  for (const [chain, price] of [["solana", SOL], ["base", ETH], ["robinhood", ETH]] as const) {
    const pv = poolView(FRESH, chain, price);
    assert.ok(pv, chain);
    assert.equal(pv.tapMax, null, `${chain}: the page sends no tap_max`);
    const bal = tradeBal(true, pv, 0n, 0n, 0n).cents;
    assert.equal(bal, 0n, chain);
    const max = poolMax(cashMax(FRESH, chain, null, price), pv.tapMax, bal);
    assert.equal(max, 0n, `${chain}: Max is $0.00`);
    // money is not on its way (nothing to make spendable), so the Max line shows, not Buy's busy look
    assert.equal(spendSoon(FRESH, chain, max), false, chain);
    assert.equal(amountOk(500n, max, bal), false, chain);
    assert.equal(presetOn(1_000n, max, bal, false), false, chain);
  }
});

test("Max is the page's own wherever it prices one; no $0 guess while Bal is not $0 or not read", () => {
  assert.equal(poolMax(4_650n, 31n, 7_000n), 4_650n, "with_cash first");
  assert.equal(poolMax(null, 31n, 7_000n), 31n, "one tap's own");
  assert.equal(poolMax(null, 0n, 0n), 0n);
  // money on the pool or in Cash that no tap is priced for yet (the seconds after a load, a proof making): no Max line
  assert.equal(poolMax(null, null, 93n), null);
  assert.equal(poolMax(null, null, null), null, "Bal not read");
});
