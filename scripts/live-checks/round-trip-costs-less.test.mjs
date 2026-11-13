// node --test scripts/live-checks/round-trip-costs-less.test.mjs: the live check replays its recorded answers
// (round-trip-costs-less.answers.json). good: this card's build, any browser of the account finishing its Ws: PASS.
// bad: main b9361e809's build, before this card: FAIL, every mark named. beforeReview: this card's 20ba2481b build,
// before the review of it was folded: FAIL on the rules that review moved (the proven buy kept, and the rent backs'
// reads), and the price rules. beforePrice: its 591044f67 build, the sale's closes out, before the price read from recent
// fees: FAIL on the price rules alone, and the sell rule's priority cap. beforeFix: its 618f53d6c build, the price the lower
// of both RPCs and waited for, before the review of it: FAIL on the same three and the spacing. beforeP3: its fe31cf1ca
// build, before the second review's items: FAIL on the sell rule's fee bound (a partial sale's) and the spacing. Planted
// on the good one: another /app.js, no pin, each mark taken away: each FAIL; and the good build's lines
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

test("recorded answer beforePrice (591044f67's build, the closes out and no price read): FAIL on the price rules, the cap, the spacing and the listing, and the found W's pass (none in that build)", () => {
  const v = judge(ANSWERS.beforePrice);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[0], ALL[1], ALL[6], ALL[9], ALL[10], ALL[11]]);
});

test("recorded answer beforeFix (618f53d6c's build, the lower price waited for): FAIL on the price rules, the cap, the spacing and the listing, and the found W's pass (none in that build)", () => {
  const v = judge(ANSWERS.beforeFix);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[0], ALL[1], ALL[6], ALL[9], ALL[10], ALL[11]]);
});

