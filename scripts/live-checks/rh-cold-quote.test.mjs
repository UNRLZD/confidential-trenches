// Replays rh-cold-quote.answers.json through the live check. Both answers are real runs of the check from this Mac on
// 2026-11-06, the kit's pinned providers, each in a fresh process. `bad` is main's kit (74e50795, 02:16Z): the cold TORCH
// quote ended rpc_error at 40.7 s, its reads at a block older than a provider's state, after 146 getLogs batches on
// Robinhood's first (36 answered 429); it fails. `fix` is card rh-cold-quote's kit (02:15Z): the cold quote ended ok in
// 16.5 s after 44 batches (20 answered 429), and 5 of 5 warm quotes ok; it still fails the card's 10 s, which no recorded
// run passes yet: Robinhood's keyless first answers about 1.2 batches of 10M-block getLogs a second.
//   node --test scripts/live-checks/rh-cold-quote.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./rh-cold-quote.mjs";

const A = JSON.parse(readFileSync(new URL("./rh-cold-quote.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the bad answer (main 74e50795) fails: the cold quote ends rpc_error at 40.7 s", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL cold: the quote ends rpc_error in 40694 ms: rpc_error: /);
});

test("the fix's answer ends ok cold and warm, and fails only the card's 10 s bound (16.5 s)", () => {
  const r = check(A.fix);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL cold: the quote ends ok in 16517 ms \(ok under 10000 ms wanted\)$/);
  has(r.lines, /^PASS warm: 5 of 5 end ok$/);
});

test("a cold quote that ends ok under 10 s with its warm quotes ok passes; one that ends ok at 10 s fails", () => {
  const fast = { ...A.fix, cold: { ...A.fix.cold, ms: 9_999 } };
  assert.equal(check(fast).ok, true, check(fast).lines.join("\n"));
  assert.equal(check({ ...A.fix, cold: { ...A.fix.cold, ms: 10_000 } }).ok, false);
  assert.equal(check({ ...fast, warm: [...A.fix.warm.slice(1), { ms: 900, code: "rpc_error" }] }).ok, false);
});
