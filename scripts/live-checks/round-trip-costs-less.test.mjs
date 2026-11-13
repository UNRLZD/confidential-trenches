// node --test scripts/live-checks/round-trip-costs-less.test.mjs: the live check replays its recorded answers
// (round-trip-costs-less.answers.json). good: this card's build after the reviews of 024e8a89d and
// 3e288da51: PASS. bad: main 6430cba10's build, before this card: FAIL, every mark named. beforeDelta: this card's
// 024e8a89d build, the head that review read:
// FAIL on the rules it moved (the empty listing while a note is RESERVED, the counted passes, the held W, every rent
// back's claim, the listing) and on the sale's stamp, the trade lock and the load's start. Planted on the good one:
// another /app.js, no pin, each mark taken away: each FAIL; and the good build's lines (round-trip-costs-less.excerpt.txt,
// cut from its public/app.js; since card every-lamport-can-move that card's build) with one rule changed: each FAIL on
// that rule's mark alone.
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
    ["t?.buy!==void 0&&(Ke.buy=t.buy),", "", 0],
    // the finding read, the settled skip, the empty list while a note is RESERVED, the setup only with a W
    ["let m=await VY(s[1],p)", "let m=await VY(s[0],p)", 1],
    ["i.seen===void 0:i.seen!==a.seen||e)&&_.push(t)", "!0:!0)&&_.push(t)", 1],
    ["a.any?_.push(t):await g(t)&&await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{})", "_.push(t)", 1],
    ["await g(t)&&await Promise.resolve(e.owed.markEmpty", "await Promise.resolve(e.owed.markEmpty", 1],
    ["filter(e=>e.state===`RESERVED`)", "filter(e=>e.state===`SPENT`)", 1],
    ["if(_.length===0)return u!==null||m===null;", "", 1],
    [",zY=100,", ",zY=1000,", 1],
    ["l=await e.wallets(qY)}", "l=await e.wallets()}", 1],
    // the order and the counted gap
    ["[_[e],_[t]]=[_[t],_[e]]", "[_[e],_[t]]=[_[e],_[t]]", 2],
    ["if(l++>0&&await c(BY+XY(BY))", "if(l++>0&&await c(0+XY(BY))", 2],
    [",BY=1e3;", ",BY=0;", 2],
    ["globalThis.crypto.getRandomValues(n),n[0]<t", "n[0]=Math.random()*t,n[0]<t", 2],
    // the proof
    ["let e=await HY(t.rpcs[0],", "let e=await HY(t.rpcs[1],", 3],
    ["return r===null?i===`none`?null:`differs`:", "return r===null?null:", 3],
    ["&&i.mint===r.mint&&i.program===r.program?", "?", 3],
    // an unproven W; a found W's pass
    ["(a.rec===void 0&&!a.none?n.passes+1:c)>=3?`steady`", "(a.rec===void 0&&!a.none?n.passes+1:c)>=1?`steady`", 4],
    ["||l===`again`", "", 4],
    ["t.unproven!==`again`);", "!0);", 4],
    ["n.found===!0?{bare:!0}:l?{unproven:l}:{}", "l?{unproven:l}:{}", 4],
    ["h.steady&&u.bare!==!0?i:void 0", "h.steady?i:void 0", 4],
    // the positions' hold
    ["D=e.preempt?.();try{let l=0;for(", "D=void 0;try{let l=0;for(", 5],
    ["}finally{D?.()}return E}", "}finally{}return E}", 5],
    ["let n=t===qY?null:Xe.preempt(),", "let n=Xe.preempt(),", 5],
    // the no-buy mark
    ["T2=`owed/buy-sol-none`", "T2=`owed/buy-sol`", 6],
    ["buyNone:async t=>Object.hasOwn(nt(await(await e.store()).get(`meta`,T2)),t)", "buyNone:async t=>!1", 6],
    // the sell rule: the priority cap, rounded up, a limit's absence 1,400,000; the fee a sale names, full or partial
    ["if(LA(d.ixs,f)>100000n)return X(`priority`);", "", 7],
    [">100000n)return X(`priority`)", ">1000000n)return X(`priority`)", 7],
    ["(n*r+999999n)/1000000n}", "(n*r)/1000000n}", 7],
    ["let n=BigInt(oA),r=0n;", "let n=0n,r=0n;", 7],
    ["i.data[0]===2?n=", "i.data[0]===3?n=", 7],
    ["||_.fee>105000n||", "||", 7],
    ["_.fee>105000n||", "_.fee>1005000n||", 7],
    ["if(_===void 0||typeof _.full!=`boolean`||typeof _.fee", "if(_===void 0||typeof _.full!=`boolean`||_.full===!0&&typeof _.fee", 7],
    // the spacing: the stamp before each send, the gap's draw and rule, the claim for every rent back, the load's hold, the held W, a hold no fault
    ["`ct-device`", "`ct-wallet`", 8],
    ["=36e5,", "=6e6,", 8],
    ["&&sJ(e,t)&&t<e.at+e.gap", "&&t<e.at+e.gap&&e.at+e.gap<=t+36e5", 8],
    ["e!==void 0&&e.at!==n&&", "e!==void 0&&", 8],
    ["spacing:()=>t.spacing()", "spacing:async()=>void 0", 8],
    ["(e,t=uJ())=>", "(e,t)=>", 8],
    ["||!y||cJ(", "||cJ(", 8],
    ["vY>_&&(b=u)", "vY>_&&(!1,b=u)", 8],
    ["if(g&&x(g)){", "if(!1){", 8],
    ["if(y||t.sale===!0||e.owed?.claim===void 0)return;", "if(y||e.owed?.claim===void 0)return;", 8],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))throw lX;", "", 8],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))", "if(!await e.owed.claim(n,t.own).catch(()=>!0))", 8],
    ["if(t===cX||t===lX)throw t;", "if(t===cX)throw t;", 8],
    ["h=i.spaced??u;", "h=u;", 8],
    ["await _({at:f(),gap:YY()}),await Promise.allSettled", "await Promise.allSettled", 8],
    // a stamp over a newer one; an open that answers past the bound kept open; the sale's own rent back claiming
    ["(i===void 0||e.at>i.at||!sJ(i,e.at))&&t.put(", "t.put(", 8],
    ["i.onsuccess=()=>a?i.result.close():n(i.result)", "i.onsuccess=()=>n(i.result)", 8],
    ["wait:m,sale:!0,", "wait:m,", 8],
    // what W shows while it waits: the found W's listing, the owed end, the sweep's record before its send, the last sweep kept on a pass that gave up
    ["if((t.buy||e!==void 0)&&f===p&&t.read?.(f),", "if(", 9],
    ["if((t.buy||e!==void 0)&&f===p", "if(t.buy&&f===p", 9],
    ["if((t.buy||S!==void 0)&&t.read?.(v),", "if(", 9],
    ["P<w&&L>0n&&(t.buy||S!==void 0)&&t.read?.(L),", "", 9],
    ["await t.swept?.(D.one.signature,D.value),", "", 9],
    ["m=n===`sent`?i.sweep:i.lamports!==void 0&&n!==`gave_up`?void 0:l", "m=n===`sent`?i.sweep:i.lamports!==void 0?void 0:l", 9],
    ["m=n===`sent`?i.sweep:", "m=n===`sent`?void 0:", 9],
    ["p=i.unlisted===!0?void 0:n===`floor`?i.lamports?.toString():", "p=i.unlisted===!0?void 0:n===`sent`?i.lamports?.toString():", 9],
    ["n===`floor`?i.lamports?.toString():i.lamports===void 0?c:", "i.lamports===void 0?c:", 9],
    ["if(n===null)continue;", "", 9],
    ["e.state!==`PLANNED`&&e.state!==`INCOMING`", "e.state===`SPENT`", 9],
    ["h=m.some(e=>e.sweep!==void 0)?await c().catch(()=>null):[]", "h=[]", 9],
    // the sale's stamp
    ["Ke.spaced=qe;", "", 10],
    ["n.stamp=Promise.all([n.stamp,(async()=>e.owed?.space?.({at:qe,gap:YY()}))().catch(()=>{})]),", "", 10],
    // the stamp awaited before the send; the release wait unbounded; the release wait taken away
    ["(async()=>e.owed?.space?.({at:qe,gap:YY()}))().catch(()=>{})]),l=Ue,", "(async()=>e.owed?.space?.({at:qe,gap:YY()}))().catch(()=>{})]),await n.stamp,l=Ue,", 10],
    ["e.stamp&&BV(e.stamp,t,`the device's spacing`).catch(()=>{})", "e.stamp", 10],
    ["}).finally(()=>QJ(c,l?.storeMs??1e4));", "});", 10],
    // the trade lock
    ["catch{return!0}", "catch{return!1}", 11],
    ["if(l++>0&&await c(BY+XY(BY)),await sH(t,e.storeMs??1e4))", "if(l++>0&&await c(BY+XY(BY)),!1)", 11],
    ["return oH(t,()=>t.request(No,{mode:`shared`},async()=>{let t=c=e();try{", "return((e,t)=>t())(t,()=>t.request(No,{mode:`shared`},async()=>{let t=c=e();try{", 11],
    ["return oH(t,()=>t.request(No,{mode:`shared`},async()=>{try{await t.request(", "return((e,t)=>t())(t,()=>t.request(No,{mode:`shared`},async()=>{try{await t.request(", 11],
    ["let n=e?.query;return((n===void 0?void 0:await BV(n.call(e),t,`the lock manager's query`))", "let n=e?.query;return((n===void 0?void 0:await n.call(e))", 11],
    // the load's start
    ["R2=15e3,", "R2=0,", 12],
    ["while(e[0]>=4294940441)", "while(!1)", 12],
    ["i=e()+t,a=i,", "i=e(),a=i,", 12],
    ["again(){a=i,", "again(){a=0,", 12],
    [",Ct=B2(),", ",Ct=B2(Date.now,0),", 12],
    // card every-lamport-can-move T3: a tap's ride passes a W whose last pass ended at the floor; a load's never does
    ["let e=n.ride===!0&&i.floor===!0;", "let e=i.floor===!0;", 1],
    ["||e)&&_.push(t)}", ")&&_.push(t)}", 1],
    // card every-lamport-can-move, review P1: a fault in the buy's proof is no answer and counts nothing; only a read that plainly disagrees counts
    ["catch{return}if(i!==null)", "catch{return null}if(i!==null)", 3],
    ["return r===null?i===`none`?null:`differs`:", "return r===null?i===`none`?null:void 0:", 3],
    ["e===`differs`?c++:s=e", "e===void 0?c++:s=e", 3],
    ["?n.passes+1:c)>=3", "?n.passes+1:c+1)>=3", 4],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(JS.split(from).length, 2, `once: ${from}`);
    const js = JS.replace(from, to);
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});

