// node --test apps/terminal/scripts/check-deploy.test.ts: the deploy gate passes the committed _headers and refuses
// each planted break of the header policy (the app paper's APU-10), one case each.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCsp, checkDir, checkHeadersFile, checkPages, checkPermissions } from "./check-deploy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const FILE = readFileSync(join(PUBLIC, "_headers"), "utf8");
// a build as Vite and build/sri.mjs write it: public/ (the _headers) copied beside the built index.html, whose one
// script and one stylesheet carry the sha384 of their files (computed here, not by sri.mjs)
const sha384 = (b: string | Buffer) => `sha384-${createHash("sha384").update(b).digest("base64")}`;
const JS = "console.log('app')\n";
const CSS = "body{margin:0}\n";
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Confidential Trenches</title>
    <link rel="preload" href="/assets/f.woff2" as="font" type="font/woff2" crossorigin>
    <script type="module" crossorigin src="/assets/index-a1.js" integrity="${sha384(JS)}"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-b2.css" integrity="${sha384(CSS)}">
  </head>
  <body><div id="root"></div></body>
</html>
`;
const BUILD = mkdtempSync(join(tmpdir(), "check-deploy-build-"));
cpSync(PUBLIC, BUILD, { recursive: true });
mkdirSync(join(BUILD, "assets"));
writeFileSync(join(BUILD, "assets/index-a1.js"), JS);
writeFileSync(join(BUILD, "assets/index-b2.css"), CSS);
writeFileSync(join(BUILD, "assets/f.woff2"), "font");
writeFileSync(join(BUILD, "index.html"), PAGE);
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
  assert.deepEqual(checkPages(BUILD), []);
  assert.deepEqual(checkDir(BUILD), []);
});

test("frame-src is exactly 'none': the terminal frames nothing, it runs inside SIGN_HOST's shell", () => {
  assert.match(CSP, /frame-src 'none';/);
  refused(checkCsp(csp("frame-src 'none';", "")), /^CSP frame-src missing/);
  refused(checkCsp(csp("frame-src 'none';", `frame-src ${SIGN};`)), /frame-src must be exactly 'none'/);
  refused(checkCsp(csp("frame-src 'none';", "frame-src *;")), /frame-src contains \*: a wildcard/);
});

test("frame-ancestors is exactly SIGN_HOST: only SIGN_HOST's shell may frame the terminal", () => {
  assert.match(CSP, new RegExp(`frame-ancestors ${SIGN};`));
  refused(checkCsp(csp(`frame-ancestors ${SIGN};`, "")), /^CSP frame-ancestors missing/);
  refused(checkCsp(csp(`frame-ancestors ${SIGN};`, "frame-ancestors 'none';")), /frame-ancestors must be exactly/);
  refused(checkCsp(csp(`frame-ancestors ${SIGN};`, "frame-ancestors 'self';")), /frame-ancestors must be exactly/);
  refused(checkCsp(csp(`frame-ancestors ${SIGN};`, `frame-ancestors ${SIGN} https://evil.ct.test;`)), /evil\.ct\.test is not allowed there/);
  refused(checkCsp(csp(`frame-ancestors ${SIGN};`, "frame-ancestors *;")), /frame-ancestors contains \*: a wildcard/);
  refused(checkCsp(csp(`frame-ancestors ${SIGN};`, "frame-ancestors https://*.unrealized.trade;")), /a wildcard/);
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

