// Card app-holding-follows-a-fill: the holding a trade's own answer leaves is the shown holding from its Filled until a
// holdings read shows it (src/screens/portfolio/fills.ts), for buy and sell alike, in the one snapshot the trade box, the
// positions and the portfolio draw (useFilled in screens/trade/source.tsx and screens/portfolio/source.tsx).
//   node --test test/holding-follows-a-fill.test.ts      (from apps/terminal)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FILL_KEEP_MS, fillOf, fillStore, pendingFills, withFills, type Fill } from "../src/screens/portfolio/fills.ts";

const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
type P = Parameters<typeof withFills>[0][number];
const pos = (amount: string, cost = "10", wallets = ["W1"]): P => ({ chain: "solana", token: MINT, amount, cost, wallets, decimals: 6 });
const buy = (id: string, amount: string, held: P | null, at = 0, spend = "0.03", was?: string | null) => fillOf({ id, chain: "solana", token: MINT, side: "buy", amount, wallet: "W9", spend, at, ...(was === undefined ? {} : { was }) }, held)!;
const sell = (id: string, amount: string, held: { amount: string; cost: string } | null, at = 0, was?: string | null) => fillOf({ id, chain: "solana", token: MINT, side: "sell", amount, at, ...(was === undefined ? {} : { was }) }, held)!;
const amountOf = (ps: readonly P[]) => ps.find((p) => p.token === MINT)?.amount ?? null;

test("a buy's fill is the holding at once, with its wallet and spend, until a read shows it", () => {
  const f = buy("b1", "944376.006241", null);
  assert.deepEqual([f.after, f.cost, f.wallet], ["944376.006241", "0.03", "W9"]);
  // the read lags (no position yet): the fill is the holding
  const shown = withFills([], [f], 1);
  assert.deepEqual(shown, [{ chain: "solana", token: MINT, amount: "944376.006241", cost: "0.03", wallets: ["W9"] }]);
  // a read that shows it: the read stands, the fill is done
  const read = [pos("944376.006241", "0.0301", ["W9"])];
  assert.equal(withFills(read, [f], 2), read);
  assert.deepEqual(pendingFills(read, [f], 2), []);
  // onto a held amount: added, the spend added to a known cost, the wallet joined
  const g = buy("b2", "5", pos("10", "2"));
  assert.deepEqual([g.after, g.cost], ["15", "2.03"]);
  assert.deepEqual(withFills([pos("10", "2")], [g], 1)[0]!.wallets, ["W1", "W9"]);
  // an unknown cost stays unknown, as the page's
  assert.equal(buy("b3", "5", pos("10", "0")).cost, "0");
});

test("a sell's fill takes its units off at once; all of it: no position; the read lagging at the old amount keeps it off", () => {
  const all = sell("s1", "944376.006241", pos("944376.006241"));
  assert.equal(all.after, "0");
  // the finalized read still lists the sold token (run 8: 944.3K shown 5 s after Filled): not shown
  assert.equal(amountOf(withFills([pos("944376.006241")], [all], 5_000)), null);
  // the read at 0 (or gone): done
  assert.deepEqual(pendingFills([], [all], 5_000), []);
  const half = sell("s2", "500", pos("1000", "10"));
  assert.deepEqual([half.after, half.cost], ["500", "5"]);
  assert.equal(amountOf(withFills([pos("1000", "10")], [half], 1)), "500");
  // the read showing the sale (at its amount or less) stands
  assert.deepEqual(pendingFills([pos("500")], [half], 1), []);
});

test("a buy then a sell before any read: the read that shows the buy only still shows the sale", () => {
  const b = buy("b1", "1000", null, 0);
  const s = sell("s1", "1000", { ...pos(b.after), cost: b.cost }, 10);
  // the buy's run ends and its read shows the bought 1000; the sale's not yet
  assert.equal(amountOf(withFills([pos("1000")], [b, s], 20)), null, "the sale stays shown");
  // the read shows the sale: done, and the buy before it with it
  assert.deepEqual(pendingFills([], [b, s], 20), []);
});

test("the next real read replaces the shown amount: one that moved the fill's way since its tap and reached it", () => {
  // half sold of 1000, the read at the tap 1000
  const half = sell("s1", "500", pos("1000"), 0, "1000");
  assert.equal(amountOf(withFills([pos("1000")], [half], 1)), "500", "the read from before the sale: the fill stands");
  assert.equal(amountOf(withFills([pos("500")], [half], 1)), "500");
  assert.deepEqual(pendingFills([pos("500")], [half], 1), [], "the sale's read stands it down");
  // a buy, the read at its tap none
  const b = buy("b1", "10600", null, 0, "0.03", null);
  assert.equal(amountOf(withFills([], [b], 1)), "10600");
  assert.deepEqual(pendingFills([pos("10600")], [b], 1), []);
  // two buys in a row: the first one's read does not stand the second down
  const b2 = buy("b2", "5000", pos("10600"), 5, "0.01", null);
  assert.equal(amountOf(withFills([pos("10600")], [b, b2], 6)), "15600");
});

