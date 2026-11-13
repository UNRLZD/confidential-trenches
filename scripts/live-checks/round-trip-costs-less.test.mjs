// node --test scripts/live-checks/round-trip-costs-less.test.mjs: the live check replays its recorded answers
// (round-trip-costs-less.answers.json). good: this card's build after the reviews of 024e8a89d and
// 3e288da51: PASS. bad: main 6430cba10's build, before this card: FAIL, every mark named. beforeDelta: this card's
// 024e8a89d build, the head that review read:
// FAIL on the rules it moved (the empty listing while a note is RESERVED, the counted passes, the held W, every rent
// back's claim, the listing) and on the sale's stamp, the trade lock and the load's start. Planted on the good one:
// another /app.js, no pin, each mark taken away: each FAIL; and the good build's lines (round-trip-costs-less.excerpt.txt,
// cut from its public/app.js) with one rule changed: each FAIL on that rule's mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./round-trip-costs-less.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./round-trip-costs-less.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (main 6430cba10's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("recorded answer beforeDelta (024e8a89d's build): FAIL on the rules the review moved and the three it added", () => {
  const v = judge(ANSWERS.beforeDelta);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [1, 2, 5, 8, 9, 10, 11, 12].map((i) => ALL[i]));
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

const JS = readFileSync(new URL("./round-trip-costs-less.excerpt.txt", import.meta.url), "utf8");
test("the good build's lines carry every mark; each with its rule changed FAILs on that mark alone", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    // the record's buy
    ["t?.buy!==void 0&&(Xe.buy=t.buy),", "", 0],
    // the finding read, the settled skip, the empty list while a note is RESERVED, the setup only with a W
    ["let p=await yJ(o[1],f)", "let p=await yJ(o[0],f)", 1],
    ["r.seen===void 0:r.seen!==i.seen)&&g.push(t)", "!0:!0)&&g.push(t)", 1],
    ["i.any?g.push(t):await h(t)&&await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{})", "g.push(t)", 1],
    ["await h(t)&&await Promise.resolve(e.owed.markEmpty", "await Promise.resolve(e.owed.markEmpty", 1],
    ["filter(e=>e.state===`RESERVED`)", "filter(e=>e.state===`SPENT`)", 1],
    ["if(g.length===0)return l!==null||p===null;", "", 1],
    [",_J=100,", ",_J=1000,", 1],
    ["c=await e.wallets(TJ)}", "c=await e.wallets()}", 1],
    // the order and the counted gap
    ["[g[e],g[t]]=[g[t],g[e]]", "[g[e],g[t]]=[g[e],g[t]]", 2],
    ["if(c++>0&&await s(vJ+OJ(vJ))", "if(c++>0&&await s(0+OJ(vJ))", 2],
    [",vJ=1e3;", ",vJ=0;", 2],
    ["globalThis.crypto.getRandomValues(n),n[0]<t", "n[0]=Math.random()*t,n[0]<t", 2],
    // the proof
    ["(s=await bJ(t.rpcs[0],", "(s=await bJ(t.rpcs[1],", 3],
    ["if(r===null)return i===`none`?null:void 0;", "if(r===null)return null;", 3],
    ["&&i.mint===r.mint&&i.program===r.program)", ")", 3],
    // an unproven W; a found W's pass
    ["n.passes+1>=3?`steady`:`again`", "n.passes+1>=1?`steady`:`again`", 4],
    ["||c===`again`", "", 4],
    ["t.unproven!==`again`);", "!0);", 4],
    ["n.found===!0?{bare:!0}:c?{unproven:c}:{}", "c?{unproven:c}:{}", 4],
    ["p.steady&&l.bare!==!0?i:void 0", "p.steady?i:void 0", 4],
    // the positions' hold
    ["E=e.preempt?.();try{let c=0;for(", "E=void 0;try{let c=0;for(", 5],
    ["}finally{E?.()}return T}", "}finally{}return T}", 5],
    ["let r=n===TJ?null:Ye.preempt(),", "let r=Ye.preempt(),", 5],
    // the no-buy mark
    ["qQ=`owed/buy-sol-none`", "qQ=`owed/buy-sol`", 6],
    ["buyNone:async t=>Object.hasOwn(tt(await(await e.store()).get(`meta`,qQ)),t)", "buyNone:async t=>!1", 6],
    // the sell rule: the priority cap, rounded up, a limit's absence 1,400,000; the fee a sale names, full or partial
    ["if(Kk(d.ixs,f)>100000n)return X(`priority`);", "", 7],
    [">100000n)return X(`priority`)", ">1000000n)return X(`priority`)", 7],
    ["(n*r+999999n)/1000000n}", "(n*r)/1000000n}", 7],
    ["let n=BigInt(bk),r=0n;", "let n=0n,r=0n;", 7],
    ["i.data[0]===2?n=", "i.data[0]===3?n=", 7],
    ["||v.fee>105000n))", "))", 7],
    ["v.fee>105000n))", "v.fee>1005000n))", 7],
    ["if(v!==void 0&&(typeof v.fee", "if(v!==void 0&&v.full===!0&&(typeof v.fee", 7],
    // the spacing: the stamp before each send, the gap's draw and rule, the claim for every rent back, the load's hold, the held W, a hold no fault
    ["`ct-device`", "`ct-wallet`", 8],
    ["=36e5,", "=6e6,", 8],
    ["&&VK(e,t)&&t<e.at+e.gap", "&&t<e.at+e.gap&&e.at+e.gap<=t+36e5", 8],
    ["e!==void 0&&e.at!==n&&", "e!==void 0&&", 8],
    ["spacing:()=>t.spacing()", "spacing:async()=>void 0", 8],
    ["(e,t=WK())=>", "(e,t)=>", 8],
    ["!v||HK(", "HK(", 8],
    ["Qq>g&&(", "Qq>g&&(!1,", 8],
    ["if(h&&b(h)){", "if(!1){", 8],
    ["if(y||t.sale===!0||e.owed?.claim===void 0)return;", "if(y||e.owed?.claim===void 0)return;", 8],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))throw VJ;", "", 8],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))", "if(!await e.owed.claim(n,t.own).catch(()=>!0))", 8],
    ["if(t===BJ||t===VJ)throw t;", "if(t===BJ)throw t;", 8],
    ["m=i.spaced??u;", "m=u;", 8],
    ["await _({at:f(),gap:DJ()}),await Promise.allSettled", "await Promise.allSettled", 8],
    // a stamp over a newer one; an open that answers past the bound kept open; the sale's own rent back claiming
    ["(i===void 0||e.at>i.at||!VK(i,e.at))&&t.put(", "t.put(", 8],
    ["i.onsuccess=()=>a?i.result.close():n(i.result)", "i.onsuccess=()=>n(i.result)", 8],
    ["wait:m,sale:!0,", "wait:m,", 8],
    // what W shows while it waits: the found W's listing, the owed end, the sweep's record before its send, the last sweep kept on a pass that gave up
    ["if((t.buy||e!==void 0)&&f===p&&t.read?.(f),", "if(", 9],
    ["if((t.buy||e!==void 0)&&f===p", "if(t.buy&&f===p", 9],
    ["if((t.buy||S!==void 0)&&t.read?.(h),", "if(", 9],
    ["if(k<w&&d>0&&(t.buy||S!==void 0)&&t.read?.(k>0n?k:0n),", "if(", 9],
    ["await t.swept?.(E.one.signature,E.value),", "", 9],
    ["p=n===`sent`?i.sweep:i.lamports!==void 0&&n!==`gave_up`?void 0:l", "p=n===`sent`?i.sweep:i.lamports!==void 0?void 0:l", 9],
    ["p=n===`sent`?i.sweep:", "p=n===`sent`?void 0:", 9],
    ["f=n===`floor`?void 0:i.lamports===void 0?c:", "f=n===`sent`?void 0:i.lamports===void 0?c:", 9],
    ["f=n===`floor`?void 0:i.lamports===void 0?c:", "f=i.lamports===void 0?c:", 9],
    ["if(n===null)continue;", "", 9],
    ["e.state!==`PLANNED`&&e.state!==`INCOMING`", "e.state===`SPENT`", 9],
    ["h=m.some(e=>e.sweep!==void 0)?await c().catch(()=>null):[]", "h=[]", 9],
    // the sale's stamp
    ["Xe.spaced=Ze;", "", 10],
    ["n.stamp=Promise.all([n.stamp,(async()=>e.owed?.space?.({at:Ze,gap:DJ()}))().catch(()=>{})]),", "", 10],
    // the stamp awaited before the send; the release wait unbounded; the release wait taken away
    ["(async()=>e.owed?.space?.({at:Ze,gap:DJ()}))().catch(()=>{})]),l=qe,", "(async()=>e.owed?.space?.({at:Ze,gap:DJ()}))().catch(()=>{})]),await n.stamp,l=qe,", 10],
    ["e.stamp&&CB(e.stamp,t,`the device's spacing`).catch(()=>{})", "e.stamp", 10],
    ["}).finally(()=>Mq(c,l?.storeMs??1e4));", "});", 10],
    // the trade lock
    ["catch{return!0}", "catch{return!1}", 11],
    ["if(c++>0&&await s(vJ+OJ(vJ)),await WB(t,e.storeMs??1e4))", "if(c++>0&&await s(vJ+OJ(vJ)),!1)", 11],
    ["return UB(t,()=>t.request(Po,{mode:`shared`},async()=>{let t=c=e();try{", "return((e,t)=>t())(t,()=>t.request(Po,{mode:`shared`},async()=>{let t=c=e();try{", 11],
    ["return UB(t,()=>t.request(Po,{mode:`shared`},async()=>{try{await t.request(", "return((e,t)=>t())(t,()=>t.request(Po,{mode:`shared`},async()=>{try{await t.request(", 11],
    ["let n=e?.query;return((n===void 0?void 0:await CB(n.call(e),t,`the lock manager's query`))", "let n=e?.query;return((n===void 0?void 0:await n.call(e))", 11],
    // the load's start
    ["o$=15e3,", "o$=0,", 12],
    ["while(e[0]>=4294940441)", "while(!1)", 12],
    ["r=e()+t,i=r,", "r=e(),i=r,", 12],
    ["again(){i=r,", "again(){i=0,", 12],
    [",St=c$(),", ",St=c$(Date.now,0),", 12],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(JS.split(from).length, 2, `once: ${from}`);
    const js = JS.replace(from, to);
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
