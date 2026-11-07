// node --test scripts/live-checks/solana-legs-checked.test.mjs: the live check replays its recorded answers
// (solana-legs-checked.answers.json, its _note says where each was read). good: this card's SIGN_HOST build, which
// carries S6's leg refusals and S11's on the wallet's other accounts: PASS. bad: SIGN_HOST as served before this card:
// FAIL. Planted on good: another /app.js, no pin, each refusal missing: each FAIL. And the words it looks for are the
// kit's own: each is in packages/kit/src/checks/solana/checks.ts, so a rewording there fails here first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WORDS, facts, judge } from "./solana-legs-checked.mjs";

const A = JSON.parse(readFileSync(new URL("./solana-legs-checked.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));

test("recorded good answer: this card's build carries every refusal: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before this card carries none of them: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), Object.keys(WORDS).map((k) => `BAD the served bundle has no refusal: ${k}`));
});

test("planted on good: another app.js, no pin, each refusal missing: each FAIL", () => {
  const with_ = (f) => { const a = structuredClone(A.good); f(a); return bads(judge(a)); };
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of Object.keys(WORDS)) assert.deepEqual(with_((a) => { a.carries[k] = false; }), [`BAD the served bundle has no refusal: ${k}`], k);
  assert.equal(judge(null).ok, false);
});

test("facts reads the bundle; the words are the kit's own", () => {
  const src = readFileSync(new URL("../../packages/kit/src/checks/solana/checks.ts", import.meta.url), "utf8");
  for (const [k, w] of Object.entries(WORDS)) assert.ok(src.includes(w), `${k}: "${w}" is not in the kit's checks`);
  const f = facts('<script type="module" src="/app.js" integrity="sha384-x"></script>', Object.values(WORDS).join(" "));
  assert.deepEqual(Object.values(f.carries), Object.values(WORDS).map(() => true));
  assert.deepEqual(Object.values(facts("", "").carries), Object.values(WORDS).map(() => false));
});
