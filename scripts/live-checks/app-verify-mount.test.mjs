// node --test scripts/live-checks/app-verify-mount.test.mjs: the release's pins against the vault deploy records as
// they are in this tree, and the live check's verdict on recorded runs (app-verify-mount.answers.json), each read by
// app-verify-mount.mjs collect() in headless Chromium on the harness: the terminal on APP_HOST's real name inside the
// stand-in shell, the release's NEAR RPCs reached live.
//   good:       this card's build for testnet (VITE_NEAR_NETWORK=testnet): Verify drawn from a live read of
//               vault.bf-vt-20261102t071444.testnet on test.rpc.fastnear.com (FastNEAR) and near-testnet.drpc.org
//               (dRPC), every check ok at both widths, and the pill's second open read afresh: PASS;
//   noVault:    the same tree built for mainnet (VITE_NEAR_NETWORK unset), as APP_HOST serves it until the mainnet vault
//               is deployed: every check Unverified, no RPC named, no NEAR request: PASS (that network's end state);
//   notMounted: the build of main before this card (Screen.tsx draws an empty main for /verify): FAIL, no panel.
// Each answer's `at` is when it was recorded. Each planted bad case is a recorded run with one thing changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { CHECKS, judge, pinsOf, pinsProblems, releaseRecord, WIDTHS } from "./app-verify-mount.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-verify-mount.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (name, f) => {
  const rec = structuredClone(ANSWERS[name]);
  f(rec);
  return judge(rec);
};
const desktop = (rec) => rec.runs.find((x) => x.width === "desktop");

test("the release's pins are each network's vault deploy record, and none exactly where no record exists", () => {
  for (const [network, r] of Object.entries(VERIFY_RELEASES)) {
    assert.deepEqual(pinsProblems(network, pinsOf(r.pins), releaseRecord(network)), [], network);
  }
  assert.equal(releaseRecord("testnet").account_id, VERIFY_RELEASES.testnet.pins.vault);
  assert.equal(releaseRecord("mainnet"), null);
});

test("a deploy record that moves, appears or goes, against the release's pins, is a problem", () => {
  const rec = releaseRecord("testnet");
  const pins = pinsOf(VERIFY_RELEASES.testnet.pins);
  assert.deepEqual(pinsProblems("testnet", pins, { ...rec, account_id: "vault.other.testnet" }), [`release.ts vault ${pins.vault}, the deploy record vault.other.testnet`]);
  assert.equal(pinsProblems("testnet", pins, { ...rec, asset: "usdc.other.testnet" }).length, 1);
  assert.equal(pinsProblems("testnet", pins, { ...rec, code_hash: "11111111111111111111111111111111" }).length, 1);
  assert.equal(pinsProblems("testnet", pins, { ...rec, network: "mainnet" }).length, 1);
  assert.match(pinsProblems("mainnet", null, { network: "mainnet", account_id: "vault.near", asset: "a", code_hash: "c" })[0], /release\.ts names none/);
  assert.match(pinsProblems("testnet", pins, null)[0], /no deploy record exists/);
});

test("recorded good answer: Verify read live on two operators, every check ok at both widths, read again on the pill's open: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.network, "testnet");
  assert.deepEqual(ANSWERS.good.pins, pinsOf(VERIFY_RELEASES.testnet.pins));
  for (const w of WIDTHS) {
    const run = ANSWERS.good.runs.find((x) => x.width === w.name);
    assert.deepEqual(run.panel.rpcs, ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]);
    assert.ok(r.lines.includes(`ok  ${w.name} /verify: panel read, code ok, funds ok; checks ${CHECKS.map((c) => `${c} ok`).join(", ")}`), w.name);
  }
  const d = desktop(ANSWERS.good);
  assert.equal(d.footer.firstState, "loading");
  for (const u of d.panel.rpcs) assert.ok(d.requests.some((q) => q.phase === "reopen" && q.method === "POST" && q.url.startsWith(u) && q.status === 200), u);
  assert.ok(r.lines.includes("ok  desktop /verify again: panel read, code ok, funds ok; checks " + CHECKS.map((c) => `${c} ok`).join(", ")));
});

test("recorded good answer, mainnet with no vault yet: every check Unverified, no RPC named, no NEAR request: PASS", () => {
  const r = judge(ANSWERS.noVault);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual([ANSWERS.noVault.network, ANSWERS.noVault.pins, ANSWERS.noVault.record], ["mainnet", null, null]);
  for (const w of WIDTHS) assert.ok(r.lines.includes(`ok  ${w.name} /verify: no vault named: the panel names no RPC; 0 request(s) to a NEAR RPC`), w.name);
});

test("recorded bad answer: main's build mounts no Verify: FAIL", () => {
  const r = judge(ANSWERS.notMounted);
  assert.equal(r.ok, false);
  for (const w of WIDTHS) assert.ok(bad(r).some((l) => l.startsWith(`BAD ${w.name} /verify: no Verify panel`)), w.name);
});

