// node --test apps/terminal/scripts/check-deploy.test.ts: the deploy gate passes the committed _headers and refuses
// each planted break of the header policy (the app paper's APU-10), one case each.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCsp, checkDir, checkHeadersFile, checkPermissions } from "./check-deploy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const FILE = readFileSync(join(PUBLIC, "_headers"), "utf8");
// a build as Vite writes it: public/ (the _headers) copied beside the built index.html
const BUILD = mkdtempSync(join(tmpdir(), "check-deploy-build-"));
cpSync(PUBLIC, BUILD, { recursive: true });
writeFileSync(join(BUILD, "index.html"), "<!doctype html>\n");
const CSP = /Content-Security-Policy: (.*)/.exec(FILE)![1]!;
const PP = /Permissions-Policy: (.*)/.exec(FILE)![1]!;
const SIGN = "https://sign.confidential.unrealized.trade";

const csp = (from: string, to: string) => {
  assert.ok(CSP.includes(from), from);
  return CSP.replace(from, to);
};
const refused = (problems: string[], re: RegExp) =>
  assert.ok(problems.some((x) => re.test(x)), `want ${re}, got:\n${problems.join("\n") || "(no problem)"}`);

test("the committed _headers and a build that carries them pass", () => {
  assert.deepEqual(checkCsp(CSP), []);
  assert.deepEqual(checkPermissions(PP), []);
  assert.deepEqual(checkHeadersFile(FILE), []);
  assert.deepEqual(checkDir(BUILD), []);
});

test("frame-src is exactly SIGN_HOST", () => {
  assert.match(CSP, new RegExp(`frame-src ${SIGN};`));
  refused(checkCsp(csp(`frame-src ${SIGN};`, "")), /^CSP frame-src missing/);
  refused(checkCsp(csp(`frame-src ${SIGN};`, `frame-src ${SIGN} https://evil.ct.test;`)), /frame-src must be exactly/);
  refused(checkCsp(csp(`frame-src ${SIGN};`, `frame-src ${SIGN} https://evil.ct.test;`)), /evil\.ct\.test is not allowed there/);
  refused(checkCsp(csp(`frame-src ${SIGN};`, "frame-src *;")), /frame-src contains \*: a wildcard/);
  refused(checkCsp(csp(`frame-src ${SIGN};`, "frame-src https://*.unrealized.trade;")), /a wildcard/);
});

