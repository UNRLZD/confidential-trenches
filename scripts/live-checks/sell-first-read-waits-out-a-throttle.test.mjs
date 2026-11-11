// node --test scripts/live-checks/sell-first-read-waits-out-a-throttle.test.mjs: the live check replays its recorded
// answers (sell-first-read-waits-out-a-throttle.answers.json). good: this card's SIGN_HOST build, and its testnet build:
// PASS. bad: the base 10317f87's builds, where the sell's first read answers down at once: FAIL.
// Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./sell-first-read-waits-out-a-throttle.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sell-first-read-waits-out-a-throttle.answers.json", import.meta.url), "utf8"));
const NO_KEPT = "BAD a token's decimals are not kept for the session: every sell reads them again, on a provider a buy just throttled";
const NO_WIRED = (w) => `BAD the kept decimals are not the page's one store on every path: ${w} reads or keeps apart`;
const NO_WAIT = "BAD the sell's first read does not wait out a provider that fails on the wallet's throttle rule: one throttle answers down";
const NO_DOWN = "BAD the sell's first read answers down for two answers that disagree, or not_allowed for a failed read";
const ALL = [NO_KEPT, NO_WIRED("page"), NO_WIRED("solanaBuy"), NO_WIRED("evmBuy"), NO_WIRED("sell"), NO_WAIT, NO_DOWN];

for (const k of ["good", "goodTestnet"])
  test(`recorded good answer ${k}: the decimals kept, the first read waits, down only for a failed read: PASS`, () => {
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
  assert.deepEqual(judge({ ...g, kept: false }).lines, [NO_KEPT]);
  for (const w of ["page", "solanaBuy", "evmBuy", "sell"]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, [w]: false } }).lines, [NO_WIRED(w)], w);
  for (const w of ["page", "solanaBuy", "sell"]) assert.deepEqual(judge({ ...g, wired: { ...g.wired, [w]: "none" } }).lines, [NO_WIRED(w)], `${w} none`);
  assert.deepEqual(judge({ ...g, wait: false }).lines, [NO_WAIT]);
  assert.deepEqual(judge({ ...g, down: false }).lines, [NO_DOWN]);
  assert.equal(judge(null).ok, false);
});

// the testnet build's code as minified (build-app.mjs --network testnet at 49efdb0c, the wait as card
// start-reads-wait-out-a-throttle builds it), cut to the pieces read
const JS =
  "var sV=1e3,cV=`ct-pool/sell`;var UV=1e4,WV=0;" +
  "var JI=Object.freeze({firstMs:1e3,maxMs:1e4,afterMaxMs:1e4});function YI(e,t,n=JI){let r=Number.isFinite(e)&&e>0?Math.min(e*2,n.maxMs):n.firstMs,i=typeof t==`number`&&Number.isFinite(t)&&t>0?Math.min(t,n.afterMaxMs):0;return Math.max(r,i)}" +
  "function kH(){let e=new Map,t=(e,t)=>`${e} ${e===`solana`?t:t.toLowerCase()}`;return{get:(n,r)=>e.get(t(n,r)),keep:(n,r,i)=>{if(MD(n,r))try{e.set(t(n,r),UD(i))}catch{}}}}" +
  "var AH=kH(),jH=Object.freeze({firstMs:sV,maxMs:UV,afterMaxMs:UV}),zL=()=>Date.now(),yL=e=>e instanceof Wh?e.afterMs:null;function bL(e=zL){let t=e(),n=0,r=0;return{next(i){let a=YI(n,yL(i),jH);return Math.max(e()-t,r)+a>3e4?null:(n=a,r+=a,a)}}}" +
  "async function MH(e,t,n,r={}){let i=r.kept??AH,a=i.get(e,t);if(a!==void 0)return a;let o=r.waits===0?null:r.waits??bL(),s=r.wait??(e=>new Promise(t=>setTimeout(t,e))),c=n=>0,l=[void 0,void 0],u=[!1,!1];" +
  "for(;;){let e=[];if(await Promise.all([0,1].map(async t=>{if(!u[t])try{l[t]=await c(n[t]),u[t]=!0}catch(t){e.push(t)}})),e.length===0)break;let t=e.find(e=>!xL(e));if(t!==void 0)throw t;let i=e.reduce((e,t)=>t),a=o===null?null:o.next(i);if(a===null)throw i;if(await CL(s,a,r.signal),r.signal?.aborted)throw new SL}let d=HD(e,l);return i.keep(e,t,d),d}" +
  "var NH=Object.freeze({error:`not_allowed`}),PH=Object.freeze({error:`down`});" +
  "return{running:!0,after:MH(o,a.token,s,{kept:t,...e.wait?{wait:e.wait}:{},...l?{signal:l}:{}}).then(async t=>{c=NH},e=>{c=e instanceof jD?NH:e instanceof SL?kV:PH}),answer:()=>c}};" +
  "function PW(e){return{pinned:e=>!0,rpcs:e=>e===`solana`?bW():null,decimals:AH,...e?{flow:e}:{}}}" +
  "send:(e,n)=>LW(e,n,t.fetch),outDecimals:(e,t,n)=>{le.set(e,t),AH.keep(`solana`,n,t)},settle:0;" +
  "seed64:i.seed64,quote:o_,build:Yw,decimals:t=>MH(e,t,n,{waits:0}),send:0";

