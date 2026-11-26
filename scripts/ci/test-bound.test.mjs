// Card test-runs-never-hold-a-slot: a test file that never ends fails by name inside the bound, in every package's own
// test run, and the run goes on (18 Nov 17:00Z: the whole wallet run waited 49 min on one file). Planted files, run with
// each package's own node --test flags from its package.json, in that package's folder, the file bound lowered to
// seconds (TEST_BOUND_FILE_MS): a test that never resolves while a handle stays open, a test that spins without
// yielding and a file that hangs at its top level are each stopped and named, and the file beside them passes. Without
// the bound the same run is still going at the probe's cap; a process a test leaves behind holding the run's output is
// stopped at the run's bound (TEST_BOUND_RUN_MS).
//   node --test scripts/ci/test-bound.test.mjs
import assert from "node:assert/strict";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../group-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE_MS = 5_000;
// a run started from inside a node --test file is a run of its own: NODE_TEST_CONTEXT would make it report to this one
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));

const PLANTS = {
  "fine.test.mjs": 'import { test } from "node:test";\ntest("fine", () => {});\n',
  "never.test.mjs": 'import { test } from "node:test";\ntest("never resolves, a handle open", async () => {\n  setInterval(() => {}, 1_000);\n  await new Promise(() => {});\n});\n',
  "spin.test.mjs": 'import { test } from "node:test";\ntest("spins without yielding", async () => {\n  for (;;) await null;\n});\n',
  "top.test.mjs": "setInterval(() => {}, 1_000);\nawait new Promise(() => {});\n",
};
const HUNG = ["never.test.mjs", "spin.test.mjs", "top.test.mjs"];

function plant() {
  const dir = mkdtempSync(path.join(tmpdir(), "test-bound-"));
  for (const [f, text] of Object.entries(PLANTS)) writeFileSync(path.join(dir, f), text);
  return dir;
}

/** Each workspace package with a test script: its folder and the flags of its node --test, as package.json has them. */
function packages() {
  const globs = [...readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  const out = [];
  for (const pkg of globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: ROOT })).sort()) {
    const script = JSON.parse(readFileSync(path.join(ROOT, pkg), "utf8")).scripts?.test;
    if (typeof script !== "string") continue;
    const w = script.split("&&").map((s) => s.trim().split(/\s+/)).find((x) => x[0] === "node" && x.includes("--test"));
    assert.ok(w, `${pkg}: no node --test in its test script`);
    out.push({ dir: path.dirname(pkg), flags: w.slice(w.indexOf("--test") + 1).filter((x) => x.startsWith("-")) });
  }
  return out;
}

