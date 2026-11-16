#!/usr/bin/env node
// Builds the terminal at HEAD and deploys it to APP_HOST's Cloudflare Pages project, only after the deploy gate passes it.
//   node apps/terminal/scripts/deploy.mjs [--dry-run]     exit 0 ok, 1 refused or failed, 2 usage
// The deploy makes its own build, the terminal's `vite build` into a fresh temp folder (as SIGN_HOST's deploy does), and
// takes no build folder: the upload is named by HEAD's commit, so it is HEAD's build and nothing else, built from
// HEAD's lockfile (`pnpm install --frozen-lockfile` first). An uncommitted change anywhere in the tree (the build
// bundles the kit and the wallet too), no HEAD, a failed install, a failed build or a gate refusal stops here, before
// a token is read or a byte is uploaded. The gate (check-deploy.ts) runs on the build's own
// _headers. Then the newest committed release list (packages/signpage/releases, newest by N, read from this checkout,
// which a deploy holds clean) must name the build: every file APP_HOST would serve, by path, sha256, sha384 and headers,
// and the _headers file, held to the list's APP_HOST part by release-list.mjs unreleasedProblems, the sign deploy's own
// comparer, run as its command (`--unreleased <dir> --host app`: a file outside packages/ imports nothing of it,
// .dependency-cruiser.cjs; card app-deploy-refuses-an-unlisted-build). No list, a list it cannot read, a list edited after it was
// written or one with no APP_HOST part refuses too, each REFUSED line naming the list, the first one the first file that
// differs, before a token is read or a byte is uploaded: a change merged after a release was cut that moves the app's
// bundle lands on APP_HOST only with the next release. --dry-run stops after these and keeps the build folder, so it can
// be served; it builds a work in progress too, and says a deploy would refuse it, with the lines. A testnet build is
// VITE_NEAR_NETWORK=testnet in the environment (build/network.mjs); a list is cut from the mainnet build, so a deploy
// refuses a testnet build. The upload is wrangler's `pages deploy`, at an exact version, run from an empty directory so no
// functions/ folder can ride along (Pages applies no _headers rule to a Function's response). It needs
// CLOUDFLARE_API_TOKEN (a Pages-only token) and CLOUDFLARE_ACCOUNT_ID in the environment; neither is printed. A wrangler
// exit 0 is not done: APP_HOST must then serve this build's / and main bundle (scripts/pages-readback.mjs, card
// pages-deploy-readback), or it exits 1 naming both hashes and prints no next:.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGINS } from "../../../scripts/live-checks/signpage-release.mjs";
import { readBack } from "../../../scripts/pages-readback.mjs";
import { TESTNET_RPCS } from "../build/network.mjs";
import { checkDir } from "./check-deploy.ts";
import { hostList } from "../../../scripts/ci/live-after.mjs";

export const PROJECT = "confidential-trenches-app";
export const BRANCH = "main"; // the project's production branch: a deploy on it serves APP_HOST
export const WRANGLER = "wrangler@4.151.1"; // published 2026-10-16
const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

// every live check that reads APP_HOST, run after each deploy: each check's `// After: app` lines (scripts/ci/live-after.mjs),
// one run for each (a test holds the list to scripts/live-checks/app-*.mjs, and signpage-release reads APP_HOST alone
// against this commit's own build, so a SIGN_HOST that lags does not fail this deploy). A check in no host's list says
// why in its own header (a "Runs:" line, scripts/ci/live-listed.mjs).
const AFTER = hostList("app", REPO);
export const LIVE_CHECKS = AFTER.checks;
export const LIVE_ARGS = AFTER.args;
// app-verify-mount reads the network the build names: a testnet build's _headers carries the testnet pair (build/network.mjs)
export const networkOfBuild = (dir) => (readFileSync(join(dir, "_headers"), "utf8").includes(TESTNET_RPCS) ? "testnet" : "mainnet");
// (app-verify-mount's line takes --network {network})
/** The runs of one check, `{network}` in its arguments the build's: live.yml runs each as its own job. */
export const liveRuns = (k, { network = "mainnet" } = {}) => (LIVE_ARGS[k] ?? []).map((a) => `scripts/live-checks/${k}.mjs${a ? ` ${a.replaceAll("{network}", network)}` : ""}`);
/** The commands a deploy prints for the live run on GitHub's runners (card ci-live-runners); a testnet build says so. */
export const liveCommands = (sha, network = "mainnet") => [`next: gh workflow run live.yml -f host=app -f commit=${sha}${network === "mainnet" ? "" : ` -f network=${network}`}`, "then: gh run watch --exit-status"];

/** The list live.yml reads (scripts/ci/live-plan.mjs runs `node <this file> --live-runs [--network n] [--commit sha]`). */
export const liveList = (opts = {}) => ({ checks: LIVE_CHECKS, skipped: {}, runs: Object.fromEntries(LIVE_CHECKS.map((k) => [k, liveRuns(k, opts)])) });

// the last lines a failed step wrote, on one line
const tail = (r) => `${r.stderr ?? ""}`.trim().split("\n").slice(-5).join(" | ");

/** The terminal's own `vite build` of the checkout at `repo` into a fresh temp folder: { dir, problems } (empty = built).
 *  It installs nothing: the deploy installs first, and the release list (release-list.mjs) builds what is installed. */
