// SPDX-License-Identifier: Apache-2.0
// scripts/ci/vault-sandbox.mjs: the rule that decides when CI runs the vault's sandbox suite, and its shards. Each
// failure the rule must refuse is planted here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PATHS, ROOT, SHARDS, closure, decide, matches, namedPaths, shardArgs, shardProblems, suiteReads, targets, uncovered } from "./vault-sandbox.mjs";

// What is wrong with ci.yml's vault-sandbox-plan decide step: on a pull request it must run main's copy of the rule
// (extracted from the base into $RUNNER_TEMP/base), never the head's, which the pull request could edit to skip.
function planStepProblems(ci) {
  const job = ci.split(/\n  vault-sandbox-plan:\n/)[1]?.split(/\n  [a-z-]+:\n/)[0];
  if (!job) return ["ci.yml has no vault-sandbox-plan job"];
  const pr = job.match(/\n\s*pull_request\)\n([\s\S]*?);;/)?.[1];
  if (!pr) return ["the decide step has no pull_request arm"];
  const p = [];
  if (!pr.includes('git archive "$BASE" scripts | tar -x -f - -C "$RUNNER_TEMP/base"')) p.push("the pull_request arm does not extract the base's scripts");
  if (!pr.includes('node "$RUNNER_TEMP/base/scripts/ci/vault-sandbox.mjs" decide "$EVENT" "$BASE" "$HEAD"')) p.push("the pull_request arm does not run the base's rule");
  if (/node\s+(\.\/)?scripts\/ci\/vault-sandbox\.mjs/.test(pr)) p.push("the pull_request arm runs the head's rule");
  if (/run=false/.test(pr)) p.push("the pull_request arm can skip on its own");
  return p;
}

test("every file the sandbox suite reads is one the rule runs the suite for", () => {
  const reads = suiteReads();
  assert.ok(reads.includes("contracts/vault/src/lib.rs"));
  for (const f of ["contracts/vault/scripts/deploy.mjs", "scripts/live-checks/vault-testnet-t01.mjs", "apps/helper/src/bind/send.ts", "apps/helper/test/bind-send/carry.ts", "packages/kit/zk/withdraw.vkey", "packages/kit/src/vault/shapes.ts", "packages/kit/test/vectors/vault-v1.json",
    // the kit's entry exports the NEAR pair rule from this file, which imports nothing (covered by packages/kit/src/)
    "packages/kit/src/near/networks.ts",
    // relayer_withdraw.rs: the withdraw relayer's CLI, the send it drives (through its imports) and the fixture
    "apps/helper/test/withdraw-send/carry.ts", "apps/helper/src/withdraw/send.ts", "apps/helper/src/withdraw/checks.ts", "apps/helper/src/withdraw/fee.ts", "contracts/vault/tests/fixtures/withdraw-spends.json"]) {
    assert.ok(reads.includes(f), `the suite reads ${f}, and suiteReads did not find it`);
  }
  assert.deepEqual(uncovered(reads), []);
});

test("planted: a file the suite reads but the rule misses fails", () => {
  const reads = suiteReads();
  for (const gone of ["apps/helper/src/token-status/", "packages/kit/zk/", "scripts/net-window.mjs", "packages/kit/test/vectors/", "apps/helper/src/withdraw/", "apps/helper/test/withdraw-send/"]) {
    const missed = uncovered(reads, PATHS.filter((p) => p !== gone));
    assert.ok(missed.length > 0 && missed.every((f) => f.startsWith(gone)), `without ${gone} the rule still covers ${missed}`);
  }
});

test("planted: a test that starts reading a new file is followed by suiteReads", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vault-sandbox-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), text);
    };
    put("contracts/vault/tests/new.rs", 'let s = repo().join("apps/helper/test/new-send/run.ts");');
    put("apps/helper/test/new-send/run.ts", 'import { x } from "../../src/new/x.ts";\nimport { k } from "@blindfill/kit";');
    put("apps/helper/src/new/x.ts", "export const x = 1;");
    put("packages/kit/package.json", JSON.stringify({ name: "@blindfill/kit", exports: { ".": { default: "./src/index.ts" } } }));
    put("packages/kit/src/index.ts", 'export * from "./vault/shapes.ts";');
    put("packages/kit/src/vault/shapes.ts", "export const k = 1;");
    const files = ["contracts/vault/tests/new.rs", "apps/helper/test/new-send/run.ts", "apps/helper/src/new/x.ts", "packages/kit/package.json", "packages/kit/src/index.ts", "packages/kit/src/vault/shapes.ts"];
    const reads = suiteReads(root, files);
    for (const f of files.filter((f) => !f.endsWith("package.json"))) assert.ok(reads.includes(f), `${f} not followed: ${reads}`);
    assert.deepEqual(uncovered(reads), ["apps/helper/src/new/x.ts", "apps/helper/test/new-send/run.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("include_str! paths count from the file's own directory, joins from the crate", () => {
  const files = ["packages/kit/test/vectors/vault-v1.json", "contracts/vault/scripts/deploy.mjs"];
  assert.deepEqual([...namedPaths('include_str!("../../../packages/kit/test/vectors/vault-v1.json")', files, "contracts/vault/tests")], [files[0]]);
  assert.deepEqual([...namedPaths('join("scripts/deploy.mjs")', files, "contracts/vault/tests")], [files[1]]);
  assert.deepEqual(closure(".", ["no/such/file.mjs"], []), []);
});

