// node --test scripts/live-checks/move-sends-or-says-why.test.mjs: the live check replays its recorded answers
// (move-sends-or-says-why.answers.json). good: this card's SIGN_HOST build: PASS. bad: the same build of 43351a214, the
// card's base: FAIL, each fact named. liveBefore: SIGN_HOST as served before this card (the same bytes as bad): FAIL.
// facts() over planted text, each mark cut. Planted on the good answer: another /app.js, no pin, each fact taken away.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./move-sends-or-says-why.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./move-sends-or-says-why.answers.json", import.meta.url), "utf8"));
const SEND_BY = "BAD a move out of a pool is not written with a 5 min send-by before its quote: nothing bounds it";
const CLAIM = "BAD the run's claim does not refuse a move that ended or passed its send-by: a move shown failed could still send";
const EXPIRY = "BAD the follow does not end an unclaimed move failed at its send-by: Processing for good";
const RUNS = (n) => `BAD ${n} of the 2 pool runs claim before a release leaves`;

test("recorded good answer: this card's build bounds every Move out of a pool: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

for (const k of ["bad", "liveBefore"])
  test(`recorded bad answer ${k}: FAIL, each fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [SEND_BY, CLAIM, EXPIRY, RUNS(0)]);
  });

test("facts() reads each mark as minified, and each cut", () => {
  const js = [
    "iK=3e5,",
    "s={kind:`move`,from:t,to:r,stage:`leaving`,txs:[],amount:a,created_ms:o,send_by_ms:o+iK};",
    "if(r?.claimed_ms===void 0||r.stage===`failed`)throw Error(`the move may no longer send`)",
    "{...e,stage:`failed`,error:`not_sent`}",
    "take:async(t,i,a,o)=>{await e.claim?.(),await n.move(r.noteId,`HELD`,`RESERVED`,{})}",
    "await e.claim?.(),await n.move(r.noteId,`HELD`,`RESERVED`,{attempt:a})",
  ].join("");
  const f = (s) => {
    const { index: _i, sha384: _s, ...r } = facts("", s);
    return r;
  };
  assert.deepEqual(f(js), { sendBy: true, claim: true, expiry: true, runs: 2 });
  assert.equal(f(js.replace("iK=3e5,", "iK=6e5,")).sendBy, false, "another bound");
  assert.equal(f(js.replace("send_by_ms:o+iK", "send_by_ms:void 0")).sendBy, false, "no send-by");
  assert.equal(f(js.replace("r.stage===`failed`", "!1")).claim, false, "a claim that sends after the move failed");
  assert.equal(f(js.replace("error:`not_sent`", "error:`down`")).expiry, false);
  assert.equal(f(js.replace("await e.claim?.(),", "")).runs, 1, "one run sends with no claim");
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  const at = (p) => judge({ ...g, ...p }).lines;
  assert.deepEqual(at({ sha384: "sha384-other" }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(at({ index: "<html></html>" }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(at({ sendBy: false }), [SEND_BY]);
  assert.deepEqual(at({ claim: false }), [CLAIM]);
  assert.deepEqual(at({ expiry: false }), [EXPIRY]);
  assert.deepEqual(at({ runs: 1 }), [RUNS(1)]);
  assert.deepEqual(at({ runs: undefined }), [RUNS("no")]);
});