test("worker-src and default-src are exactly 'none'", () => {
  refused(checkCsp(csp("worker-src 'none';", "worker-src 'self';")), /worker-src must be exactly 'none'/);
  refused(checkCsp(csp("worker-src 'none';", "")), /worker-src missing/);
  refused(checkCsp(csp("default-src 'none';", "default-src 'self';")), /default-src must be exactly 'none'/);
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

test("Integrity-Policy, HSTS, COOP and the rest must be exact; COEP and X-Frame-Options must not be sent", () => {
  const drop = (name: string) => FILE.replace(new RegExp(`\\n  ${name}: .*`), "");
  refused(checkHeadersFile(drop("Integrity-Policy")), /^integrity-policy missing \(must be blocked-destinations=\(script\)\)/);
  refused(checkHeadersFile(FILE.replace("blocked-destinations=(script)", "blocked-destinations=()")), /integrity-policy must be/);
  refused(checkHeadersFile(FILE.replace("max-age=63072000", "max-age=31536000")), /strict-transport-security must be/);
  refused(checkHeadersFile(FILE.replace("Opener-Policy: same-origin", "Opener-Policy: same-origin-allow-popups")), /cross-origin-opener-policy must be same-origin/);
  // any X-Frame-Options value would refuse SIGN_HOST's shell: DENY and SAMEORIGIN both, and ALLOW-FROM is obsolete
  for (const v of ["DENY", "SAMEORIGIN"]) refused(checkHeadersFile(`${FILE}  X-Frame-Options: ${v}\n`), /x-frame-options must not be sent/);
  refused(checkHeadersFile(drop("Content-Security-Policy")), /Content-Security-Policy missing/);
  refused(checkHeadersFile(`${FILE}  Cross-Origin-Embedder-Policy: require-corp\n`), /cross-origin-embedder-policy must not be sent/);
  refused(checkHeadersFile(`${FILE}  Content-Security-Policy-Report-Only: default-src *\n`), /report-only must not be sent/);
});

test("the _headers file: one /* rule, no policy header set or removed elsewhere, none set twice, lines under 2,000", () => {
  refused(checkHeadersFile(`${FILE}/index.html\n  ! Content-Security-Policy\n`), /rule \/index\.html removes content-security-policy/);
  refused(checkHeadersFile(`${FILE}/x/*\n  Content-Security-Policy: default-src *\n`), /rule \/x\/\* sets Content-Security-Policy/);
  assert.deepEqual(checkHeadersFile(`${FILE}/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`), []);
  refused(checkHeadersFile(`${FILE}  Referrer-Policy: origin\n`), /sets Referrer-Policy twice/);
  refused(checkHeadersFile(`${FILE}/*\n  Cache-Control: no-store\n`), /exactly one \/\* rule \(has 2\)/);
  refused(checkHeadersFile(FILE.replace("upgrade-insecure-requests", `upgrade-insecure-requests${" ".repeat(1500)}`)), /over Pages' 2,000 character limit/);
});

test("a build with _worker.js or without _headers is refused; the CLI exits 1 on a refusal and 0 on the real build", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-"));
  cpSync(BUILD, dir, { recursive: true });
  writeFileSync(join(dir, "_worker.js"), "export default {}\n");
  refused(checkDir(dir), /carries _worker\.js/);
  const empty = mkdtempSync(join(tmpdir(), "check-deploy-"));
  cpSync(BUILD, empty, { recursive: true });
  rmSync(join(empty, "_headers"));
  refused(checkDir(empty), /has no _headers file/);
  const cli = (d: string) => spawnSync(process.execPath, [join(HERE, "check-deploy.ts"), d], { encoding: "utf8" });
  const bad = cli(dir);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /check-deploy: REFUSED .*_worker\.js/);
  const good = cli(BUILD);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /check-deploy: ok .*the header policy holds/);
});

// deploy.mjs's own steps, without git, vite or wrangler: `git` answers HEAD and the tree's status as given, `make` is the
// build (a copy of a planted folder, since a deploy removes the build it uploaded), and every call is kept
const copyOf = (src: string) => {
  const d = mkdtempSync(join(tmpdir(), "deploy-"));
  cpSync(src, d, { recursive: true });
  return d;
};
const steps = ({ head = "abc123", status = "", from = BUILD, problems = [] as string[] } = {}) => {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run = (cmd: string, args: string[], o: { cwd?: string } = {}) => {
    calls.push({ cmd, args, cwd: o.cwd });
    if (cmd !== "git") return { status: 0, stdout: "" };
    return { status: 0, stdout: args.includes("rev-parse") ? (head ? `${head}\n` : "") : status };
  };
  const made: string[] = [];
  const make = () => {
    const dir = copyOf(from);
    made.push(dir);
    return { dir, problems };
  };
  return { calls, run, make, made, uploads: () => calls.filter((c) => c.cmd === "pnpm") };
};
const ENV = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };

