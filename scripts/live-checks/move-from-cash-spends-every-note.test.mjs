// node --test scripts/live-checks/move-from-cash-spends-every-note.test.mjs: the live check's verdict replays recorded
// answers (move-from-cash-spends-every-note.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, the
//         move from Cash is planned over every note at a least part each quote takes, pool.move sends that plan's parts
//         through the buy's own sender, and pool.move.dry prices it: PASS;
//   bad:  SIGN_HOST as served on 15 Nov 2026 before the card (the move and its dry held to Cash's largest note): FAIL.
// Planted from the minified code the build writes: each mark broken alone FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge, SAYS } from "./move-from-cash-spends-every-note.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "move-from-cash-spends-every-note.answers.json"), "utf8"));
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: the branch's build: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before the card: FAIL on every mark", () => {
  const r = judge(ANSWERS.bad);
  for (const k of Object.keys(SAYS)) fails(r, new RegExp(`^BAD ${k}:`));
});

test("planted on the good answer: each mark alone, and the index's pin", () => {
  for (const k of Object.keys(SAYS)) fails(judge({ ...ANSWERS.good, [k]: false }), new RegExp(`^BAD ${k}:`));
  fails(judge({ ...ANSWERS.good, sha384: ANSWERS.bad.sha384 }), /not the one index\.html pins/);
  fails(judge({ ...ANSWERS.good, index: "<html></html>" }), /pins no \/app\.js/);
});

// the minified code as this card's build writes it (packages/signpage/scripts/build-app.mjs at the branch)
const PLAN =
  "function XK(e,t,n,r,i,a){if(t<0n||n<=0n)return null;let o=hq(e=>e>t&&e>=(a??0n)&&r(e)>=i);if(o===null)return null;let s=qG(e,t,o),c=e=>e.map(e=>({note:e.noteId,usdc:e.part,least:r(e.part),units:r(e.part)}));if(n>s)return{fee:t,max:s,part:o,parts:null};if(n<o)return{fee:t,max:s,part:o,parts:null,min:o};let l=BN(WG(t,o)),u=[...e].filter(e=>e.value-t>=n&&(e.value-t===n||e.value-t-n>=l)).sort((e,t)=>e.value===t.value?e.id<t.id?-1:1:e.value<t.value?-1:1)[0];if(u!==void 0)return{fee:t,max:s,part:o,parts:c([{noteId:u.id,part:n}])};let d=JG(e,n,t,o);return d===null?{fee:t,max:s,part:o,parts:null,...BW(e,n,WG(t,o))}:{fee:t,max:s,part:o,parts:c(d)}}";
const PLANNED =
  "m=async(t,n)=>{let r=e.price(t);if(r===null||n<=0n||e.handoff===null||e.rails.length===0)return{error:`not_allowed`};let[i,a,o,s]=await Promise.all([e.fee(),e.notes?e.notes():e.cash().then(e=>[{id:``,value:e}]),e.floor?e.floor(t).catch(()=>null):Promise.resolve(0n),e.least?e.least(t).catch(()=>null):Promise.resolve(null)]);return typeof o==`bigint`?XK(a,i,n,e=>HK(e,r,t),o,s)??{error:`not_allowed`}:{error:`down`}";
const MOVE = "move:(e,t,n)=>h(async()=>{let r=await m(e,t);if(`error`in r)return r;if(r.parts===null)return{error:t>r.max?`not_funded`:r.min===void 0?`not_allowed`:`below_min`};let i=await l(e,r.parts,n,r.fee)";
const BUY = "let h=await l(n,m,`cash/${n}/${e.now()}`,c)";
const DRY = "o=await e.plan(t,n.usdc);if(`error`in o)return o;if(o.parts===null)return a(r,o.max,o);let s=o.parts.reduce((e,t)=>e+t.least,0n),c=o.fee*BigInt(o.parts.length);return{result:{out:sq(s,PK[t]),fee:sq(c,cq),steps:r,max:i(o.max)}}";
const all = (o = {}) => facts("", [o.plan ?? PLAN, `function zz(){${o.buy ?? BUY};let ${o.planned ?? PLANNED}},${o.move ?? MOVE}}`, `async function yy(e,t,n){let r=1,${o.dry ?? DRY}}`].join(";"));

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is broken", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(SAYS).map((k) => [k, all()[k]])), { plan: true, move: true, dry: true });
  const broken = {
    plan: [
      // Max on the largest note, as before the card
      { plan: PLAN.replace("let s=qG(e,t,o)", "let s=qQ(e,t)") },
      // a part with no least: 1Click's least or the pool's floor dropped
      { plan: PLAN.replace("&&e>=(a??0n)", "") },
      { plan: PLAN.replace("&&r(e)>=i", "") },
      // the split by another planner, or at the fee's least part
      { plan: PLAN.replace("let d=JG(e,n,t,o)", "let d=JG(e,n,t)") },
      { plan: PLAN.replace("...BW(e,n,WG(t,o))", "") },
    ],
    move: [
      // the move held to one note, its quote and hand-off by the old single send
      { move: MOVE.replace("let i=await l(e,r.parts,n,r.fee)", "let i=await f(e,t,r.least,n,r.fee)") },
      // sent by another sender than the buy's
      { buy: BUY.replace("await l(", "await k(") },
      // the move not held to the plan
      { move: MOVE.replace("if(r.parts===null)return{error:t>r.max?`not_funded`:r.min===void 0?`not_allowed`:`below_min`};", "") },
      { move: MOVE.replace("await m(e,t)", "await g(e,t)") },
      // the plan read with no floor, or held to Cash's largest note
      { planned: PLANNED.replace("return typeof o==`bigint`?", "return 1?") },
      { planned: PLANNED.replace("XK(a,i,n,", "XK([{id:``,value:a}],i,n,") },
    ],
    dry: [
      // Fee one relay fee whatever the parts
      { dry: DRY.replace("c=o.fee*BigInt(o.parts.length)", "c=o.fee") },
      // out the whole amount's least, not the parts'
      { dry: DRY.replace("let s=o.parts.reduce((e,t)=>e+t.least,0n)", "let s=e.least(t,n.usdc)") },
      // the dry not from the mover's plan
      { dry: DRY.replace("await e.plan(t,n.usdc)", "await e.bounds(t)") },
      { dry: DRY.replace("return a(r,o.max,o)", "return a(r,o.max,{})") },
    ],
  };
  for (const [k, list] of Object.entries(broken)) {
    for (const o of list) {
      const f = all(o);
      assert.equal(f[k], false, `${k} misses: ${JSON.stringify(o)}`);
      fails(judge({ ...ANSWERS.good, ...f, index: ANSWERS.good.index, sha384: ANSWERS.good.sha384 }), new RegExp(`^BAD ${k}:`));
    }
  }
});
