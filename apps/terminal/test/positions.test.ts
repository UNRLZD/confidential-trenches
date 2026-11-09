// Sell and positions (card app-sell-positions; A2.4, app.md:1449; AE-11's sell rows, app.md:1352; S8.29, S8.30 at
// 09-design-brief S8): the percent math on the kit's token amounts in exact base units (rounded down, 100% the whole
// amount string, a percent that comes to zero base units sells nothing), the box's typed percent, Initials, the share's
// value in cents, and one WORDS table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOX_PERCENTS, initialsBps, parsePercent, QUICK, sellAmount, shareCents, toUnits, fromUnits } from "../src/screens/positions/model.ts";
import { DRAFTS, WORDS } from "../src/screens/positions/words.ts";

test("token amounts to exact base units and back: the string's own decimals, no float", () => {
  assert.deepEqual(toUnits("1234.5678"), { n: 12345678n, scale: 4 });
  assert.deepEqual(toUnits("0.000001"), { n: 1n, scale: 6 });
  assert.deepEqual(toUnits("42"), { n: 42n, scale: 0 });
  for (const bad of ["", "-1", "1e5", "1.2.3", " ", "abc", ".5", "5."]) assert.equal(toUnits(bad), null, bad);
  assert.equal(fromUnits(12345678n, 4), "1234.5678");
  assert.equal(fromUnits(1n, 6), "0.000001");
  assert.equal(fromUnits(1200n, 4), "0.12");
  assert.equal(fromUnits(10000n, 4), "1");
  assert.equal(fromUnits(42n, 0), "42");
});

test("a percent sell rounds down to the base unit: never more than is held", () => {
  // the token's decimals passed (6): with none read the share floors at the string's scale plus 4 (sell-mount.test.ts)
  assert.equal(sellAmount("1000", 2500), "250");
  assert.equal(sellAmount("1234567.891234", 5000), "617283.945617");
  // 33.33% of 10 base units of 0.000010 is 3.333 units: 3
  assert.equal(sellAmount("0.000010", 3333, 6), "0.000003");
  // 75% of 1 base unit is 0.75: rounds down to 0, so nothing to sell
  assert.equal(sellAmount("0.000001", 7500, 6), null);
  // every percent of an odd amount rounds down, and the parts never sum past the whole
  const whole = "999999999.999999";
  const parts = [2500, 5000, 7500].map((b) => toUnits(sellAmount(whole, b, 6)!)!.n);
  assert.deepEqual(parts, [249999999999999n, 499999999999999n, 749999999999999n]);
});

test("100% sells the whole amount exactly, the kit's own string, whatever its digits", () => {
  for (const a of ["1", "0.000001", "1234567.891234", "999999999999999999999.123456789012345678", "0.10", "007"]) assert.equal(sellAmount(a, 10000), a);
});

test("dust: a sell of zero base units is no sell, a zero or unreadable position sells nothing, a percent is 0 to 100", () => {
  assert.equal(sellAmount("0.000003", 2500, 6), null);
  assert.equal(sellAmount("0", 10000), null);
  assert.equal(sellAmount("0.000", 10000), null);
  assert.equal(sellAmount("x", 5000), null);
  assert.equal(sellAmount("100", 0), null);
  assert.equal(sellAmount("100", -1), null);
  assert.equal(sellAmount("100", 10001), null);
  assert.equal(sellAmount("100", 50.5), null);
});

test("the box's percent: whole or two decimals, 0 to 100, as basis points", () => {
  assert.equal(parsePercent("50"), 5000);
  assert.equal(parsePercent("12.5"), 1250);
  assert.equal(parsePercent("0.01"), 1);
  assert.equal(parsePercent("100"), 10000);
  assert.equal(parsePercent("100.00"), 10000);
  for (const bad of ["", "0", "0.00", "100.01", "101", "1.234", "-5", "5%", "abc"]) assert.equal(parsePercent(bad), null, bad);
});

test("Initials sells the share whose value returns the cost, rounded up; off when the position is not up or has no price", () => {
  // $100 cost, $219 value: 100/219 = 45.66% -> 4567 bps (the sale covers the cost)
  assert.equal(initialsBps(10_000n, 21_900n), 4567);
  assert.equal(initialsBps(5_000n, 10_000n), 5000);
  assert.equal(initialsBps(10_000n, 10_000n), null);
  assert.equal(initialsBps(10_000n, 9_000n), null);
  assert.equal(initialsBps(10_000n, null), null);
  assert.equal(initialsBps(0n, 10_000n), null);
  // the share sold at that value is never below the cost
  for (const [c, v] of [[333n, 1000n], [10_001n, 99_999n], [1n, 3n]] as const) {
    const b = initialsBps(c, v)!;
    assert.ok(v * BigInt(b) >= c * 10_000n, `${c}/${v}: ${b}`);
  }
});

test("the share's value in cents, rounded down", () => {
  assert.equal(shareCents(21_900n, 5000), 10_950n);
  assert.equal(shareCents(333n, 5000), 166n);
  assert.equal(shareCents(21_900n, 10000), 21_900n);
  assert.equal(shareCents(null, 5000), null);
});

test("the presets: the box's 25 50 75 100 (VN-05 A), the panel's 25% 50% All Initials", () => {
  assert.deepEqual(BOX_PERCENTS, [2500, 5000, 7500, 10000]);
  assert.deepEqual(QUICK, [2500, 5000, 10000, "initials"]);
});

test("every word has a source; drafts are listed", () => {
  for (const [k, w] of Object.entries(WORDS)) assert.ok(w.text && w.source, k);
  assert.deepEqual(DRAFTS, (Object.keys(WORDS) as (keyof typeof WORDS)[]).filter((k) => WORDS[k].draft));
});
