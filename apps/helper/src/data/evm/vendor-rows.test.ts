// card evm-tape-rows-exact: a vendor's trade row made exact from its transaction's receipt (vendor-rows.ts), on
// receipts recorded on mainnet (fixtures/vendor-rows-receipts.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { exactRow, receiptFacts, vendorUnits } from "./vendor-rows.ts";
import { SWAP_TOPICS, VENUES } from "./swaps.ts";

type Row = { tx: string; side: string; amt: string; vendorTrader: string };
const R = JSON.parse(readFileSync(new URL("./fixtures/vendor-rows-receipts.json", import.meta.url), "utf8")) as {
  base: { coin: string; decimals: number; rows: Row[]; receipts: Record<string, unknown> };
  robinhood: { coin: string; decimals: number; rows: Row[]; receipts: Record<string, unknown> };
  hook: { coin: string; decimals: number; rows: Row[]; receipts: Record<string, unknown> };
  hookOwn: { coin: string; decimals: number; rows: Row[]; receipts: Record<string, unknown> };
};

test("Base tx 0xfa31c53f (live runs 43689567273, 43689580591): the vendor's 4029.69636401198 is served as the 4029696364011983028639 its buyer got, the buyer the transaction's sender", () => {
  const { coin: token, decimals, rows, receipts } = R.base;
  const f = receiptFacts(receipts[rows[0]!.tx], rows[0]!.tx, token, VENUES.base.poolManager, SWAP_TOPICS);
  assert.ok(f !== null);
  assert.deepEqual(exactRow("b", rows[0]!.amt, decimals, f), { amt: "4029.696364011983028639", trader: "0x89cdaf64636cc51337b306f38ce8bd8abd4df6f7" });
});

test("Robinhood bundles (v0.7 and v0.6 EntryPoints): each row names the user operation's account, never the bundler, and the token's exact move", () => {
  const { coin: token, decimals, rows, receipts } = R.robinhood;
  const want = [
    { amt: "458642.37766139650870616", trader: "0xd22e3afceed111eef9336ea0fe7533566d55e7b7" },
    { amt: "82417.41435946235", trader: "0x596c04b0d855049b2c45618099ff36de36214112" },
  ];
  rows.forEach((r, i) => {
    const f = receiptFacts(receipts[r.tx], r.tx, token, VENUES.robinhood.poolManager, SWAP_TOPICS);
    assert.ok(f !== null, r.tx);
    const got = exactRow(r.side as "b" | "s", r.amt, decimals, f);
    assert.deepEqual(got, want[i], r.tx);
    assert.notEqual(got!.trader, r.vendorTrader, "the bundler is never the trader");
  });
});

test("a row no move of the token in its receipt matches is no trade the chain shows: null; so is a receipt of another transaction or a reverted one", () => {
  const { coin: token, decimals, rows, receipts } = R.base;
  const tx = rows[0]!.tx;
  const f = receiptFacts(receipts[tx], tx, token, VENUES.base.poolManager, SWAP_TOPICS)!;
  // a float off in its 11th significant digit (1e-11 of it), and one of another token's size
  assert.equal(exactRow("b", "4029.69636411198", decimals, f), null);
  assert.equal(exactRow("b", "17949", decimals, f), null);
  assert.equal(exactRow("b", "-1", decimals, f), null);
  assert.equal(receiptFacts(receipts[tx], `0x${"ab".repeat(32)}`, token, VENUES.base.poolManager, SWAP_TOPICS), null);
  assert.equal(receiptFacts({ ...(receipts[tx] as object), status: "0x0" }, tx, token, VENUES.base.poolManager, SWAP_TOPICS), null);
  assert.equal(receiptFacts({ ...(receipts[tx] as object), logs: [{ logIndex: "0x1", topics: "x", data: "0x" }] }, tx, token, VENUES.base.poolManager, SWAP_TOPICS), null);
});

