// node --test scripts/live-checks/app-verify-mount.test.mjs: the release's pins against the vault deploy records as
// they are in this tree, and the live check's verdict on recorded runs (app-verify-mount.answers.json), each read by
// app-verify-mount.mjs collect() in headless Chromium on the harness: the terminal on APP_HOST's real name inside the
// stand-in shell, the release's NEAR RPCs reached live.
//   good:       this card's build for testnet (VITE_NEAR_NETWORK=testnet): Verify drawn from a live read of
//               vault.bf-vt-20261102t071444.testnet on test.rpc.fastnear.com (FastNEAR) and near-testnet.drpc.org
//               (dRPC), every check ok at both widths, each open leaving loading only once both RPCs answered it, every
//               NEAR request to the pair and of the release's accounts, and the pill's second open read afresh: PASS;
//   noVault:    the same tree built for mainnet (VITE_NEAR_NETWORK unset), as APP_HOST serves it until the mainnet vault
//               is deployed: every check Unverified, no RPC named, no NEAR request: PASS (that network's end state);
//   notMounted: the build of main before this card (Screen.tsx draws an empty main for /verify): FAIL, no panel;
//   cached:     this card's build with one change in VerifyRoute.tsx: each read kept in a module-level LAST and drawn at
//               once on the next open before it reads (`if (LAST) setView(LAST);`): FAIL, the pill's open leaves loading
//               before either RPC answered it.
// Each answer's `at` is when it was recorded. Each planted bad case is a recorded run with one thing changed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { APP_HOST, CHECKS, judge, onConsole, pinsOf, pinsProblems, releaseRecord, WIDTHS } from "./app-verify-mount.mjs";

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
  assert.ok(bad(cached).some((l) => /opens it again 1 time\(s\), starting read/.test(l)));
  const noReads = mut("good", (rec) => (desktop(rec).requests = desktop(rec).requests.filter((q) => q.phase !== "reopen")));
  assert.equal(noReads.ok, false);
  assert.ok(bad(noReads).some((l) => /^BAD desktop \/verify again: this page read test\.rpc\.fastnear\.com 0 time\(s\)/.test(l)));
  assert.equal(mut("good", (rec) => (desktop(rec).footer.panel = null)).ok, false);
  assert.equal(mut("good", (rec) => (desktop(rec).footer.panel.checks.balance = "warn")).ok, false);
});

test("recorded bad answer: the pill's open draws the last read at once, then reads (a module-level cache): FAIL", () => {
  const r = judge(ANSWERS.cached);
  assert.equal(r.ok, false);
  assert.match(ANSWERS.cached.source, /build-cached/);
  const d = desktop(ANSWERS.cached);
  // the panel is drawn loading and turns to the cached read before any answer: its first state alone does not show it
  assert.deepEqual(d.timeline.filter((e) => e.open === 1).map((e) => e.state), ["loading", "read"]);
  assert.ok(bad(r).some((l) => /^BAD desktop \/verify again: left loading for read at \d+ ms, 0 of 2 RPCs answered by then/.test(l)), r.lines.join("\n"));
  // the same run had the cached open's own read answered 200 before the close: only the timing refuses it
  const answered = mut("cached", (rec) => desktop(rec).requests.filter((q) => q.phase === "reopen").forEach((q) => (q.status = 200)));
  assert.equal(answered.ok, false);
  assert.deepEqual(bad(answered).map((l) => l.replace(/\d+ ms/, "N ms")), ["BAD desktop /verify again: left loading for read at N ms, 0 of 2 RPCs answered by then, 0 NEAR read(s) of this open still unanswered"]);
  // the first open of each width has nothing cached and passes
  assert.ok(r.lines.some((l) => /^ok  phone \/verify: left loading for read at \d+ ms, 2 of 2 RPCs answered by then, 0 NEAR read/.test(l)));
});

test("planted: an open that leaves loading before both RPCs answered it, or with a read of its own unanswered: FAIL", () => {
  const early = mut("good", (rec) => {
    const r = rec.runs[0];
    const leave = r.timeline.find((e) => e.open === 0 && e.state !== "loading");
    leave.t = Math.min(...r.rpcTiming.map((e) => e.end)) - 1;
  });
  assert.equal(early.ok, false);
  assert.ok(bad(early).some((l) => /^BAD phone \/verify: left loading for read at \d+ ms, \d of 2 RPCs answered by then/.test(l)));
  const pending = mut("good", (rec) => {
    const r = rec.runs[0];
    const leave = r.timeline.find((e) => e.open === 0 && e.state !== "loading");
    r.rpcTiming.push({ name: "https://near-testnet.drpc.org/", start: leave.t - 5, end: leave.t + 500 });
  });
  assert.equal(pending.ok, false);
  assert.ok(bad(pending).some((l) => /1 NEAR read\(s\) of this open still unanswered/.test(l)));
  assert.equal(mut("good", (rec) => (desktop(rec).timeline = desktop(rec).timeline.filter((e) => !(e.open === 1 && e.state === "loading")))).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].timeline = [])).ok, false);
  assert.equal(mut("good", (rec) => (rec.runs[0].rpcTiming = [])).ok, false);
});

