// node --test scripts/live-checks/signpage-prover-threads.test.mjs: the live check replays recorded answers
// (signpage-prover-threads.answers.json), each the harness run on a build served under its own _headers (SIGN_HOST does
// not serve the thread file before this card's deploy), on the test box. good: a fresh `deploy.mjs --dry-run` build of
// this branch, in Playwright's WebKit (both re-recorded on the box for card page-evm-rpc-csp's site CSP, 2026-11-07, and with goodChromium for card held-move-forgotten-tx's, the mainnet archival RPCs, 2026-11-08); goodChromium: the same in the installed Google Chrome (over the harness's local HTTPS server): PASS. bad and badWebkit: main's build before this card (no thread file, the
// worker on one thread), in Chromium and WebKit: FAIL. badLoose: this branch's build with the site's worker-src loosened
// to 'self' data: blob:, the change the card refuses: the planted data: worker runs: FAIL. The other bad answers are
// the good one with one fault planted each: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { consoleLineOf, failLines, judge, THREAD_CSP, THREAD_PATH, THREAD_PIN, threadsFor } from "./signpage-prover-threads.mjs";

after(() => globalThis.curve_bn128?.terminate?.());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-prover-threads.answers.json"), "utf8"));
const GOOD = ANSWERS.good;

const planted = (f, from = GOOD) => {
  const a = structuredClone(from);
  f(a);
  return a;
};
const bad = (r, line) => {
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${line}`)), `no "BAD ${line}" in:\n${r.lines.join("\n")}`);
};

test("threads = min(hardwareConcurrency - 1, 4), single thread below 2", () => {
  assert.deepEqual([16, 12, 8, 5, 4, 3, 2, 1, 0, undefined].map(threadsFor), [4, 4, 4, 4, 3, 2, 1, 1, 1, 1]);
});

for (const name of ["good", "goodChromium"])
  test(`recorded ${name} answer: the pinned thread file under both policies, planted workers refused, threaded proofs snarkjs accepts: PASS`, async () => {
    const a = ANSWERS[name];
    const r = await judge(a);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.match(a.browser, name === "good" ? /^WebKit / : /^Chrome .*, sandbox on$/); // scripts/browsers.mjs browserLabel
    assert.ok(r.lines.includes(`ok  ${THREAD_PATH}: ${THREAD_PIN.bytes} B sha256 ${THREAD_PIN.sha256}`));
    assert.ok(r.lines.includes(`ok  ${THREAD_PATH}: 2 CSP policies, the site's 1, its own 1; want exactly one of each`));
    assert.ok(a.page.proofs.length >= 3 && a.page.proofs.every((p) => p.threads === threadsFor(a.page.cores) && p.threads > 1));
    assert.ok(r.lines.includes(`ok  snarkjs groth16.verify with the pinned withdraw.vkey: ${a.page.proofs.length}/${a.page.proofs.length}`));
  });

for (const name of ["bad", "badWebkit"])
  test(`recorded ${name} answer: main's build before this card, no thread file and one thread: FAIL`, async () => {
    const r = await judge(ANSWERS[name]);
    bad(r, `${THREAD_PATH}: 404`);
    bad(r, "each proof ran on min(");
  });

test("recorded badLoose answer: worker-src loosened to data: and blob:, the planted workers run: FAIL", async () => {
  const r = await judge(ANSWERS.badLoose);
  bad(r, "a planted data: worker is refused and never runs");
  bad(r, "CSP and Trusted Types violations: the two planted workers' only");
});

test("planted: a thread file that is not the pin, not served, or without its own policy: FAIL", async () => {
  bad(await judge(planted((a) => (a.files[THREAD_PATH].sha256 = "0".repeat(64)))), `${THREAD_PATH}: ${THREAD_PIN.bytes} B sha256 ${"0".repeat(64)}, pinned`);
  bad(await judge(planted((a) => (a.files[THREAD_PATH].bytes -= 1))), `${THREAD_PATH}: ${THREAD_PIN.bytes - 1} B`);
  bad(await judge(planted((a) => delete a.files[THREAD_PATH])), `${THREAD_PATH}: not read`);
  bad(await judge(planted((a) => (a.files[THREAD_PATH].status = 404))), `${THREAD_PATH}: 404`);
  bad(await judge(planted((a) => (a.files[THREAD_PATH].headers["content-type"] = "text/html"))), `${THREAD_PATH}: content-type`);
  const csp = GOOD.files[THREAD_PATH].headers["content-security-policy"];
  const site = csp.split(",").find((p) => p.includes("frame-src"));
  for (const [what, header] of [
    ["the site's policy only", site],
    ["its own policy only", THREAD_CSP],
    ["a third policy", `${csp}, default-src *`],
    ["its own policy with 'unsafe-eval'", csp.replace(/script-src 'wasm-unsafe-eval'\s*$/, "script-src 'wasm-unsafe-eval' 'unsafe-eval'")],
    ["its own policy loading scripts", csp.replace(/script-src 'wasm-unsafe-eval'\s*$/, "script-src 'self' 'wasm-unsafe-eval'")],
    ["the site's worker-src with blob:", csp.replace("worker-src 'self'", "worker-src 'self' blob:")],
  ]) {
    assert.notEqual(header, csp, what);
    bad(await judge(planted((a) => (a.files[THREAD_PATH].headers["content-security-policy"] = header))), `${THREAD_PATH}: `);
  }
});

