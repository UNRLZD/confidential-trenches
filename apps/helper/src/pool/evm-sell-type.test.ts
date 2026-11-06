// node --test apps/helper/src/pool/evm-sell-type.test.ts: the helper's Sell is the contract's, as it is in this tree
// (card helper-sell-fee-recipient, review Low 3). fixtures/sell-cast.json is made from SellDelegate.sol at one commit;
// this test reads contracts/pool-evm/src/SellDelegate.sol as checked out, so a change to the contract's Sell that the
// helper does not follow fails here: its SELL_TYPEHASH string must be evm.ts SELL_TYPE_STRING, and its struct's field
// types, in order, the tuple of evm.ts SELL_SIGNATURE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SELL_SIGNATURE, SELL_TYPE_STRING } from "./evm.ts";

const SOL = new URL("../../../../contracts/pool-evm/src/SellDelegate.sol", import.meta.url);

test("SellDelegate.sol's Sell type string is the helper's SELL_TYPE_STRING, and its struct's field types are SELL_SIGNATURE's tuple", () => {
  const sol = readFileSync(SOL, "utf8");
  const typed = [...sol.matchAll(/'(Sell\([^']*\))'/g)].map((m) => m[1]);
  assert.equal(typed.length, 1, "one Sell type string in SellDelegate.sol");
  assert.equal(SELL_TYPE_STRING, typed[0], "SELL_TYPE_STRING is the contract's SELL_TYPEHASH string");
  const struct = /struct Sell \{([^}]*)\}/.exec(sol)?.[1];
  assert.ok(struct, "SellDelegate.sol has struct Sell");
  const fields = struct.split(";").map((f) => f.trim().split(/\s+/)).filter((f) => f.length === 2);
  assert.equal(fields.map(([t, n]) => `${t} ${n}`).join(","), typed[0]!.slice(5, -1), "the struct's fields are the type string's, in order");
  assert.equal(SELL_SIGNATURE, `sell((${fields.map(([t]) => t).join(",")}),uint256,bytes)`, "SELL_SIGNATURE's tuple is the struct's field types");
});
