// Runs a serial group's live checks one after another, in the one job of the live run (card helper-live-jup-serial; the
// plan's `group` entry, scripts/ci/live-plan.mjs, and helper-live-checks.mjs SERIAL_GROUPS say why): the checks that spend
// the helper's Jupiter budget between them must not run together, and each starts only once the helper's own answer says
// the budget is idle (scripts/ci/jup-idle.mjs), so a check reads the budget, never the one that ran before it.
//   - every member runs, in the order given, whatever an earlier one ended with: the run reads every verdict;
//   - a member that FAILs or errors runs once: no retry, so a red is the check's own and stays red. A member that ends
//     INCONCLUSIVE (exit 3: its providers did not answer) runs again after a pause, each run once the budget is idle, as a
//     single check does (scripts/ci/live-rerun.mjs, card live-inconclusive-rerun); still INCONCLUSIVE at the bound, it is red;
//   - a budget that is not idle in time (jup-idle's IDLE_MAX_MS) stops the group there, the members left named as not run:
//     something other than this run is spending the budget, and a check started now would read that.
// Each member's output is printed as it comes, under a `=== <key>` line, so the job's log and summary hold each check's own
// verdict line. The group ends with one line: `live-serial: PASS <n> checks` or `live-serial: FAIL <keys>`.
//   node scripts/ci/live-serial.mjs <key> <key> ...      exit 0 when every member passed, else 1
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitIdle } from "./jup-idle.mjs";
import { RERUN, rerun, runCheck as runOnce } from "./live-rerun.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = /^[a-z][a-z0-9-]*$/;

/** One run of a check, as the job runs a single one (`node scripts/live-checks/<key>.mjs`): { code, output }. */
export function runCheck(key, root = ROOT) {
  return runOnce(key, [], root);
}

/**
 * Runs `keys` in order: `idle()` first for each run ({ idle, why, ... }), then `run(key)` ({ code, output } or an exit
 * code), again on exit 3 (live-rerun.mjs's rerun, with `sleep`, `random` and `policy`). Returns
 * { ok, failed: [key], notRun: [key] } and prints through `say`.
 */
export async function serial(keys, { idle, run, say = console.log, sleep, random, policy = RERUN }) {
  const failed = [];
  const notRun = [];
  for (const [i, key] of keys.entries()) {
    const gate = async (n) => {
      say(`=== ${key}: waiting for the helper's Jupiter budget to be idle${n > 1 ? ` (run ${n})` : ""}`);
      const g = await idle();
      if (!g.idle) {
        say(`BAD the helper's Jupiter budget was not idle in ${g.waitedMs} ms (${g.probes} probes) before ${key}${n > 1 ? ` run ${n}` : ""}: ${g.why}`);
        return false;
      }
      say(`=== ${key}: idle after ${g.probes} probes, ${g.waitedMs} ms; running`);
      return true;
    };
    const r = await rerun(key, [], { run: async (k) => {
      const out = await run(k);
      say(`=== ${key}: exit ${typeof out === "number" ? out : out?.code}`);
      return out;
    }, say, before: gate, policy, ...(sleep ? { sleep } : {}), ...(random ? { random } : {}) });
    if (r.stopped) {
      failed.push(key);
      notRun.push(...keys.slice(r.runs === 0 ? i : i + 1));
      break;
    }
    if (r.code !== 0) failed.push(key);
  }
  say(failed.length === 0 ? `live-serial: PASS ${keys.length} checks, one after another` : `live-serial: FAIL ${failed.join(", ")}${notRun.length ? ` (not run: ${notRun.join(", ")})` : ""}`);
  return { ok: failed.length === 0, failed, notRun };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keys = process.argv.slice(2);
  const bad = keys.filter((k) => !KEY.test(k) || !existsSync(path.join(ROOT, "scripts/live-checks", `${k}.mjs`)));
  if (keys.length === 0 || bad.length > 0) {
    console.error(`live-serial: ERROR: ${keys.length === 0 ? "no check named" : `no such check: ${bad.join(", ")}`}`);
    process.exit(2);
  }
  try {
    const r = await serial(keys, { idle: () => waitIdle({ log: (l) => console.log(l) }), run: (k) => runCheck(k) });
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-serial: ERROR: ${e.message}`);
    process.exit(2);
  }
}
