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
const NO_SPENT = "BAD a sell's next wallet starts after the tap's waits are spent";
const NO_STOPS = "BAD a deposit's wait does not end at the sign out's tap: its host waits on the follow's signal alone";
const NO_TAPS = "BAD a kind does not take its request's one bound: a tap's waits start again at each step";
const NO_RENT_BACK = "BAD the rent back's tries wait a flat second, not on the one rule";
const ALL = [NO_RULE, NO_FAULTS, NO_STOP, NO_WIRED("decimals"), NO_WIRED("sell"), NO_WIRED("buy"), NO_WIRED("deposits"), NO_TAPS, NO_SPENT, NO_STOPS, NO_RENT_BACK];

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
  assert.deepEqual(judge({ ...g, wired: { ...g.wired, spent: false } }).lines, [NO_SPENT]);
  for (const n of [0, 1, 3]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, stops: n } }).lines, [NO_STOPS], `stops ${n}`);
  assert.deepEqual(judge({ ...g, rentBack: false }).lines, [NO_RENT_BACK]);
  assert.equal(judge(null).ok, false);
});

// the SIGN_HOST build's code as minified (build-app.mjs, card start-reads-wait-out-a-throttle), cut to the pieces read
const JS =
  "var Ry=class extends Error{fault;tries;host;afterMs;constructor(e,t,n,r,i=null){super(`${t}`),this.name=`SolanaRpcTransportError`,this.fault=e}};" +
  "function cV(e,t,n=$I){let r=Number.isFinite(e)&&e>0?Math.min(e*2,n.maxMs):n.firstMs,i=typeof t==`number`&&Number.isFinite(t)&&t>0?Math.min(t,n.afterMaxMs):0;return Math.max(r,i)}" +
  "var EV=Object.freeze({firstMs:1e3,maxMs:1e4,afterMaxMs:1e4}),DV=()=>Date.now(),OV=e=>e instanceof Ry?e.afterMs:null;function kV(e=DV){let t=e(),n=0,r=0,i=!1;return{next(a){let o=cV(n,OV(a),EV);return i||Math.max(e()-t,r)+o>3e4?(i=!0,null):(n=o,r+=o,o)},spent:()=>i}}" +
  "var AV=new Map,jV=9e4;function MV(e,t){if(typeof e?.id!=`string`)return kV(t);let n=DV();for(let[e,t]of AV)n-t.at>jV&&AV.delete(e);let r=AV.get(e.id);return r===void 0&&AV.set(e.id,r={waits:kV(t),at:n}),r.waits}var NV=e=>()=>Number(e.now?.()??Date.now()),PV=e=>e instanceof Ry,FV=class extends Error{};" +
  "function IV(e,t,n){return n?.aborted?Promise.resolve():new Promise(r=>{let i,a=()=>{clearTimeout(i),n?.removeEventListener(`abort`,a),r()};n?.addEventListener(`abort`,a,{once:!0}),e===void 0?i=setTimeout(a,t):e(t).then(a,a)})}" +
  "var LV=e=>e.signal!==void 0&&e.stop!==void 0?AbortSignal.any([e.signal,e.stop]):e.signal??e.stop;" +
  "async function RV(e,t,n,r){for(;;){let i={},a=await e(i);if(!(`fault`in i))return a;if(n?.aborted)return{error:`failed`};let o=r.next(i.fault);if(o===null)return a;if(await IV(t,o,n),n?.aborted)return{error:`failed`}}}" +
  "async function zG(e,t,n,r={}){let i=r.kept??kV,a=i.get(e,t);if(a!==void 0)return a;let o=r.waits===0?null:r.waits??kV(),l=[void 0,void 0];for(;;){let e=[];if(e.length===0)break;let t=e.find(e=>!PV(e));if(t!==void 0)throw t;let i=e.reduce((e,t)=>t),a=o===null?null:o.next(i);if(a===null)throw i;if(await IV(r.wait,a,r.signal),r.signal?.aborted)throw new FV}return 0}" +
  "if(!s||!Bj(o,a.token))return BG;let c=BG,l=e.stop?.(),u=MV(i,e.now);return{running:!0,after:zG(o,a.token,s,{kept:t,waits:u,...e.wait?{wait:e.wait}:{}})};" +
  "async function lq(e,t,n,r,i){for(let o=0;;){let s=await mq(e,t,n,r);if(`error`in s&&`fault`in n&&!e.stopped?.()){let t=i.next(n.fault);if(t!==null){if(await IV(e.wait,t,e.signal),e.stopped?.()||e.signal?.aborted)return{error:`failed`};continue}}return s}}" +
  "async function uq(e,t,n,r={},i=kV(NV(e))){let a,o=Object.assign(Object.create(e),{rpcs:0});for(;;)try{a=await dq(o,t);break}catch(e){if(PV(e)){let t=o.stopped?.()?null:i.next(e);if(t===null)return{error:`down`};if(await IV(o.wait,t,o.signal),o.stopped?.()||o.signal?.aborted)return{error:`failed`};continue}return{error:`failed`}}" +
  "return f.then(()=>o.stopped?.()?{error:`failed`}:i.spent()?{error:`down`}:lq(p,{...t,amount:e.units,shareBps:void 0},l,e.w,i)).catch(()=>({error:`failed`}))}" +
  "async function bR(e,t,n=kV(NV(e))){let r=Object.assign(Object.create(e),{rpcs:zV(e.rpcs,BV(null))});return RV(e=>xR(r,t,e),r.wait,r.signal,n)}async function xR(e,t,n){let r=null,i=null,a=null,o=!1,s=0}" +
  "async function wK(e,t,n,r=kV(NV(e))){return t===null?xK(e,t,n,{}):RV(r=>xK(e,t,n,r),e.wait,LV(e),r)}async function xK(e,t,n,r){if(t!==null&&(t.kind!==`pool.deposit`||t.chain!==`solana`))return{error:`not_allowed`}}" +
  "async function AJ(e,t,n=kV(NV(e))){return t===null?jJ(e,t,{}):RV(n=>jJ(e,t,n),e.wait,LV(e),n)}async function jJ(e,t,n){if(t!==null&&(t.kind!==`pool.deposit`||t.chain===`solana`))return{error:`not_allowed`}}" +
  "x1(n,r)=>{if(n.kind!==`pool.buy`||n.chain!==`solana`||!t)return{error:`not_allowed`};let i=MV(r),a=null;" +
  "x2(n,r)=>{if(n!==null&&(n.kind!==`pool.deposit`||n.chain!==`solana`)||!t)return{error:`not_allowed`};let a=MV(r),o=null;" +
  "x3(n,r)=>{if(n.kind!==`pool.sell`||n.chain!==`solana`||!t||!r)return{error:`not_allowed`};let i=MV(r),a=null;" +
  "x4(n,r)=>{if(n!==null&&(n.kind!==`pool.deposit`||n.chain===`solana`)||!t)return{error:`not_allowed`};let i=MV(r),a=null;" +
  "y1({seed64:e.seed64,settle:()=>void je(),signal:_.signal,stop:s.signal,end:()=>{i?.close(),t?.()}});" +
  "y2({seed64:e.seed64,settle:()=>void R(t),signal:_.signal,stop:ne.signal,end:()=>{i?.close(),n?.()}});" +
  "c=()=>{s.abort(),s=new AbortController};z={signingOut:()=>{re++,c(),ne.abort(),ne=new AbortController}};" +
  "v=async(e,t)=>{for(let n=0,r=0,i=null;n<30&&(n===0||f()<p);n++){n>0&&await u(PV(i)?r=cV(r,OV(i),EV):EV.firstMs);try{return{ok:await t()}}catch(t){i=t}}}";

