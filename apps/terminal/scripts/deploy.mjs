#!/usr/bin/env node
// Deploys a terminal build to APP_HOST's Cloudflare Pages project, only after the deploy gate passes it.
//   node apps/terminal/scripts/deploy.mjs <buildDir> [--dry-run]     exit 0 ok, 1 refused or failed, 2 usage
// The gate (check-deploy.ts) runs on the build's own _headers first; any refusal stops here, before a token is read
// or a byte is uploaded. --dry-run stops after the gate. The upload is wrangler's `pages deploy`, at an exact version,
// run from an empty directory so no functions/ folder can ride along (Pages applies no _headers rule to a Function's
// response). It needs CLOUDFLARE_API_TOKEN (a Pages-only token) and CLOUDFLARE_ACCOUNT_ID in the environment; neither
// is printed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TESTNET_RPCS } from "../build/network.mjs";
import { checkDir } from "./check-deploy.ts";

export const PROJECT = "confidential-trenches-app";
export const BRANCH = "main"; // the project's production branch: a deploy on it serves APP_HOST
export const WRANGLER = "wrangler@4.151.1"; // published 2026-10-16

// every live check that reads APP_HOST, run after each deploy (a test holds this list to scripts/live-checks/app-*.mjs
// and signpage-release, which reads APP_HOST alone against this commit's own build, so a SIGN_HOST that lags does not
// fail this deploy)
export const LIVE_CHECKS = ["app-host-gate", "app-release-sri", "app-shell", "app-in-shell", "app-discover-live", "app-no-test-token", "app-launchpad-badges", "app-harness-signin-e2e", "app-verify-mount", "signpage-release"];
export const LIVE_ARGS = { "app-harness-signin-e2e": "--host app", "signpage-release": "--host app" };
// app-verify-mount reads the network the build names: a testnet build's _headers carries the testnet pair (build/network.mjs)
export const networkOfBuild = (dir) => (readFileSync(join(dir, "_headers"), "utf8").includes(TESTNET_RPCS) ? "testnet" : "mainnet");
export const liveRun = (k, network = "mainnet") => `scripts/live-checks/${k}.mjs${LIVE_ARGS[k] ? ` ${LIVE_ARGS[k]}` : ""}${k === "app-verify-mount" ? ` --network ${network}` : ""}`;

export function deploy(argv, env = process.env, run = spawnSync) {
  const dryRun = argv.includes("--dry-run");
  const rest = argv.filter((a) => a !== "--dry-run");
  if (rest.length !== 1) return { code: 2, err: ["usage: node apps/terminal/scripts/deploy.mjs <buildDir> [--dry-run]"] };
  const dir = resolve(rest[0]);
  const problems = checkDir(dir);
  if (problems.length) return { code: 1, err: [...problems.map((p) => `REFUSED ${p}`), "nothing was uploaded"] };
  if (dryRun) return { code: 0, out: [`gate ok on ${dir}; --dry-run: nothing was uploaded`] };
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !env[k]);
  if (missing.length) return { code: 2, err: [`gate ok; ${missing.join(" and ")} not set, nothing was uploaded`] };
  const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const sha = run("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  const dirty = run("git", ["-C", repo, "status", "--porcelain", "--", "apps/terminal"], { encoding: "utf8" }).stdout?.trim();
  const args = ["dlx", WRANGLER, "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH];
  if (sha) args.push("--commit-hash", sha, `--commit-dirty=${dirty ? "true" : "false"}`);
  const r = run("pnpm", args, {
    cwd: mkdtempSync(join(tmpdir(), "ct-deploy-")),
    env: { ...env, WRANGLER_SEND_METRICS: "false" },
    stdio: "inherit",
  });
  if (r.status !== 0) return { code: 1, err: [`wrangler pages deploy failed (exit ${r.status ?? r.signal})`] };
  return { code: 0, out: [`deployed ${dir} to ${PROJECT} on ${BRANCH}; run ${LIVE_CHECKS.map((k) => liveRun(k, networkOfBuild(dir))).join(", ")} next`] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = deploy(process.argv.slice(2));
  for (const l of r.out ?? []) console.log(`deploy: ${l}`);
  for (const l of r.err ?? []) console.error(`deploy: ${l}`);
  process.exit(r.code);
}
