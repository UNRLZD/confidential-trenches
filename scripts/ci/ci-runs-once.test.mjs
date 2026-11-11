// node --test scripts/ci/ci-runs-once.test.mjs: ci.yml runs the full checks once per merged commit, the queue's run
// (no push trigger), and a commit's CI is read from its own runs by sha: its merge queue run, a push run or one by hand,
// never a scheduled one (scripts/ci/ci-runs-once.mjs, card main-ci-runs-once). Each way the rule can break is planted.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ciProblems, fullRun, runsArgs, triggerProblems } from "./ci-runs-once.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(path.join(HERE, "../../.github/workflows/ci.yml"), "utf8");
const has = (p, re) => p.some((l) => re.test(l));

test("the real ci.yml runs on pull requests, the merge queue, nightly and by hand, and never on push", () => {
  assert.deepEqual(triggerProblems(CI), []);
});

test("planted: a push trigger, a lost merge_group or workflow_dispatch, or triggers named another way are refused", () => {
  const push = CI.replace("  merge_group:\n    types: [checks_requested]\n", "  merge_group:\n    types: [checks_requested]\n  push:\n    branches: [main]\n");
  assert.notEqual(push, CI);
  assert.ok(has(triggerProblems(push), /ci\.yml runs on push/));
  const pushAny = CI.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n");
  assert.notEqual(pushAny, CI);
  assert.ok(has(triggerProblems(pushAny), /ci\.yml runs on push/), "a push on any branch");
  const noQueue = CI.replace("  merge_group:\n    types: [checks_requested]\n", "");
  assert.ok(has(triggerProblems(noQueue), /does not run on merge_group/));
  const noHand = CI.replace("  workflow_dispatch:\n", "");
  assert.notEqual(noHand, CI);
  assert.ok(has(triggerProblems(noHand), /no workflow_dispatch/));
  const noPr = CI.replace("  pull_request:\n    branches: [main]\n", "");
  assert.ok(has(triggerProblems(noPr), /does not run on pull requests into main/));
  const twice = `${CI}\n"on": [push]\n`;
  assert.ok(has(triggerProblems(twice), /names its triggers a second way/));
  const flow = CI.replace(/^on:\n/m, "on: [push, pull_request]\nx:\n");
  assert.ok(triggerProblems(flow).length > 0, "a flow-form on: is not read as clean");
  const other = CI.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  workflow_run:\n    workflows: [x]\n");
  assert.ok(has(triggerProblems(other), /runs on workflow_run, which this rule does not know/));
});

const SHA = "b04a235225deb8d277ce162326fc6312268ea446";
const QUEUE = "gh-readonly-queue/main/pr-628-7e673a4613cdb8f1be4aa2c1068c4edeee4fa9d2";
const run = (o) => ({ headSha: SHA, headBranch: QUEUE, event: "merge_group", status: "completed", conclusion: "success", databaseId: 43008967616, ...o });

test("a commit with only its merge queue run, passed, goes; the recorded answer for b04a2352 (11 Nov 11:3xZ) goes", () => {
  assert.deepEqual(ciProblems(SHA, [run()]), []);
  // gh run list --workflow ci.yml --commit b04a2352..., as GitHub answered it while the push run still went
  const recorded = [
    { attempt: 1, conclusion: "", databaseId: 43010314311, event: "push", headBranch: "main", headSha: SHA, status: "in_progress" },
    { attempt: 1, conclusion: "success", databaseId: 43008967616, event: "merge_group", headBranch: QUEUE, headSha: SHA, status: "completed" },
  ];
  assert.deepEqual(ciProblems(SHA, recorded), [], "the queue's passed run is the commit's run; a second run still going does not hold it");
  // a commit from before this card: its push run
  assert.deepEqual(ciProblems(SHA, [run({ event: "push", headBranch: "main" })]), []);
  assert.deepEqual(ciProblems(SHA, [run({ event: "workflow_dispatch", headBranch: "main" })]), []);
});

test("planted: a queue run that failed, was cancelled or still goes is refused, named; so is a commit with no full run", () => {
  assert.match(ciProblems(SHA, [run({ conclusion: "failure" })])[0], /merge queue run of ci\.yml \(43008967616\) ended failure: rerun it \(gh run rerun 43008967616 -R UNRLZD\/confidential-trenches\)/);
  assert.match(ciProblems(SHA, [run({ conclusion: "cancelled" })])[0], /ended cancelled/);
  assert.match(ciProblems(SHA, [run({ status: "in_progress", conclusion: "" })])[0], /merge queue run of ci\.yml \(43008967616\) is in_progress: wait for it to pass$/);
  assert.match(ciProblems(SHA, [])[0], /has no full ci\.yml run .*: give it one with gh workflow run ci\.yml --ref main -R UNRLZD\/confidential-trenches/);
  // the newest full run decides when none passed: a rerun still going after a failure is waited for
  assert.match(ciProblems(SHA, [run({ databaseId: 2, status: "queued", conclusion: "" }), run({ databaseId: 1, conclusion: "failure" })])[0], /\(2\) is queued/);
});

test("planted: a run that is not the commit's full run is never read as one", () => {
  // a scheduled run checks the vault sandbox alone
  assert.match(ciProblems(SHA, [run({ event: "schedule", headBranch: "main" })])[0], /no full ci\.yml run .*a scheduled run checks the vault sandbox alone/);
  // a pull request's run is on its own tree, and another branch's queue is not main's
  assert.ok(ciProblems(SHA, [run({ event: "pull_request", headBranch: "card/x" })]).length > 0);
  assert.ok(ciProblems(SHA, [run({ headBranch: "gh-readonly-queue/dev/pr-1-abc" })]).length > 0);
  assert.ok(ciProblems(SHA, [run({ event: "push", headBranch: "card/x" })]).length > 0, "a push to another branch");
  // another commit's pass
  assert.ok(ciProblems(SHA, [run({ headSha: "c".repeat(40) })]).length > 0);
  // a short sha or no answer
  assert.match(ciProblems("b04a2352", [run()])[0], /not a full commit sha/);
  assert.match(ciProblems(SHA, null)[0], /gh did not read/);
  assert.equal(fullRun(undefined), false);
});

test("the read is the commit's own ci.yml runs, by its full sha, never main's branch", () => {
  assert.deepEqual(runsArgs(SHA), ["run", "list", "-R", "UNRLZD/confidential-trenches", "--workflow", "ci.yml", "--commit", SHA, "-L", "50", "--json", "headSha,headBranch,event,status,conclusion,databaseId"]);
});

test("the command: exit 0 on the real ci.yml, 1 on one with a push trigger", () => {
  const cli = fileURLToPath(new URL("./ci-runs-once.mjs", import.meta.url));
  assert.equal(spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 0);
  const dir = mkdtempSync(path.join(tmpdir(), "ci-runs-once-"));
  try {
    const f = path.join(dir, "ci.yml");
    writeFileSync(f, CI.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  push:\n    branches: [main]\n"));
    const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ci-runs-once: ci\.yml runs on push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
