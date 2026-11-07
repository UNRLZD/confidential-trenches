// Card ci-test-shards: ci.yml's test work runs as shard jobs (test-*), and the job `test`, a required check of main's
// ruleset, passes only when every shard passed. A required check that is skipped counts as passed, so `test` must run
// whatever its shards ended with, and fail unless each one ended in success: a shard that failed, was skipped or was
// cancelled fails it. This reads ci.yml, replays test's own step under bash with each planted ending, and plants each
// way the wiring can break. It also holds scripts/ci/test-shards.mjs's split of the terminal's browser runs.
//   node --test scripts/ci/test-shards.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync as realpath, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { e2ePart, mutantCommands, mutantParts, mutantsPart, runPart, MUTANT_SECONDS, MUTANTS_ELSEWHERE, NEW_SWEEP_SECONDS, PART_BUDGET_SECONDS } from "./test-shards.mjs";
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
  p.push(...mutantJobProblems(all, ci, mutantCommands(ROOT)));
  return p;
}

// card ci-mutants-sharded: test-mutants runs the split across its matrix, enough parts that the heaviest is planned
// inside PART_BUDGET_SECONDS, each package left out of the split runs its sweeps in its own job, and no line runs the
// sweeps whole besides
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
  for (const [name, job] of Object.entries(MUTANTS_ELSEWHERE)) {
    if (!new RegExp(`^ +run: pnpm --filter ${name} run test:mutants$`, "m").test(all[job] ?? "")) {
      p.push(`${name}'s test:mutants runs nowhere: the split leaves it to ${job}, which does not run it`);
    }
  }
  if (/^ +(- )?run: .*pnpm -r\b.*\brun test:mutants\b/m.test(ci)) p.push("a ci.yml line runs test:mutants with pnpm -r beside the split, so a sweep runs twice");
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
  "a browser part count set by hand": [/(this part's share\n {8}env:\n {10}INDEX: \$\{\{ strategy\.job-index \}\}\n {10})TOTAL: \$\{\{ strategy\.job-total \}\}(\n {8}run: \|)/, "$1TOTAL: 2$2", "test-browser does not take its part"],
  "a mutant part count set by hand": [/(this part's share\n {8}env:\n {10}INDEX: \$\{\{ strategy\.job-index \}\}\n {10})TOTAL: \$\{\{ strategy\.job-total \}\}(\n {8}run: node)/, "$1TOTAL: 4$2", "test-mutants does not take its part"],
  "the mutant sweeps run whole in every part": ['run: node scripts/ci/test-shards.mjs mutants "$INDEX" "$TOTAL"', "run: pnpm -r --filter '!@blindfill/wallet' --if-present --no-bail run test:mutants", "test-mutants does not run scripts/ci/test-shards.mjs mutants"],
  "the whole sweep run again beside the split": ["      - name: the wallet package's test:mutants script\n", "      - run: pnpm -r --filter '!@blindfill/wallet' --if-present run test:mutants\n      - name: the wallet package's test:mutants script\n", "a ci.yml line runs test:mutants with pnpm -r"],
  "too few mutant parts for the budget": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4\]/, "$1part: [1]", "test-mutants' heaviest of 1 part(s) is planned at"],
  "a mutant matrix that skips a part": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4\]/, "$1part: [1, 2, 4]", "test-mutants has no matrix part"],
  "more mutant parts than sweeps": [/(\n {6}matrix:\n {8})part: \[1, 2, 3, 4\]/, "$1part: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]", "test-mutants: the sweeps are"],
  "the wallet's own sweep dropped": ["      - name: the wallet package's test:mutants script\n        run: pnpm --filter @blindfill/wallet run test:mutants\n", "", "@blindfill/wallet's test:mutants runs nowhere"],
  "no test-mutants job": [/\n {2}test-mutants:\n/, "\n  test-mutantz:\n", "ci.yml has no test-mutants shard"],
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

// card ci-mutants-sharded: the mutant sweeps' split. SWEEPS is read here from git's own list of package.json files,
// apart from the split's reader, so a reader that misses a package fails against it.
const key = (c) => `${c.dir}: ${c.command}`;
function sweepsFromGit(root) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ":(glob)apps/*/package.json", ":(glob)packages/*/package.json"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean).toSorted();
  return files.flatMap((f) => {
    const { name, scripts } = JSON.parse(readFileSync(path.join(root, f), "utf8"));
    const script = scripts?.["test:mutants"];
    if (!script || Object.hasOwn(MUTANTS_ELSEWHERE, name)) return [];
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
  assert.ok(!SWEEPS.some((c) => Object.hasOwn(MUTANTS_ELSEWHERE, c.name)), "a package left to its own job is not split");
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
  const more = CI.replace(/(\n {6}matrix:\n {8}part: \[1, 2, 3, 4)\]/, `$1, 5]`);
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

test("planted: the split's reader takes every workspace package's test:mutants but those left to their own job", () => {
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
    put("packages/w/package.json", pkg(Object.keys(MUTANTS_ELSEWHERE)[0], "FULL_RUNS=1 node --test test/w.test.ts"));
    put("other/c/package.json", pkg("c", "node c-mutants.mjs"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    const want = [
      { dir: "apps/b", name: "b", command: "node --test test/b-mutants.test.mjs" },
      { dir: "packages/a", name: "@x/a", command: 'node --test "test/mutants/*.test.mjs"' },
      { dir: "packages/a", name: "@x/a", command: "node test/q-mutants.mjs" },
    ];
    assert.deepEqual(mutantCommands(dir), want);
    assert.deepEqual(sweepsFromGit(dir), want);
    // a command added to a package's script is read, and lands in exactly one part
    put("packages/a/package.json", pkg("@x/a", 'node --test "test/mutants/*.test.mjs" && node test/q-mutants.mjs && node test/r-mutants.mjs'));
    const more = mutantCommands(dir);
    assert.deepEqual(more.map(key), [...want.map(key), "packages/a: node test/r-mutants.mjs"]);
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
