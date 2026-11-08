// node --test scripts/live-checks/evm-sell-unfunded-sim-keeps-route.test.mjs: the live check replays its recorded answers
// (evm-sell-unfunded-sim-keeps-route.answers.json, its _note says where each was read). good: SIGN_HOST as served, no EVM
// sell quote in it: PASS. good_quote: the kit's sell quote bundled at this card's fix: PASS. bad: the same at the commit
// before it, the short branch dropping the routes: FAIL on that line of the guard alone. Planted on good_quote: each line
// of the guard missing, another /app.js, no pin, no quotes field: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GUARD, QUOTE, facts, judge } from "./evm-sell-unfunded-sim-keeps-route.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-sell-unfunded-sim-keeps-route.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle quotes a sale without the guard: ${k}`;
const SKIP = "a sender too low to pay the sim keeps every route, none dropped, and the quote says the sim was skipped";

test("recorded good answer: SIGN_HOST as served quotes no EVM sale: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.ok(v.lines.includes("ok  the served bundle carries no EVM sell quote: it quotes no sale"));
});

test("recorded good answer: the kit's sell quote at this card's fix carries every line of the guard: PASS", () => {
  const v = judge(A.good_quote);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(A.good_quote.quotes, true);
});

test("recorded bad answer: the kit's sell quote before this card drops the routes a short sender cannot sim: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), [no(SKIP)]);
});

test("planted on good_quote: each line of the guard gone, another app.js, no pin, no quotes field: each FAIL", () => {
  const with_ = (f) => {
    const a = structuredClone(A.good_quote);
    f(a);
    return bads(judge(a));
  };
  for (const k of Object.keys(GUARD)) assert.deepEqual(with_((a) => { a.carries[k] = false; }), [no(k)], k);
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(with_((a) => { delete a.quotes; }), ["BAD the answer does not say whether the bundle carries the EVM sell quote"]);
  assert.equal(judge(null).ok, false);
});

test("facts finds the quote by any of its refusals and each line of the guard in any of the minifier's quotes", () => {
  for (const q of ["`", '"', "'"]) {
    const guard = `[{to:x,data:${q}0x4d2301cc${q}+s}]);if(v.kind!==${q}out${q}||v.amountOut<m*h)return{routes:s,sim:${q}skipped${q}};`;
    for (const b of QUOTE) {
      const f = facts("", `x(\`${b}\`);${guard}`);
      assert.equal(f.quotes, true, b);
      assert.deepEqual(Object.values(f.carries), Object.values(GUARD).map(() => true), q);
    }
    assert.equal(facts("", guard).quotes, false);
  }
  // the short branch as it was before this card: the routes filtered, no sim said
  const before = facts("", `${QUOTE[0]};data:\`0x4d2301cc\`+s;if(v.kind!==\`out\`||v.amountOut<m*h)return s.filter(e=>!u.includes(e));`);
  assert.deepEqual(before.carries, { ...Object.fromEntries(Object.keys(GUARD).map((k) => [k, true])), [SKIP]: false });
  // a branch that says skipped and filters the routes is no guard
  assert.equal(facts("", `{routes:s.filter(e=>!u.includes(e)),sim:\`skipped\`}`).carries[SKIP], false);
});
