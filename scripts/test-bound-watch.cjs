// Card test-runs-never-hold-a-slot: the watch every package's `node --test` loads (--require=../../scripts/test-bound-watch.cjs)
// to stop a test file's process at FILE_MS and the run's at RUN_MS (scripts/test-bound.mjs names both and why). A
// --require preload runs in the runner's own process and in each file's; an --import one only in the files' (read on
// node 24.22.3), and the run needs its own bound: a process a test leaves behind holding a file's output keeps
// node --test waiting after every file has ended. The watch is a worker thread: a spin on the main thread, or a test's
// mocked clock, cannot hold it, and an unref'd worker never keeps a process alive.
const { isMainThread, Worker } = require("node:worker_threads");
const { FILE_MS, RUN_MS } = require("./test-bound.mjs");

// TEST_BOUND_FILE_MS and TEST_BOUND_RUN_MS may only lower a bound, so the planted hangs of scripts/ci/test-bound.test.mjs
// end in seconds; a value that is not a lower whole number of ms is ignored
const lower = (name, ms) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < ms ? v : ms;
};

const WATCH = `
const { workerData: w } = require("node:worker_threads");
const { writeSync } = require("node:fs");
setTimeout(() => {
  try { writeSync(2, "\\ntest-bound: " + w.what + " still running at its bound (" + w.ms + " ms), stopped: " + w.name + "\\n"); } catch {}
  process.kill(w.pid, "SIGKILL");
}, w.ms);
`;

/** Stops this process once `ms` have passed, printing which bound and `name`. */
function arm(ms, what, name) {
  new Worker(WATCH, { eval: true, workerData: { pid: process.pid, ms, what, name }, stdout: false, stderr: false }).unref();
}

// a test file's own process (the runner starts each with NODE_TEST_CONTEXT set), or the run's (node --test itself); a
// worker thread (a test's own, which inherits --require, or this watch) arms nothing: its process is watched already
if (isMainThread && process.env.NODE_TEST_CONTEXT !== undefined) arm(lower("TEST_BOUND_FILE_MS", FILE_MS), "the test file", process.argv[1] ?? "?");
else if (isMainThread && process.execArgv.includes("--test")) arm(lower("TEST_BOUND_RUN_MS", RUN_MS), "the test run", process.cwd());
