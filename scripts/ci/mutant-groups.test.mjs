// A mutant sweep's test run leaves no process behind (card mutant-sweep-no-orphans). Every sweep runs each test run
// through scripts/group-run.mjs, in a process group of its own killed whole at its end: a planted test that never ends
// and starts a process of its own (a local server, as a test of a sender does) is run with a short timeout, sync and
// async, and through a sweep that is itself stopped with SIGTERM; after each, no process has the planted folder as its
// working folder (lsof's cwd read of that one folder, never a process list). Before this card the run's timeout killed
// only its own process: node --test's per-file child, or what a test started, lived on with parent 1 for hours (three
// found 5 Nov 05:10Z). The last test reads every mutant file in the tree and refuses a test run spawned past the runner.
//   node --test scripts/ci/mutant-groups.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run, runSync } from "../group-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = pathToFileURL(path.join(ROOT, "scripts/group-run.mjs")).href;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// each planted run is a run of its own: with this runner's NODE_TEST_CONTEXT it would report to this file's runner
delete process.env.NODE_TEST_CONTEXT;

// a folder with a test that starts a process of its own, writes `started` once it runs, and never ends
function plant() {
  const dir = mkdtempSync(path.join(tmpdir(), "mutant-groups-"));
  writeFileSync(
    path.join(dir, "never.test.mjs"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
test("never ends", async () => {
  const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((ok) => server.once("spawn", ok));
  writeFileSync("started", String(server.pid));
  for (;;) await new Promise((ok) => setImmediate(ok));
});
`,
  );
  return dir;
}

// the processes whose working folder is `dir` (lsof +d reads that one folder; it exits 1 when there are none)
function inFolder(dir) {
  const r = spawnSync("lsof", ["-t", "-a", "-d", "cwd", "+d", dir], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid);
}

// the leftovers, read until none is left (a kill lands within a moment) or 2 s pass; the test's own processes are then
// stopped by their pid, so a failing run leaves nothing either
async function leftovers(dir) {
  let pids = inFolder(dir);
  for (let i = 0; i < 20 && pids.length > 0; i++) {
    await sleep(100);
    pids = inFolder(dir);
  }
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  return pids;
}

async function until(file, ms) {
  for (let t = 0; t < ms && !existsSync(file); t += 50) await sleep(50);
  assert.ok(existsSync(file), `${file} never appeared`);
}

test("a sync run past its timeout leaves no process: node --test's file child and the process the test started die with it", { timeout: 30_000 }, async () => {
  const dir = plant();
  try {
    const r = runSync(process.execPath, ["--test", "never.test.mjs"], { cwd: dir, encoding: "utf8", timeoutMs: 3_000 });
    assert.equal(r.timedOut, true);
    assert.ok(existsSync(path.join(dir, "started")), "the planted test never started");
    assert.deepEqual(await leftovers(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an async run past its timeout leaves no process", { timeout: 30_000 }, async () => {
  const dir = plant();
  try {
    const r = await run(process.execPath, ["--test", "never.test.mjs"], { cwd: dir, timeoutMs: 3_000 });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(path.join(dir, "started")), "the planted test never started");
    assert.deepEqual(await leftovers(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that ends on its own takes what it left in its group with it, and its output and status come back", { timeout: 30_000 }, async () => {
  const dir = plant();
  try {
    // the run's process starts a process that would outlive it, prints, and exits 3
    const script = `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref(); console.log("out"); process.exit(3);`;
    const s = runSync(process.execPath, ["-e", script], { cwd: dir, encoding: "utf8", timeoutMs: 10_000 });
    assert.deepEqual([s.status, s.stdout.trim(), s.timedOut], [3, "out", false]);
    assert.deepEqual(await leftovers(dir), []);
    const a = await run(process.execPath, ["-e", script], { cwd: dir, timeoutMs: 10_000 });
    assert.deepEqual([a.status, a.stdout.trim(), a.timedOut], [3, "out", false]);
    assert.deepEqual(await leftovers(dir), []);
    // a command that is not there is a failed run, never a throw
    const missing = await run(path.join(dir, "no-such-command"), [], { cwd: dir, timeoutMs: 10_000 });
    assert.equal(missing.error?.code, "ENOENT");
    assert.notEqual(runSync(path.join(dir, "no-such-command"), [], { cwd: dir, timeoutMs: 10_000 }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ["run", "runSync"]) {
  test(`a sweep stopped with SIGTERM mid-run (${mode}) leaves no process`, { timeout: 30_000 }, async () => {
    const dir = plant();
    try {
      // the sweep: one long run of the planted test, as a harness makes it; a sync run ends at its own timeout (the
      // sweep's SIGTERM waits for it), an async one at once
      const call = mode === "run" ? `await run(process.execPath, ["--test", "never.test.mjs"], { cwd: ${JSON.stringify(dir)}, timeoutMs: 60_000 });` : `runSync(process.execPath, ["--test", "never.test.mjs"], { cwd: ${JSON.stringify(dir)}, timeoutMs: 4_000 });`;
      const sweep = spawn(process.execPath, ["--input-type=module", "-e", `import { run, runSync } from ${JSON.stringify(RUNNER)};\n${call}\nawait new Promise((ok) => setTimeout(ok, 60_000));`], { stdio: "ignore" });
      const ended = new Promise((ok) => sweep.once("exit", (code, signal) => ok({ code, signal })));
      await until(path.join(dir, "started"), 10_000);
      sweep.kill("SIGTERM");
      const { code } = await ended;
      assert.equal(code, 143);
      assert.deepEqual(await leftovers(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a run without a timeout is refused before it starts", () => {
  assert.throws(() => runSync(process.execPath, ["-e", ""], {}), /timeoutMs/);
  assert.throws(() => run(process.execPath, ["-e", ""], { timeoutMs: 0 }), /timeoutMs/);
});

// ---- every sweep's test runs go through the runner

const CALLS = ["execFileSync", "execFile", "spawnSync", "spawn", "execSync", "exec", "fork"];
/** The test runs `text` spawns straight from node:child_process: each call's own text. A test run is a call naming
 *  --test, `test` (cargo, forge), the fork replay, node itself or a sweep file; a tool call (git, forge inspect, a
 *  build) is not one. promisify(execFile) is one too: its calls are read under any name. */
export function directRuns(text) {
  const m = /import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/.exec(text);
  if (!m) return [];
  // each imported call by its local name ("execFileSync" or "execFileSync as x")
  const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)).filter(([c]) => CALLS.includes(c)).map(([c, as]) => as ?? c);
  const out = [];
  for (const n of names) {
    for (const at of [...text.matchAll(new RegExp(`(?<![\\w.$])${n.replace(/\$/g, "\\$")}\\s*\\(`, "g"))].map((x) => x.index + x[0].length)) {
      let depth = 1;
      let i = at;
      while (i < text.length && depth > 0) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      }
      const call = text.slice(at, i - 1);
      if (/["'`]--test|["'`]test["'`]|fork-rpc|process\.execPath|["'`]node["'`]|\.mjs/.test(call)) out.push(`${n}(${call.split("\n")[0].slice(0, 100)}`);
    }
  }
  if (/promisify\s*\(\s*(execFile|exec)\s*\)/.test(text)) out.push("promisify(execFile)");
  return out;
}

