#!/usr/bin/env node
// Builds the signing page and deploys it to SIGN_HOST's Cloudflare Pages project, only after the gate passes it.
//   node packages/signpage/scripts/deploy.mjs [--dry-run]     exit 0 ok, 1 refused or failed, 2 usage
// The build is index.html and public/ copied into a fresh temp folder, so nothing else in the package is served, plus
// the prover's setup files at assets/zk/<sha256>.<ext> and their licences (scripts/build-app.mjs copyServed, card
// signpage-prover-host). The gate then reads the build's own _headers and runs the card's live check
// (scripts/live-checks/signpage-skeleton.mjs) on the headers it sets for every path, checks the worker's own policy
// rule (W:880) and the thread file's (card signpage-prover-threads), and reads every setup file back against its pin
// and the worker and the thread file against a fresh build of the kit's;
// any refusal stops here, before a token is read or a byte is uploaded. So does an uncommitted change anywhere in the
// tree (the build carries the kit's prover too), no HEAD, or a failed `pnpm install --frozen-lockfile` (run first, so
// the build reads HEAD's lockfile): the upload is named by HEAD's commit, so it is HEAD's build.
// --dry-run stops after the gate and keeps the build folder, so `wrangler pages dev` can serve it; it builds a work in
// progress too, and says a deploy would refuse it. The upload is
// wrangler's `pages deploy`, at an exact version, run from an empty folder so no functions/ folder can ride along
// (Pages applies no _headers rule to a Function's response). It needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
// in the environment; neither is printed.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADERS, judge } from "../../../scripts/live-checks/signpage-skeleton.mjs";
import { WORKER_CSP, WORKER_PATH, ZK_CACHE } from "../../../scripts/live-checks/signpage-prover-host.mjs";
import { THREAD_CSP, THREAD_PATH } from "../../../scripts/live-checks/signpage-prover-threads.mjs";
import { proverThreadSource, proverWorkerSource } from "../../kit/src/prover/build.mjs";
import { SERVED, copyServed, pinProblems } from "./build-app.mjs";

/** Every live check that reads SIGN_HOST, run after each deploy (a failing one undoes it). */
export const LIVE_CHECKS = ["signpage-skeleton", "wallet-passkey-prf", "signpage-postmessage", "signpage-shell", "signpage-signin-kinds", "signpage-prover-host", "signpage-prover-threads", "signpage-release", "signpage-withdraw-form", "signpage-solana-trade", "signpage-pool-kinds", "signpage-pool-flow", "signpage-pool-notes", "signpage-pool-withdraw-form", "app-harness-signin-e2e", "signpage-pool-price", "signpage-buy-route-events", "signpage-withdraw-own-spend"];
// the arguments a check is run with after this deploy (a list: one run for each, each its own job in live.yml):
// signpage-release reads SIGN_HOST alone against this commit's own build, and app-harness-signin-e2e SIGN_HOST's
// backdrop alone, so an APP_HOST that lags does not fail this deploy; signpage-shell takes an engine and runs live on
// Chromium and Firefox at both widths (its WebKit run is the Mac's own harness, which a runner has not); the engines a
// run needs are named, so live.yml installs Playwright's Firefox and WebKit only where an argument says so
export const LIVE_ARGS = {
  "signpage-prover-threads": "--browser webkit",
  "signpage-release": "--host sign",
  "app-harness-signin-e2e": "--host sign",
  "signpage-buy-route-events": "--host sign",
  "signpage-shell": ["chromium", "firefox"].flatMap((e) => ["phone", "desktop"].map((w) => `--engine ${e} --live --width ${w}`)),
};
/** The runs of one check, each as `scripts/live-checks/<key>.mjs <args>`. */
export const liveRuns = (k) => [LIVE_ARGS[k] ?? ""].flat().map((a) => `scripts/live-checks/${k}.mjs${a ? ` ${a}` : ""}`);
/** The command a deploy prints for the live run on GitHub's runners (card ci-live-runners). */
export const liveCommands = (sha) => [`next: gh workflow run live.yml -f host=sign -f commit=${sha}`, "then: gh run watch --exit-status"];
/** The list live.yml reads (scripts/ci/live-plan.mjs runs `node <this file> --live-runs`). */
export const liveList = () => ({ checks: LIVE_CHECKS, skipped: {}, runs: Object.fromEntries(LIVE_CHECKS.map((k) => [k, liveRuns(k)])) });
export const PROJECT = "confidential-trenches-sign";
export const BRANCH = "main"; // the project's production branch: a deploy on it serves SIGN_HOST
export const WRANGLER = "wrangler@4.151.1"; // published 2026-10-16
const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(PKG));

