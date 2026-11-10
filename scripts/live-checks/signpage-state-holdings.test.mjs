// node --test scripts/live-checks/signpage-state-holdings.test.mjs: the live check's verdict on its recorded answers,
// with no network. Each record is a real run of the check (2026-11-09 22:2xZ, re-recorded with the positions marks):
// - good: this card's build (index.html and public/app.js at the card's branch, --local) served at / and /app.js: PASS;
// - bad_live_before: the live SIGN_HOST before this card's release, whose state sends vault_balance "0" and
//   positions [] on every signed-in state (src/state.ts stateOf): FAIL on the marks alone;
// - bad_review_build: the build the review rejected (d50dd0ce, --local), whose pass named a stranger's token and read
//   every W, and whose sell waited behind it: FAIL on the run's marks;
// - and the good record with its integrity naming another script, and with each mark gone: each FAIL. A planted build
//   whose state read starts no pass, or whose cache runs none, fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./signpage-state-holdings.mjs";
import { COSTS, FILL, FIRST, judge, KEPT, localFetch, PASS, PREEMPT, probe, RECORDS, RUN, SET, SIGN_ORIGIN, SOLD, SUM } from "./signpage-state-holdings.mjs";
import { copyChange, dropRule, plantedFetch } from "./planted-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-state-holdings.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
const MARKS = "/app.js fills vault_balance from the device's own notes";
const SAME = "/app.js is the script / names: its sha384 is the integrity";
const POS = "/app.js fills positions from the device's own pass, with its cost";
const RUNS = "/app.js runs the pass from the state read, on the device's buy records, stopped by a sell's read";

test("the recorded good answer (the card's build) passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  const m = answers.good.app.marks;
  assert.ok(m.sum >= 1 && m.fill >= 1 && m.set >= 1 && m.pass >= 1 && m.costs >= 1 && m.kept >= 1 && m.sold >= 1 && m.first >= 1 && m.run >= 1 && m.records >= 1 && m.preempt >= 1);
});

test("the recorded live SIGN_HOST before the release fails, on the marks alone", () => {
  assert.equal(answers.bad_live_before.url, SIGN_ORIGIN);
  assert.equal(judge(answers.bad_live_before).pass, false);
  assert.deepEqual(BAD(answers.bad_live_before), [MARKS, POS, RUNS]);
});

test("the recorded build the review rejected fails, on the run's marks", () => {
  assert.equal(judge(answers.bad_review_build).pass, false);
  assert.deepEqual(BAD(answers.bad_review_build), [RUNS]);
});

test("the good script under a page whose integrity names another script fails; each mark gone fails", () => {
  const other = structuredClone(answers.good);
  other.index.integrity = answers.bad_live_before.index.integrity;
  assert.deepEqual(BAD(other), [SAME]);
  for (const k of ["sum", "fill"]) {
    const gone = structuredClone(answers.good);
    gone.app.marks[k] = 0;
    assert.deepEqual(BAD(gone), [MARKS], k);
  }
  for (const k of ["set", "pass", "costs", "kept", "sold"]) {
    const gone = structuredClone(answers.good);
    gone.app.marks[k] = 0;
    assert.deepEqual(BAD(gone), [POS], k);
  }
  for (const k of ["first", "run", "records", "preempt"]) {
    const gone = structuredClone(answers.good);
    gone.app.marks[k] = 0;
    assert.deepEqual(BAD(gone), [RUNS], k);
    delete gone.app.marks[k];
    assert.deepEqual(BAD(gone), [RUNS], `${k} not read`);
  }
});

test("the committed build in this tree passes the live rule", async () => {
  const rec = await probe(SIGN_ORIGIN, localFetch);
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
});

test("a rebuilt bundle with an unrelated copy change passes with no re-record; one with vault_balance back at `0` fails", async () => {
  const copy = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => copyChange(js, [SUM, FILL, SET, PASS, COSTS, KEPT, SOLD, FIRST, RUN, RECORDS, PREEMPT])));
  assert.equal(judge(copy).pass, true, judge(copy).lines.join("\n"));
  assert.notEqual(copy.app.sha384, (await probe(SIGN_ORIGIN, localFetch)).app.sha384, "another bundle than the tree's");
  // the state step's fill replaced by the fixed "0" the build before it sent
  const zero = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(FILL, "vault_balance:`0`")));
  assert.equal(zero.app.marks.fill, 0);
  assert.deepEqual(BAD(zero), [MARKS]);
  const noSum = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => dropRule(js, SUM)));
  assert.equal(noSum.app.marks.sum, 0);
  assert.deepEqual(BAD(noSum), [MARKS]);
  // the state step's positions back to the [] the build before it sent; the pass's cost back to "0"
  const none = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(SET, "{}")));
  assert.equal(none.app.marks.set, 0);
  assert.deepEqual(BAD(none), [POS]);
  const noCost = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(PASS, (m) => m.replace(/cost:[\w$]+\($/, "cost:`0`,x:("))));
  assert.equal(noCost.app.marks.pass, 0);
  assert.deepEqual(BAD(noCost), [POS]);
  // no kept pass (a reload waits on the finder again): red
  const noKept = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => dropRule(js, KEPT)));
  assert.equal(noKept.app.marks.kept, 0);
  assert.deepEqual(BAD(noKept), [POS]);
  // a build with no pass: the state read never starts one, or the cache never runs one
  const noFirst = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(FIRST, (m, c) => `positions:async()=>(await ${c}.ready(),${c}.get())`)));
  assert.equal(noFirst.app.marks.first, 0);
  assert.deepEqual(BAD(noFirst), [RUNS]);
  const noRun = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(RUN, "Promise.resolve({positions:[],whole:!0})")));
  assert.equal(noRun.app.marks.run, 0);
  assert.deepEqual(BAD(noRun), [RUNS]);
  // every W read, not only the recorded ones; a sell that does not stop the pass
  const allWs = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(RECORDS, ".wallets(new Set())")));
  assert.deepEqual(BAD(allWs), [RUNS]);
  const noStop = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(PREEMPT, "wallets:async()=>{")));
  assert.deepEqual(BAD(noStop), [RUNS]);
});

test("the check has the shape scripts/ci/bundle-checks.mjs runs: read(fetch) on SIGN_HOST, then judge", async () => {
  assert.equal(typeof check.read, "function");
  const asked = [];
  const rec = await check.read((u, o) => (asked.push(new URL(String(u)).origin), localFetch(u, o)));
  assert.deepEqual([...new Set(asked)], [SIGN_ORIGIN]);
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
});
