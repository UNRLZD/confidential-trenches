// node --test scripts/live-checks/signpage-state-holdings.test.mjs: the live check's verdict on its recorded answers,
// with no network. Each record is a real run of the check:
// - good: this card's build (index.html and public/app.js at the card's branch, --local). No release list names it
//   yet (it is cut after the merge), so it is judged against a ledger that names its bundle, standing for the release
//   that will; once SIGN_HOST serves that release, `good` is re-recorded from SIGN_HOST (--record) and judged against
//   the real ledger, with no stand-in;
// - bad_release_110: SIGN_HOST at release-110 (2026-11-10 03:38Z), the last release before this card: FAIL on the
//   ledger and on the marks;
// - bad_live_before: SIGN_HOST before the card's first build, whose state sent vault_balance "0" and positions [];
// - bad_review_build: the build the first review rejected (d50dd0ce, --local): FAIL on the ledger and the run's marks;
// - and the good record served with no release naming it: FAIL on the ledger alone, which is what tells a build that
//   keeps every shape and breaks what they do (the second review's seven broken builds) from the card's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./signpage-state-holdings.mjs";
import { COSTS, FILL, FIRST, FIRST_RELEASE, judge, KEPT, localFetch, PASS, PREEMPT, probe, RECORDS, releasedAppJs, RUN, SET, SIGN_ORIGIN, SOLD, SUM } from "./signpage-state-holdings.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { copyChange, dropRule, plantedFetch } from "./planted-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-state-holdings.answers.json"), "utf8"));
const BAD = (rec, o) => judge(rec, o).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
const LEDGER = `/app.js is a release from release-${FIRST_RELEASE} on, a build of the source this card's tests hold`;
/** The good answer's ledger: the real one once it is SIGN_HOST's record, else one naming its bundle (see the header). */
const goodLedger = answers.good.url === SIGN_ORIGIN ? {} : { released: new Map([[answers.good.app.sha384, `release-${FIRST_RELEASE}`]]) };
const NO_LEDGER = { ledger: false };
const MARKS = "/app.js fills vault_balance from the device's own notes";
const SAME = "/app.js is the script / names: its sha384 is the integrity";
const POS = "/app.js fills positions from the device's own pass, with its cost";
const RUNS = "/app.js runs the pass from the state read, on the device's buy records, stopped by a sell's read";

test("the recorded good answer (the card's build) passes", () => {
  const r = judge(answers.good, goodLedger);
  assert.equal(r.pass, true, r.lines.join("\n"));
  const m = answers.good.app.marks;
  assert.ok(m.sum >= 1 && m.fill >= 1 && m.set >= 1 && m.pass >= 1 && m.costs >= 1 && m.kept >= 1 && m.sold >= 1 && m.first >= 1 && m.run >= 1 && m.records >= 1 && m.preempt >= 1);
});

test("the recorded SIGN_HOST at release-110, the last release before this card, fails: no release of the card's on, and no positions", () => {
  assert.equal(answers.bad_release_110.url, SIGN_ORIGIN);
  assert.equal(judge(answers.bad_release_110).pass, false);
  assert.deepEqual(BAD(answers.bad_release_110), [LEDGER, POS, RUNS]);
});

test("the recorded live SIGN_HOST before the card's first build fails, on the ledger and the marks", () => {
  assert.equal(answers.bad_live_before.url, SIGN_ORIGIN);
  assert.equal(judge(answers.bad_live_before).pass, false);
  assert.deepEqual(BAD(answers.bad_live_before), [LEDGER, MARKS, POS, RUNS]);
});

test("the recorded build the first review rejected fails, on the ledger and the run's marks", () => {
  assert.equal(judge(answers.bad_review_build).pass, false);
  assert.deepEqual(BAD(answers.bad_review_build), [LEDGER, RUNS]);
});

test("the good build served with no release naming it fails on the ledger alone: the marks cannot tell a broken build that keeps them", () => {
  assert.deepEqual(BAD(answers.good), [LEDGER]);
  assert.deepEqual(BAD(answers.good, { released: new Map([[answers.bad_release_110.app.sha384, "release-110"]]) }), [LEDGER], "a release before the card's");
});

test("the ledger: SIGN_HOST's /app.js of every release list from release-${FIRST_RELEASE} on, and none before", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssh-ledger-"));
  const list = (n, sha) => writeFileSync(path.join(dir, `release-${n}.json`), JSON.stringify({ release: `release-${n}`, hosts: { SIGN_HOST: { files: [{ path: "/", sha384: "sha384-index" }, { path: "/app.js", sha384: sha }] }, APP_HOST: { files: [{ path: "/app.js", sha384: "sha384-app" }] } } }));
  list(FIRST_RELEASE - 1, "sha384-before");
  list(FIRST_RELEASE, "sha384-card");
  list(FIRST_RELEASE + 1, "sha384-later");
  assert.deepEqual(releasedAppJs(dir), new Map([["sha384-card", `release-${FIRST_RELEASE}`], ["sha384-later", `release-${FIRST_RELEASE + 1}`]]));
  assert.equal(releasedAppJs().has(answers.bad_release_110.app.sha384), false, "release-110, cut before this card, is not in it");
});

