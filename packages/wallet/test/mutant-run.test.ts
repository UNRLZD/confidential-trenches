// The mutant sweeps' runner (scripts/mutant-run.mjs) leaves no process behind when a run hangs: a planted test file that
// spins forever without yielding is killed at the timeout, its process with it (card sol-restore-race, 3 Nov 04:20Z).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error: a plain .mjs script, no types
import { runMutant, runTests } from "../scripts/mutant-run.mjs";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a run that hangs is killed at its timeout, the process that spins with it", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mutant-run-"));
  let pid = 0;
  try {
    writeFileSync(path.join(dir, "spin.test.mjs"), `import { writeFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("spins", async () => {\n  writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(process.pid));\n  for (;;) await Promise.resolve();\n});\n`);
    const r = runTests(["spin.test.mjs"], { cwd: dir, timeoutMs: 3_000 }) as { hung: boolean };
    pid = Number(readFileSync(path.join(dir, "pid"), "utf8"));
    assert.ok(pid > 0);
    assert.equal(r.hung, true);
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(alive(pid), false, `the spinning test's process ${pid} is left running`);
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// a planted test file per case, run as a mutant: its verdict and how many runs it took
function verdictOf(body: string): { verdict: string; runs: number; fail: number; cancelled: number } {
  const dir = mkdtempSync(path.join(tmpdir(), "mutant-run-"));
  try {
    writeFileSync(path.join(dir, "case.test.mjs"), `import { existsSync, writeFileSync } from "node:fs";\nimport { test } from "node:test";\nconst first = !existsSync(${JSON.stringify(path.join(dir, "ran"))});\nwriteFileSync(${JSON.stringify(path.join(dir, "ran"))}, "");\n${body}\n`);
    return runMutant(["case.test.mjs"], { cwd: dir, timeoutMs: 20_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const pick = (r: { verdict: string; runs: number; fail: number; cancelled: number }) => ({ verdict: r.verdict, runs: r.runs, fail: r.fail, cancelled: r.cancelled });
const spin = "for (;;) await new Promise((ok) => setImmediate(ok));";

test("a mutant whose only failures are tests cancelled at their own timeout is run once more, then listed apart, never a kill (fold 7)", { timeout: 60_000 }, () => {
  // cancelled on both runs: listed apart
  assert.deepEqual(pick(verdictOf(`test("yields forever", { timeout: 200 }, async () => { ${spin} });`)), { verdict: "cancelled", runs: 2, fail: 0, cancelled: 1 });
  // slow under load once, then on time: a correct mutant survives
  assert.deepEqual(pick(verdictOf(`test("slow once", { timeout: 200 }, async () => { if (first) ${spin} });`)), { verdict: "survived", runs: 2, fail: 0, cancelled: 0 });
  // cancelled once, then a real failure: killed
  assert.deepEqual(pick(verdictOf(`test("fails on the second run", { timeout: 200 }, async () => { if (first) ${spin} throw new Error("told apart"); });`)), { verdict: "killed", runs: 2, fail: 1, cancelled: 0 });
  // a real failure: killed at once
  assert.deepEqual(pick(verdictOf(`test("fails", () => { throw new Error("told apart"); });`)), { verdict: "killed", runs: 1, fail: 1, cancelled: 0 });
  // a pass: survived at once
  assert.deepEqual(pick(verdictOf(`test("passes", () => {});`)), { verdict: "survived", runs: 1, fail: 0, cancelled: 0 });
});
