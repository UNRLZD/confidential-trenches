// node --test scripts/live-checks/round-trip-costs-less.test.mjs: the live check replays its recorded answers
// (round-trip-costs-less.answers.json). good: this card's build, any browser of the account finishing its Ws, the sale
// at the priority main's build pays: PASS. bad: main b9361e809's build, before this card: FAIL, every mark named.
// beforeReview: this card's 20ba2481b build, before the review of it was folded: FAIL on the rules that review moved (the
// proven buy kept, and the rent backs' reads). beforePrice: its 591044f67 build, the sale's closes out: FAIL on the sell
// rule's priority cap, the spacing, the listing and the found W's pass. beforeP3: its fe31cf1ca build, before the
// second review's items: FAIL on the sell rule's fee bound (a partial sale's) and the spacing. Planted on the good one:
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

test("recorded answer beforePrice (591044f67's build, the closes out): FAIL on the cap, the spacing and the listing, and the found W's pass (none in that build)", () => {
  const v = judge(ANSWERS.beforePrice);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[4], ALL[7], ALL[8], ALL[9]]);
});

test("recorded answer beforeP3 (fe31cf1ca's build, a partial sale's fee unbounded, leftover sweeps back to back): FAIL on those, the listing, and the found W's pass (none in that build)", () => {
  const v = judge(ANSWERS.beforeP3);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [ALL[4], ALL[7], ALL[8], ALL[9]]);
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
    ["t?.buy!==void 0&&(Ze.buy=t.buy),", "", 0],
    // the finding read, the settled skip, the empty list, the setup only with a W
    ["let p=await iJ(o[1],f)", "let p=await iJ(o[0],f)", 1],
    ["r.seen===void 0:r.seen!==i.seen)&&m.push(t)", "!0:!0)&&m.push(t)", 1],
    ["i.any?m.push(t):await Promise.resolve(e.owed.markEmpty?.(t)).catch(()=>{})", "m.push(t)", 1],
    ["if(m.length===0)return l!==null||p===null;", "", 1],
    [",nJ=100,", ",nJ=1000,", 1],
    ["c=await e.wallets(lJ)}", "c=await e.wallets()}", 1],
    // the order and the gap
    ["[m[e],m[t]]=[m[t],m[e]]", "[m[e],m[t]]=[m[e],m[t]]", 2],
    ["{n>0&&await s(rJ+fJ(rJ)", "{n>0&&await s(0+fJ(rJ)", 2],
    [",rJ=1e3;", ",rJ=0;", 2],
    ["globalThis.crypto.getRandomValues(n),n[0]<t", "n[0]=Math.random()*t,n[0]<t", 2],
    // the proof
    ["(s=await aJ(t.rpcs[0],", "(s=await aJ(t.rpcs[1],", 3],
    ["if(r===null)return i===`none`?null:void 0;", "if(r===null)return null;", 3],
    ["&&i.mint===r.mint&&i.program===r.program)", ")", 3],
    // an unproven W
    ["n.passes+1>=3?`steady`:`again`", "n.passes+1>=1?`steady`:`again`", 4],
    ["||c===`again`", "", 4],
    ["t.unproven!==`again`);", "!0);", 4],
    // the positions' hold
    ["C=e.preempt?.();try{for(", "C=void 0;try{for(", 5],
    ["}finally{C?.()}return S}", "}finally{}return S}", 5],
    ["let r=n===lJ?null:Ye.preempt(),", "let r=Ye.preempt(),", 5],
    // the no-buy mark
    ["kQ=`owed/buy-sol-none`", "kQ=`owed/buy-sol`", 6],
    ["buyNone:async t=>Object.hasOwn(tt(await(await e.store()).get(`meta`,kQ)),t)", "buyNone:async t=>!1", 6],
    // the sell rule: the priority cap, rounded up, a limit's absence 1,400,000; the fee a sale names, full or partial
    ["if(Uk(d.ixs,f)>100000n)return X(`priority`);", "", 7],
    [">100000n)return X(`priority`)", ">1000000n)return X(`priority`)", 7],
    ["(n*r+999999n)/1000000n}", "(n*r)/1000000n}", 7],
    ["let n=BigInt(_k),r=0n;", "let n=0n,r=0n;", 7],
    ["i.data[0]===2?n=", "i.data[0]===3?n=", 7],
    ["||v.fee>105000n))", "))", 7],
    ["v.fee>105000n))", "v.fee>1005000n))", 7],
    ["if(v!==void 0&&(typeof v.fee", "if(v!==void 0&&v.full===!0&&(typeof v.fee", 7],
    // the spacing: the device's stamp before each send, the gap's draw and rule, the claim, the load's hold, a hold no fault
    // (8); what W shows while it waits (9); a found W's pass (4)
    ["`ct-device`", "`ct-wallet`", 8],
    ["=36e5,", "=6e6,", 8],
    ["&&e.at+e.gap<=t+36e5", "", 8],
    ["e!==void 0&&e.at!==n&&", "e!==void 0&&", 8],
    ["spacing:()=>t.spacing()", "spacing:async()=>void 0", 8],
    ["(e,t=kK())=>", "(e,t)=>", 8],
    ["!g||DK(", "DK(", 8],
    ["Lq>l&&(", "Lq>l&&(!1,", 8],
    ["quiet:_(l),leftover:!0,", "quiet:_(l),", 8],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))throw TJ;", "", 8],
    ["if(!await e.owed.claim(n,t.own).catch(()=>!1))", "if(!await e.owed.claim(n,t.own).catch(()=>!0))", 8],
    ["if(t===wJ||t===TJ)throw t;", "if(t===wJ)throw t;", 8],
    ["m=i.spaced??u;", "m=u;", 8],
    ["await _({at:f(),gap:dJ()}),await Promise.allSettled", "await Promise.allSettled", 8],
    ["if(t.buy&&f===p&&t.read?.(f),", "if(", 9],
    ["if(t.quiet===!0)throw TJ;let h=", "let h=", 9],
    ["if(t.buy&&t.read?.(h),", "if(", 9],
    ["W holds nothing`};if(t.quiet===!0)throw TJ;", "W holds nothing`};", 9],
    ["t.swept?.(E.one.signature),", "", 9],
    ["p=n===`sent`?i.sweep:", "p=n===`sent`?void 0:", 9],
    ["f=n===`floor`?void 0:i.lamports===void 0?c:", "f=n===`sent`?void 0:i.lamports===void 0?c:", 9],
    ["f=n===`floor`?void 0:i.lamports===void 0?c:", "f=i.lamports===void 0?c:", 9],
    ["if(n===null)continue;", "", 9],
    ["e.state!==`PLANNED`&&e.state!==`INCOMING`", "e.state===`SPENT`", 9],
    ["h=m.some(e=>e.sweep!==void 0)?await c().catch(()=>null):[]", "h=[]", 9],
    ["n.found===!0?{bare:!0}:c?{unproven:c}:{}", "c?{unproven:c}:{}", 4],
    ["p.steady&&l.bare!==!0?i:void 0", "p.steady?i:void 0", 4],
  ];
  for (const [from, to, i] of planted) {
    assert.equal(JS.split(from).length, 2, `once: ${from}`);
    const js = JS.replace(from, to);
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], `${from} -> ${to}`);
  }
});