test("the scan refuses a test run spawned straight from node:child_process, and passes a tool call (planted)", () => {
  const imp = (n) => `import { ${n} } from "node:child_process";\n`;
  assert.equal(directRuns(`${imp("execFileSync")}execFileSync("node", ["--test", f], { timeout: 1 });`).length, 1);
  assert.equal(directRuns(`${imp("spawnSync")}spawnSync(process.execPath, [runner], {});`).length, 1);
  assert.equal(directRuns(`${imp("spawnSync")}const r = spawnSync("cargo", ["+1.97.1", "test", "--quiet"], {\n  cwd,\n});`).length, 1);
  assert.equal(directRuns(`${imp("execFile")}const run$ = promisify(execFile);\nawait run$("node", ["--test"]);`).length >= 1, true);
  assert.equal(directRuns(`${imp("execFileSync as x")}x("node", ["test/fork-rpc.mjs", "--", "forge"]);`).length, 1);
  assert.deepEqual(directRuns(`${imp("execFileSync")}execFileSync("git", ["init", "-q", std]);\nexecFileSync("cargo-build-sbf", ["--sbf-out-dir", "out/mutant"], {});`), []);
  assert.deepEqual(directRuns(`import { runSync } from "../../../scripts/group-run.mjs";\nrunSync("node", ["--test", f], { timeoutMs: 1 });`), []);
});

test("every mutant sweep and its test spawns its test runs only through scripts/group-run.mjs", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /mutant/i.test(path.basename(f)) && /\.(mjs|ts)$/.test(f) && f !== "scripts/ci/mutant-groups.test.mjs" && existsSync(path.join(ROOT, f)));
  // the sweeps this card found (5 Nov): a file taken out of the tree or renamed fails here until this list follows it
  for (const f of [
    "apps/helper/test/pool-evm/sell-mutants.mjs",
    "contracts/pool-evm/test/mutants.mjs",
    "contracts/pool-solana/scripts/mutants.mjs",
    "packages/kit/test/evm-pool-buy-mutants.mjs",
    "packages/kit/test/evm-pool-sell-mutants.mjs",
    "packages/kit/test/evm-quote-mutants.mjs",
    "packages/kit/test/pool-usd-mutants.mjs",
    "packages/kit/test/mutants/evm-pool-mutants.test.mjs",
    "packages/kit/test/mutants/pool-usd-mutants.test.mjs",
    "packages/signpage/test/pool-price-mutants.mjs",
    "packages/signpage/test/pool-price-mutants.test.mjs",
    "packages/signpage/test/rules-pool-mutants.mjs",
    "packages/signpage/test/rules-pool-mutants.test.mjs",
    "packages/wallet/scripts/mutant-run.mjs",
    "packages/wallet/scripts/pool-evm-restore-mutants.mjs",
  ])
    assert.ok(files.includes(f), `${f} is not in the tree`);
  const direct = files.flatMap((f) => directRuns(readFileSync(path.join(ROOT, f), "utf8")).map((c) => `${f}: ${c}`));
  assert.deepEqual(direct, []);
});
