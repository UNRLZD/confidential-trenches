// node --test scripts/live-checks/signpage-prover-host.test.mjs: the live check replays recorded answers
// (signpage-prover-host.answers.json). good: the harness run on a fresh `deploy.mjs --dry-run` build of this branch
// (SIGN_HOST does not serve the prover before this card's deploy), in Playwright's Chromium: PASS. bad: the same build
// with one byte of withdraw.zkey changed: its sha256 is not the pin and the worker refuses it at load, so nothing is
// proved: FAIL. The other bad answers are the good one with one fault planted each: FAIL.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LICENSES, openBrowser, PINS, policies, WORKER_CSP, WORKER_PATH, zkPath } from "./signpage-prover-host.mjs";

after(() => globalThis.curve_bn128?.terminate?.());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-prover-host.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const ZKEY = zkPath(PINS[1]);

/** The good answer with `f` applied to a deep copy. */
const planted = (f) => {
  const a = structuredClone(GOOD);
  f(a);
  return a;
};
const bad = (r, line) => {
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${line}`)), `no "BAD ${line}" in:\n${r.lines.join("\n")}`);
};

test("recorded good answer: the six files, the worker under both policies, the probes, a proof snarkjs accepts: PASS", async () => {
  const r = await judge(GOOD);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, PINS.length * 3 + 4 + LICENSES.length + 10);
  for (const [name, bytes, sha] of PINS) assert.ok(r.lines.includes(`ok  ${name}: ${bytes} B sha256 ${sha}`), name);
  assert.ok(r.lines.includes(`ok  ${WORKER_PATH}: 2 CSP policies, the site's 1, its own (W:880) 1; want exactly one of each`));
  assert.ok(r.lines.includes("ok  snarkjs groth16.verify with the pinned withdraw.vkey: true"));
  assert.ok(r.lines.includes("ok  CSP and Trusted Types violations: the probes' three only"));
});

test("recorded bad answer: withdraw.zkey with one byte changed is refused, by the check and by the worker: FAIL", async () => {
  const r = await judge(ANSWERS.bad);
  bad(r, `withdraw.zkey: 17793015 B sha256 ${ANSWERS.bad.files[ZKEY].sha256}, pinned 17793015 B ${PINS[1][2]}`);
  bad(r, 'the worker loads the withdraw setup files: "Error: withdraw.zkey: sha256 ');
  bad(r, "snarkjs groth16.verify with the pinned withdraw.vkey: false");
});

test("planted: a setup file not served, served short, or not cached for good: FAIL", async () => {
  bad(await judge(planted((a) => delete a.files[ZKEY])), "withdraw.zkey: not read");
  bad(await judge(planted((a) => (a.files[zkPath(PINS[3])].bytes -= 1))), "commitment.wasm: 2380441 B");
  bad(await judge(planted((a) => (a.files[ZKEY].status = 404))), `withdraw.zkey at ${ZKEY}: 404`);
  bad(await judge(planted((a) => (a.files[ZKEY].headers["cache-control"] = "public, max-age=0, must-revalidate"))), "withdraw.zkey: cache-control");
  // two rules joined by Pages: the right value and a second, conflicting max-age
  bad(await judge(planted((a) => (a.files[ZKEY].headers["cache-control"] = "public, max-age=31536000, immutable, public, max-age=0, must-revalidate"))), "withdraw.zkey: cache-control");
  bad(await judge(planted((a) => delete a.files[zkPath(PINS[2])].headers["cache-control"])), 'withdraw.vkey: cache-control none, want "public, max-age=31536000, immutable"');
});

test("planted: a worker that is not the release's, or without its own policy, or with a third: FAIL", async () => {
  bad(await judge(planted((a) => (a.files[WORKER_PATH].sha256 = "0".repeat(64)))), `${WORKER_PATH}: sha256 ${"0".repeat(64)}, the release's`);
  const csp = GOOD.files[WORKER_PATH].headers["content-security-policy"];
  assert.equal(policies(csp).length, 2);
  const site = csp.split(",").find((p) => p.includes("frame-src"));
  for (const [what, header] of [
    ["the site's policy only", site],
    ["its own policy only", WORKER_CSP],
    ["its own policy and another in place of the site's", `${WORKER_CSP}, default-src *`],
    ["a third policy", `${csp}, default-src *`],
    ["its own policy with a remote connect-src", csp.replace(/connect-src 'self'\s*$/, "connect-src 'self' https://evil.ct.test")],
    ["its own policy with 'unsafe-eval'", csp.replace(/'wasm-unsafe-eval'; connect-src 'self'\s*$/, "'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self'")],
  ]) {
    assert.notEqual(header, csp, what);
    bad(await judge(planted((a) => (a.files[WORKER_PATH].headers["content-security-policy"] = header))), `${WORKER_PATH}: `);
  }
});

test("planted: a licence text missing: FAIL", async () => {
  bad(await judge(planted((a) => (a.files["/licenses/GPL-3.0.txt"].status = 404))), "/licenses/GPL-3.0.txt: 404");
});

test("planted: Trusted Types not enforced, a violation beyond the probes, or a proof that is not the input's: FAIL", async () => {
  bad(await judge(planted((a) => (a.page.plainStringWorker = "allowed"))), 'a Worker from a plain string: "allowed"');
  bad(await judge(planted((a) => (a.page.otherPolicy = "allowed"))), 'a policy named other: "allowed"');
  bad(await judge(planted((a) => a.page.violations.push({ where: "worker", directive: "connect-src", blocked: "https://evil.ct.test/", sample: "" }))), "CSP and Trusted Types violations");
  bad(await judge(planted((a) => (a.page.result.publicSignals[7] = "1"))), "its public signals are withdraw.public.json's");
  bad(await judge(planted((a) => (a.page.result.proof.pi_a[0] = String(BigInt(a.page.result.proof.pi_a[0]) + 1n)))), "snarkjs groth16.verify with the pinned withdraw.vkey: false");
  bad(await judge(planted((a) => (a.page.posts[0].bytesLeftHere = [2607967, 17793015]))), "the wasm and zkey moved to the worker by transfer");
  bad(await judge(planted((a) => delete a.page)), "the page: not run");
});

test("the harness's TLS folder is removed when openssl fails after writing the key (fold 1, item 4)", async () => {
  const bin = mkdtempSync(path.join(tmpdir(), "ct-fake-openssl-"));
  // writes a key file where -keyout says, then fails
  writeFileSync(path.join(bin, "openssl"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -keyout ] && echo not-a-key > "$2"; shift; done\necho made up >&2\nexit 1\n');
  chmodSync(path.join(bin, "openssl"), 0o755);
  const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("ct-harness-tls-")));
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    await assert.rejects(openBrowser("chromium", () => ({ status: 404, headers: {}, body: Buffer.alloc(0) })), /^Error: openssl: exit 1: made up$/);
  } finally {
    process.env.PATH = PATH;
    rmSync(bin, { recursive: true, force: true });
  }
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith("ct-harness-tls-") && !before.has(f)), []);
});
