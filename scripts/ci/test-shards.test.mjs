// Card ci-test-shards: ci.yml's test work runs as shard jobs (test-*), and the job `test`, a required check of main's
// ruleset, passes only when every shard passed. A required check that is skipped counts as passed, so `test` must run
// whatever its shards ended with, and fail unless each one ended in success: a shard that failed, was skipped or was
// cancelled fails it, but for the one skip card ci-pr-light allows: on a pull request, a shard the job `changes`, itself
// passed, said false for. This reads ci.yml, replays test's own step under bash with each planted ending, and plants each
// way the wiring can break. It also holds scripts/ci/test-shards.mjs's split of the terminal's browser runs.
//   node --test scripts/ci/test-shards.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync as realpath, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  e2ePart, listedSeconds, mutantCommands, mutantParts, mutantsPart, packageItems, packageKey, packageParts, packagesPart, runPart, selectedPackages, staleWarning,
  testFilters, typecheckArgs, unnamedMutantFiles, MAX_SWEEP_SECONDS, MUTANT_SECONDS, NEW_PACKAGE_SECONDS, NEW_SWEEP_SECONDS, PACKAGE_PART_BUDGET_SECONDS,
  PACKAGE_SECONDS, PART_BUDGET_SECONDS, STALE_FACTOR,
} from "./test-shards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CI = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
const E2E = JSON.parse(readFileSync(path.join(ROOT, "apps/terminal/package.json"), "utf8")).scripts["test:e2e"];

// { name: text } of every job in a workflow (two-space keys under `jobs:`)
function jobs(ci) {
  const body = ci.split(/\njobs:\n/)[1] ?? "";
  const out = {};
  const parts = body.split(/^ {2}([a-z0-9_-]+):\s*$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

// the run text of a job's step whose name is `name`: one line, or a `run: |` block without its indent
function stepRun(job, name) {
  const lines = job.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) return null;
  const indent = lines[at].indexOf("-");
  for (let i = at + 1; i < lines.length && (!lines[i].trim() || lines[i].indexOf(lines[i].trim()) > indent); i++) {
    const m = /^( *)run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!/^[|>]-?\s*$/.test(m[2])) return m[2];
    const block = [];
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].indexOf(lines[j].trim()) > m[1].length); j++) block.push(lines[j]);
    const pad = Math.min(...block.filter((l) => l.trim()).map((l) => l.indexOf(l.trim())));
    return block.map((l) => l.slice(pad)).join("\n");
  }
  return null;
}

// test's step as GitHub runs it (bash -e -o pipefail), with NEEDS as toJSON(needs) gives it: its exit status
function replay(run, needs, event = "pull_request") {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], {
    env: { PATH: process.env.PATH, EVENT: event, NEEDS: JSON.stringify(needs, null, 2) },
    encoding: "utf8",
  }).status;
}

// card ci-fast-checks-on-the-pr: the mutant sweeps run nightly on main and by hand only, never on a pull request, a
// queue group or a push, and the required check test never waits on them
const NIGHTLY = "test-mutants";
const NIGHTLY_IF = "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";

