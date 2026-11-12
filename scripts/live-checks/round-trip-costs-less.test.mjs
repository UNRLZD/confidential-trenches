// node --test scripts/live-checks/round-trip-costs-less.test.mjs: the live check replays its recorded answers
// (round-trip-costs-less.answers.json). good: this card's build, the sale closing W's accounts where that costs less and
// any browser of the account finishing its Ws: PASS. bad: main b9361e809's build, before this card: FAIL, every mark
// named. beforeReview: this card's 20ba2481b build, before the review of it was folded: FAIL on the rules that review
// moved (the cost rule decided after the size fallback, no close on the last build, what the sale left read from the
// balances before it, the proven buy kept, and the rent backs' reads). beforeFill: its 8c08894bd build, the cost rule
// decided at the quote's expected out against a model of the form before: FAIL on that rule. Planted on the good one: another /app.js, no pin,
// each mark taken away: each FAIL; and the good build's lines (round-trip-costs-less.excerpt.txt, cut from its
// public/app.js) with one rule changed: each FAIL on that rule's mark alone.
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

test("recorded bad answer (main b9361e809's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("recorded answer beforeReview (20ba2481b's build): FAIL on the rules the review moved", () => {
  const v = judge(ANSWERS.beforeReview);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [0, 1, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => ALL[i]));
});

test("recorded answer beforeFill (8c08894bd's build): FAIL on the cost rule alone, decided there at the expected out against a model of the form before", () => {
  const v = judge(ANSWERS.beforeFill);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[1]]);
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
    // the closes in the sale: when, and as fits
    ["&&!n.last&&!Oe(L.stateSize)", "&&!Oe(L.stateSize)", 0],
    ["xe===0&&n.bare!==!0", "n.bare!==!0", 0],
    ["&&!Oe(L.stateSize)&&!Oe(L.labelSize)?", "?", 0],
    ["(Ae=Ae.filter(e=>e.kind===`token`))", "(Ae=[])", 0],
    [",td=1232,", ",td=1300,", 0],
    ["Oe=e=>Qv-e%Qv<=64,", "Oe=e=>Qv-e%Qv<=128,", 0],
    // the cost rule
    ["F.accounts,new Set),t=qy(N,0)", "F.accounts,ke),t=qy(N,0)", 1],
    ["a=n>_e?n-_e:0n", "a=0n", 1],
    [";t+l+a>p&&(Ae=[])}", ";t+a>p&&(Ae=[])}", 1],
    [";t+l+a>p&&(Ae=[])}", ";t+l>p&&(Ae=[])}", 1],
    ["&&(Ae=[])}", "&&(Ae=Ae)}", 1],
    ["p=`refused`in d||d.value===0n?u:u+(s<f?s:f)", "p=u+(s<f?s:f)", 1],
    ["p=`refused`in d||d.value===0n?u:u+(s<f?s:f)", "p=`refused`in d||d.value===0n?u:u+f", 1],
    [",swept:Se-t,base:t,floor:o})", ",swept:Se-t})", 1],
    ["2n*(qy(e,PO)-qy(e,0))", "2n*qy(e,PO)", 1],
    // the deposit with the closes
    ["after:r,lamports:R+i,", "after:r,lamports:R,", 2],
    ["after:r,lamports:R+i,", "after:Se,lamports:R+i,", 2],
    // a refusal or failure of the closes
    ["if(Ae.length>0){Ae=[];continue}", "", 3],
    [",o&&(n.bare=!0)", "", 3],
    ["r.every(e=>_G(e.err,a)||gG(e.err,qe)),{end:c}", "r.every(e=>_G(e.err,a)),{end:c}", 3],
    ["s=i&&!n.last&&r.every", "s=i&&r.every", 3],
    // the rule's closes
    ["if(S.length<C.length)return X(`closes`);", "", 4],
    ["||!SO(n.accounts,t.accounts))return X(`closes`)", ")return X(`closes`)", 4],
    ["n.data.some((e,n)=>e!==t.data[n])||", "", 4],
    // what the sale left
    ["if(r.mint===n&&r.owner===t)return 0n", "if(r.mint===n)return 0n", 5],
    ["if(r.mint===n&&r.owner===t)return 0n", "if(r.mint===n&&r.owner===t)return null", 5],
    // the record's buy
    ["t?.buy!==void 0&&(tt.buy=t.buy),", "", 6],
    // the finding read, the settled skip, the empty list, the setup only with a W
    ["let p=await AG(o[1],f)", "let p=await AG(o[0],f)", 7],
    ["r.seen===void 0:r.seen!==i.seen)&&m.push(t)", "!0:!0)&&m.push(t)", 7],
    ["i.any?m.push(t):await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{})", "m.push(t)", 7],
    ["if(m.length===0)return l!==null||p===null;", "", 7],
    [",OG=100,", ",OG=1000,", 7],
    ["c=await e.wallets(FG)}", "c=await e.wallets()}", 7],
    // the order and the gap
    ["[m[e],m[t]]=[m[t],m[e]]", "[m[e],m[t]]=[m[e],m[t]]", 8],
    ["if(n>0&&await s(kG+LG(kG))", "if(n>0&&await s(0+LG(kG))", 8],
    [",kG=1e3;", ",kG=0;", 8],
    ["globalThis.crypto.getRandomValues(n),n[0]<t", "n[0]=Math.random()*t,n[0]<t", 8],
    // the proof
    ["(s=await jG(t.rpcs[0],", "(s=await jG(t.rpcs[1],", 9],
    ["if(r===null)return i===`none`?null:void 0;", "if(r===null)return null;", 9],
    ["&&i.mint===r.mint&&i.program===r.program)", ")", 9],
    // an unproven W
    ["n.passes+1>=3?`steady`:`again`", "n.passes+1>=1?`steady`:`again`", 10],
    ["||c===`again`", "", 10],
    ["t.unproven!==`again`);", "!0);", 10],
    // the positions' hold
    ["b=e.preempt?.();try{for(", "b=void 0;try{for(", 11],
    ["}finally{b?.()}return y}", "}finally{}return y}", 11],
    ["let r=n===FG?null:Ke.preempt(),", "let r=Ke.preempt(),", 11],
    // the no-buy mark
    ["gJ=`owed/buy-sol-none`", "gJ=`owed/buy-sol`", 12],
    ["buyNone:async t=>Object.hasOwn(Qe(await(await e.store()).get(`meta`,gJ)),t)", "buyNone:async t=>!1", 12],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(JS.split(from).length, 2, `once: ${from}`);
    const js = JS.replace(from, to);
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
