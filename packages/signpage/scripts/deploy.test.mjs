// node --test packages/signpage/scripts/deploy.test.mjs: the deploy refuses a build whose headers break SIGN_HOST's
// policy before anything is uploaded, and uploads the real build with wrangler at its pinned version. The build carries
// the prover (card signpage-prover-host): the worker under its own CSP too (W:880) and the six pinned setup files at
// /assets/zk/<sha256>.<ext>; a changed, missing or extra setup file, a stale worker or a worker rule with another
// policy is refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRANCH, LIVE_CHECKS, PROJECT, WRANGLER, build, checkDir, checkHeadersFile, checkPins, deploy, liveRuns } from "./deploy.mjs";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
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

// a spawnSync stand-in that records every call: git answers HEAD `head` and the tree's status `status`; `uploads` are
// the calls that would send bytes (git reads the tree, which any run may do)
function recorder({ head = "abc", status = "", install = 0 } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "pnpm" && args[0] === "install") return { status: install, stdout: "", stderr: install ? "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"\n" : "" };
    return { status: 0, stdout: cmd !== "git" ? "" : args.includes("rev-parse") ? (head ? `${head}\n` : "") : status };
  };
  return { calls, run, uploads: () => calls.filter((c) => c.cmd === "pnpm" && c.args[0] === "dlx"), installs: () => calls.filter((c) => c.cmd === "pnpm" && c.args[0] === "install") };
}
// a package folder that is not there: build() throws on it, so a deploy that returns on it never built
const NO_PKG = join(tmpdir(), "ct-signpage-test-no-such-package");

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
  assert.ok(r.err.includes("REFUSED _headers: framed from https://confidential.unrealized.trade: allowed (no frame-ancestors)"), r.err.join("\n"));
  assert.ok(r.err.includes("REFUSED _headers: framed from https://example.com: allowed (no frame-ancestors)"), r.err.join("\n"));
  assert.equal(r.err.at(-1), "nothing was uploaded");
  assert.equal(uploads().length, 0);
});

