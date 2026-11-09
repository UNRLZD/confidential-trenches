// node --test packages/signpage/scripts/deploy.test.mjs: the deploy refuses a build whose headers break SIGN_HOST's
// policy before anything is uploaded, and uploads the real build with wrangler at its pinned version. The build carries
// the prover (card signpage-prover-host): the worker under its own CSP too (W:880) and the six pinned setup files at
// /assets/zk/<sha256>.<ext>; a changed, missing or extra setup file, a stale worker or a worker rule with another
// policy is refused.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { BRANCH, LIVE_CHECKS, PROJECT, WRANGLER, build, checkDir, checkHeadersFile, checkPins, deploy, liveRuns, servedSources } from "./deploy.mjs";
import { makeList } from "./release-list.mjs";
import { bundle } from "./build-app.mjs";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";
import { signBuilt } from "../../../scripts/signpage-built.mjs";

const PKG = signBuilt(); // the page's build, made from this tree's sources first (card signpage-generated-merge-free)
const REAL = readFileSync(join(PKG, "public", "_headers"), "utf8");
const ENV = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };

// a copy of the package whose _headers is `headers`, plus extra files
function pkgWith(headers, extra = {}) {
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-test-"));
  cpSync(join(PKG, "index.html"), join(d, "index.html"));
  mkdirSync(join(d, "public"));
  writeFileSync(join(d, "public", "_headers"), headers);
  for (const [f, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(d, "public", f)), { recursive: true });
    writeFileSync(join(d, "public", f), body);
  }
  return d;
}

// a spawnSync stand-in that records every call: git answers HEAD `head` and the tree's status `status`; git ls-remote on
// the repository answers main's head `main` (HEAD's by default; a list is one head per read, the last kept), with exit
// `lsRemote`; gh answers main's ci.yml push runs `runs` (one passed run of HEAD by default). `uploads` are the calls that
// would send bytes (the reads any run may make)
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const passed = (sha = HEAD, id = 1) => ({ headSha: sha, status: "completed", conclusion: "success", databaseId: id });
// The clean checkout a deploy builds in (review P2-1) is made for real: git worktree add and remove, and its install
// (--prefer-offline, about 1 s from the store), run as asked; the install in the repository (--build's) is answered.
function recorder({ head = HEAD, status = "", install = 0, lsRemote = 0, main = head, runs = [passed(head)] } = {}) {
  const calls = [];
  const heads = [main].flat();
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "pnpm" && args[0] === "install" && install) return { status: install, stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"\n" };
    if (cmd === "pnpm" && args[0] === "install") return args.includes("--prefer-offline") ? spawnSync(cmd, args, { ...opts, env: { ...process.env, ...opts?.env }, encoding: "utf8" }) : { status: 0, stdout: "", stderr: "" };
    if (cmd === "git" && args[0] === "-C" && args[2] === "worktree") return spawnSync(cmd, args, { ...opts, encoding: "utf8" });
    if (cmd === "gh") return { status: 0, stdout: JSON.stringify(runs) };
    if (cmd !== "git") return { status: 0, stdout: "" };
    if (args[0] === "ls-remote") {
      const m = heads.length > 1 ? heads.shift() : heads[0];
      return { status: lsRemote, stdout: lsRemote || !m ? "" : `${m}\trefs/heads/main\n` };
    }
    if (args.includes("rev-parse")) return { status: 0, stdout: head ? `${head}\n` : "" };
    return { status: 0, stdout: status };
  };
  return { calls, run, uploads: () => calls.filter((c) => c.cmd === "pnpm" && c.args[0] === "dlx"), installs: () => calls.filter((c) => c.cmd === "pnpm" && c.args[0] === "install") };
}
// a package folder that is not there: build() throws on it, so a deploy that returns on it never built
const NO_PKG = join(tmpdir(), "ct-signpage-test-no-such-package");

// card signpage-release-at-deploy: a deploy uploads only a build the newest committed release names. The tests that
// reach the upload deploy this tree's build against a releases folder whose one list names that build, so they hold on a
// card branch that changes SIGN_HOST and cuts no release (the release is cut on main, right before the sign deploy)
/** A releases folder whose one list, release-1, names `pkg`'s SIGN_HOST build and the tree `tree` (HEAD's: the list cut
 *  from HEAD's inputs, review P1), and its ledger: { dir, ledger }. */