test("deploy.mjs takes no build folder: it builds HEAD itself, so a folder built from another commit can never be uploaded", async () => {
  const { deploy } = await import("./deploy.mjs");
  const s = steps();
  const r = deploy([copyOf(BUILD)], ENV, s.run, s.make);
  assert.equal(r.code, 2, r.out?.join("\n"));
  assert.match(r.err.join("\n"), /takes no build folder: it builds HEAD itself/);
  assert.deepEqual([s.made.length, s.uploads().length], [0, 0]);
});

test("a failed build stops the deploy before a token is read or a byte is uploaded", async () => {
  const { deploy } = await import("./deploy.mjs");
  const s = steps({ problems: ["the build failed (vite exit 1): src/x.ts: Unexpected token"] });
  const r = deploy([], {}, s.run, s.make);
  assert.equal(r.code, 1, r.err?.join("\n"));
  assert.match(r.err.join("\n"), /REFUSED the build failed \(vite exit 1\)[\s\S]*nothing was uploaded/);
  assert.equal(s.uploads().length, 0);
});

test("an uncommitted tree or no HEAD is refused before the token: the upload is named by HEAD's commit, so it must be HEAD's build", async () => {
  const { deploy } = await import("./deploy.mjs");
  const dirty = steps({ status: " M packages/kit/src/index.ts\n" });
  const r = deploy([], {}, dirty.run, dirty.make);
  assert.equal(r.code, 1, r.out?.join("\n"));
  assert.match(r.err.join("\n"), /REFUSED the tree has uncommitted changes[\s\S]*packages\/kit\/src\/index\.ts[\s\S]*nothing was uploaded/);
  assert.equal(dirty.uploads().length, 0);
  const headless = steps({ head: "" });
  const r2 = deploy([], ENV, headless.run, headless.make);
  assert.equal(r2.code, 1);
  assert.match(r2.err.join("\n"), /REFUSED no HEAD commit/);
  assert.equal(headless.uploads().length, 0);
  // --dry-run still builds and gates a work in progress, and says a deploy would refuse it
  const dry = steps({ status: " M apps/terminal/src/main.tsx\n" });
  const d = deploy(["--dry-run"], {}, dry.run, dry.make);
  assert.equal(d.code, 0, d.err?.join("\n"));
  assert.match(d.out.join("\n"), /gate ok on [\s\S]*uncommitted changes: a deploy would refuse/);
});

test("deploy.mjs runs the gate first: a refused build reaches no upload; a passing one uploads HEAD's build by wrangler from an empty dir", async () => {
  const { deploy, PROJECT, BRANCH, WRANGLER } = await import("./deploy.mjs");
  const bad = mkdtempSync(join(tmpdir(), "deploy-"));
  cpSync(BUILD, bad, { recursive: true });
  writeFileSync(join(bad, "_headers"), FILE.replace("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';"));
  const b = steps({ from: bad });
  const r1 = deploy([], ENV, b.run, b.make);
  assert.equal(r1.code, 1);
  assert.match(r1.err.join("\n"), /REFUSED CSP script-src contains 'wasm-unsafe-eval'[\s\S]*nothing was uploaded/);
  assert.equal(b.uploads().length, 0);
  const s = steps();
  assert.equal(deploy(["--dry-run"], ENV, s.run, s.make).code, 0);
  assert.equal(deploy([], {}, s.run, s.make).code, 2);
  assert.equal(s.uploads().length, 0);
  const r2 = deploy([], ENV, s.run, s.make);
  assert.equal(r2.code, 0, r2.err?.join("\n"));
  const up = s.uploads()[0]!;
  const dir = s.made.at(-1)!;
  assert.deepEqual(up.args.slice(0, 9), ["dlx", WRANGLER, "pages", "deploy", dir, "--project-name", PROJECT, "--branch", BRANCH]);
  assert.deepEqual(up.args.slice(9), ["--commit-hash", "abc123", "--commit-dirty=false"]);
  assert.match(up.cwd!, /ct-deploy-/);
  assert.equal(existsSync(dir), false, "the uploaded build is removed");
  assert.equal(PROJECT, "confidential-trenches-app");
});

