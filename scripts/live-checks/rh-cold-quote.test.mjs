// Replays rh-cold-quote.answers.json through the live check. Both answers are real runs of the check from this Mac on
// 2026-11-06, the kit's pinned providers, each in a fresh process. `good` is card rh-cold-quote's kit merged with main
// 7936e80d (6c88307b, 02:31Z): the cold TORCH quote ended ok in 19.3 s after 44 getLogs batches on Robinhood's first (20
// answered 429), 5 of 5 warm quotes ok in 2.3-2.7 s, and TORCH held 101 pools with other currencies; it passes. `bad` is
// main's kit (74e50795, 02:16Z): the cold quote ended rpc_error at 40.7 s, its reads at a block older than a provider's
// state, after 146 batches (36 answered 429); it fails.
//   node --test scripts/live-checks/rh-cold-quote.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOUND_MS, TARGET_MS, check } from "./rh-cold-quote.mjs";

const A = JSON.parse(readFileSync(new URL("./rh-cold-quote.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (6c88307b) passes: cold ok in 19.3 s, 5 of 5 warm ok under 3 s, the case's seeded pools still there", () => {
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

test("the bounds: a cold quote at BOUND_MS, a refusal, a slow or refused warm quote, or a case with its seeded pools gone fails", () => {
  assert.equal(BOUND_MS, 30_000);
  assert.equal(TARGET_MS, 10_000);
  const g = A.good;
  assert.equal(check({ ...g, cold: { ...g.cold, ms: BOUND_MS } }).ok, false);
  assert.equal(check({ ...g, cold: { ...g.cold, code: "below_reference" } }).ok, false);
  assert.equal(check({ ...g, warm: [...g.warm.slice(1), { ms: 3_000, code: "ok" }] }).ok, false);
  assert.equal(check({ ...g, warm: [...g.warm.slice(1), { ms: 900, code: "rpc_error" }] }).ok, false);
  assert.equal(check({ ...g, warm: g.warm.slice(1) }).ok, false);
  assert.equal(check({ ...g, shape: { head: g.shape.head, pools: 3 } }).ok, false);
  assert.equal(check({ ...g, shape: undefined }).ok, false);
});
