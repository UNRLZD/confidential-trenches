// Card readme-fresh-run: the README's "For AI agents and scripts" steps, run the way a reviewer's machine runs them.
//   node scripts/ci/readme-fresh-run.mjs [--readme README.md] [--checkout .] [--workdir DIR] [--max-minutes 15]
//
// The commands come from README.md itself (readme-commands.mjs --agent-steps), never from a copy here, so a README edit
// that breaks them breaks this run. The one substitution: `git clone <url>` clones --checkout (the commit under test)
// into the folder the URL would give, because the URL names main. Then, in a new folder:
// - the machine has no key (an env name with KEY, JWT, SECRET, TOKEN or PASSWORD is dropped) and no Rust (a PATH
//   folder holding cargo, rustc or rustup is dropped); Chrome is hidden by the workflow, which has the rights to;
// - `git clone` and `pnpm install` may use the network, every other step may not (no-network.mjs refuses a connection
//   to any host but this machine): the default tests must pass on a machine with no route out;
// - the run must exit 0, every workspace package with a test script must print at least one summary, every summary
//   must read `fail 0`, and the whole run must end within --max-minutes (15 by default). Its wall time is printed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentSteps, workspacePackages } from "./readme-commands.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NEEDS_NETWORK = /^(git clone|pnpm install)\b/;
const SECRET_NAME = /KEY|JWT|SECRET|TOKEN|PASSWORD/i;

/** The environment of a machine with no key and no Rust. */
export function cleanEnv(env, has = (f) => existsSync(f)) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_NAME.test(k) && v !== undefined) out[k] = v;
  const keep = (out.PATH ?? "").split(path.delimiter).filter((d) => d && !["cargo", "rustc", "rustup"].some((b) => has(path.join(d, b))));
  out.PATH = keep.join(path.delimiter);
  return out;
}

/** The step to run: `git clone <url> [dir]` becomes a clone of the checkout into the folder the URL gives. */
export function substitute(step, checkout) {
  const m = /^git clone\s+(?:-\S+\s+)*(\S+)(?:\s+(\S+))?\s*$/.exec(step);
  if (!m) return step;
  const dir = m[2] ?? path.basename(m[1]).replace(/\.git$/, "");
  return `git clone -q ${JSON.stringify(checkout)} ${JSON.stringify(dir)}`;
}

/** Each `ℹ fail N` line of the output: { pkg, fail }, pkg being pnpm's `<folder> test` prefix, or null without one. */
export function summaries(output) {
  const out = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^(?:(\S+)\s+test[:$]\s+)?.*ℹ fail (\d+)\s*$/.exec(line);
    if (m) out.push({ pkg: m[1] ?? null, fail: Number(m[2]) });
  }
  return out;
}

/** One line per problem; an empty list is a pass. `expected` are the package folders that have a test script. */
export function problems({ failedStep, output, expected, seconds, maxSeconds }) {
  const out = [];
  if (failedStep) return [`step failed: ${failedStep}`, ...(seconds > maxSeconds ? [`wall time ${fmt(seconds)} is over the ${fmt(maxSeconds)} limit`] : [])];
  const found = summaries(output);
  if (!found.length) out.push("no test summary (`ℹ fail N`) in the output");
  for (const s of found) if (s.fail !== 0) out.push(`${s.pkg ?? "a test run"}: ${s.fail} failing`);
  for (const dir of expected) {
    if (!found.some((s) => s.pkg === dir)) out.push(`${dir}: no test summary in the output`);
  }
  if (seconds > maxSeconds) out.push(`wall time ${fmt(seconds)} is over the ${fmt(maxSeconds)} limit`);
  return out;
}

const fmt = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;

// Runs one step in bash; past `seconds` the step's whole process group is killed and the code is null.
function run(command, cwd, env, seconds) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `${command}\n__rc=$?\npwd > "$FRESH_RUN_CWD"\nexit $__rc`], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), Math.max(seconds, 1) * 1000);
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (b) => {
        output += b;
        process.stdout.write(b);
      });
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export async function main(argv) {
  const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const readme = path.resolve(arg("--readme", "README.md"));
  const checkout = path.resolve(arg("--checkout", "."));
  const maxSeconds = Number(arg("--max-minutes", "15")) * 60;
  const work = arg("--workdir", null) ? path.resolve(arg("--workdir")) : mkdtempSync(path.join(tmpdir(), "readme-fresh-run-"));
  mkdirSync(work, { recursive: true });
  const steps = agentSteps(readFileSync(readme, "utf8"));
  console.log(`readme-fresh-run: ${steps.length} step(s) from ${path.relative(process.cwd(), readme) || readme}, in ${work}`);
  const base = cleanEnv({ ...process.env, CI: "true", NO_COLOR: "1" });
  const dropped = Object.keys(process.env).filter((k) => !(k in base));
  const droppedDirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d && !base.PATH.split(path.delimiter).includes(d));
  console.log(`readme-fresh-run: a machine with no key and no Rust: ${dropped.length} environment name(s) dropped, PATH without ${droppedDirs.join(" ") || "a Rust folder (none on this machine)"}`);
  const guard = `--import=${pathToFileURL(path.join(HERE, "no-network.mjs")).href}`;
  const cwdFile = path.join(work, ".fresh-run-cwd");
  let cwd = work;
  let output = "";
  let failedStep = null;
  const t0 = performance.now();
  for (const step of steps) {
    const online = NEEDS_NETWORK.test(step);
    const env = { ...base, FRESH_RUN_CWD: cwdFile };
    if (!online) env.NODE_OPTIONS = [base.NODE_OPTIONS, guard, "--no-warnings"].filter(Boolean).join(" ");
    if (!online) env.npm_config_update_notifier = "false";
    const run1 = substitute(step, checkout);
    console.log(`\n$ ${step}${run1 === step ? "" : `    (run as: ${run1})`}${online ? "" : "    [no network]"}`);
    const { code, output: o } = await run(run1, cwd, env, maxSeconds - (performance.now() - t0) / 1000);
    output += o;
    if (code !== 0) {
      failedStep = `${step} (${code === null ? "killed at the time limit" : `exit ${code}`})`;
      break;
    }
    if (existsSync(cwdFile)) cwd = readFileSync(cwdFile, "utf8").trim() || cwd;
  }
  const seconds = (performance.now() - t0) / 1000;
  const expected = failedStep ? [] : workspacePackages(cwd).filter((w) => w.pkg.scripts?.test).map((w) => w.dir);
  const bad = problems({ failedStep, output, expected, seconds, maxSeconds });
  console.log(`\nreadme-fresh-run: wall time ${fmt(seconds)} (limit ${fmt(maxSeconds)})`);
  console.log(`readme-fresh-run: ${summaries(output).length} test summaries from ${expected.length} packages with a test script`);
  for (const p of bad) console.log(`readme-fresh-run: FAIL ${p}`);
  if (!bad.length) console.log("readme-fresh-run: PASS");
  if (!arg("--workdir", null)) rmSync(work, { recursive: true, force: true });
  return bad.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
