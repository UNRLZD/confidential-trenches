// node --test scripts/live-checks/pool-restore-wired.test.mjs: the live check's verdict replays recorded runs
// (pool-restore-wired.answers.json), each read on 6 Nov by pool-restore-wired.mjs collect():
//   good: --local, this card's signing page build served as SIGN_HOST under its own _headers: signed out restore is
//         refused, the published vector's words sign in, the run with no tap ends done, and restore is answered started
//         with progress reading then done: PASS;
//   bad:  live SIGN_HOST on release-53, before this card: restore refused not_allowed signed in too, and no run with
//         no tap: FAIL.
// Planted from the good run: a run that stalls, one that never ends, a second run with no tap, an answer that is not
// started, a restore answered while signed out. Card sign-live-checks-read-a-pinned-page: live111 (below), and the
// pinned hosts' cases planted at the end. Card restore-first-sign-in-under-two-minutes: step 5 after done, planted on
// live111 at the end.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./pool-restore-wired.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "pool-restore-wired.answers.json"), "utf8"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: this card's build answers restore and runs it once after the words: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: live SIGN_HOST before this card refuses restore and runs none: FAIL", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /ran one restore with no tap/);
  fails(r, /answered started/);
});

test("planted: a stalled or endless run, a second run with no tap, another answer, a signed-out run: FAIL", () => {
  fails(mut((rec) => (rec.steps.asked.stages = ["reading", "stalled"])), /never stalled/);
  fails(mut((rec) => (rec.steps.asked.stages = ["reading"])), /ends done/);
  fails(mut((rec) => (rec.steps.auto.state.ops[0].stage = "reading")), /ended done/);
  fails(mut((rec) => rec.steps.auto.state.ops.push({ ...rec.steps.auto.state.ops[0], id: "x" })), /ran one restore/);
  fails(mut((rec) => (rec.steps.asked.answer = { v: 1, id: rec.steps.asked.answer.id, ok: false, error: { code: "not_allowed" } })), /answered started/);
  fails(mut((rec) => (rec.steps.signedOut.answer = { v: 1, id: "x", ok: true, result: { stage: "started" } })), /signed out/);
  fails(mut((rec) => (rec.steps.signedIn = null)), /sign SIGN_HOST in/);
  fails(mut((rec) => rec.errors.push("no words field")), /no error/);
});

// Card sign-live-checks-read-a-pinned-page: the pinned mainnet page reads its pool on the hosts its own connect-src names
// (PINNED_HOSTS); every other host, a pinned host its served connect-src does not name, and the page's own "restore
// stalled" line still fail. The wait and the done rule are unchanged.
test("planted: a stray host, a pinned host the page's connect-src does not name, a stalled line: FAIL; the pinned hosts in it: PASS", () => {
  const pinned = (rec) => {
    rec.hosts = { "confidential.unrealized.trade": 3, "ct-app.unrealized.trade": 2, "ct-api.unrealized.trade": 4, "solana-rpc.publicnode.com": 9, "rpc.mainnet.fastnear.com": 7 };
    rec.connect = ["ct-api.unrealized.trade", "solana-rpc.publicnode.com", "rpc.mainnet.fastnear.com", "near.drpc.org"];
  };
  const ok = mut(pinned);
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  fails(mut((rec) => (pinned(rec), (rec.hosts["evil.example"] = 1))), /every request goes to .*stray: evil\.example/);
  fails(mut((rec) => (pinned(rec), (rec.hosts["api.mainnet-beta.solana.com"] = 1))), /stray: api\.mainnet-beta\.solana\.com/);
  fails(mut((rec) => (pinned(rec), (rec.connect = rec.connect.filter((h) => h !== "rpc.mainnet.fastnear.com")))), /not in its connect-src: rpc\.mainnet\.fastnear\.com/);
  fails(mut((rec) => (pinned(rec), (rec.connect = null))), /not in its connect-src: ct-api/);
  fails(mut((rec) => rec.requests.push({ host: "evil.example", path: "/" })), /stray: evil\.example/);
  fails(mut((rec) => (rec.console = ["warning: restore stalled: lane 3: 1 id unread (both providers refused)"])), /the page logged no stalled restore \(warning: restore stalled: lane 3/);
  fails(mut((rec) => ((rec.requests = []), (rec.hosts = {}))), /every request goes to .*\(none\)/);
});

// live111: the live page on release 111 (the mainnet Solana pool pinned), this card's check, 10 Nov 20:03Z: every
// request on SIGN_HOST, APP_HOST and the pinned hosts its connect-src names, and the restore still reading at WAIT_MS
// (step 5's 168 ids at the providers' pace): FAIL on done alone, until card restore-first-sign-in-under-two-minutes.
test("recorded live run on release 111: the hosts line passes, and it fails on done alone (still reading)", () => {
  const r = judge(ANSWERS.live111);
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0]), [
    "BAD the sign-in on an empty store ran one restore with no tap, and it ended done",
    "BAD its progress reads, then ends done, never stalled",
    // card restore-first-sign-in-under-two-minutes: on release 111 the run is never done, so no read is after done
    "BAD after done, step 5 reads on: id reads to both NEAR operators",
  ]);
  assert.ok(r.lines.some((l) => l.startsWith("OK  every request goes to SIGN_HOST, APP_HOST or a pinned pool's host the page's own connect-src names (") && l.includes("rpc.mainnet.fastnear.com")), r.lines.join("\n"));
  const x = structuredClone(ANSWERS.live111);
  x.hosts["api.mainnet-beta.solana.com"] = 1;
  assert.ok(judge(x).lines.some((l) => l.startsWith("BAD every request goes to") && l.includes("stray: api.mainnet-beta.solana.com")));
});