export function shardProblems(ci) {
  const all = jobs(ci);
  const shards = Object.keys(all).filter((j) => j.startsWith("test-") && j !== NIGHTLY);
  const job = all.test;
  if (!job) return ["ci.yml has no job named test"];
  if (!shards.length) return ["ci.yml has no shard job (test-*)"];
  const p = [];
  const needs = /^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(job)?.[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (!needs) p.push("test has no one-line needs: [...] list");
  for (const s of shards) if (needs && !needs.includes(s)) p.push(`test does not need ${s}`);
  if (needs?.includes(NIGHTLY)) p.push(`test needs ${NIGHTLY}, the nightly sweeps: every pull request would wait on them`);
  for (const n of needs ?? []) if (!shards.includes(n) && n !== "changes" && n !== NIGHTLY) p.push(`test needs ${n}, which is no shard job (test-*)`);
  if (needs && !needs.includes("changes")) p.push("test does not need changes, so it cannot tell a planned skip from a lost shard");
  if (!/^ {4}if:.*\balways\(\)/m.test(job)) p.push("test's if has no always(): a failed shard would skip test, and a skipped required check passes");
  const nightly = all[NIGHTLY];
  if (nightly) {
    if (!nightly.split("\n").includes(NIGHTLY_IF)) p.push(`${NIGHTLY}'s if is not the nightly-and-by-hand one, exactly: ${NIGHTLY_IF.trim()}`);
    // the changes job skips a scheduled run, and a job that needs a skipped one is skipped with it
    if (/^ {4}needs:/m.test(nightly)) p.push(`${NIGHTLY} needs another job, so the nightly run can skip it`);
  }
  if (!/^on:\n(?: .*\n|\s*\n)*? {2}schedule:\n {4}- cron: "[^"]+"\n/m.test(ci)) p.push("ci.yml has no nightly schedule, so the mutant sweeps never run");
  if (!/^on:\n(?: .*\n|\s*\n)*? {2}workflow_dispatch:/m.test(ci)) p.push("ci.yml has no workflow_dispatch, so the mutant sweeps cannot run by hand");
  for (const [name, text] of Object.entries(all)) {
    if (name !== "test" && name !== NIGHTLY && !shards.includes(name)) continue;
    if (/continue-on-error/.test(text)) p.push(`${name} has continue-on-error`);
    if (name !== "test" && !/^ {4}timeout-minutes:\s*\d+\s*$/m.test(text)) p.push(`${name} has no timeout of its own`);
  }
  if (!/^ {10}NEEDS: \$\{\{ toJSON\(needs\) \}\}$/m.test(job)) p.push("test's step does not read NEEDS from toJSON(needs)");
  if (!/^ {10}EVENT: \$\{\{ github\.event_name \}\}$/m.test(job)) p.push("test's step does not read EVENT from github.event_name");
  const run = stepRun(job, "every shard passed");
  if (!run) return [...p, "test has no step named \"every shard passed\""];
  // the shards each ended `result` but the first, which ended `first`; the changes job ended `plan`, saying `say` for
  // the first shard and "true" for every other
  const list = (needs ?? shards).filter((s) => s !== "changes");
  const flag = (s) => s.replaceAll("-", "_");
  const ended = (first, { plan = "success", say = "true" } = {}) => ({
    changes: { result: plan, outputs: Object.fromEntries(list.map((s, i) => [flag(s), i === 0 ? say : "true"])) },
    ...Object.fromEntries(list.map((s, i) => [s, { result: i === 0 ? first : "success", outputs: {} }])),
  });
  if (replay(run, ended("success")) !== 0) p.push("test fails when every shard passed");
  for (const r of ["failure", "skipped", "cancelled"]) if (replay(run, ended(r)) === 0) p.push(`test passes when a shard is ${r}`);
  // each shard on its own, so a step that reads past one (test-packages, say) is caught, not only the first
  for (const s of list) {
    const one = ended("success");
    one[s] = { result: "failure", outputs: {} };
    if (replay(run, one) === 0) p.push(`test passes when ${s} is failure`);
  }
  if (replay(run, {}) === 0) p.push("test passes with no shard at all");
  if (replay(run, { changes: ended("success").changes }) === 0) p.push("test passes with no shard at all");
  // card ci-pr-light: the planned skip passes on a pull request, and nowhere else
  if (replay(run, ended("skipped", { say: "false" })) !== 0) p.push("test fails a pull request whose shard the changes job planned to skip");
  for (const ev of ["merge_group", "push", "workflow_dispatch"]) if (replay(run, ended("skipped", { say: "false" }), ev) === 0) p.push(`test passes a skipped shard on ${ev}, which runs every job`);
  for (const say of ["", "maybe", "False", "false "]) if (replay(run, ended("skipped", { say })) === 0) p.push(`test passes a skipped shard the changes job said "${say}" for`);
  // PR #549's first run: changes passed with no output at all ({}), and every gated shard was skipped
  const empty = ended("skipped", { say: "false" });
  empty.changes.outputs = {};
  if (replay(run, empty) === 0) p.push("test passes a skipped shard when the changes job wrote no plan");
  for (const plan of ["failure", "skipped", "cancelled"]) {
    if (replay(run, ended("success", { plan })) === 0) p.push(`test passes when the changes job is ${plan}`);
    if (replay(run, ended("skipped", { plan, say: "false" })) === 0) p.push(`test passes a planned skip when the changes job is ${plan}`);
  }
  const browser = all["test-browser"];
  if (!browser) p.push("ci.yml has no test-browser shard for the terminal's browser runs");
  else {
    if (!/^ {10}INDEX: \$\{\{ strategy\.job-index \}\}$/m.test(browser) || !/^ {10}TOTAL: \$\{\{ strategy\.job-total \}\}$/m.test(browser)) {
      p.push("test-browser does not take its part from strategy.job-index and strategy.job-total");
    }
    if (!browser.includes('node scripts/ci/test-shards.mjs e2e "$INDEX" "$TOTAL"')) p.push("test-browser does not run scripts/ci/test-shards.mjs e2e \"$INDEX\" \"$TOTAL\"");
  }
  p.push(...mutantJobProblems(all, ci, mutantCommands(ROOT)));
  return p;
}

// card ci-mutants-sharded: test-mutants runs the split across its matrix, enough parts that the heaviest is planned
// inside PART_BUDGET_SECONDS, and no line runs a test:mutants script besides (card held-move-forgotten-tx: the wallet's,
// run whole in test-wallet outside the split and its budget, took that job past its 15 minutes on PR #474)
function mutantJobProblems(all, ci, commands) {
  const p = [];
  const mutants = all["test-mutants"];
  if (!mutants) return ["ci.yml has no test-mutants shard for the mutant sweeps"];
  if (!/^ {10}INDEX: \$\{\{ strategy\.job-index \}\}$/m.test(mutants) || !/^ {10}TOTAL: \$\{\{ strategy\.job-total \}\}$/m.test(mutants)) {
    p.push("test-mutants does not take its part from strategy.job-index and strategy.job-total");
  }
  if (!/^ {8}run: node scripts\/ci\/test-shards\.mjs mutants "\$INDEX" "\$TOTAL"$/m.test(mutants)) p.push("test-mutants does not run scripts/ci/test-shards.mjs mutants \"$INDEX\" \"$TOTAL\"");
  const parts = /^ {8}part:\s*\[([^\]]*)\]\s*$/m.exec(mutants)?.[1].split(",").map((s) => s.trim());
  if (!parts?.length || parts.some((s, i) => s !== String(i + 1))) p.push("test-mutants has no matrix part: [1, ..., N]");
  else {
    try {
      const worst = Math.max(...mutantParts(commands, parts.length).map((x) => x.seconds));
      if (worst > PART_BUDGET_SECONDS) p.push(`test-mutants' heaviest of ${parts.length} part(s) is planned at ${worst} s, over ${PART_BUDGET_SECONDS} s: add a part`);
    } catch (e) {
      p.push(`test-mutants: ${e.message}`);
    }
  }
  // any line that is not a comment, in any form a runner takes (pnpm --filter, pnpm -C, npm run, a run: | block):
  // the split's own line names no test:mutants, so each such line runs sweeps twice (review 5, item 3)
  if (ci.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && /\btest:mutants\b/.test(l))) p.push("a ci.yml line runs a test:mutants script beside the split: its sweeps run twice, outside the split's budget");
  return p;
}

test("ci.yml: test needs every shard and passes only when each one passed", () => {
  assert.deepEqual(shardProblems(CI), []);
});

