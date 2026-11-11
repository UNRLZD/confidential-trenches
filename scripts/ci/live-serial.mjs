// Runs a serial group's live checks one after another, in the one job of the live run (card helper-live-jup-serial; the
// plan's `group` entry, scripts/ci/live-plan.mjs, and helper-live-checks.mjs SERIAL_GROUPS say why): the checks that spend
// the helper's Jupiter budget between them must not run together, and each starts only once the helper's own answer says
// the budget is idle (scripts/ci/jup-idle.mjs), so a check reads the budget, never the one that ran before it.
//   - every member runs, in the order given, whatever an earlier one ended with: the run reads every verdict;
//   - a member that FAILs or errors runs once: no retry, so a red is the check's own and stays red. A member that ends
//     INCONCLUSIVE (exit 3: its providers did not answer) runs again after a pause, each run once the budget is idle, as a
//     single check does (scripts/ci/live-rerun.mjs, card live-inconclusive-rerun); still INCONCLUSIVE at the bound, or a
//     member whose exit 2 its own last verdict line calls INCONCLUSIVE, it is its own result (card
//     live-run-red-means-the-build): never a pass, never red, named with its reason in the group's last line and verdict
//     file;
//   - a member that says it is done with the budget (RELEASES: its `live-check <key>: budget released` line, printed once
//     its last helper call is made) lets the next member start while it reads on (card live-run-red-means-the-build:
//     solana-mint-supply-moves spent its two dry builds in its first minute, then 10 of the run's 17 minutes reading public
//     RPCs for a burn while the budget sat idle). It is given a deadline (RELEASES' flag, the group's start plus withinMs)
//     so the group ends in time, it runs first so its wait is spent beside the others, and it is never run again (a rerun
//     would spend the budget beside them); the group awaits it at the end. A check of an older commit that prints no such
//     line holds its turn to its end, as before;
//   - a budget that is not idle in time (jup-idle's IDLE_MAX_MS) stops the group there, the members left named as not run:
//     something other than this run is spending the budget, and a check started now would read that.
// Each member's output is printed as it comes, under a `=== <key>` line, so the job's log and summary hold each check's own
// verdict line. The group ends with one line: `live-serial: PASS <n> checks` (with its inconclusive members and their
// reasons) or `live-serial: FAIL <keys>`, and writes every member's result to the job's verdict file (live-rerun.mjs
// writeVerdicts), which the live job reads.
// As live-rerun.mjs: the runner is the workflow's own (.live-runner), the checks are those under the folder it is started
// in (the deployed commit's), and it writes the job's log itself (--log), its exit with no pipe after it.
//   node <runner>/scripts/ci/live-serial.mjs --log <file> <key> <key> ...      exit 0 when no member failed or erred (a
//   pass or an inconclusive each), 1 when one did or was not run, 2 on an error
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { waitIdle } from "./jup-idle.mjs";
import { RERUN, isCheck, logArg, noticeLine, reasonOf, rerun, runCheck as runOnce, sink, verdictLine, verdictOf, writeVerdicts } from "./live-rerun.mjs";

/** The members that say when they are done with the budget, and the flag that gives each its deadline (epoch ms): the
 *  group's start plus withinMs. solana-mint-supply-moves: its burn reads end by then, so the group, and the helper's
 *  live run, end inside 10 minutes (its wait stays its own: a run with no burn in it is inconclusive, never a pass). */
export const RELEASES = Object.freeze({ "solana-mint-supply-moves": Object.freeze({ flag: "--burn-until", withinMs: 390_000 }) });
/** The line a member prints once its last helper call is made. */
export const releasedLine = (key) => `live-check ${key}: budget released`;

/** One run of a check under `root`, as the job runs a single one: { code, output }. `args` its arguments. */
export function runCheck(key, root = process.cwd(), write, args = []) {
  return runOnce(key, args, root, write);
}

/**
 * Runs `keys` in order: `idle()` first for each run ({ idle, why, ... }), then `run(key, args, write)` ({ code, output }
 * or an exit code; `write(chunk)`, when given, where its output goes as it comes), again on exit 3 (live-rerun.mjs's
 * rerun, with `sleep`, `random` and `policy`). A member of `releases` (RELEASES) runs once, given its deadline (`now()`
 * at the start plus its withinMs); the next member starts once its output holds releasedLine, and what it prints after
 * that line is held and written (`write`) whole once it ends, so two checks' lines never mix in the log. Returns { ok,
 * failed: [key], inconclusive: [key], notRun: [key], results: [{ key, verdict, reason, runs }] } and prints through `say`.
 */