test("planted: the pill's click drawing two panels, or the second open read from the wrong index: FAIL", () => {
  const twice = mut("good", (rec) => (desktop(rec).footer.newOpens = 2));
  assert.equal(twice.ok, false);
  assert.ok(bad(twice).some((l) => /opens it again 2 time\(s\)/.test(l)));
  assert.equal(mut("good", (rec) => delete desktop(rec).footer.newOpens).ok, false);
});

test("planted: a NEAR read of an account that is not the release's vault or asset: FAIL", () => {
  const other = mut("good", (rec) => (rec.runs[0].requests.find((q) => q.phase === "open" && q.account === rec.pins.vault).account = "vault.other.testnet"));
  assert.equal(other.ok, false);
  assert.ok(bad(other).some((l) => /^BAD phone \/verify: .*account vault\.other\.testnet in open/.test(l)));
  assert.equal(mut("good", (rec) => (desktop(rec).requests.find((q) => q.phase === "reopen" && q.account).account = null)).ok, false);
  for (const w of WIDTHS) {
    const posts = ANSWERS.good.runs.find((x) => x.width === w.name).requests.filter((q) => q.method === "POST");
    assert.ok(posts.length > 0 && posts.every((q) => [ANSWERS.good.pins.vault, ANSWERS.good.pins.asset].includes(q.account) && q.rpcId === "verify"), w.name);
  }
});

test("planted: stray NEAR requests between and after the opens: FAIL", () => {
  const post = (url, phase, rpcId = "other") => ({ url, method: "POST", type: "fetch", status: 200, phase, account: ANSWERS.good.pins.vault, rpcId });
  const cases = [
    ["noVault", "https://near.drpc.org/", "between", /no vault named: 1 NEAR request\(s\) over the whole run \(near\.drpc\.org in between\)/],
    ["noVault", "https://rpc.mainnet.fastnear.com/", "after", /no vault named: 1 NEAR request\(s\) over the whole run \(rpc\.mainnet\.fastnear\.com in after\)/], // near-rpc-operators: one operator (planted strays, one request each)
    ["good", "https://rpc.testnet.near.org/", "between", /rpc\.testnet\.near\.org \(not the pair\) in between/], // near-rpc-operators: one operator (planted strays, one request each)
    ["good", "https://test.rpc.fastnear.com/", "after", /a Verify read in after/, "verify"], // near-rpc-operators: one operator (planted strays, one request each)
    ["good", "https://rpc.mainnet.fastnear.com/", "after", /rpc\.mainnet\.fastnear\.com \(not the pair\) in after/], // near-rpc-operators: one operator (planted strays, one request each)
  ];
  for (const [name, url, phase, line, rpcId] of cases) {
    const r = mut(name, (rec) => desktop(rec).requests.push(post(url, phase, rpcId)));
    assert.equal(r.ok, false, `${name} ${url} ${phase}`);
    assert.ok(bad(r).some((l) => l.startsWith("BAD desktop /verify: ") && line.test(l)), `${name} ${url} ${phase}\n${bad(r).join("\n")}`);
  }
});

test("planted: any NEAR request with no vault named, or a panel naming an RPC it never asked: FAIL", () => {
  const post = (url) => ({ url, method: "POST", type: "fetch", status: 200, phase: "open", account: ANSWERS.good.pins.vault, rpcId: "verify" });
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

test("planted on the good answer: a recorded 429 names its resource's origin and path in the BAD line, and an error with no location still fails (card live-console-url)", () => {
  const text = "Failed to load resource: the server responded with a status of 429 ()";
  const msg = (t, location) => ({ type: () => "error", text: () => t, location: () => location });
  const kept = [];
  const hook = onConsole(kept);
  hook(msg(text, { url: `${APP_HOST}/assets/index-abc.js?v=1` }));
  hook(msg("the shell's own", { url: "https://sign.confidential.unrealized.trade/assets/shell.js" }));
  hook({ type: () => "warning", text: () => "a warning", location: () => ({ url: `${APP_HOST}/` }) });
  assert.deepEqual(kept, [`${text} (${APP_HOST}/assets/index-abc.js)`]);
  let r = mut("good", (rec) => rec.runs[1].errors.push(kept[0]));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.endsWith(`console ${text} (${APP_HOST}/assets/index-abc.js)`)), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("?v=1")), "no query in a line");
  r = mut("good", (rec) => rec.runs[0].errors.push("Uncaught boom"));
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.endsWith(": console Uncaught boom")), r.lines.join("\n"));
});