// each way the wiring can break, planted in a copy of this ci.yml
const PLANTED = {
  "a shard missing from test's needs": [/needs: \[([^\]]*), test-vault\]/, "needs: [$1]", "test does not need test-vault"],
  "test without always()": [/if: always\(\) && github\.event_name != 'schedule'\n(\s+runs-on: ubuntu-24\.04\n\s+timeout-minutes: 5)/, "if: github.event_name != 'schedule'\n$1", "test's if has no always()"],
  "a skipped shard read as passed": ['.value.result == "success" or', '.value.result == "success" or .value.result == "skipped" or', "test passes when a shard is skipped"],
  "a failed shard read as passed": ['.value.result == "success" or', '.value.result != "cancelled" or', "test passes when a shard is failure"],
  // card ci-pr-light: each way the planned skip can widen
  "a planned skip on any event": ['$event == "pull_request" and ', "", "test passes a skipped shard on merge_group"],
  "a skip the plan did not say": [' and $plan[(.key | gsub("-"; "_"))] == "false"', "", 'test passes a skipped shard the changes job said ""'],
  "a skip on any plan but true": ['$plan[(.key | gsub("-"; "_"))] == "false"', '$plan[(.key | gsub("-"; "_"))] != "true"', "test passes a skipped shard when the changes job wrote no plan"],
  "a skip read from a plan that did not pass": ['.changes.result == "success" and ', "", "test passes when the changes job is failure"],
  "test without the changes job": ["needs: [changes, test-wallet,", "needs: [test-wallet,", "test does not need changes"],
  "test without the event": ["          EVENT: ${{ github.event_name }}\n          NEEDS: ${{ toJSON(needs) }}", "          NEEDS: ${{ toJSON(needs) }}", "test's step does not read EVENT"],
  "a step that passes on anything": ['|| { echo "a shard did not pass"; exit 1; }', "|| true", "test passes when a shard is failure"],
  "a shard that may fail": [/(\n  test-scripts:\n)/, "$1    continue-on-error: true\n", "test-scripts has continue-on-error"],
  "a step that may fail in a shard": ["      - name: the EVM pool's tests\n", "      - name: the EVM pool's tests\n        continue-on-error: true\n", "test-scripts has continue-on-error"],
  "a Foundry install that may fail": ["      - name: Foundry v1.7.1\n", "      - name: Foundry v1.7.1\n        continue-on-error: true\n", "test-scripts has continue-on-error"],
  "a shard with no timeout": [/(\n  test-vault:\n(?:.*\n){3}) {4}timeout-minutes: \d+\n/, "$1", "test-vault has no timeout of its own"],
  "a browser part count set by hand": [/(this part's share\n {8}env:\n {10}INDEX: \$\{\{ strategy\.job-index \}\}\n {10})TOTAL: \$\{\{ strategy\.job-total \}\}(\n {8}run: \|)/, "$1TOTAL: 2$2", "test-browser does not take its part"],
  "a mutant part count set by hand": [/(this part's share\n {8}env:\n {10}INDEX: \$\{\{ strategy\.job-index \}\}\n {10})TOTAL: \$\{\{ strategy\.job-total \}\}(\n {8}run: node)/, "$1TOTAL: 4$2", "test-mutants does not take its part"],
  "the mutant sweeps run whole in every part": ['run: node scripts/ci/test-shards.mjs mutants "$INDEX" "$TOTAL"', "run: pnpm -r --filter '!@blindfill/wallet' --if-present --no-bail run test:mutants", "test-mutants does not run scripts/ci/test-shards.mjs mutants"],
  "the whole sweep run again beside the split": ["      - name: the wallet package's test script\n", "      - run: pnpm -r --if-present run test:mutants\n      - name: the wallet package's test script\n", "a ci.yml line runs a test:mutants script beside the split"],
  "the wallet's sweeps run again in test-wallet": ["        run: pnpm --filter @blindfill/wallet run test\n", "        run: pnpm --filter @blindfill/wallet run test\n      - name: the wallet package's test:mutants script\n        run: pnpm --filter @blindfill/wallet run test:mutants\n", "a ci.yml line runs a test:mutants script beside the split"],
  "the wallet's sweeps by pnpm --filter, no run": ["        run: pnpm --filter @blindfill/wallet run test\n", "        run: pnpm --filter @blindfill/wallet run test\n      - run: pnpm --filter @blindfill/wallet test:mutants\n", "a ci.yml line runs a test:mutants script beside the split"],
  "the wallet's sweeps by pnpm -C": ["        run: pnpm --filter @blindfill/wallet run test\n", "        run: pnpm --filter @blindfill/wallet run test\n      - run: pnpm -C packages/wallet test:mutants\n", "a ci.yml line runs a test:mutants script beside the split"],
  "the wallet's sweeps by npm in a run block": ["        run: pnpm --filter @blindfill/wallet run test\n", "        run: pnpm --filter @blindfill/wallet run test\n      - run: |\n          cd packages/wallet && npm run test:mutants\n", "a ci.yml line runs a test:mutants script beside the split"],
  "too few mutant parts for the budget": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1]", "test-mutants' heaviest of 1 part(s) is planned at"],
  "five mutant parts once the wallet's sweeps joined": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 3, 4, 5]", "test-mutants' heaviest of 5 part(s) is planned at"],
  "seven mutant parts once the rent back's sweep grew": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 3, 4, 5, 6, 7]", "test-mutants' heaviest of 7 part(s) is planned at"],
  "eight mutant parts once the sell's deposit back floor grew the rent back": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 3, 4, 5, 6, 7, 8]", "test-mutants' heaviest of 8 part(s) is planned at"],
  // card ci-mutant-shards-true-times: nine parts planned 536 s by the table that had gone stale; the true one plans 780 s there
  "nine mutant parts, the count before the table read the true times": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 3, 4, 5, 6, 7, 8, 9]", "test-mutants' heaviest of 9 part(s) is planned at"],
  "thirteen mutant parts, one short of the budget": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]", "test-mutants' heaviest of 13 part(s) is planned at"],
  "fourteen mutant parts, the count before the rent back's sweep grew to 121": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]", "test-mutants' heaviest of 14 part(s) is planned at"],
  "fifteen mutant parts, one short of the budget": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]", "test-mutants' heaviest of 15 part(s) is planned at"],
  "a mutant matrix that skips a part": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [1, 2, 4]", "test-mutants has no matrix part"],
  "more mutant parts than sweeps": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]/, "$1part: [" + Array.from({ length: 60 }, (_, i) => i + 1).join(", ") + "]", "test-mutants: the sweeps are"],
  "no test-mutants job": [/\n {2}test-mutants:\n/, "\n  test-mutantz:\n", "ci.yml has no test-mutants shard"],
  "a shard job left out of the list": [/(\n {2}test:\n)/, "\n  test-extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: \"true\"\n$1", "test does not need test-extra"],
  // card ci-fast-checks-on-the-pr: the sweeps stay nightly, test never waits on them, and a package job's failure fails test
  "the sweeps on pull_request": [NIGHTLY_IF + "\n", NIGHTLY_IF + " || github.event_name == 'pull_request'\n", "test-mutants's if is not the nightly-and-by-hand one"],
  "the sweeps back on every event but the nightly": [NIGHTLY_IF + "\n", "    needs: changes\n    if: github.event_name != 'schedule' && (github.event_name != 'pull_request' || needs.changes.outputs.test_mutants != 'false')\n", "test-mutants's if is not the nightly-and-by-hand one"],
  "the sweeps on push": [NIGHTLY_IF + "\n", "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'\n", "test-mutants's if is not the nightly-and-by-hand one"],
  "the sweeps needing the changes job, which skips the nightly": [NIGHTLY_IF + "\n", "    needs: changes\n" + NIGHTLY_IF + "\n", "test-mutants needs another job"],
  "test waiting on the sweeps again": ["needs: [changes, test-wallet, test-packages,", "needs: [changes, test-wallet, test-packages, test-mutants,", "test needs test-mutants, the nightly sweeps"],
  "a nightly sweep that may fail": [NIGHTLY_IF + "\n", NIGHTLY_IF + "\n    continue-on-error: true\n", "test-mutants has continue-on-error"],
  "no nightly schedule": [/\n {2}schedule:\n {4}- cron: "[^"]+"\n/, "\n", "ci.yml has no nightly schedule"],
  "no run by hand": ["\n  workflow_dispatch:\n", "\n", "ci.yml has no workflow_dispatch"],
  "test passing while test-packages failed": ['select(.key != "changes")', 'select(.key != "changes" and .key != "test-packages")', "test passes when test-packages is failure"],
  "test-packages left out of test's needs": ["test-wallet, test-packages, test-browser", "test-wallet, test-browser", "test does not need test-packages"],
};
for (const [name, [from, to, want]] of Object.entries(PLANTED)) {
  test(`planted: ${name} fails`, () => {
    const planted = CI.replace(from, to);
    assert.notEqual(planted, CI, `the plant for "${name}" matched nothing in ci.yml`);
    const found = shardProblems(planted);
    assert.ok(found.some((f) => f.startsWith(want)), `want "${want}", found: ${JSON.stringify(found)}`);
  });
}

test("the browser runs: the build in every part, each later command in exactly one, for 1 to 4 parts", () => {
  const [build, ...runs] = E2E.split("&&").map((c) => c.trim());
  assert.match(build, /^vite build$/);
  for (let total = 1; total <= 4; total++) {
    const seen = [];
    for (let index = 0; index < total; index++) {
      const [first, ...mine] = e2ePart(E2E, index, total).split(" && ");
      assert.equal(first, build);
      assert.ok(mine.length > 0, `part ${index} of ${total} runs nothing but the build`);
      seen.push(...mine);
    }
    assert.deepEqual(seen.toSorted(), runs.toSorted(), `${total} parts`);
  }
});

