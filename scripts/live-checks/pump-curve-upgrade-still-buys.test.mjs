// node --test scripts/live-checks/pump-curve-upgrade-still-buys.test.mjs: the live check replays its recorded answers
// (pump-curve-upgrade-still-buys.answers.json). good: this card's SIGN_HOST build (reads a Global of 1,088 bytes or
// more) with pump's Global read at 1,096 bytes on both mainnet RPCs after the 13 Nov upgrade: PASS. bad: SIGN_HOST as
// served on 13 Nov 21:0xZ (a 1,088-only exact check) with the same reads: FAIL. Planted on the good one: another
// /app.js, no pin, no size check, an exact size, a mainnet Global under the minimum, the RPCs disagreeing, a wrong
// answer: each FAIL; a no-answer INCONCLUSIVE; and the rule parser on minified lines of each shape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { globalRule, judge, judgeBundle } from "./pump-curve-upgrade-still-buys.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pump-curve-upgrade-still-buys.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build reads Global from 1,088 bytes up, mainnet's is 1,096: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.global, { rule: "min", size: 1088 });
  assert.deepEqual(ANSWERS.good.globalSizes, [1096, 1096]);
});

test("recorded bad answer: today's SIGN_HOST pins Global at an exact size: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines, ["BAD the served bundle pins pump Global at an exact size"]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  const lines = (a) => judge(a).lines;
  assert.deepEqual(lines({ ...g, sha384: "sha384-other" }), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(lines({ ...g, index: "<html></html>" }), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(lines({ ...g, global: null }), ["BAD the served bundle has no check of pump Global's size"]);
  assert.deepEqual(lines({ ...g, global: { rule: "exact" } }), ["BAD the served bundle pins pump Global at an exact size"]);
  assert.deepEqual(lines({ ...g, globalSizes: [1080, 1080] }), ["BAD pump Global is 1080 bytes on mainnet, under the served bundle's minimum of 1088"]);
  assert.deepEqual(lines({ ...g, globalSizes: [1096, 1104] }), ["BAD the RPCs read pump Global at different sizes: 1096, 1104"]);
  assert.deepEqual(lines({ ...g, globalSizes: [1096, 0] }), ["BAD 1 RPC(s) answered with no pump Global"]);
  assert.equal(judge({ ...g, globalSizes: [1088, 1088] }).verdict, "PASS");
  assert.equal(judge({ ...g, globalSizes: [1200, 1200] }).verdict, "PASS");
  assert.equal(judge(null).verdict, "FAIL");
});

test("an RPC that answers nothing usable is INCONCLUSIVE, never PASS, and never hides a bad build", () => {
  const g = ANSWERS.good;
  const v = judge({ ...g, globalSizes: [1096, null], noAnswers: ["solana-rpc.publicnode.com HTTP 429: 429 Too Many Requests"] });
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.deepEqual(v.lines, ["--  solana-rpc.publicnode.com HTTP 429: 429 Too Many Requests", "--  pump Global read on 1 of 2 RPCs: INCONCLUSIVE"]);
  assert.equal(judge({ ...g, globalSizes: [1096] }).verdict, "INCONCLUSIVE");
  assert.equal(judge({ ...ANSWERS.bad, globalSizes: [null, null] }).verdict, "FAIL");
});

test("on a build alone (bundle-checks): the good build PASSes, the exact-size one FAILs", () => {
  assert.deepEqual(judgeBundle(ANSWERS.good), { ok: true, lines: [] });
  assert.deepEqual(judgeBundle(ANSWERS.bad).lines, ["BAD the served bundle pins pump Global at an exact size"]);
  assert.deepEqual(judgeBundle({ ...ANSWERS.good, global: { rule: "min", size: 1104 } }).lines, ["BAD the bundle's minimum of 1104 refuses the 1096-byte Global"]);
});

test("the rule parser reads each minified shape", () => {
  // this card's build, the one before it (an exact pair) and SIGN_HOST's (one exact size), as the minifier spelled them
  const min = "function Qp(e,t=!1){if(Yd(e),e.data.length<1088)throw Error(`pump Global is ${e.data.length} bytes, under ${Xp}`);let n=1}";
  const pair = "Yp=[1088,1096];function Zp(e,t=!1){if(Jd(e),!Yp.includes(e.data.length))throw Error(`pump Global is ${e.data.length} bytes, not ${Yp.join(` or `)}`);let n=1}";
  const one = "function Yp(e,t=!1){if(qd(e),e.data.length!==1088)throw Error(`pump Global is ${e.data.length} bytes, not ${qp}`);let n=1}";
  assert.deepEqual(globalRule(min), { rule: "min", size: 1088 });
  assert.deepEqual(globalRule(pair), { rule: "exact" });
  assert.deepEqual(globalRule(one), { rule: "exact" });
  assert.equal(globalRule("no check here"), null);
  assert.equal(globalRule(min + min), null, "a repeated refusal");
  assert.deepEqual(globalRule(min.replace("e.data.length<1088", "t.data.length<1088")), { rule: "exact" }, "another account's length is no minimum");
});
