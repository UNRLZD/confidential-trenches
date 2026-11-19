// One test run of a mutant sweep, in a process group of its own. A timeout's kill on the run's own process reaches only
// that process: node --test's per-file child, or a process a test started (a local server, a validator), lived on
// with parent 1, spinning for hours (three found 5 Nov 05:10Z, 6 to 15 hours old). Here the run's process leads its
// own group, and the whole group is killed when the run ends, on its timeout, and when the sweep itself exits (an
// interrupt or a SIGTERM included), so no process the run started outlives it.
//   runSync(cmd, args, { timeoutMs, ...spawnSync options }) -> spawnSync's result and timedOut
//   run(cmd, args, { timeoutMs, ...spawn options }) -> a promise of { status, signal, stdout, stderr, timedOut, error }
// A sweep that is itself killed with SIGKILL cannot run any of this. A sync sweep turns no event loop between its runs,
// so a SIGINT or SIGTERM it gets waits for every run it has left: each run is given its end (GROUP_RUN_UNTIL_MS, unix
// ms) and a run inside it ends by then too, the sweep with it (exit 124 at its next run), so a sweep ends at the bound
// of the run it is in.
//   withPlant(file, text, run) -> run()'s result, with `text` written over `file` while it runs
// A plant is put back before the process ends: at withPlant's end, and on the way out of a process that ends inside it
// (that exit 124, a signal's exit, a throw), since a process.exit skips the sweep's own finally (card
// mutant-sweeps-refuse-no-verdict). A SIGKILL can put nothing back.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const live = new Set();
// file -> its bytes before the plant written over it now
const planted = new Map();
let hooked = false;

/** SIGKILL to the whole group `pgid`; a group already gone is no error. */
export function killGroup(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (e) {
    if (e.code !== "ESRCH" && e.code !== "EPERM") throw e;
  }
}

function hook() {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const g of live) killGroup(g);
    for (const [file, text] of planted) writeFileSync(file, text);
  });
  // a signal ends the sweep through exit, so the groups above die with it
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(sig, () => process.exit(128 + n));
}

/** Writes `text` over `file`, runs `run` (sync) and puts the file's own text back, whether run returns or throws; the text
 *  is kept and the exit hook set before the write, so a process that ends inside run puts it back on its way out. */
export function withPlant(file, text, run) {
  if (planted.has(file)) throw new Error(`group-run: ${file} is already planted`);
  hook();
  planted.set(file, readFileSync(file));
  try {
    writeFileSync(file, text);
    return run();
  } finally {
    writeFileSync(file, planted.get(file));
    planted.delete(file);
  }
}

const UNTIL = "GROUP_RUN_UNTIL_MS";

/** This run's timeout, cut to the end of the run this process is inside, and the env that hands its own end on; past
 *  that end, the process exits 124 (its live groups killed on the way out). */
function bounded(timeoutMs, env) {
  const outer = Number(process.env[UNTIL]);
  if (Number.isFinite(outer)) {
    const left = Math.ceil(outer - Date.now());
    if (left <= 0) {
      console.error("group-run: past the end of the run this one is inside");
      process.exit(124);
    }
    timeoutMs = Math.min(timeoutMs, left);
  }
  return { timeoutMs, env: { ...(env ?? process.env), [UNTIL]: String(Date.now() + timeoutMs) } };
}

const need = (timeoutMs) => {
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new Error(`group-run: timeoutMs must be a positive whole number of ms, got ${timeoutMs}`);
};

/** spawnSync in a group of its own, the group killed once the run ends (its timeout included). At the timeout the run's
 *  own process gets killSignal (SIGKILL unless named: a sweep run as a test takes SIGTERM, so it ends its own groups). */
export function runSync(cmd, args, { timeoutMs: asked, ...opts }) {
  need(asked);
  hook();
  const { timeoutMs, env } = bounded(asked, opts.env);
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 26, killSignal: "SIGKILL", ...opts, env, detached: true, timeout: timeoutMs });
  if (r.pid > 0) killGroup(r.pid);
  return { ...r, timedOut: r.error?.code === "ETIMEDOUT" };
}

/** spawn in a group of its own; resolves once the run's output has closed, its group killed at its exit or timeout. */
export function run(cmd, args, { timeoutMs: asked, maxBuffer = 1 << 26, ...opts }) {
  need(asked);
  hook();
  const { timeoutMs, env } = bounded(asked, opts.env);
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { ...opts, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let error;
    const pgid = c.pid;
    if (pgid > 0) live.add(pgid);
    // once only: a group id once gone can be another group's later
    const end = () => {
      if (live.delete(pgid)) killGroup(pgid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, timeoutMs);
    const take = (add) => {
      if (stdout.length + stderr.length + add.length > maxBuffer) {
        error ??= new Error(`group-run: output past ${maxBuffer} bytes`);
        end();
        return "";
      }
      return add;
    };
    c.stdout.setEncoding("utf8").on("data", (d) => (stdout += take(d)));
    c.stderr.setEncoding("utf8").on("data", (d) => (stderr += take(d)));
    // the run's own process has ended: what it left behind in its group ends with it, which also closes the output
    c.on("exit", end);
    c.on("error", (e) => (error ??= e));
    c.on("close", (status, signal) => {
      clearTimeout(timer);
      end();
      resolve({ status, signal, stdout, stderr, timedOut, error });
    });
  });
}
