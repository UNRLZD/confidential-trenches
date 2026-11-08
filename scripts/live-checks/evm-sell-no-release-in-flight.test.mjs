// node --test scripts/live-checks/evm-sell-no-release-in-flight.test.mjs: the live check replays its recorded answers
// (evm-sell-no-release-in-flight.answers.json, its _note says where each was read). good: SIGN_HOST as served, no EVM
// sell builder in it: PASS. good_builder: the kit's sell builder bundled at this card's commit: PASS. bad: the same at
// the commit before it, the builder without the guard: FAIL on every line of the guard. Planted on good_builder: each
// line of the guard missing, another /app.js, no pin, no builds field: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILDER, GUARD, facts, judge } from "./evm-sell-no-release-in-flight.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-sell-no-release-in-flight.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle builds a sale without the guard: ${k}`;

test("recorded good answer: SIGN_HOST as served builds no EVM sale: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.ok(v.lines.includes("ok  the served bundle carries no EVM sell builder: it builds and signs no sale"));
});

test("recorded good answer: the kit's sell builder at this card's commit carries every line of the guard: PASS", () => {
  const v = judge(A.good_builder);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(A.good_builder.builds, true);
});

test("recorded bad answer: the kit's sell builder before this card builds a sale with no guard: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(bads(v), Object.keys(GUARD).map(no));
});

test("planted on good_builder: each line of the guard gone, another app.js, no pin, no builds field: each FAIL", () => {
  const with_ = (f) => {
    const a = structuredClone(A.good_builder);
    f(a);
    return bads(judge(a));
  };
  for (const k of Object.keys(GUARD)) assert.deepEqual(with_((a) => { a.carries[k] = false; }), [no(k)], k);
  assert.deepEqual(with_((a) => { a.sha384 = "sha384-x"; }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(with_((a) => { a.index = "<!doctype html>"; }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(with_((a) => { delete a.builds; }), ["BAD the answer does not say whether the bundle carries the EVM sell builder"]);
  assert.equal(judge(null).ok, false);
});

test("facts finds the builder by any of its refusals and each line of the guard by its text", () => {
  const guard = Object.values(GUARD).join(";");
  for (const b of BUILDER) {
    const f = facts("", `x(\`${b}\`);${guard}`);
    assert.equal(f.builds, true, b);
    assert.deepEqual(Object.values(f.carries), Object.values(GUARD).map(() => true));
  }
  assert.equal(facts("", guard).builds, false);
  assert.deepEqual(Object.values(facts("", BUILDER[0]).carries), Object.values(GUARD).map(() => false));
});