export function build(env = process.env, run = spawnSync, repo = REPO) {
  const dir = mkdtempSync(join(tmpdir(), "ct-app-"));
  const term = join(repo, "apps", "terminal");
  const r = run(process.execPath, [join(term, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dir, "--emptyOutDir", "--logLevel", "warn"], { cwd: term, env, encoding: "utf8" });
  if (r.status === 0) return { dir, problems: [] };
  return { dir, problems: [`the build failed (vite exit ${r.status ?? r.signal})${tail(r) ? `: ${tail(r)}` : ""}`] };
}

export const RELEASE_LIST = join(REPO, "packages", "signpage", "scripts", "release-list.mjs");

/** Why the newest committed release list does not name the build folder `dir` as APP_HOST's (empty = it names it):
 *  release-list.mjs --unreleased, its lines; `released` ({ dir, ledger }: a releases folder and a ledger JSON file) a
 *  test's stand-ins. A run that answers neither yes nor no is a refusal too. */
export function unlisted(dir, released = {}) {
  const extra = released.dir ? ["--releases", released.dir, "--ledger", released.ledger] : [];
  const r = spawnSync(process.execPath, [RELEASE_LIST, "--unreleased", dir, "--host", "app", ...extra], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return [];
  const lines = `${r.stderr ?? ""}`.split("\n").filter(Boolean).map((l) => l.replace(/^release-list: /, ""));
  if (r.status === 1 && lines.length) return lines;
  return [`release-list.mjs --unreleased did not answer (exit ${r.status ?? r.signal ?? r.error?.code})${lines.length ? `: ${lines.slice(-5).join(" | ")}` : ""}`];
}

/** The deploy: { code, out, err }. `net` is the read-back's fetch and sleep (scripts/pages-readback.mjs), and `released`
 *  the release lists and their ledger file ({ dir, ledger }; the committed ones by default), a test's stand-ins. */
export async function deploy(argv, env = process.env, run = spawnSync, make = () => build(env), net = {}, released = {}) {
  const dryRun = argv.includes("--dry-run");
  const rest = argv.filter((a) => a !== "--dry-run");
  if (rest.length) return { code: 2, err: ["usage: node apps/terminal/scripts/deploy.mjs [--dry-run] (it takes no build folder: it builds HEAD itself)"] };
  // the tree the build reads, before it reads it: a deploy is HEAD's commit and nothing else (--dry-run builds a work in
  // progress too, and says a deploy would refuse it)
  const sha = run("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  const dirty = run("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).stdout?.trimEnd();
  if (!dryRun && !sha) return { code: 1, err: ["REFUSED no HEAD commit to name the upload by", "nothing was uploaded"] };
  if (!dryRun && dirty) return { code: 1, err: [`REFUSED the tree has uncommitted changes, and the upload would carry HEAD's name (${sha}):`, ...dirty.split("\n").slice(0, 20), "commit them first; nothing was uploaded"] };
  // HEAD's lockfile, exactly: node_modules installed for another commit can build cleanly with the wrong versions
  const inst = run("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO, env, encoding: "utf8" });
  if (inst.status !== 0) return { code: 1, err: [`REFUSED the install failed (pnpm exit ${inst.status ?? inst.signal})${tail(inst) ? `: ${tail(inst)}` : ""}`, "nothing was uploaded"] };
  const made = make();
  const dir = made.dir;
  let keep = false; // a passing --dry-run keeps its build to serve; every other run removes it
  try {
    const problems = made.problems.length ? made.problems : checkDir(dir);
    if (problems.length) return { code: 1, err: [...problems.map((p) => `REFUSED ${p}`), "nothing was uploaded"] };
    // the newest committed list must name this build, file for file and header for header
    const notListed = unlisted(dir, released).map((p) => `REFUSED ${p}`);
    keep = dryRun;
    if (dryRun) {
      return { code: 0, out: [`gate ok on ${dir}; --dry-run: nothing was uploaded${dirty ? "; the tree has uncommitted changes: a deploy would refuse it" : ""}${notListed.length ? `; a deploy would refuse it: ${notListed.join("; ")}` : ""}`] };
    }
    if (notListed.length) return { code: 1, err: [...notListed, "nothing was uploaded"] };
    const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !env[k]);
    if (missing.length) return { code: 2, err: [`gate ok; ${missing.join(" and ")} not set, nothing was uploaded`] };
    const args = ["dlx", WRANGLER, "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH, "--commit-hash", sha, "--commit-dirty=false"];
    const r = run("pnpm", args, {
      cwd: mkdtempSync(join(tmpdir(), "ct-deploy-")),
      env: { ...env, WRANGLER_SEND_METRICS: "false" },
      stdio: "inherit",
    });
    if (r.status !== 0) return { code: 1, err: [`wrangler pages deploy failed (exit ${r.status ?? r.signal})`] };
    // wrangler's exit 0 is its word, not the address's (6 Nov 09:21Z: "couldn't ascertain the final status", a Failure)
    const back = await readBack(ORIGINS.APP_HOST, dir, net);
    if (!back.ok) return { code: 1, err: [`uploaded HEAD ${sha} to ${PROJECT} on ${BRANCH}, but`, ...back.lines] };
    return { code: 0, out: [`deployed HEAD ${sha} to ${PROJECT} on ${BRANCH}`, ...back.lines, ...liveCommands(sha, networkOfBuild(dir))] };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--live-runs") {
    const a = process.argv.slice(3);
    console.log(JSON.stringify(liveList({ network: a.includes("--network") ? a[a.indexOf("--network") + 1] : "mainnet" })));
    process.exit(0);
  }
  const r = await deploy(process.argv.slice(2));
  for (const l of r.out ?? []) console.log(`deploy: ${l}`);
  for (const l of r.err ?? []) console.error(`deploy: ${l}`);
  process.exit(r.code);
}
