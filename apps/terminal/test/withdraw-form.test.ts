// The app's Withdraw form (card withdraw-address-in-the-app, owner 14 Nov 12:22Z picked A): the amount and the address
// typed in the app, the Withdraw on only for an address of the place's chain and an amount the place holds, and the tap's
// request exactly the four shapes the kit's schema is held to take (packages/kit/test/withdraw-given.test.ts: withdraw.open
// with to and amount or max, pool.withdraw with the chain and to and amount or max), so the signing page draws its Confirm.
//   node --test apps/terminal/test/withdraw-form.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WithdrawPlace } from "../src/screens/withdraw/target.ts";
import { addressFits, checkWithdraw, units, withdrawHop } from "../src/screens/withdraw/withdraw-form.ts";

const CASH: WithdrawPlace = { kind: "withdraw.open", chain: "near", balance: "62.34", symbol: "USDC" };
const SOL: WithdrawPlace = { kind: "pool.withdraw", chain: "solana", balance: "0.2522", symbol: "SOL" };
const BASE: WithdrawPlace = { kind: "pool.withdraw", chain: "base", balance: "0.0041", symbol: "ETH" };
const SOL_KEY = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";

test("an address of the place's chain only: a NEAR account for Cash, a Solana key for the Solana pool, 0x and 40 hex on Base", () => {
  for (const to of ["alice.near", " alice.near ", "a1-b_c.tg", "f".repeat(64), EVM.toLowerCase()]) assert.equal(addressFits(CASH, to), true, to);
  for (const to of ["Alice.near", "a", SOL_KEY, "alice..near", "x".repeat(65)]) assert.equal(addressFits(CASH, to), false, to);
  assert.equal(addressFits(SOL, SOL_KEY), true);
  assert.equal(addressFits(SOL, ` ${SOL_KEY}\n`), true, "a paste's ends");
  for (const to of [EVM, "alice.near", `${SOL_KEY.slice(0, -1)}0`, SOL_KEY.slice(0, 40), "11111111111111111111111111111111"]) assert.equal(addressFits(SOL, to), to === "11111111111111111111111111111111", to);
  assert.equal(addressFits(BASE, EVM), true);
  for (const to of [SOL_KEY, "alice.near", `${EVM}0`, EVM.slice(0, 41)]) assert.equal(addressFits(BASE, to), false, to);
});

test("an amount above zero, no finer than the asset, at most what the place holds; Max is the place's balance", () => {
  assert.equal(units("0.2522", 9), 252_200_000n);
  assert.equal(units("1.0000001", 6), null, "finer than USDC");
  for (const a of ["1,5", "-1", "1e3", ".5", "5.", "abc"]) assert.equal(units(a, 9), null, a);
  assert.deepEqual(checkWithdraw(SOL, "", "", false), { amount: "empty", address: "empty", ready: false });
  assert.deepEqual(checkWithdraw(SOL, "0.05", SOL_KEY, false), { amount: "ok", address: "ok", ready: true });
  assert.equal(checkWithdraw(SOL, "0.2522", SOL_KEY, false).ready, true, "all of it");
  assert.equal(checkWithdraw(SOL, "0.25220001", SOL_KEY, false).amount, "bad", "above the balance");
  assert.equal(checkWithdraw(SOL, "0", SOL_KEY, false).amount, "bad");
  assert.equal(checkWithdraw(SOL, "0.05", EVM, false).address, "bad", "another chain's address");
  assert.deepEqual(checkWithdraw(SOL, "", SOL_KEY, true), { amount: "ok", address: "ok", ready: true });
  assert.equal(checkWithdraw({ ...SOL, balance: "0" }, "", SOL_KEY, true).amount, "bad", "Max of nothing");
});

test("the tap's request: the place's kind with the address and the amount, or Max, in the kit test's shapes", () => {
  const cases = [
    [withdrawHop(CASH, " 12.5 ", " alice.near ", false), { kind: "withdraw.open", params: { to: "alice.near", amount: "12.5" } }],
    [withdrawHop(CASH, "", "alice.near", true), { kind: "withdraw.open", params: { to: "alice.near", max: true } }],
    [withdrawHop(SOL, "0.05", SOL_KEY, false), { kind: "pool.withdraw", params: { chain: "solana", to: SOL_KEY, amount: "0.05" } }],
    [withdrawHop(BASE, "", EVM, true), { kind: "pool.withdraw", params: { chain: "base", to: EVM, max: true } }],
  ] as const;
  for (const [got, want] of cases) assert.deepEqual(got, want);
});
