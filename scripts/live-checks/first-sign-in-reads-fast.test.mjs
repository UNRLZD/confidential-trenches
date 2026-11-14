// node --test scripts/live-checks/first-sign-in-reads-fast.test.mjs: the live check's verdict replays recorded sign-ins
// (first-sign-in-reads-fast.answers.json), RUNS each, every run the "restore: <chain> walked" lines
// pool-restore-wired.mjs collect() read, judged on each pool's median gap after Solana:
//   good: this card's signing page build with the pinned hosts on the network (--local --net, box run fsirf-median,
//         14 Nov 05:33-05:34Z, Chrome 156, three runs): Base 6.1, 9.2 and 3.0 s and Robinhood 3.0, 3.0 and 6.2 s after
//         Solana, medians 6.1 and 3.0 s: PASS;
//   bad:  live SIGN_HOST at release 133, before this card (14 Nov 03:31-03:32Z, box Chrome 156, three runs): Robinhood
//         16.7, 13.2 and 14.9 s and Base 19.9, 16.2 and 11.9 s after Solana, medians 14.9 and 16.2 s: FAIL.
// Planted from the good record: a pool that never walks, Solana missing, an EVM pool past GAP_MS, an error (each in
// every run); one slow run of three PASSES, two FAIL; fewer than RUNS runs is refused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GAP_MS, judge } from "./first-sign-in-reads-fast.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "first-sign-in-reads-fast.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
// the same change in every run of the good record
const every = (f) => mut((rec) => rec.runs.forEach(f));
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};
const sol = (run) => run.walked.find((w) => w.chain === "solana").t;
const set = (run, chain, gap) => (run.walked.find((w) => w.chain === chain).t = sol(run) + gap);

test("recorded good answer: this card's build walks Base and Robinhood within GAP_MS of Solana at the median of three sign-ins: PASS", () => {
  assert.equal(ANSWERS.good.runs.length, 3);
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: live SIGN_HOST before this card walks Base and Robinhood long after Solana in three sign-ins: FAIL on both medians", () => {
  assert.equal(ANSWERS.bad.runs.length, 3);
  const r = judge(ANSWERS.bad);
  fails(r, /^BAD base walked a median of 16198 ms after Solana/);
  fails(r, /^BAD robinhood walked a median of 14881 ms after Solana/);
});

test("planted: a pool that never walks, no Solana line, an EVM pool past GAP_MS, an error: FAIL; one at GAP_MS: PASS", () => {
  for (const chain of ["base", "robinhood"]) {
    fails(every((run) => (run.walked = run.walked.filter((w) => w.chain !== chain))), new RegExp(`^BAD ${chain} walked a median of never`));
    fails(every((run) => set(run, chain, GAP_MS + 1)), new RegExp(`^BAD ${chain} walked a median of ${GAP_MS + 1} ms`));
    assert.equal(every((run) => set(run, chain, GAP_MS)).ok, true);
  }
  fails(every((run) => (run.walked = run.walked.filter((w) => w.chain !== "solana"))), /^BAD Solana walked in every run \(never in runs 1, 2, 3/);
  fails(every((run) => (run.walked = [])), /^BAD Solana walked/);
  fails(every((run) => delete run.walked), /^BAD Solana walked/);
  fails(mut((rec) => rec.runs[1].errors.push("no words field")), /no error/);
});

test("the median: one slow sign-in of three (past GAP_MS) PASSES; two slow FAIL, each pool alone", () => {
  for (const chain of ["base", "robinhood"]) {
    const one = mut((rec) => set(rec.runs[0], chain, 38_250));
    assert.equal(one.ok, true, one.lines.join("\n"));
    assert.ok(one.lines.some((l) => l.includes("38250")), "the slow run is named on its line");
    fails(
      mut((rec) => (set(rec.runs[0], chain, 38_250), set(rec.runs[2], chain, GAP_MS + 1))),
      new RegExp(`^BAD ${chain} walked a median of ${GAP_MS + 1} ms`),
    );
    // a run where the pool never walks counts as slow, never as missing
    const never = mut((rec) => (rec.runs[1].walked = rec.runs[1].walked.filter((w) => w.chain !== chain)));
    assert.equal(never.ok, true, never.lines.join("\n"));
    fails(mut((rec) => [0, 1].forEach((i) => (rec.runs[i].walked = rec.runs[i].walked.filter((w) => w.chain !== chain)))), new RegExp(`^BAD ${chain} walked a median of never`));
  }
});

test("fewer than three sign-ins, or none, is refused: FAIL", () => {
  for (const runs of [0, 1, 2]) fails(mut((rec) => (rec.runs = rec.runs.slice(0, runs))), new RegExp(`^BAD 3 sign-ins recorded \\(${runs}\\)`));
  fails(mut((rec) => delete rec.runs), /^BAD 3 sign-ins recorded \(0\)/);
  fails(judge(null), /^BAD 3 sign-ins recorded/);
});
