// withdraw.open and pool.withdraw with what the app's Withdraw sheet took (card withdraw-address-in-the-app, owner
// 14 Nov 12:22Z): `to` with exactly one of `amount` and `max`, or none of the three (the typed form). A `from_id` (the
// held deposit's way out) takes none of them. Anything else is refused before the page reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNPAGE_PARAM_SCHEMAS } from "../src/signpage/schema.ts";

const P = SIGNPAGE_PARAM_SCHEMAS as Record<string, (v: unknown) => boolean>;
const RK = { return_key: "withdraw" };

test("withdraw.open: none of to, amount, max opens the typed form, as before", () => {
  assert.equal(P["withdraw.open"]!({ ...RK }), true);
  assert.equal(P["withdraw.open"]!({ ...RK, from_id: "op-1" }), true);
});

test("withdraw.open: to with an amount, or to with max", () => {
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near", amount: "12.5" }), true);
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near", max: true }), true);
});

test("withdraw.open: refused half-given, doubly given, a bad amount, max not true, or with from_id", () => {
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near" }), false, "to alone");
  assert.equal(P["withdraw.open"]!({ ...RK, amount: "1" }), false, "amount alone");
  assert.equal(P["withdraw.open"]!({ ...RK, max: true }), false, "max alone");
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near", amount: "1", max: true }), false, "amount and max");
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near", amount: "-1" }), false, "not a decimal");
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near", max: false }), false, "max: false");
  assert.equal(P["withdraw.open"]!({ ...RK, to: "", amount: "1" }), false, "an empty to");
  assert.equal(P["withdraw.open"]!({ ...RK, from_id: "op-1", to: "alice.near", amount: "1" }), false, "from_id with to");
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near", amount: "1", chain: "near" }), false, "an extra field");
});

// card cash-withdraw-in-app-to-any-chain: Cash's dest, exactly as pool.withdraw's: an exit chain, only with `to`
test("withdraw.open: dest, an exit chain, only with to", () => {
  assert.equal(P["withdraw.open"]!({ ...RK, to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "12.5", dest: "solana" }), true);
  assert.equal(P["withdraw.open"]!({ ...RK, to: "0x52908400098527886E0F7030069857D2E4169EE7", max: true, dest: "base" }), true);
  assert.equal(P["withdraw.open"]!({ ...RK, to: "alice.near", amount: "1", dest: "near" }), true);
  assert.equal(P["withdraw.open"]!({ ...RK, dest: "solana" }), false, "dest alone");
  assert.equal(P["withdraw.open"]!({ ...RK, from_id: "op-1", dest: "solana" }), false, "dest with from_id");
  assert.equal(P["withdraw.open"]!({ ...RK, to: "x", amount: "1", dest: "ethereum" }), false, "not an exit chain");
});

test("the chains Cash reaches: NEAR first, each an exit chain", async () => {
  const { CASH_WITHDRAW_DESTS } = await import("../src/index.ts");
  assert.equal(CASH_WITHDRAW_DESTS[0], "near");
  for (const c of CASH_WITHDRAW_DESTS) assert.ok(["solana", "base", "robinhood", "near"].includes(c), c);
  assert.ok(Object.isFrozen(CASH_WITHDRAW_DESTS));
});

test("pool.withdraw: the chain, with none of to, amount, max or to with exactly one", () => {
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana" }), true);
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "0.05" }), true);
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "base", to: "0x52908400098527886E0F7030069857D2E4169EE7", max: true }), true);
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", to: "x" }), false, "to alone");
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", amount: "1" }), false, "amount alone");
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", to: "x", amount: "1", max: true }), false, "amount and max");
  assert.equal(P["pool.withdraw"]!({ ...RK, to: "x", amount: "1" }), false, "no chain");
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", to: "x", amount: "1", from_id: "op-1" }), false, "from_id is not pool.withdraw's");
});

test("pool.withdraw: dest, an exit chain, only with to", () => {
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", to: "alice.near", amount: "0.05", dest: "near" }), true);
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "base", to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", max: true, dest: "solana" }), true);
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", dest: "near" }), false, "dest alone");
  assert.equal(P["pool.withdraw"]!({ ...RK, chain: "solana", to: "x", amount: "1", dest: "ethereum" }), false, "not an exit chain");
});
