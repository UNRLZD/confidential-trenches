// node --test contracts/pool-evm/test/sell-type-helper.test.mjs: the helper's sell sender reads and hashes this
// contract's Sell as it is in this tree (card helper-sell-fee-recipient, review Low 3). The helper's cast fixture
// (apps/helper/src/pool/fixtures/sell-cast.json) is made from SellDelegate.sol at one commit; this test reads
// src/SellDelegate.sol as checked out and apps/helper/src/pool/evm.ts as text, so a change to the Sell on either side
// that the other does not follow fails here: the SELL_TYPEHASH string must be the one evm.ts SELL_TYPE hashes, and struct
// Sell's field types, in order, the tuple of evm.ts SELL_SIGNATURE. It lives on the contract's side because a file
// outside packages/ and contracts/ may not reach them (scripts/ci/kit-reach.mjs); here it runs with the pool's tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOL = readFileSync(new URL("../src/SellDelegate.sol", import.meta.url), "utf8");
const HELPER = readFileSync(new URL("../../../apps/helper/src/pool/evm.ts", import.meta.url), "utf8");
const constOf = (name) => {
  const m = [...HELPER.matchAll(new RegExp(`^export const ${name} = "([^"]*)";$`, "gm"))];
  assert.equal(m.length, 1, `evm.ts declares ${name} once as a string`);
  return m[0][1];
};

test("SellDelegate.sol's Sell type string is the one the helper's SELL_TYPE hashes, and its struct's field types are the helper's SELL_SIGNATURE tuple", () => {
  const typed = [...SOL.matchAll(/'(Sell\([^']*\))'/g)].map((m) => m[1]);
  assert.equal(typed.length, 1, "one Sell type string in SellDelegate.sol");
  const hashed = [...HELPER.matchAll(/^const SELL_TYPE = keccak_256\(utf8\("([^"]*)"\)\);$/gm)];
  assert.equal(hashed.length, 1, "evm.ts declares SELL_TYPE once, as the hash of a string literal");
  assert.equal(hashed[0][1], typed[0], "SELL_TYPE hashes the contract's SELL_TYPEHASH string");
  const struct = /struct Sell \{([^}]*)\}/.exec(SOL)?.[1];
  assert.ok(struct, "SellDelegate.sol has struct Sell");
  const fields = struct.split(";").map((f) => f.trim().split(/\s+/)).filter((f) => f.length === 2);
  assert.equal(fields.map(([t, n]) => `${t} ${n}`).join(","), typed[0].slice(5, -1), "the struct's fields are the type string's, in order");
  assert.equal(constOf("SELL_SIGNATURE"), `sell((${fields.map(([t]) => t).join(",")}),uint256,bytes)`, "SELL_SIGNATURE's tuple is the struct's field types");
});