test("other policy breaks are refused", () => {
  const bad = {
    "frame-ancestors *": swap("frame-ancestors 'none'", "frame-ancestors *"),
    "frame-ancestors APP_HOST (the framed page's policy)": swap("frame-ancestors 'none'", "frame-ancestors https://confidential.unrealized.trade"),
    "frame-src gone": swap(" frame-src https://confidential.unrealized.trade;", ""),
    "frame-src *": swap("frame-src https://confidential.unrealized.trade", "frame-src *"),
    "frame-src a second host": swap("frame-src https://confidential.unrealized.trade", "frame-src https://confidential.unrealized.trade https://example.com"),
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

test("a build carrying _worker.js or .well-known/webauthn is refused", async () => {
  const { uploads, run } = recorder();
  for (const f of ["_worker.js", ".well-known/webauthn"]) {
    const r = await deploy([], ENV, run, pkgWith(REAL, { [f]: "x" }));
    assert.equal(r.code, 1, f);
    assert.ok(r.err.some((e) => e.includes(f)), r.err.join("\n"));
  }
  assert.equal(uploads().length, 0);
});

test("--dry-run stops after the gate and keeps the build, whose _headers is the package's", async () => {
  const { uploads, run } = recorder();
  const r = await deploy(["--dry-run"], {}, run);
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
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
  const r = await deploy([], {}, run);
  assert.equal(r.code, 2);
  assert.match(r.err[0], /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID not set/);
  assert.equal(uploads().length, 0);
});

test("the upload is wrangler pages deploy at its pinned version, to the sign project on main, from an empty folder, named by HEAD", async () => {
  const rec = recorder();
  const { uploads, run } = rec;
  const r = await deploy([], ENV, run, undefined, signHost(rec).net);
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  const up = uploads().find((c) => c.cmd === "pnpm");
  assert.deepEqual(up.args.slice(9), ["--commit-hash", "abc", "--commit-dirty=false"]);
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
  // --dry-run still builds and gates a work in progress, and says a deploy would refuse it
  const dry = recorder({ status: " M packages/signpage/index.html" });
  const d = await deploy(["--dry-run"], {}, dry.run);
  assert.equal(d.code, 0, (d.err ?? []).join("\n"));
  rmSync(/gate ok on (\S+?);/.exec(d.out[0])[1], { recursive: true, force: true });
  assert.match(d.out[0], /uncommitted changes: a deploy would refuse/);
});

test("the deploy installs HEAD's lockfile (pnpm install --frozen-lockfile at the repository root) after the tree reads and before the build", async () => {
  const { calls, run, installs } = recorder();
  // the build of a missing package throws: the install was already asked for, after the two tree reads
  await assert.rejects(deploy([], ENV, run, NO_PKG), /ENOENT/);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args.at(c.cmd === "git" ? 2 : 0)].join(" ")), ["git rev-parse", "git status", "pnpm install"]);
  assert.deepEqual(installs()[0].args, ["install", "--frozen-lockfile"]);
  assert.equal(installs()[0].opts.cwd, dirname(dirname(PKG)));
  const dry = recorder();
  await assert.rejects(deploy(["--dry-run"], {}, dry.run, NO_PKG), /ENOENT/);
  assert.equal(dry.installs().length, 1, "--dry-run builds what a deploy would, so it installs too");
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
  const r = await deploy([], ENV, rec.run, undefined, signHost(rec).net);
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  assert.ok(r.out.some((l) => /^next: gh workflow run live\.yml -f host=sign -f commit=\S+$/.test(l)), r.out.join("\n"));
  assert.ok(r.out.includes("then: gh run watch --exit-status"), r.out.join("\n"));
  const out = LIVE_CHECKS.flatMap((k) => liveRuns(k)).join("\n");
  // every signpage-* live check is named, and every named check exists and holds SIGN_HOST's own name
  const dir = join(PKG, "..", "..", "scripts", "live-checks");
  const own = readdirSync(dir).filter((f) => /^signpage-[\w-]+\.mjs$/.test(f) && !f.endsWith(".test.mjs")).map((f) => f.replace(/\.mjs$/, ""));
  assert.ok(own.length >= 3, own.join(" "));
  for (const k of own) assert.ok(LIVE_CHECKS.includes(k), `LIVE_CHECKS does not name ${k}`);
  for (const k of LIVE_CHECKS) assert.match(readFileSync(join(dir, `${k}.mjs`), "utf8"), /sign\.confidential\.unrealized\.trade/, `${k} does not read SIGN_HOST`);
  assert.deepEqual([...LIVE_CHECKS].sort(), ["app-harness-signin-e2e", "evm-pool-sync-wide-pages", "evm-sell-no-release-in-flight", "evm-sell-unfunded-sim-keeps-route", "held-deposit-way-out", "kit-deposit-assets-dry", "kit-deposit-calls", "kit-frame-version", "kit-oneclick-pins-frozen", "kit-renewal-read-bounded", "oneclick-fee-path-own-key", "page-evm-rpc-csp", "pool-answer-unknown", "pool-deposit-address", "pool-deposit-follow", "pool-deposit-sent-end", "pool-deposits", "pool-read-down", "pool-ready-no-flicker", "pool-restore-wired", "pool-senders-next-page", "signpage-buy-own-spend", "signpage-buy-route-events", "signpage-error-after-timeout", "signpage-pool-flow", "signpage-pool-kinds", "signpage-pool-mainnet", "signpage-pool-notes", "signpage-pool-pins", "signpage-pool-price", "signpage-pool-withdraw-form", "signpage-postmessage", "signpage-prover-host", "signpage-prover-threads", "signpage-release", "signpage-sent-read-back", "signpage-shell", "signpage-signin-kinds", "signpage-skeleton", "signpage-solana-trade", "signpage-withdraw-form", "signpage-withdraw-handoff", "signpage-withdraw-own-spend", "sol-buy-rent-back", "solana-legs-checked", "solana-release-reads-paced", "solana-written-accounts-whole", "wallet-deposit-follow", "wallet-near-prepay-taken", "wallet-passkey-prf", "wallet-withdraw-move-out"]);
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
  const r = await deploy([], ENV, rec.run, undefined, h.net);
  assert.equal(r.code, 1, (r.out ?? []).join("\n"));
  const said = [...(r.out ?? []), ...(r.err ?? [])].join("\n");
  assert.doesNotMatch(said, /next:/);
  assert.match(said, new RegExp(`/app\\.js[^\\n]*${sha256(OLD)}[^\\n]*${sha256(readFileSync(join(PKG, "public", "app.js")))}`));
  // a few tries over about a minute, each a fresh cache-buster, all on SIGN_HOST's own address
  const tries = h.asked.filter((a) => new URL(a.url).pathname === "/app.js");
  assert.ok(tries.length >= 3, `${tries.length} tries`);
  assert.equal(new Set(tries.map((a) => new URL(a.url).search)).size, tries.length, "each try its own cache-buster");
  for (const a of h.asked) assert.equal(new URL(a.url).origin, "https://sign.confidential.unrealized.trade");
  const waited = h.slept.reduce((a, b) => a + b, 0);
  assert.ok(waited >= 45_000 && waited <= 90_000, `${waited} ms`);
});

test("a deploy whose SIGN_HOST serves exactly the build it uploaded (/ and /app.js) prints next:", async () => {
  const rec = recorder();
  const h = signHost(rec);
  const r = await deploy([], ENV, rec.run, undefined, h.net);
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  assert.ok(r.out.some((l) => /^next: gh workflow run live\.yml -f host=sign -f commit=abc$/.test(l)), r.out.join("\n"));
  assert.deepEqual([...new Set(h.asked.map((a) => new URL(a.url).pathname))].sort(), ["/", "/app.js"]);
  assert.ok(h.asked.every((a) => new URL(a.url).search), "every read carries a cache-buster");
});

test("a SIGN_HOST that cannot be read, or answers other than 200, is never taken as done", async () => {
  for (const fail of [async () => { throw new TypeError("fetch failed"); }, async () => new Response("gone", { status: 404 })]) {
    const rec = recorder();
    const r = await deploy([], ENV, rec.run, undefined, { fetch: fail, sleep: async () => {} });
    assert.equal(r.code, 1, (r.out ?? []).join("\n"));
    assert.doesNotMatch([...(r.out ?? []), ...(r.err ?? [])].join("\n"), /next:/);
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
