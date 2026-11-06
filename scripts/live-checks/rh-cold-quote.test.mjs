// Replays rh-cold-quote.answers.json through the live check. Both answers are real runs of the check from this Mac on
// 2026-11-06, the kit's pinned providers, each in a fresh process. `good` is card rh-cold-quote's kit merged with main
// 7936e80d (6c88307b, 02:31Z): the cold TORCH quote ended ok in 19.3 s after 44 getLogs batches on Robinhood's first (20
// answered 429), 5 of 5 warm quotes ok in 2.3-2.7 s (median 2,370 ms), and TORCH held 101 pools with other currencies; it passes. `bad` is
// main's kit (74e50795, 02:16Z): the cold quote ended rpc_error at 40.7 s, its reads at a block older than a provider's
// state, after 146 batches (36 answered 429); it fails.
//   node --test scripts/live-checks/rh-cold-quote.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOUND_MS, TARGET_MS, WARM_MAX_MS, WARM_MS, check } from "./rh-cold-quote.mjs";

const A = JSON.parse(readFileSync(new URL("./rh-cold-quote.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (6c88307b) passes: cold ok in 19.3 s, 5 of 5 warm ok (median 2,370 ms, slowest 2,717 ms), the case's seeded pools still there", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS cold: the quote ends ok in 19339 ms /);
  has(r.lines, /^PASS warm: 5 of 5 end ok$/);
  has(r.lines, /^PASS case: TORCH has 101 pools with other currencies/);
});

test("the bad answer (main 74e50795) fails: the cold quote ends rpc_error at 40.7 s", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL cold: the quote ends rpc_error in 40694 ms: rpc_error: /);
});

test("the warm bounds: a median of 3,001 ms fails, a slowest of 5,001 ms fails, a median of 2,900 ms with a slowest of 4,900 ms passes", () => {
  assert.equal(WARM_MS, 3_000);
  assert.equal(WARM_MAX_MS, 5_000);
  const at = (...ms) => ({ ...A.good, warm: ms.map((x) => ({ ms: x, code: "ok" })) });
  const median = check(at(2_000, 2_500, 3_001, 3_100, 3_200));
  assert.equal(median.ok, false);
  has(median.lines, /^FAIL warm: median 3001 ms \(under 3000 ms wanted\)$/);
  const slowest = check(at(2_000, 2_100, 2_200, 2_300, 5_001));
  assert.equal(slowest.ok, false);
  has(slowest.lines, /^FAIL warm: the slowest 5001 ms \(under 5000 ms wanted\)$/);
  const fine = check(at(2_000, 2_100, 2_900, 3_500, 4_900));
  assert.equal(fine.ok, true, fine.lines.join("\n"));
  has(fine.lines, /^PASS warm: median 2900 ms /);
  has(fine.lines, /^PASS warm: the slowest 4900 ms /);
});

test("the bounds: a cold quote at BOUND_MS, a refusal, a refused or missing warm quote, or a case with its seeded pools gone fails", () => {
  assert.equal(BOUND_MS, 30_000);
  assert.equal(TARGET_MS, 10_000);
  const g = A.good;
  assert.equal(check({ ...g, cold: { ...g.cold, ms: BOUND_MS } }).ok, false);
  assert.equal(check({ ...g, cold: { ...g.cold, code: "below_reference" } }).ok, false);
  assert.equal(check({ ...g, warm: [...g.warm.slice(1), { ms: 900, code: "rpc_error" }] }).ok, false);
  assert.equal(check({ ...g, warm: g.warm.slice(1) }).ok, false);
  assert.equal(check({ ...g, shape: { head: g.shape.head, pools: 3 } }).ok, false);
  assert.equal(check({ ...g, shape: undefined }).ok, false);
});
