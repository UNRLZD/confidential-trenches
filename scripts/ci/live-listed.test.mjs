// node --test scripts/ci/live-listed.test.mjs: every live check is in a host's after-deploy list or says why not
// (scripts/ci/live-listed.mjs), on the tree as it is, and each planted failure is refused.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hostList } from "./live-after.mjs";
import { listedProblems, readTree, runsLines } from "./live-listed.mjs";

const head = (...lines) => `#!/usr/bin/env node\n// Live check of card x: what it reads.\n${lines.map((l) => `${l}\n`).join("")}import "../net-window.mjs";\n`;
const one = (key, text, listed) => listedProblems({ [key]: text }, listed);

test("the tree passes: every check is in a host's list or has its Runs line, never both", () => {
  const { checks, listed } = readTree();
  assert.deepEqual(listedProblems(checks, listed), []);
  assert.ok(Object.keys(checks).length >= 80, "every scripts/live-checks/*.mjs is read");
});

test("the checks that cover a deployed screen run after the app's deploy", () => {
  const { listed } = readTree();
  for (const key of ["balances-per-chain", "trade-box-pool"]) assert.ok(listed.get(key)?.includes("app"), `${key} is in APP_HOST's list`);
  assert.ok(listed.get("solana-jupiter-build")?.includes("helper"), "solana-jupiter-build reads HELPER_HOST's Jupiter proxy");
});

test("passes: a listed check, a once with its reason, a pending that names a card", () => {
  assert.deepEqual(one("a", head("//   node scripts/live-checks/a.mjs"), new Map([["a", ["app"]]])), []);
  assert.deepEqual(one("a", head("// After: app", "//   node scripts/live-checks/a.mjs")), []);
  assert.deepEqual(one("a", head("// After: sign --host sign", "// After: app helper", "//   node scripts/live-checks/a.mjs [--host <h>]")), []);
  assert.deepEqual(one("b", head("// Runs: once, a contract deploy's read-back: no host deploy changes it")), []);
  assert.deepEqual(one("c", head("// Runs: pending helper-robinhood-capacity")), []);
  assert.deepEqual(one("d", head("// Runs: pending helper-robinhood-capacity, the tapes answer 429 on what is deployed")), []);
});

test("planted: a check in no list with no Runs line is refused", () => {
  assert.match(one("planted", head("//   node scripts/live-checks/planted.mjs")).join("\n"), /planted\.mjs is in no host's list and has no Runs line: write "\/\/ After: <host>/);
});

test("planted: a Runs line after the header block does not count", () => {
  const text = `${head()}// Runs: once, a contract deploy's read-back: no host deploy changes it\n`;
  assert.deepEqual(runsLines(text), []);
  assert.match(one("late", text).join("\n"), /late\.mjs is in no host's list/);
});

test("planted: a once with no reason, a pending with no card key, any other Runs word", () => {
  assert.match(one("e", head("// Runs: once, later")).join("\n"), /gives no reason/);
  assert.match(one("f", head("// Runs: once")).join("\n"), /a Runs line is "once, <why>" or "pending <card>"/);
  for (const card of ["soon", "Helper_Fix", "helper-"]) assert.match(one("g", head(`// Runs: pending ${card}`)).join("\n"), /names no card key|a Runs line is/, card);
  assert.match(one("h", head("// Runs: pending")).join("\n"), /a Runs line is/);
  assert.match(one("i", head("// Runs: never, it is slow and flaky on the runners")).join("\n"), /a Runs line is/);
});

test("planted: a listed check with a Runs line, two Runs lines, a list naming no file", () => {
  assert.match(one("j", head("// Runs: once, a contract deploy's read-back: no host deploy changes it"), new Map([["j", ["sign"]]])).join("\n"), /is in sign's list \(After\) and says Runs: once/);
  assert.match(one("k", head("// Runs: once, a contract deploy's read-back: no host deploy changes it", "// Runs: pending helper-robinhood-capacity")).join("\n"), /has 2 Runs lines/);
  assert.match(listedProblems({}, new Map([["gone", ["helper"]]])).join("\n"), /helper list gone, which is no file/);
});

// card live-lists-merge-clean: a check's hosts are its own After lines (scripts/ci/live-after.mjs), the one parser the
// hosts' lists are made from
test("planted: an After line naming no host or a word that is no host, a check with After and Runs, an After after the header", () => {
  assert.match(one("u", head("// After: web")).join("\n"), /After:" names web, which is no host \(app, sign, helper\)/);
  assert.match(one("u", head("// After: sign web --host sign")).join("\n"), /names web, which is no host/);
  assert.match(one("u", head("// After: --host sign")).join("\n"), /After:" names no host/);
  assert.match(one("u", head("// After: sign sign")).join("\n"), /names a host twice/);
  assert.match(one("u", head("// After: sign", "// After: sign")).join("\n"), /runs sign twice/);
  assert.match(one("both", head("// After: sign", "// Runs: once, a contract deploy's read-back: no host deploy changes it")).join("\n"), /both\.mjs is in sign's list \(After\) and says Runs: once/);
  const late = `${head()}// After: sign\n`;
  assert.match(one("late", late).join("\n"), /late\.mjs is in no host's list and has no Runs line/);
});

test("a host's list loads only past good After lines: hostList refuses a check whose After line is wrong", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-after-"));
  try {
    mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
    writeFileSync(path.join(root, "scripts/live-checks/a.mjs"), head("// After: sign --host sign", "// After: sign", "// After: app"));
    writeFileSync(path.join(root, "scripts/live-checks/b.mjs"), head("// Runs: once, a contract deploy's read-back: no host deploy changes it"));
    writeFileSync(path.join(root, "scripts/live-checks/a.test.mjs"), head("// After: helper"));
    assert.deepEqual(hostList("sign", root), { checks: ["a"], args: { a: ["--host sign", ""] } });
    assert.deepEqual(hostList("helper", root), { checks: [], args: {} });
    writeFileSync(path.join(root, "scripts/live-checks/c.mjs"), head("// After: web"));
    assert.throws(() => hostList("app", root), /scripts\/live-checks\/c\.mjs: "After:" names web, which is no host/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
