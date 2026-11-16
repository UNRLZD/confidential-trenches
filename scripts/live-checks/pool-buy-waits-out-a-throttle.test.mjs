// node --test scripts/live-checks/pool-buy-waits-out-a-throttle.test.mjs: the live check replays its recorded answers
// (pool-buy-waits-out-a-throttle.answers.json). good: this card's SIGN_HOST build: PASS. bad: the base 125a32cc6 build,
// whose withdraw ends on one provider's throttle and whose throttled pool scan reads as no pools: FAIL, each mark named.
// bad_round1: the reviewed f64ab0557 build (its busy answer carries no Retry-After, its To step asks the exit again, its
// failed free is silent, its given-up scan reads as no pools): FAIL.
// Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL; and on the bundle's own pieces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-buy-waits-out-a-throttle.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-buy-waits-out-a-throttle.answers.json", import.meta.url), "utf8"));
const NO_STEP = "BAD a withdraw step does not wait on the page's one rule (from 1 s, doubling to 10 s, 30 s a step), ended by a sign out";
const NO_FAULTS = "BAD a withdraw step's wait is not kept to the transport fault and the busy answer";
const NO_WIRED = (w) => `BAD the withdraw's ${w} does not wait out a throttle before its signature`;
const NO_SIGNED = "BAD a withdraw part is not marked signed before W signs: a signed part could be made again";
const NO_STOP = "BAD the page's withdraw host passes no sign out: a wait would hold the seed's lock";
const NO_EXIT = "BAD the exit's busy 1Click answer ends the withdraw at once, or its Retry-After is not waited";
const NO_SCAN = "BAD a throttled or given-up pool scan reads as no pools: the buy answers quote_check_failed at once";
const NO_TO = "BAD the withdraw's To step asks the exit again on a retry: an abandoned quote could name a W the withdraw never uses";
const NO_FREE = "BAD a part's failed free of its held note is silent: the retry waits for a note the run holds";
const ALL = [NO_STEP, NO_FAULTS, NO_WIRED("plan"), NO_WIRED("part"), NO_TO, NO_FREE, NO_SIGNED, NO_STOP, NO_EXIT, NO_SCAN];

test("recorded good answer: the withdraw's steps wait on the one rule, the exit and the scan's faults wait: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (base 125a32cc6): FAIL, each mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("recorded bad answer (the reviewed f64ab0557 build): FAIL", () => {
  const v = judge(ANSWERS.bad_round1);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, step: false }).lines, [NO_STEP]);
  assert.deepEqual(judge({ ...g, faults: false }).lines, [NO_FAULTS]);
  for (const w of ["plan", "part"]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, [w]: false } }).lines, [NO_WIRED(w)], w);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, to: false } }).lines, [NO_TO]);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, free: false } }).lines, [NO_FREE]);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, signed: false } }).lines, [NO_SIGNED]);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, stop: false } }).lines, [NO_STOP]);
  assert.deepEqual(judge({ ...g, exit: false }).lines, [NO_EXIT]);
  assert.deepEqual(judge({ ...g, scan: false }).lines, [NO_SCAN]);
  assert.equal(judge(null).ok, false);
});