const HEAD_TREE = spawnSync("git", ["-C", PKG, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).stdout.trim();
function releasedAs(pkg = PKG, tree = HEAD_TREE) {
  const built = build(pkg);
  try {
    const dir = mkdtempSync(join(tmpdir(), "ct-signpage-released-"));
    const text = `${JSON.stringify({ ...makeList("release-1", { SIGN_HOST: built }, null), tree }, null, 1)}\n`;
    writeFileSync(join(dir, "release-1.json"), text);
    return { dir, ledger: { "release-1": createHash("sha256").update(text).digest("hex") } };
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
}
let releasedTree;
const RELEASED_TREE = () => (releasedTree ??= releasedAs());
after(() => releasedTree && rmSync(releasedTree.dir, { recursive: true, force: true }));
/** A copy of the package's served sources (index.html and public/), the folder build() reads, to plant in. */
function pkgCopy() {
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-test-"));
  cpSync(join(PKG, "index.html"), join(d, "index.html"));
  cpSync(join(PKG, "public"), join(d, "public"), { recursive: true });
  return d;
}

const WORKER_RULE = "/prover-worker.js\n  Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'\n";
const THREAD_RULE = "/prover-thread.js\n  Content-Security-Policy: default-src 'none'; script-src 'wasm-unsafe-eval'\n";
const ZK_RULE = "/assets/zk/*\n  Cache-Control: public, max-age=31536000, immutable\n";

const swap = (from, to) => {
  assert.ok(REAL.includes(from), from);
  return REAL.replace(from, to);
};

test("the real _headers passes the gate", () => {
  assert.deepEqual(checkHeadersFile(REAL), []);
});

test("a CSP with no frame-ancestors is refused, and nothing is uploaded", async () => {
  const { uploads, run } = recorder();
  const r = await deploy([], ENV, run, pkgWith(swap(" frame-ancestors 'none';", "")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`REFUSED _headers: CSP frame-ancestors: none, want "'none'"`), r.err.join("\n"));
  assert.ok(r.err.includes("REFUSED _headers: framed from https://ct-app.unrealized.trade: allowed (no frame-ancestors)"), r.err.join("\n"));
  assert.ok(r.err.includes("REFUSED _headers: framed from https://example.com: allowed (no frame-ancestors)"), r.err.join("\n"));
  assert.equal(r.err.at(-1), "nothing was uploaded");
  assert.equal(uploads().length, 0);
});

test("other policy breaks are refused", () => {
  const bad = {
    "frame-ancestors *": swap("frame-ancestors 'none'", "frame-ancestors *"),
    "frame-ancestors APP_HOST (the framed page's policy)": swap("frame-ancestors 'none'", "frame-ancestors https://ct-app.unrealized.trade"),
    "frame-src gone": swap(" frame-src https://ct-app.unrealized.trade;", ""),
    "frame-src *": swap("frame-src https://ct-app.unrealized.trade", "frame-src *"),
    "frame-src a second host": swap("frame-src https://ct-app.unrealized.trade", "frame-src https://ct-app.unrealized.trade https://example.com"),
    "Origin-Agent-Cluster gone": swap("  Origin-Agent-Cluster: ?1\n", ""),
    "X-Frame-Options sent": `${REAL}  X-Frame-Options: DENY\n`,
    "Integrity-Policy gone": swap("  Integrity-Policy: blocked-destinations=(script)\n", ""),
    "a second CSP line": `${REAL}  Content-Security-Policy: default-src *\n`,
    "another rule removes the CSP": `${REAL}/x\n  ! Content-Security-Policy\n`,
    "another rule sets the CSP": `${REAL}/x\n  Content-Security-Policy: default-src *\n`,
    "no /* rule": REAL.replace("/*\n", "/index.html\n"),
    "font-src *": swap("; font-src 'self';", "; font-src *;"),
    "font-src gone": swap(" font-src 'self';", ""),
    "unsafe-inline": swap("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'"),
    "a connect-src host added": swap("https://near.drpc.org", "https://near.drpc.org https://evil.ct.test"),
    "no worker rule": swap(WORKER_RULE, ""),
    "the worker rule twice": `${REAL}${WORKER_RULE}`,
    "the worker's CSP without default-src": swap(WORKER_RULE, WORKER_RULE.replace("default-src 'none'; ", "")),
    "the worker's CSP with a remote connect-src": swap(WORKER_RULE, WORKER_RULE.replace("connect-src 'self'", "connect-src 'self' https://evil.ct.test")),
    "the worker's CSP with 'unsafe-eval'": swap(WORKER_RULE, WORKER_RULE.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'")),
    "the worker's CSP on another path": swap(WORKER_RULE, WORKER_RULE.replace("/prover-worker.js", "/*.js")),
    "the worker's CSP also on another path": `${REAL}${WORKER_RULE.replace("/prover-worker.js", "/app.js")}`,
    "the worker rule sets a second header": swap(WORKER_RULE, `${WORKER_RULE}  Cross-Origin-Resource-Policy: cross-origin\n`),
    "the worker rule removes the site's CSP": swap(WORKER_RULE, `${WORKER_RULE}  ! Content-Security-Policy\n`),
    // the thread file's rule (card signpage-prover-threads): exactly its own CSP, on that one path
    "no thread rule": swap(THREAD_RULE, ""),
    "the thread rule twice": `${REAL}${THREAD_RULE}`,
    "the thread's CSP without default-src": swap(THREAD_RULE, THREAD_RULE.replace("default-src 'none'; ", "")),
    "the thread's CSP with 'unsafe-eval'": swap(THREAD_RULE, THREAD_RULE.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'")),
    "the thread's CSP with worker-src data: blob:": swap(THREAD_RULE, THREAD_RULE.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval'; worker-src data: blob:")),
    "the thread's CSP loads scripts": swap(THREAD_RULE, THREAD_RULE.replace("script-src 'wasm-unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval'")),
    "the thread's CSP on another path": swap(THREAD_RULE, THREAD_RULE.replace("/prover-thread.js", "/prover-*.js")),
    "the thread rule sets a second header": swap(THREAD_RULE, `${THREAD_RULE}  Cross-Origin-Embedder-Policy: require-corp\n`),
    "the thread rule removes the site's CSP": swap(THREAD_RULE, `${THREAD_RULE}  ! Content-Security-Policy\n`),
    // the site's worker-src loosened to fit a library's thread workers
    "worker-src data:": swap("worker-src 'self';", "worker-src 'self' data:;"),
    "worker-src blob:": swap("worker-src 'self';", "worker-src 'self' blob:;"),
    "script-src 'unsafe-eval'": swap("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'"),
    "COEP added": swap("  Cross-Origin-Opener-Policy:", "  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Opener-Policy:"),
    // the review's plants (signpage-prover-host round 2): every rule, header and removal off the allow-list
    "/ sends Refresh to another site": `${REAL}/\n  Refresh: 0; url=https://evil.example/\n`,
    "/index.html sends Refresh": `${REAL}/index.html\n  Refresh: 0; url=https://evil.example/\n`,
    "/ sets a cookie": `${REAL}/\n  Set-Cookie: a=b; Secure\n`,
    "/ adds Integrity-Policy-Report-Only": `${REAL}/\n  Integrity-Policy-Report-Only: blocked-destinations=(script)\n`,
    "/* adds Service-Worker-Allowed": swap("  Integrity-Policy:", "  Service-Worker-Allowed: /\n  Integrity-Policy:"),
    "/* adds a Cache-Control, joined onto /assets/zk/*'s": swap("  Integrity-Policy:", "  Cache-Control: no-store\n  Integrity-Policy:"),
    "/assets/zk/* allows every origin": `${REAL.trimEnd()}\n  Access-Control-Allow-Origin: *\n`,
    "/prover-* serves the worker as HTML": `${REAL}/prover-*\n  Content-Type: text/html\n`,
    "/assets/zk/* without its Cache-Control": swap(ZK_RULE, ""),
    "/assets/zk/* no-store": swap(ZK_RULE, ZK_RULE.replace("public, max-age=31536000, immutable", "no-store")),
    "/assets/zk/* a second max-age": swap(ZK_RULE, ZK_RULE.replace("immutable", "immutable, max-age=0")),
    "/assets/zk/* twice": `${REAL}${ZK_RULE}`,
    // Pages trims only a value's ends, and the live check reads the value exactly: inner spaces would deploy, then fail it
    "/assets/zk/* with inner double spaces": swap(ZK_RULE, ZK_RULE.replace("public, max-age", "public,  max-age")),
    "/assets/zk/* sets its Cache-Control twice": swap(ZK_RULE, `${ZK_RULE}  Cache-Control: public, max-age=31536000, immutable\n`),
    "/assets/zk/* removes a header": swap(ZK_RULE, `${ZK_RULE}  ! X-Content-Type-Options\n`),
  };
  for (const [name, text] of Object.entries(bad)) assert.notDeepEqual(checkHeadersFile(text), [], name);
});

test("a build carrying any Pages config file but _headers, or .well-known/webauthn, is refused", async () => {
  const { uploads, run } = recorder();
  // review F8: a _redirects rewrite of /.well-known/webauthn to a JSON file would hand SIGN_HOST's passkeys to the
  // origins it lists; _routes.json and functions/ are Pages' other config, never part of the signing page
  const planted = {
    "_worker.js": "x",
    ".well-known/webauthn": "x",
    "_redirects": "/.well-known/webauthn /ror.json 200\n",
    "_routes.json": "{}",
    "functions/x.js": "export const onRequest = () => new Response('x');\n",
  };
  for (const [f, body] of Object.entries(planted)) {
    const r = await deploy([], ENV, run, pkgWith(REAL, { [f]: body }));
    assert.equal(r.code, 1, f);
    assert.ok(r.err.some((e) => e.includes(`carries ${f.startsWith("functions/") ? "functions" : f}`)), r.err.join("\n"));
  }
  assert.equal(uploads().length, 0);
});

test("--build and --dry-run stop after the gate and keep the build, whose _headers is the package's; --build reads nothing of main", async () => {
  const b = recorder({ main: OTHER, runs: [] });
  const built = await deploy(["--build"], {}, b.run);
  assert.equal(built.code, 0, (built.err ?? []).join("\n"));
  rmSync(/gate ok on (\S+);/.exec(built.out[0])[1], { recursive: true, force: true });
  assert.deepEqual(b.calls.map((c) => `${c.cmd} ${c.args[0]}`), ["pnpm install"], "--build makes no git or gh read: the install here only");
  const { uploads, run } = recorder();
  const r = await deploy(["--dry-run"], {}, run, undefined, {}, RELEASED_TREE());
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  assert.match(r.out[0], /a deploy would go ahead$/);
  const dir = /gate ok on (\S+);/.exec(r.out[0])[1];
  try {
    assert.deepEqual(checkDir(dir), []);
    assert.equal(readFileSync(join(dir, "_headers"), "utf8"), REAL);
    assert.equal(uploads().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with the gate passed and no token, nothing is uploaded", async () => {
  const { uploads, run } = recorder();
  const r = await deploy([], {}, run, undefined, {}, RELEASED_TREE());
  assert.equal(r.code, 2);
  assert.match(r.err[0], /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID not set/);
  assert.equal(uploads().length, 0);
});

// card signpage-generated-merge-free: the deploy builds index.html and app.js at HEAD from the sources, never from a
// committed or local copy, and the newest release list still pins their bytes: a list that names another bundle (here
// the same page with one unrelated copy change, its integrity re-pinned as build-app.mjs writes it) refuses the deploy
test("the build's four output files are built at the deploy from the sources: a local build in the package is never copied", async () => {
  const served = servedSources(PKG);
  assert.deepEqual(served.filter((f) => ["index.html", "public/app.js", "public/prover-worker.js", "public/prover-thread.js"].includes(f)), []);
  const fresh = await bundle();
  const dir = build();
  try {
    assert.ok(readFileSync(join(dir, "app.js")).equals(fresh.js));
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), fresh.html);
    assert.ok(readFileSync(join(dir, "prover-worker.js")).equals(fresh.worker));
    assert.ok(readFileSync(join(dir, "prover-thread.js")).equals(fresh.thread));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: a deploy whose fresh build of the sources the newest release list does not name is refused, nothing uploaded", async () => {
  const other = mkdtempSync(join(tmpdir(), "ct-signpage-test-"));
  const js = `${readFileSync(join(PKG, "public", "app.js"), "utf8")}\n/* another build */\n`;
  cpSync(join(PKG, "public"), join(other, "public"), { recursive: true });
  writeFileSync(join(other, "public", "app.js"), js);
  const sri = `sha384-${createHash("sha384").update(js).digest("base64")}`;
  writeFileSync(join(other, "index.html"), readFileSync(join(PKG, "index.html"), "utf8").replace(/integrity="[^"]+"/, `integrity="${sri}"`));
  const stale = releasedAs(other);
  try {
    for (const [argv, env, code] of [[["--dry-run"], {}, 1], [[], ENV, 1]]) {
      const rec = recorder();
      const r = await deploy(argv, env, rec.run, undefined, signHost(rec).net, stale);
      assert.equal(r.code, code, `${argv}: ${(r.err ?? []).join("\n")}`);
      assert.ok(r.err.some((l) => l.includes("is not this SIGN_HOST build") && l.includes("/app.js")), `${argv}: ${r.err.join("\n")}`);
      assert.equal(rec.uploads().length, 0, `${argv}`);
    }
    // and the list of this tree's own fresh build lets the same deploy through
    const rec = recorder();
    assert.equal((await deploy(["--dry-run"], {}, rec.run, undefined, {}, RELEASED_TREE())).code, 0);
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(stale.dir, { recursive: true, force: true });
  }
});

test("the upload is wrangler pages deploy at its pinned version, to the sign project on main, from an empty folder, named by HEAD", async () => {
  const rec = recorder();
  const { uploads, run } = rec;
  const r = await deploy([], ENV, run, undefined, signHost(rec).net, RELEASED_TREE());
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  const up = uploads().find((c) => c.cmd === "pnpm");
  assert.deepEqual(up.args.slice(9), ["--commit-hash", HEAD, "--commit-dirty=false"]);
  assert.deepEqual(up.args.slice(0, 4), ["dlx", WRANGLER, "pages", "deploy"]);
  assert.equal(WRANGLER, "wrangler@4.151.1");
  assert.deepEqual(up.args.slice(5, 9), ["--project-name", PROJECT, "--branch", BRANCH]);
  assert.equal(PROJECT, "confidential-trenches-sign");
  assert.notEqual(up.opts.cwd, up.args[4]);
  assert.equal(up.opts.env.WRANGLER_SEND_METRICS, "false");
});

test("an uncommitted tree or no HEAD is refused before the token: the upload is named by HEAD's commit, so it must be HEAD's build", async () => {
  const dirty = recorder({ status: " M packages/kit/src/prover/worker.js" });
  const r = await deploy([], {}, dirty.run, NO_PKG);
  assert.equal(r.code, 1, (r.out ?? []).join("\n"));
  assert.match(r.err.join("\n"), /REFUSED the tree has uncommitted changes[\s\S]*packages\/kit\/src\/prover\/worker\.js[\s\S]*nothing was uploaded/);
  assert.deepEqual([dirty.installs().length, dirty.uploads().length], [0, 0], "refused before the install and the build");
  const headless = recorder({ head: "" });
  const r2 = await deploy([], ENV, headless.run);
  assert.equal(r2.code, 1);
  assert.match(r2.err.join("\n"), /REFUSED no HEAD commit/);
  assert.equal(headless.uploads().length, 0);
  // --dry-run still builds and gates a work in progress, and exits 1 with what a deploy would refuse
  const dry = recorder({ status: " M packages/signpage/src/main.ts" });
  const d = await deploy(["--dry-run"], {}, dry.run, undefined, {}, RELEASED_TREE());
  assert.equal(d.code, 1, (d.out ?? []).join("\n"));
  rmSync(/gate ok on (\S+?);/.exec(d.out[0])[1], { recursive: true, force: true });
  assert.match(d.out[0], /a deploy would refuse it:$/);
  assert.match(d.err.join("\n"), /^REFUSED the tree has uncommitted changes/m);
});

test("the deploy installs HEAD's lockfile (pnpm install --frozen-lockfile) in a clean checkout of HEAD after the tree reads, builds there, and removes it", async () => {
  const { calls, run, installs } = recorder();
  // the build of a missing package throws: the install was already asked for, after the tree and main reads
  await assert.rejects(deploy([], ENV, run, NO_PKG), /ENOENT|No such file/);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args.at(c.cmd === "git" ? (c.args[0] === "-C" ? 2 : 0) : 0)].join(" ")), ["git rev-parse", "git status", "git ls-remote", "gh run", "git worktree", "pnpm install", "git worktree"]);
  const [add, , remove] = calls.slice(4);
  assert.deepEqual(add.args.slice(2), ["worktree", "add", "--detach", installs()[0].opts.cwd, "HEAD"]);
  assert.deepEqual(remove.args.slice(2), ["worktree", "remove", installs()[0].opts.cwd], "removed, never --force");
  assert.deepEqual(installs()[0].args, ["install", "--frozen-lockfile", "--prefer-offline"]);
  assert.notEqual(installs()[0].opts.cwd, dirname(dirname(PKG)), "never this checkout's node_modules");
  assert.equal(existsSync(installs()[0].opts.cwd), false, "the clean checkout is gone");
  const dry = recorder();
  await assert.rejects(deploy(["--dry-run"], {}, dry.run, NO_PKG), /ENOENT|No such file/);
  assert.equal(dry.installs().length, 1, "--dry-run builds what a deploy would, so it installs too");
});

// review P2-1: pnpm store status is no lockfile check. An extra file in a dependency (poseidon-lite's constants/<n>.mjs,
// which the bundler resolves before <n>.js) and a re-pointed symlink (packages/kit's and packages/wallet's poseidon-lite)
// each change a local build's app.js and pass it. The deploy builds in a clean checkout of HEAD: its bytes are the clean
// install's (PKG, built by signBuilt from CI's fresh install), whatever this checkout's node_modules hold
test("planted: an extra file in a dependency or a re-pointed symlink passes pnpm store status and changes a local build; the deploy's build is the clean one", async () => {
  const repo = dirname(dirname(PKG));
  const clean = readFileSync(join(PKG, "public", "app.js"));
  const a = mkdtempSync(join(tmpdir(), "ct-signpage-test-planted-"));
  const sh = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stdout}${r.stderr}`);
    return r;
  };
  sh("git", ["-C", repo, "worktree", "add", "--detach", a, "HEAD"]);
  const copy = mkdtempSync(join(tmpdir(), "ct-signpage-test-pl-"));
  try {
    sh("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], a);
    const store = join(a, "node_modules", ".pnpm");
    const pl = join(store, readdirSync(store).find((f) => f.startsWith("poseidon-lite@")), "node_modules", "poseidon-lite");
    const constants = readdirSync(join(pl, "constants")).filter((f) => /^\d+\.js$/.test(f));
    // a copy, never an edit in place: the installed files are hard links into pnpm's store
    cpSync(pl, copy, { recursive: true });
    writeFileSync(join(copy, "constants", "2.js"), readFileSync(join(copy, "constants", "2.js"), "utf8").replace(/'[A-Za-z0-9+/]{4}/, "'AAAA"));
    const links = ["kit", "wallet"].map((p) => join(a, "packages", p, "node_modules", "poseidon-lite"));
    const plants = {
      "an extra file in a dependency": {
        on: () => constants.forEach((f) => writeFileSync(join(pl, "constants", f.replace(/\.js$/, ".mjs")), 'export default { C: ["planted"], M: [["planted"]] };\n')),
        off: () => constants.forEach((f) => unlinkSync(join(pl, "constants", f.replace(/\.js$/, ".mjs")))),
      },
      "a re-pointed symlink": {
        on: () => links.forEach((l) => { unlinkSync(l); symlinkSync(copy, l); }),
        off: () => links.forEach((l) => { unlinkSync(l); symlinkSync(join("..", "..", "..", "node_modules", ".pnpm", pl.slice(store.length + 1)), l); }),
      },
    };
    const { deploy: deployAt } = await import(pathToFileURL(join(a, "packages", "signpage", "scripts", "deploy.mjs")).href);
    for (const [name, plant] of Object.entries(plants)) {
      plant.on();
      try {
        sh("pnpm", ["store", "status"], a); // the old check passes it
        const local = mkdtempSync(join(tmpdir(), "ct-signpage-test-local-"));
        sh(process.execPath, [join(a, "packages", "signpage", "scripts", "build-app.mjs"), "--out", local], a);
        const changed = !readFileSync(join(local, "app.js")).equals(clean);
        rmSync(local, { recursive: true, force: true });
        assert.ok(changed, `${name}: the plant changes a local build's app.js`);
        const rec = recorder();
        const r = await deployAt(["--dry-run"], {}, rec.run, undefined, {});
        const dir = /gate ok on (\S+);/.exec(r.out?.[0] ?? "")?.[1];
        assert.ok(dir, `${name}: ${(r.err ?? []).join("\n")}`);
        try {
          assert.ok(readFileSync(join(dir, "app.js")).equals(clean), `${name}: the deploy's app.js is the clean build's`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        assert.equal(rec.uploads().length, 0);
      } finally {
        plant.off();
      }
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
    if (spawnSync("git", ["-C", repo, "worktree", "remove", a]).status !== 0) {
      rmSync(a, { recursive: true, force: true });
      spawnSync("git", ["-C", repo, "worktree", "prune"]);
    }
  }
});

// review P1: the deploy is held to the list's tree, not only its bytes: a list naming this very build, cut from other
// SIGN_HOST build inputs (here the empty tree's), is refused, since no clean build of HEAD was ever compared to it
test("planted: a newest list naming this build's bytes but cut from other inputs than HEAD's refuses the deploy and --dry-run", async () => {
  const other = releasedAs(PKG, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  try {
    for (const [argv, env] of [[["--dry-run"], {}], [[], ENV]]) {
      const rec = recorder();
      const r = await deploy(argv, env, rec.run, undefined, signHost(rec).net, other);
      assert.equal(r.code, 1, `${argv}: ${(r.out ?? []).join("\n")}`);
      assert.ok(!r.err.some((l) => l.includes("is not this SIGN_HOST build")), `${argv}: the bytes are the list's`);
      assert.ok(r.err.some((l) => /^REFUSED release-1 was cut from other SIGN_HOST build inputs than HEAD's \(.+\), so no clean build of HEAD was compared to it: cut release-2/.test(l)), `${argv}: ${r.err.join("\n")}`);
      assert.equal(rec.uploads().length, 0);
      const kept = /gate ok on (\S+);/.exec(r.out?.[0] ?? "")?.[1];
      if (kept) rmSync(kept, { recursive: true, force: true });
    }
  } finally {
    rmSync(other.dir, { recursive: true, force: true });
  }
});

test("a failed install refuses before a token is read: no build, no upload", async () => {
  for (const argv of [[], ["--dry-run"]]) {
    const { run, uploads } = recorder({ install: 1 });
    const r = await deploy(argv, {}, run, NO_PKG);
    assert.equal(r.code, 1, (r.out ?? []).join("\n"));
    assert.match(r.err.join("\n"), /REFUSED the install failed \(pnpm exit 1\): ERR_PNPM_OUTDATED_LOCKFILE[\s\S]*nothing was uploaded/);
    assert.equal(uploads().length, 0);
  }
});

test("an unknown argument is a usage error", async () => {
  assert.equal((await deploy(["dist"], ENV, recorder().run)).code, 2);
});

test("a deploy's live runs name every live check that reads SIGN_HOST, and its success line is the command that runs them on GitHub's runners", async () => {
  const rec = recorder();
  const r = await deploy([], ENV, rec.run, undefined, signHost(rec).net, RELEASED_TREE());
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  assert.ok(r.out.some((l) => /^next: gh workflow run live\.yml -f host=sign -f commit=\S+$/.test(l)), r.out.join("\n"));
  assert.ok(r.out.includes("then: gh run watch --exit-status"), r.out.join("\n"));
  const out = LIVE_CHECKS.flatMap((k) => liveRuns(k)).join("\n");
  // every signpage-* live check is named, and every named check exists and holds SIGN_HOST's own name
  const dir = join(PKG, "..", "..", "scripts", "live-checks");
  const own = readdirSync(dir).filter((f) => /^signpage-[\w-]+\.mjs$/.test(f) && !f.endsWith(".test.mjs")).map((f) => f.replace(/\.mjs$/, ""));
  assert.ok(own.length >= 3, own.join(" "));
  for (const k of own) assert.ok(LIVE_CHECKS.includes(k), `LIVE_CHECKS does not name ${k}`);
  for (const k of LIVE_CHECKS) assert.match(readFileSync(join(dir, `${k}.mjs`), "utf8"), /confidential\.unrealized\.trade/, `${k} does not read SIGN_HOST`);
  for (const k of LIVE_CHECKS) assert.ok(out.includes(`scripts/live-checks/${k}.mjs`), `the success line does not name ${k}: ${out}`);
  // the release check reads SIGN_HOST alone, against this commit's build
  assert.ok(out.includes("scripts/live-checks/signpage-release.mjs --host sign"), `the success line does not run signpage-release on SIGN_HOST alone: ${out}`);
  assert.ok(out.includes("scripts/live-checks/page-evm-rpc-csp.mjs --host sign"), `the success line does not run page-evm-rpc-csp on SIGN_HOST alone: ${out}`);
});

const zkPath = (name) => `assets/zk/${ZK_SETUP_FILES[name].sha256}.${name.split(".").pop()}`;

test("the build holds the prover: the worker, the six setup files at /assets/zk/<sha256>.<ext> and the licences", () => {
  const dir = build();
  try {
    assert.deepEqual(checkDir(dir), []);
    assert.deepEqual(readdirSync(join(dir, "assets", "zk")).sort(), Object.keys(ZK_SETUP_FILES).map((n) => zkPath(n).slice("assets/zk/".length)).sort());
    for (const n of Object.keys(ZK_SETUP_FILES)) assert.ok(readFileSync(join(dir, zkPath(n))).equals(readFileSync(join(PKG, "..", "kit", "zk", n))), n);
    assert.ok(readFileSync(join(dir, "prover-worker.js")).equals(readFileSync(join(PKG, "public", "prover-worker.js"))));
    assert.ok(readFileSync(join(dir, "prover-thread.js")).equals(readFileSync(join(PKG, "public", "prover-thread.js"))));
    assert.ok(readFileSync(join(dir, "licenses", "GPL-3.0.txt")).equals(readFileSync(join(PKG, "..", "kit", "zk", "LICENSE-GPL-3.0.txt"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a build whose setup files or worker are not the pinned ones is refused", () => {
  const plants = {
    "a setup file with one byte changed": (d) => {
      const f = join(d, zkPath("withdraw.wasm"));
      const b = readFileSync(f);
      b[100] ^= 1;
      writeFileSync(f, b);
      return /assets\/zk\/36cda227[0-9a-f]+\.wasm: sha256 [0-9a-f]{64}, pinned 36cda227/;
    },
    "a setup file missing": (d) => (rmSync(join(d, zkPath("commitment.zkey"))), /assets\/zk\/494ae92d[0-9a-f]+\.zkey: missing/),
    "a setup file under another name": (d) => (writeFileSync(join(d, "assets", "zk", `${"0".repeat(64)}.zkey`), "x"), /assets\/zk\/0{64}\.zkey: not a pinned setup file/),
    "the worker changed": (d) => (writeFileSync(join(d, "prover-worker.js"), "postMessage(1)"), /prover-worker\.js is not the kit's prover worker build/),
    "the worker missing": (d) => (rmSync(join(d, "prover-worker.js")), /prover-worker\.js is not the kit's prover worker build/),
    "the thread file changed": (d) => (writeFileSync(join(d, "prover-thread.js"), "postMessage(1)"), /prover-thread\.js is not the kit's prover thread build/),
    "the thread file missing": (d) => (rmSync(join(d, "prover-thread.js")), /prover-thread\.js is not the kit's prover thread build/),
    "the GPL text missing": (d) => (rmSync(join(d, "licenses", "GPL-3.0.txt")), /licenses\/GPL-3\.0\.txt: missing/),
  };
  for (const [name, plant] of Object.entries(plants)) {
    const dir = build();
    try {
      const want = plant(dir);
      const p = checkDir(dir);
      assert.ok(p.some((l) => want.test(l)), `${name}: ${p.join(" | ")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// card pages-deploy-readback: a stand-in for SIGN_HOST that serves the folder wrangler was handed (what a deploy that
// landed serves), with `old` answering some paths with other bytes (what a deploy that did not land serves); every
// read is kept. The sleep between tries is a stand-in too, so the test does not wait the minute.
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
function signHost(rec, old = {}) {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url, init });
    const u = new URL(url);
    const dir = rec.uploads().at(-1).args[4];
    const body = old[u.pathname] ?? readFileSync(join(dir, u.pathname === "/" ? "index.html" : u.pathname.slice(1)));
    return new Response(body, { status: 200 });
  };
  const slept = [];
  return { asked, slept, net: { fetch, sleep: async (ms) => void slept.push(ms) } };
}

test("a deploy wrangler calls done while SIGN_HOST still serves the old bundle exits 1 with both hashes, and prints no next: line", async () => {
  const rec = recorder();
  const OLD = "console.log('release-57')\n";
  const h = signHost(rec, { "/app.js": OLD });
  const r = await deploy([], ENV, rec.run, undefined, h.net, RELEASED_TREE());
  assert.equal(r.code, 1, (r.out ?? []).join("\n"));
  const said = [...(r.out ?? []), ...(r.err ?? [])].join("\n");
  assert.doesNotMatch(said, /next:/);
  assert.match(said, new RegExp(`/app\\.js[^\\n]*${sha256(OLD)}[^\\n]*${sha256(readFileSync(join(PKG, "public", "app.js")))}`));
  // a few tries over about a minute, each a fresh cache-buster, all on SIGN_HOST's own address
  const tries = h.asked.filter((a) => new URL(a.url).pathname === "/app.js");
  assert.ok(tries.length >= 3, `${tries.length} tries`);
  assert.equal(new Set(tries.map((a) => new URL(a.url).search)).size, tries.length, "each try its own cache-buster");
  for (const a of h.asked) assert.equal(new URL(a.url).origin, "https://confidential.unrealized.trade");
  const waited = h.slept.reduce((a, b) => a + b, 0);
  assert.ok(waited >= 45_000 && waited <= 90_000, `${waited} ms`);
});

test("a deploy whose SIGN_HOST serves exactly the build it uploaded (/ and /app.js) prints next:", async () => {
  const rec = recorder();
  const h = signHost(rec);
  const r = await deploy([], ENV, rec.run, undefined, h.net, RELEASED_TREE());
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  assert.ok(r.out.some((l) => l === `next: gh workflow run live.yml -f host=sign -f commit=${HEAD}`), r.out.join("\n"));
  assert.deepEqual([...new Set(h.asked.map((a) => new URL(a.url).pathname))].sort(), ["/", "/app.js"]);
  assert.ok(h.asked.every((a) => new URL(a.url).search), "every read carries a cache-buster");
});

test("a SIGN_HOST that cannot be read, or answers other than 200, is never taken as done", async () => {
  for (const fail of [async () => { throw new TypeError("fetch failed"); }, async () => new Response("gone", { status: 404 })]) {
    const rec = recorder();
    const r = await deploy([], ENV, rec.run, undefined, { fetch: fail, sleep: async () => {} }, RELEASED_TREE());
    assert.equal(r.code, 1, (r.out ?? []).join("\n"));
    assert.doesNotMatch([...(r.out ?? []), ...(r.err ?? [])].join("\n"), /next:/);
  }
});

// Card signpage-release-at-deploy: the "newest release is this build" rule moved here from every card branch's
// release.test, so a release is cut once per sign deploy, not once per card.
test("planted: a deploy of a build no committed release names is refused before its env check, nothing uploaded; --dry-run exits 1", async () => {
  const pkg = pkgCopy();
  const named = releasedAs(pkg);
  try {
    // the build the newest list names goes up (the stand-in SIGN_HOST serves what was uploaded)
    const ok = recorder();
    const good = await deploy([], ENV, ok.run, pkg, signHost(ok).net, named);
    assert.equal(good.code, 0, (good.err ?? []).join("\n"));
    assert.equal(ok.uploads().length, 1);
    // one file served that the newest list does not name: refused, against the planted lists and the committed ones
    writeFileSync(join(pkg, "public", "extra.txt"), "a page change with no release");
    for (const released of [named, {}]) {
      const rec = recorder();
      const r = await deploy([], ENV, rec.run, pkg, signHost(rec).net, released);
      assert.equal(r.code, 1, (r.out ?? []).join("\n"));
      assert.ok(r.err.some((l) => /^REFUSED release-\d+, the newest release, is not this SIGN_HOST build \(SIGN_HOST \/extra\.txt: built, not in the list\): cut release-\d+ on a branch from origin\/main's head/.test(l)), r.err.join("\n"));
      assert.equal(r.err.at(-1), "nothing was uploaded");
      assert.equal(rec.uploads().length, 0);
    }
    // so is a changed byte in a file the list names, and a list the ledger does not hold as written (even one naming the build)
    rmSync(join(pkg, "public", "extra.txt"));
    writeFileSync(join(pkg, "index.html"), `${readFileSync(join(pkg, "index.html"), "utf8")}\n`);
    const changed = recorder();
    const c = await deploy([], ENV, changed.run, pkg, signHost(changed).net, named);
    assert.ok(c.code === 1 && c.err.some((l) => l.startsWith("REFUSED release-1, the newest release, is not this SIGN_HOST build (SIGN_HOST /: the build's ")), (c.err ?? []).join("\n"));
    const edited = recorder();
    const e = await deploy([], ENV, edited.run, undefined, signHost(edited).net, { ...RELEASED_TREE(), ledger: { "release-1": "0".repeat(64) } });
    assert.ok(e.code === 1 && e.err.some((l) => l.startsWith("REFUSED release-1 was edited after it was written")), (e.err ?? []).join("\n"));
    assert.deepEqual([changed.uploads().length, edited.uploads().length], [0, 0]);
    // with no token in the environment it is refused all the same (code 1, not the env check's 2): the release check sits above it
    const bare = recorder();
    const n = await deploy([], {}, bare.run, pkg, signHost(bare).net, named);
    assert.equal(n.code, 1, (n.err ?? []).join("\n"));
    assert.ok(n.err.some((l) => l.startsWith("REFUSED release-1, the newest release, is not this SIGN_HOST build")), n.err.join("\n"));
    assert.ok(!n.err.some((l) => /CLOUDFLARE/.test(l)), n.err.join("\n"));
    // --dry-run builds it and exits 1 with what a deploy would refuse
    const dry = recorder();
    const d = await deploy(["--dry-run"], {}, dry.run, pkg, {}, named);
    assert.equal(d.code, 1, (d.out ?? []).join("\n"));
    rmSync(/gate ok on (\S+?);/.exec(d.out[0])[1], { recursive: true, force: true });
    assert.match(d.out[0], /a deploy would refuse it:$/);
    assert.ok(d.err.some((l) => l.startsWith("REFUSED release-1, the newest release, is not this SIGN_HOST build (SIGN_HOST /: ")), d.err.join("\n"));
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(named.dir, { recursive: true, force: true });
  }
});

// Card signpage-release-at-deploy, review P1 and delta P2-1: the deploy knows main as GitHub answers it, not this
// checkout's lists or its origin/main ref (a fork, a mirror or a refspec that maps no main can leave that ref stale)
test("planted: a deploy is refused unless HEAD is main's head on GitHub, read twice, with a passed ci.yml push run on main", async () => {
  const cases = {
    "a checkout behind main": [{ main: OTHER }, new RegExp(`^REFUSED HEAD ${HEAD} is not main's head ${OTHER} on https://github\\.com/UNRLZD/confidential-trenches: a sign deploy is main's head`)],
    "main's head with no push run": [{ runs: [passed(OTHER)] }, new RegExp(`^REFUSED HEAD ${HEAD} has no push run of ci\\.yml on main$`)],
    "a push run cancelled": [{ runs: [{ headSha: HEAD, status: "completed", conclusion: "cancelled", databaseId: 19876 }] }, new RegExp(`^REFUSED HEAD ${HEAD}'s push run of ci\\.yml on main \\(19876\\) ended cancelled: rerun it \\(gh run rerun 19876 -R UNRLZD/confidential-trenches\\)`)],
    "a push run still going": [{ runs: [{ headSha: HEAD, status: "in_progress", conclusion: "", databaseId: 7 }] }, /\(7\) is in_progress: wait for it to pass$/],
    "an ls-remote that fails": [{ lsRemote: 128 }, /^REFUSED git ls-remote https:\/\/github\.com\/UNRLZD\/confidential-trenches refs\/heads\/main failed \(exit 128\)/],
    "an ls-remote that names no main": [{ main: "" }, /refs\/heads\/main named no main: the deploy reads main's head from GitHub$/],
  };
  for (const [name, [opts, want]] of Object.entries(cases)) {
    const rec = recorder(opts);
    const r = await deploy([], ENV, rec.run, undefined, signHost(rec).net, RELEASED_TREE());
    assert.equal(r.code, 1, `${name}: ${(r.out ?? []).join("\n")}`);
    assert.ok(r.err.some((l) => want.test(l)), `${name}: ${r.err.join("\n")}`);
    assert.deepEqual([rec.installs().length, rec.uploads().length], [0, 0], `${name}: refused before the install, the build and the upload`);
    const dry = recorder(opts);
    const d = await deploy(["--dry-run"], {}, dry.run, undefined, {}, RELEASED_TREE());
    assert.equal(d.code, 1, `${name} --dry-run`);
    rmSync(/gate ok on (\S+?);/.exec(d.out[0])[1], { recursive: true, force: true });
    assert.ok(d.err.some((l) => want.test(l)), `${name} --dry-run: ${d.err.join("\n")}`);
  }
  // a merge that lands on main during the install and the build: the second read, right before the upload, refuses it
  const moved = recorder({ main: [HEAD, OTHER] });
  const m = await deploy([], ENV, moved.run, undefined, signHost(moved).net, RELEASED_TREE());
  assert.equal(m.code, 1, (m.out ?? []).join("\n"));
  assert.ok(m.err.some((l) => l.startsWith(`REFUSED HEAD ${HEAD} is not main's head ${OTHER}`)), m.err.join("\n"));
  assert.deepEqual([moved.installs().length, moved.uploads().length], [1, 0], "read again after the build, before the upload");
  // the reads it makes: main's head from the repository's URL (never origin/main), and main's ci.yml push runs
  const rec = recorder();
  assert.equal((await deploy([], ENV, rec.run, undefined, signHost(rec).net, RELEASED_TREE())).code, 0);
  assert.deepEqual(rec.calls.filter((c) => c.cmd === "git" && c.args[0] === "ls-remote").map((c) => c.args), [["ls-remote", "https://github.com/UNRLZD/confidential-trenches", "refs/heads/main"], ["ls-remote", "https://github.com/UNRLZD/confidential-trenches", "refs/heads/main"]]);
  assert.ok(!rec.calls.some((c) => c.args.includes("origin/main") || c.args.includes("fetch")), "no local origin/main ref is read");
  const gh = rec.calls.find((c) => c.cmd === "gh");
  assert.deepEqual(gh.args, ["run", "list", "-R", "UNRLZD/confidential-trenches", "--branch", "main", "--workflow", "ci.yml", "--event", "push", "-L", "200", "--json", "headSha,status,conclusion,databaseId"]);
});

// delta P3-3 and P3-4: a dry run that fails its install or its gate still names what a deploy refuses; a failed build is
// not kept; a tracked file missing from the tree fails the build, and an untracked one is refused, never left out
test("planted: a failed --dry-run keeps its refusals and no folder; a missing tracked file fails the build; an untracked one is refused", async () => {
  const inst = recorder({ install: 1, main: OTHER });
  const i = await deploy(["--dry-run"], {}, inst.run, NO_PKG, {}, RELEASED_TREE());
  assert.equal(i.code, 1);
  assert.ok(i.err[0].startsWith(`REFUSED HEAD ${HEAD} is not main's head ${OTHER}`) && i.err.some((l) => l.startsWith("REFUSED the install failed")), i.err.join("\n"));
  const bad = pkgWith(swap(" frame-ancestors 'none';", ""));
  const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("ct-signpage-") && !f.startsWith("ct-signpage-test-") && !f.startsWith("ct-signpage-released-")));
  try {
    for (const argv of [["--dry-run"], ["--build"]]) {
      const g = recorder({ main: OTHER });
      const r = await deploy(argv, {}, g.run, bad, {}, RELEASED_TREE());
      assert.equal(r.code, 1, argv[0]);
      assert.ok(r.err.some((l) => l.startsWith("REFUSED _headers: CSP frame-ancestors")), r.err.join("\n"));
      assert.equal(r.err.some((l) => l.startsWith(`REFUSED HEAD ${HEAD} is not main's head`)), argv[0] === "--dry-run", `${argv[0]}: ${r.err.join("\n")}`);
      assert.ok(!(r.out ?? []).some((l) => /gate ok on/.test(l)));
    }
    const left = readdirSync(tmpdir()).filter((f) => f.startsWith("ct-signpage-") && !f.startsWith("ct-signpage-test-") && !f.startsWith("ct-signpage-released-") && !before.has(f));
    assert.deepEqual(left, [], "a build that failed its gate was kept");
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  // a git checkout of the package: a tracked file deleted from the tree, then an untracked one
  const pkg = pkgCopy();
  const git = (...a) => execFileSync("git", ["-C", pkg, ...a], { encoding: "utf8" });
  try {
    git("init", "-q");
    git("add", "--", "index.html", "public");
    rmSync(join(pkg, "public", "prover-thread.js"));
    assert.throws(() => build(pkg), /ENOENT[\s\S]*prover-thread\.js/);
    git("checkout", "--", "public/prover-thread.js");
    writeFileSync(join(pkg, "public", "new-page.js"), "a file not yet added");
    assert.throws(() => build(pkg), /untracked files the build would leave out: public\/new-page\.js/);
    const u = recorder();
    const r = await deploy(["--build"], {}, u.run, pkg);
    assert.equal(r.code, 1);
    assert.match(r.err[0], /^REFUSED untracked files the build would leave out: public\/new-page\.js: git add them or remove them$/);
    assert.equal(u.installs().length, 0);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
  // git failing for any reason but "not a git repository" is never read as a test's plain copy
  assert.throws(() => servedSources(join(tmpdir(), "ct-signpage-test-no-such-package")), /git ls-files in .* failed/);
});

// review P2-2: a release build is the commit's tree, so a file git ignores in public/ is never served or listed
test("planted: an ignored file in public/ (.env.local) is not in the build; build() copies the tracked sources only", () => {
  // a git checkout of the package's sources, with the repository's ignore rule for .env.* and one ignored file planted
  const pkg = pkgCopy();
  const git = (...a) => execFileSync("git", ["-C", pkg, ...a], { encoding: "utf8" });
  let dir;
  try {
    git("init", "-q");
    writeFileSync(join(pkg, ".gitignore"), ".env.*\n");
    git("add", "--", ".gitignore", "index.html", "public");
    writeFileSync(join(pkg, "public", ".env.local"), "SECRET_FOR_A_TEST_ONLY=1\n");
    assert.equal(git("check-ignore", "public/.env.local").trim(), "public/.env.local");
    dir = build(pkg);
    assert.ok(!existsSync(join(dir, ".env.local")), "public/.env.local was built");
    assert.deepEqual(checkDir(dir), []);
    assert.ok(readFileSync(join(dir, "app.js")).equals(readFileSync(join(PKG, "public", "app.js"))));
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// Card kit-oneclick-pins-frozen: the gate names the pinned 1Click key bytes in the build's app.js, so a build that ships
// a test harness's key, or a 1Click pin left writable, is refused before anything is uploaded or listed.
test("planted: a build whose app.js names a harness 1Click key, or leaves a pin unfrozen, is refused; the real build passes", () => {
  const dir = build();
  try {
    assert.deepEqual(checkPins(dir), []);
    const js = readFileSync(join(dir, "app.js"), "utf8");
    const KEYS = "Object.freeze([`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`])";
    assert.equal(js.split(KEYS).length, 2, "the key set's minified form moved; update this test");
    const harness = "ed25519:5Mbn3Ajg8a4x3tgXqLqgdx2GvnyLRB3exyzi9apAYVt8"; // a made-up 32-byte key, no secret of any kind
    writeFileSync(join(dir, "app.js"), js.replace(KEYS, `Object.freeze([\`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc\`,\`${harness}\`])`));
    assert.ok(checkPins(dir).some((l) => l.includes(`names the 1Click key ${harness}, which the release does not pin`)), checkPins(dir).join("\n"));
    assert.ok(checkDir(dir).some((l) => l.includes(harness)));
    writeFileSync(join(dir, "app.js"), js.replace(KEYS, "[`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`]"));
    assert.ok(checkPins(dir).some((l) => l.includes("copies of ONECLICK_SIGNING_KEYS in the bundle are not frozen")), checkPins(dir).join("\n"));
    writeFileSync(join(dir, "app.js"), js.replace("Object.freeze({keyless:1,partner:1})", "{keyless:1,partner:1}"));
    assert.ok(checkPins(dir).some((l) => l.includes("copies of ONECLICK_FEE_BPS in the bundle are not frozen")), checkPins(dir).join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Card signpage-deploy-runs: deploy.mjs run as the main module (node packages/signpage/scripts/deploy.mjs), as a sign deploy
// runs it, not imported as the tests above import it. release-list.mjs, which deploy() loads late, imports deploy.mjs
// back, so a main block that awaits deploy() at the top level never settles once the late import starts (Node exits 13,
// "unsettled top-level await"). Every path runs the real script on this tree with stand-ins on PATH for the reads that
// leave the machine: git ls-remote answers HEAD as main's head and git status a clean tree (every other git call is git's),
// gh a passed ci.yml push run of HEAD, pnpm an install that did nothing (the clean checkout's is pnpm's own); no CLOUDFLARE_* is set, so nothing is uploaded.
test("deploy.mjs run as the main module reaches its gate on every path: --dry-run and a deploy through the late import of release-list.mjs, --build, --live-runs", () => {
  const repo = dirname(dirname(PKG));
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "ct-signpage-main-"));
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("git", `if [ "$1" = ls-remote ]; then printf '%s\\trefs/heads/main\\n' "${head}"; exit 0; fi\nif [ "$3" = status ]; then exit 0; fi\nexec "${git}" "$@"`);
  stub("gh", `printf '%s\\n' '${JSON.stringify([passed(head)])}'`);
  // the clean checkout's install (--prefer-offline, review P2-1) is pnpm's own, from the store: the build there needs it
  const pnpm = execFileSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();
  stub("pnpm", `case "$*" in *--prefer-offline*) exec "${pnpm}" "$@";; esac\nexit 0`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const main = (...args) => {
    const r = spawnSync(process.execPath, [join(PKG, "scripts", "deploy.mjs"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 300_000 });
    const all = `${r.stdout}${r.stderr}`;
    assert.ok(!/unsettled top-level await/i.test(all), `deploy.mjs ${args.join(" ")} never settled (exit ${r.status}):\n${all}`);
    const kept = /gate ok on (\S+);/.exec(r.stdout)?.[1];
    if (kept && kept.startsWith(tmpdir())) rmSync(kept, { recursive: true, force: true });
    return { ...r, all, kept };
  };
  try {
    const dry = main("--dry-run");
    assert.ok([0, 1].includes(dry.status), `--dry-run exit ${dry.status}:\n${dry.all}`);
    assert.match(dry.stdout, /deploy: gate ok on \S+; --dry-run: nothing was uploaded; a deploy would (go ahead|refuse it:)/, dry.all);
    // a deploy: past the late import, it refuses a build no release names, or stops at the missing token
    const real = main();
    assert.ok([1, 2].includes(real.status), `a deploy exit ${real.status}:\n${real.all}`);
    assert.match(real.stderr, /deploy: (REFUSED release-\d+, the newest release, is not this SIGN_HOST build|REFUSED .*RELEASED|gate ok; CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID not set, nothing was uploaded)/, real.all);
    const built = main("--build");
    assert.equal(built.status, 0, built.all);
    assert.match(built.stdout, /deploy: gate ok on \S+; --build:/);
    const runs = main("--live-runs");
    assert.equal(runs.status, 0, runs.all);
    assert.deepEqual(JSON.parse(runs.stdout).checks, LIVE_CHECKS);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
