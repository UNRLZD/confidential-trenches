// Replays evm-quote-warm-round.answers.json through the live check. The good answer is a real run at the card's build
// (bc189de, on the box, 2026-11-04): base-hook warm p95 829 ms, base-partial-v4 warm p95 693 ms, every quote ending as
// its case says; it passes. The bad answer is a real run before the card (db834f9, 2026-11-04): base-hook with two
// rpc_error quotes and one of 20,986 ms, warm p95 20,986 ms, and no base-partial-v4; it fails on each of those.
//   node --test scripts/live-checks/evm-quote-warm-round.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./evm-quote-warm-round.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-quote-warm-round.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (bc189de, the box) passes: both cases under a second at warm p95", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS base-hook: warm p50 \d+ ms, p95 829 ms over 20/);
  has(r.lines, /^PASS base-partial-v4: warm p50 \d+ ms, p95 693 ms over 20/);
  has(r.lines, /^PASS base-hook: 21 of 21 quotes end ok$/);
  has(r.lines, /^PASS base-partial-v4: 21 of 21 quotes end partial_fill$/);
});

test("the bad answer (db834f9) fails: base-hook's slow p95, its rpc_errors, its short count, the missing case", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base-hook: warm p50 \d+ ms, p95 20986 ms over 19/);
  has(r.lines, /^FAIL base-hook: 18 of 20 quotes end ok \(others: rpc_error\)$/);
  has(r.lines, /^FAIL base-hook: 20 quotes, 21 needed/);
  has(r.lines, /^FAIL base-partial-v4: 0 quotes, 21 needed/);
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const slow = structuredClone(A.good);
  for (const q of slow.cases["base-hook"].quotes.slice(1, 3)) q.ms = 20986; // two slow quotes of twenty lift the p95
  assert.equal(check(slow).ok, false);
  const refused = structuredClone(A.good);
  refused.cases["base-partial-v4"].quotes[5].code = "rpc_error"; // a fast refusal never counts as a fast quote
  assert.equal(check(refused).ok, false);
  const short = structuredClone(A.good);
  short.cases["base-hook"].quotes.pop();
  assert.equal(check(short).ok, false);
  const venues = { base: { providers: ["https://a.example/1", "https://a.example/2", "https://b.example"] }, robinhood: { providers: ["https://c.example", "https://d.example", "https://e.example"] } };
  assert.equal(check(A.good, venues).ok, false); // two providers on one host
  assert.equal(check(A.good, { ...venues, base: { providers: ["https://a.example", "https://b.example"] } }).ok, false);
});
