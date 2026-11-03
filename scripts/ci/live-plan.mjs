// The plan of one live run (card ci-live-runners): which checks .github/workflows/live.yml runs for a host, read from the
// lists the deploys print, never copied:
//   app     apps/terminal/scripts/deploy.mjs      LIVE_CHECKS and liveRuns (the network a testnet build names)
//   sign    packages/signpage/scripts/deploy.mjs  LIVE_CHECKS and liveRuns
//   helper  scripts/ci/helper-live-checks.mjs     LIVE_CHECKS, liveRuns and SKIPPED (the helper deploys from its server)
// One matrix entry for each run of each check, so each is its own parallel job. A check the runner cannot run (SKIPPED:
// it needs a secret or an account the release has not named) is listed with its reason, run nowhere and never counted a
// pass. An entry says whether its job needs Chrome (the check reaches scripts/browsers.mjs through its imports) and
// which of Playwright's Firefox and WebKit to install (the engines its arguments name, so a deploy's list says them).
//   node scripts/ci/live-plan.mjs <app|sign|helper> <40-hex commit> [--network mainnet|testnet] [--verify]
// Prints the plan as JSON; under GitHub Actions it also sets the step outputs matrix, count and skipped and writes the
// run's summary. --verify reads what the host reports of its commit and fails when it is not the commit asked for.
import "../net-window.mjs";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HOSTS = {
  app: "apps/terminal/scripts/deploy.mjs",
  sign: "packages/signpage/scripts/deploy.mjs",
  helper: "scripts/ci/helper-live-checks.mjs",
};
export const LAUNCHER = "scripts/browsers.mjs";
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[a-z][a-z0-9-]*$/;
const PLAYWRIGHT_ONLY = ["firefox", "webkit"];

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** Whether `file` (a path under root) reaches scripts/browsers.mjs through its relative imports. */
export function reachesLauncher(root, file, seen = new Set()) {
  const abs = path.resolve(root, file);
  if (seen.has(abs) || !existsSync(abs)) return false;
  seen.add(abs);
  if (path.relative(root, abs) === LAUNCHER) return true;
  if (!/\.(mjs|js|ts)$/.test(abs)) return false;
  for (const m of readFileSync(abs, "utf8").matchAll(IMPORT)) if (reachesLauncher(root, path.join(path.dirname(abs), m[1]), seen)) return true;
  return false;
}

/** The Playwright browsers a run installs: the Firefox and WebKit its arguments name (--engine, --engines, --browser). */
export function enginesFor(args) {
  const named = [...args.matchAll(/--(?:engine|engines|browser)[ =]([a-z,]+)/g)].flatMap((m) => m[1].split(","));
  return PLAYWRIGHT_ONLY.filter((e) => named.includes(e));
}

/**
 * The plan for `host` at `commit`: { host, commit, include: [{ id, key, args, name, chrome, engines }], skipped: [{ key,
 * reason, detail }] }. Throws on a check that has no file, or a name or run that is not what a job can take.
 */
export async function planFor(host, { commit, network = "mainnet", root = ROOT } = {}) {
  if (!HOSTS[host]) throw new Error(`host must be one of ${Object.keys(HOSTS).join(", ")}, not ${host}`);
  if (!SHA.test(commit ?? "")) throw new Error(`commit must be a full 40-hex sha, not ${commit}`);
  if (!["mainnet", "testnet"].includes(network)) throw new Error(`network must be mainnet or testnet, not ${network}`);
  const mod = await import(pathToFileURL(path.join(root, HOSTS[host])).href);
  if (!Array.isArray(mod.LIVE_CHECKS) || !mod.LIVE_CHECKS.length) throw new Error(`${HOSTS[host]} lists no live check`);
  const include = [];
  const skipped = [];
  for (const key of mod.LIVE_CHECKS) {
    if (!KEY.test(key) || !existsSync(path.join(root, "scripts/live-checks", `${key}.mjs`))) throw new Error(`${HOSTS[host]} lists ${key}, which is no file in scripts/live-checks`);
    if (mod.SKIPPED?.[key]) {
      skipped.push({ key, ...mod.SKIPPED[key] });
      continue;
    }
    const runs = mod.liveRuns(key, { network, commit });
    if (!runs.length) throw new Error(`${HOSTS[host]} gives ${key} no run`);
    runs.forEach((run, i) => {
      const prefix = `scripts/live-checks/${key}.mjs`;
      if (run !== prefix && !run.startsWith(`${prefix} `)) throw new Error(`${HOSTS[host]}'s run for ${key} does not start with ${prefix}: ${run}`);
      const args = run.slice(prefix.length).trim();
      if (/[^A-Za-z0-9 ._:=,/-]/.test(args)) throw new Error(`${key}'s arguments hold a character a job does not take: ${args}`);
      include.push({
        id: runs.length === 1 ? key : `${key}-${i + 1}`,
        key,
        args,
        name: args && runs.length > 1 ? `${key} ${args.replace(/--/g, "")}` : key,
        chrome: reachesLauncher(root, path.join("scripts/live-checks", `${key}.mjs`)),
        engines: enginesFor(args).join(" "),
      });
    });
  }
  return { host, commit, network, include, skipped };
}

/** What `host` reports of its commit: the helper's X-Helper-Commit; the two Pages hosts report none (null). */
export async function hostCommit(host, fetchFn = fetch) {
  if (host !== "helper") return null;
  const { BASE, APP } = await import("../live-checks/helper-host-health.mjs");
  const r = await fetchFn(`${BASE}/v1/health`, { headers: { Origin: APP } });
  return r.headers.get("x-helper-commit");
}

/** The problem with a host's reported commit against the one asked for, or null. */
export function commitProblem(host, asked, reported) {
  if (host !== "helper") return null;
  return reported === asked ? null : `the helper reports commit ${reported ?? "none"}, not ${asked}: it is not (yet) the deploy being checked`;
}

const summaryOf = (plan, note) => [
  `### live.yml: ${plan.host} at ${plan.commit.slice(0, 12)}${plan.host === "app" ? ` (${plan.network})` : ""}`,
  "",
  `${plan.include.length} jobs: ${plan.include.map((e) => e.name).join(", ")}`,
  ...(note ? ["", note] : []),
  ...(plan.skipped.length ? ["", "Not run:", ...plan.skipped.map((s) => `- skipped-${s.reason}: ${s.key} (${s.detail})`)] : []),
  "",
].join("\n");

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const [host, commit] = a;
    const plan = await planFor(host, { commit, network: opt("--network") ?? "mainnet" });
    let note = host === "helper" ? "" : `${host === "app" ? "APP_HOST" : "SIGN_HOST"} reports no commit; signpage-release holds its files to this commit's own build.`;
    if (a.includes("--verify")) {
      const reported = await hostCommit(host);
      const problem = commitProblem(host, commit, reported);
      if (problem) throw new Error(problem);
      if (reported) note = `The helper reports commit ${reported}, the one asked for.`;
    }
    console.log(JSON.stringify(plan, null, 1));
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: plan.include })}\ncount=${plan.include.length}\nskipped=${JSON.stringify(plan.skipped)}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryOf(plan, note));
  } catch (e) {
    console.error(`live-plan: ${e.message}`);
    process.exit(1);
  }
}
