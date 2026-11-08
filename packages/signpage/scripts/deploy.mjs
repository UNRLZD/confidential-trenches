#!/usr/bin/env node
// Builds the signing page and deploys it to SIGN_HOST's Cloudflare Pages project, only after the gate passes it.
//   node packages/signpage/scripts/deploy.mjs [--dry-run | --build]     exit 0 ok, 1 refused or failed, 2 usage
// The build is the package's tracked index.html and public/ (git ls-files: what the commit holds, never a file an
// ignore rule hides, such as public/.env.local) copied into a fresh temp folder, so nothing else in the package is
// served, plus the prover's setup files at assets/zk/<sha256>.<ext> and their licences (scripts/build-app.mjs
// copyServed, card signpage-prover-host). The gate then reads the build's own _headers and runs the card's live check
// (scripts/live-checks/signpage-skeleton.mjs) on the headers it sets for every path, checks the worker's own policy
// rule (W:880) and the thread file's (card signpage-prover-threads), and reads every setup file back against its pin
// and the worker and the thread file against a fresh build of the kit's.
// A deploy is main's head, released (card signpage-release-at-deploy): it fetches origin main and refuses unless HEAD
// is origin/main's head and that commit's push run of ci.yml passed (the read scripts/deploy/hosts-cutover.sh makes),
// and unless the newest committed release list (packages/signpage/releases, newest by N) names the build, file for file
// and header for header, with the ledger holding every list as written (release-list.mjs unreleasedProblems). So every
// build SIGN_HOST serves is a release on main; the flow that cuts one is in release-list.mjs's header, and the live
// check signpage-release-at-deploy reads SIGN_HOST against that list after the deploy. It also refuses an uncommitted
// change anywhere in the tree (the build carries the kit's prover too), no HEAD, or a failed
// `pnpm install --frozen-lockfile` (run first, so the build reads HEAD's lockfile): the upload is named by HEAD's
// commit, so it is HEAD's build. Every refusal comes before its env check (CLOUDFLARE_*) and before any upload.
// --dry-run makes every read and the build a deploy makes, keeps the build folder, and exits 1 with each REFUSED line
// whenever a deploy would refuse, 0 only when it would go ahead. --build is for a caller that wants only the gated
// build (a harness, `wrangler pages dev`): the install, the build and the build's gate, the folder kept, nothing read of
// main, CI or the releases. The upload is
// wrangler's `pages deploy`, at an exact version, run from an empty folder so no functions/ folder can ride along
// (Pages applies no _headers rule to a Function's response). It needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
// in the environment; neither is printed. A wrangler exit 0 is not done: SIGN_HOST must then serve this build's / and
// /app.js (scripts/pages-readback.mjs, card pages-deploy-readback), or it exits 1 naming both hashes and prints no next:.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBack } from "../../../scripts/pages-readback.mjs";
import { HEADERS, judge } from "../../../scripts/live-checks/signpage-skeleton.mjs";
import { ORIGINS } from "../../../scripts/live-checks/signpage-release.mjs";
import { WORKER_CSP, WORKER_PATH, ZK_CACHE } from "../../../scripts/live-checks/signpage-prover-host.mjs";
import { THREAD_CSP, THREAD_PATH } from "../../../scripts/live-checks/signpage-prover-threads.mjs";
import { facts as pinFacts, judge as judgePins } from "../../../scripts/live-checks/kit-oneclick-pins-frozen.mjs";
import { proverThreadSource, proverWorkerSource } from "../../kit/src/prover/build.mjs";
import { SERVED, copyServed, pinProblems } from "./build-app.mjs";
import { hostList } from "../../../scripts/ci/live-after.mjs";

/** Every live check that reads SIGN_HOST, run after each deploy (a failing one undoes it): each check's `// After: sign`
 *  lines (scripts/ci/live-after.mjs), one run for each, each its own job in live.yml. A run's arguments are on its line:
 *  signpage-release reads SIGN_HOST alone against this commit's own build, and app-harness-signin-e2e SIGN_HOST's
 *  backdrop alone, so an APP_HOST that lags does not fail this deploy; signpage-shell runs live on Chromium and Firefox at
 *  both widths (its WebKit run is the Mac's own harness, which a runner has not); the engines a run needs are named, so
 *  live.yml installs Playwright's Firefox and WebKit only where an argument says so. */
