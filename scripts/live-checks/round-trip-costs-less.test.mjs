// node --test scripts/live-checks/round-trip-costs-less.test.mjs: the live check replays its recorded answers
// (round-trip-costs-less.answers.json). good: this card's build, any browser of the account finishing its Ws: PASS.
// bad: main b9361e809's build, before this card: FAIL, every mark named. beforeReview: this card's 20ba2481b build,
// before the review of it was folded: FAIL on the rules that review moved (the proven buy kept, and the rent backs'
// reads). Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL; and the good build's lines
// (round-trip-costs-less.excerpt.txt, cut from its public/app.js) with one rule changed: each FAIL on that rule's mark
// alone.
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
  assert.deepEqual(v.lines, [0, 1, 2, 3, 4, 5, 6].map((i) => ALL[i]));
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
    // the finding read, the settled skip, the empty list, the setup only with a W
    ["let p=await EG(o[1],f)", "let p=await EG(o[0],f)", 1],
    ["r.seen===void 0:r.seen!==i.seen)&&m.push(t)", "!0:!0)&&m.push(t)", 1],
    ["i.any?m.push(t):await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{})", "m.push(t)", 1],
    ["if(m.length===0)return l!==null||p===null;", "", 1],
    [",wG=100,", ",wG=1000,", 1],
    ["c=await e.wallets(jG)}", "c=await e.wallets()}", 1],
    // the order and the gap
    ["[m[e],m[t]]=[m[t],m[e]]", "[m[e],m[t]]=[m[e],m[t]]", 2],
    ["if(n>0&&await s(TG+NG(TG))", "if(n>0&&await s(0+NG(TG))", 2],
    [",TG=1e3;", ",TG=0;", 2],
    ["globalThis.crypto.getRandomValues(n),n[0]<t", "n[0]=Math.random()*t,n[0]<t", 2],
    // the proof
    ["(s=await DG(t.rpcs[0],", "(s=await DG(t.rpcs[1],", 3],
    ["if(r===null)return i===`none`?null:void 0;", "if(r===null)return null;", 3],
    ["&&i.mint===r.mint&&i.program===r.program)", ")", 3],
    // an unproven W
    ["n.passes+1>=3?`steady`:`again`", "n.passes+1>=1?`steady`:`again`", 4],
    ["||c===`again`", "", 4],
    ["t.unproven!==`again`);", "!0);", 4],
    // the positions' hold
    ["b=e.preempt?.();try{for(", "b=void 0;try{for(", 5],
    ["}finally{b?.()}return y}", "}finally{}return y}", 5],
    ["let r=n===jG?null:Ke.preempt(),", "let r=Ke.preempt(),", 5],
    // the no-buy mark
    ["fJ=`owed/buy-sol-none`", "fJ=`owed/buy-sol`", 6],
    ["buyNone:async t=>Object.hasOwn(Qe(await(await e.store()).get(`meta`,fJ)),t)", "buyNone:async t=>!1", 6],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(JS.split(from).length, 2, `once: ${from}`);
    const js = JS.replace(from, to);
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