test("devnet run 10: a 100% sale of a holding the read never had: the read at 0 before and after shows 0, and the buy's late read never brings it back", () => {
  const b = buy("b1", "10600", null, 0, "0.03", null);
  const s = sell("s1", "10600", { amount: b.after, cost: b.cost }, 3_000, null);
  assert.equal(amountOf(withFills([], [b, s], 4_000)), null, "sold: none, the read still at none");
  assert.equal(pendingFills([], [b, s], 4_000).length, 2, "the read from before both stands neither down");
  // the buy's finalized read comes: the sale still shows
  assert.equal(amountOf(withFills([pos("10600")], [b, s], 13_000)), null);
  assert.deepEqual(pendingFills([pos("10600")], [b, s], 13_000).map((f) => f.id), ["s1"]);
});

test("the store reads the holdings at a tap: none before a read, then the read's amount", () => {
  fillStore.sync(null, Date.now());
  assert.equal(fillStore.readOf("solana", MINT), undefined);
  fillStore.sync([pos("7")], Date.now());
  assert.equal(fillStore.readOf("solana", MINT), "7");
  fillStore.sync([], Date.now());
  assert.equal(fillStore.readOf("solana", MINT), null);
  fillStore.sync(null, Date.now());
});

test("past FILL_KEEP_MS the read stands; signed out: none", () => {
  const f = buy("b1", "10", null, 0);
  assert.equal(amountOf(withFills([], [f], FILL_KEEP_MS - 1)), "10");
  assert.equal(amountOf(withFills([], [f], FILL_KEEP_MS)), null);
  assert.deepEqual(pendingFills(null, [f], 0), []);
});

test("the store: once per id, a trade with no fill takes it back, a sync drops what a read shows", () => {
  const f: Fill = buy("x1", "10", null, Date.now());
  fillStore.note(f);
  fillStore.note(f);
  assert.equal(fillStore.get().filter((x) => x.id === "x1").length, 1);
  fillStore.drop("x1");
  assert.equal(fillStore.get().some((x) => x.id === "x1"), false, "the old amount shows again");
  fillStore.note(f);
  fillStore.sync([pos("10")], Date.now());
  assert.equal(fillStore.get().some((x) => x.id === "x1"), false);
  fillStore.note({ ...f, id: "x2" });
  fillStore.sync(null, Date.now());
  assert.equal(fillStore.get().length, 0, "sign out drops them");
});

test("one source: the trade box, the positions and the portfolio draw the filled snapshot; the buy notes at its out, the sell at its Filled", () => {
  const trade = readFileSync(new URL("../src/screens/trade/source.tsx", import.meta.url), "utf8");
  assert.match(trade, /const filled = useFilled\(base\.snapshot, base\.now\);/);
  const pf = readFileSync(new URL("../src/screens/portfolio/source.tsx", import.meta.url), "utf8");
  assert.match(pf, /const filled = useFilled\(fixture\?\.snapshot \?\? snapshot, fixture\?\.now \?\? Date\.now\);/);
  const box = readFileSync(new URL("../src/screens/trade/TradeBox.tsx", import.meta.url), "utf8");
  assert.match(box, /fillStore\.note\(fillOf\(\{ id: d\.id, chain: h\.chain, token: h\.token, side: "buy", amount: d\.amount,/);
  assert.match(box, /if \(phase\.k === "ended"\) fillStore\.drop\(phase\.id\);/);
  const sellSrc = readFileSync(new URL("../src/screens/positions/source.tsx", import.meta.url), "utf8");
  assert.match(sellSrc, /fillStore\.note\(fillOf\(\{ id: phase\.id, chain: t\.chain, token: t\.token, side: "sell", amount: t\.amount,/);
  // each on the holding as shown at its tap, so a read that has shown the trade by its Filled is not counted twice
  assert.match(box, /tapHeld\.current = \{ id: h\.id, held: snapshot\.state\?\.positions\.find\(/);
  assert.match(box, /side: "buy", amount: d\.amount, [^\n]*, was: t\.was \}, t\.held\)\);/);
  assert.match(box, /was: fillStore\.readOf\(chain, token\) \};/);
  assert.match(sellSrc, /SOLD\.set\(h\.id, \{ chain, token, amount, held: src\.snapshot\.state\?\.positions\.find\(/);
  assert.match(sellSrc, /side: "sell", amount: t\.amount, [^\n]*, was: t\.was \}, t\.held\)\);/);
  assert.match(sellSrc, /was: fillStore\.readOf\(chain, token\) \}\);/);
});

test("a read that already shows the sale at its Filled: the fill made on the tap's holding stands down at once", () => {
  // tapped at 1000, half sold; the record's read at Filled says 500 already
  const f = sell("s1", "500", pos("1000"));
  assert.deepEqual(pendingFills([pos("500")], [f], 1), []);
  assert.equal(amountOf(withFills([pos("500")], [f], 1)), "500");
  // a buy the read has shown by its out: the read stands
  const b = buy("b1", "10", null);
  assert.equal(withFills([pos("10")], [b], 1)[0]!.amount, "10");
});
