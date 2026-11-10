// node --test scripts/live-checks/helper-ws-fragment-flood.test.mjs: the live check replays recorded answers
// (helper-ws-fragment-flood.answers.json). good: the card's helper run locally with stub tape reads: the flood closed
// 1008, the subscriber sent the tape: PASS. bad_base: the helper before the card (ws 8.17.1, no fragment bound) run the
// same way: it answered the ping after all 32 fragments: FAIL. bad_pre_push: the deployed helper on 10 Nov 00:58Z, before
// the push socket's deploy: 404 to both handshakes: FAIL. Each planted answer is the good one with one fault: a close with
// another code, a cut with no close frame, a flood no larger than the bound: FAIL; no answer, a 503, a subscriber with no
// frame: INCONCLUSIVE, never PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PUSH_IN_FRAGMENTS } from "../../apps/helper/src/data/push.ts";
import { CODE, flood, judge, SENT } from "./helper-ws-fragment-flood.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-ws-fragment-flood.answers.json"), "utf8"));
const planted = (edit) => {
  const a = structuredClone(A.good);
  edit(a);
  return judge(a);
};

test("the recorded answers are what the note says", () => {
  assert.equal(A.good.flood.end, CODE);
  assert.equal(A.bad_base.flood.end, "pong", "the helper before the card took every fragment and answered the ping");
  assert.equal(A.bad_pre_push.flood.status, 404, "the deployed helper had no push socket yet");
});

test("recorded good answer (the card's helper): PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad answer (the helper before the card, ws 8.17.1): FAIL, named", () => {
  const r = judge(A.bad_base);
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && l.includes("took them and stayed open")), r.lines.join("\n"));
});

test("recorded bad answer (the deployed helper before the push socket): FAIL", () => {
  assert.equal(judge(A.bad_pre_push).verdict, "FAIL");
});

test("planted: a close with another code (1009 maxPayload, 1001, 1005), or a cut with no close frame, fails", () => {
  for (const end of [1009, 1001, 1005, "cut"]) assert.equal(planted((a) => (a.flood.end = end)).verdict, "FAIL", String(end));
});

test("planted: a flood no larger than the bound proves nothing and fails", () => {
  assert.equal(planted((a) => (a.sent = PUSH_IN_FRAGMENTS)).verdict, "FAIL");
});

test("planted: a subscriber sent something that is not a tape fails", () => {
  assert.equal(planted((a) => (a.sub.frame = "<html>")).verdict, "FAIL");
  assert.equal(planted((a) => (a.sub.acceptOk = false)).verdict, "FAIL");
});

test("planted: no answer, a 429 or 503 at the handshake, or no frame in the wait is INCONCLUSIVE, never PASS", () => {
  assert.equal(planted((a) => (a.flood = { status: null, error: "ECONNRESET", sent: 0, tapes: 0, end: "none" })).verdict, "INCONCLUSIVE");
  assert.equal(planted((a) => (a.flood.end = "none")).verdict, "INCONCLUSIVE");
  for (const s of [429, 503]) assert.equal(planted((a) => (a.flood = { status: s, sent: 0, tapes: 0, end: null })).verdict, "INCONCLUSIVE", String(s));
  assert.equal(planted((a) => (a.sub = { status: null, error: "timeout", frame: null, frames: 0 })).verdict, "INCONCLUSIVE");
  assert.equal(planted((a) => (a.sub.frame = null)).verdict, "INCONCLUSIVE");
  assert.equal(planted((a) => ((a.flood.end = "pong"), (a.sub.frame = null))).verdict, "FAIL", "a wrong answer is a FAIL even beside a no-answer");
});

test("the flood is SENT one-byte fragments of one unfinished binary message, then a ping: a few hundred bytes", () => {
  const b = flood();
  assert.equal(SENT, 2 * PUSH_IN_FRAGMENTS);
  assert.equal(b.length, SENT * 7 + 6);
  const ops = [];
  for (let at = 0; at < b.length; at += 6 + (b[at + 1] & 0x7f)) ops.push([b[at] & 0x80 ? 1 : 0, b[at] & 0x0f, b[at + 1] & 0x7f]);
  assert.deepEqual(ops[0], [0, 0x2, 1], "the first: binary, not FIN, one byte");
  assert.ok(ops.slice(1, SENT).every((o) => o[0] === 0 && o[1] === 0 && o[2] === 1), "then continuations, none FIN");
  assert.deepEqual(ops.at(-1), [1, 0x9, 0], "then a ping");
  assert.equal(ops.length, SENT + 1);
});
