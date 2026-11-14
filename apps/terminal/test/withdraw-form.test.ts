// The app's Withdraw form (card withdraw-address-in-the-app, owner 14 Nov 12:22Z picked A): the amount and the address
// typed in the app, the Withdraw on only for an address of the place's chain and an amount the place holds, and the tap's
// request exactly the four shapes the kit's schema is held to take (packages/kit/test/withdraw-given.test.ts: withdraw.open
// with to and amount or max, pool.withdraw with the chain and to and amount or max), so the signing page draws its Confirm.
// Card withdraw-in-app-to-any-chain: a pool's money arrives on any chain (the To row), the tap's pool.withdraw carries it as
// `dest` when it is not the pool's own (the kit's pool.withdraw takes dest with to), and the address is checked on the
// chain the money arrives on, never the place's own. Card cash-withdraw-in-app-to-any-chain: Cash arrives on each chain of
// the kit's CASH_WITHDRAW_DESTS, the one list SIGN_HOST's Cash form sends to, and the tap's withdraw.open carries `dest`
// when it is not NEAR (the kit's withdraw.open takes dest with to, as pool.withdraw does).
//   node --test apps/terminal/test/withdraw-form.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { CASH_WITHDRAW_DESTS } from "@blindfill/kit";
import type { WithdrawPlace } from "../src/screens/withdraw/target.ts";
import { addressFits, arrivals, checkWithdraw, units, withdrawHop } from "../src/screens/withdraw/withdraw-form.ts";

const CASH: WithdrawPlace = { kind: "withdraw.open", chain: "near", balance: "62.34", symbol: "USDC" };
const SOL: WithdrawPlace = { kind: "pool.withdraw", chain: "solana", balance: "0.2522", symbol: "SOL" };
const BASE: WithdrawPlace = { kind: "pool.withdraw", chain: "base", balance: "0.0041", symbol: "ETH" };
const HOOD: WithdrawPlace = { kind: "pool.withdraw", chain: "robinhood", balance: "0.0123", symbol: "ETH" };
const SOL_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";

test("an address of the arrival chain only: a NEAR account on NEAR, a Solana key on Solana, 0x and 40 hex on Base and Robinhood", () => {
  for (const to of ["alice.near", " alice.near ", "a1-b_c.tg", "f".repeat(64), EVM.toLowerCase()]) assert.equal(addressFits("near", to), true, to);
  for (const to of ["Alice.near", "a", SOL_TO, "alice..near", "x".repeat(65)]) assert.equal(addressFits("near", to), false, to);
  assert.equal(addressFits("solana", SOL_TO), true);
  assert.equal(addressFits("solana", ` ${SOL_TO}\n`), true, "a paste's ends");
  for (const to of [EVM, "alice.near", `${SOL_TO.slice(0, -1)}0`, SOL_TO.slice(0, 40), "11111111111111111111111111111111"]) assert.equal(addressFits("solana", to), to === "11111111111111111111111111111111", to);
  for (const c of ["base", "robinhood"] as const) {
    assert.equal(addressFits(c, EVM), true, c);
    for (const to of [SOL_TO, "alice.near", `${EVM}0`, EVM.slice(0, 41)]) assert.equal(addressFits(c, to), false, `${c} ${to}`);
  }
});

test("where each place's money can arrive: a pool on every chain, in the deposit's To order; Cash on the chains SIGN_HOST sends it to", () => {
  assert.equal(arrivals(CASH), CASH_WITHDRAW_DESTS, "the kit's one list, never a copy that can drift from the page's");
  assert.equal(arrivals(CASH)[0], "near");
  for (const p of [SOL, BASE, HOOD]) assert.deepEqual(arrivals(p), ["near", "solana", "base", "robinhood"], p.chain);
});

