// node --test scripts/live-checks/app-verify-mount.test.mjs: the live check's verdict replays recorded runs
// (app-verify-mount.answers.json), each read by app-verify-mount.mjs collect() in headless Chromium on the harness: the
// terminal built for testnet (VITE_NEAR_NETWORK=testnet) on APP_HOST's real name with the stand-in shell, the two
// testnet RPCs reached live.
//   good:       this card's build: Verify drawn from a live read of vault.bf-vt-20261102t071444.testnet on
//               test.rpc.fastnear.com (FastNEAR) and near-testnet.drpc.org (dRPC), every check ok at both widths: PASS;
//   mainnetNoVault: the same tree built for mainnet (VITE_NEAR_NETWORK unset), as APP_HOST serves it until the release
//               names the Nov 7 vault: every check Unverified, nothing read: FAIL.
// Both recorded on the PC box on 2 Nov 2026 (the answers' `at`). The red run before this card (main's build: no panel)
// is apps/terminal/test/verify-mount/run.mjs --build <main's build>.
// Each planted bad case is the good run with one thing changed, and fails on it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS, judge, WIDTHS } from "./app-verify-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-verify-mount.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: Verify read live on two operators, every check ok at both widths, the pill opens and closes it: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.network, "testnet");
  for (const w of WIDTHS) {
    const run = ANSWERS.good.runs.find((x) => x.width === w.name);
    assert.deepEqual(Object.keys(run.panel.checks).sort(), [...CHECKS].sort());
    assert.deepEqual(run.panel.rpcs, ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]);
    assert.ok(r.lines.includes(`ok  ${w.name} /verify: panel read, code ok, funds ok; checks ${CHECKS.map((c) => `${c} ok`).join(", ")}`), w.name);
  }
  assert.ok(r.lines.includes("ok  desktop /verify: the footer's Verify pill opens the panel, close returns to /"));
});

test("recorded bad answer: the mainnet build before the vault exists draws every check Unverified and reads nothing: FAIL", () => {
  const r = judge(ANSWERS.mainnetNoVault);
  assert.equal(r.ok, false);
  for (const w of WIDTHS) {
    assert.ok(bad(r).includes(`BAD ${w.name} /verify: panel unverified, code warn, funds warn; checks ${CHECKS.map((c) => `${c} warn`).join(", ")}`), w.name);
    assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w.name} /verify: this page read rpc.mainnet.fastnear.com 0 time(s)`)), w.name);
  }
});

test("planted: no Verify panel in the terminal's frame (main's build, before this card): FAIL", () => {
  const r = mut((rec) => rec.runs.forEach((run) => (run.panel = null)));
  assert.equal(r.ok, false);
  for (const w of WIDTHS) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w.name} /verify: no Verify panel`)), w.name);
});

test("planted: every check Unverified (a refused pair or a failed read): FAIL", () => {
  const r = mut((rec) => {
    for (const run of rec.runs) {
      Object.assign(run.panel, { state: "unverified", code: "warn", funds: "warn", block: "—" });
      for (const c of CHECKS) run.panel.checks[c] = "warn";
    }
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /panel unverified, code warn, funds warn/.test(l)));
  assert.ok(bad(r).some((l) => /block —/.test(l)));
});

test("planted: one check not ok, or RPCs disagree: FAIL", () => {
  assert.equal(mut((rec) => (rec.runs[0].panel.checks.balance = "danger")).ok, false);
  assert.equal(mut((rec) => (rec.runs[1].panel.checks.code = "warn")).ok, false);
  assert.equal(mut((rec) => (rec.runs[0].panel.state = "disagree")).ok, false);
  assert.equal(mut((rec) => delete rec.runs[1].panel.checks.keys).ok, false);
});

test("planted: two RPCs of one operator, or the other network's: FAIL", () => {
  const one = mut((rec) => (rec.runs[0].panel.rpcs = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"])); // near-rpc-operators: one operator (planted)
  assert.equal(one.ok, false);
  assert.ok(bad(one).some((l) => /\(fastnear, fastnear; testnet, testnet\)/.test(l)));
  const other = mut((rec) => (rec.network = "mainnet"));
  assert.equal(other.ok, false);
});

test("planted: rows drawn with no read of this page (a recording or a cache drawn as live): FAIL", () => {
  const none = mut((rec) => (rec.runs[0].requests = []));
  assert.equal(none.ok, false);
  assert.ok(bad(none).some((l) => /test\.rpc\.fastnear\.com 0 time\(s\)/.test(l)));
  const oneSide = mut((rec) => (rec.runs[1].requests = rec.runs[1].requests.filter((q) => !q.url.includes("drpc"))));
  assert.equal(oneSide.ok, false);
  const failed = mut((rec) => (rec.runs[0].requests.find((q) => q.url.includes("drpc")).status = 429));
  assert.equal(failed.ok, false);
});

test("planted: a CSP violation or a console error in the terminal's frame, the pill not opening, a width missing: FAIL", () => {
  assert.equal(mut((rec) => rec.runs[0].violations.push({ directive: "connect-src", blocked: "https://near-testnet.drpc.org" })).ok, false);
  assert.equal(mut((rec) => rec.runs[1].errors.push("boom")).ok, false);
  assert.equal(mut((rec) => (rec.runs.find((x) => x.width === "desktop").footer.opened = false)).ok, false);
  assert.equal(mut((rec) => (rec.runs.find((x) => x.width === "desktop").footer.closedTo = "/verify")).ok, false);
  assert.equal(mut((rec) => rec.runs.pop()).ok, false);
});
