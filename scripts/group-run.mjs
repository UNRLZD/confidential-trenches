// One test run of a mutant sweep, in a process group of its own. A timeout's kill on the run's own process reaches only
// that process: node --test's per-file child, or a process a test started (a local server, a validator), lived on
// with parent 1, spinning for hours (three found 5 Nov 05:10Z, 6 to 15 hours old). Here the run's process leads its
// own group, and the whole group is killed when the run ends, on its timeout, and when the sweep itself exits (an
// interrupt or a SIGTERM included), so no process the run started outlives it.
//   runSync(cmd, args, { timeoutMs, ...spawnSync options }) -> spawnSync's result and timedOut
//   run(cmd, args, { timeoutMs, ...spawn options }) -> a promise of { status, signal, stdout, stderr, timedOut, error }
// A sweep that is itself killed with SIGKILL cannot run any of this; a sync run defers the sweep's SIGINT and SIGTERM
// to the end of the run in progress, which its timeout bounds.
import { spawn, spawnSync } from "node:child_process";

const live = new Set();
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
  });
  // a signal ends the sweep through exit, so the groups above die with it
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(sig, () => process.exit(128 + n));
}

const need = (timeoutMs) => {
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new Error(`group-run: timeoutMs must be a positive whole number of ms, got ${timeoutMs}`);
};

/** spawnSync in a group of its own, the group killed once the run ends (its timeout included). At the timeout the run's
 *  own process gets killSignal (SIGKILL unless named: a sweep run as a test takes SIGTERM, so it ends its own groups). */
export function runSync(cmd, args, { timeoutMs, ...opts }) {
  need(timeoutMs);
  hook();
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 26, killSignal: "SIGKILL", ...opts, detached: true, timeout: timeoutMs });
  if (r.pid > 0) killGroup(r.pid);
  return { ...r, timedOut: r.error?.code === "ETIMEDOUT" };
}

/** spawn in a group of its own; resolves once the run's output has closed, its group killed at its exit or timeout. */
export function run(cmd, args, { timeoutMs, maxBuffer = 1 << 26, ...opts }) {
  need(timeoutMs);
  hook();
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let error;
    const pgid = c.pid;
    if (pgid > 0) live.add(pgid);
    const end = () => {
      if (pgid > 0) {
        killGroup(pgid);
        live.delete(pgid);
      }
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
