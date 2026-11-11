// Runs one live check as the live run's check job does, and runs it again when it ends INCONCLUSIVE (card
// live-inconclusive-rerun). An INCONCLUSIVE check (exit 3, scripts/live-checks/provider-answer.mjs's EXIT) did not get
// enough answers from its providers to judge: a public RPC's 429 or outage, no fault of the deploy. Read once and red, it
// undid a good deploy. Now:
//   - exit 3 runs again after a pause, up to RERUN.runs runs in all: capped exponential backoff with equal jitter (Marc
//     Brooker, "Exponential Backoff And Jitter", AWS Architecture Blog, 4 Mar 2015: the pause is half of
//     min(cap, base * 2^n) plus a random part of the other half, so it is never short and parallel jobs do not ask the
//     same provider again in step; Google Cloud Storage's retry strategy retries a 429 the same way);
//   - a run still INCONCLUSIVE after the last one is its own result (card live-run-red-means-the-build): never a pass and
//     never a FAIL. Its last line names the providers that did not answer (the hosts in the no-answer lines
//     provider-answer.mjs writes), the job prints a notice with that reason, writes it to the job's verdict file, and
//     exits 0, so the run is red only when a check judged the build bad; the live job lists every inconclusive check by
//     key with its reason on every run (scripts/ci/live-verdicts.mjs), so one that never judges is seen;
//   - a check that maps its own INCONCLUSIVE to exit 2 so that it is never run again (hosts-main-on-top,
//     solana-mint-supply-moves: waits measured in minutes to hours) is read by its last verdict line: exit 2 whose last
//     `live-check <key>: <VERDICT>` line is INCONCLUSIVE is inconclusive, never run again; any other exit 2 is an ERROR;
//   - exit 0 passes; exit 1 (FAIL), exit 2 (ERROR) and any other code end the job at once, red, never run again: a wrong
//     answer is the deploy's, and a check that crashed may be (a helper answer it could not read).
// Some checks end INCONCLUSIVE for something other than a silent provider: app-discover-rows-hold (no refresh reordered
// a list in its window), deposit-sheet-oneclick-budget (its rerun spends 1Click's budget again), the browser checks that
// saw no event to judge. A rerun is sound for them too: it can turn exit 3 into a PASS or a FAIL that it read, never a
// FAIL into a pass.
// The runner is the workflow's own (live.yml checks it out at github.workflow_sha into .live-runner) and the check is the
// deployed commit's: the check is scripts/live-checks/<key>.mjs under the folder the runner is started in, never under
// the runner's own, so a dispatch of a commit older than the runner still runs its checks (review of 9eaf059a, P2-2).
// The runner writes the job's log itself (--log): the check's stdout and stderr through one pipe, in the order written,
// and its own lines, each also printed as it comes. Its exit is the check's last code, with no pipe or tee after it that
// could change it (review of 9eaf059a, P2-1).
//   node <runner>/scripts/ci/live-rerun.mjs --log <file> <key> [args...]      the check's own exit code, after the reruns
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = /^[a-z][a-z0-9-]*$/;

/** The exit code that is run again (provider-answer.mjs EXIT.INCONCLUSIVE). */
export const INCONCLUSIVE = 3;
/** The bound: 3 runs in all; pauses 15-30 s, then 30-60 s (base 30 s, cap 120 s), past a public RPC's per-second and
 *  per-minute windows, and three runs of the slowest single check (about 2.5 min a job) inside the job's 20 min. */
export const RERUN = Object.freeze({ runs: 3, baseMs: 30_000, capMs: 120_000 });

/** The pause before run `n + 2` (n = 0 for the first rerun), ms: equal jitter. `random` returns [0, 1). */
export function pauseMs(n, policy = RERUN, random = Math.random) {
  const top = Math.min(policy.capMs, policy.baseMs * 2 ** n);
  return Math.round(top / 2 + random() * (top / 2));
}

// A provider's no-answer as provider-answer.mjs names it: `<host> HTTP <status>: <why>` (classify) or
// `<host>: no answer (<why>)` (a fetch that failed); live-rerun.test.mjs holds the two in step. The host is URL.host's:
// a name with a dot, an IPv4 or [IPv6] address, each with an optional port, or any name with a port (localhost:8899).
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST = `(?:(?:${LABEL}\\.)+[a-z][a-z0-9-]*[a-z0-9]|\\d{1,3}(?:\\.\\d{1,3}){3}|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?|${LABEL}:\\d{1,5}`;
const NO_ANSWER = new RegExp(`(?<![\\w.:\\[\\]-])(${HOST})(?: HTTP \\d{3}: |: no answer \\()`, "gi");

