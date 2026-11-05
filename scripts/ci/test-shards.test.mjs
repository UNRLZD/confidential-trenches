// Card ci-test-shards: ci.yml's test work runs as shard jobs (test-*), and the job `test`, a required check of main's
// ruleset, passes only when every shard passed. A required check that is skipped counts as passed, so `test` must run
// whatever its shards ended with, and fail unless each one ended in success: a shard that failed, was skipped or was
// cancelled fails it. This reads ci.yml, replays test's own step under bash with each planted ending, and plants each
// way the wiring can break. It also holds scripts/ci/test-shards.mjs's split of the terminal's browser runs.
//   node --test scripts/ci/test-shards.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { e2ePart } from "./test-shards.mjs";
import { withoutHeldRetries } from "./download-retry.mjs";

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
function replay(run, needs) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], {
    env: { PATH: process.env.PATH, NEEDS: JSON.stringify(needs, null, 2) },
    encoding: "utf8",
  }).status;
}

export function shardProblems(ci) {
  const all = jobs(ci);
  const shards = Object.keys(all).filter((j) => j.startsWith("test-"));
  const job = all.test;
  if (!job) return ["ci.yml has no job named test"];
  if (!shards.length) return ["ci.yml has no shard job (test-*)"];
  const p = [];
  const needs = /^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(job)?.[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (!needs) p.push("test has no one-line needs: [...] list");
  for (const s of shards) if (needs && !needs.includes(s)) p.push(`test does not need ${s}`);
  for (const n of needs ?? []) if (!shards.includes(n)) p.push(`test needs ${n}, which is no shard job (test-*)`);
  if (!/^ {4}if:.*\balways\(\)/m.test(job)) p.push("test's if has no always(): a failed shard would skip test, and a skipped required check passes");
  // a foundry-toolchain install that may fail once is no shard that may fail: download-retry.mjs holds its second run,
  // the same action in the same job, which fails the job when the install fails twice
  const held = jobs(withoutHeldRetries(ci));
  for (const [name, text] of Object.entries(all)) {
    if (name !== "test" && !shards.includes(name)) continue;
    if (/continue-on-error/.test(held[name] ?? text)) p.push(`${name} has continue-on-error`);
    if (name !== "test" && !/^ {4}timeout-minutes:\s*\d+\s*$/m.test(text)) p.push(`${name} has no timeout of its own`);
  }
  if (!/^ {10}NEEDS: \$\{\{ toJSON\(needs\) \}\}$/m.test(job)) p.push("test's step does not read NEEDS from toJSON(needs)");
  const run = stepRun(job, "every shard passed");
  if (!run) return [...p, "test has no step named \"every shard passed\""];
  const ended = (result) => Object.fromEntries((needs ?? shards).map((s, i) => [s, { result: i === 0 ? result : "success", outputs: {} }]));
  if (replay(run, ended("success")) !== 0) p.push("test fails when every shard passed");
  for (const r of ["failure", "skipped", "cancelled"]) if (replay(run, ended(r)) === 0) p.push(`test passes when a shard is ${r}`);
  if (replay(run, {}) === 0) p.push("test passes with no shard at all");
  const browser = all["test-browser"];
  if (!browser) p.push("ci.yml has no test-browser shard for the terminal's browser runs");
  else {
    if (!/^ {10}INDEX: \$\{\{ strategy\.job-index \}\}$/m.test(browser) || !/^ {10}TOTAL: \$\{\{ strategy\.job-total \}\}$/m.test(browser)) {
      p.push("test-browser does not take its part from strategy.job-index and strategy.job-total");
    }
    if (!browser.includes('node scripts/ci/test-shards.mjs e2e "$INDEX" "$TOTAL"')) p.push("test-browser does not run scripts/ci/test-shards.mjs e2e \"$INDEX\" \"$TOTAL\"");
  }
  return p;
}

test("ci.yml: test needs every shard and passes only when each one passed", () => {
  assert.deepEqual(shardProblems(CI), []);
});

// each way the wiring can break, planted in a copy of this ci.yml
const PLANTED = {
  "a shard missing from test's needs": [/needs: \[([^\]]*), test-vault\]/, "needs: [$1]", "test does not need test-vault"],
  "test without always()": [/if: always\(\) && github\.event_name != 'schedule'\n(\s+runs-on: ubuntu-24\.04\n\s+timeout-minutes: 5)/, "if: github.event_name != 'schedule'\n$1", "test's if has no always()"],
  "a skipped shard read as passed": ['all(.[]; .result == "success")', 'all(.[]; .result == "success" or .result == "skipped")', "test passes when a shard is skipped"],
  "a failed shard read as passed": ['all(.[]; .result == "success")', 'all(.[]; .result != "cancelled")', "test passes when a shard is failure"],
  "a step that passes on anything": ['|| { echo "a shard did not pass"; exit 1; }', "|| true", "test passes when a shard is failure"],
  "a shard that may fail": [/(\n  test-scripts:\n)/, "$1    continue-on-error: true\n", "test-scripts has continue-on-error"],
  "a step that may fail in a shard": ["      - name: the EVM pool's tests\n", "      - name: the EVM pool's tests\n        continue-on-error: true\n", "test-scripts has continue-on-error"],
  "a foundry install that may fail with no second run": [/      - name: Foundry once more\n(?:.*\n){4}/, "", "test-scripts has continue-on-error"],
  "a shard with no timeout": [/(\n  test-vault:\n(?:.*\n){2}) {4}timeout-minutes: \d+\n/, "$1", "test-vault has no timeout of its own"],
  "a browser part count set by hand": ["TOTAL: ${{ strategy.job-total }}", "TOTAL: 2", "test-browser does not take its part"],
  "a shard job left out of the list": [/(\n {2}test:\n)/, "\n  test-extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: \"true\"\n$1", "test does not need test-extra"],
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
