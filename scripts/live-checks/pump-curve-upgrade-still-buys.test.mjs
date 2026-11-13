// node --test scripts/live-checks/pump-curve-upgrade-still-buys.test.mjs: the live check replays its recorded answers
// (pump-curve-upgrade-still-buys.answers.json). good: this card's SIGN_HOST build (accepts a Global of 1,088 or 1,096
// bytes) with pump's Global read at 1,096 bytes on both mainnet RPCs after the 13 Nov upgrade: PASS. bad: SIGN_HOST as
// served on 13 Nov 20:3xZ (main f7f20cdaf's era, a 1,088-only check) with the same reads: FAIL. Planted on the good
// one: another /app.js, no pin, no size check, one RPC unread, the RPCs disagreeing, a later Global size: each FAIL;
// and the size parser on minified lines of both shapes and on lines it must not read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { acceptedSizes, judge } from "./pump-curve-upgrade-still-buys.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pump-curve-upgrade-still-buys.answers.json", import.meta.url), "utf8"));

test("recorded good answer: this card's build accepts the 1,096-byte Global mainnet holds: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.accepts, [1088, 1096]);
  assert.deepEqual(ANSWERS.good.globalSizes, [1096, 1096]);
});

test("recorded bad answer: the served 1,088-only build against mainnet's 1,096-byte Global: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD pump Global is 1096 bytes on mainnet and the served bundle accepts only 1088"]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, accepts: null }).lines, ["BAD the served bundle has no check of pump Global's size"]);
  assert.deepEqual(judge({ ...g, accepts: [] }).lines, ["BAD the served bundle has no check of pump Global's size"]);
  assert.deepEqual(judge({ ...g, globalSizes: [1096, null] }).lines, ["BAD pump Global was not read on both RPCs"]);
  assert.deepEqual(judge({ ...g, globalSizes: [1096] }).lines, ["BAD pump Global was not read on both RPCs"]);
  assert.deepEqual(judge({ ...g, globalSizes: [1096, 1104] }).lines, ["BAD the RPCs read pump Global at different sizes: 1096, 1104"]);
  assert.deepEqual(judge({ ...g, globalSizes: [1104, 1104] }).lines, ["BAD pump Global is 1104 bytes on mainnet and the served bundle accepts only 1088 or 1096"]);
  assert.equal(judge(null).ok, false);
});

test("the size parser reads both minified shapes and nothing else", () => {
  // this card's build and the build before it, as the minifier spelled them
  const list = "x=5,Yp=[1088,1096],Xp=Object.freeze({});function Zp(e,t=!1){if(Jd(e),!Yp.includes(e.data.length))throw Error(`pump Global is ${e.data.length} bytes, not ${Yp.join(` or `)}`);let n=1}";
  const one = "qp=1088,Jp=1;function Yp(e,t=!1){if(qd(e),e.data.length!==1088)throw Error(`pump Global is ${e.data.length} bytes, not ${qp}`);let n=1}";
  assert.deepEqual(acceptedSizes(list), [1088, 1096]);
  assert.deepEqual(acceptedSizes(one), [1088]);
  assert.equal(acceptedSizes("no check here"), null);
  assert.equal(acceptedSizes(list + list.replace("Zp", "Zq")), null, "a repeated refusal");
  assert.equal(acceptedSizes(list.replace("Yp=[1088,1096],", "")), null, "a list defined nowhere");
  assert.equal(acceptedSizes(list.replace("Yp=[1088,1096],", "Yp=[1088,1096],a.Yp=[1],Yp=[7],")), null, "a list defined twice");
  assert.equal(acceptedSizes(list.replace("!Yp.includes(e.data.length)", "!Yp.includes(t.data.length)")), null, "another account's length");
});