// Card restore-first-sign-in-under-two-minutes: a restore is done at the walk's end and step 5 reads on after it, so a
// live run (live111's hosts, made done as this card makes it) passes only with id reads on both NEAR operators after
// done; the page's `restore ids unread:` lines are printed and fail nothing; a local build is not judged on it.
test("planted: a live run done with step 5's id reads after it on both NEAR operators: PASS; one operator or none: FAIL", () => {
  const live = (after) => {
    const rec = structuredClone(ANSWERS.live111);
    rec.steps.auto = structuredClone(ANSWERS.good.steps.auto);
    rec.steps.asked = structuredClone(ANSWERS.good.steps.asked);
    if (after !== undefined) rec.afterDone = after;
    return rec;
  };
  const ok = judge(live({ "rpc.mainnet.fastnear.com": 9, "near.drpc.org": 11 }));
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  assert.ok(ok.lines.includes("OK  after done, step 5 reads on: id reads to both NEAR operators (rpc.mainnet.fastnear.com 9, near.drpc.org 11)"), ok.lines.join("\n"));
  const fail = (rec, re) => {
    const r = judge(rec);
    assert.equal(r.ok, false, r.lines.join("\n"));
    assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0]), ["BAD after done, step 5 reads on: id reads to both NEAR operators"]);
    assert.ok(r.lines.some((l) => re.test(l)), r.lines.join("\n"));
  };
  fail(live({ "rpc.mainnet.fastnear.com": 9, "near.drpc.org": 0 }), /near\.drpc\.org 0/);
  fail(live({ "rpc.mainnet.fastnear.com": 0, "near.drpc.org": 4 }), /rpc\.mainnet\.fastnear\.com 0/);
  fail(live(undefined), /rpc\.mainnet\.fastnear\.com 0, near\.drpc\.org 0/);
  fail(live({ "rpc.mainnet.fastnear.com": "9", "near.drpc.org": 11 }), /after done/);
  // a step 5 read asked again is printed with the line and fails nothing
  const asked = live({ "rpc.mainnet.fastnear.com": 9, "near.drpc.org": 11 });
  asked.console = ["warning: restore ids unread: try 1, asked again: solana: lane 2: 1 id unread (HTTP 503)"];
  const a = judge(asked);
  assert.equal(a.ok, true, a.lines.join("\n"));
  assert.ok(a.lines.some((l) => l.startsWith("OK  after done") && l.includes("restore ids unread: try 1")), a.lines.join("\n"));
  // a local build serves no pinned host: not judged there
  assert.ok(!judge(ANSWERS.good).lines.some((l) => l.includes("after done")));
});
