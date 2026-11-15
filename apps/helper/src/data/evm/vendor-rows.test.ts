// card evm-tape-rows-exact: a vendor's trade row made exact from its transaction's receipt (vendor-rows.ts), on
// receipts recorded on mainnet (fixtures/vendor-rows-receipts.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { exactRow, receiptFacts, vendorUnits } from "./vendor-rows.ts";
import { VENUES } from "./swaps.ts";

type Row = { tx: string; side: string; amt: string; vendorTrader: string };
const R = JSON.parse(readFileSync(new URL("./fixtures/vendor-rows-receipts.json", import.meta.url), "utf8")) as {
  base: { coin: string; decimals: number; rows: Row[]; receipts: Record<string, unknown> };
  robinhood: { coin: string; decimals: number; rows: Row[]; receipts: Record<string, unknown> };
};

test("Base tx 0xfa31c53f (live runs 43689567273, 43689580591): the vendor's 4029.69636401198 is served as the 4029696364011983028639 its buyer got, the buyer the transaction's sender", () => {
  const { coin: token, decimals, rows, receipts } = R.base;
  const f = receiptFacts(receipts[rows[0]!.tx], rows[0]!.tx, token, VENUES.base.poolManager);
  assert.ok(f !== null);
  assert.deepEqual(exactRow(rows[0]!.amt, decimals, f), { amt: "4029.696364011983028639", trader: "0x89cdaf64636cc51337b306f38ce8bd8abd4df6f7" });
});

test("Robinhood bundles (v0.7 and v0.6 EntryPoints): each row names the user operation's account, never the bundler, and the token's exact move", () => {
  const { coin: token, decimals, rows, receipts } = R.robinhood;
  const want = [
    { amt: "458642.37766139650870616", trader: "0xd22e3afceed111eef9336ea0fe7533566d55e7b7" },
    { amt: "82417.41435946235", trader: "0x596c04b0d855049b2c45618099ff36de36214112" },
  ];
  rows.forEach((r, i) => {
    const f = receiptFacts(receipts[r.tx], r.tx, token, VENUES.robinhood.poolManager);
    assert.ok(f !== null, r.tx);
    const got = exactRow(r.amt, decimals, f);
    assert.deepEqual(got, want[i], r.tx);
    assert.notEqual(got!.trader, r.vendorTrader, "the bundler is never the trader");
  });
});

test("a row no move of the token in its receipt matches is no trade the chain shows: null; so is a receipt of another transaction or a reverted one", () => {
  const { coin: token, decimals, rows, receipts } = R.base;
  const tx = rows[0]!.tx;
  const f = receiptFacts(receipts[tx], tx, token, VENUES.base.poolManager)!;
  // a float off in its 11th significant digit (1e-11 of it), and one of another token's size
  assert.equal(exactRow("4029.69636411198", decimals, f), null);
  assert.equal(exactRow("17949", decimals, f), null);
  assert.equal(exactRow("-1", decimals, f), null);
  assert.equal(receiptFacts(receipts[tx], `0x${"ab".repeat(32)}`, token, VENUES.base.poolManager), null);
  assert.equal(receiptFacts({ ...(receipts[tx] as object), status: "0x0" }, tx, token, VENUES.base.poolManager), null);
  assert.equal(receiptFacts({ ...(receipts[tx] as object), logs: [{ logIndex: "0x1", topics: "x", data: "0x" }] }, tx, token, VENUES.base.poolManager), null);
});

test("two different moves that both match the vendor's float name no amount (never a guess)", () => {
  const traders = { from: `0x${"11".repeat(20)}` };
  assert.equal(exactRow("1.5", 18, { traders, moves: [{ index: 1, raw: "1500000000000000000", tier: 1 }, { index: 2, raw: "1500000000000000001", tier: 1 }] }), null);
  assert.deepEqual(exactRow("1.5", 18, { traders, moves: [{ index: 1, raw: "1500000000000000001", tier: 1 }, { index: 2, raw: "1500000000000000001", tier: 1 }] }), { amt: "1.500000000000000001", trader: traders.from });
});

test("vendorUnits: decimal text to the token's units, digits past its decimals dropped", () => {
  assert.equal(vendorUnits("4029.69636401198", 18), 4029696364011980000000n);
  assert.equal(vendorUnits("86.710609123", 6), 86710609n);
  assert.equal(vendorUnits("0", 6), null);
  assert.equal(vendorUnits("1e5", 6), null);
});