test("the facts read from a bundle", () => {
  const f = facts("", JS);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, rule: true, faults: true, stop: true, wired: { decimals: true, sell: true, spent: true, buy: true, deposits: 2, stops: 2, taps: 4 }, rentBack: true });
});

test("planted on the bundle: a flat wait, another bound, no clock, any error waiting, no sign out, a kind off the rule or off its request's bound: each read as not held", () => {
  const off = (from, to) => {
    assert.ok(JS.includes(from), from);
    return facts("", JS.replace(from, to));
  };
  // the rule
  assert.equal(off("let o=cV(n,OV(a),EV);", "let o=1e3;").rule, false, "a flat wait");
  assert.equal(off("firstMs:1e3,maxMs:1e4,afterMaxMs:1e4", "firstMs:1e3,maxMs:2e3,afterMaxMs:1e4").rule, false, "another cap");
  assert.equal(off("return i||Math.max(e()-t,r)+o>3e4?", "return i||r+o>3e4?").rule, false, "the bound on the waits alone, not the clock");
  assert.equal(off("return i||Math.max(e()-t,r)+o>3e4?", "return i||Math.max(e()-t,r)+o>9e9?").rule, false, "no bound");
  assert.equal(off("return i||Math.max(", "return Math.max(").rule, false, "a refused wait not kept spent");
  assert.equal(off("Math.min(e*2,n.maxMs)", "Math.min(e,n.maxMs)").rule, false, "no doubling");
  assert.equal(off("this.name=`SolanaRpcTransportError`", "this.name=`Error`").rule, false, "the Retry-After of another class");
  assert.equal(off("if(typeof e?.id!=`string`)return kV(t);", "return kV(t);").rule, false, "no bound per request");
  // the faults
  assert.equal(off(",PV=e=>e instanceof Ry,", ",PV=e=>!0,").faults, false, "any error waits");
  // the stop
  assert.equal(off("if(await IV(t,o,n),n?.aborted)return{error:`failed`}", "await IV(t,o,n)").stop, false, "the loop runs on after a sign out");
  assert.equal(off("n?.addEventListener(`abort`,a,{once:!0}),", "").stop, false, "the wait not ended by the abort");
  assert.equal(off("let i,a=()=>{clearTimeout(i),", "let i,a=()=>{").stop, false, "its own timer left running at the abort");
  assert.equal(off("e(t).then(a,a)", "e(t).then(a)").stop, false, "a host's wait that rejects never settles");
  assert.equal(off("AbortSignal.any([e.signal,e.stop]):e.signal??e.stop", "e.signal:e.signal").stop, false, "a deposit on the follow's signal alone");
  // the kinds
  assert.equal(off("if(await IV(r.wait,a,r.signal),r.signal?.aborted)throw new FV}", "await r.wait(a)}").wired.decimals, false, "the decimals wait not ended by a sign out");
  assert.equal(off("u=MV(i,e.now);return{running:!0,after:zG(o,a.token,s,{kept:t,waits:u,", "u=0;return{running:!0,after:zG(o,a.token,s,{kept:t,").wired.decimals, false, "the decimals read off the request's bound");
  assert.equal(off("if(await IV(o.wait,t,o.signal),o.stopped?.()||o.signal?.aborted)return{error:`failed`};continue", "await o.wait(1e3);continue").wired.sell, false, "the plan's flat wait");
  assert.equal(off("async function uq(e,t,n,r={},i=kV(NV(e)))", "async function uq(e,t,n,r={},i=0)").wired.sell, false, "the sell off the clock");
  assert.equal(off("i.spent()?{error:`down`}:", "").wired.spent, false, "the next wallet starts once the waits are spent");
  assert.equal(off("return RV(e=>xR(r,t,e),r.wait,r.signal,n)", "return xR(r,t,{})").wired.buy, false, "the buy down at once");
  assert.equal(off("RV(n=>jJ(e,t,n),e.wait,LV(e),n)", "RV(n=>jJ(e,t,n),e.wait,e.signal,n)").wired.deposits, 1, "the EVM deposit on the follow's signal alone");
  assert.equal(off("signal:_.signal,stop:s.signal,", "signal:_.signal,").wired.stops, 1, "the page's Solana deposit host without the session's stop");
  assert.equal(off("ne.abort(),ne=new AbortController", "re++").wired.stops, 1, "an EVM stop no sign out aborts");
  assert.equal(off("signal:_.signal,stop:ne.signal,", "signal:_.signal,stop:_.signal,").wired.stops, 1, "the follow's signal named as the stop");
  assert.equal(off("return{error:`not_allowed`};let a=MV(r),o=null;", "return{error:`not_allowed`};let a=null,o=null;").wired.taps, 3, "a deposit's bound not from its arrival");
  assert.equal(off("n>0&&await u(PV(i)?r=cV(r,OV(i),EV):EV.firstMs)", "n>0&&await u(1e3)").rentBack, false, "the rent back's flat second");
  assert.equal(off("n>0&&await u(PV(i)?r=cV(r,OV(i),EV):EV.firstMs)", "n>0&&await u(r=cV(r,OV(i),EV))").rentBack, false, "the rent back doubling on any failure");
});

// card pool-sell-legs-side-by-side hands each wallet's sale more after the waits (its earlier reads and its turn): the
// spent mark reads that shape, cut from that card's public/app.js (start-reads-wait-out-a-throttle.side.excerpt.txt),
// and the shape before it; the check taken away from either FAILs
test("the spent mark on the side-by-side sell's shape and on the shape before it; the check taken away FAILs", async () => {
  const { SPENT } = await import("./start-reads-wait-out-a-throttle.mjs");
  const side = readFileSync(new URL("./start-reads-wait-out-a-throttle.side.excerpt.txt", import.meta.url), "utf8");
  const before = ".then(()=>o.stopped?.()?{error:`failed`}:i.spent()?{error:`down`}:hU(g,{...t,amount:e.units,shareBps:void 0},s,e.w,i)))";
  for (const js of [side, before]) {
    assert.equal(SPENT.test(js), true, js.slice(0, 80));
    assert.equal(SPENT.test(js.replace("i.spent()?{error:`down`}:", "")), false, "no spent check: FAIL");
  }
});