const AFTER = hostList("sign", join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
export const LIVE_CHECKS = AFTER.checks;
export const LIVE_ARGS = AFTER.args;
/** The runs of one check, each as `scripts/live-checks/<key>.mjs <args>`. */
export const liveRuns = (k) => (LIVE_ARGS[k] ?? []).map((a) => `scripts/live-checks/${k}.mjs${a ? ` ${a}` : ""}`);
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

/**
 * The package's served sources, relative to `pkg`: index.html and public/'s files as git tracks them (a release build is
 * the commit's tree, so an ignored file, such as public/.env.local, is never served or listed). A folder outside any git
 * tree (a test's copy of the package) is its own source: every file in it.
 */
export function servedSources(pkg = PKG) {
  const r = spawnSync("git", ["-C", pkg, "ls-files", "-z", "--", "index.html", "public"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split("\0").filter((f) => f && existsSync(join(pkg, f)));
  const all = [];
  const walk = (rel) => {
    for (const n of readdirSync(join(pkg, rel))) {
      const f = `${rel}/${n}`;
      if (statSync(join(pkg, f)).isDirectory()) walk(f);
      else all.push(f);
    }
  };
  walk("public");
  return ["index.html", ...all];
}

/** Copies the package's served sources (servedSources: index.html at the root, public/'s files at their paths under it)
 *  and the prover's setup files and licences (SERVED) into a fresh temp folder and returns its path. */
export function build(pkg = PKG) {
  const out = mkdtempSync(join(tmpdir(), "ct-signpage-"));
  for (const f of servedSources(pkg)) {
    const to = join(out, f === "index.html" ? f : f.slice("public/".length));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(pkg, f), to);
  }
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
  // Pages' other config files: a _redirects rule could rewrite /.well-known/webauthn to a file that lends SIGN_HOST's
  // passkeys to other origins, and _routes.json and functions/ belong to Functions; _headers is the only one allowed
  for (const f of ["_redirects", "_routes.json", "functions"]) {
    if (existsSync(join(dir, f))) p.push(`${dir} carries ${f}: _headers is the only Pages config file the signing page has`);
  }
  if (existsSync(join(dir, ".well-known", "webauthn"))) p.push(`${dir} carries .well-known/webauthn: no other origin may use SIGN_HOST's passkeys`);
  p.push(...checkProver(dir));
  p.push(...checkPins(dir));
  if (!existsSync(join(dir, "_headers"))) return [...p, `${dir} has no _headers file`];
  return [...p, ...checkHeadersFile(readFileSync(join(dir, "_headers"), "utf8"))];
}

/** Problems with a build folder's 1Click pins (card kit-oneclick-pins-frozen; empty = fine): its app.js names no 1Click
 *  signing key but the pinned bytes (PINNED_KEYS, named by the live check itself), so a build that ships a test
 *  harness's key is never uploaded or listed, and every pin of the device's 1Click check in it is frozen. */
export function checkPins(dir) {
  if (!existsSync(join(dir, "index.html")) || !existsSync(join(dir, "app.js"))) return [`${dir} has no app.js for the 1Click pin check`];
  return judgePins(pinFacts(readFileSync(join(dir, "index.html"), "utf8"), readFileSync(join(dir, "app.js"), "utf8"))).lines.map((l) => `app.js: ${l.slice(4)}`);
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

/** The repository whose main a sign deploy must be, and whose ci.yml push run on that commit must have passed. */
export const REPO_SLUG = "UNRLZD/confidential-trenches";

/** Why HEAD `sha` is not a commit a sign deploy may serve (empty = none): it must be origin/main's head, fetched now,
 *  with a passed push run of ci.yml on main (a pull request's checks ran on its own tree, not the merge's). */
export function mainProblems(sha, run = spawnSync) {
  const f = run("git", ["-C", REPO, "fetch", "-q", "origin", "main"], { encoding: "utf8" });
  if (f.status !== 0) return [`git fetch origin main failed (exit ${f.status ?? f.signal}): the deploy reads origin/main's head`];
  const p = [];
  const main = run("git", ["-C", REPO, "rev-parse", "origin/main"], { encoding: "utf8" }).stdout?.trim();
  if (!sha || main !== sha) p.push(`HEAD ${sha || "(none)"} is not origin/main's head ${main || "(none)"}: a sign deploy is main's head, at the merge that holds its release`);
  const ci = run("gh", ["run", "list", "-R", REPO_SLUG, "--branch", "main", "--workflow", "ci.yml", "--event", "push", "--status", "success", "-L", "200", "--json", "headSha", "-q", ".[].headSha"], { encoding: "utf8" });
  if (ci.status !== 0) p.push(`gh did not read ci.yml's runs on main (exit ${ci.status ?? ci.signal})`);
  else if (!sha || !`${ci.stdout ?? ""}`.split("\n").includes(sha)) p.push(`HEAD ${sha || "(none)"} has no passed push run of ci.yml on main`);
  return p;
}

const USAGE = "usage: node packages/signpage/scripts/deploy.mjs [--dry-run | --build]";

/** The deploy: { code, out, err }. `net` is the read-back's fetch and sleep (scripts/pages-readback.mjs), and
 *  `released` the release lists and their ledger ({ dir, ledger }; the committed ones by default), a test's stand-ins. */
export async function deploy(argv, env = process.env, run = spawnSync, pkg = PKG, net = {}, released = {}) {
  if (argv.length > 1 || (argv.length && !["--dry-run", "--build"].includes(argv[0]))) return { code: 2, err: [USAGE] };
  const [dryRun, buildOnly] = [argv[0] === "--dry-run", argv[0] === "--build"];
  // what a deploy refuses, read before the install and the build: HEAD's commit, clean, main's released head
  const would = [];
  let head = null;
  if (!buildOnly) {
    const sha = run("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
    const dirty = run("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).stdout?.trimEnd();
    if (!sha) would.push("no HEAD commit to name the upload by");
    if (dirty) would.push(`the tree has uncommitted changes, and the upload would carry HEAD's name (${sha}): ${dirty.split("\n").slice(0, 20).join(" | ")}: commit them first`);
    would.push(...mainProblems(sha, run));
    if (!dryRun && would.length) return { code: 1, err: [...would.map((p) => `REFUSED ${p}`), "nothing was uploaded"] };
    head = sha;
  }
  // HEAD's lockfile, exactly: the prover worker and thread file are built from the kit's installed packages
  const inst = run("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO, env, encoding: "utf8" });
  if (inst.status !== 0) {
    const why = `${inst.stderr ?? ""}`.trim().split("\n").slice(-5).join(" | ");
    return { code: 1, err: [`REFUSED the install failed (pnpm exit ${inst.status ?? inst.signal})${why ? `: ${why}` : ""}`, "nothing was uploaded"] };
  }
  const dir = build(pkg);
  const keep = dryRun || buildOnly; // the build holds 24 MB of setup files; --dry-run and --build keep it to serve
  try {
    const problems = checkDir(dir);
    if (problems.length) return { code: 1, err: [...problems.map((p) => `REFUSED ${p}`), "nothing was uploaded"] };
    if (buildOnly) return { code: 0, out: [`gate ok on ${dir}; --build: the build's gate only, nothing read of main, CI or the releases; nothing was uploaded`] };
    // loaded here, not at the top: release-list.mjs imports this file and the terminal's deploy, which --live-runs needs not
    const { unreleasedProblems } = await import("./release-list.mjs");
    would.push(...unreleasedProblems(dir, ...(released.dir ? [released.dir, released.ledger] : [])));
    if (dryRun) {
      if (would.length) return { code: 1, out: [`gate ok on ${dir}; --dry-run: nothing was uploaded; a deploy would refuse it:`], err: [...would.map((p) => `REFUSED ${p}`)] };
      return { code: 0, out: [`gate ok on ${dir}; --dry-run: nothing was uploaded; a deploy would go ahead`] };
    }
    if (would.length) return { code: 1, err: [...would.map((p) => `REFUSED ${p}`), "nothing was uploaded"] };
    const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !env[k]);
    if (missing.length) return { code: 2, err: [`gate ok; ${missing.join(" and ")} not set, nothing was uploaded`] };
    const args = ["dlx", WRANGLER, "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH, "--commit-hash", head, "--commit-dirty=false"];
    const r = run("pnpm", args, {
      cwd: mkdtempSync(join(tmpdir(), "ct-deploy-")),
      env: { ...env, WRANGLER_SEND_METRICS: "false" },
      stdio: "inherit",
    });
    if (r.status !== 0) return { code: 1, err: [`wrangler pages deploy failed (exit ${r.status ?? r.signal})`] };
    // wrangler's exit 0 is its word, not the address's (6 Nov 09:21Z: "couldn't ascertain the final status", a Failure)
    const back = await readBack(ORIGINS.SIGN_HOST, dir, net);
    if (!back.ok) return { code: 1, err: [`uploaded HEAD ${head} to ${PROJECT} on ${BRANCH}, but`, ...back.lines] };
    return { code: 0, out: [`deployed HEAD ${head} to ${PROJECT} on ${BRANCH}`, ...back.lines, ...liveCommands(head)] };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--live-runs") {
    console.log(JSON.stringify(liveList()));
    process.exit(0);
  }
  const r = await deploy(process.argv.slice(2));
  for (const l of r.out ?? []) console.log(`deploy: ${l}`);
  for (const l of r.err ?? []) console.error(`deploy: ${l}`);
  process.exit(r.code);
}