test("two different moves that both match the vendor's float name no amount (never a guess)", () => {
  const traders = { from: `0x${"11".repeat(20)}` };
  const [pool, router] = [`0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`];
  assert.equal(exactRow("b", "1.5", 18, { traders, moves: [{ index: 1, raw: "1500000000000000000", tier: 1, from: pool, to: traders.from, pool: true }, { index: 2, raw: "1500000000000000001", tier: 1, from: pool, to: traders.from, pool: true }] }), null);
  assert.deepEqual(exactRow("b", "1.5", 18, { traders, moves: [{ index: 1, raw: "1500000000000000001", tier: 1, from: pool, to: router, pool: true }, { index: 2, raw: "1500000000000000001", tier: 1, from: router, to: traders.from }] }), { amt: "1.500000000000000001", trader: traders.from });
});

test("vendorUnits: decimal text to the token's units, digits past its decimals dropped", () => {
  assert.equal(vendorUnits("4029.69636401198", 18), 4029696364011980000000n);
  assert.equal(vendorUnits("86.710609123", 6), 86710609n);
  assert.equal(vendorUnits("0", 6), null);
  assert.equal(vendorUnits("1e5", 6), null);
});

test("a row whose trader did not move the token its way is never served: Base tx 0x2bd3a576, whose sender sold 12,887,788.33 while the hook's contract 0x9982538f bought 18,198.82 with its cut (GeckoTerminal served both under the sender)", () => {
  const { coin: token, decimals, rows, receipts } = R.hook;
  const f = receiptFacts(receipts[rows[0]!.tx], rows[0]!.tx, token, VENUES.base.poolManager, SWAP_TOPICS)!;
  assert.equal(exactRow("b", rows[0]!.amt, decimals, f), null, "the hook's own buy is no trade of the sender");
  assert.deepEqual(exactRow("s", rows[1]!.amt, decimals, f), { amt: "12887788.33122396375", trader: "0x89cdaf64636cc51337b306f38ce8bd8abd4df6f7" });
  assert.equal(exactRow("b", rows[1]!.amt, decimals, f), null, "nor is the sender's sell read as a buy");
});

test("two transfers in a row through a router: the trader's net decides, the router's pass-through counts for no one", () => {
  const traders = { from: `0x${"11".repeat(20)}` };
  const [pool, router] = [`0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`];
  const moves = [{ index: 1, raw: "700", tier: 1 as const, from: traders.from, to: router }, { index: 2, raw: "700", tier: 1 as const, from: router, to: pool, pool: true as const }];
  assert.deepEqual(exactRow("s", "700", 0, { traders, moves }), { amt: "700", trader: traders.from });
  assert.equal(exactRow("b", "700", 0, { traders, moves }), null);
});

test("a hook's own swap is no trade of the sender's: Base tx 0x95ac6c34 (helper-v4-hook-liquidity, live run 43702430864), where the account sold 3,450.918... through router 0x5cdc0f0f and the pool's hook 0x0469a4bd then swapped 27.607... of its own liquidity (Swap log 18, no Transfer or claim of it); GeckoTerminal served both under the account", () => {
  const { coin: token, decimals, rows, receipts } = R.hookOwn;
  const tx = rows[0]!.tx;
  const f = receiptFacts(receipts[tx], tx, token, VENUES.base.poolManager, SWAP_TOPICS)!;
  assert.ok(f !== null);
  assert.equal(exactRow("s", rows[0]!.amt, decimals, f), null, "the hook's swap leg is no move of the token");
  assert.deepEqual(exactRow("s", rows[1]!.amt, decimals, f), { amt: "3450.918746181206190705", trader: "0x05168e5cbb19b6d53022f5ec1e51428b242321c9" });
});

test("only a swap's own settlement makes a row: a move between two addresses that logged no swap (a router to its user, an aggregator's fee) never does", () => {
  const traders = { from: `0x${"11".repeat(20)}` };
  const [router, fee] = [`0x${"33".repeat(20)}`, `0x${"44".repeat(20)}`];
  assert.equal(exactRow("s", "5", 0, { traders, moves: [{ index: 1, raw: "105", tier: 1, from: traders.from, to: router }, { index: 2, raw: "5", tier: 1, from: router, to: fee }] }), null);
});