// The whole _headers file, as an allow-list: these four rules, each exactly once, each setting exactly its own
// headers and removing none; any other rule, header or removal is refused. /* holds the site's policy (judged below by
// signpage-skeleton's check); the worker's rule its own CSP (W:880) and the thread file's its own (card
// signpage-prover-threads), each joined by Pages to /*'s; the setup files' rule their one Cache-Control (vault.md 2.14).
const EXACT = {
  [WORKER_PATH]: { "content-security-policy": WORKER_CSP },
  [THREAD_PATH]: { "content-security-policy": THREAD_CSP },
  "/assets/zk/*": { "cache-control": ZK_CACHE },
};
export const RULES = {
  "/*": ["content-security-policy", ...Object.keys(HEADERS)],
  ...Object.fromEntries(Object.entries(EXACT).map(([path, exact]) => [path, Object.keys(exact)])),
};

/** Copies index.html, public/ and the prover's setup files and licences (SERVED) into a fresh temp folder and returns its path. */
export function build(pkg = PKG) {
  const out = mkdtempSync(join(tmpdir(), "ct-signpage-"));
  copyFileSync(join(pkg, "index.html"), join(out, "index.html"));
  cpSync(join(pkg, "public"), out, { recursive: true });
  copyServed(out);
  return out;
}

/** Problems with a _headers file's text (empty = fine): one /* rule holding the whole policy, read as the live check reads a served answer. */
export function checkHeadersFile(text) {
  const rules = [];
  const p = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.length > 2000) p.push(`_headers line ${i + 1} is over Pages' 2,000 character limit`);
    if (!line.trim() || line.trim().startsWith("#")) return;
    if (!/^\s/.test(line)) return void rules.push({ path: line.trim(), headers: [], removes: [] });
    const rule = rules.at(-1);
    if (!rule) return void p.push(`_headers line ${i + 1} is a header before any URL line`);
    const rm = /^\s+!\s*(\S+)\s*$/.exec(line);
    const kv = /^\s+([^:\s]+):\s*(.*)$/.exec(line);
    if (rm) rule.removes.push(rm[1].toLowerCase());
    else if (kv) rule.headers.push([kv[1].toLowerCase(), kv[2]]);
    else p.push(`_headers line ${i + 1} cannot be read`);
  });
  if (rules.length > 100) p.push(`_headers has ${rules.length} rules, over Pages' 100`);
  for (const r of rules) {
    const allowed = Object.hasOwn(RULES, r.path) ? RULES[r.path] : null;
    if (!allowed) {
      p.push(`_headers rule ${r.path} is not one of the policy's rules (${Object.keys(RULES).join(", ")})`);
      continue;
    }
    for (const [k] of r.headers) if (!allowed.includes(k)) p.push(`_headers rule ${r.path} sets ${k}, which the policy does not set there`);
    for (const k of r.removes) p.push(`_headers rule ${r.path} removes ${k}`);
  }
  for (const [path, exact] of Object.entries(EXACT)) {
    const these = rules.filter((r) => r.path === path);
    const want = Object.entries(exact).map(([k, v]) => `${k}: ${v}`).join("; ");
    // each of its headers once, with its value (any other header is refused above)
    const once = (k, v) => {
      const hs = these[0].headers.filter(([h]) => h === k);
      return hs.length === 1 && hs[0][1].trim() === v; // trimmed as Pages does, then exact, as the live check reads it
    };
    const ok = these.length === 1 && Object.entries(exact).every(([k, v]) => once(k, v));
    if (!ok) p.push(`_headers must hold one ${path} rule that sets exactly ${want}`);
  }
  const all = rules.filter((r) => r.path === "/*");
  if (all.length !== 1) return [...p, `_headers must hold exactly one /* rule (has ${all.length})`];
  const seen = {};
  for (const [k, v] of all[0].headers) {
    if (k in seen) p.push(`_headers /* sets ${k} twice (Pages joins the two with a comma)`);
    else seen[k] = v;
  }
  const { lines } = judge({ status: 200, headers: seen });
  return [...p, ...lines.filter((l) => l.startsWith("BAD")).map((l) => `_headers: ${l.slice(4)}`)];
}

/** Problems with a build folder (empty = fine). */
export function checkDir(dir) {
  const p = [];
  if (!existsSync(join(dir, "index.html"))) p.push(`${dir} has no index.html`);
  if (existsSync(join(dir, "_worker.js"))) p.push(`${dir} carries _worker.js: Pages applies no _headers rule to a Function's response`);
  if (existsSync(join(dir, ".well-known", "webauthn"))) p.push(`${dir} carries .well-known/webauthn: no other origin may use SIGN_HOST's passkeys`);
  p.push(...checkProver(dir));
  if (!existsSync(join(dir, "_headers"))) return [...p, `${dir} has no _headers file`];
  return [...p, ...checkHeadersFile(readFileSync(join(dir, "_headers"), "utf8"))];
}

