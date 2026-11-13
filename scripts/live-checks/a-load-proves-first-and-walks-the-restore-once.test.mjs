// node --test scripts/live-checks/a-load-proves-first-and-walks-the-restore-once.test.mjs: the live check replays its
// recorded answers (a-load-proves-first-and-walks-the-restore-once.answers.json). good: this card's SIGN_HOST build:
// PASS. bad: main 63cdf7cb4's build: FAIL. Planted on the good one: another /app.js, no pin, each mark taken away: each
// FAIL. Planted in a bundle: the resume's wait gone, its bound changed, the walks' pauses changed, the walk choice gone:
// each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./a-load-proves-first-and-walks-the-restore-once.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./a-load-proves-first-and-walks-the-restore-once.answers.json", import.meta.url), "utf8"));
const NO_FIRST = "BAD a load's restore reads beside its first proof pass: the first proof waits on the restore's reads";
const NO_WALKS = "BAD a load walks every pool again while step 5 is owed: a returning device walks four chains on every load";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: main 63cdf7cb4's build: FAIL, each path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_FIRST, NO_WALKS]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, first: false }).lines, [NO_FIRST]);
  assert.deepEqual(judge({ ...g, walks: false }).lines, [NO_WALKS]);
});

test("planted in a bundle: each mark broken in place FAILs", () => {
  const js = [
    "written:()=>void a?.proofs().catch(()=>{}),firstPass:()=>a?.firstPass()??Promise.resolve(),ux:e=>1",
    "for(e.firstPass&&await r(e.firstPassMaxMs??2e4,e.firstPass());;){}",
    "q0=Object.freeze([0,3e4,12e4,3e5,6e5])",
    "g=e=>{if(a?.walks===void 0)return`walk`;let t=a.walks[e.scope.toString()];return t}",
  ].join(";");
  const at = (s) => facts("", s);
  assert.deepEqual([at(js).first, at(js).walks], [true, true]);
  assert.equal(at(js.replace("firstPass:()=>a?.firstPass()??Promise.resolve(),", "")).first, false, "the host's first passes not handed");
  assert.equal(at(js.replace("e.firstPass&&await ", "")).first, false, "the resume does not wait");
  assert.equal(at(js.replace("2e4", "6e4")).first, false, "another bound");
  assert.equal(at(js.replace("[0,3e4,12e4,3e5,6e5]", "[0,0,0,0,0]")).walks, false, "a failed walk asked on every load");
  assert.equal(at(js.replace("if(a?.walks===void 0)return`walk`;", "")).walks, false, "no walk choice");
});
