#!/usr/bin/env node
// Builds the signing page and deploys it to SIGN_HOST's Cloudflare Pages project, only after the gate passes it.
//   node packages/signpage/scripts/deploy.mjs [--dry-run]     exit 0 ok, 1 refused or failed, 2 usage
// The build is index.html and public/ copied into a fresh temp folder, so nothing else in the package is served. The
// gate then reads the build's own _headers and runs the card's live check (scripts/live-checks/signpage-skeleton.mjs)
// on the headers it sets for every path; any refusal stops here, before a token is read or a byte is uploaded.
// --dry-run stops after the gate and keeps the build folder, so `wrangler pages dev` can serve it. The upload is
// wrangler's `pages deploy`, at an exact version, run from an empty folder so no functions/ folder can ride along
// (Pages applies no _headers rule to a Function's response). It needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
// in the environment; neither is printed.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABSENT, HEADERS, judge } from "../../../scripts/live-checks/signpage-skeleton.mjs";

/** Every live check that reads SIGN_HOST, run after each deploy (a failing one undoes it). */
export const LIVE_CHECKS = ["signpage-skeleton", "wallet-passkey-prf", "signpage-postmessage", "signpage-frame-state", "signpage-shell"];
export const PROJECT = "confidential-trenches-sign";
export const BRANCH = "main"; // the project's production branch: a deploy on it serves SIGN_HOST
export const WRANGLER = "wrangler@4.151.1"; // published 2026-10-16
const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(PKG));

// headers the policy sets; a rule other than /* may neither set nor remove one
const POLICY = ["content-security-policy", ...Object.keys(HEADERS), ...ABSENT];

/** Copies index.html and public/ into a fresh temp folder and returns its path. */
export function build(pkg = PKG) {
  const out = mkdtempSync(join(tmpdir(), "ct-signpage-"));
  copyFileSync(join(pkg, "index.html"), join(out, "index.html"));
  cpSync(join(pkg, "public"), out, { recursive: true });
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
  const all = rules.filter((r) => r.path === "/*");
  if (all.length !== 1) return [...p, `_headers must hold exactly one /* rule (has ${all.length})`];
  for (const r of rules) {
    for (const [k] of r.headers) if (r.path !== "/*" && POLICY.includes(k)) p.push(`_headers rule ${r.path} sets ${k}: the policy is set on /* only`);
    for (const k of r.removes) if (POLICY.includes(k)) p.push(`_headers rule ${r.path} removes ${k}`);
  }
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
  if (!existsSync(join(dir, "_headers"))) return [...p, `${dir} has no _headers file`];
  return [...p, ...checkHeadersFile(readFileSync(join(dir, "_headers"), "utf8"))];
}

export function deploy(argv, env = process.env, run = spawnSync, pkg = PKG) {
  const dryRun = argv.includes("--dry-run");
  if (argv.some((a) => a !== "--dry-run")) return { code: 2, err: ["usage: node packages/signpage/scripts/deploy.mjs [--dry-run]"] };
  const dir = build(pkg);
  const problems = checkDir(dir);
  if (problems.length) return { code: 1, err: [...problems.map((p) => `REFUSED ${p}`), "nothing was uploaded"] };
  if (dryRun) return { code: 0, out: [`gate ok on ${dir}; --dry-run: nothing was uploaded`] };
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((k) => !env[k]);
  if (missing.length) return { code: 2, err: [`gate ok; ${missing.join(" and ")} not set, nothing was uploaded`] };
  const sha = run("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  const dirty = run("git", ["-C", REPO, "status", "--porcelain", "--", "packages/signpage"], { encoding: "utf8" }).stdout?.trim();
  const args = ["dlx", WRANGLER, "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH];
  if (sha) args.push("--commit-hash", sha, `--commit-dirty=${dirty ? "true" : "false"}`);
  const r = run("pnpm", args, {
    cwd: mkdtempSync(join(tmpdir(), "ct-deploy-")),
    env: { ...env, WRANGLER_SEND_METRICS: "false" },
    stdio: "inherit",
  });
  if (r.status !== 0) return { code: 1, err: [`wrangler pages deploy failed (exit ${r.status ?? r.signal})`] };
  return { code: 0, out: [`deployed ${dir} to ${PROJECT} on ${BRANCH}; run ${LIVE_CHECKS.map((k) => `scripts/live-checks/${k}.mjs`).join(", ")} next`] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = deploy(process.argv.slice(2));
  for (const l of r.out ?? []) console.log(`deploy: ${l}`);
  for (const l of r.err ?? []) console.error(`deploy: ${l}`);
  process.exit(r.code);
}