test("planted: a planted worker that ran, one thread, a proof that does not verify, another worker script, a stray violation: FAIL", async () => {
  bad(await judge(planted((a) => (a.page.planted.data.ran = true))), "a planted data: worker is refused");
  bad(await judge(planted((a) => (a.page.planted.blob.ran = true))), "a planted blob: worker is refused");
  bad(await judge(planted((a) => delete a.page.planted.blob)), "a planted blob: worker is refused");
  bad(await judge(planted((a) => (a.page.proofs[0].threads = 1))), "each proof ran on min(");
  bad(await judge(planted((a) => (a.page.cores = 2))), "each proof ran on min(2 - 1, 4) = 1 threads");
  bad(await judge(planted((a) => (a.page.proofs = []))), "the worker proves the fixed input: 0 proofs");
  bad(await judge(planted((a) => (a.page.loadError = "Error: /prover-thread.js: sha256 00, pinned d2"))), "the worker loads the withdraw setup files");
  bad(await judge(planted((a) => (a.page.proofs[1].publicSignals[7] = "1"))), "public signals are withdraw.public.json's");
  bad(await judge(planted((a) => (a.page.proofs[0].proof.pi_a[0] = String(BigInt(a.page.proofs[0].proof.pi_a[0]) + 1n)))), "snarkjs groth16.verify with the pinned withdraw.vkey");
  bad(await judge(planted((a) => a.page.workerScripts.push("https://confidential.unrealized.trade/evil.js"))), "worker scripts fetched");
  bad(await judge(planted((a) => a.page.workerScripts.push("data:text/javascript,postMessage('ran')"))), "worker scripts fetched");
  bad(await judge(planted((a) => a.page.violations.push({ where: "worker", directive: "worker-src", blocked: "blob" }))), "CSP and Trusted Types violations");
  bad(await judge(planted((a) => (a.page.violations = []))), "CSP and Trusted Types violations");
  bad(await judge(planted((a) => delete a.page)), "the page: not run");
});

// The check judges no console line: the planted data: and blob: workers make CSP errors by design. Its console lines are
// for the reader, and name their resource like every other check's (card live-console-url).
test("a console line the run keeps names its resource's origin and path, never the query; one with no location is its text", () => {
  const msg = (type, t, location) => ({ type: () => type, text: () => t, location: () => location });
  const text = "Failed to load resource: the server responded with a status of 429 ()";
  assert.equal(consoleLineOf(msg("error", text, { url: "https://confidential.unrealized.trade/zk/withdraw.zkey?x=1" })), `error ${text} (https://confidential.unrealized.trade/zk/withdraw.zkey)`);
  assert.equal(consoleLineOf(msg("error", "Refused to create a worker", { url: "blob:https://confidential.unrealized.trade/9a7e" })), "error Refused to create a worker (blob:https://confidential.unrealized.trade)");
  assert.equal(consoleLineOf(msg("log", "x".repeat(400), { url: "" })), `log ${"x".repeat(296)}`);
});

// card pool-buy-send-fast (live run 42137740517's red job printed no console line): a FAIL prints the run's console
// lines and the worker scripts asked for, so a red run's log is its own reproduction
test("a FAIL's extra lines: each console line kept, then the worker scripts; none kept says so", () => {
  const rec = { page: { console: ["worker https://confidential.unrealized.trade/prover-worker.js", "in /prover-worker.js: error x"], workerScripts: ["https://confidential.unrealized.trade/prover-worker.js"] } };
  assert.deepEqual(failLines(rec), ["CONSOLE worker https://confidential.unrealized.trade/prover-worker.js", "CONSOLE in /prover-worker.js: error x", 'WORKER SCRIPTS ["https://confidential.unrealized.trade/prover-worker.js"]']);
  assert.deepEqual(failLines({ page: {} }), ["CONSOLE none kept", "WORKER SCRIPTS []"]);
  assert.deepEqual(failLines(null), ["CONSOLE none kept", "WORKER SCRIPTS []"]);
});
