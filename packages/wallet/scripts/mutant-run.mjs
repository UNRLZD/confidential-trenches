// One test run of a mutant sweep (pool-solana-mutants.mjs, pool-solana-review-mutants.mjs). The tests run in the child's
// own process (--test-isolation=none), so a timeout's SIGKILL stops the process that runs them: with a file runner per
// test file, spawnSync's kill reaches only the runner and the file's process, spinning on a mutant that loops, is left
// behind (ppid 1; card sol-restore-race, 3 Nov 04:20Z). --test-force-exit ends the run once every test has ended, so a
// mutant whose loop still yields fails at its test's own timeout instead of holding the process to the cap.
import { spawnSync } from "node:child_process";

/** Runs `node --test --test-isolation=none ...args` in cwd; hung: it ran past timeoutMs and was killed. */
export function runTests(args, { cwd, timeoutMs }) {
  const r = spawnSync(process.execPath, ["--test", "--test-isolation=none", "--test-force-exit", ...args], { cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  const stdout = r.stdout ?? "";
  return { hung: r.signal === "SIGKILL" || r.error?.code === "ETIMEDOUT", status: r.status, stdout, fail: Number((stdout.match(/ℹ fail (\d+)/) ?? [])[1] ?? 0), pass: Number((stdout.match(/ℹ pass (\d+)/) ?? [])[1] ?? 0) };
}