// the bundle's pieces as this card's build minified them (its public/app.js), each one broken in turn
const BUSY = "var LL=class extends Error{code;afterMs;constructor(e,t=null){super(`a busy answer (HTTP ${e})`),this.name=`ReadBusy`,this.code=e===429?`http_429`:`http_5xx`,this.afterMs=t}},RL=class extends Error{constructor(){super(`signed out while the reads waited`),this.name=`ReadStopped`}};";
const TRANSPORT = "var bu=class extends Error{fault;tries;host;afterMs;constructor(e,t,n,r,i=null){super(`${t}`),this.name=`SolanaRpcTransportError`}};";
const RULE = "function jL(e=ML){let t=e(),n=0,r=0,i=!1;return{next(a){let o=T(n,A(a),B);return i||Math.max(e()-t,r)+o>3e4?(i=!0,null):(n=o,r+=o,o)}}}var FL=e=>()=>Number(e.now?.()??Date.now()),IL=e=>e instanceof bu;function zL(e,t,n){return n?.aborted?Promise.resolve():new Promise(r=>{})}";
const STEP = "var $W=e=>IL(e)||e instanceof LL;async function eG(e,t){let n=jL(FL(e));for(;;){let r={signed:!1};try{return await t(r)}catch(t){if(r.signed||e.stop?.aborted||!$W(t))throw t;let i=n.next(t);if(i===null)throw t;if(await zL(e.wait,i,e.stop),e.stop?.aborted)throw new RL}}}";
const WIRED = "let{pool:d,ws:_}=await eG(e,()=>tG(e,r,i)),v={};n=await eG(e,()=>nG(e,n,d,_,v)),e.keepOut&&0;let v=await eG(e,a=>pG(e,t,m,i,f,p,d,{to:n},e=>void(s=e),_,void 0,a));ie.address!==M.address&&FW(`wallet`),d&&(d.signed=!0);let W=RN(m,U);x({...c?{claim:c}:{},stop:u.signal},{...y},r.to,r.amount,r.maxFee);";
const EXIT = "if(s.status===429||s.status>=500&&s.status<=599)throw new LL(s.status,Eu(s.retryAfter??null,i()));";
const AFTER = "var EL=Object.freeze({firstMs:1e3,maxMs:1e4,afterMaxMs:1e4}),DL=()=>Date.now(),OL=e=>e instanceof bu||e instanceof LL?e.afterMs:null;";
const TO = "async function nG(e,t,n,r,i){return e.exit&&(t=i.to??=await e.exit(r[0])),QW(t,e.pin,n,r)&&FW(`to`),await JW(e,t),t}";
const FREE = "h!==null&&!g&&!await n.move(r.noteId,`HELD`,`UNSPENT`,{attempt:h}).then(()=>!0,()=>!1)&&FW(`free`)}}";
const WATCH = "function hz(e){let t=null,n=new Map;return{watch:(e,r=(t,n)=>e(t,n))=>{let i=e.url===void 0?`a provider`:new URL(e.url).host;return hu(e,async(e,a)=>{n.set(i,(n.get(i)??0)+1);try{return await r(e,a)}catch(e){throw e instanceof bu&&(t??=e),e}finally{n.set(i,n.get(i)-1)}})},fault:()=>{if(t!==null)return t;let r=[...n].find(([,e])=>e>0)?.[0];return r===void 0?null:new bu(`timeout`,`no answer before ${e} was given up`,1,r)}}}";
const GIVEN = "let d=hz(`the scan`),f=t().map((e,t)=>d.watch(e,async(n,r)=>{let i=await e(n,r);return i})),p=n(),m=a(f,[d.watch(p[0]),d.watch(p[1])],e).catch(e=>{throw e instanceof bu?e:d.fault()??e});";
const SCAN = "a=Promise.all(r.map(e=>n[e](t.token).catch(e=>(e instanceof bu&&(i??=e),[])))),o=gz(e,t),s=async e=>{let t=await e;if(t===null&&i!==null)throw i;return t};";
const JS = ";" + [BUSY, TRANSPORT, RULE, STEP, WIRED, TO, FREE, EXIT, AFTER, SCAN, WATCH, GIVEN].join("");

test("facts over the bundle's pieces: every mark read; each piece broken loses its own mark", () => {
  const f = facts("", JS);
  assert.deepEqual({ step: f.step, faults: f.faults, wired: f.wired, exit: f.exit, scan: f.scan }, { step: true, faults: true, wired: { plan: true, to: true, part: true, signed: true, stop: true, free: true }, exit: true, scan: true });
  const broken = (from, to) => facts("", JS.replace(from, to));
  // a signed part made again: the signed test gone from the loop
  assert.equal(broken("if(r.signed||e.stop?.aborted||", "if(e.stop?.aborted||").step, false);
  // a wait that is not the rule's bound, or no sign out after it
  assert.equal(broken(">3e4?", ">6e4?").step, false);
  assert.equal(broken(",e.stop?.aborted)throw new RL", ")throw new RL").step, false);
  // every error waits
  assert.equal(broken("var $W=e=>IL(e)||e instanceof LL;", "var $W=e=>!0;").faults, false);
  assert.equal(broken("d&&(d.signed=!0);", "").wired.signed, false);
  assert.equal(broken(",stop:u.signal}", "}").wired.stop, false);
  assert.equal(broken("=await eG(e,()=>tG(e,r,i)),", "=await tG(e,r,i),").wired.plan, false);
  // the To step outside the loop, or asking the exit at every attempt (no answer kept)
  assert.equal(broken("n=await eG(e,()=>nG(e,n,d,_,v))", "n=await nG(e,n,d,_,v)").wired.plan, false);
  assert.equal(broken("(t=i.to??=await e.exit(r[0]))", "(t=await e.exit(r[0]))").wired.to, false);
  // a failed free silent again
  assert.equal(broken(".then(()=>!0,()=>!1)&&FW(`free`)", ".catch(()=>{})").wired.free, false);
  assert.equal(broken("throw new LL(s.status,Eu(s.retryAfter??null,i()))", "throw new X(s.status,Eu(s.retryAfter??null,i()))").exit, false);
  // the busy answer's Retry-After dropped, or not read by the rule
  assert.equal(broken("throw new LL(s.status,Eu(s.retryAfter??null,i()))", "throw new LL(s.status)").exit, false);
  assert.equal(broken("e instanceof bu||e instanceof LL?e.afterMs:null", "e instanceof bu?e.afterMs:null").exit, false);
  // a scan given up on read as no pools again: the in-flight timeout, or the finder's catch, gone
  assert.equal(broken(".catch(e=>{throw e instanceof bu?e:d.fault()??e})", "").scan, false);
  assert.equal(broken("return r===void 0?null:new bu(`timeout`,", "return null;new bu(`timeout`,").scan, false);
  // the scan's fault dropped as "no pools", as before the card
  assert.equal(broken(".catch(e=>(e instanceof bu&&(i??=e),[]))", ".catch(()=>[])").scan, false);
  assert.equal(broken("if(t===null&&i!==null)throw i;", "").scan, false);
});