test("recorded answer beforeP3 (fe31cf1ca's build, a partial sale's fee unbounded, leftover sweeps back to back): FAIL on those, the listing, and the found W's pass (none in that build)", () => {
  const v = judge(ANSWERS.beforeP3);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[6], ALL[9], ALL[10], ALL[11]]);
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
    ["return i>1n?i:Rq}", "return i>0n?i:Rq}", 0],
    [" Rq=1n;", " Rq=0n;", 0],
    ["||t<0)throw Error(`not a price`)", ")throw Error(`not a price`)", 0],
    ["||i.length===0)throw", ")throw", 0],
    ["return i>1n?i:Rq}catch{return null}}", "return i>1n?i:Rq}catch{return 1n}}", 0],
    ["[t(e[0]),t(e[1])]", "[t(e[0]),t(e[0])]", 0],
    ["if(s.aborted||!a.open(n))", "if(s.aborted)", 0],
    ["a.count();", "", 0],
    ["backoffMs:r.deadlineMs}", "backoffMs:0}", 0],
    [":Sz.get(e.url)}", ":e.optional}", 0],
    ["return n===`trade`&&!Sz.has(i)", "return!Sz.has(i)", 0],
    // its use: never waited for, the cap where it is not in by the first simulation, the cap after a sale not landed
    ["e.writable&&!e.signer", "e.writable", 1],
    [".then(e=>Ae=e)", ".then(e=>e)", 1],
    ["t=Ae??void 0;", "t=void 0;", 1],
    ["ke.abort();let n=", "let n=", 1],
    [":null,Oe,t)", ":null,Oe)", 1],
    ["s=n!==void 0&&n<o?n:o;", "s=o;", 1],
    ["s=n!==void 0&&n<o?n:o;", "s=n??o;", 1],
    ["&&!Bq.has(r.address)&&", "&&", 1],
    ["?Bq.add(r.address):", "?void 0:", 1],
    ["&&Bq.delete(r.address)", "&&void 0", 1],
    // the record's buy
    ["t?.buy!==void 0&&($e.buy=t.buy),", "", 2],
    // the finding read, the settled skip, the empty list, the setup only with a W
    ["let p=await uJ(o[1],f)", "let p=await uJ(o[0],f)", 3],
    ["r.seen===void 0:r.seen!==i.seen)&&m.push(t)", "!0:!0)&&m.push(t)", 3],
    ["i.any?m.push(t):await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{})", "m.push(t)", 3],
    ["if(m.length===0)return l!==null||p===null;", "", 3],
    [",cJ=100,", ",cJ=1000,", 3],
    ["c=await e.wallets(hJ)}", "c=await e.wallets()}", 3],
    // the order and the gap
    ["[m[e],m[t]]=[m[t],m[e]]", "[m[e],m[t]]=[m[e],m[t]]", 4],
    ["{n>0&&await s(lJ+vJ(lJ)", "{n>0&&await s(0+vJ(lJ)", 4],
    [",lJ=1e3;", ",lJ=0;", 4],
    ["globalThis.crypto.getRandomValues(n),n[0]<t", "n[0]=Math.random()*t,n[0]<t", 4],
    // the proof
    ["(s=await dJ(t.rpcs[0],", "(s=await dJ(t.rpcs[1],", 5],
    ["if(r===null)return i===`none`?null:void 0;", "if(r===null)return null;", 5],
    ["&&i.mint===r.mint&&i.program===r.program)", ")", 5],
    // an unproven W
    ["n.passes+1>=3?`steady`:`again`", "n.passes+1>=1?`steady`:`again`", 6],
    ["||c===`again`", "", 6],
    ["t.unproven!==`again`);", "!0);", 6],
    // the positions' hold
    ["C=e.preempt?.();try{for(", "C=void 0;try{for(", 7],
    ["}finally{C?.()}return S}", "}finally{}return S}", 7],
    ["let r=n===hJ?null:Ye.preempt(),", "let r=Ye.preempt(),", 7],
    // the no-buy mark
    ["FQ=`owed/buy-sol-none`", "FQ=`owed/buy-sol`", 8],
    ["buyNone:async t=>Object.hasOwn(tt(await(await e.store()).get(`meta`,FQ)),t)", "buyNone:async t=>!1", 8],
    // the sell rule: the priority cap, rounded up, a limit's absence 1,400,000; the fee a sale names, full or partial
    ["if(Uk(d.ixs,f)>100000n)return X(`priority`);", "", 9],
    [">100000n)return X(`priority`)", ">1000000n)return X(`priority`)", 9],
    ["(n*r+999999n)/1000000n}", "(n*r)/1000000n}", 9],
    ["let n=BigInt(_k),r=0n;", "let n=0n,r=0n;", 9],
    ["i.data[0]===2?n=", "i.data[0]===3?n=", 9],
    ["||v.fee>105000n))", "))", 9],
    ["v.fee>105000n))", "v.fee>1005000n))", 9],
    ["if(v!==void 0&&(typeof v.fee", "if(v!==void 0&&v.full===!0&&(typeof v.fee", 9],
    // the spacing: the device's stamp before each send, the gap's draw and rule, the claim, the load's hold, a hold no fault
    // (10); what W shows while it waits (11); a found W's pass (6)
    ["`ct-device`", "`ct-wallet`", 10],
    ["=36e5,", "=6e6,", 10],
    ["&&e.at+e.gap<=t+36e5", "", 10],
    ["e!==void 0&&e.at!==n&&", "e!==void 0&&", 10],
    ["spacing:()=>t.spacing()", "spacing:async()=>void 0", 10],
    ["(e,t=jK())=>", "(e,t)=>", 10],
    ["!g||kK(", "kK(", 10],
    ["Hq>l&&(", "Hq>l&&(!1,", 10],
    ["quiet:_(l),leftover:!0,", "quiet:_(l),", 10],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))throw jJ;", "", 10],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))", "if(!await e.owed.claim(n,t.own).catch(()=>!0))", 10],
    ["if(t===AJ||t===jJ)throw t;", "if(t===AJ)throw t;", 10],
    ["m=i.spaced??u;", "m=u;", 10],
    ["await _({at:f(),gap:_J()}),await Promise.allSettled", "await Promise.allSettled", 10],
    ["if(t.buy&&f===p&&t.read?.(f),", "if(", 11],
    ["if(t.quiet===!0)throw jJ;let h=", "let h=", 11],
    ["if(t.buy&&t.read?.(h),", "if(", 11],
    ["W holds nothing`};if(t.quiet===!0)throw jJ;", "W holds nothing`};", 11],
    ["t.swept?.(E.one.signature),", "", 11],
    ["p=n===`sent`?i.sweep:", "p=n===`sent`?void 0:", 11],
    ["f=n===`floor`?void 0:i.lamports===void 0?c:", "f=n===`sent`?void 0:i.lamports===void 0?c:", 11],
    ["f=n===`floor`?void 0:i.lamports===void 0?c:", "f=i.lamports===void 0?c:", 11],
    ["if(n===null)continue;", "", 11],
    ["e.state!==`PLANNED`&&e.state!==`INCOMING`", "e.state===`SPENT`", 11],
    ["h=m.some(e=>e.sweep!==void 0)?await c().catch(()=>null):[]", "h=[]", 11],
    ["n.found===!0?{bare:!0}:c?{unproven:c}:{}", "c?{unproven:c}:{}", 6],
    ["p.steady&&l.bare!==!0?i:void 0", "p.steady?i:void 0", 6],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(JS.split(from).length, 2, `once: ${from}`);
    const js = JS.replace(from, to);
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