test("script-src refuses 'wasm-unsafe-eval', 'unsafe-inline', 'unsafe-eval', 'unsafe-hashes'", () => {
  for (const k of ["'wasm-unsafe-eval'", "'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]) {
    const p = checkCsp(csp("script-src 'self';", `script-src 'self' ${k};`));
    refused(p, new RegExp(`script-src contains ${k}`));
  }
  refused(checkCsp(csp("style-src 'self';", "style-src 'self' 'unsafe-inline';")), /style-src contains 'unsafe-inline'/);
  refused(checkCsp(csp("script-src 'self';", "script-src 'self' 'strict-dynamic';")), /'strict-dynamic' is not allowed there/);
  refused(checkCsp(csp("script-src 'self';", "script-src 'self' 'nonce-abc';")), /'nonce-abc' is not allowed there/);
});

test("blob:, http:, https: and other bare schemes are refused", () => {
  refused(checkCsp(csp("img-src 'self' data:", "img-src 'self' blob: data:")), /img-src contains blob:: a bare scheme/);
  refused(checkCsp(csp("connect-src 'self'", "connect-src 'self' https:")), /connect-src contains https:: a bare scheme/);
  refused(checkCsp(csp("connect-src 'self'", "connect-src 'self' http:")), /connect-src contains http:: a bare scheme/);
  refused(checkCsp(csp("script-src 'self';", "script-src 'self' data:;")), /script-src contains data:: a bare scheme/);
  refused(checkCsp(csp("connect-src 'self'", "connect-src 'self' http://rpc.mainnet.near.org")), /http:\/\/rpc\.mainnet\.near\.org is not allowed there/);
});

test("worker-src, default-src and frame-ancestors are exactly 'none'", () => {
  refused(checkCsp(csp("worker-src 'none';", "worker-src 'self';")), /worker-src must be exactly 'none'/);
  refused(checkCsp(csp("worker-src 'none';", "")), /worker-src missing/);
  refused(checkCsp(csp("default-src 'none';", "default-src 'self';")), /default-src must be exactly 'none'/);
  refused(checkCsp(csp("frame-ancestors 'none';", "frame-ancestors 'self';")), /frame-ancestors must be exactly 'none'/);
  refused(checkCsp(csp("trusted-types 'none';", "trusted-types default;")), /trusted-types must be exactly 'none'/);
});

test("connect-src takes only the helper, SIGN_HOST and the three RPCs; a directive outside the policy is refused", () => {
  refused(checkCsp(csp("connect-src 'self'", "connect-src 'self' https://evil.ct.test")), /connect-src: https:\/\/evil\.ct\.test is not allowed/);
  refused(checkCsp(`${CSP}; report-uri https://evil.ct.test`), /directive report-uri is not in the policy/);
  refused(checkCsp(`${CSP}; script-src 'self' 'unsafe-eval'`), /script-src given twice/);
  refused(checkCsp(`${CSP}, script-src *`), /more than one policy/);
});

test("Permissions-Policy: WebAuthn is () and no feature is turned on", () => {
  refused(checkPermissions(PP.replace("publickey-credentials-get=()", "publickey-credentials-get=(self)")), /publickey-credentials-get must be \(\)/);
  refused(checkPermissions(PP.replace("publickey-credentials-create=(), ", "")), /publickey-credentials-create missing/);
  refused(checkPermissions(PP.replace("publickey-credentials-get=(), ", "")), /publickey-credentials-get missing/);
  refused(checkPermissions(PP.replace("camera=()", "camera=*")), /camera must be \(\)/);
  refused(checkPermissions(`${PP}, fullscreen=(self)`), /fullscreen must be \(\)/);
  assert.deepEqual(checkPermissions(`${PP}, fullscreen=()`), []);
});

test("Integrity-Policy, HSTS, COOP, X-Frame-Options and the rest must be exact; COEP must not be sent", () => {
  const drop = (name: string) => FILE.replace(new RegExp(`\\n  ${name}: .*`), "");
  refused(checkHeadersFile(drop("Integrity-Policy")), /^integrity-policy missing \(must be blocked-destinations=\(script\)\)/);
  refused(checkHeadersFile(FILE.replace("blocked-destinations=(script)", "blocked-destinations=()")), /integrity-policy must be/);
  refused(checkHeadersFile(FILE.replace("max-age=63072000", "max-age=31536000")), /strict-transport-security must be/);
  refused(checkHeadersFile(FILE.replace("Opener-Policy: same-origin", "Opener-Policy: same-origin-allow-popups")), /cross-origin-opener-policy must be same-origin/);
  refused(checkHeadersFile(drop("X-Frame-Options")), /x-frame-options missing/);
  refused(checkHeadersFile(drop("Content-Security-Policy")), /Content-Security-Policy missing/);
  refused(checkHeadersFile(`${FILE}  Cross-Origin-Embedder-Policy: require-corp\n`), /cross-origin-embedder-policy must not be sent/);
  refused(checkHeadersFile(`${FILE}  Content-Security-Policy-Report-Only: default-src *\n`), /report-only must not be sent/);
});

test("the _headers file: one /* rule, no policy header set or removed elsewhere, none set twice, lines under 2,000", () => {
  refused(checkHeadersFile(`${FILE}/index.html\n  ! Content-Security-Policy\n`), /rule \/index\.html removes content-security-policy/);
  refused(checkHeadersFile(`${FILE}/x/*\n  Content-Security-Policy: default-src *\n`), /rule \/x\/\* sets Content-Security-Policy/);
  assert.deepEqual(checkHeadersFile(`${FILE}/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`), []);
  refused(checkHeadersFile(`${FILE}  X-Frame-Options: SAMEORIGIN\n`), /sets X-Frame-Options twice/);
  refused(checkHeadersFile(`${FILE}/*\n  Cache-Control: no-store\n`), /exactly one \/\* rule \(has 2\)/);
  refused(checkHeadersFile(FILE.replace("upgrade-insecure-requests", `upgrade-insecure-requests${" ".repeat(1500)}`)), /over Pages' 2,000 character limit/);
});

test("a build with _worker.js or without _headers is refused; the CLI exits 1 on a refusal and 0 on the real build", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-"));
  cpSync(BUILD, dir, { recursive: true });
  writeFileSync(join(dir, "_worker.js"), "export default {}\n");
  refused(checkDir(dir), /carries _worker\.js/);
  const empty = mkdtempSync(join(tmpdir(), "check-deploy-"));
  writeFileSync(join(empty, "index.html"), "<!doctype html>\n");
  refused(checkDir(empty), /has no _headers file/);
  const cli = (d: string) => spawnSync(process.execPath, [join(HERE, "check-deploy.ts"), d], { encoding: "utf8" });
  const bad = cli(dir);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /check-deploy: REFUSED .*_worker\.js/);
  const good = cli(BUILD);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /check-deploy: ok .*the header policy holds/);
});

test("deploy.mjs runs the gate first: a refused build reaches no upload; a passing one uploads by wrangler from an empty dir", async () => {
  const { deploy, PROJECT, BRANCH, WRANGLER } = await import("./deploy.mjs");
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run = (cmd: string, args: string[], o: { cwd?: string }) => {
    calls.push({ cmd, args, cwd: o.cwd });
    return { status: 0, stdout: cmd === "git" && args.includes("rev-parse") ? "abc123\n" : "" };
  };
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };
  const bad = mkdtempSync(join(tmpdir(), "deploy-"));
  cpSync(BUILD, bad, { recursive: true });
  writeFileSync(join(bad, "_headers"), FILE.replace("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';"));
  const r1 = deploy([bad], env, run);
  assert.equal(r1.code, 1);
  assert.match(r1.err.join("\n"), /REFUSED CSP script-src contains 'wasm-unsafe-eval'[\s\S]*nothing was uploaded/);
  assert.equal(calls.length, 0);
  assert.equal(deploy([BUILD, "--dry-run"], env, run).code, 0);
  assert.equal(deploy([BUILD], {}, run).code, 2);
  assert.equal(calls.length, 0);
  const r2 = deploy([BUILD], env, run);
  assert.equal(r2.code, 0, r2.err?.join("\n"));
  const up = calls.find((c) => c.cmd === "pnpm")!;
  assert.deepEqual(up.args.slice(0, 9), ["dlx", WRANGLER, "pages", "deploy", BUILD, "--project-name", PROJECT, "--branch", BRANCH]);
  assert.ok(up.args.includes("abc123"));
  assert.match(up.cwd!, /ct-deploy-/);
  assert.equal(PROJECT, "confidential-trenches-app");
});
