// node --test scripts/live-checks/sell-right-after-a-buy.test.mjs: the live check replays its recorded answers
// (sell-right-after-a-buy.answers.json). good: the signing page's build at this card's head (build-app.mjs --out), the
// buy's record at its read-back, taken back at a not_landed end, its reads a pass's from its land: PASS. before: the
// same build at the card's base (1dbafe4a): FAIL, every mark named. sentSwitch: the build at 29a9e506, whose reads went
// a pass's at its sent (the review's P2: before its land, so the reads that tell Filled waited): FAIL on those two marks.
// Planted on the good one: another script, no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./sell-right-after-a-buy.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sell-right-after-a-buy.answers.json", import.meta.url), "utf8"));
const NO_EARLY = "BAD the buy's record is written only at its end: a sale, the preview and the positions do not have W's token at Filled";
const NO_TAKE_BACK = "BAD a buy that did not land keeps its record: a position shows that was never bought";
const NO_RELEASE = "BAD the buy's reads do not go as the background's from its land, or switch at its sent: a sale tapped after Filled waits, or Filled does";
const NO_PAIR = "BAD the buy's pair does not read as its kind says at each call";
const NO_LANDED = "BAD the buy's run does not tell its land: its reads stay a trade's to Final";

test("recorded good answer: this card's build: PASS", () => {
  assert.deepEqual(judge(ANSWERS.good), { ok: true, lines: [] });
});

test("recorded bad answer before: the build at the card's base: FAIL, every mark named", () => {
  const v = judge(ANSWERS.before);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_EARLY, NO_TAKE_BACK, NO_RELEASE, NO_PAIR, NO_LANDED]);
});

test("recorded bad answer sentSwitch: the build at 29a9e506, its reads a pass's from its sent: FAIL on the land's two marks", () => {
  assert.deepEqual(judge(ANSWERS.sentSwitch), { ok: false, lines: [NO_RELEASE, NO_LANDED] });
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no script"]);
  assert.deepEqual(judge({ ...g, early: false }).lines, [NO_EARLY]);
  assert.deepEqual(judge({ ...g, takeBack: false }).lines, [NO_TAKE_BACK]);
  assert.deepEqual(judge({ ...g, release: false }).lines, [NO_RELEASE]);
  assert.deepEqual(judge({ ...g, pair: false }).lines, [NO_PAIR]);
  assert.deepEqual(judge({ ...g, landed: false }).lines, [NO_LANDED]);
  assert.equal(judge(null).ok, false);
});

test("the facts read from the script, each mark its own code", () => {
  const js = "a=ke(t,{...n,progress:u,route:e=>(d(e),`out`in e&&s())});return r?.mint===s.mint&&r.received===s.received&&delete t[n.wallet],t;function KG(e,t){return[0,1].map(n=>Lh(e.trade[n],(r,i)=>e[t()][n](r,i)))}function qG(e,t){let n=`trade`;return{rpcs:KG(e,()=>n),kind:()=>n,release:t,landed:()=>{n=`pass`}}}if(!F)return k(P?M:[],j);e.landed?.();let R=f()";
  const f = facts({ index: "", js });
  assert.equal(f.early && f.takeBack && f.release && f.pair && f.landed, true);
  assert.equal(facts({ index: "", js: js.replace("route:e=>(d(e),`out`in e&&s())", "route:eP(r,n.route)") }).early, false, "the route into the facts alone is the end-only record");
  assert.equal(facts({ index: "", js: js.replace("r.received===s.received&&", "") }).takeBack, false, "a take-back of any record of W is not this buy's own");
  assert.equal(facts({ index: "", js: js.replace("release:t,landed:()=>{n=`pass`}", "release:()=>{n=`pass`,t()},landed:()=>{}") }).release, false, "the kind switched at the release is the review's P2");
  assert.equal(facts({ index: "", js: js.replace("landed:()=>{n=`pass`}", "landed:()=>{}") }).release, false, "a land that switches nothing");
  assert.equal(facts({ index: "", js: js.replace("e.landed?.();", "") }).landed, false, "a run that never tells its land");
  assert.equal(facts({ index: "", js: js.replace("e[t()][n](r,i)", "e.trade[n](r,i)") }).pair, false, "a pair fixed to the trade's");
});
