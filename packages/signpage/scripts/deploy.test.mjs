// node --test packages/signpage/scripts/deploy.test.mjs: the deploy refuses a build whose headers break SIGN_HOST's
// policy before anything is uploaded, and uploads the real build with wrangler at its pinned version.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRANCH, LIVE_CHECKS, PROJECT, WRANGLER, checkDir, checkHeadersFile, deploy } from "./deploy.mjs";

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

// a spawnSync stand-in that records every call
function recorder() {
  const calls = [];
  const run = (cmd, args, opts) => (calls.push({ cmd, args, opts }), { status: 0, stdout: cmd === "git" ? "abc\n" : "" });
  return { calls, run };
}

const swap = (from, to) => {
  assert.ok(REAL.includes(from), from);
  return REAL.replace(from, to);
};

test("the real _headers passes the gate", () => {
  assert.deepEqual(checkHeadersFile(REAL), []);
});

test("a CSP with no frame-ancestors is refused, and nothing is uploaded", () => {
  const { calls, run } = recorder();
  const r = deploy([], ENV, run, pkgWith(swap(" frame-ancestors 'none';", "")));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(`REFUSED _headers: CSP frame-ancestors: none, want "'none'"`), r.err.join("\n"));
  assert.ok(r.err.includes("REFUSED _headers: framed from https://confidential.unrealized.trade: allowed (no frame-ancestors)"), r.err.join("\n"));
  assert.ok(r.err.includes("REFUSED _headers: framed from https://example.com: allowed (no frame-ancestors)"), r.err.join("\n"));
  assert.equal(r.err.at(-1), "nothing was uploaded");
  assert.equal(calls.length, 0);
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
  };
  for (const [name, text] of Object.entries(bad)) assert.notDeepEqual(checkHeadersFile(text), [], name);
});

test("a build carrying _worker.js or .well-known/webauthn is refused", () => {
  const { calls, run } = recorder();
  for (const f of ["_worker.js", ".well-known/webauthn"]) {
    const r = deploy([], ENV, run, pkgWith(REAL, { [f]: "x" }));
    assert.equal(r.code, 1, f);
    assert.ok(r.err.some((e) => e.includes(f)), r.err.join("\n"));
  }
  assert.equal(calls.length, 0);
});

test("--dry-run stops after the gate; the build holds the page and _headers only", () => {
  const { calls, run } = recorder();
  const r = deploy(["--dry-run"], {}, run);
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  const dir = /gate ok on (\S+);/.exec(r.out[0])[1];
  assert.deepEqual(checkDir(dir), []);
  assert.equal(readFileSync(join(dir, "_headers"), "utf8"), REAL);
  assert.equal(calls.length, 0);
});

test("with the gate passed and no token, nothing is uploaded", () => {
  const { calls, run } = recorder();
  const r = deploy([], {}, run);
  assert.equal(r.code, 2);
  assert.match(r.err[0], /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID not set/);
  assert.equal(calls.length, 0);
});

test("the upload is wrangler pages deploy at its pinned version, to the sign project on main, from an empty folder", () => {
  const { calls, run } = recorder();
  const r = deploy([], ENV, run);
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  const up = calls.find((c) => c.cmd === "pnpm");
  assert.deepEqual(up.args.slice(0, 4), ["dlx", WRANGLER, "pages", "deploy"]);
  assert.equal(WRANGLER, "wrangler@4.151.1");
  assert.deepEqual(up.args.slice(5, 9), ["--project-name", PROJECT, "--branch", BRANCH]);
  assert.equal(PROJECT, "confidential-trenches-sign");
  assert.notEqual(up.opts.cwd, up.args[4]);
  assert.equal(up.opts.env.WRANGLER_SEND_METRICS, "false");
});

test("an unknown argument is a usage error", () => {
  assert.equal(deploy(["dist"], ENV, recorder().run).code, 2);
});

test("a deploy names every live check that reads SIGN_HOST in its success line", () => {
  const r = deploy([], ENV, recorder().run);
  assert.equal(r.code, 0, (r.err ?? []).join("\n"));
  const out = r.out.join("\n");
  // every signpage-* live check is named, and every named check exists and holds SIGN_HOST's own name
  const dir = join(PKG, "..", "..", "scripts", "live-checks");
  const own = readdirSync(dir).filter((f) => /^signpage-[\w-]+\.mjs$/.test(f) && !f.endsWith(".test.mjs")).map((f) => f.replace(/\.mjs$/, ""));
  assert.ok(own.length >= 3, own.join(" "));
  for (const k of own) assert.ok(LIVE_CHECKS.includes(k), `LIVE_CHECKS does not name ${k}`);
  for (const k of LIVE_CHECKS) assert.match(readFileSync(join(dir, `${k}.mjs`), "utf8"), /sign\.confidential\.unrealized\.trade/, `${k} does not read SIGN_HOST`);
  assert.deepEqual([...LIVE_CHECKS].sort(), ["app-signpage-client", "signpage-frame-state", "signpage-postmessage", "signpage-skeleton", "wallet-passkey-prf"]);
  for (const k of LIVE_CHECKS) assert.ok(out.includes(`scripts/live-checks/${k}.mjs`), `the success line does not name ${k}: ${out}`);
});
