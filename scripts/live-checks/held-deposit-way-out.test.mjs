// node --test scripts/live-checks/held-deposit-way-out.test.mjs: the live check's verdict on its recorded answers, with
// no network. Each record is a real run of the check (2026-11-08):
// - good: this card's build (index.html and public/app.js at the card's branch, --local) served at / and /app.js: PASS;
// - bad_live_before: the live SIGN_HOST before this card's release, whose held screen's Withdraw is refused
//   (withdraw.open with from_id not built): FAIL on the markers alone;
// - and the good record with its integrity naming another script, and with each marker gone: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as check from "./held-deposit-way-out.mjs";
import { judge, localFetch, MARKERS, probe, SIGN_ORIGIN } from "./held-deposit-way-out.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "held-deposit-way-out.answers.json"), "utf8"));
const BAD = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0].slice(4));
const MARKS = "/app.js offers a held deposit's way out";
const SAME = "/app.js is the script / names: its sha384 is the integrity";

test("the recorded good answer (the card's build) passes", () => {
  const r = judge(answers.good);
  assert.equal(r.pass, true, r.lines.join("\n"));
  for (const m of MARKERS) assert.ok(answers.good.app.markers[m] >= 1, m);
});

test("the recorded live SIGN_HOST before the release fails, on the markers alone", () => {
  // the record was read before card hosts-main-on-top moved SIGN_HOST to the main name: its URL is the main name's
  // child, sign. under it, as read then
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

test("the check has the shape scripts/ci/bundle-checks.mjs runs: read(fetch) on SIGN_HOST, then judge", async () => {
  assert.equal(typeof check.read, "function");
  const asked = [];
  const rec = await check.read((u, o) => (asked.push(new URL(String(u)).origin), localFetch(u, o)));
  assert.deepEqual([...new Set(asked)], [SIGN_ORIGIN]);
  assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
});
