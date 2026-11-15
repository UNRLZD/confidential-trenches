// node --test scripts/ci/live-verdicts.test.mjs: the live run's last step reads every check job's verdict file and is red
// only when a check FAILED or erred, was not run, or a job left no verdict; an inconclusive check is listed by key with its
// reason, never red, never a pass (scripts/ci/live-verdicts.mjs, card live-run-red-means-the-build).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { idsOf, judge } from "./live-verdicts.mjs";

const file = (...results) => JSON.stringify({ attempt: 1, results });
const at = (attempt, ...results) => JSON.stringify({ attempt, results });
const pass = (key) => ({ key, verdict: "pass", reason: "", runs: 1 });
const fail = (key) => ({ key, verdict: "fail", reason: "exit 1", runs: 1 });

test("planted pass: every check passed, green, with its counts", () => {
  const r = judge(["a", "g"], { a: file(pass("a")), g: file(pass("g1"), pass("g2")) });
  assert.equal(r.ok, true);
  assert.equal(r.lines[0], "live-verdicts: 3 checks in 2 jobs: 3 passed, 0 failed, 0 inconclusive, 0 errors, 0 not run");
  assert.equal(r.lines.at(-1), "live-verdicts: PASS: no check judged the build bad");
});

test("planted inconclusive: green, and each one named by key with its reason on its own line", () => {
  const r = judge(["a", "g"], {
    a: file({ key: "a", verdict: "inconclusive", reason: "after 3 runs: too few answered; no answer from: mainnet.base.org", runs: 3 }),
    g: file(pass("g1"), { key: "solana-mint-supply-moves", verdict: "inconclusive", reason: "no burn landed between two reads: the run proves nothing either way", runs: 1 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.counts.inconclusive, 2);
  assert.ok(r.lines.includes("live-verdicts: inconclusive a: after 3 runs: too few answered; no answer from: mainnet.base.org"));
  assert.ok(r.lines.includes("live-verdicts: inconclusive solana-mint-supply-moves: no burn landed between two reads: the run proves nothing either way"));
  assert.equal(r.lines.at(-1), "live-verdicts: PASS: no check judged the build bad (2 could not judge, listed above)");
});

test("planted fail: one FAIL beside passes and an inconclusive is red, and named", () => {
  const r = judge(["a", "b", "c"], { a: file(pass("a")), b: file({ key: "b", verdict: "fail", reason: "live-check b: FAIL (no swap row)", runs: 1 }), c: file({ key: "c", verdict: "inconclusive", reason: "x", runs: 3 }) });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("live-verdicts: failed b: live-check b: FAIL (no swap row)"));
  assert.ok(r.lines.includes("live-verdicts: inconclusive c: x"), "the inconclusive one is still listed");
  assert.match(r.lines.at(-1), /^live-verdicts: FAIL/);
});

test("planted crash: an error, a check not run, and a job that left no verdict (or a broken one) are each red", () => {
  assert.equal(judge(["a"], { a: file({ key: "a", verdict: "error", reason: "exit 137", runs: 1 }) }).ok, false);
  const notRun = judge(["g"], { g: file(pass("g1"), { key: "g2", verdict: "not_run", reason: "the group stopped before it", runs: 0 }) });
  assert.equal(notRun.ok, false);
  assert.ok(notRun.lines.includes("live-verdicts: not run g2: the group stopped before it"));
  const gone = judge(["a", "b"], { a: file(pass("a")) });
  assert.equal(gone.ok, false);
  assert.ok(gone.lines.includes("live-verdicts: no verdict from job b: it ended before its runner wrote one (a crash, a cancel or a timeout)"));
  assert.equal(judge(["a"], { a: "{not json" }).ok, false);
  assert.equal(judge(["a"], { a: file() }).ok, false, "a file that names no check");
  const odd = judge(["a"], { a: file({ key: "a", verdict: "passed", runs: 1 }) });
  assert.equal(odd.ok, false, "a verdict word it does not know is an error, never a pass");
  assert.ok(odd.lines.includes("live-verdicts: error a: no reason given (passed)"));
});

// card live-runs-keep-what-a-fail-needs: a re-run's verdict is its newest attempt's (run 43708092717: attempt 2 passed
// evm-pool-index and evm-quote-warm-round, yet attempt 1's FAIL was read)
test("planted (live-runs-keep-what-a-fail-needs): attempt 1 FAIL then attempt 2 PASS reads PASS, in either file order", () => {
  for (const files of [[at(1, fail("a")), at(2, pass("a"))], [at(2, pass("a")), at(1, fail("a"))]]) {
    const r = judge(["a", "b"], { a: files, b: [at(1, pass("b"))] });
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(r.counts.passed, 2);
    assert.ok(r.lines.includes("live-verdicts: job a: attempt 2's verdict read, attempt 1's set aside"));
  }
});
test("planted (live-runs-keep-what-a-fail-needs): attempt 1 PASS then attempt 2 FAIL reads FAIL, in either file order", () => {
  for (const files of [[at(1, pass("a")), at(2, fail("a"))], [at(2, fail("a")), at(1, pass("a"))]]) {
    const r = judge(["a"], { a: files });
    assert.equal(r.ok, false);
    assert.ok(r.lines.includes("live-verdicts: failed a: exit 1"));
  }
});
test("planted (live-runs-keep-what-a-fail-needs): the newest attempt is read whole, never an older one in its place", () => {
  // a job re-run in attempt 2 that left no verdict there reads its attempt-1 FAIL (the reason it was re-run): red
  assert.equal(judge(["a"], { a: [at(1, fail("a"))] }).ok, false);
  // a job with no verdict in any attempt stays red, as on one attempt
  assert.ok(judge(["a", "b"], { a: [at(1, pass("a"))] }).lines.includes("live-verdicts: no verdict from job b: it ended before its runner wrote one (a crash, a cancel or a timeout)"));
  // the newest names no check, or a check not run: red, never attempt 1's pass
  assert.equal(judge(["a"], { a: [at(1, pass("a")), at(2)] }).ok, false);
  assert.equal(judge(["g"], { g: [at(1, pass("g1"), pass("g2")), at(2, pass("g1"), { key: "g2", verdict: "not_run", reason: "x", runs: 0 })] }).ok, false);
  // a file that cannot be read, or names no attempt, holds its job red whatever another attempt says
  for (const bad of ["{not json", JSON.stringify({ results: [pass("a")] }), at(0, pass("a")), at("2", pass("a"))]) {
    const r = judge(["a"], { a: [at(1, pass("a")), bad] });
    assert.equal(r.ok, false, bad);
    assert.equal(r.counts.noVerdict, 1, bad);
  }
  // two files for one attempt: no way to tell which is the job's, red
  const two = judge(["a"], { a: [at(2, pass("a")), at(2, fail("a")), at(1, pass("a"))] });
  assert.equal(two.ok, false);
  assert.ok(two.lines.includes("live-verdicts: no verdict from job a: two verdict files for attempt 2"));
});

test("the matrix's ids are read whole: an empty matrix or an id that is not one is refused", () => {
  assert.deepEqual(idsOf('{"include":[{"id":"a"},{"id":"jupiter-budget"}]}'), ["a", "jupiter-budget"]);
  assert.throws(() => idsOf('{"include":[]}'));
  assert.throws(() => idsOf('{"include":[{"id":"../x"}]}'));
});

const READER = fileURLToPath(new URL("./live-verdicts.mjs", import.meta.url));
test("the process: exit 0 on passes and inconclusives, 1 on a FAIL or a missing verdict, 2 on bad arguments; the summary gets the lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-verdicts-"));
  try {
    // download-artifact puts each artifact in a folder named after it (verdict-<id>-attempt-<n>), or a lone one at the top
    mkdirSync(path.join(dir, "v/verdict-g-attempt-1"), { recursive: true });
    mkdirSync(path.join(dir, "v/verdict-g-attempt-2"), { recursive: true });
    writeFileSync(path.join(dir, "v/a.verdict.json"), file(pass("a")));
    writeFileSync(path.join(dir, "v/verdict-g-attempt-1/g.verdict.json"), at(1, { key: "g1", verdict: "fail", reason: "first", runs: 1 }));
    writeFileSync(path.join(dir, "v/verdict-g-attempt-2/g.verdict.json"), at(2, { key: "g1", verdict: "inconclusive", reason: "why", runs: 1 }));
    const summary = path.join(dir, "summary.md");
    const run = (matrix) => spawnSync(process.execPath, [READER, "--dir", path.join(dir, "v"), "--matrix", matrix, "--summary", summary], { encoding: "utf8" });
    const ok = run('{"include":[{"id":"a"},{"id":"g"}]}');
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /^live-verdicts: inconclusive g1: why$/m);
    assert.match(ok.stdout, /^live-verdicts: job g: attempt 2's verdict read, attempt 1's set aside$/m);
    assert.match(readFileSync(summary, "utf8"), /live-verdicts: inconclusive g1: why/);
    const missing = run('{"include":[{"id":"a"},{"id":"g"},{"id":"b"}]}');
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /no verdict from job b/);
    writeFileSync(path.join(dir, "v/b.verdict.json"), file({ key: "b", verdict: "fail", reason: "live-check b: FAIL", runs: 1 }));
    assert.equal(run('{"include":[{"id":"a"},{"id":"g"},{"id":"b"}]}').status, 1, "a FAIL is red");
    assert.equal(run("").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