/** The hosts named as not answering in a check's output, sorted, each once. */
export function noAnswerHosts(output) {
  return [...new Set([...String(output).matchAll(NO_ANSWER)].map((m) => m[1].toLowerCase()))].sort();
}

/** A run's result: pass, fail, inconclusive or error (see the header). */
export const VERDICTS = Object.freeze(["pass", "fail", "inconclusive", "error"]);

/** The last `live-check <key>: <VERDICT>` line of a check's output: { verdict, line }, or null. */
export function verdictLine(key, output) {
  const re = new RegExp(`^live-check ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (PASS|FAIL|INCONCLUSIVE|ERROR)\\b.*$`, "gm");
  const all = [...String(output).matchAll(re)];
  return all.length ? { verdict: all.at(-1)[1], line: all.at(-1)[0].trim() } : null;
}

/** A run's verdict from its exit code and output (see the header). */
export function verdictOf(key, code, output = "") {
  if (code === 0) return "pass";
  if (code === 1) return "fail";
  if (code === INCONCLUSIVE) return "inconclusive";
  if (code === 2 && verdictLine(key, output)?.verdict === "INCONCLUSIVE") return "inconclusive";
  return "error";
}

/** Why a run was inconclusive, in one line: the check's own last INCONCLUSIVE or `--` line before its verdict line (the
 *  line that says why), else its verdict line, then the providers that did not answer when it named any. */
export function reasonOf(key, output = "", hosts = noAnswerHosts(output)) {
  const lines = String(output).split("\n").map((l) => l.trim()).filter(Boolean);
  const v = verdictLine(key, output);
  const at = v ? lines.lastIndexOf(v.line) : lines.length;
  const why = lines.slice(0, at < 0 ? lines.length : at).reverse().find((l) => /^(?:INCONCLUSIVE\b|--\s)/.test(l));
  const base = (why ?? v?.line ?? "no verdict line in its output").replace(/^--\s+/, "").slice(0, 300);
  return hosts.length ? `${base}; no answer from: ${hosts.join(", ")}` : base;
}

/** The job's exit for a result: 0 on a pass or an inconclusive, 1 on a FAIL, the check's own code (2 when none) on an
 *  error. */
export const exitOf = (verdict, code) => (verdict === "pass" || verdict === "inconclusive" ? 0 : verdict === "fail" ? 1 : Number.isInteger(code) && code > 1 && code !== INCONCLUSIVE ? code : 2);

