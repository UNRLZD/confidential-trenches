// node --test scripts/live-checks/evm-withdraw-waits-out-a-throttle.test.mjs: the live check replays its recorded
// answers (evm-withdraw-waits-out-a-throttle.answers.json). good: this card's SIGN_HOST build: PASS. bad: the base
// 0219b1203 build, whose EVM withdraw ends on one provider's throttle, swallows a failed free and passes no sign out:
// FAIL, each mark named. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL; and on the
// bundle's own pieces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./evm-withdraw-waits-out-a-throttle.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-withdraw-waits-out-a-throttle.answers.json", import.meta.url), "utf8"));
const NO_FAULTS = "BAD the EVM withdraw's steps do not wait on the EVM reads' own faults (unanswered, lagging) beside the page's";
const NO_PLAN = "BAD the EVM withdraw's plan does not wait out a throttle, or a rerun asks the exit again for the same W";
const NO_PART = "BAD an EVM withdraw part does not wait out a throttle before W signs";
const NO_SIGNED = "BAD an EVM withdraw part is not marked signed before W signs: a signed part could be made again";
const NO_FREE = "BAD an EVM part's failed free of its held note is silent: the run could wait over a note it holds";
const NO_STOP = "BAD the page's EVM withdraw host passes no sign out: a wait would hold the seed's lock";
const ALL = [NO_FAULTS, NO_PLAN, NO_PART, NO_SIGNED, NO_FREE, NO_STOP];
const MARKS = { faults: NO_FAULTS, plan: NO_PLAN, part: NO_PART, signed: NO_SIGNED, free: NO_FREE, stop: NO_STOP };

test("recorded good answer: the EVM withdraw's plan and parts wait out a throttle up to W's signature: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (base 0219b1203): FAIL, each mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [k, line] of Object.entries(MARKS)) assert.deepEqual(judge({ ...g, [k]: false }).lines, [line], k);
  assert.equal(judge(null).ok, false);
});

// the bundle's pieces as this card's build minified them (its public/app.js), each one broken in turn
const UNANSWERED = "var dO=class extends Error{code=`unanswered`;constructor(e,t){super(e,{cause:t}),this.name=`EvmUnansweredError`}},";
const LAG = "QD=class extends Error{code=`lag`;constructor(e){super(e),this.name=`EvmLagError`}};";
const LOOP = "var nG=e=>LL(e)||e instanceof RL;async function rG(e,t,n=nG){let r=ML(IL(e));for(;;){let i={signed:!1};try{return await t(i)}catch(t){if(i.signed||e.stop?.aborted||!n(t))throw t;let a=r.next(t);if(a===null)throw t;if(await BL(e.wait,a,e.stop),e.stop?.aborted)throw new zL}}}";
const EVM_ON = "var x=[],G1=e=>nG(e)||e instanceof dO||e instanceof QD,y=1;";
const PLAN_STEP = "async function Que(e,t,n,r,i){let a=await e.notes(),m=await p(f);e.exit&&(t=i[m[0]]??=await e.exit(m[0])),l0(t,e.pin,m)&&K1(`to`)}";
const RUN = "async function ide(e,n,r,i){let p={},{notes:a,plan:h,costs:g,wCap:_,dest:v}=await rG(e,()=>Que(e,n,r,i,p),G1);for(let[r,i]of h.entries()){let f=await rG(e,a=>rde(e,t,m,i,g,{to:n,last:r===h.length-1,feeCap:_.toString()},e=>void(s=e),y,a),G1);}}";
const SIGNER = "function sP(e,t,n,r,i,a=!1){let o=LM(`evm.withdraw`,i);return o}";
const PART = "async function rde(e,t,n,r,i,o,s,y,c){try{let L=await c0(e,n=>{let r=ba(n);(q1(r.address)!==q1(E.w.address))&&K1(`wallet`),c&&(c.signed=!0);let i=sP(f,M,t,e.pin.pool,A,e.testnet);return i})}finally{f?.fill(0),u!==null&&!d&&!await n.move(r.noteId,`HELD`,`UNSPENT`,{attempt:u}).then(()=>!0,()=>!1)&&K1(`free`)}}";
const HOST = "let h={send:e=>GZ(vB,e,t.fetch),owedNotes:v,...t.now?{now:t.now}:{},...t.wait?{wait:t.wait}:{},stop:Qe.signal};";
const JS = ";" + [UNANSWERED, LAG, LOOP, EVM_ON, PLAN_STEP, RUN, SIGNER, PART, HOST].join("");
const marks = (f) => ({ faults: f.faults, plan: f.plan, part: f.part, signed: f.signed, free: f.free, stop: f.stop });

test("facts over the bundle's pieces: every mark read; each piece broken loses its own mark", () => {
  assert.deepEqual(marks(facts("", JS)), { faults: true, plan: true, part: true, signed: true, free: true, stop: true });
  const broken = (from, to) => facts("", JS.replace(from, to));
  // the EVM faults: one of the two left out, or the page's own step faults not among them
  assert.equal(broken("||e instanceof QD,", ",").faults, false);
  assert.equal(broken("G1=e=>nG(e)||", "G1=e=>").faults, false);
  // the loop's faults no parameter (every step on the page's own only), as before the card
  assert.equal(broken("async function rG(e,t,n=nG){", "async function rG(e,t){").faults, false);
  // the plan outside the loop, on the page's faults only, or the exit asked at every rerun
  assert.equal(broken("=await rG(e,()=>Que(e,n,r,i,p),G1)", "=await Que(e,n,r,i,p)").plan, false);
  assert.equal(broken("=await rG(e,()=>Que(e,n,r,i,p),G1)", "=await rG(e,()=>Que(e,n,r,i,p))").plan, false);
  assert.equal(broken("(t=i[m[0]]??=await e.exit(m[0]))", "(t=await e.exit(m[0]))").plan, false);
  // the answer kept under another key than the W it was asked with
  assert.equal(broken("(t=i[m[0]]??=await e.exit(m[0]))", "(t=i[q[0]]??=await e.exit(m[0]))").plan, false);
  // a part outside the loop, or without its attempt's mark
  assert.equal(broken("let f=await rG(e,a=>rde(e,t,m,i,g,{to:n,last:r===h.length-1,feeCap:_.toString()},e=>void(s=e),y,a),G1);", "let f=await rde(e,t,m,i,g,{},e=>void(s=e),y,void 0);").part, false);
  assert.equal(broken(",e=>void(s=e),y,a),G1);", ",e=>void(s=e),y,void 0),G1);").part, false);
  // the signed mark gone, or after the signature
  assert.equal(broken(",c&&(c.signed=!0);let i=sP(f,", ";let i=sP(f,").signed, false);
  assert.equal(broken("c&&(c.signed=!0);let i=sP(f,M,t,e.pin.pool,A,e.testnet);", "let i=sP(f,M,t,e.pin.pool,A,e.testnet);c&&(c.signed=!0);").signed, false);
  // a failed free silent again (the base build's), or stopped by another run's stop
  assert.equal(broken(".then(()=>!0,()=>!1)&&K1(`free`)", ".catch(()=>{})").free, false);
  assert.equal(broken("&&K1(`free`)", "&&RW(`free`)").free, false);
  // the host with no sign out
  assert.equal(broken(",stop:Qe.signal}", "}").stop, false);
});
