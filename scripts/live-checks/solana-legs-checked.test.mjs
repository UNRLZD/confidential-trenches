// node --test scripts/live-checks/solana-legs-checked.test.mjs: the live check replays its recorded answers
// (solana-legs-checked.answers.json, its _note says where each was read). good: card solana-written-accounts-whole's
// SIGN_HOST build, whose S6 walks every route account with both refusals live, and S11's two: PASS. bad: SIGN_HOST as
// served before card solana-legs-checked: FAIL. planted: the good bundle with S6's walk starting past every account (A),
// its wallet-account refusal dead (B), the walk removed (C): each FAIL on the mark it breaks (the review of f46305b9
// found A and B passing the word search this check was). Planted on good: another /app.js, no pin, each mark missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKS, facts, judge } from "./solana-legs-checked.mjs";

const A = JSON.parse(readFileSync(new URL("./solana-legs-checked.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle has no refusal: ${k}`;
const [WALK, WALLET, UNREAD] = Object.keys(MARKS);

test("recorded good answer: this card's build carries every refusal: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before card solana-legs-checked carries none of them: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), Object.keys(MARKS).map(no));
});

test("recorded planted bundles A, B, C: a walk past every account, a dead refusal, no walk: each FAIL", () => {
  assert.deepEqual(bads(judge(A.planted["A the walk starts past every account"])), [no(WALK)]);
  assert.deepEqual(bads(judge(A.planted["B the wallet-account refusal dead"])), [no(WALLET)]);
  assert.deepEqual(bads(judge(A.planted["C the walk removed"])), [no(WALK), no(WALLET), no(UNREAD)]);
});

test("planted on good: another app.js, no pin, each mark missing: each FAIL", () => {
  const with_ = (f) => { const a = structuredClone(A.good); f(a); return bads(judge(a)); };
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of Object.keys(MARKS)) assert.deepEqual(with_((a) => { a.carries[k] = false; }), [no(k)], k);
  assert.equal(judge(null).ok, false);
});

test("facts reads each mark by the bundle's shape, not its words alone", () => {
  const s6 = "for(let t of e.ixs[e.jupAt].accounts){if(!t.writable||t.key===n.source.key)continue;let r=l[t.key];r?r.some(t=>rd(t,e.req.wallet))&&c.push(`leg account ${t.key} is a token account of the wallet's`):c.push(`leg account ${t.key} is not read`)}";
  const s11 = "moves: ${u} is not read back";
  assert.deepEqual(Object.values(facts("", s6 + s11).carries), Object.values(MARKS).map(() => true));
  // the words with no live code: S11's "which the tx writes, is not read`" and dead text satisfy no S6 mark
  const words = "`${o}, which the tx writes, is not read` 0&&c.push(`leg account ${t.key} is a token account of the wallet's`) " + s11;
  assert.deepEqual(facts("", words).carries, { [WALK]: false, [WALLET]: false, [UNREAD]: false, ...Object.fromEntries(Object.keys(MARKS).slice(3).map((k) => [k, true])) });
  assert.equal(facts("", s6.replace(".accounts){", ".accounts.slice(10)){") + s11).carries[WALK], false);
});
