// node --test scripts/live-checks/start-reads-wait-out-a-throttle.test.mjs: the live check replays its recorded answers
// (start-reads-wait-out-a-throttle.answers.json). good: this card's SIGN_HOST build, and its testnet build: PASS. bad:
// the base f5fff9cc's builds, with flat 1 s waits on a 429 alone and the buy and deposits down at once: FAIL.
// Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL; and on the bundle's own pieces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./start-reads-wait-out-a-throttle.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./start-reads-wait-out-a-throttle.answers.json", import.meta.url), "utf8"));
const NO_RULE = "BAD no one wait for a kind's next attempt on the wallet's throttle rule (from 1 s, doubling to 10 s, down past 30 s)";
const NO_FAULTS = "BAD a wait is not kept to the page client's transport fault: another error waits, or none does";
const NO_STOP = "BAD a sign out does not end a kind's wait: a kind asked before it can run after it";
const NO_WIRED = (w) => `BAD ${w} does not wait on the one rule before its signature`;
const NO_TAPS = "BAD a kind does not take its request's one bound: a tap's waits start again at each step";
const NO_RENT_BACK = "BAD the rent back's tries wait a flat second, not on the one rule";
const ALL = [NO_RULE, NO_FAULTS, NO_STOP, NO_WIRED("decimals"), NO_WIRED("sell"), NO_WIRED("buy"), NO_WIRED("deposits"), NO_TAPS, NO_RENT_BACK];

for (const k of ["good", "goodTestnet"])
  test(`recorded good answer ${k}: one rule, kept to transport faults, ended by a sign out, on every kind and the rent back: PASS`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, true, v.lines.join("\n"));
    assert.deepEqual(v.lines, []);
  });