test("the decision: a pull request or push runs the suite only when it touches what the suite reads", () => {
  assert.equal(decide("pull_request", ["contracts/vault/src/withdraw.rs"])[0], true);
  assert.equal(decide("push", ["apps/helper/src/bind/send.ts", "README.md"])[0], true);
  assert.equal(decide("pull_request", [".github/workflows/ci.yml"])[0], true);
  assert.equal(decide("pull_request", ["scripts/ci/vault-sandbox.mjs"])[0], true);
  const [run, why] = decide("pull_request", ["apps/terminal/src/App.tsx", "README.md"]);
  assert.equal(run, false);
  assert.match(why, /none of the 2 changed file\(s\)/);
  // unknown changes, and the nightly and manual runs, always run it
  assert.equal(decide("pull_request", null)[0], true);
  assert.equal(decide("schedule", [])[0], true);
  assert.equal(decide("workflow_dispatch", [])[0], true);
  assert.equal(matches("packages/kit/src/index.ts"), true);
  assert.equal(matches("packages/wallet/src/index.ts"), false);
});

test("on a pull request the plan step runs main's rule, never the head's", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(planStepProblems(ci), []);
});

test("planted: a plan step that runs the head's rule on a pull request fails", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  // each plant changes the plan job only (verify-gate and money-gate hold the same lines)
  const at = ci.indexOf("\n  vault-sandbox-plan:\n");
  const plant = (a, b) => ci.slice(0, at) + ci.slice(at).replace(a, b);
  const head = plant('node "$RUNNER_TEMP/base/scripts/ci/vault-sandbox.mjs" decide', "node scripts/ci/vault-sandbox.mjs decide");
  assert.notEqual(head, ci);
  assert.deepEqual(planStepProblems(head), ["the pull_request arm does not run the base's rule", "the pull_request arm runs the head's rule"]);
  const noBase = plant('git archive "$BASE" scripts', 'git archive "$HEAD" scripts');
  assert.ok(planStepProblems(noBase).includes("the pull_request arm does not extract the base's scripts"));
  const skips = plant('echo "run=true" >> "$GITHUB_OUTPUT"', 'echo "run=false" >> "$GITHUB_OUTPUT"');
  assert.ok(planStepProblems(skips).includes("the pull_request arm can skip on its own"));
});

test("a copy of the rule outside the checkout reads the change in its working directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-sandbox-base-"));
  try {
    copyFileSync(path.join(ROOT, "scripts/ci/vault-sandbox.mjs"), path.join(dir, "vault-sandbox.mjs"));
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const git = (...a) => execFileSync("git", ["-c", "user.name=ci", "-c", "user.email=ci@example.invalid", ...a], { cwd: repo, encoding: "utf8" }).trim();
    const commit = (f) => {
      mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      writeFileSync(path.join(repo, f), "x\n");
      git("add", "--", f);
      git("commit", "--quiet", "--no-verify", "-m", f);
      return git("rev-parse", "HEAD");
    };
    git("init", "--quiet");
    const c0 = commit("README.md");
    const c1 = commit("contracts/vault/src/lib.rs");
    const c2 = commit("apps/terminal/src/App.tsx");
    const decide = (a, b) => execFileSync("node", [path.join(dir, "vault-sandbox.mjs"), "decide", "pull_request", a, b], { cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
    assert.match(decide(c0, c1), /^run=true: 1 changed file\(s\) the suite reads, first contracts\/vault\/src\/lib\.rs/);
    assert.match(decide(c1, c2), /^run=false: none of the 1 changed file\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every test target is in exactly one shard", () => {
  const all = targets();
  assert.ok(all.includes("lib") && all.includes("s04") && all.includes("relayer_send"), String(all));
  assert.deepEqual(shardProblems(SHARDS, all), []);
  assert.deepEqual(shardArgs(4).slice(0, 3), ["--no-fail-fast", "--lib", "--test"]);
  assert.throws(() => shardArgs(SHARDS.length + 1), /no shard/);
});

test("planted: a test target in no shard, in two, or gone fails", () => {
  const all = targets();
  assert.deepEqual(shardProblems(SHARDS, [...all, "s99"]), ["s99 is in no shard, so CI never runs it"]);
  assert.deepEqual(shardProblems([...SHARDS, ["s04"]], all), [`s04 is in shard 2 and shard ${SHARDS.length + 1}`]);
  assert.deepEqual(shardProblems(SHARDS, all.filter((t) => t !== "smoke")), ["smoke is in a shard but is no test target"]);
});