test("a fresh build at HEAD, by the terminal's own vite build, passes --dry-run", async () => {
  const { deploy } = await import("./deploy.mjs");
  const r = deploy(["--dry-run"]);
  assert.equal(r.code, 0, r.err?.join("\n"));
  const dir = /gate ok on (\S+?);/.exec(r.out.join("\n"))![1]!;
  assert.ok(existsSync(join(dir, "index.html")) && existsSync(join(dir, "_headers")), dir);
  rmSync(dir, { recursive: true, force: true });
});

test("deploy.mjs's live runs name every live check that reads APP_HOST, and its success line is the command that runs them on GitHub's runners", async () => {
  const { deploy, LIVE_CHECKS: CHECKS, liveRuns } = await import("./deploy.mjs");
  const s = steps();
  const done = deploy([], ENV, s.run, s.make).out!;
  assert.ok(done.includes("next: gh workflow run live.yml -f host=app -f commit=abc123"), done.join("\n"));
  assert.ok(done.includes("then: gh run watch --exit-status"), done.join("\n"));
  const out = CHECKS.flatMap((k: string) => liveRuns(k)).join("\n");
  // a check reads APP_HOST when it is an app-* live check; each such file must hold APP_HOST's own address
  const dir = join(HERE, "..", "..", "..", "scripts", "live-checks");
  const keys = readdirSync(dir).filter((f) => /^app-[\w-]+\.mjs$/.test(f) && !f.endsWith(".test.mjs")).map((f) => f.replace(/\.mjs$/, ""));
  assert.ok(keys.length >= 4, keys.join(" "));
  for (const k of keys) {
    assert.match(readFileSync(join(dir, `${k}.mjs`), "utf8"), /"https:\/\/confidential\.unrealized\.trade\/?"/, `${k} does not hold APP_HOST's address`);
    assert.ok(out.includes(`scripts/live-checks/${k}.mjs`), `the success line does not name ${k}: ${out}`);
  }
  // and signpage-release, which reads APP_HOST alone against this commit's own build
  assert.match(readFileSync(join(dir, "signpage-release.mjs"), "utf8"), /"https:\/\/confidential\.unrealized\.trade"/);
  assert.ok(out.includes("scripts/live-checks/signpage-release.mjs --host app"), `the success line does not run signpage-release on APP_HOST alone: ${out}`);
  // app-verify-mount runs on the network the build names: this build's _headers names the mainnet RPCs
  assert.ok(out.includes("scripts/live-checks/app-verify-mount.mjs --network mainnet"), out);
  const { networkOfBuild } = await import("./deploy.mjs");
  const { headersFor } = await import("../build/network.mjs");
  const t = mkdtempSync(join(tmpdir(), "check-deploy-testnet-"));
  writeFileSync(join(t, "_headers"), headersFor("testnet", readFileSync(join(BUILD, "_headers"), "utf8")));
  assert.deepEqual([networkOfBuild(BUILD), networkOfBuild(t)], ["mainnet", "testnet"]);
  const { LIVE_CHECKS } = await import("./deploy.mjs");
  assert.deepEqual(LIVE_CHECKS.filter((k: string) => !keys.includes(k)), ["signpage-release"], "LIVE_CHECKS holds only app-* checks and signpage-release");
});

// A build like BUILD with `edit` applied to a fresh copy; its problems from checkDir.
const planted = (edit: (dir: string, page: string) => string | void) => {
  const dir = mkdtempSync(join(tmpdir(), "check-deploy-sri-"));
  cpSync(BUILD, dir, { recursive: true });
  const html = edit(dir, PAGE);
  if (typeof html === "string") writeFileSync(join(dir, "index.html"), html);
  return checkDir(dir);
};
const swap = (from: string, to: string) => (_: string, page: string) => {
  assert.ok(page.includes(from), from);
  return page.replace(from, to);
};
const SCRIPT_TAG = /<script type="module"[^>]*><\/script>/.exec(PAGE)![0];

