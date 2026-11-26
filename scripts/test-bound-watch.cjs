// Card test-runs-never-hold-a-slot: the watch every package's `node --test` loads (--require=../../scripts/test-bound-watch.cjs)
// to stop a test file's process at FILE_MS and the run's at RUN_MS (scripts/test-bound.mjs names both and why). A
// --require preload runs in the runner's own process and in each file's; an --import one only in the files' (read on
// node 24.22.3), and the run needs its own bound: a process a test leaves behind holding a file's output keeps
// node --test waiting after every file has ended. The watch is a worker thread: a spin on the main thread, or a test's
// mocked clock, cannot hold it, and an unref'd worker never keeps a process alive.
const { isMainThread, Worker } = require("node:worker_threads");
const { DEADLINE_GRACE_MS, FILE_MS, RUN_MS } = require("./test-bound.mjs");
/** The bound on the run's stop listing its group (ps). [design: 5 s, a quarter of DEADLINE_GRACE_MS, so the list and
 *  the kill land inside the job's limit; ps itself answers in well under a second] */
const PS_MS = 5_000;

// Card readme-run-fits-an-agent-timeout: node's own compile cache, in the run's process, each file's and every node
// process a test starts (they inherit NODE_COMPILE_CACHE). A run is about 700 file processes, each compiling and
// type-stripping the modules the others did (read on node 24.22.3: a small helper file 0.46 CPU-s without the cache, 0.20
// with it warm). Node keys each entry by the module's source and its own version, so a changed file is compiled again. A
// cache the caller names is kept, and NODE_DISABLE_COMPILE_CACHE turns it off, as node documents
// (scripts/ci/test-compile-cache.test.mjs).
if (process.env.NODE_COMPILE_CACHE === undefined && process.env.NODE_DISABLE_COMPILE_CACHE === undefined) {
  process.env.NODE_COMPILE_CACHE = require("node:path").join(__dirname, "..", "node_modules", ".cache", "node-compile-cache");
  require("node:module").enableCompileCache?.(process.env.NODE_COMPILE_CACHE);
}

// Card tests-make-no-late-reads: a connection to a host off this machine is refused and fails the file
// (scripts/test-no-network.cjs)
require("./test-no-network.cjs");

// TEST_BOUND_FILE_MS and TEST_BOUND_RUN_MS may only lower a bound, so the planted hangs of scripts/ci/test-bound.test.mjs
// end in seconds; a value that is not a lower whole number of ms is ignored
const lower = (name, ms) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < ms ? v : ms;
};

// Card ci-kit-shard-never-stalls-silent: the run's stop lists every process of the run's group (the runner, each test
// file's process and any process they started, which keeps the group when its parent ends) with its state and what it
// waits on, read by ps (the same keywords on Linux and macOS). Merge queue run 45744571533 (job 139657420490) stopped the
// kit's run at the job's deadline after 742 s with no line, and nothing read said whether a file was still running (none
// was named stopped at the deadline, 20 s before the run) or the runner itself was held. The list is bounded (PS_MS) and
// never holds the kill.
const WATCH = `
const { workerData: w } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const say = (t) => { try { writeSync(2, t); } catch {} };
setTimeout(() => {
  say("\\ntest-bound: " + w.what + " still running at " + w.at + ", stopped: " + w.name + "\\n");
  if (w.list) say(groupList(w.pid));
  process.kill(w.pid, "SIGKILL");
}, w.ms);
function groupList(pid) {
  let rows;
  try {
    const out = require("node:child_process").execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,etime=,wchan=,command="], { encoding: "utf8", timeout: ${PS_MS}, maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "ignore"] });
    rows = out.split("\\n").map((l) => l.trim().split(/\\s+/)).filter((r) => r.length >= 7 && /^\\d+$/.test(r[0]));
  } catch (e) {
    return "test-bound: its processes could not be listed (ps: " + String(e && (e.code || e.message)).slice(0, 80) + ")\\n";
  }
  const own = rows.find((r) => r[0] === String(pid));
  // the group but this list's own ps; a command's end kept, where a test file's process names its file (node puts the
  // runner's flags first and the file last)
  const group = own === undefined ? [] : rows.filter((r) => r[2] === own[2] && !(r[6] === "ps" && r[7] === "-A"));
  const tail = (c) => (c.length > 300 ? "..." + c.slice(-297) : c);
  return "test-bound: its group's processes at the stop (pid ppid stat elapsed wchan command):\\n" + group.map((r) => "test-bound:   " + r.slice(0, 2).join(" ") + " " + r.slice(3, 6).join(" ") + " " + tail(r.slice(6).join(" ")) + "\\n").join("");
}
`;

/** Stops this process at its bound `ms`, or at the job's deadline (TEST_BOUND_DEADLINE, plus `grace`) when that comes
 *  first, printing which and `name`, and with `list` its group's processes. A deadline that is not a whole number of ms
 *  since the epoch is ignored. */
function arm(ms, grace, what, name, list = false) {
  const d = Number(process.env.TEST_BOUND_DEADLINE);
  const left = Number.isSafeInteger(d) && d > 0 ? Math.max(1, d + grace - Date.now()) : Infinity;
  const at = left < ms ? { ms: left, at: "the job's deadline" } : { ms, at: `its bound (${ms} ms)` };
  new Worker(WATCH, { eval: true, workerData: { pid: process.pid, ...at, what, name, list }, stdout: false, stderr: false }).unref();
}

// Card test-count-never-short: stdout and stderr written in full before any exit. On macOS a pipe is written
// asynchronously, so --test-force-exit's process.exit() (node v24.22.3 lib/internal/test_runner/test.js:1468-1492)
// dropped a file's last results still queued for the runner, and the runner's own last lines: 3,499 to 3,592 of 3,600
// tests reported beside a CPU load, exit 0. Linux writes a pipe synchronously already; this makes macOS do the same, in
// the runner and in every file's process (scripts/test-report.mjs refuses a run that still lost one). Only those two: a
// process a test starts inherits this preload (fork's execArgv, NODE_OPTIONS) and NODE_TEST_CONTEXT, and a blocking
// write to a parent that reads it only after it exits never returns (scripts/ci/test-report.test.mjs plants one: a
// child that writes 1 MiB and exits held its file until the run's cap). A file's process is the runner's own child,
// named by the pid the runner leaves in RUNNER_PID; any process past it keeps node's own writes.
const RUNNER_PID = "TEST_BOUND_RUNNER_PID";
if (isMainThread && process.execArgv.includes("--test")) process.env[RUNNER_PID] = String(process.pid);
const reporting = isMainThread && (process.execArgv.includes("--test") || (process.env.NODE_TEST_CONTEXT !== undefined && process.env[RUNNER_PID] === String(process.ppid)));
if (reporting) for (const s of [process.stdout, process.stderr]) if (s._handle && typeof s._handle.setBlocking === "function") s._handle.setBlocking(true);

// a test file's own process (the runner starts each with NODE_TEST_CONTEXT set), or the run's (node --test itself); a
// worker thread (a test's own, which inherits --require, or this watch) arms nothing: its process is watched already
if (isMainThread && process.env.NODE_TEST_CONTEXT !== undefined) arm(lower("TEST_BOUND_FILE_MS", FILE_MS), 0, "the test file", process.argv[1] ?? "?");
else if (isMainThread && process.execArgv.includes("--test")) arm(lower("TEST_BOUND_RUN_MS", RUN_MS), DEADLINE_GRACE_MS, "the test run", process.cwd(), true);
