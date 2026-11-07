// node --test scripts/live-checks/pool-answer-unknown.test.mjs: the live check replays its recorded answers
// (pool-answer-unknown.answers.json). good: this card's SIGN_HOST build: PASS. bad: main d57ecfb9's build (release-72):
// FAIL. liveBefore: SIGN_HOST before this card's deploy (release-72; its landed and paced facts read from the same
// bundle, by its sha384, after the delta review r2 added them): FAIL. Planted on the good one: another /app.js,
// no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-answer-unknown.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-answer-unknown.answers.json", import.meta.url), "utf8"));
const NO_UNREAD = "BAD a pool deposit whose read back does not check out after its send is answered failed: the app shows a deposit that may land as failed";
const NO_ONE = "BAD a pool deposit whose mark only one RPC holds is built again or stuck: a deposit that landed may be asked again";
const NO_PICK = "BAD a vault buy or sell whose provider read fails at the pick is answered failed: the app takes an outage as a no";
const NO_RECORD = "BAD a vault buy whose blockhash, mint or build read fails before signing is answered failed: the app takes an outage as a no";
const NO_LANDED = "BAD a pool deposit rung that landed with no tx named is left out of the answer: the app shows money that arrived as failed";
const NO_PACED = "BAD the kit's pacing calls the bare provider past the page's fault watch: a vault buy's provider outage answers failed";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each path named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [NO_UNREAD, NO_ONE, NO_PICK, NO_RECORD, NO_LANDED, NO_PACED]);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, unread: false }).lines, [NO_UNREAD]);
  assert.deepEqual(judge({ ...g, one: false }).lines, [NO_ONE]);
  assert.deepEqual(judge({ ...g, pick: false }).lines, [NO_PICK]);
  assert.deepEqual(judge({ ...g, record: false }).lines, [NO_RECORD]);
  assert.deepEqual(judge({ ...g, landed: false }).lines, [NO_LANDED]);
  assert.deepEqual(judge({ ...g, paced: false }).lines, [NO_PACED]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from a bundle", () => {
  const js =
    "catch(e){if(e instanceof NN)return e.code===`not_landed`?{stage:`not_landed`,txs:c}:s.length?{stage:`part_filled`,txs:s}:e.code===`failed`&&u().length?{stage:`sent`,txs:u()}:{error:`failed`}}" +
    "return t===`one`?`pending`:(await x(a,t),`taken`);" +
    "catch(e){if(!d)return u(e instanceof pm?`down`:`failed`);throw e}" +
    "if(!d)return l(g&&!_&&w===`failed`?`down`:w);" +
    "o!==null&&s.push({chain:`solana`,hash:o}),n&&c++,e.landed?.(r),n&&e.progress?.(`filled`);" +
    "if(c)return{stage:`part_filled`,txs:s};if(d().length)return{stage:`sent`,txs:d()};" +
    "a.started=!0;let c=Kp;Kp=r;try{return e(n,t)}finally{Kp=c,a.t=Jp()}" +
    "i=(n,i)=>{if(Kp===r)return e(n,i);let a=$p(e,t,n);return a.wait?a.wait.then(()=>a.run(i)):a.run(i)}";
  const f = facts("", js);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, unread: true, one: true, pick: true, record: true, landed: true, paced: true });
  assert.equal(facts("", js.replace("e.code===`failed`&&u().length?{stage:`sent`,txs:u()}:", "")).unread, false);
  assert.equal(facts("", js.replace("t===`one`?`pending`:", "")).one, false);
  assert.equal(facts("", js.replace("e instanceof pm?`down`:`failed`", "`failed`")).pick, false);
  assert.equal(facts("", js.replace("g&&!_&&w===`failed`?`down`:w", "g&&!_?`down`:w")).record, false);
  // the count, never the signing flag or the list (card pool-answer-unknown, delta review r2): a part_filled on another
  // name, or with no count bumped, FAILs
  assert.equal(facts("", js.replace("if(c)return{stage:`part_filled`", "if(g)return{stage:`part_filled`")).landed, false);
  assert.equal(facts("", js.replace("if(c)return{stage:`part_filled`", "if(s)return{stage:`part_filled`")).landed, false);
  assert.equal(facts("", js.replace("n&&c++,", "")).landed, false);
  assert.equal(facts("", js.replace("txs:s};if(d()", "txs:[]};if(d()")).landed, false);
  // the slot calls the bare provider (d57ecfb9: try{return n(...)} with no queue marked), or the paced wrapper never
  // sees its own slot: FAIL
  assert.equal(facts("", js.replace("let c=Kp;Kp=r;try{return e(n,t)}finally{Kp=c,", "try{return e(n,t)}finally{")).paced, false);
  assert.equal(facts("", js.replace("{if(Kp===r)return e(n,i);let a", "{let a")).paced, false);
});
