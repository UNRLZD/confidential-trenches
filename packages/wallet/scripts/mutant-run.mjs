// One test run of a mutant sweep (pool-solana-mutants.mjs, pool-solana-review-mutants.mjs). The tests run in the child's
// own process (--test-isolation=none), so a timeout's SIGKILL stops the process that runs them: with a file runner per
// test file, spawnSync's kill reaches only the runner and the file's process, spinning on a mutant that loops, is left
// behind (ppid 1; card sol-restore-race, 3 Nov 04:20Z). --test-force-exit ends the run once every test has ended, so a
// mutant whose loop still yields fails at its test's own timeout instead of holding the process to the cap. The run is
// in a process group of its own, killed whole at its end (scripts/group-run.mjs): a process a test started dies too.
import { runSync } from "../../../scripts/group-run.mjs";

/** Runs `node --test --test-isolation=none ...args` in cwd; hung: it ran past timeoutMs and was killed. fail and cancelled
 * (a test stopped at its own timeout: node prints it apart from fail) are counted apart. */
export function runTests(args, { cwd, timeoutMs }) {
  const r = runSync(process.execPath, ["--test", "--test-isolation=none", "--test-force-exit", ...args], { cwd, env: ownRun(), encoding: "utf8", timeoutMs });
  const stdout = r.stdout ?? "";
  return { hung: r.signal === "SIGKILL" || r.timedOut, status: r.status, stdout, fail: count(stdout, "fail"), cancelled: count(stdout, "cancelled"), pass: count(stdout, "pass") };
}

/**
 * One mutant's verdict. killed: a test failed. A run whose only failures are tests cancelled at their own timeout is run
 * once more, since a correct but slow run under load is cancelled too (fold 6: M7 read SURVIVED on fail 0, cancelled 1;
 * fold 7: a cancel alone is no kill): a real failure then is killed, a pass survived, and a second cancel alone is
 * cancelled, listed apart and never counted, as hung (past the cap) is. runs: 1 or 2.
 */
export function runMutant(args, opts) {
  for (let runs = 1; ; runs++) {
    const r = runTests(args, opts);
    const verdict = r.hung ? "hung" : r.status !== 0 && r.fail > 0 ? "killed" : r.status !== 0 && r.cancelled > 0 ? "cancelled" : "survived";
    if (verdict !== "cancelled" || runs === 2) return { ...r, verdict, runs };
  }
}

const count = (stdout, what) => Number((stdout.match(new RegExp(`ℹ ${what} (\\d+)`)) ?? [])[1] ?? 0);
// a run started from inside a node --test file (the runner's own test) is a run of its own: NODE_TEST_CONTEXT would make
// the child report to that parent and print no summary to count
const ownRun = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