export async function serial(keys, { idle, run, say = console.log, write = (b) => process.stdout.write(b), sleep, random, policy = RERUN, releases = RELEASES, now = Date.now }) {
  const start = now();
  const results = new Map();
  const notRun = [];
  const background = [];
  let stopped = null;
  const gate = (key) => async (n) => {
    say(`=== ${key}: waiting for the helper's Jupiter budget to be idle${n > 1 ? ` (run ${n})` : ""}`);
    const g = await idle();
    if (!g.idle) {
      say(`BAD the helper's Jupiter budget was not idle in ${g.waitedMs} ms (${g.probes} probes) before ${key}${n > 1 ? ` run ${n}` : ""}: ${g.why}`);
      return false;
    }
    say(`=== ${key}: idle after ${g.probes} probes, ${g.waitedMs} ms; running`);
    return true;
  };
  for (const [i, key] of keys.entries()) {
    const rel = Object.hasOwn(releases, key) ? releases[key] : null;
    if (rel) {
      if (!(await gate(key)(1))) {
        stopped = key;
        notRun.push(...keys.slice(i));
        break;
      }
      let text = "";
      let held = null;
      let free;
      const freed = new Promise((r) => (free = r));
      const args = [rel.flag, String(start + rel.withinMs)];
      const done = Promise.resolve(run(key, args, (b) => {
        if (held !== null) return void (held += String(b));
        text += String(b);
        const at = text.indexOf(`${releasedLine(key)}\n`);
        if (at < 0) return void write(b);
        // the released line, whole, then everything after it held
        const cut = at + releasedLine(key).length + 1;
        const shown = text.length - String(b).length;
        write(text.slice(shown, Math.max(shown, cut)));
        held = text.slice(Math.max(shown, cut));
        free();
      })).then(
        (out) => {
          const code = typeof out === "number" ? out : Number.isInteger(out?.code) ? out.code : 2;
          const output = typeof out === "number" ? "" : (out?.output ?? text);
          const verdict = verdictOf(key, code, output);
          if (held !== null) {
            say(`=== ${key}: its output since it was done with the budget`);
            if (held) write(held.endsWith("\n") ? held : `${held}\n`);
          }
          say(`=== ${key}: exit ${code}`);
          results.set(key, { key, verdict, reason: verdict === "pass" ? "" : verdict === "inconclusive" ? reasonOf(key, output) : (verdictLine(key, output)?.line ?? `exit ${code}`), runs: 1 });
        },
        (e) => void results.set(key, { key, verdict: "error", reason: `the runner could not run it: ${e?.message ?? e}`, runs: 1 }),
      );
      background.push(done);
      results.set(key, null);
      await Promise.race([done, freed]);
      if (!results.get(key)) say(`=== ${key}: done with the budget; reading on beside the next members (its deadline in ${Math.round((start + rel.withinMs - now()) / 1000)} s)`);
      continue;
    }
    const r = await rerun(key, [], { run: async (k) => {
      const out = await run(k, []);
      say(`=== ${key}: exit ${typeof out === "number" ? out : out?.code}`);
      return out;
    }, say, before: gate(key), policy, ...(sleep ? { sleep } : {}), ...(random ? { random } : {}) });
    if (r.stopped && r.runs === 0) {
      stopped = key;
      notRun.push(...keys.slice(i));
      break;
    }
    results.set(key, { key, verdict: r.stopped ? "error" : r.verdict, reason: r.stopped ? `the helper's Jupiter budget was not idle before run ${r.runs + 1}` : r.reason, runs: r.runs });
    if (r.stopped) {
      notRun.push(...keys.slice(i + 1));
      break;
    }
  }
  await Promise.all(background);
  const list = [...results.values()].filter(Boolean);
  for (const k of notRun) list.push({ key: k, verdict: "not_run", reason: k === stopped ? "the helper's Jupiter budget was not idle before it" : "the group stopped before it", runs: 0 });
  // a member the budget stopped before its first run is red, as one that failed (the rest are only not run)
  const failed = list.filter((x) => (x.verdict !== "pass" && x.verdict !== "inconclusive" && x.verdict !== "not_run") || x.key === stopped).map((x) => x.key);
  const inconclusive = list.filter((x) => x.verdict === "inconclusive");
  const ok = failed.length === 0 && notRun.length === 0;
  const inc = inconclusive.length ? ` (inconclusive: ${inconclusive.map((x) => `${x.key}: ${x.reason}`).join("; ")})` : "";
  say(ok ? `live-serial: PASS ${keys.length} checks, one after another${inc}` : `live-serial: FAIL ${failed.join(", ")}${notRun.length ? ` (not run: ${notRun.join(", ")})` : ""}${inc}`);
  return { ok, failed, inconclusive: inconclusive.map((x) => x.key), notRun, results: list };
}

/** The command line: `--log <file>` and the keys, the checks under `root`. Resolves the exit code. `idle` stands in for
 *  the helper's budget read in the tests. */
export async function main(argv, { root = process.cwd(), idle } = {}) {
  const { log, rest: keys } = logArg(argv);
  const out = sink(log);
  try {
    const bad = keys.filter((k) => !isCheck(k, root));
    if (keys.length === 0 || bad.length > 0) {
      const line = `live-serial: ERROR: ${keys.length === 0 ? "no check named" : `no such check: ${bad.join(", ")} in ${root}/scripts/live-checks`}`;
      out.say(line);
      writeVerdicts(log, (keys.length ? keys : [""]).map((k) => ({ key: k, verdict: "error", reason: line, runs: 0 })));
      return 2;
    }
    const r = await serial(keys, { idle: idle ?? (() => waitIdle({ log: out.say })), run: (k, args, w) => runCheck(k, root, w ?? out.write, args), say: out.say, write: out.write });
    writeVerdicts(log, r.results);
    for (const x of r.results) if (x.verdict === "inconclusive") out.say(noticeLine(x.key, x.reason));
    return r.ok ? 0 : 1;
  } catch (e) {
    out.say(`live-serial: ERROR: ${e.message}`);
    writeVerdicts(log, keys.map((k) => ({ key: k, verdict: "error", reason: `live-serial: ERROR: ${e.message}`, runs: 0 })));
    return 2;
  } finally {
    out.close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
