// node --test scripts/live-checks/solana-quote-under-1s.test.mjs: the live check's verdict on recorded runs
// (solana-quote-under-1s.answers.json), each a real run of the check on HELPER_HOST and PublicNode (card
// solana-quote-under-1s), named in the answers file with where and on which kit each was recorded.
// - bad (the kit before the card): the build waits for the reference, the second simulation for the first: FAIL.
// - head (the card's kit, from a Mac about 200 ms from the helper): every structural line holds and only the time bound
//   fails. No passing run is recorded yet; one from a host near the helper, or after the helper's provider B stops
//   pacing a quote's burst, is the good answer this file still needs.
// Made from head, each one thing changed: a refused leg, a check that did not run or failed, provider B with no
// blockhash, the build asked after the reference answered, the second simulation asked after the first answered or not
// at all, a run dropped: each FAIL with its own line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, RUNS, WALLET, WSOL } from "./solana-quote-under-1s.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-quote-under-1s.answers.json"), "utf8"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const planted = (f) => { const r = copy(A.head); f(r.runs[0], r); return judge(r); };
const isSecond = (c, at) => c.at === at && c.method === "simulateTransaction" && c.keys?.length === 2 && c.keys[0] === WALLET && c.keys[1] === WSOL;
const isFirst = (c, at) => c.at === at && c.method === "simulateTransaction" && c.keys?.length === 4 && c.keys[0] === WALLET;

test(`recorded head run: ${RUNS} quotes, every check run and passed on both providers, the build with the first reads, the second simulation beside the first; from 200 ms away it misses the time bound alone: FAIL on that line only`, () => {
  const r = judge(A.head);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 1, r.lines.join("\n"));
  assert.match(b[0], /^BAD the quote complete: p50 \d+ ms, p95 \d+ ms over 5 \(bound p50 < 1000, p95 < 1300\)$/);
});

/** A run's whole timeline scaled so its quote completes at `ms`: every call keeps its order and its place before it. */
const scaled = (run, ms) => { const k = ms / run.quote; for (const c of run.calls) { c.start *= k; c.end *= k; } run.quote = ms; };

test("the bound: the head's runs scaled to complete under 1,000 ms pass; scaled to 1,000 ms they fail on p50", () => {
  const under = copy(A.head);
  under.runs.forEach((run, i) => scaled(run, 800 + i));
  assert.equal(judge(under).ok, true, judge(under).lines.join("\n"));
  const at = copy(A.head);
  at.runs.forEach((run) => scaled(run, 1_000));
  assert.ok(bad(judge(at)).some((l) => /^BAD the quote complete: p50 1000 ms/.test(l)));
});

test("recorded bad run (the kit before the card): the build waits for the reference, the second simulation for the first, and the bound fails: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.ok(b.some((l) => /the build went out at \d+ ms, after the reference answered/.test(l)), b.join("\n"));
  assert.ok(b.some((l) => /second simulation went out at \d+ ms, after the first answered/.test(l)), b.join("\n"));
  assert.ok(b.some((l) => /^BAD the quote complete:/.test(l)), b.join("\n"));
});

test("planted: a refused leg: FAIL", () => {
  const r = planted((run) => { run.refused = "checks: S12 the simulated out is under E"; });
  assert.ok(bad(r).some((l) => /run 0: refused: checks: S12/.test(l)));
});

test("planted: S11 did not run: FAIL", () => {
  const r = planted((run) => { run.checks = run.checks.filter((c) => c.id !== "S11"); });
  assert.ok(bad(r).some((l) => /run 0: checks not run or not passed: S11$/.test(l)));
});

test("planted: S6 ran and failed: FAIL", () => {
  const r = planted((run) => { run.checks.find((c) => c.id === "S6").ok = false; });
  assert.ok(bad(r).some((l) => /run 0: checks not run or not passed: S6$/.test(l)));
});

test("planted: provider B answered no blockhash (one provider's word): FAIL", () => {
  const r = planted((run) => { run.calls = run.calls.filter((c) => !(c.at === "B" && c.method === "getLatestBlockhash")); });
  assert.ok(bad(r).some((l) => /run 0: provider B answered no blockhash/.test(l)));
});

test("planted: the build asked after the reference answered: FAIL", () => {
  const r = planted((run) => { const ref = run.calls.find((c) => c.method === "reference"); run.calls.find((c) => c.method === "build").start = ref.end + 1; });
  assert.ok(bad(r).some((l) => /run 0: the build went out at \d+ ms, after the reference answered/.test(l)));
});

test("planted: provider A's second simulation asked after its first answered: FAIL", () => {
  const r = planted((run) => { const first = run.calls.find((c) => isFirst(c, "A")); run.calls.find((c) => isSecond(c, "A")).start = first.end + 1; });
  assert.ok(bad(r).some((l) => /run 0: provider A's second simulation went out at \d+ ms, after the first answered/.test(l)));
});

test("planted: no second simulation on provider B: FAIL", () => {
  const r = planted((run) => { run.calls = run.calls.filter((c) => !isSecond(c, "B")); });
  assert.ok(bad(r).some((l) => /run 0: provider B ran no second simulation/.test(l)));
});

test("planted: a run dropped: FAIL", () => {
  const r = planted((_run, rec) => { rec.runs.pop(); });
  assert.ok(bad(r).some((l) => new RegExp(`^BAD ${RUNS - 1} runs, want ${RUNS}$`).test(l)));
});
