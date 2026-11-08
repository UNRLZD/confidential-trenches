// node --test scripts/live-checks/sol-w-sweep.test.mjs: the live check replays its recorded answers
// (sol-w-sweep.answers.json). good: this card's build, a full sell depositing W's surplus, keeping what the sweep needs
// at a page boundary and each owed claim's cost (rent(0) when its note would land under the floor), checked exactly by
// the sell's rule, and a sweep that leaves W only an owed claim's cost: PASS. bad: 11c963f9's build (the sell left W's surplus on W, the sweep stopped at
// any kept account): FAIL, every mark named. Planted on the good one: another /app.js, no pin, each mark taken away:
// each FAIL; and planted bundles with a mark's line changed: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./sol-w-sweep.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-w-sweep.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer (11c963f9's build): FAIL, every mark named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

// The minified lines as the good build spells them, each changed so its rule no longer holds.
const JS = [
  "function BR(e){if(!e.keeps&&e.base!==void 0){let t=BR({...e,base:void 0});return`refused`in t||t.value<(e.floor??0n)?BR({...e,after:e.base,swept:0n,base:void 0}):t}let t=e.fee+e.made+e.rents+e.after-e.lamports,n=t>0n||!e.keeps?t:0n;return e.keeps&&n>iE?{refused:`not_funded`}:n-(e.swept??0n)>iE||n>=e.minOut||e.minOut-n<1000000n?{refused:`quote_check_failed`}:{reserve:n,value:e.minOut-n}}",
  "function GE(e,t=0){let n=HE(e)>1000000n?HE(e):FE,r=ay(e,88),i=n+(sd+ay(e,IE)+2n*r)+sd-ay(e,165)+WE(e,t),a=ay(e,0);return i>a?i:a}",
  "ie=k.kind===`pumpswap`?gf:Qu,[ae,oe]=await Promise.all([UR(g,p,v,F,c),Promise.all([Qu,gf].map(async e=>k.cashback&&e===ie?!0:(await wR(g,t=>TR(t,Sf(f.address,e),`confirmed`))).some(t=>!(`none`in t)&&t.owner===e&&Mf(e,t.data)>0n))).then(e=>e.filter(Boolean).length)]),se=I?vy(k,_):GE(_,oe),ce=HE(_)>1000000n?HE(_):FE,",
  "let a=ay(_,0),o=BR({fee:r,made:M,rents:UE(_,v,ae,e),after:se,lamports:b,minOut:ee,keeps:I,...I?{}:{swept:se-a,base:a,floor:ce}});",
  "if(typeof s!=`bigint`||s>=_)return X(`reserve`);let y=0n,b=c;if(b!==void 0&&b.full===!0){if(typeof b.lamports!=`bigint`||typeof b.fee!=`bigint`||typeof b.made!=`bigint`||b.fee<0n||b.made<0n||typeof b.next!=`boolean`||typeof b.rent?.lamportsPerByte!=`bigint`||typeof b.rent.factor!=`bigint`||b.rent.lamportsPerByte<0n||b.rent.factor<0n||b.rent.lamportsPerByte*b.rent.factor>6960n||!Number.isSafeInteger(b.owed)||b.owed<0||b.owed>2)return X(`reserve`);let e=b.fee+b.made+UE(b.rent,o,b.held,b.next)-b.lamports,t=GE(b.rent,b.owed),n=ay(b.rent,0),r=HE(b.rent)>1000000n?HE(b.rent):FE,i=e+t,a=i-(t-n)<=iE&&i<_&&_-i>=r;if(s!==(a?i:e+n))return X(`reserve`);a&&(y=t-n)}else if(s<0n)return X(`reserve`);if(s-y>iE)return X(`reserve`);",
  "var UE=(e,t)=>t===0?0n:iy(e,0)+BigInt(t)*(sd+iy(e,165));",
  "return typeof r!=`bigint`||!Number.isSafeInteger(o)||o<0||o>2?X(`sweep_reads`):l+5000n+HE(i,n,a)+UE(i,o)===r?l:X(`sweep_amount`)}",
  "function qR(e){return e.length>2||e.some(e=>e.cashback!==!0)?null:e.length}",
  "if(T<x)return{end:i>0?`owed`:`floor`,detail:``};",
  "async function ZR(e,t,n,r){try{if(n===`holds`&&await r?.())return;if(n===`floor`)return await e.owed?.put({...t});if(n!==`sent`&&n!==`gave_up`&&n!==`owed`)return await e.owed?.drop(t.address);",
  "r.keep.push({address:e,why:o.join(`, `),...i.other.length===0&&i.amount>0n?{cashback:!0}:{}})",
].join("");
test("the facts read from a bundle; a planted line with its rule changed FAILs", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    [JS.replace("n=t>0n||!e.keeps?t:0n", "n=t>0n?t:0n"), 0],
    [JS.replace("+2n*r)", "+r)"), 1],
    [JS.replace("+WE(e,t)", ""), 1],
    [JS.replace("k.cashback&&e===ie?!0:", ""), 2],
    [JS.replace(".some(t=>!(`none`in t)", ".every(t=>!(`none`in t)"), 2],
    [JS.replace("||t.value<(e.floor??0n)", ""), 3],
    [JS.replace(",floor:ce}", "}"), 4],
    [JS.replace("floor:ce}", "floor:FE}"), 4],
    [JS.replace("ce=HE(_)>1000000n?HE(_):FE,", "ce=FE,"), 4],
    [JS.replace("n-(e.swept??0n)>iE", "n>iE"), 5],
    [JS.replace("b.full===!0", "b.full!==!1"), 6],
    [JS.replace("||b.rent.lamportsPerByte*b.rent.factor>6960n", ""), 6],
    [JS.replace("&&_-i>=r;", ";"), 6],
    [JS.replace("s!==(a?i:e+n)", "s!==i&&s!==e+n"), 6],
    [JS.replace("if(s-y>iE)", "if(s>iE)"), 6],
    [JS.replace("iy(e,0)+BigInt(t)*", "BigInt(t)*"), 7],
    [JS.replace("+UE(i,o)===r", "===r"), 8],
    [JS.replace("||o>2?", "?"), 8],
    [JS.replace("e.some(e=>e.cashback!==!0)", "!1"), 9],
    [JS.replace("{end:i>0?`owed`:`floor`,", "{end:`floor`,"), 10],
    [JS.replace("if(n===`floor`)return await e.owed?.put({...t});", ""), 11],
    [JS.replace("i.other.length===0&&", ""), 12],
  ];
  for (const [js, i] of planted) {
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], js.slice(0, 80));
  }
});
