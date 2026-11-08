// node --test scripts/live-checks/wallet-withdraw-move-out.test.mjs: the live check's verdict on its recorded answers,
// with no network. Each record is a real run of the check (2026-11-08 00:25Z; bad_handoff_drop 2026-11-08 00:13Z):
// - good: this card's build (index.html and public/app.js at the card's branch, --local) served at / and /app.js: PASS;
// - bad_live_before: the live SIGN_HOST before this card's release, whose script still routes nothing to the typed
//   account and shows no unmatched withdrawal: FAIL on the markers alone;
// - bad_handoff_drop: this card's build with `to: w.recipient` dropped from the hand-off (handoff.ts), which pays
//   the note's A again: FAIL on the hand-off marker alone (review of c19ad399, L1);
// - and the good record with its integrity naming another script, and with one marker gone: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HANDOFF_RE, judge, localFetch, MARKERS, probe, SIGN_ORIGIN } from "./wallet-withdraw-move-out.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "wallet-withdraw-move-out.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
const MARKS = "/app.js pays the typed account and shows an unmatched withdrawal";
const SAME = "/app.js is the script / names: its sha384 is the integrity";

test("the recorded good answer (the card's build) passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  for (const m of MARKERS) assert.ok(answers.good.app.markers[m] >= 1, m);
});

// the live read was made before card hosts-main-on-top moved SIGN_HOST to the main address: the record names its old
// child, sign. under it, as read then
test("the recorded live SIGN_HOST before the release fails, on the markers alone", () => {
  assert.equal(answers.bad_live_before.url, `https://sign.${new URL(SIGN_ORIGIN).host}`);
  assert.equal(judge(answers.bad_live_before).pass, false);
  assert.deepEqual(BAD(answers.bad_live_before), [MARKS]);
});

test("the good script under a page whose integrity names another script fails; one marker gone fails", () => {
  const other = structuredClone(answers.good);
  other.index.integrity = answers.bad_live_before.index.integrity;
  assert.deepEqual(BAD(other), [SAME]);
  for (const m of MARKERS) {
    const gone = structuredClone(answers.good);
    gone.app.markers[m] = 0;
    assert.deepEqual(BAD(gone), [MARKS], m);
  }
});

test("the committed build in this tree passes as the recorded good answer did", async () => {
  const rec = await probe(SIGN_ORIGIN, localFetch);
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
});

test("a build whose hand-off no longer passes the typed account fails, on the hand-off marker alone", () => {
  const m = answers.bad_handoff_drop;
  assert.equal(judge(m).pass, false);
  assert.deepEqual(BAD(m), [MARKS]);
  const hand = MARKERS[MARKERS.length - 1];
  assert.equal(m.app.markers[hand], 0);
  for (const k of MARKERS.slice(0, -1)) assert.ok(m.app.markers[k] >= 1, k);
  assert.equal(answers.good.app.markers[hand], 1, "the card's build holds the hand-off wiring once");
});

test("the hand-off pattern reads any minified name, and only the hand-off's own wiring", () => {
  const count = (t) => (t.match(HANDOFF_RE) ?? []).length;
  assert.equal(count("withdrawRequest({amount:c.amount,to:c.recipient,deadlineMs:Rt(n)})"), 1);
  assert.equal(count("{amount:$a.amount,to:_b.recipient,deadlineMs:1}"), 1);
  assert.equal(count("{amount:c.amount,deadlineMs:Rt(n)}"), 0);
  assert.equal(count("{amount:c.amount,to:c.account,deadlineMs:1}"), 0);
});
