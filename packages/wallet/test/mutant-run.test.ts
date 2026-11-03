// The mutant sweeps' runner (scripts/mutant-run.mjs) leaves no process behind when a run hangs: a planted test file that
// spins forever without yielding is killed at the timeout, its process with it (card sol-restore-race, 3 Nov 04:20Z).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error: a plain .mjs script, no types
import { runTests } from "../scripts/mutant-run.mjs";

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
