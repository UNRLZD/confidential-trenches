// node --test scripts/live-checks/pool-buy-waits-out-a-throttle.test.mjs: the live check replays its recorded answers
// (pool-buy-waits-out-a-throttle.answers.json). good: this card's SIGN_HOST build: PASS. bad: the base 125a32cc6 build,
// whose withdraw ends on one provider's throttle and whose throttled pool scan reads as no pools: FAIL, each mark named.
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
const NO_EXIT = "BAD the exit's busy 1Click answer ends the withdraw at once";
const NO_SCAN = "BAD a throttled pool scan reads as no pools: the buy answers quote_check_failed at once";
const ALL = [NO_STEP, NO_FAULTS, NO_WIRED("plan"), NO_WIRED("part"), NO_SIGNED, NO_STOP, NO_EXIT, NO_SCAN];

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

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, step: false }).lines, [NO_STEP]);
  assert.deepEqual(judge({ ...g, faults: false }).lines, [NO_FAULTS]);
  for (const w of ["plan", "part"]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, [w]: false } }).lines, [NO_WIRED(w)], w);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, signed: false } }).lines, [NO_SIGNED]);
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, stop: false } }).lines, [NO_STOP]);
  assert.deepEqual(judge({ ...g, exit: false }).lines, [NO_EXIT]);
  assert.deepEqual(judge({ ...g, scan: false }).lines, [NO_SCAN]);
  assert.equal(judge(null).ok, false);
});

// the bundle's pieces as this card's build minified them (its public/app.js), each one broken in turn
const BUSY = "var LL=class extends Error{code;constructor(e){super(`a busy answer (HTTP ${e})`),this.name=`ReadBusy`,this.code=e===429?`http_429`:`http_5xx`}},RL=class extends Error{constructor(){super(`signed out while the reads waited`),this.name=`ReadStopped`}};";
const TRANSPORT = "var bu=class extends Error{fault;tries;host;afterMs;constructor(e,t,n,r,i=null){super(`${t}`),this.name=`SolanaRpcTransportError`}};";
const RULE = "function jL(e=ML){let t=e(),n=0,r=0,i=!1;return{next(a){let o=T(n,A(a),B);return i||Math.max(e()-t,r)+o>3e4?(i=!0,null):(n=o,r+=o,o)}}}var FL=e=>()=>Number(e.now?.()??Date.now()),IL=e=>e instanceof bu;function zL(e,t,n){return n?.aborted?Promise.resolve():new Promise(r=>{})}";
const STEP = "var $W=e=>IL(e)||e instanceof LL;async function eG(e,t){let n=jL(FL(e));for(;;){let r={signed:!1};try{return await t(r)}catch(t){if(r.signed||e.stop?.aborted||!$W(t))throw t;let i=n.next(t);if(i===null)throw t;if(await zL(e.wait,i,e.stop),e.stop?.aborted)throw new RL}}}";
const WIRED = "let{pool:d}=await eG(e,()=>tG(e,n,r,i));let v=await eG(e,a=>pG(e,t,m,i,f,p,d,{to:n},e=>void(s=e),_,void 0,a));ie.address!==M.address&&FW(`wallet`),d&&(d.signed=!0);let W=RN(m,U);x({...c?{claim:c}:{},stop:u.signal},{...y},r.to,r.amount,r.maxFee);";
const EXIT = "if(s.status===429||s.status>=500&&s.status<=599)throw new LL(s.status);";
const SCAN = "a=Promise.all(r.map(e=>n[e](t.token).catch(e=>(e instanceof bu&&(i??=e),[])))),o=gz(e,t),s=async e=>{let t=await e;if(t===null&&i!==null)throw i;return t};";
const JS = ";" + [BUSY, TRANSPORT, RULE, STEP, WIRED, EXIT, SCAN].join("");

test("facts over the bundle's pieces: every mark read; each piece broken loses its own mark", () => {
  const f = facts("", JS);
  assert.deepEqual({ step: f.step, faults: f.faults, wired: f.wired, exit: f.exit, scan: f.scan }, { step: true, faults: true, wired: { plan: true, part: true, signed: true, stop: true }, exit: true, scan: true });
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
  assert.equal(broken("=await eG(e,()=>tG(e,n,r,i));", "=await tG(e,n,r,i);").wired.plan, false);
  assert.equal(broken("throw new LL(s.status)", "throw new X(s.status)").exit, false);
  // the scan's fault dropped as "no pools", as before the card
  assert.equal(broken(".catch(e=>(e instanceof bu&&(i??=e),[]))", ".catch(()=>[])").scan, false);
  assert.equal(broken("if(t===null&&i!==null)throw i;", "").scan, false);
});