/** A GitHub notice for an inconclusive check, its title and message escaped as the workflow command reads them. */
export function noticeLine(key, reason) {
  const esc = (t) => String(t).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::notice title=${esc(`inconclusive ${key}`).replace(/:/g, "%3A").replace(/,/g, "%2C")}::${esc(reason)}`;
}

/** The job's verdict file beside its log (`<id>.log` -> `<id>.verdict.json`), which the live job reads. */
export const verdictFile = (log) => (log ? `${log.replace(/\.log$/, "")}.verdict.json` : null);
/** Writes `results` ([{ key, verdict, reason, runs }]) to the verdict file of `log`, when there is one. */
export function writeVerdicts(log, results) {
  const f = verdictFile(log);
  if (f) writeFileSync(f, `${JSON.stringify({ results })}\n`);
}

const named = (hosts) => (hosts.length ? hosts.join(", ") : "none named in its output (its INCONCLUSIVE lines above say why)");

/**
 * Runs `key` through `run(key, args)` ({ code, output }, or a bare exit code), again on exit 3 after `sleep(pauseMs)`,
 * up to policy.runs runs. `before(n)` (optional) is awaited before run n and returns false to stop there (a serial
 * group's budget that is not idle). Returns { code, runs, stopped, verdict, reason, exit }: `code` the last run's (null
 * when none ran), `verdict` the last run's (verdictOf; "error" when stopped before any ran), `reason` why it was not a
 * pass, `exit` the job's (exitOf).
 */
export async function rerun(key, args, { run, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), say = console.log, random = Math.random, policy = RERUN, before = async () => true }) {
  let code = null;
  let last = { verdict: "error", reason: "not run" };
  const quiet = [];
  const end = (runs, stopped) => ({ code, runs, stopped, ...last, exit: exitOf(last.verdict, code) });
  for (let n = 1; ; n++) {
    if (!(await before(n))) {
      if (n === 1) last = { verdict: "error", reason: "not run: the run before it could not start" };
      return end(n - 1, true);
    }
    const r = await run(key, args);
    code = typeof r === "number" ? r : Number.isInteger(r?.code) ? r.code : 2;
    const output = typeof r === "number" ? "" : (r?.output ?? "");
    const verdict = verdictOf(key, code, output);
    const own = verdictLine(key, output)?.line;
    last = { verdict, reason: verdict === "pass" ? "" : verdict === "inconclusive" ? reasonOf(key, output) : (own ?? `exit ${code}`) };
    if (code !== INCONCLUSIVE) {
      if (n > 1) say(`live-rerun ${key}: run ${n} of ${policy.runs} ended exit ${code}${code === 0 ? " PASS" : code === 1 ? " FAIL" : verdict === "inconclusive" ? " INCONCLUSIVE" : " ERROR"}; runs before it were INCONCLUSIVE (no answer from: ${named(quiet)})`);
      else if (verdict === "inconclusive") say(`live-rerun ${key}: exit ${code} INCONCLUSIVE (its last verdict line), never run again: ${last.reason}`);
      else if (code !== 0) say(`live-rerun ${key}: exit ${code}${code === 1 ? " FAIL" : " ERROR"}, never run again`);
      return end(n, false);
    }
    const hosts = noAnswerHosts(output);
    for (const h of hosts) if (!quiet.includes(h)) quiet.push(h);
    if (n >= policy.runs) {
      say(`live-rerun ${key}: INCONCLUSIVE after ${n} runs, never a pass; no answer from: ${named(hosts)}`);
      last = { verdict, reason: `after ${n} runs: ${reasonOf(key, output, hosts)}` };
      return end(n, false);
    }
    const ms = pauseMs(n - 1, policy, random);
    say(`live-rerun ${key}: run ${n} of ${policy.runs} INCONCLUSIVE (no answer from: ${named(hosts)}); run again in ${Math.round(ms / 1000)} s`);
    await sleep(ms);
  }
}

/** Where output goes: printed as it comes, and appended to the log file when there is one. Returns { write, say, close }. */
export function sink(logFile) {
  const fd = logFile ? openSync(logFile, "a") : null;
  const write = (b) => {
    process.stdout.write(b);
    if (fd !== null) writeSync(fd, b);
  };
  return { write, say: (line) => write(`${line}\n`), close: () => fd !== null && closeSync(fd) };
}

/** `--log <file>` first, then the rest: { log, rest }. */
export function logArg(argv) {
  return argv[0] === "--log" && argv.length >= 2 ? { log: argv[1], rest: argv.slice(2) } : { log: null, rest: argv };
}

/** Whether `key` names a check under `root`'s scripts/live-checks. */
export const isCheck = (key, root) => KEY.test(key) && existsSync(path.join(root, "scripts/live-checks", `${key}.mjs`));

/**
 * One run of `root`'s scripts/live-checks/<key>.mjs with `args`: its stdout and stderr through one pipe (`sh -c 'exec
 * node … 2>&1'`, the arguments passed as the shell's positional ones, never parsed), each chunk to `write` as it comes.
 * Resolves { code, output }.
 */
export function runCheck(key, args = [], root = process.cwd(), write = (b) => process.stdout.write(b)) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn("/bin/sh", ["-c", 'exec "$0" "$@" 2>&1', process.execPath, path.join("scripts/live-checks", `${key}.mjs`), ...args], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (b) => (write(b), chunks.push(b)));
    child.on("error", (e) => resolve({ code: 2, output: `${Buffer.concat(chunks)}${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 2, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { log, rest } = logArg(process.argv.slice(2));
  const [key, ...args] = rest;
  const root = process.cwd();
  const out = sink(log);
  if (!key || !isCheck(key, root)) {
    const line = `live-rerun: ERROR: ${key ? `no such check: ${key} in ${root}/scripts/live-checks` : "no check named"}`;
    out.say(line);
    writeVerdicts(log, [{ key: key ?? "", verdict: "error", reason: line, runs: 0 }]);
    out.close();
    process.exit(2);
  }
  const r = await rerun(key, args, { run: (k, a) => runCheck(k, a, root, out.write), say: out.say });
  writeVerdicts(log, [{ key, verdict: r.verdict, reason: r.reason, runs: r.runs }]);
  if (r.verdict === "inconclusive") out.say(noticeLine(key, r.reason));
  out.say(`live-rerun ${key}: ${r.verdict.toUpperCase()}${r.reason ? `: ${r.reason}` : ""}`);
  out.close();
  process.exitCode = r.exit;
}