for (const k of ["bad", "badTestnet"])
  test(`recorded bad answer ${k}: FAIL, each mark named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, ALL);
  });

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, rule: false }).lines, [NO_RULE]);
  assert.deepEqual(judge({ ...g, faults: false }).lines, [NO_FAULTS]);
  assert.deepEqual(judge({ ...g, stop: false }).lines, [NO_STOP]);
  for (const w of ["decimals", "sell", "buy"]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, [w]: false } }).lines, [NO_WIRED(w)], w);
  for (const n of [0, 1, 3]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, deposits: n } }).lines, [NO_WIRED("deposits")], String(n));
  for (const n of [0, 3, 5]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, taps: n } }).lines, [NO_TAPS], `taps ${n}`);
  assert.deepEqual(judge({ ...g, rentBack: false }).lines, [NO_RENT_BACK]);
  assert.equal(judge(null).ok, false);
});

// the SIGN_HOST build's code as minified (build-app.mjs, card start-reads-wait-out-a-throttle), cut to the pieces read
const JS =
  "var Wh=class extends Error{fault;tries;host;afterMs;constructor(e,t,n,r,i=null){super(`${t}`),this.name=`SolanaRpcTransportError`,this.fault=e}};" +
  "function eL(e,t,n=$I){let r=Number.isFinite(e)&&e>0?Math.min(e*2,n.maxMs):n.firstMs,i=typeof t==`number`&&Number.isFinite(t)&&t>0?Math.min(t,n.afterMaxMs):0;return Math.max(r,i)}" +
  "var vL=Object.freeze({firstMs:1e3,maxMs:1e4,afterMaxMs:1e4}),yL=()=>Date.now(),bL=e=>e instanceof Wh?e.afterMs:null;function xL(e=yL){let t=e(),n=0,r=0;return{next(i){let a=eL(n,bL(i),vL);return Math.max(e()-t,r)+a>3e4?null:(n=a,r+=a,a)}}}" +
  "var SL=new Map,CL=9e4;function wL(e,t){if(typeof e?.id!=`string`)return xL(t);let n=yL();for(let[e,t]of SL)n-t.at>CL&&SL.delete(e);let r=SL.get(e.id);return r===void 0&&SL.set(e.id,r={waits:xL(t),at:n}),r.waits}var TL=e=>()=>Number(e.now?.()??Date.now()),EL=e=>e instanceof Wh,DL=class extends Error{};" +
  "function OL(e,t,n){return n===void 0?e(t):n.aborted?Promise.resolve():new Promise(r=>{let i=()=>r();n.addEventListener(`abort`,i,{once:!0}),e(t).then(()=>{n.removeEventListener(`abort`,i),r()})})}" +
  "async function kL(e,t,n,r){let i=t??(e=>new Promise(t=>setTimeout(t,e)));for(;;){let t={},a=await e(t);if(!(`fault`in t))return a;if(n?.aborted)return{error:`failed`};let o=r.next(t.fault);if(o===null)return a;if(await OL(i,o,n),n?.aborted)return{error:`failed`}}}" +
  "async function AV(e,t,n,r={}){let i=r.kept??kV,a=i.get(e,t);if(a!==void 0)return a;let o=r.waits===0?null:r.waits??xL(),s=r.wait??0,l=[void 0,void 0],u=[!1,!1];for(;;){let e=[];if(e.length===0)break;let t=e.find(e=>!EL(e));if(t!==void 0)throw t;let i=e.reduce((e,t)=>t),a=o===null?null:o.next(i);if(a===null)throw i;if(await OL(s,a,r.signal),r.signal?.aborted)throw new DL}let d=qD(e,l);return i.keep(e,t,d),d}" +
  "if(!s||!LD(o,a.token))return jV;let c=jV,l=e.stop?.(),u=wL(i,e.now);return{running:!0,after:AV(o,a.token,s,{kept:t,waits:u,...e.wait?{wait:e.wait}:{}})};" +
  "async function YH(e,t,n,r){let i=e.wait??0;for(let o=0;;){let s=await eU(e,t,n,r);if(`error`in s&&`fault`in n&&!e.stopped?.()){let t=a.next(n.fault);if(t!==null){if(await OL(i,t,e.signal),e.stopped?.()||e.signal?.aborted)return{error:`failed`};continue}}return s}}" +
  "async function rU(e,t,n,r={},i=xL(TL(e))){let a,o=Object.assign(Object.create(e),{rpcs:0}),s=o.wait??0;for(;;)try{a=await tU(o,t);break}catch(e){if(EL(e)){let t=o.stopped?.()?null:i.next(e);if(t===null)return{error:`down`};if(await OL(s,t,o.signal),o.stopped?.()||o.signal?.aborted)return{error:`failed`};continue}return{error:`failed`}}}" +
  "async function bR(e,t,n=xL(TL(e))){let r=Object.assign(Object.create(e),{rpcs:AL(e.rpcs,jL(null))});return kL(e=>xR(r,t,e),r.wait,r.signal,n)}async function xR(e,t,n){let r=null,i=null,a=null,o=!1,s=0}" +
  "async function dH(e,t,n,r=xL(TL(e))){if(t===null)return fH(e,t,n,{});let i=e;return kL(e=>fH(i,t,n,e),i.wait,i.signal,r)}async function fH(e,t,n,r){if(t!==null&&(t.kind!==`pool.deposit`||t.chain!==`solana`))return{error:`not_allowed`}}" +
  "async function xW(e,t,n=xL(TL(e))){return t===null?SW(e,t,{}):kL(n=>SW(e,t,n),e.wait,e.signal,n)}async function SW(e,t,n){if(t!==null&&(t.kind!==`pool.deposit`||t.chain===`solana`))return{error:`not_allowed`}}" +
  "x(route:e=>r?.route?.(e)},n,wL(r,TL(t)));y(d=await dH(u,n,i,wL(r,TL(u))));z(},wL(r,TL(l)));w(await xW({...t},n,wL(r,TL(t))));" +
  "v=async(e,t)=>{for(let n=0,r=0,i=null;n<30&&(n===0||f()<p);n++){n>0&&await u(r=eL(r,bL(i),vL));try{return{ok:await t()}}catch(t){i=t}}}";

test("the facts read from a bundle", () => {
  const f = facts("", JS);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, rule: true, faults: true, stop: true, wired: { decimals: true, sell: true, buy: true, deposits: 2, taps: 4 }, rentBack: true });
});

test("planted on the bundle: a flat wait, another bound, no clock, any error waiting, no sign out, a kind off the rule or off its request's bound: each read as not held", () => {
  const off = (from, to) => {
    assert.ok(JS.includes(from), from);
    return facts("", JS.replace(from, to));
  };
  // the rule
  assert.equal(off("let a=eL(n,bL(i),vL);", "let a=1e3;").rule, false, "a flat wait");
  assert.equal(off("firstMs:1e3,maxMs:1e4,afterMaxMs:1e4", "firstMs:1e3,maxMs:2e3,afterMaxMs:1e4").rule, false, "another cap");
  assert.equal(off("return Math.max(e()-t,r)+a>3e4?null:", "return r+a>3e4?null:").rule, false, "the bound on the waits alone, not the clock");
  assert.equal(off("return Math.max(e()-t,r)+a>3e4?null:", "return Math.max(e()-t,r)+a>9e9?null:").rule, false, "no bound");
  assert.equal(off("Math.min(e*2,n.maxMs)", "Math.min(e,n.maxMs)").rule, false, "no doubling");
  assert.equal(off("this.name=`SolanaRpcTransportError`", "this.name=`Error`").rule, false, "the Retry-After of another class");
  assert.equal(off("if(typeof e?.id!=`string`)return xL(t);", "return xL(t);").rule, false, "no bound per request");
  // the faults
  assert.equal(off(",EL=e=>e instanceof Wh,", ",EL=e=>!0,").faults, false, "any error waits");
  // the stop
  assert.equal(off("if(await OL(i,o,n),n?.aborted)return{error:`failed`}", "await OL(i,o,n)").stop, false, "the loop runs on after a sign out");
  assert.equal(off("n.aborted?Promise.resolve():new Promise(r=>{let i=()=>r();n.addEventListener(`abort`,i,{once:!0})", "n.aborted?Promise.resolve():new Promise(r=>{let i=()=>r();").stop, false, "the wait not ended by the abort");
  // the kinds
  assert.equal(off("if(await OL(s,a,r.signal),r.signal?.aborted)throw new DL}", "await s(a)}").wired.decimals, false, "the decimals wait not ended by a sign out");
  assert.equal(off("u=wL(i,e.now);return{running:!0,after:AV(o,a.token,s,{kept:t,waits:u,", "u=0;return{running:!0,after:AV(o,a.token,s,{kept:t,").wired.decimals, false, "the decimals read off the request's bound");
  assert.equal(off("if(await OL(s,t,o.signal),o.stopped?.()||o.signal?.aborted)return{error:`failed`};continue", "await s(1e3);continue").wired.sell, false, "the plan's flat wait");
  assert.equal(off("async function rU(e,t,n,r={},i=xL(TL(e)))", "async function rU(e,t,n,r={},i=0)").wired.sell, false, "the sell off the clock");
  assert.equal(off("return kL(e=>xR(r,t,e),r.wait,r.signal,n)", "return xR(r,t,{})").wired.buy, false, "the buy down at once");
  assert.equal(off("kL(n=>SW(e,t,n),e.wait,e.signal,n)", "SW(e,t,{})").wired.deposits, 1, "the EVM deposit down at once");
  assert.equal(off("d=await dH(u,n,i,wL(r,TL(u)))", "d=await dH(u,n,i)").wired.taps, 3, "a deposit's waits start again");
  assert.equal(off("n>0&&await u(r=eL(r,bL(i),vL))", "n>0&&await u(1e3)").rentBack, false, "the rent back's flat second");
});
