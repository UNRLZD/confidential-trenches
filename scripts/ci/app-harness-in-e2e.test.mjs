// node --test scripts/ci/app-harness-in-e2e.test.mjs: every app live check with a --harness mode runs in apps/terminal's
// test:e2e or says why not (scripts/ci/app-harness-in-e2e.mjs), on the tree as it is, and each planted failure is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { e2eHarnessRuns, harnessProblems, readTree } from "./app-harness-in-e2e.mjs";

const HARNESS = `const a = process.argv.slice(2);\nif (a.includes("--harness")) run();\n`;
const check = ({ after = "// After: app", lines = [], harness = true } = {}) =>
  `#!/usr/bin/env node\n// Live check of card x: what it reads.\n${[after, ...lines].filter(Boolean).map((l) => `${l}\n`).join("")}import "../net-window.mjs";\n${harness ? HARNESS : ""}`;
const E2E = (...keys) => ["vite build", ...keys.map((k) => `node ../../scripts/live-checks/${k}.mjs --harness`), "node test/bar10/run.mjs"].join(" && ");
const REASON = "// Harness: not in e2e, its harness reads the release's real RPCs";

test("the tree passes: every app check with a --harness mode runs in test:e2e or says why not", () => {
  const { checks, e2e } = readTree();
  assert.deepEqual(harnessProblems(checks, e2e), []);
});

test("the tree runs trade-box-pool's harness, the check that went stale on release 125", () => {
  assert.ok(e2eHarnessRuns(readTree().e2e).includes("trade-box-pool"));
});

test("passes: a check test:e2e runs, one with its Harness reason, one with no --harness mode, one in no app list", () => {
  const checks = {
    "run-one": check(),
    "said-why": check({ lines: [REASON] }),
    "no-harness": check({ harness: false }),
    "sign-only": check({ after: "// After: sign" }),
  };
  assert.deepEqual(harnessProblems(checks, E2E("run-one")), []);
});

test("passes: a test:e2e run with more arguments after --harness counts", () => {
  const e2e = "vite build && node ../../scripts/live-checks/app-in-shell.mjs --harness --engines chromium";
  assert.deepEqual(e2eHarnessRuns(e2e), ["app-in-shell"]);
  assert.deepEqual(harnessProblems({ "app-in-shell": check() }, e2e), []);
});

test("planted: an app check with a --harness mode left out of test:e2e, with no Harness line, is refused", () => {
  const p = harnessProblems({ "left-out": check(), "run-one": check() }, E2E("run-one"));
  assert.equal(p.length, 1);
  assert.match(p[0], /left-out\.mjs runs after the app's deploy and has a --harness mode, but test:e2e does not run it/);
});

test("planted: a check after app among other hosts, left out, is refused too", () => {
  assert.equal(harnessProblems({ both: check({ after: "// After: app sign" }) }, E2E()).length, 1);
});

test("planted: a run without --harness, or a wrapper test, does not count as the check's own harness run", () => {
  const e2e = "vite build && node ../../scripts/live-checks/left-out.mjs --engine chromium && node test/left-out/run.mjs";
  assert.deepEqual(e2eHarnessRuns(e2e), []);
  assert.equal(harnessProblems({ "left-out": check() }, e2e).length, 1);
});

test("planted: a Harness line on a check test:e2e runs, two Harness lines, a Harness line with no reason or another word", () => {
  assert.match(harnessProblems({ a: check({ lines: [REASON] }) }, E2E("a"))[0], /runs in test:e2e and says Harness/);
  assert.match(harnessProblems({ a: check({ lines: [REASON, REASON] }) }, E2E())[0], /has 2 Harness lines/);
  assert.match(harnessProblems({ a: check({ lines: ["// Harness: not in e2e, slow"] }) }, E2E())[0], /gives no reason/);
  assert.match(harnessProblems({ a: check({ lines: ["// Harness: later"] }) }, E2E())[0], /a Harness line is "not in e2e, <why>"/);
});

test("planted: a Harness line on a check with no --harness mode or in no app list is refused", () => {
  assert.match(harnessProblems({ a: check({ harness: false, lines: [REASON] }) }, E2E())[0], /reads no --harness argument/);
  assert.match(harnessProblems({ a: check({ after: "// After: helper", lines: [REASON] }) }, E2E())[0], /is in no app list/);
});

test("planted: a Harness line below the header block does not count", () => {
  const text = `${check()}// Harness: not in e2e, its harness reads the release's real RPCs\n`;
  assert.equal(harnessProblems({ a: text }, E2E()).length, 1);
});

test("planted: test:e2e runs a check file that does not exist", () => {
  assert.match(harnessProblems({}, E2E("gone"))[0], /runs scripts\/live-checks\/gone\.mjs --harness, which is no file/);
});
