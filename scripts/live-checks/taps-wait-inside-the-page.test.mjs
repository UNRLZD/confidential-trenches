// node --test scripts/live-checks/taps-wait-inside-the-page.test.mjs: the live check replays its recorded answers
// (taps-wait-inside-the-page.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before the
// card: FAIL. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL. Planted in this build's
// own minified text: the buy straight to its flow, the wait unbounded or with no step, a pass of its own, no strip of
// spendable for an older kit: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./taps-wait-inside-the-page.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./taps-wait-inside-the-page.answers.json", import.meta.url), "utf8"));
const NO_WAIT = "BAD a pool.buy tapped while its chain's spend is prepared goes to its flow at once: refused not_funded, or Cash moved for money the pool holds";
const NO_BOUND = "BAD the tap's wait for its chain's spend is not the bounded one that joins the pass in flight";
const NO_SPENDABLE = "BAD state.pools carries no spendable, or an app of kit 1.19 or below is sent it";

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, each path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_WAIT, NO_BOUND, NO_SPENDABLE]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, wait: false }).lines, [NO_WAIT]);
  assert.deepEqual(judge({ ...g, bound: false }).lines, [NO_BOUND]);
  assert.deepEqual(judge({ ...g, spendable: false }).lines, [NO_SPENDABLE]);
});

// this build's own minified text of each mark (build-app.mjs at the card's head)
const HANDLER = "let r=e.flow,o=()=>n===`pool.buy`&&e.cash?iX((e,t)=>oQ(r,e,t??i),e.cash)(t,i):oQ(r,t,i);return n===`pool.buy`&&e.prepared?eme(e.prepared(t.chain),o,e.stop?.()):o()}";
const DEPS = "...t?{stop:t}:{},...n?{prepared:n}:{}}";
const MAIN = "(o7?.flow,o7?()=>o7.outSignal():void 0,o7?e=>o7.prepared(e):void 0)";
const BOUND = "var Kye=2e4,qye=(e,t)=>new Promise(n=>{if(t?.aborted)return n();let r=setTimeout(i,e);function i(){clearTimeout(r),t?.removeEventListener(`abort`,i),n()}t?.addEventListener(`abort`,i,{once:!0})});async function Jye(e){let t=e.now()+Kye,n=new AbortController,r=()=>n.abort();e.signal?.addEventListener(`abort`,r,{once:!0}),e.signal?.aborted&&r();let i=new Promise(e=>n.signal.aborted?e():n.signal.addEventListener(`abort`,()=>e(),{once:!0})),a=null;try{for(;;){if(e.signal?.aborted||e.now()>=t||!await e.preparing().catch(()=>!1))return;if(a!==null){let r=Math.min(250-a,t-e.now());a=null,r>0&&await Promise.race([e.wait(r,n.signal),i]);continue}let r=t-e.now();if(r<=0||e.signal?.aborted)return;let o=e.now(),s=new AbortController,c=()=>s.abort();n.signal.addEventListener(`abort`,c,{once:!0});try{await Promise.race([Promise.resolve().then(()=>e.pass()).catch(()=>{}),e.wait(r,s.signal),i])}finally{n.signal.removeEventListener(`abort`,c),s.abort()}let l=e.now()-o;l<250&&(a=l)}}finally{e.signal?.removeEventListener(`abort`,r)}}";
const PAGE = "prepared:async e=>{let t=await m.tap().catch(()=>null);if(t!==null)try{await Jye({preparing:()=>mr(e),pass:()=>j.get(e)??(e===`so";
const SPENDABLE = "return{...e,spendable:RV(a>i";
const NO_SPENDABLE_FN = "Rh=e=>e.pools===void 0?e:{...e,pools:e.pools.map(({spendable:e,...t})=>t)}";
const ALL = [HANDLER, DEPS, MAIN, BOUND, PAGE, SPENDABLE, NO_SPENDABLE_FN].join(";");
const at = (js) => {
  const f = facts("", js);
  return { wait: f.wait, bound: f.bound, spendable: f.spendable };
};

test("planted in a bundle: the marks as built read whole", () => {
  assert.deepEqual(at(ALL), { wait: true, bound: true, spendable: true });
});

test("planted in a bundle: the buy straight to its flow, or no wait handed to the pool kinds, FAILs", () => {
  assert.equal(at(ALL.replace(HANDLER, HANDLER.replace(/return n===`pool\.buy`&&e\.prepared\?[^:]+:o\(\)\}/, "return o()}"))).wait, false, "the handler runs the flow at once");
  assert.equal(at(ALL.replace(DEPS, "...t?{stop:t}:{}}")).wait, false, "the page's deps carry no wait");
  assert.equal(at(ALL.replace(MAIN, "(o7?.flow,o7?()=>o7.outSignal():void 0)")).wait, false, "main hands the pool kinds no wait");
});

test("planted in a bundle: an unbounded wait, a bound past the tap's own, no step, or a pass of its own FAILs", () => {
  assert.equal(at(ALL.replace("var Kye=2e4", "var Kye=1/0")).bound, false, "no bound");
  assert.equal(at(ALL.replace("var Kye=2e4", "var Kye=6e4")).bound, false, "a bound past the tap's one 30 s bound");
  assert.equal(at(ALL.replace("Math.min(250-", "Math.min(0-")).bound, false, "no step after a pass that ended at once");
  assert.equal(at(ALL.replace("pass:()=>j.get(e)??", "pass:()=>")).bound, false, "a pass of its own, never the one in flight");
  assert.equal(at(ALL.replace("let t=await m.tap().catch(()=>null);if(t!==null)", "let t=null;")).bound, false, "no front taken first");
});

test("planted in a bundle: no spendable computed, or sent to an older kit, FAILs", () => {
  assert.equal(at(ALL.replace(SPENDABLE, "return{...e,spent:RV(a>i")).spendable, false, "none computed");
  assert.equal(at(ALL.replace(NO_SPENDABLE_FN, "Rh=e=>e")).spendable, false, "kit 1.19 and below sent it");
});