// Card every-lamport-can-move: its build spells the sell rule's fee bound in the one check of the sale's own reads (with
// the full flag and a full sell's reserve of 0), and a W whose pass ended under the floor is listed at what it adds once
// moved (restAdds, pick (a)), unlisted when that is 0. The excerpt is that build's: each rule changed FAILs on
// its mark alone.
test("every-lamport-can-move's spellings carry the fee bound and the owed listing; each changed FAILs on its mark", () => {
  const LAMPORT = JS;
  for (const [from, to, i] of [
    ["||_.fee>105000n||", "||", 7],
    ["_.fee>105000n||", "_.fee>1005000n||", 7],
    ["typeof _.fee!=`bigint`||", "", 7],
    ["P<w&&L===0n&&t.unlisted?.(),", "", 9],
    ["t.read?.(L)", "t.read?.(M)", 9],
    ["t.read?.(L)", "t.read?.(v)", 9],
    ["L=NY(M,Nm(l),w)", "L=M", 9],
    ["if(r>=n)return r;", "", 9],
    ["return i>=1000000n?i-i%BC:0n}", "return i>0n?i:0n}", 9],
    ["p=i.unlisted===!0?void 0:", "p=", 9],
    ["n===`floor`?i.lamports?.toString():", "n===`floor`?void 0:", 9],
  ]) {
    assert.equal(LAMPORT.split(from).length, 2, `once: ${from}`);
    const c = facts("", LAMPORT.replace(from, to)).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