/** Problems with a build folder's prover files (empty = fine): the worker and the thread file are the kit's build, the setup files are exactly the pinned six. */
export function checkProver(dir) {
  const p = [];
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null);
  const worker = read(WORKER_PATH.slice(1));
  if (!worker || !worker.equals(proverWorkerSource())) p.push(`${WORKER_PATH.slice(1)} is not the kit's prover worker build`);
  const thread = read(THREAD_PATH.slice(1));
  if (!thread || !thread.equals(proverThreadSource())) p.push(`${THREAD_PATH.slice(1)} is not the kit's prover thread build`);
  for (const e of SERVED) {
    const b = read(e.to);
    if (!b) p.push(`${e.to}: missing`);
    else if (e.sha256 !== undefined) p.push(...pinProblems(e, b));
  }
  const zk = existsSync(join(dir, "assets", "zk")) ? readdirSync(join(dir, "assets", "zk")) : [];
  for (const f of zk) if (!SERVED.some((e) => e.to === `assets/zk/${f}`)) p.push(`assets/zk/${f}: not a pinned setup file`);
  return p;
}

/** The highest version a served release can have taken a wallet database to: release-26 is the first to go past 1 (its
 *  "owed" store, card signpage-withdraw-own-spend). A release that adds a store raises it. */
export const WALLET_DB_SERVED = 2;

/** Problems with the wallet store a build carries (empty = fine): it opens a database at WALLET_DB_SERVED, so SIGN_HOST
 *  never goes back to a release that opens a lower version (up to release-25, version 1 exactly), which would stop
 *  every signing at a VersionError until a newer deploy (fold 2, review MEDIUM 3). */
export function walletDbProblems(store = join(PKG, "..", "wallet", "src", "store", "index.ts"), version = WALLET_DB_SERVED) {
  const r = spawnSync(process.execPath, [join(PKG, "scripts", "wallet-db.mjs"), store, String(version)], { encoding: "utf8" });
  if (r.status === 0) return [];
  return [`${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").at(-1) || `wallet-db exit ${r.status ?? r.signal}`}: a database a served release made (WALLET_DB_SERVED ${version}) would stop every signing`];
}

export function deploy(argv, env = process.env, run = spawnSync, pkg = PKG) {
  const dryRun = argv.includes("--dry-run");
  if (argv.some((a) => a !== "--dry-run")) return { code: 2, err: ["usage: node packages/signpage/scripts/deploy.mjs [--dry-run]"] };
  // the tree the build reads, before it reads it: a deploy is HEAD's commit and nothing else (--dry-run builds a work in
  // progress too, and says a deploy would refuse it)
  const sha = run("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  const dirty = run("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).stdout?.trimEnd();
  if (!dryRun && !sha) return { code: 1, err: ["REFUSED no HEAD commit to name the upload by", "nothing was uploaded"] };
  if (!dryRun && dirty) return { code: 1, err: [`REFUSED the tree has uncommitted changes, and the upload would carry HEAD's name (${sha}):`, ...dirty.split("\n").slice(0, 20), "commit them first; nothing was uploaded"] };
  // HEAD's lockfile, exactly: the prover worker and thread file are built from the kit's installed packages
  const inst = run("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO, env, encoding: "utf8" });
  if (inst.status !== 0) {
    const why = `${inst.stderr ?? ""}`.trim().split("\n").slice(-5).join(" | ");
    return { code: 1, err: [`REFUSED the install failed (pnpm exit ${inst.status ?? inst.signal})${why ? `: ${why}` : ""}`, "nothing was uploaded"] };
  }
  const dir = build(pkg);
  try {
    const problems = [...checkDir(dir), ...walletDbProblems()];
    if (problems.length) return { code: 1, err: [...problems.map((p) => `REFUSED ${p}`), "nothing was uploaded"] };
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
    return { code: 0, out: [`deployed HEAD ${sha} to ${PROJECT} on ${BRANCH}`, ...liveCommands(sha)] };
  } finally {
    if (!dryRun) rmSync(dir, { recursive: true, force: true }); // the build holds 24 MB of setup files; --dry-run keeps it to serve
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--live-runs") {
    console.log(JSON.stringify(liveList()));
    process.exit(0);
  }
  const r = deploy(process.argv.slice(2));
  for (const l of r.out ?? []) console.log(`deploy: ${l}`);
  for (const l of r.err ?? []) console.error(`deploy: ${l}`);
  process.exit(r.code);
}