test("planted: a chain the split cannot read, a part with nothing to run, and a part out of range are refused", () => {
  for (const [script, index, total, want] of [
    ["vite build && node a.mjs || node b.mjs && node c.mjs", 0, 1, /not a plain a && b chain/],
    ["vite build && node a.mjs; node b.mjs", 0, 1, /not a plain a && b chain/],
    ["vite build && node a.mjs | tee x && node b.mjs", 0, 1, /not a plain a && b chain/],
    ["vite build && node a.mjs & node b.mjs", 0, 1, /not a plain a && b chain/],
    ["vite build && node $(echo a.mjs)", 0, 1, /not a plain a && b chain/],
    ["vite build &&  && node a.mjs", 0, 1, /empty command/],
    ["vite build && node a.mjs && node b.mjs", 0, 3, /fewer than 3 parts/],
    ["vite build && node a.mjs && node b.mjs", 2, 2, /not a part of 2/],
    ["vite build && node a.mjs && node b.mjs", -1, 2, /not a part of 2/],
    ["vite build && node a.mjs && node b.mjs", 0, 0, /not a count of parts/],
    ["vite build && node a.mjs && node b.mjs", Number.NaN, 2, /not a part of 2/],
    [undefined, 0, 1, /no test:e2e script/],
  ]) {
    assert.throws(() => e2ePart(script, index, total), want, `${script} ${index}/${total}`);
  }
  assert.equal(e2ePart("vite build && node a.mjs && node b.mjs && node c.mjs", 1, 2), "vite build && node b.mjs");
});

test("the command line: a missing or non-number part is refused with exit 1", () => {
  const script = path.join(ROOT, "scripts/ci/test-shards.mjs");
  for (const args of [["e2e", "", ""], ["e2e", "0"], ["e2e", "x", "2"], ["e2e", "0", "2.5"], ["other", "0", "1"]]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
    assert.equal(r.stdout, "");
  }
  const ok = spawnSync(process.execPath, [script, "e2e", "0", "1"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), E2E.split("&&").map((c) => c.trim()).join(" && "));
});

// card ci-mutants-sharded: the mutant sweeps' split. SWEEPS is read here from git's own list of package.json files,
// apart from the split's reader, so a reader that misses a package fails against it.
const key = (c) => `${c.dir}: ${c.command}`;
function sweepsFromGit(root) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ":(glob)apps/*/package.json", ":(glob)packages/*/package.json"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean).toSorted();
  return files.flatMap((f) => {
    const { name, scripts } = JSON.parse(readFileSync(path.join(root, f), "utf8"));
    const script = scripts?.["test:mutants"];
    if (!script) return [];
    return script.split(" && ").map((command) => ({ dir: path.posix.dirname(f), name, command: command.trim() }));
  });
}
const SWEEPS = sweepsFromGit(ROOT);

// each sweep in exactly one part of every total from 1 to one part per sweep, no part empty, and no sweep that is not
// one; split(index, total) is the split under test
function splitProblems(sweeps, split) {
  const p = [];
  const want = new Set(sweeps.map(key));
  for (let total = 1; total <= sweeps.length; total++) {
    const parts = Array.from({ length: total }, (_, i) => {
      try {
        return split(i, total).map(key);
      } catch (e) {
        p.push(`part ${i} of ${total}: ${e.message}`);
        return [];
      }
    });
    for (const [i, part] of parts.entries()) if (!part.length) p.push(`part ${i} of ${total} runs nothing`);
    for (const k of want) {
      const n = parts.flat().filter((x) => x === k).length;
      if (n !== 1) p.push(`${k} runs in ${n} part(s) of ${total}`);
    }
    for (const k of new Set(parts.flat())) if (!want.has(k)) p.push(`${k} is no sweep, in a part of ${total}`);
  }
  return p;
}

test("the mutant sweeps: the split reads every package's test:mutants, each command in its package's folder", () => {
  assert.ok(SWEEPS.length >= 2, "this tree has mutant sweeps to split");
  assert.deepEqual(mutantCommands(ROOT), SWEEPS);
  // card held-move-forgotten-tx: the wallet's sweeps run in the split, under its budget, never whole in a job of their own
  const wallet = JSON.parse(readFileSync(path.join(ROOT, "packages/wallet/package.json"), "utf8")).scripts["test:mutants"].split(" && ").map((c) => `packages/wallet: ${c.trim()}`);
  assert.deepEqual(SWEEPS.filter((c) => c.dir === "packages/wallet").map(key), wallet);
});

test("the measured times: every sweep of this tree has one, so the budget check plans real seconds", () => {
  assert.deepEqual(SWEEPS.map(key).filter((k) => !Object.hasOwn(MUTANT_SECONDS, k)), [], "a sweep with no MUTANT_SECONDS time: read it off its CI log and add it");
});

test("the mutant sweeps: the union of all parts is every command, each in exactly one part, for every count of parts", () => {
  assert.deepEqual(splitProblems(SWEEPS, (i, n) => mutantsPart(SWEEPS, i, n)), []);
  for (let total = 1; total <= SWEEPS.length; total++) {
    const parts = mutantParts(SWEEPS, total);
    assert.deepEqual(parts.map((x) => x.commands), parts.map((_, i) => mutantsPart(SWEEPS, i, total)));
    assert.equal(parts.reduce((s, x) => s + x.seconds, 0), SWEEPS.reduce((s, c) => s + (MUTANT_SECONDS[key(c)] ?? NEW_SWEEP_SECONDS), 0));
  }
});

test("planted: a command added to any package's test:mutants, or a new package's, lands in exactly one part", () => {
  const added = [...new Set(SWEEPS.map((c) => c.dir)), "packages/new"].map((dir) => ({ dir, name: dir, command: "node --test test/new-mutants.test.mjs" }));
  for (const c of added) {
    const sweeps = [...SWEEPS, c];
    assert.deepEqual(splitProblems(sweeps, (i, n) => mutantsPart(sweeps, i, n)), [], key(c));
  }
  const all = [...SWEEPS, ...added];
  assert.deepEqual(splitProblems(all, (i, n) => mutantsPart(all, i, n)), []);
});

test("planted: a part added to the matrix drops nothing and doubles nothing; past one part per sweep it is refused", () => {
  const n = Number(/\n {2}test-mutants:\n(?:.*\n)*? {8}part: \[([^\]]*)\]/.exec(CI)[1].split(",").length);
  for (const total of [n, n + 1]) {
    const seen = Array.from({ length: total }, (_, i) => mutantsPart(SWEEPS, i, total)).flat().map(key);
    assert.deepEqual(seen.toSorted(), SWEEPS.map(key).toSorted(), `${total} parts`);
  }
  const more = CI.replace(/(\n {6}matrix:\n {8}part: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)\]/, `$1, 17]`);
  assert.notEqual(more, CI);
  assert.deepEqual(shardProblems(more), []);
  assert.throws(() => mutantsPart(SWEEPS, 0, SWEEPS.length + 1), /fewer than/);
  assert.throws(() => mutantsPart(SWEEPS, 4, 4), /not a part of 4/);
  assert.throws(() => mutantsPart(SWEEPS, -1, 4), /not a part of 4/);
  assert.throws(() => mutantsPart(SWEEPS, 0, 0), /not a count of parts/);
  assert.throws(() => mutantsPart([], 0, 1), /no workspace package/);
});

