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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
