// A position's decimals (card signpage-state-holdings): an additive optional field on SignpageState.positions, the
// token's own decimals (an SPL mint's and an ERC-20's are a u8), so an app sizes a partial sell in the token's base
// units instead of guessing them from the amount string. Absent is still valid (a page of an earlier release sends
// none); a value that is not a u8 is refused, and so is an amount with more fraction digits than the decimals named.
//   node --test test/position-decimals.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "@blindfill/kit";
import { SIGNPAGE_RESULT_SCHEMAS } from "../src/signpage/schema.ts";

const BASE: SignpageState = {
  release: "sp-1",
  api: 1,
  signed_in: true,
  code_saved: true,
  vault_balance: "0",
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
};
type Position = SignpageState["positions"][number];
const POS: Position = { chain: "solana", token: "Mint1111", amount: "1234.567891", cost: "12.5", wallets: ["W1111"] };
const ok = (p: unknown): boolean => SIGNPAGE_RESULT_SCHEMAS.state({ ...BASE, positions: [p] });

test("a position with no decimals is still a valid state", () => {
  assert.equal(ok(POS), true);
});

test("a position with its token's decimals is valid, 0 and 255 included", () => {
  assert.equal(ok({ ...POS, decimals: 6 }), true);
  assert.equal(ok({ ...POS, amount: "1234", decimals: 0 }), true);
  assert.equal(ok({ ...POS, decimals: 255 }), true);
  const typed: Position = { ...POS, decimals: 9 };
  assert.equal(ok(typed), true);
});

test("decimals of the wrong type or out of a u8's range are refused", () => {
  for (const decimals of ["6", 6.5, -1, 256, null, true, Number.NaN, Infinity, 2 ** 53])
    assert.equal(ok({ ...POS, decimals }), false, String(decimals));
});

test("an amount with more fraction digits than the decimals named is refused", () => {
  assert.equal(ok({ ...POS, decimals: 5 }), false, "1234.567891 has 6 fraction digits");
  assert.equal(ok({ ...POS, amount: "1.5", decimals: 0 }), false);
});