test("SRI: one byte changed in the script, or a stylesheet, after its sha384 was written is refused", () => {
  refused(planted((d) => writeFileSync(join(d, "assets/index-a1.js"), JS.replace("app", "apq"))), /index\.html: script \/assets\/index-a1\.js: integrity sha384-\S+ is not the sha384 of its file \(sha384-/);
  refused(planted((d) => writeFileSync(join(d, "assets/index-b2.css"), `${CSS} `)), /index\.html: stylesheet \/assets\/index-b2\.css: integrity .* is not the sha384 of its file/);
});

test("SRI: a script with no integrity, an inline script, or a script whose file is not in the build is refused", () => {
  const bare = planted(swap(` integrity="${sha384(JS)}"`, ""));
  assert.deepEqual(bare, ["index.html: script /assets/index-a1.js has no integrity (Integrity-Policy blocks it)"]);
  refused(planted(swap("/assets/index-a1.js", "http://[x")), /index\.html: script http:\/\/\[x: not a URL/);
  refused(planted(swap("</title>", "</title><script>window.x=1</script>")), /index\.html: an inline script/);
  refused(planted(swap("/assets/index-a1.js", "/assets/gone.js")), /index\.html: script \/assets\/gone\.js: no such file in the build/);
  refused(planted(swap("/assets/index-a1.js", "https://evil.ct.test/a.js")), /index\.html: script https:\/\/evil\.ct\.test\/a\.js is not a file of this build/);
  refused(planted(swap("/assets/index-a1.js", "//evil.ct.test/a.js")), /is not a file of this build/);
  refused(planted(swap(SCRIPT_TAG, SCRIPT_TAG.replace("<script ", "<SCRIPT ").replace(` integrity="${sha384(JS)}"`, ""))), /script \/assets\/index-a1\.js has no integrity/);
});

test("SRI: an integrity must be exactly one sha384", () => {
  const sha256 = `sha256-${createHash("sha256").update(JS).digest("base64")}`;
  refused(planted(swap(sha384(JS), sha256)), /script \/assets\/index-a1\.js: integrity must be exactly one sha384 \(got sha256-/);
  refused(planted(swap(sha384(JS), `${sha384(JS)} ${sha384("x")}`)), /integrity must be exactly one sha384/);
  refused(planted(swap(`integrity="${sha384(JS)}"`, "integrity")), /integrity must be exactly one sha384 \(got nothing\)/);
});

test("SRI: a modulepreload without integrity, a script no page loads, a CSP meta, a page with no script, another page's bare script", () => {
  refused(planted(swap("</title>", '</title><link rel="modulepreload" href="/assets/index-a1.js">')), /index\.html: modulepreload \/assets\/index-a1\.js has no integrity/);
  refused(planted((d) => void writeFileSync(join(d, "assets/chunk-c3.js"), "export {}\n")), /assets\/chunk-c3\.js is in the build but no page loads it with its integrity/);
  refused(planted(swap("</title>", `</title><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval'">`)), /index\.html: a CSP meta tag/);
  refused(planted(swap(SCRIPT_TAG, "")), /index\.html loads no script/);
  refused(planted((d) => void writeFileSync(join(d, "404.html"), '<script src="/assets/index-a1.js"></script>')), /404\.html: script \/assets\/index-a1\.js has no integrity/);
  assert.deepEqual(planted((d) => void writeFileSync(join(d, "404.html"), "<!doctype html><p>Not found</p>")), []);
});

test("deploy.mjs refuses a build whose script bytes differ from their integrity: nothing is uploaded", async () => {
  const { deploy } = await import("./deploy.mjs");
  const dir = mkdtempSync(join(tmpdir(), "deploy-sri-"));
  cpSync(BUILD, dir, { recursive: true });
  writeFileSync(join(dir, "assets/index-a1.js"), `${JS};`);
  const s = steps({ from: dir });
  const r = deploy([], ENV, s.run, s.make);
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /REFUSED index\.html: script \/assets\/index-a1\.js: integrity [\s\S]*nothing was uploaded/);
  assert.equal(s.uploads().length, 0);
});
