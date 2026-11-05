// Replays evm-quote-lag-held.answers.json through the live check. Both answers are real runs of the check from this
// Mac on 2026-11-05, the kit's pinned providers with one of each venue's first two answering its latest block maxLag
// back. The good answer is the kit of card base-200ms-blocks (f746056f, 21:03Z): Robinhood's publicnode 100 back, Base's
// blastapi 5 back and 50 back (Base's maxLag: 10 s of its 200 ms blocks), each asked in the cold quote, and 10 of 10 warm
// quotes ok on each; it passes. The bad answer is the kit before card evm-quote-lag-held (e031ad4): Base 2 of 10 warm
// quotes ok, the rest rpc_disagree in about 0.6 s (the scan provider's head more than 5 blocks past the agreed block, the
// lagger's), Robinhood 9 of 10; it fails on each. bad_maxlag5 is main's kit before card base-200ms-blocks (3ad4abf6,
// Base maxLag 5, 21:06Z): blastapi 50 back, 10 s of Base's blocks, is never asked in the pair; it fails.
//   node --test scripts/live-checks/evm-quote-lag-held.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./evm-quote-lag-held.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-quote-lag-held.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (f746056f) passes: each lagger asked in the cold quote, 10 of 10 warm quotes ok on each chain", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS robinhood-publicnode-100: robinhood-rpc\.publicnode\.com answering 100 blocks back was asked for its head \d+ times in the cold quote$/);
  has(r.lines, /^PASS robinhood-publicnode-100: 10 of 10 warm quotes end ok$/);
  has(r.lines, /^PASS base-blastapi-5: base-mainnet\.public\.blastapi\.io answering 5 blocks back was asked for its head \d+ times in the cold quote$/);
  has(r.lines, /^PASS base-blastapi-5: 10 of 10 warm quotes end ok$/);
  has(r.lines, /^PASS base-blastapi-50: base-mainnet\.public\.blastapi\.io answering 50 blocks back was asked for its head \d+ times in the cold quote$/);
  has(r.lines, /^PASS base-blastapi-50: 10 of 10 warm quotes end ok$/);
});

test("bad_maxlag5 (3ad4abf6, Base maxLag 5) fails: a provider 50 blocks back, 10 s of Base's 200 ms blocks, is never in the pair", () => {
  const r = check(A.bad_maxlag5);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base-blastapi-50: base-mainnet\.public\.blastapi\.io answering 50 blocks back was asked for its head 0 times in the cold quote$/);
});

test("the bad answer (e031ad4) fails: Base's warm quotes refused rpc_disagree at the lagger's block, one Robinhood quote refused", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base-blastapi-5: 2 of 10 warm quotes end ok \(others: rpc_disagree at quote 1, 598 ms: rpc_disagree: the scan provider's head 53541965 is more than 5 blocks past the agreed block 53541959/);
  has(r.lines, /^FAIL robinhood-publicnode-100: 9 of 10 warm quotes end ok/);
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const refused = structuredClone(A.good);
  refused.cases["base-blastapi-5"].quotes[4].code = "rpc_disagree";
  assert.equal(check(refused).ok, false, "one warm refusal");
  const short = structuredClone(A.good);
  short.cases["robinhood-publicnode-100"].quotes.pop();
  assert.equal(check(short).ok, false, "nine warm quotes");
  const unasked = structuredClone(A.good);
  unasked.cases["base-blastapi-5"].cold.lagHeads = 0;
  assert.equal(check(unasked).ok, false, "a lagger never asked proves nothing");
  const missing = structuredClone(A.good);
  delete missing.cases["robinhood-publicnode-100"];
  assert.equal(check(missing).ok, false, "a case not run");
  // the cold quote's outcome is shown, not judged
  const cold = structuredClone(A.good);
  cold.cases["robinhood-publicnode-100"].cold.code = "rpc_error";
  assert.equal(check(cold).ok, true);
});
