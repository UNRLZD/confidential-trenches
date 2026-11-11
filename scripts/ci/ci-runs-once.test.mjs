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
import { cacheProblems, ciProblems, fullRun, runsArgs, triggerProblems } from "./ci-runs-once.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(path.join(HERE, "../../.github/workflows/ci.yml"), "utf8");
const CACHE = readFileSync(path.join(HERE, "../../.github/workflows/ci-cache.yml"), "utf8");
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
    const r = spawnSync(process.execPath, [cli, f, path.join(HERE, "../../.github/workflows/ci-cache.yml")], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ci-runs-once: ci\.yml runs on push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// main's caches: with no push run, ci-cache.yml saves on main each cache ci.yml's pull request and queue runs read
test("the real ci-cache.yml saves every cache ci.yml saves outside the nightly's jobs, with its key and path, on a miss", () => {
  assert.deepEqual(cacheProblems(CI, CACHE), []);
});

test("planted: a cache ci-cache.yml does not save, a key or path that drifted, a new ci.yml cache, a test, a save on every run, or other triggers are refused", () => {
  const FOUNDRY = "download-foundry-1.7.1-cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b";
  // a key bumped in ci.yml (a version) and not here
  const bumped = CI.replaceAll(FOUNDRY, FOUNDRY.replace("1.7.1", "1.7.2"));
  assert.ok(has(cacheProblems(bumped, CACHE), /ci\.yml's test-scripts saves download-foundry-1\.7\.2-.*ci-cache\.yml does not save it/), "the queue would read 1.7.2 cold until a run on main saved it");
  assert.ok(has(cacheProblems(bumped, CACHE), /ci\.yml's slither saves download-foundry-1\.7\.2/));
  // a path that drifted
  const moved = CACHE.replaceAll("~/.cache/ci-downloads/gitleaks-8.30.1.tgz", "~/.cache/gitleaks.tgz");
  assert.ok(has(cacheProblems(CI, moved), /ci\.yml's gitleaks saves download-gitleaks-8\.30\.1-/));
  // the pool's build cache with one path fewer
  const fewer = CACHE.replaceAll("            ~/.cache/solana\n", "");
  assert.ok(has(cacheProblems(CI, fewer), /ci\.yml's pool-solana saves pool-solana-rustc-/));
  // a save step gone
  const gone = CACHE.replace(/      - if: steps\.agave-tar\.outputs\.cache-hit != 'true'\n        uses: actions\/cache\/save@[^\n]*\n        with:\n          path: ~\/\.cache\/ci-downloads\/agave-4\.4\.0\.tar\.bz2\n          key: [^\n]*\n/, "");
  assert.notEqual(gone, CACHE);
  assert.ok(cacheProblems(CI, gone).length === 0, "agave is still saved by the pool job's miss path");
  const noAgave = gone.replace(/      - if: steps\.pool-cache\.outputs\.cache-hit != 'true' && steps\.agave-tar\.outputs\.cache-hit != 'true'\n        uses: actions\/cache\/save@[^\n]*\n        with:\n          path: ~\/\.cache\/ci-downloads\/agave-4\.4\.0\.tar\.bz2\n          key: [^\n]*\n/, "");
  assert.notEqual(noAgave, gone);
  assert.ok(has(cacheProblems(CI, noAgave), /ci\.yml's pool-solana saves download-agave-4\.4\.0-/));
  // the test-vault steps drifted (another toolchain: rust-cache's key differs)
  const drift = CACHE.replace("rustup toolchain install 1.96.0 --profile minimal\n      - uses: Swatinem", "rustup toolchain install 1.97.1 --profile minimal\n      - uses: Swatinem");
  assert.notEqual(drift, CACHE);
  assert.ok(has(cacheProblems(CI, drift), /test-vault job does not have ci\.yml's test-vault steps/));
  // a test run in it
  for (const t of ["cargo +1.96.0 test --locked --manifest-path contracts/pool-solana/Cargo.toml", "node --test scripts/ci/x.test.mjs", "pnpm -r test", "forge test --root contracts/pool-evm"]) {
    const ran = CACHE.replace("        run: cargo +1.96.0 test --locked --manifest-path contracts/pool-solana/Cargo.toml --no-run", `        run: ${t}`);
    assert.notEqual(ran, CACHE);
    assert.ok(has(cacheProblems(CI, ran), /ci-cache\.yml's pool-solana runs a test/), t);
  }
  // a save on every run
  const always = CACHE.replace("      - if: steps.gitleaks-tgz.outputs.cache-hit != 'true'\n        uses: actions/cache/save", "      - uses: actions/cache/save");
  assert.notEqual(always, CACHE);
  assert.ok(has(cacheProblems(CI, always), /saves download-gitleaks-.* on every run/));
  // other triggers: a pull request's or the queue's run would save into its own scope and wait in their way
  for (const extra of ["  pull_request:\n", "  merge_group:\n"]) assert.ok(has(cacheProblems(CI, CACHE.replace("  workflow_dispatch:\n", `  workflow_dispatch:\n${extra}`)), /it runs on a push to main and by hand alone/), extra);
  assert.ok(has(cacheProblems(CI, CACHE.replace("    branches: [main]\n  workflow_dispatch:", "  workflow_dispatch:")), /push: any branch/));
  assert.ok(has(cacheProblems(CI, CACHE.replace("name: ci-cache", "name: ci")), /named ci/));
  // the nightly's jobs save their own on main: a new cache in a vault-sandbox job needs no entry here
  assert.deepEqual(cacheProblems(CI.replace("          shared-key: vault-sandbox\n          workspaces: |", "          shared-key: vault-sandbox-2\n          workspaces: |"), CACHE), []);
});