test("planted: a split that misses a package, drops, doubles or moves a command fails", () => {
  const last = SWEEPS.at(-1);
  const pkg = SWEEPS[0].dir;
  for (const [name, split, want] of [
    ["a package missed", (i, n) => mutantsPart(SWEEPS.filter((c) => c.dir !== pkg), i, n), `${pkg}: `],
    ["the last command dropped", (i, n) => mutantsPart(SWEEPS, i, n).filter((c) => c !== last), key(last)],
    ["a command in every part", (i, n) => [...new Set([...mutantsPart(SWEEPS, i, n), last])], `${key(last)} runs in`],
    ["a command in another folder", (i, n) => mutantsPart(SWEEPS, i, n).map((c) => (c === last ? { ...c, dir: "." } : c)), `${key(last)} runs in 0`],
  ]) {
    const found = splitProblems(SWEEPS, split);
    assert.ok(found.some((f) => f.startsWith(want)), `${name}: want "${want}", found ${JSON.stringify(found)}`);
  }
});

test("planted: the split's reader takes every workspace package's test:mutants", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-shards-mutants-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    const pkg = (name, mutants) => JSON.stringify({ name, scripts: { test: "node --test", ...(mutants === undefined ? {} : { "test:mutants": mutants }) } });
    put("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "packages/*"\nminimumReleaseAge: 10080\n');
    put("package.json", pkg("root", "node root-mutants.mjs"));
    put("packages/a/package.json", pkg("@x/a", 'node --test "test/mutants/*.test.mjs" && node test/q-mutants.mjs'));
    put("apps/b/package.json", pkg("b", "node --test test/b-mutants.test.mjs"));
    put("packages/n/package.json", pkg("@x/n"));
    put("packages/w/package.json", pkg("@blindfill/wallet", "FULL_RUNS=1 node --test test/w.test.ts"));
    put("other/c/package.json", pkg("c", "node c-mutants.mjs"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    const want = [
      { dir: "apps/b", name: "b", command: "node --test test/b-mutants.test.mjs" },
      { dir: "packages/a", name: "@x/a", command: 'node --test "test/mutants/*.test.mjs"' },
      { dir: "packages/a", name: "@x/a", command: "node test/q-mutants.mjs" },
      { dir: "packages/w", name: "@blindfill/wallet", command: "FULL_RUNS=1 node --test test/w.test.ts" },
    ];
    assert.deepEqual(mutantCommands(dir), want);
    assert.deepEqual(sweepsFromGit(dir), want);
    // a command added to a package's script is read, and lands in exactly one part
    put("packages/a/package.json", pkg("@x/a", 'node --test "test/mutants/*.test.mjs" && node test/q-mutants.mjs && node test/r-mutants.mjs'));
    const more = mutantCommands(dir);
    assert.deepEqual(more.map(key), [...want.slice(0, 3).map(key), "packages/a: node test/r-mutants.mjs", key(want[3])]);
    assert.deepEqual(splitProblems(more, (i, n) => mutantsPart(more, i, n)), []);
    // a script the split cannot read whole is refused, never split wrong
    for (const bad of ["node a.mjs || node b.mjs", "node a.mjs; node b.mjs", "node a.mjs &&  && node b.mjs", ""]) {
      put("apps/b/package.json", pkg("b", bad));
      assert.throws(() => mutantCommands(dir), /apps\/b('s test:mutants is not a plain|'s test:mutants has an empty command| has an empty test:mutants script)/, JSON.stringify(bad));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the measured times: each one names a sweep of this tree, and a stale one fails", () => {
  const stale = (seconds) => Object.keys(seconds).filter((k) => !SWEEPS.some((c) => key(c) === k));
  assert.deepEqual(stale(MUTANT_SECONDS), [], "a MUTANT_SECONDS key in scripts/ci/test-shards.mjs names no sweep: rename it to the sweep's new command, or remove it");
  assert.deepEqual(stale({ ...MUTANT_SECONDS, "packages/kit: node test/gone-mutants.mjs": 10 }), ["packages/kit: node test/gone-mutants.mjs"]);
  for (const [k, s] of Object.entries(MUTANT_SECONDS)) assert.ok(Number.isInteger(s) && s > 0, k);
});

test("a part runs every one of its sweeps in its package's folder, after a failed one too, and reports which failed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-shards-run-"));
  try {
    for (const d of ["packages/a", "apps/b"]) {
      mkdirSync(path.join(dir, d), { recursive: true });
      writeFileSync(path.join(dir, d, "package.json"), JSON.stringify({ name: d }));
    }
    const lines = [];
    const ran = runPart([
      { dir: "packages/a", command: "pwd > ran.txt && exit 3" },
      { dir: "apps/b", command: "pwd > ran.txt" },
    ], dir, (l) => lines.push(l));
    assert.deepEqual(ran.map((r) => [r.dir, r.ok]), [["packages/a", false], ["apps/b", true]]);
    for (const d of ["packages/a", "apps/b"]) {
      assert.equal(readFileSync(path.join(dir, d, "ran.txt"), "utf8").trim(), path.join(realpath(dir), d));
    }
    assert.ok(lines.some((l) => /failed \(exit 3\) in [\d.]+ s: packages\/a: /.test(l)), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mutants command line: a missing, non-number or out-of-range part is refused with exit 1 and runs nothing", () => {
  const script = path.join(ROOT, "scripts/ci/test-shards.mjs");
  for (const args of [["mutants"], ["mutants", "0"], ["mutants", "x", "4"], ["mutants", "4", "4"], ["mutants", "0", "0"], ["mutants", "0", "99"]]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
    assert.equal(r.stdout, "");
  }
});

// ---- card ci-mutant-shards-true-times

// every sweep command's listed seconds, and a stale-table warning on a sweep that ran long

const overlong = (seconds) => Object.entries(seconds).filter(([, n]) => n > MAX_SWEEP_SECONDS).map(([k]) => k);

test("no sweep is listed over 300 s, and a sweep listed over it is named (planted)", () => {
  assert.equal(MAX_SWEEP_SECONDS, 300);
  assert.deepEqual(overlong(MUTANT_SECONDS), [], "a sweep over 300 s fills a part alone on a slow runner: run it in parts (<k>/<n>, scripts/mutant-part.mjs)");
  assert.deepEqual(overlong({ ...MUTANT_SECONDS, "packages/kit: node test/new.mjs": 301 }), ["packages/kit: node test/new.mjs"]);
  assert.deepEqual(overlong({ a: 300, b: 299 }), []);
  // the budget and the table together: the heaviest part of the matrix ci.yml lists is inside it
  assert.equal(PART_BUDGET_SECONDS, 540);
  const parts = Number(/\n {2}test-mutants:\n(?:.*\n)*? {8}part: \[([^\]]*)\]/.exec(CI)[1].split(",").length);
  assert.ok(Math.max(...mutantParts(SWEEPS, parts).map((x) => x.seconds)) <= PART_BUDGET_SECONDS);
  assert.ok(Math.max(...mutantParts(SWEEPS, parts - 1).map((x) => x.seconds)) > PART_BUDGET_SECONDS, "a part fewer would also fit: the matrix lists more parts than it needs");
});

test("a stale table shows itself: a sweep past 1.25 times its listed seconds prints a ::warning:: naming it, the listed and the measured time", () => {
  const c = { dir: "packages/a", name: "a", command: "node s.mjs 1/2" };
  const table = { "packages/a: node s.mjs 1/2": 100 };
  assert.equal(STALE_FACTOR, 1.25);
  assert.equal(staleWarning(c, 125, table), null, "exactly 1.25 times is no warning");
  assert.equal(staleWarning(c, 99, table), null);
  const w = staleWarning(c, 125.1, table);
  assert.match(w, /^::warning::packages\/a: node s\.mjs 1\/2 took 125\.1 s, listed 100 s: /);
  // a sweep with no listed time is planned at NEW_SWEEP_SECONDS and says so
  assert.equal(staleWarning({ ...c, command: "node new.mjs" }, NEW_SWEEP_SECONDS * 1.25, table), null);
  assert.match(staleWarning({ ...c, command: "node new.mjs" }, NEW_SWEEP_SECONDS * 1.25 + 1, table), /took 251 s, no listed time, planned at 200 s/);
  // the data of a workflow command escapes %, CR and LF, so a sweep's text cannot end the annotation or start a command
  const evil = staleWarning({ dir: "packages/a", command: "echo 100%\r\n::error::x" }, 1000, table);
  assert.ok(!/[\r\n]/.test(evil) && evil.includes("100%25%0D%0A::error::x"), evil);
});

test("a part prints the warning after the slow sweep's own line, never fails on it, and says nothing for a sweep inside its time (fake clock)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-shards-clock-"));
  try {
    mkdirSync(path.join(dir, "packages/a"), { recursive: true });
    writeFileSync(path.join(dir, "packages/a/package.json"), JSON.stringify({ name: "a" }));
    const cmds = [
      { dir: "packages/a", command: "true" },
      { dir: "packages/a", command: "exit 3" },
      { dir: "packages/a", command: "true && true" },
    ];
    // the clock answers a start and an end per sweep: 100 s (listed 100: no warning), 130 s (listed 100: warning, and the
    // sweep also failed), 400 s (no listed time: planned at 200: warning)
    const times = [0, 100_000, 100_000, 230_000, 230_000, 630_000];
    const clock = () => times.shift();
    const lines = [];
    const ran = runPart(cmds, dir, (l) => lines.push(l), { clock, seconds: { "packages/a: true": 100, "packages/a: exit 3": 100 } });
    assert.deepEqual(ran.map((r) => [r.ok, r.seconds]), [[true, 100], [false, 130], [true, 400]]);
    const warnings = lines.filter((l) => l.startsWith("::warning::"));
    assert.equal(warnings.length, 2, lines.join("\n"));
    assert.match(warnings[0], /packages\/a: exit 3 took 130 s, listed 100 s/);
    assert.match(warnings[1], /packages\/a: true && true took 400 s, no listed time, planned at 200 s/);
    // the warning follows the sweep's own "== failed" line
    assert.ok(lines.findIndex((l) => l.startsWith("== failed")) < lines.indexOf(warnings[0]));
    assert.equal(lines.filter((l) => /^== ok in 100 s: packages\/a: true$/.test(l)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the kit's mutants folder: a test file no test:mutants command names is found; named by path or by glob, it is not (planted)", () => {
  assert.deepEqual(unnamedMutantFiles(ROOT), [], "a file of a test/mutants folder that no test:mutants command runs: add a command for it to the package's script");
  const dir = mkdtempSync(path.join(tmpdir(), "test-shards-files-"));
  try {
    const put = (f, text) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    };
    const pkg = (name, mutants) => JSON.stringify({ name, scripts: { test: "node --test", "test:mutants": mutants } });
    put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    put("packages/k/package.json", pkg("@x/k", "node --test test/mutants/a.test.mjs && MUTANT_PART=1/2 node --test test/mutants/b.test.mjs"));
    put("packages/g/package.json", pkg("@x/g", 'node --test "test/mutants/*.test.mjs"'));
    put("packages/o/package.json", pkg("@x/o", "node --test test/mutants/a.test.mjs"));
    for (const f of ["packages/k/test/mutants/a.test.mjs", "packages/k/test/mutants/b.test.mjs", "packages/g/test/mutants/x.test.mjs", "packages/g/test/mutants/y.test.mjs", "packages/o/test/mutants/a.test.mjs", "packages/o/test/other.test.mjs"]) put(f, "");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    assert.deepEqual(unnamedMutantFiles(dir), []);
    // a new file in each: the glob names it, the paths do not
    put("packages/k/test/mutants/c.test.mjs", "");
    put("packages/g/test/mutants/z.test.mjs", "");
    put("packages/o/test/mutants/c.test.ts", "");
    execFileSync("git", ["add", "."], { cwd: dir });
    assert.deepEqual(unnamedMutantFiles(dir), ["packages/k/test/mutants/c.test.mjs", "packages/o/test/mutants/c.test.ts"]);
    // another package's command naming the same file name vouches for nothing
    put("packages/o/package.json", pkg("@x/o", "node --test test/mutants/a.test.mjs && node --test test/mutants/b.test.mjs"));
    execFileSync("git", ["add", "."], { cwd: dir });
    assert.ok(unnamedMutantFiles(dir).includes("packages/k/test/mutants/c.test.mjs"));
    assert.ok(!unnamedMutantFiles(dir).includes("packages/k/test/mutants/b.test.mjs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the packages' tests: ci.yml's test-packages matrix

const ITEMS = packageItems(ROOT);
const ITEM_COMMANDS = ITEMS.map((i) => ({ dir: "packages", name: packageKey(i), command: packageKey(i), item: i }));

test("the packages' items: each workspace package's test script but the wallet's, and the four steps, each with a measured time", () => {
  const names = ITEMS.filter((i) => i.kind === "tests").map((i) => i.name);
  assert.deepEqual(names.toSorted(), ["@blindfill/exit", "@blindfill/kit", "@confidential-trenches/helper", "signpage", "terminal"]);
  assert.deepEqual(ITEMS.filter((i) => i.kind === "step").map((i) => i.name), ["typecheck", "deploy gate", "live-check replays", "bundle checks"]);
  assert.deepEqual(ITEMS.map(packageKey).filter((k) => !Object.hasOwn(PACKAGE_SECONDS, k)), [], "an item with no PACKAGE_SECONDS time: read it off the test-packages job log and add it");
  assert.deepEqual(Object.keys(PACKAGE_SECONDS).filter((k) => !ITEMS.some((i) => packageKey(i) === k)), [], "a PACKAGE_SECONDS key names no item");
  assert.equal(NEW_PACKAGE_SECONDS, 200);
});

test("the packages' parts: every item in exactly one part, for every count of parts from 1 to one part per item", () => {
  assert.deepEqual(splitProblems(ITEM_COMMANDS, (i, n) => packagesPart(ITEMS, i, n).map((x) => ITEM_COMMANDS.find((c) => c.item === x))), []);
  for (let total = 1; total <= ITEMS.length; total++) {
    const parts = packageParts(ITEMS, total);
    assert.equal(parts.reduce((s, x) => s + x.seconds, 0), ITEMS.reduce((s, i) => s + PACKAGE_SECONDS[packageKey(i)], 0));
    assert.deepEqual(parts.map((x) => x.items), parts.map((_, i) => packagesPart(ITEMS, i, total)));
  }
  assert.throws(() => packagesPart(ITEMS, 0, ITEMS.length + 1), /fewer than/);
  assert.throws(() => packagesPart(ITEMS, 3, 3), /not a part of 3/);
  assert.throws(() => packagesPart([], 0, 1), /no workspace package/);
});

test("planted: a split that leaves a package in no part, puts one in two parts, or runs the typecheck in every part fails", () => {
  const find = (k) => ITEM_COMMANDS.find((c) => packageKey(c.item) === k);
  const own = (i, n) => packagesPart(ITEMS, i, n).map((x) => ITEM_COMMANDS.find((c) => c.item === x));
  const kit = find("tests @blindfill/kit");
  const typecheck = find("typecheck");
  for (const [name, split, want] of [
    ["a package in no part", (i, n) => own(i, n).filter((c) => c !== kit), `${kit.dir}: ${kit.command} runs in 0 part(s)`],
    ["a package in two parts", (i, n) => [...new Set([...own(i, n), ...(i === 0 ? [kit] : [])])], `${kit.dir}: ${kit.command} runs in 2 part(s)`],
    ["the typecheck in every part", (i, n) => [...new Set([...own(i, n), typecheck])], `${typecheck.dir}: ${typecheck.command} runs in`],
    ["a part with nothing to run", (i, n) => (i === 0 && n > 1 ? [] : own(i, n)), "part 0 of 2 runs nothing"],
  ]) {
    const found = splitProblems(ITEM_COMMANDS, split);
    assert.ok(found.some((f) => f.startsWith(want)), `${name}: want "${want}", found ${JSON.stringify(found.slice(0, 4))}`);
  }
});

test("the packages' parts: the heaviest of ci.yml's matrix is planned inside 8 minutes, so 1.5 times slower ends inside 15", () => {
  const job = jobs(CI)["test-packages"];
  const list = /^ {8}part:\s*\[([^\]]*)\]\s*$/m.exec(job)?.[1].split(",").map((x) => x.trim());
  assert.ok(list?.every((x, i) => x === String(i + 1)), "test-packages has a matrix part: [1, ..., N]");
  const worst = Math.max(...packageParts(ITEMS, list.length).map((x) => x.seconds));
  assert.equal(PACKAGE_PART_BUDGET_SECONDS, 480);
  assert.ok(worst <= PACKAGE_PART_BUDGET_SECONDS, `${worst} s over ${PACKAGE_PART_BUDGET_SECONDS} s`);
  assert.ok(worst * 1.5 <= 15 * 60 - 60, `${worst} s on a runner 1.5 times slower`);
  // and the pull request's own job log: the whole was 503 s for the tests and the typecheck, replays and bundle 105 s on top
  assert.ok(ITEMS.reduce((s, i) => s + PACKAGE_SECONDS[packageKey(i)], 0) > PACKAGE_PART_BUDGET_SECONDS, "one part holds them all: the matrix needs no split");
});

// the wiring: each way test-packages can break, planted in a copy of ci.yml
function packageJobProblems(ci) {
  const job = jobs(ci)["test-packages"];
  if (!job) return ["ci.yml has no test-packages shard"];
  const p = [];
  const parts = /^ {8}part:\s*\[([^\]]*)\]\s*$/m.exec(job)?.[1].split(",").map((x) => x.trim());
  if (!parts?.length || parts.some((x, i) => x !== String(i + 1))) p.push("test-packages has no matrix part: [1, ..., N]");
  else {
    try {
      const worst = Math.max(...packageParts(ITEMS, parts.length).map((x) => x.seconds));
      if (worst > PACKAGE_PART_BUDGET_SECONDS) p.push(`test-packages' heaviest of ${parts.length} part(s) is planned at ${worst} s, over ${PACKAGE_PART_BUDGET_SECONDS} s: add a part`);
    } catch (e) {
      p.push(`test-packages: ${e.message}`);
    }
  }
  const stepsOf = (re) => job.split("\n").filter((l) => re.test(l)).length;
  const need = [
    ["plan", 'run: node scripts/ci/test-shards.mjs packages plan "$INDEX" "$TOTAL" >> "$GITHUB_OUTPUT"'],
    ["tests", 'run: node scripts/ci/test-shards.mjs packages tests "$INDEX" "$TOTAL"'],
    ["typecheck", 'run: node scripts/ci/test-shards.mjs packages typecheck "$INDEX" "$TOTAL"'],
  ];
  for (const [what, line] of need) if (!job.split("\n").some((l) => l.trim() === line)) p.push(`test-packages does not run packages ${what} through the split: ${line}`);
  const inputs = job.split("\n").filter((l) => /^ {10}INDEX: \$\{\{ strategy\.job-index \}\}$/.test(l)).length;
  const totals = job.split("\n").filter((l) => /^ {10}TOTAL: \$\{\{ strategy\.job-total \}\}$/.test(l)).length;
  if (inputs !== 3 || totals !== 3) p.push("test-packages takes a part from strategy.job-index and strategy.job-total in fewer than its three split steps");
  for (const [key, cmd] of [["deploy_gate", "node --test apps/terminal/scripts/check-deploy.test.ts"], ["replays", "node --test scripts/live-checks/*.test.mjs"], ["bundle", "pnpm --filter terminal build && node scripts/ci/bundle-checks.mjs"]]) {
    const lines = job.split("\n");
    const at = lines.map((l, i) => (l.trim() === `run: ${cmd}` ? i : -1)).filter((i) => i >= 0);
    if (at.length !== 1) p.push(`test-packages runs "${cmd}" ${at.length} time(s), not once`);
    else if (lines[at[0] - 1]?.trim() !== `if: steps.plan.outputs.${key} == 'true'`) p.push(`test-packages' step "${cmd}" is not gated on the plan's ${key}: it runs in every part`);
  }
  if (stepsOf(/^ {6}- name: which steps this part runs$/) !== 1 || !/^ {8}id: plan$/m.test(job)) p.push("test-packages has no plan step (id: plan)");
  if (/\bpnpm\b.*\brun (test|typecheck)\b/.test(job.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"))) p.push("test-packages runs a package's test or typecheck script beside the split: it runs in more than one part");
  return p;
}

test("ci.yml: test-packages runs its share of the packages' tests, and each fixed step in one part", () => {
  assert.deepEqual(packageJobProblems(CI), []);
  assert.deepEqual(shardProblems(CI), []);
});

const PACKAGE_PLANTED = {
  "a package part count set by hand": [/(this part's share\n {8}env:\n {10}SELECT: [^\n]*tests[^\n]*\n {10}INDEX: \$\{\{ strategy\.job-index \}\}\n {10})TOTAL: \$\{\{ strategy\.job-total \}\}/, "$1TOTAL: 3", "test-packages takes a part from strategy"],
  "one package part": [/(\n {2}test-packages:\n(?:.*\n)*? {8}part: )\[1, 2, 3\]/, "$1[1]", "test-packages' heaviest of 1 part(s) is planned at"],
  "a package matrix that skips a part": [/(\n {2}test-packages:\n(?:.*\n)*? {8}part: )\[1, 2, 3\]/, "$1[1, 3]", "test-packages has no matrix part"],
  "more package parts than items": [/(\n {2}test-packages:\n(?:.*\n)*? {8}part: )\[1, 2, 3\]/, "$1[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]", "test-packages: the packages' items are"],
  "the live-check replays in every part": ["        if: steps.plan.outputs.replays == 'true'\n", "", "it runs in every part"],
  "the bundle checks on the wrong plan key": ["        if: steps.plan.outputs.bundle == 'true'\n", "        if: steps.plan.outputs.replays == 'true'\n", "is not gated on the plan's bundle"],
  "the deploy gate's tests in every part": ["        if: steps.plan.outputs.deploy_gate == 'true'\n", "", "is not gated on the plan's deploy_gate"],
  "the plan step dropped": ["      - name: which steps this part runs\n        id: plan\n", "      - name: which steps this part runs\n", "test-packages has no plan step"],
  "the tests step dropped": ['        run: node scripts/ci/test-shards.mjs packages tests "$INDEX" "$TOTAL"\n', "        run: echo skipped\n", "does not run packages tests through the split"],
  "every package's tests run whole beside the split": ["      - name: the deploy gate's own tests\n", "      - run: pnpm -r --filter '!@blindfill/wallet' --if-present --no-bail run test\n      - name: the deploy gate's own tests\n", "beside the split"],
  "the typecheck run whole beside the split": ["      - name: the deploy gate's own tests\n", "      - run: pnpm -r --if-present run typecheck\n      - name: the deploy gate's own tests\n", "beside the split"],
};
for (const [name, [from, to, want]] of Object.entries(PACKAGE_PLANTED)) {
  test(`planted: ${name} fails`, () => {
    const planted = CI.replace(from, to);
    assert.notEqual(planted, CI, `the plant for "${name}" matched nothing in ci.yml`);
    const found = packageJobProblems(planted);
    assert.ok(found.some((f) => f.startsWith(want) || f.includes(want)), `want "${want}", found: ${JSON.stringify(found)}`);
  });
}

test("the packages' selectors: a part runs the packages pr-paths picked that it holds, none for none, every one for an empty selector", () => {
  const part = packagesPart(ITEMS, 1, 3);
  const mine = part.filter((i) => i.kind === "tests").map((i) => `--filter=${i.name}`);
  assert.ok(mine.length > 0);
  assert.deepEqual(testFilters(part, ""), mine);
  assert.deepEqual(testFilters(part, undefined), mine);
  assert.deepEqual(testFilters(part, "none"), []);
  assert.deepEqual(testFilters(part, mine[0]), [mine[0]]);
  assert.deepEqual(testFilters(part, "--filter=signpage --filter=@nope/x"), part.some((i) => i.name === "signpage") ? ["--filter=signpage"] : []);
  assert.deepEqual(selectedPackages(" --filter=a --filter=@b/c.d "), ["a", "@b/c.d"]);
  for (const bad of ["a", "--filter=!a", "--filter=a;b", "-r", "--filter=a --other", "--filter="]) assert.throws(() => selectedPackages(bad), /neither empty, none nor/, bad);
  // the typecheck: in the one part that has it, all packages or the picked ones, none for none
  for (let total = 1; total <= ITEMS.length; total++) {
    const has = Array.from({ length: total }, (_, i) => typecheckArgs(packagesPart(ITEMS, i, total), "")).filter(Boolean);
    assert.equal(has.length, 1, `${total} parts`);
    assert.deepEqual(has[0], ["-r", "--if-present", "run", "typecheck"]);
  }
  const t = packagesPart(ITEMS, 0, 1);
  assert.deepEqual(typecheckArgs(t, "--filter=a --filter=b"), ["-r", "--filter=a", "--filter=b", "--if-present", "run", "typecheck"]);
  assert.equal(typecheckArgs(t, "none"), null);
});

test("the packages command line: plan names each of the three steps in exactly one part, and a part out of range or a step unknown is refused", () => {
  const script = path.join(ROOT, "scripts/ci/test-shards.mjs");
  const plan = (i, n) => spawnSync(process.execPath, [script, "packages", "plan", String(i), String(n)], { encoding: "utf8" });
  for (const total of [1, 2, 3, 4]) {
    const seen = { deploy_gate: 0, replays: 0, bundle: 0 };
    for (let i = 0; i < total; i++) {
      const r = plan(i, total);
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.trim().split("\n");
      assert.deepEqual(lines.map((l) => l.split("=")[0]), ["deploy_gate", "replays", "bundle"]);
      for (const l of lines) if (l.endsWith("=true")) seen[l.split("=")[0]]++;
      assert.ok(lines.every((l) => /^[a-z_]+=(true|false)$/.test(l)), r.stdout);
    }
    assert.deepEqual(seen, { deploy_gate: 1, replays: 1, bundle: 1 }, `${total} parts`);
  }
  for (const args of [["plan", "3", "3"], ["plan", "x", "3"], ["plan", "0", "0"], ["plan", "0", "99"], ["bogus", "0", "3"], ["tests", "-1", "3"]]) {
    const r = spawnSync(process.execPath, [script, "packages", ...args], { encoding: "utf8" });
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stdout, "");
  }
  // a malformed selector is refused with nothing run
  const bad = spawnSync(process.execPath, [script, "packages", "tests", "0", "3"], { encoding: "utf8", env: { ...process.env, SELECT: "--filter=a;rm" } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /neither empty, none nor/);
  // a selector that keeps nothing of the part runs nothing and passes
  const none = spawnSync(process.execPath, [script, "packages", "tests", "0", "3"], { encoding: "utf8", env: { ...process.env, SELECT: "none" } });
  assert.equal(none.status, 0);
  assert.match(none.stderr, /^skip: /m);
});

test("listedSeconds: a listed time, or NEW_SWEEP_SECONDS for a sweep that has none", () => {
  assert.equal(listedSeconds({ dir: "a", command: "x" }, { "a: x": 7 }), 7);
  assert.equal(listedSeconds({ dir: "a", command: "y" }, { "a: x": 7 }), NEW_SWEEP_SECONDS);
});
