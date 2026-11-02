// node --test scripts/live-checks/app-host-gate.test.mjs: the live check replays recorded answers
// (app-host-gate.answers.json). good: card app-in-shell's build (apps/terminal/dist) served by the Pages runtime of
// wrangler 4.151.1 on a Mac, 2026-11-01: PASS. liveBefore: the live APP_HOST read the same day before app-in-shell's
// deploy (frame-ancestors 'none', frame-src SIGN_HOST, X-Frame-Options DENY): FAIL. The other bad answers are the good
// one with 'wasm-unsafe-eval' added to script-src, and with frame-ancestors *: FAIL. predeploy: APP_HOST's real 522
// before its first deploy: FAIL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read } from "./app-host-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-host-gate.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const SIGN = "https://sign.confidential.unrealized.trade";

const withCsp = (from, to) => {
  const csp = GOOD.headers["content-security-policy"];
  assert.ok(csp.includes(from), from);
  return { ...GOOD, headers: { ...GOOD.headers, "content-security-policy": csp.replace(from, to) } };
};

// a fetch that answers every request with one recorded answer
const replay = (a) => async () => ({ status: a.status, headers: new Headers(a.headers) });

test("recorded good answer: every header equals the policy: PASS", async () => {
  const r = judge(await read("https://confidential.unrealized.trade/", replay(GOOD)));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  CSP frame-ancestors is exactly ${SIGN}`));
  assert.ok(r.lines.includes(`ok  CSP frame-src: "'none'"`));
  assert.ok(r.lines.includes("ok  no header holds 'wasm-unsafe-eval'"));
  assert.ok(r.lines.includes("ok  x-frame-options: none, want none"));
});

test("recorded bad answer: the live APP_HOST before app-in-shell (not frameable by the shell, frames SIGN_HOST): FAIL", async () => {
  const r = judge(await read(undefined, replay(ANSWERS.liveBefore)));
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [
    `BAD CSP frame-src: "${SIGN}", want "'none'"`,
    `BAD CSP frame-ancestors: "'none'", want "${SIGN}"`,
    `BAD CSP frame-ancestors is exactly ${SIGN}`,
    'BAD x-frame-options: "DENY", want none',
  ]);
});

test("recorded bad answer: 'wasm-unsafe-eval' added to script-src: FAIL", async () => {
  const r = judge(await read(undefined, replay(withCsp("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';"))));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD CSP script-src: "'self' 'wasm-unsafe-eval'", want "'self'"`), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD no header holds 'wasm-unsafe-eval': content-security-policy"));
});

test("recorded bad answer: frame-ancestors *: FAIL", async () => {
  const r = judge(await read(undefined, replay(withCsp(`frame-ancestors ${SIGN};`, "frame-ancestors *;"))));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD CSP frame-ancestors: "*", want "${SIGN}"`), r.lines.join("\n"));
  assert.ok(r.lines.includes(`BAD CSP frame-ancestors is exactly ${SIGN}`));
});

test("recorded bad answers: a directive added, a header off by one value, COEP sent, APP_HOST's 522: FAIL", async () => {
  const added = judge(withCsp("upgrade-insecure-requests", "upgrade-insecure-requests; report-uri https://evil.ct.test"));
  assert.ok(added.lines.includes("BAD CSP has no directive beyond the policy's: extra report-uri"), added.lines.join("\n"));
  const hsts = judge({ ...GOOD, headers: { ...GOOD.headers, "strict-transport-security": "max-age=31536000; includeSubDomains" } });
  assert.equal(hsts.ok, false);
  const coep = judge({ ...GOOD, headers: { ...GOOD.headers, "cross-origin-embedder-policy": "require-corp" } });
  assert.equal(coep.ok, false);
  const pre = judge(ANSWERS.predeploy);
  assert.equal(pre.ok, false);
  assert.equal(pre.lines[0], "BAD GET answers 522");
  assert.ok(pre.lines.includes('BAD x-frame-options: "SAMEORIGIN", want none'));
});

test("the CLI on a host that does not answer is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "app-host-gate.mjs"), "--url", "http://127.0.0.1:9/"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /live-check app-host-gate: ERROR: /);
});
