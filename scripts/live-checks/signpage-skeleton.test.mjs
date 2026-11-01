// node --test scripts/live-checks/signpage-skeleton.test.mjs: the live check replays recorded answers
// (signpage-skeleton.answers.json). good: packages/signpage built by deploy.mjs --dry-run and served by the Pages
// runtime of wrangler 4.151.1 on a Mac (SIGN_HOST answered 522 before any deploy, so no served answer exists
// yet): PASS. The bad answers are that same answer with frame-ancestors taken out of the CSP, and with
// frame-ancestors *: FAIL. predeploy: SIGN_HOST's real 522 before any deploy: FAIL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { frameAllowed, judge, read } from "./signpage-skeleton.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-skeleton.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const APP = "https://confidential.unrealized.trade";

const withCsp = (from, to) => {
  const csp = GOOD.headers["content-security-policy"];
  assert.ok(csp.includes(from), from);
  return { ...GOOD, headers: { ...GOOD.headers, "content-security-policy": csp.replace(from, to) } };
};

// a fetch that answers every request with one recorded answer
const replay = (a) => async () => ({ status: a.status, headers: new Headers(a.headers) });

test("recorded good answer: every header equals the policy: PASS", async () => {
  const r = judge(await read(undefined, replay(GOOD)));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  CSP frame-ancestors: "${APP}"`));
  assert.ok(r.lines.includes(`ok  framed from ${APP}: allowed`));
  assert.ok(r.lines.includes("ok  framed from https://example.com: blocked"));
  assert.ok(r.lines.includes('ok  integrity-policy: "blocked-destinations=(script)"'));
});

test("recorded bad answer: a CSP with no frame-ancestors: FAIL", async () => {
  const r = judge(await read(undefined, replay(withCsp(` frame-ancestors ${APP};`, ""))));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD CSP frame-ancestors: none, want "${APP}"`), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD framed from https://example.com: allowed (no frame-ancestors)"));
  assert.ok(r.lines.includes(`BAD framed from ${APP}: blocked`));
});

test("recorded bad answer: frame-ancestors *: FAIL", async () => {
  const r = judge(await read(undefined, replay(withCsp(`frame-ancestors ${APP}`, "frame-ancestors *"))));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD framed from https://example.com: allowed"), r.lines.join("\n"));
});

test("recorded bad answers: a directive added, Integrity-Policy gone, X-Frame-Options sent, SIGN_HOST's 522: FAIL", async () => {
  const added = judge(withCsp("trusted-types prover-worker", "trusted-types prover-worker; report-uri https://evil.ct.test"));
  assert.ok(added.lines.includes("BAD CSP has no directive beyond the policy's: extra report-uri"), added.lines.join("\n"));
  const { "integrity-policy": _, ...noIp } = GOOD.headers;
  const ip = judge({ ...GOOD, headers: noIp });
  assert.ok(ip.lines.includes('BAD integrity-policy: none, want "blocked-destinations=(script)"'), ip.lines.join("\n"));
  const xfo = judge({ ...GOOD, headers: { ...GOOD.headers, "x-frame-options": "DENY" } });
  assert.ok(xfo.lines.includes('BAD x-frame-options: "DENY", want none'), xfo.lines.join("\n"));
  const two = judge({ ...GOOD, headers: { ...GOOD.headers, "content-security-policy": `${GOOD.headers["content-security-policy"]}, default-src *` } });
  assert.ok(two.lines.includes("BAD CSP is one policy: it holds a comma"), two.lines.join("\n"));
  const pre = judge(ANSWERS.predeploy);
  assert.equal(pre.ok, false);
  assert.equal(pre.lines[0], "BAD GET answers 522");
  assert.ok(pre.lines.includes('BAD x-frame-options: "SAMEORIGIN", want none'));
});

test("frameAllowed reads frame-ancestors source expressions as CSP3 does", () => {
  const ex = "https://example.com";
  assert.equal(frameAllowed([APP], APP), true);
  assert.equal(frameAllowed([APP], ex), false);
  assert.equal(frameAllowed(["'none'"], APP), false);
  assert.equal(frameAllowed(["'self'"], ex), false);
  assert.equal(frameAllowed(["'self'"], "https://sign.confidential.unrealized.trade"), true);
  for (const s of ["*", "https:", "http:", "example.com", "*.com", "https://example.com:443", "http://example.com", "https://example.com/x", "example.com:*"])
    assert.equal(frameAllowed([s], ex), true, s);
  for (const s of ["https://example.com:8443", "*.example.com", "wss:", "https://example.org", "'unsafe-inline'"])
    assert.equal(frameAllowed([s], ex), false, s);
});

test("the CLI on a host that does not answer is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "signpage-skeleton.mjs"), "--url", "http://127.0.0.1:9/"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /live-check signpage-skeleton: ERROR: /);
});