test("the facts read from a bundle", () => {
  const f = facts("", JS);
  assert.deepEqual({ ...f, sha384: null }, { index: "", sha384: null, kept: true, wired: { page: true, solanaBuy: true, evmBuy: true, sell: true }, wait: true, down: true });
  // the store keyed some other way, or the read not kept: not kept
  assert.equal(facts("", JS.replace("t.toLowerCase()", "t")).kept, false);
  assert.equal(facts("", JS.replace("return i.keep(e,t,d),d}", "return d}")).kept, false);
  // no kept answer before the read: nothing read at all
  assert.equal(facts("", JS.replace("if(a!==void 0)return a;", "")).kept, false);
  // each path apart from the page's one store
  assert.equal(facts("", JS.replace("decimals:AH,", "decimals:kH(),")).wired.page, false);
  assert.equal(facts("", JS.replace("AH.keep(`solana`,n,t)", "")).wired.solanaBuy, false);
  assert.equal(facts("", JS.replace("AH.keep(`solana`,n,t)", "AH.keep(`solana`,t,n)")).wired.solanaBuy, false);
  assert.equal(facts("", JS.replace("decimals:t=>MH(e,t,n,{waits:0})", "decimals:t=>HD(e,t)")).wired.evmBuy, false);
  assert.equal(facts("", JS.replace("decimals:t=>MH(e,t,n,{waits:0})", "decimals:t=>MH(e,t,n)")).wired.evmBuy, false);
  assert.equal(facts("", JS.replace("quote:o_,build:Yw,decimals:t=>MH(e,t,n,{waits:0})", "")).wired.evmBuy, "none");
  assert.equal(facts("", JS.replace("after:MH(o,a.token,s,{kept:t,", "after:MH(o,a.token,s,{")).wired.sell, false);
  // the wait: on the page's one rule (read-waits.ts readWaits), in its bounds
  assert.equal(facts("", JS.replace("let a=YI(n,yL(i),jH);", "let a=1e3;")).wait, false);
  assert.equal(facts("", JS.replace("r.waits===0?null:r.waits??bL()", "null")).wait, false);
  assert.equal(facts("", JS.replace("if(a===null)throw i;", "")).wait, false);
  assert.equal(facts("", JS.replace("var sV=1e3", "var sV=250")).wait, false);
  assert.equal(facts("", JS.replace("var UV=1e4", "var UV=6e4")).wait, false);
  assert.equal(facts("", JS.replace("Math.min(e*2,n.maxMs)", "Math.min(e,n.maxMs)")).wait, false);
  // down only for a failed read
  assert.equal(facts("", JS.replace("c=e instanceof jD?NH:e instanceof SL?kV:PH", "c=e instanceof jD?PH:e instanceof SL?kV:NH")).down, false);
  assert.equal(facts("", JS.replace("c=e instanceof jD?NH:e instanceof SL?kV:PH", "c=PH")).down, false);
});