test("the address is checked on the chain the money arrives on, never the place's own (a Robinhood pool to Solana)", () => {
  assert.deepEqual(checkWithdraw(HOOD, "solana", "0.001", SOL_TO, false), { amount: "ok", address: "ok", ready: true });
  assert.equal(checkWithdraw(HOOD, "solana", "0.001", EVM, false).address, "bad", "the pool's own chain's address, sent to Solana");
  assert.equal(checkWithdraw(HOOD, "robinhood", "0.001", EVM, false).ready, true);
  assert.equal(checkWithdraw(HOOD, "robinhood", "0.001", SOL_TO, false).address, "bad");
  assert.equal(checkWithdraw(SOL, "base", "0.05", EVM, false).ready, true);
  assert.equal(checkWithdraw(SOL, "near", "0.05", "alice.near", false).ready, true);
  for (const c of ["solana", "base", "robinhood"] as const) {
    const to = c === "solana" ? SOL_TO : EVM;
    assert.equal(checkWithdraw(CASH, c, "1", to, false).ready, (CASH_WITHDRAW_DESTS as readonly string[]).includes(c), `Cash to ${c} only when the page sends it there`);
  }
});

test("an amount above zero, no finer than the asset, at most what the place holds; Max is the place's balance", () => {
  assert.equal(units("0.2522", 9), 252_200_000n);
  assert.equal(units("1.0000001", 6), null, "finer than USDC");
  for (const a of ["1,5", "-1", "1e3", ".5", "5.", "abc"]) assert.equal(units(a, 9), null, a);
  assert.deepEqual(checkWithdraw(SOL, "solana", "", "", false), { amount: "empty", address: "empty", ready: false });
  assert.deepEqual(checkWithdraw(SOL, "solana", "0.05", SOL_TO, false), { amount: "ok", address: "ok", ready: true });
  assert.equal(checkWithdraw(SOL, "solana", "0.2522", SOL_TO, false).ready, true, "all of it");
  assert.equal(checkWithdraw(SOL, "solana", "0.25220001", SOL_TO, false).amount, "bad", "above the balance");
  assert.equal(checkWithdraw(SOL, "solana", "0", SOL_TO, false).amount, "bad");
  assert.equal(checkWithdraw(SOL, "solana", "0.05", EVM, false).address, "bad", "another chain's address");
  assert.deepEqual(checkWithdraw(SOL, "solana", "", SOL_TO, true), { amount: "ok", address: "ok", ready: true });
  assert.equal(checkWithdraw({ ...SOL, balance: "0" }, "solana", "", SOL_TO, true).amount, "bad", "Max of nothing");
});

test("the tap's request: the place's kind with the address and the amount, or Max, in the kit test's shapes", () => {
  const cases = [
    [withdrawHop(CASH, "near", " 12.5 ", " alice.near ", false), { kind: "withdraw.open", params: { to: "alice.near", amount: "12.5" } }],
    [withdrawHop(CASH, "near", "", "alice.near", true), { kind: "withdraw.open", params: { to: "alice.near", max: true } }],
    [withdrawHop(SOL, "solana", "0.05", SOL_TO, false), { kind: "pool.withdraw", params: { chain: "solana", to: SOL_TO, amount: "0.05" } }],
    [withdrawHop(BASE, "base", "", EVM, true), { kind: "pool.withdraw", params: { chain: "base", to: EVM, max: true } }],
    // another chain: dest, the chain the money arrives on (the kit's pool.withdraw takes it only with to)
    [withdrawHop(HOOD, "solana", "0.001", SOL_TO, false), { kind: "pool.withdraw", params: { chain: "robinhood", to: SOL_TO, amount: "0.001", dest: "solana" } }],
    [withdrawHop(SOL, "near", "", "alice.near", true), { kind: "pool.withdraw", params: { chain: "solana", to: "alice.near", max: true, dest: "near" } }],
    // Cash to another chain: dest, as a pool's (the kit's withdraw.open takes it only with to); on NEAR none, as before
    [withdrawHop(CASH, "solana", "12.5", SOL_TO, false), { kind: "withdraw.open", params: { to: SOL_TO, amount: "12.5", dest: "solana" } }],
    [withdrawHop(CASH, "base", "", EVM, true), { kind: "withdraw.open", params: { to: EVM, max: true, dest: "base" } }],
  ] as const;
  for (const [got, want] of cases) assert.deepEqual(got, want);
});