test("the good script under a page whose integrity names another script fails; each mark gone fails", () => {
  const other = structuredClone(answers.good);
  other.index.integrity = answers.bad_live_before.index.integrity;
  assert.deepEqual(BAD(other, goodLedger), [SAME]);
  for (const k of ["sum", "fill"]) {
    const gone = structuredClone(answers.good);
    gone.app.marks[k] = 0;
    assert.deepEqual(BAD(gone, goodLedger), [MARKS], k);
  }
  for (const k of ["set", "pass", "costs", "kept", "sold"]) {
    const gone = structuredClone(answers.good);
    gone.app.marks[k] = 0;
    assert.deepEqual(BAD(gone, goodLedger), [POS], k);
  }
  for (const k of ["first", "run", "records", "preempt"]) {
    const gone = structuredClone(answers.good);
    gone.app.marks[k] = 0;
    assert.deepEqual(BAD(gone, goodLedger), [RUNS], k);
    delete gone.app.marks[k];
    assert.deepEqual(BAD(gone, goodLedger), [RUNS], `${k} not read`);
  }
});

test("the build of this tree passes the marks and the pin (its release is cut after its merge)", async () => {
  const rec = await probe(SIGN_ORIGIN, localFetch);
  assert.equal(judge(rec, NO_LEDGER).pass, true, judge(rec, NO_LEDGER).lines.join("\n"));
});

test("a rebuilt bundle with an unrelated copy change passes with no re-record; one with vault_balance back at `0` fails", async () => {
  const copy = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => copyChange(js, [SUM, FILL, SET, PASS, COSTS, KEPT, SOLD, FIRST, RUN, RECORDS, PREEMPT])));
  assert.equal(judge(copy, NO_LEDGER).pass, true, judge(copy, NO_LEDGER).lines.join("\n"));
  assert.notEqual(copy.app.sha384, (await probe(SIGN_ORIGIN, localFetch)).app.sha384, "another bundle than the tree's");
  // the state step's fill replaced by the fixed "0" the build before it sent
  const zero = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(FILL, "vault_balance:`0`")));
  assert.equal(zero.app.marks.fill, 0);
  assert.deepEqual(BAD(zero, NO_LEDGER), [MARKS]);
  const noSum = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => dropRule(js, SUM)));
  assert.equal(noSum.app.marks.sum, 0);
  assert.deepEqual(BAD(noSum, NO_LEDGER), [MARKS]);
  // the state step's positions back to the [] the build before it sent; the pass's cost back to "0"
  const none = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(SET, "{}")));
  assert.equal(none.app.marks.set, 0);
  assert.deepEqual(BAD(none, NO_LEDGER), [POS]);
  const noCost = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(PASS, (m) => m.replace(/cost:[\w$]+\($/, "cost:`0`,x:("))));
  assert.equal(noCost.app.marks.pass, 0);
  assert.deepEqual(BAD(noCost, NO_LEDGER), [POS]);
  // no kept pass (a reload waits on the finder again): red
  const noKept = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => dropRule(js, KEPT)));
  assert.equal(noKept.app.marks.kept, 0);
  assert.deepEqual(BAD(noKept, NO_LEDGER), [POS]);
  // a build with no pass: the state read never starts one, or the cache never runs one
  const noFirst = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(FIRST, "positions:()=>Promise.resolve(null)")));
  assert.equal(noFirst.app.marks.first, 0);
  assert.deepEqual(BAD(noFirst, NO_LEDGER), [RUNS]);
  const noRun = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(RUN, "Promise.resolve({positions:[],whole:!0})")));
  assert.equal(noRun.app.marks.run, 0);
  assert.deepEqual(BAD(noRun, NO_LEDGER), [RUNS]);
  // every W read, not only the recorded ones; a sell that does not stop the pass
  const allWs = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(RECORDS, ".wallets(new Set())")));
  assert.deepEqual(BAD(allWs, NO_LEDGER), [RUNS]);
  const noStop = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(PREEMPT, "wallets:async()=>{")));
  assert.deepEqual(BAD(noStop, NO_LEDGER), [RUNS]);
  // a sell's read that fails never ends its hold (the second review's P2-2): the passes wait for the next sell
  const noRelease = await probe(SIGN_ORIGIN, plantedFetch(localFetch, (js) => js.replace(PREEMPT, (m) => m.replace(/\?[\w$]+\.release\(\):/, "?0:"))));
  assert.equal(noRelease.app.marks.preempt, 0);
  assert.deepEqual(BAD(noRelease, NO_LEDGER), [RUNS]);
});

test("the check has the shape scripts/ci/bundle-checks.mjs runs: read(fetch) on SIGN_HOST, then judge", async () => {
  assert.equal(typeof check.read, "function");
  const asked = [];
  const rec = await check.read((u, o) => (asked.push(new URL(String(u)).origin), localFetch(u, o)));
  assert.deepEqual([...new Set(asked)], [SIGN_ORIGIN]);
  assert.equal(judge(rec, NO_LEDGER).pass, true, judge(rec, NO_LEDGER).lines.join("\n"));
});
