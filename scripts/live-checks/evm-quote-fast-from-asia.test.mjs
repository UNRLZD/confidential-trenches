// Replays evm-quote-fast-from-asia.answers.json through the live check. Both answers are real runs of the check from the
// Mac (2026-11-14): the good one on the card's branch, where every warm quote sent its first read before any
// answer of the scan provider; the bad one on e092c10ba, the base the card started from, where each warm quote's first
// read waited for two scan answers (the head, then the logs). The good passes, the bad fails.
//   node --test scripts/live-checks/evm-quote-fast-from-asia.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, MIN_BESIDE, N_WARM } from "./evm-quote-fast-from-asia.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-quote-fast-from-asia.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (the card's branch, from the Mac) passes: every warm quote reads before any scan answer", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, new RegExp(`^PASS base-hook: ${N_WARM} of ${N_WARM} warm quotes send their first read before any scan answer`));
  has(r.lines, new RegExp(`^PASS base-partial-v4: ${N_WARM} of ${N_WARM} warm quotes send their first read before any scan answer`));
});

test("the bad answer (e092c10ba, from the Mac) fails: each warm quote's first read waited for the scan's answers", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base-hook: 0 of \d+ warm quotes send their first read before any scan answer/);
  has(r.lines, /^FAIL base-partial-v4: 0 of \d+ warm quotes send their first read before any scan answer/);
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const waited = structuredClone(A.good);
  for (const q of waited.cases["base-hook"].quotes.slice(1, 2 + N_WARM - MIN_BESIDE)) q.scanBefore = 2; // one more than the rule allows
  assert.equal(check(waited).ok, false);
  const allowed = structuredClone(A.good);
  for (const q of allowed.cases["base-hook"].quotes.slice(1, 1 + N_WARM - MIN_BESIDE)) q.scanBefore = 2; // as many as it allows
  assert.equal(check(allowed).ok, true);
  const noRead = structuredClone(A.good);
  for (const q of noRead.cases["base-partial-v4"].quotes.slice(1)) q.firstRead = null; // a quote that read nothing is no fast one
  assert.equal(check(noRead).ok, false);
  const refused = structuredClone(A.good);
  refused.cases["base-hook"].quotes[4].code = "rpc_error"; // a fast refusal never counts as a fast quote
  assert.equal(check(refused).ok, false);
  const short = structuredClone(A.good);
  short.cases["base-partial-v4"].quotes.pop();
  assert.equal(check(short).ok, false);
  assert.equal(check({ cases: {} }).ok, false);
});
