// node --test scripts/live-checks/solana-written-accounts-whole.test.mjs: the live check replays its recorded answers
// (solana-written-accounts-whole.answers.json, its _note says where each was read). good: this card's SIGN_HOST build:
// PASS. bad: SIGN_HOST as served before this card: FAIL. planted: the good bundle with the field list cut to owner and
// amount (P1), the providers agreeing on amount alone (P2), the wSOL refusal dead (P3): each FAIL on its mark. Planted
// on good: another /app.js, no pin, each mark missing: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKS, facts, judge } from "./solana-written-accounts-whole.mjs";

const A = JSON.parse(readFileSync(new URL("./solana-written-accounts-whole.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle has no rule: ${k}`;
const [FIELDS, AGREE, WSOL] = Object.keys(MARKS);

test("recorded good answer: this card's build carries every rule: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before this card carries none of them: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), Object.keys(MARKS).map(no));
});

test("recorded planted bundles P1, P2, P3: each FAIL on the rule it breaks", () => {
  assert.deepEqual(bads(judge(A.planted["P1 the field list cut to owner and amount"])), [no(FIELDS)]);
  assert.deepEqual(bads(judge(A.planted["P2 the providers agree on amount alone"])), [no(AGREE)]);
  assert.deepEqual(bads(judge(A.planted["P3 the wSOL refusal dead"])), [no(WSOL)]);
});

test("planted on good: another app.js, no pin, each mark missing: each FAIL", () => {
  const with_ = (f) => { const a = structuredClone(A.good); f(a); return bads(judge(a)); };
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of Object.keys(MARKS)) assert.deepEqual(with_((a) => { a.carries[k] = false; }), [no(k)], k);
  assert.equal(judge(null).ok, false);
});

test("facts reads each mark by the bundle's shape", () => {
  const js = [
    "id=[[`mint`,0,32],[`owner`,32,64],[`amount`,64,72],[`delegate`,72,108],[`state`,108,109],[`is_native`,109,121],[`delegated_amount`,121,129],[`close authority`,129,165]]",
    "Nd=(e,t)=>e.owner===t.owner&&e.lamports===t.lamports&&$u(e.data.subarray(0,165),t.data.subarray(0,165))",
    "!c||n.length?o.push(`the wallet's wSOL account ${e.key} is left with its ${n.join(`, `)} changed`):a+=c.lamports",
    "i.length&&o.push(`the wallet's account of the token ${e.key} is left with its ${i.join(`, `)} changed`)",
    "c.lamports!==l.lamports)&&o.push(`the wallet's account ${e.key} moves: ${u}`)",
  ].join(";");
  assert.deepEqual(Object.values(facts("", js).carries), Object.values(MARKS).map(() => true));
  assert.deepEqual(Object.values(facts("", "").carries), Object.values(MARKS).map(() => false));
  assert.equal(facts("", js.replace("e.lamports===t.lamports&&", "")).carries[AGREE], false);
});
