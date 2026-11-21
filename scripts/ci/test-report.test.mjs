// Card test-count-never-short: a test file whose results did not all reach the runner fails the run by name, in every
// package's own test run (21 Nov: the kit's suite reported 2237 and 2293 tests on loaded macOS against 2316 on Linux, both
// runs exit 0; signpage-client.test.mjs and solana-quote.test.ts were missing). Planted files, run with each
// package's own node --test flags from its package.json, in that package's folder: a file that exits before its first
// test and one that exits in its second test each pass under node's own reporter (the red control) and are each named
// by scripts/test-report.mjs, and the file beside them passes. scripts/ci/tests-run.test.mjs holds every package's
// test script to the reporter.
//   node --test scripts/ci/test-report.test.mjs
import assert from "node:assert/strict";
import { globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../group-run.mjs";
import { namedFiles, shortFiles } from "../test-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT = "--test-reporter=../../scripts/test-report.mjs";
// a run started from inside a node --test file is a run of its own: NODE_TEST_CONTEXT would make it report to this one
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));

const PLANTS = {
  "fine.test.mjs": 'import { test } from "node:test";\ntest("fine one", () => {});\ntest("fine two", () => {});\n',
  // a file that ends before its tests run, exit 0: node --test reports it as one passing test named after the file
  "gone.test.mjs": 'import { test } from "node:test";\nprocess.exit(0);\ntest("never runs", () => {});\n',
  // a file whose report is cut after its first test, exit 0, as --test-force-exit cut one on a loaded macOS runner
  "cut.test.mjs": 'import { test } from "node:test";\ntest("ran", () => {});\ntest("ends the process", () => process.exit(0));\ntest("never runs", () => {});\n',
};
const DROPPED = ["gone.test.mjs", "cut.test.mjs"];
// a file that runs another file's tests by importing it (signpage's pool-deposit-evm-base-mainnet.test.ts runs
// pool-deposit-evm.test.ts's): each test event names the file the test is written in, so a file is counted by the file
// the runner ran (entryFile), never refused as 0 of its tests beside the other at twice its own
const USES = { "uses.test.mjs": 'import "./fine.test.mjs";\n' };

function plant() {
  // its links resolved, so the names the report prints are the names asserted here
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "test-report-")));
  for (const [f, text] of Object.entries({ ...PLANTS, ...USES })) writeFileSync(path.join(dir, f), text);
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

test("every package's test run fails a file whose results did not arrive, names it, and passes the file beside it", async () => {
  const dir = plant();
  try {
    const pkgs = packages();
    assert.ok(pkgs.length >= 7, `the workspace's test scripts, read: ${pkgs.map((p) => p.dir)}`);
    const files = Object.keys(PLANTS).map((f) => path.join(dir, f));
    const runs = await Promise.all(pkgs.map(async (p) => ({ ...p, r: await run(process.execPath, ["--test", ...p.flags, ...files], { cwd: path.join(ROOT, p.dir), env: ENV, timeoutMs: 90_000 }) })));
    for (const { dir: d, r } of runs) {
      const out = r.stdout + r.stderr;
      assert.equal(r.timedOut, false, `${d}: the run is still going at 90 s`);
      assert.equal(r.status, 1, `${d}: a run that lost a file's results passed\n${out}`);
      for (const f of DROPPED) assert.ok(out.includes(`${path.join(dir, f)}: reported no result`), `${d}: ${f} not named\n${out}`);
      assert.ok(!out.includes(`${path.join(dir, "fine.test.mjs")}: `), `${d}: the whole file named\n${out}`);
      assert.match(out, /✔ fine one/, `${d}: the file beside them did not run`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every package's test run passes when each file's results arrive whole, a file that runs another's tests included", async () => {
  const dir = plant();
  try {
    const runs = await Promise.all(packages().map(async (p) => ({ ...p, r: await run(process.execPath, ["--test", ...p.flags, ...["fine.test.mjs", "uses.test.mjs"].map((f) => path.join(dir, f))], { cwd: path.join(ROOT, p.dir), env: ENV, timeoutMs: 90_000 }) })));
    for (const { dir: d, r } of runs) {
      assert.equal(r.status, 0, `${d}\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /ℹ tests 4\n/, d);
      assert.ok(!(r.stdout + r.stderr).includes("test-report: FAIL"), d);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("red control: the same files under the package's flags with node's own reporter pass, exit 0", async () => {
  const dir = plant();
  try {
    const { flags } = packages().find((p) => p.dir === "packages/kit");
    assert.ok(flags.includes(REPORT), "the kit's test script reports through the check");
    const r = await run(process.execPath, ["--test", ...flags.filter((f) => f !== REPORT), ...Object.keys(PLANTS).map((f) => path.join(dir, f))], { cwd: path.join(ROOT, "packages/kit"), env: ENV, timeoutMs: 90_000 });
    assert.equal(r.status, 0, "node's own reporter refused a lost file");
    // the two files' tests counted as one test each, named after the file
    assert.match(r.stdout, /ℹ tests 4\n/, r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file's count short of its own summary is refused; a whole report passes; a run with no summary is refused", () => {
  const ev = (type, file, extra = {}) => ({ type, data: { file, ...extra } });
  const whole = [ev("test:pass", "/a", { details: { type: "test" } }), ev("test:pass", "/a", { details: { type: "test" } }), ev("test:pass", "/a", { details: { type: "suite" } }), ev("test:summary", "/a", { counts: { tests: 2 } }), ev("test:summary", undefined, { counts: { tests: 2 } })];
  assert.deepEqual(shortFiles(["/a"], whole), []);
  assert.deepEqual(shortFiles(["/a"], whole.slice(1)), ["/a: 1 of its 2 tests reported"]);
  assert.deepEqual(shortFiles(["/a", "/b"], whole), ["/b: reported no result (its process sent no summary)"]);
  assert.deepEqual(shortFiles(["/a"], whole.slice(0, -1)), ["the run sent no summary"]);
});

test("the files named are the runner's arguments, globs expanded, flags and node_modules left out", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-report-named-"));
  try {
    for (const f of ["test/a.test.ts", "test/b.test.ts", "test/node_modules/c.test.ts", "x.test.mjs"]) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), "");
    }
    assert.deepEqual(namedFiles(["--x", "test/**/*.test.ts", "x.test.mjs"], dir), ["test/a.test.ts", "test/b.test.ts", "x.test.mjs"].map((f) => realpathSync(path.join(dir, f))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