test("every package's test run stops a file that never ends, names it, and runs the file beside it", async () => {
  const dir = plant();
  try {
    const pkgs = packages();
    assert.ok(pkgs.length >= 7, `the workspace's test scripts, read: ${pkgs.map((p) => p.dir)}`);
    const files = Object.keys(PLANTS).map((f) => path.join(dir, f));
    const runs = await Promise.all(pkgs.map(async (p) => ({ ...p, r: await run(process.execPath, ["--test", ...p.flags, ...files], { cwd: path.join(ROOT, p.dir), env: { ...ENV, TEST_BOUND_FILE_MS: String(FILE_MS) }, timeoutMs: 90_000 }) })));
    for (const { dir: d, r } of runs) {
      const out = r.stdout + r.stderr;
      assert.equal(r.timedOut, false, `${d}: the run is still going at 90 s`);
      assert.notEqual(r.status, 0, `${d}: a hung file passed`);
      for (const f of HUNG) assert.ok(out.includes(`test-bound: the test file still running at its bound (${FILE_MS} ms), stopped: ${path.join(dir, f)}`), `${d}: ${f} not named as stopped\n${out}`);
      assert.match(out, /✔ fine/, `${d}: the file beside them did not run`);
      assert.match(out, /ℹ pass 1\n/, d);
      assert.match(out, /ℹ fail 3\n/, d);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("red control: the same file under node --test with no bound is still running past the file bound", async () => {
  const dir = plant();
  try {
    const r = await run(process.execPath, ["--test", path.join(dir, "spin.test.mjs")], { cwd: ROOT, env: ENV, timeoutMs: FILE_MS + 3_000 });
    assert.equal(r.timedOut, true, "node --test alone ended a spinning file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a process a test leaves behind holding the run's output is stopped at the run's bound", async () => {
  const dir = plant();
  try {
    writeFileSync(path.join(dir, "left.test.mjs"), 'import { spawn } from "node:child_process";\nimport { test } from "node:test";\ntest("leaves a process holding the output", () => {\n  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref();\n});\n');
    const { flags } = packages().find((p) => p.dir === "packages/wallet");
    const r = await run(process.execPath, ["--test", ...flags, path.join(dir, "left.test.mjs")], { cwd: path.join(ROOT, "packages/wallet"), env: { ...ENV, TEST_BOUND_RUN_MS: String(2 * FILE_MS) }, timeoutMs: 60_000 });
    assert.equal(r.timedOut, false, "the run is still going at 60 s");
    assert.equal(r.signal, "SIGKILL", "the run's own process stopped by its watch");
    assert.ok(r.stderr.includes(`test-bound: the test run still running at its bound (${2 * FILE_MS} ms), stopped: ${path.join(ROOT, "packages/wallet")}`), r.stderr);
    // card ci-kit-shard-never-stalls-silent: the stop names the process that held the output, by its command
    assert.ok(r.stderr.includes("test-bound: its group's processes at the stop (pid ppid stat elapsed wchan command):\n"), r.stderr);
    assert.match(r.stderr, /^test-bound: {3}\d+ \d+ \S+ \S+ \S+ \S*node -e setInterval\(\(\) => \{\}, 1000\)$/m, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Card ci-kit-shard-never-stalls-silent: merge queue run 45744571533 (job 139657420490) stopped the kit's run at the job's
// deadline after 742 s with no line but the run's own: no file named, and nothing said whether a file was still running
// or the runner was held. The run's stop now lists its group's processes (the runner, each file's process, any process
// they started) with state, elapsed and wait channel, so a stall names what held it. Red at 0ba510633: no list.
test("a run stopped at its bound lists its group's processes, the file still running named by its path", async () => {
  const dir = plant();
  try {
    const { flags } = packages().find((p) => p.dir === "packages/wallet");
    const top = path.join(dir, "top.test.mjs");
    // the file's own bound left at FILE_MS (900 s), the run's at 2 * this file's FILE_MS: the run's stop comes first
    const r = await run(process.execPath, ["--test", ...flags, top], { cwd: path.join(ROOT, "packages/wallet"), env: { ...ENV, TEST_BOUND_RUN_MS: String(2 * FILE_MS) }, timeoutMs: 60_000 });
    assert.equal(r.timedOut, false, "the run is still going at 60 s");
    assert.equal(r.signal, "SIGKILL", "the run's own process stopped by its watch");
    assert.ok(r.stderr.includes(`test-bound: the test run still running at its bound (${2 * FILE_MS} ms), stopped: ${path.join(ROOT, "packages/wallet")}`), r.stderr);
    const rows = r.stderr.split("\n").filter((l) => /^test-bound: {3}\d/.test(l));
    // the file's process names its file at its command's end, past node's own flags, whatever their length
    assert.ok(rows.some((l) => l.endsWith(top) && !/ --test( |$)/.test(l)), `the hung file's process named by its path\n${r.stderr}`);
    assert.ok(rows.every((l) => l.length <= "test-bound:   ".length + 80 + 300), `each row bounded\n${r.stderr}`);
    assert.ok(!rows.some((l) => / ps -A -o /.test(l)), `the list's own ps left out\n${r.stderr}`);
    assert.ok(rows.some((l) => / --test /.test(l)), `the runner itself listed\n${r.stderr}`);
    assert.ok(rows.every((l) => /^test-bound: {3}\d+ \d+ \S+ [0-9:-]+ \S+ /.test(l)), `each row pid, ppid, state, elapsed, wait channel, command\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run whose group cannot be listed (no ps) says so, and its stop still lands", async () => {
  const dir = plant();
  try {
    const { flags } = packages().find((p) => p.dir === "packages/wallet");
    const r = await run(process.execPath, ["--test", ...flags, path.join(dir, "top.test.mjs")], { cwd: path.join(ROOT, "packages/wallet"), env: { ...ENV, PATH: dir, TEST_BOUND_RUN_MS: String(2 * FILE_MS) }, timeoutMs: 60_000 });
    assert.equal(r.timedOut, false, "the run is still going at 60 s");
    assert.equal(r.signal, "SIGKILL", "the stop landed with no list");
    assert.match(r.stderr, /^test-bound: its processes could not be listed \(ps: ENOENT\)$/m, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Card hung-test-file-named-in-ci: a job's own limit (timeout-minutes) ends the job and names nothing. Release 197's first
// merge queue run lost test-packages (1) that way (run 45216828809: its signpage suite printed nothing from 16:33:04Z to
// the cancel at 16:43:29Z), FILE_MS being the job's whole 15 minutes and several tests naming 600 or 900 s of their own.
// TEST_BOUND_DEADLINE (ms since the epoch) is the job's: a file still running then is stopped by name, and the run
// DEADLINE_GRACE_MS after it, so the names reach the log before the job's limit.
test("a job's deadline stops a hung file by name long before the file's own bound, and runs the file beside it", async () => {
  const dir = plant();
  try {
    const { flags } = packages().find((p) => p.dir === "packages/wallet");
    const files = ["never.test.mjs", "fine.test.mjs"].map((f) => path.join(dir, f));
    const r = await run(process.execPath, ["--test", ...flags, ...files], { cwd: path.join(ROOT, "packages/wallet"), env: { ...ENV, TEST_BOUND_DEADLINE: String(Date.now() + FILE_MS) }, timeoutMs: 60_000 });
    const out = r.stdout + r.stderr;
    assert.equal(r.timedOut, false, "the run is still going at 60 s");
    assert.ok(out.includes(`test-bound: the test file still running at the job's deadline, stopped: ${path.join(dir, "never.test.mjs")}`), out);
    assert.match(out, /✔ fine/);
    assert.match(out, /ℹ fail 1\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deadline that is no time, or one past the file's bound, changes nothing: the file stops at its bound", async () => {
  const dir = plant();
  try {
    const { flags } = packages().find((p) => p.dir === "packages/wallet");
    for (const deadline of ["soon", String(Date.now() + 10 * 60_000)]) {
      const r = await run(process.execPath, ["--test", ...flags, path.join(dir, "never.test.mjs")], { cwd: path.join(ROOT, "packages/wallet"), env: { ...ENV, TEST_BOUND_FILE_MS: String(FILE_MS), TEST_BOUND_DEADLINE: deadline }, timeoutMs: 60_000 });
      const out = r.stdout + r.stderr;
      assert.equal(r.timedOut, false, `${deadline}: the run is still going at 60 s`);
      assert.ok(out.includes(`test-bound: the test file still running at its bound (${FILE_MS} ms), stopped: ${path.join(dir, "never.test.mjs")}`), `${deadline}\n${out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Each ci.yml job whose steps run a package's test script (the ones that load the watch): its timeout-minutes and
 *  whether its first step sets TEST_BOUND_DEADLINE a minute before that limit. */
function deadlineProblems(ci) {
  const out = [];
  const jobs = [...ci.matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\s*\n|\s*#.*\n)*)/gm)];
  let seen = 0;
  for (const [, name, body] of jobs) {
    if (!/pnpm --filter \S+ run test\n|test-shards\.mjs packages tests /.test(body)) continue;
    seen++;
    const minutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(body)?.[1]);
    // the first step: past any comment lines under steps:, its "- " line and the lines indented under it
    const first = /^ {4}steps:\n(?: {6}#.*\n)*( {6}- .*\n(?: {8}.*\n)*)/m.exec(body)?.[1] ?? "";
    const want = `run: echo "TEST_BOUND_DEADLINE=$(( ($(date +%s) + ${minutes - 1} * 60) * 1000 ))" >> "$GITHUB_ENV"`;
    if (!first.includes(want)) out.push(`${name}: its first step does not set TEST_BOUND_DEADLINE ${minutes - 1} minutes on (timeout-minutes ${minutes})`);
  }
  if (seen < 2) out.push(`ci.yml: ${seen} job(s) run a package's test script, want test-wallet and test-packages`);
  return out;
}

test("ci.yml: each job that runs a package's test script sets the deadline first, a minute before its own limit", () => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(deadlineProblems(ci), []);
  const step = /\n {6}- name: the test runs' deadline[^\n]*\n {8}run: echo "TEST_BOUND_DEADLINE[^\n]*\n/;
  const plants = {
    "no deadline step": [new RegExp(step.source), "\n", /test-wallet: its first step does not set/],
    "the deadline at the job's limit": [/\+ 14 \* 60\) \* 1000 \)\)" >> "\$GITHUB_ENV"/, '+ 15 * 60) * 1000 ))" >> "$GITHUB_ENV"', /does not set TEST_BOUND_DEADLINE 14 minutes on \(timeout-minutes 15\)/],
  };
  for (const [what, [find, repl, want]] of Object.entries(plants)) {
    const planted = ci.replace(find, repl);
    assert.notEqual(planted, ci, what);
    assert.match(deadlineProblems(planted).join("\n"), want, what);
  }
});
