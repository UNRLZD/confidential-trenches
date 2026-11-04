#!/usr/bin/env node
// Builds the terminal at HEAD and deploys it to APP_HOST's Cloudflare Pages project, only after the deploy gate passes it.
//   node apps/terminal/scripts/deploy.mjs [--dry-run]     exit 0 ok, 1 refused or failed, 2 usage
// The deploy makes its own build, the terminal's `vite build` into a fresh temp folder (as SIGN_HOST's deploy does), and
// takes no build folder: the upload is named by HEAD's commit, so it is HEAD's build and nothing else, built from
// HEAD's lockfile (`pnpm install --frozen-lockfile` first). An uncommitted change anywhere in the tree (the build
// bundles the kit and the wallet too), no HEAD, a failed install, a failed build or a gate refusal stops here, before
// a token is read or a byte is uploaded. The gate (check-deploy.ts) runs on the build's own
// _headers. --dry-run stops after the gate and keeps the build folder, so it can be served; it builds a work in
// progress too, and says a deploy would refuse it. A testnet build is VITE_NEAR_NETWORK=testnet in the environment
// (build/network.mjs). The upload is wrangler's `pages deploy`, at an exact version, run from an empty directory so no
// functions/ folder can ride along (Pages applies no _headers rule to a Function's response). It needs
// CLOUDFLARE_API_TOKEN (a Pages-only token) and CLOUDFLARE_ACCOUNT_ID in the environment; neither is printed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TESTNET_RPCS } from "../build/network.mjs";
import { checkDir } from "./check-deploy.ts";

export const PROJECT = "confidential-trenches-app";
export const BRANCH = "main"; // the project's production branch: a deploy on it serves APP_HOST
export const WRANGLER = "wrangler@4.151.1"; // published 2026-10-16
const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

// every live check that reads APP_HOST, run after each deploy (a test holds this list to scripts/live-checks/app-*.mjs
// and signpage-release, which reads APP_HOST alone against this commit's own build, so a SIGN_HOST that lags does not
// fail this deploy). A check in no host's list says why in its own header (a "Runs:" line, scripts/ci/live-listed.mjs).
export const LIVE_CHECKS = ["app-host-gate", "app-release-sri", "app-shell", "app-in-shell", "app-discover-live", "app-no-test-token", "app-launchpad-badges", "app-token-route", "app-trade-box-mount", "app-token-chart", "app-harness-signin-e2e", "app-verify-mount", "app-no-blank-pages", "app-portfolio-mount", "signpage-release", "trade-box-pool", "app-console-429", "trade-box-bal-cash", "app-list-age", "app-pool-withdraw", "signpage-pool-price", "app-buy-route-strip", "signpage-buy-route-events", "app-hop-sync-lock", "balances-per-chain", "app-export-every-wallet"];
export const LIVE_ARGS = { "app-in-shell": "--engines chromium,firefox,webkit", "app-harness-signin-e2e": "--host app", "signpage-release": "--host app", "signpage-pool-price": "--host app", "signpage-buy-route-events": "--host app" };
// app-verify-mount reads the network the build names: a testnet build's _headers carries the testnet pair (build/network.mjs)
export const networkOfBuild = (dir) => (readFileSync(join(dir, "_headers"), "utf8").includes(TESTNET_RPCS) ? "testnet" : "mainnet");
export const liveRun = (k, network = "mainnet") => `scripts/live-checks/${k}.mjs${LIVE_ARGS[k] ? ` ${LIVE_ARGS[k]}` : ""}${k === "app-verify-mount" ? ` --network ${network}` : ""}`;
/** The runs of one check, each as `liveRun` writes it: live.yml runs each as its own job. */
export const liveRuns = (k, { network = "mainnet" } = {}) => [liveRun(k, network)];
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

export function deploy(argv, env = process.env, run = spawnSync, make = () => build(env)) {
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
    keep = dryRun;
    if (dryRun) return { code: 0, out: [`gate ok on ${dir}; --dry-run: nothing was uploaded${dirty ? "; the tree has uncommitted changes: a deploy would refuse it" : ""}`] };
    const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !env[k]);
    if (missing.length) return { code: 2, err: [`gate ok; ${missing.join(" and ")} not set, nothing was uploaded`] };
    const args = ["dlx", WRANGLER, "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH, "--commit-hash", sha, "--commit-dirty=false"];
    const r = run("pnpm", args, {
      cwd: mkdtempSync(join(tmpdir(), "ct-deploy-")),
      env: { ...env, WRANGLER_SEND_METRICS: "false" },
      stdio: "inherit",
    });
    if (r.status !== 0) return { code: 1, err: [`wrangler pages deploy failed (exit ${r.status ?? r.signal})`] };
    return { code: 0, out: [`deployed HEAD ${sha} to ${PROJECT} on ${BRANCH}`, ...liveCommands(sha, networkOfBuild(dir))] };
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
  const r = deploy(process.argv.slice(2));
  for (const l of r.out ?? []) console.log(`deploy: ${l}`);
  for (const l of r.err ?? []) console.error(`deploy: ${l}`);
  process.exit(r.code);
}
