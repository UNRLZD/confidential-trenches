// node --test scripts/ci/live-listed.test.mjs: every live check is in a host's after-deploy list or says why not
// (scripts/ci/live-listed.mjs), on the tree as it is, and each planted failure is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listedProblems, readTree, runsLines } from "./live-listed.mjs";

const head = (...lines) => `#!/usr/bin/env node\n// Live check of card x: what it reads.\n${lines.map((l) => `${l}\n`).join("")}import "../net-window.mjs";\n`;
const one = (key, text, listed = new Map()) => listedProblems({ [key]: text }, listed);

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
  assert.deepEqual(one("b", head("// Runs: once, a contract deploy's read-back: no host deploy changes it")), []);
  assert.deepEqual(one("c", head("// Runs: pending helper-robinhood-capacity")), []);
  assert.deepEqual(one("d", head("// Runs: pending helper-robinhood-capacity, the tapes answer 429 on what is deployed")), []);
});

test("planted: a check in no list with no Runs line is refused", () => {
  assert.match(one("planted", head("//   node scripts/live-checks/planted.mjs")).join("\n"), /planted\.mjs is in no host's list .* and has no Runs line/);
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
  assert.match(one("j", head("// Runs: once, a contract deploy's read-back: no host deploy changes it"), new Map([["j", ["sign"]]])).join("\n"), /is in sign's list and says Runs: once/);
  assert.match(one("k", head("// Runs: once, a contract deploy's read-back: no host deploy changes it", "// Runs: pending helper-robinhood-capacity")).join("\n"), /has 2 Runs lines/);
  assert.match(listedProblems({}, new Map([["gone", ["helper"]]])).join("\n"), /helper list gone, which is no file/);
});