test("planted: the deploy record moved while release.ts did not, or names a vault the run did not have: FAIL", () => {
  const moved = mut("good", (rec) => (rec.record.account_id = "vault.other.testnet"));
  assert.equal(moved.ok, false);
  assert.ok(bad(moved).some((l) => /release\.ts vault vault\.bf-vt-20261102t071444\.testnet, the deploy record vault\.other\.testnet/.test(l)));
  assert.equal(mut("noVault", (rec) => (rec.record = { network: "mainnet", account_id: "vault.near", asset: "a", code_hash: "c" })).ok, false);
  assert.equal(mut("good", (rec) => delete rec.record).ok, false);
});

test("planted: the pill's second open starts from the last read, or reads nothing afresh: FAIL", () => {
  const cached = mut("good", (rec) => (desktop(rec).footer.firstState = "read"));
  assert.equal(cached.ok, false);
  assert.ok(bad(cached).some((l) => /opens it again, starting read/.test(l)));
  const noReads = mut("good", (rec) => (desktop(rec).requests = desktop(rec).requests.filter((q) => q.phase !== "reopen")));
  assert.equal(noReads.ok, false);
  assert.ok(bad(noReads).some((l) => /^BAD desktop \/verify again: this page read test\.rpc\.fastnear\.com 0 time\(s\)/.test(l)));
  assert.equal(mut("good", (rec) => (desktop(rec).footer.panel = null)).ok, false);
  assert.equal(mut("good", (rec) => (desktop(rec).footer.panel.checks.balance = "warn")).ok, false);
});

test("planted: any NEAR request with no vault named, or a panel naming an RPC it never asked: FAIL", () => {
  const post = (url) => ({ url, method: "POST", type: "fetch", status: 200, phase: "open" });
  // a POST to a NEAR RPC the panel does not name (not one of the release's pair)
  assert.equal(mut("noVault", (rec) => rec.runs[0].requests.push(post("https://rpc.mainnet.near.org/"))).ok, false);
  // a panel naming no RPC while the page asks near.drpc.org
  const silent = mut("noVault", (rec) => rec.runs[1].requests.push(post("https://near.drpc.org/")));
  assert.equal(silent.ok, false);
  assert.ok(bad(silent).some((l) => /names no RPC; 1 request\(s\) to a NEAR RPC \(near\.drpc\.org\)/.test(l)));
  // the panel names a pair with no vault named
  assert.equal(mut("noVault", (rec) => (rec.runs[0].panel.rpcs = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"])).ok, false);
  // with a vault named, a POST to a third NEAR RPC
  assert.equal(mut("good", (rec) => rec.runs[0].requests.push(post("https://rpc.testnet.near.org/"))).ok, false);
});

test("planted: the testnet pair on a mainnet run, two RPCs of one operator, the other network's record: FAIL", () => {
  const crossed = mut("good", (rec) => {
    rec.network = "mainnet";
    rec.record = { network: "mainnet", account_id: rec.record.account_id, asset: rec.record.asset, code_hash: rec.record.code_hash };
  });
  assert.equal(crossed.ok, false);
  assert.ok(bad(crossed).some((l) => /\(fastnear, drpc; testnet, testnet\), want two operators on mainnet/.test(l)));
  const one = mut("good", (rec) => (rec.runs[0].panel.rpcs = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"])); // near-rpc-operators: one operator (planted)
  assert.equal(one.ok, false);
  assert.ok(bad(one).some((l) => /\(fastnear, fastnear; testnet, testnet\)/.test(l)));
});

test("planted: every check Unverified, one check not ok, or RPCs disagree, with a vault named: FAIL", () => {
  assert.equal(mut("good", (rec) => rec.runs.forEach((run) => Object.assign(run.panel, { state: "unverified", code: "warn", funds: "warn" }))).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].panel.checks.balance = "danger")).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[1].panel.checks.code = "warn")).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].panel.state = "disagree")).ok, false);
  assert.equal(mut("good", (rec) => delete rec.runs[1].panel.checks.keys).ok, false);
  assert.equal(mut("noVault", (rec) => (rec.runs[1].panel.checks.keys = "ok")).ok, false);
});

test("planted: rows drawn with no read of this open, a failed read, a CSP violation, a console error, a missing width: FAIL", () => {
  assert.equal(mut("good", (rec) => (rec.runs[0].requests = rec.runs[0].requests.filter((q) => q.phase !== "open"))).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].requests.find((q) => q.phase === "open" && q.url.includes("drpc")).status = 429)).ok, false);
  assert.equal(mut("good", (rec) => rec.runs[0].violations.push({ directive: "connect-src", blocked: "https://near-testnet.drpc.org" })).ok, false);
  assert.equal(mut("good", (rec) => rec.runs[1].errors.push("boom")).ok, false);
  assert.equal(mut("good", (rec) => (desktop(rec).footer.closedTo = "/verify")).ok, false);
  assert.equal(mut("good", (rec) => rec.runs.pop()).ok, false);
  assert.equal(mut("good", (rec) => rec.runs.forEach((run) => (run.panel = null))).ok, false);
});
