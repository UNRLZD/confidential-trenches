// node --test scripts/live-checks/round-trip-costs-less.test.mjs: the live check replays its recorded answers
// (round-trip-costs-less.answers.json). good: this card's build, any browser of the account finishing its Ws: PASS.
// bad: main b9361e809's build, before this card: FAIL, every mark named. beforeReview: this card's 20ba2481b build,
// before the review of it was folded: FAIL on the rules that review moved (the proven buy kept, and the rent backs'
// reads), and the price rules. beforePrice: its 591044f67 build, the sale's closes out, before the price read from recent
// fees: FAIL on the price rules alone, and the sell rule's priority cap. beforeFix: its 618f53d6c build, the price the lower
// of both RPCs and waited for, before the review of it: FAIL on the same three. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL; and the good build's lines
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
  assert.deepEqual(v.lines, ALL);
});

test("recorded answer beforePrice (591044f67's build, the closes out and no price read): FAIL on the price rules and the cap", () => {
  const v = judge(ANSWERS.beforePrice);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[0], ALL[1], ALL[9]]);
});

test("recorded answer beforeFix (618f53d6c's build, the lower price waited for): FAIL on the price rules and the cap", () => {
  const v = judge(ANSWERS.beforeFix);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[0], ALL[1], ALL[9]]);
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
    // the price: the 75th percentile, the higher RPC, the floor, a bad or empty answer none; each read optional, sent once,
    // only to an open host, found by its url
    ["Math.ceil(a.length*3/4)-1", "Math.ceil(a.length*1/2)-1", 0],
    ["i=t>n?t:n;", "i=t<n?t:n;", 0],
    ["return i>1n?i:oq}", "return i>0n?i:oq}", 0],
    [" oq=1n;", " oq=0n;", 0],
    ["||t<0)throw Error(`not a price`)", ")throw Error(`not a price`)", 0],
    ["||i.length===0)throw", ")throw", 0],
    ["catch{return null}}", "catch{return 1n}}", 0],
    ["[t(e[0]),t(e[1])]", "[t(e[0]),t(e[0])]", 0],
    ["if(s.aborted||!a.open(n))", "if(s.aborted)", 0],
    ["a.count();", "", 0],
    ["backoffMs:r.deadlineMs}", "backoffMs:0}", 0],
    [":zU.get(e.url)}", ":e.optional}", 0],
    ["return n===`trade`&&!zU.has(i)", "return!zU.has(i)", 0],
    // its use: never waited for, the cap where it is not in by the first simulation, the cap after a sale not landed
    ["e.writable&&!e.signer", "e.writable", 1],
    [".then(e=>Ae=e)", ".then(e=>e)", 1],
    ["t=Ae??void 0;", "t=void 0;", 1],
    ["ke.abort();let n=", "let n=", 1],
    [":null,Oe,t)", ":null,Oe)", 1],
    ["s=n!==void 0&&n<o?n:o;", "s=o;", 1],
    ["s=n!==void 0&&n<o?n:o;", "s=n??o;", 1],
    ["&&!cq.has(r.address)&&", "&&", 1],
    ["?cq.add(r.address):", "?void 0:", 1],
    ["&&cq.delete(r.address)", "&&void 0", 1],
    // the record's buy
    ["t?.buy!==void 0&&($e.buy=t.buy),", "", 2],
    // the finding read, the settled skip, the empty list, the setup only with a W
    ["let p=await Aq(o[1],f)", "let p=await Aq(o[0],f)", 3],
    ["r.seen===void 0:r.seen!==i.seen)&&m.push(t)", "!0:!0)&&m.push(t)", 3],
    ["i.any?m.push(t):await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{})", "m.push(t)", 3],
    ["if(m.length===0)return l!==null||p===null;", "", 3],
    [",Oq=100,", ",Oq=1000,", 3],
    ["c=await e.wallets(Fq)}", "c=await e.wallets()}", 3],
    // the order and the gap
    ["[m[e],m[t]]=[m[t],m[e]]", "[m[e],m[t]]=[m[e],m[t]]", 4],
    ["if(n>0&&await s(kq+Lq(kq)", "if(n>0&&await s(0+Lq(kq)", 4],
    [",kq=1e3;", ",kq=0;", 4],
    ["globalThis.crypto.getRandomValues(n),n[0]<t", "n[0]=Math.random()*t,n[0]<t", 4],
    // the proof
    ["(s=await jq(t.rpcs[0],", "(s=await jq(t.rpcs[1],", 5],
    ["if(r===null)return i===`none`?null:void 0;", "if(r===null)return null;", 5],
    ["&&i.mint===r.mint&&i.program===r.program)", ")", 5],
    // an unproven W
    ["n.passes+1>=3?`steady`:`again`", "n.passes+1>=1?`steady`:`again`", 6],
    ["||c===`again`", "", 6],
    ["t.unproven!==`again`);", "!0);", 6],
    // the positions' hold
    ["b=e.preempt?.();try{for(", "b=void 0;try{for(", 7],
    ["}finally{b?.()}return y}", "}finally{}return y}", 7],
    ["let r=n===Fq?null:Ye.preempt(),", "let r=Ye.preempt(),", 7],
    // the no-buy mark
    ["BZ=`owed/buy-sol-none`", "BZ=`owed/buy-sol`", 8],
    ["buyNone:async t=>Object.hasOwn(tt(await(await e.store()).get(`meta`,BZ)),t)", "buyNone:async t=>!1", 8],
    // the sell rule: the priority cap, rounded up, a limit's absence 1,400,000, the full sell's fee
    ["if(Ak(d.ixs,f)>100000n)return X(`priority`);", "", 9],
    [">100000n)return X(`priority`)", ">1000000n)return X(`priority`)", 9],
    ["(n*r+999999n)/1000000n}", "(n*r)/1000000n}", 9],
    ["let n=BigInt(ik),r=0n;", "let n=0n,r=0n;", 9],
    ["i.data[0]===2?n=", "i.data[0]===3?n=", 9],
    ["v.fee>105000n||", "", 9],
    ["v.fee>105000n||", "v.fee>1005000n||", 9],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(JS.split(from).length, 2, `once: ${from}`);
    const js = JS.replace(from, to);
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
