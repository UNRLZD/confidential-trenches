// Card test-runs-never-hold-a-slot: the bound on every package's test run. Each workspace package's `test` script runs
//   node --test --require=../../scripts/test-bound-watch.cjs --test-timeout=<TEST_MS> --test-force-exit <files>
// (scripts/ci/tests-run.test.mjs holds every one to that form and to TEST_MS; scripts/ci/test-bound.test.mjs plants
// the hangs). node --test bounds a test (--test-timeout cancels it and names it) but never a test file: a file that spins
// without yielding, hangs at its top level, or keeps a handle open once its tests have ended is waited on for ever, and
// the run with it (18 Nov 17:00Z: the whole wallet run held a heavy slot 49 min in one lost abort). --test-force-exit
// ends a file once its tests have ended; scripts/test-bound-watch.cjs stops a file process still running at FILE_MS, its
// name printed as the failure, and the run goes on, and the run's own process past RUN_MS (a process a test left behind
// holding a file's output open) the same way. This file only names the bounds, so a gate can import them.

/** One test (--test-timeout): over the slowest test of any suite, 197 s, read with every suite at once on a loaded Mac
 *  (18 Nov, /tmp/rhv3-pkg.log); a test that names its own timeout keeps it. */
export const TEST_MS = 300_000;
/** One test file's process: the longest bound any suite's test names (signpage restore-speed, 900 s), over the slowest
 *  whole suite in that run (helper, 532 s). */
export const FILE_MS = 900_000;
/** The whole run (the node --test process): CI's longest job (ci.yml timeout-minutes: 30). */
export const RUN_MS = 1_800_000;
/** Card hung-test-file-named-in-ci: a CI job's own limit ends it and names nothing, and the bounds above cannot know when
 *  the job started (release 197's first queue run lost test-packages (1) to its 15 minutes, no file named). Each CI job
 *  that runs a package's tests sets TEST_BOUND_DEADLINE (ms since the epoch) a minute before its limit: a file still
 *  running then is stopped by name, and the run this long after it, so the file's name reaches the log first. */
export const DEADLINE_GRACE_MS = 20_000;
