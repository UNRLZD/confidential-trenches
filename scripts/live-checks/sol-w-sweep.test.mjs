// node --test scripts/live-checks/sol-w-sweep.test.mjs: the live check replays its recorded answers
// (sol-w-sweep.answers.json). good: this card's SIGN_HOST build, a full sell depositing W's surplus and a sweep that
// leaves W only an owed claim's cost: PASS. bad: 11c963f9's build (the sell left W's surplus on W, the sweep stopped at
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
  "function RR(e){let t=e.fee+e.made+e.rents+e.after-e.lamports,n=t>0n||!e.keeps?t:0n;}",
  "function zR(e,t=!1){let n=(VE(e)>1000000n?VE(e):PE)+(py+iy(e,17)+2n*72n*e.lamportsPerByte*e.factor)+py-iy(e,165)+UE(e,+!!t),r=iy(e,0);return n>r?n:r}",
  "let I=y.amount>u,ne=I?_y(k,_):zR(_,k.cashback),re=1;",
  "if(`refused`in o&&!I&&(o=a(iy(_,0))),`refused`in o)return $(o.refused);",
  "if(typeof s!=`bigint`||s>rE||s>=_||s<0n&&(typeof c!=`bigint`||-s>c))return X(`reserve`);",
  "var UE=(e,t)=>t===0?0n:iy(e,0)+BigInt(t)*(sd+iy(e,165));",
  "return typeof r!=`bigint`||!Number.isSafeInteger(o)||o<0||o>2?X(`sweep_reads`):l+5000n+HE(i,n,a)+UE(i,o)===r?l:X(`sweep_amount`)}",
  "function qR(e){return e.length>2||e.some(e=>e.cashback!==!0)?null:e.length}",
  "if(T<x)return{end:i>0?`owed`:`floor`,detail:``};",
  "r.keep.push({address:e,why:o.join(`, `),...i.other.length===0&&i.amount>0n?{cashback:!0}:{}})",
].join("");
test("the facts read from a bundle; a planted line with its rule changed FAILs", () => {
  assert.deepEqual(Object.values(facts("", JS).carries), Object.keys(MARKS).map(() => true));
  const planted = [
    [JS.replace("n=t>0n||!e.keeps?t:0n", "n=t>0n?t:0n"), 0],
    [JS.replace("+py-iy(e,165)", "+py+py-iy(e,165)"), 1],
    [JS.replace("+UE(e,+!!t)", ""), 1],
    [JS.replace("zR(_,k.cashback)", "zR(_)"), 2],
    [JS.replace("if(`refused`in o&&!I&&(o=a(iy(_,0))),", "if("), 3],
    [JS.replace("-s>c", "-s>c+1n"), 4],
    [JS.replace("iy(e,0)+BigInt(t)*", "BigInt(t)*"), 5],
    [JS.replace("+UE(i,o)===r", "===r"), 6],
    [JS.replace("||o>2?", "?"), 6],
    [JS.replace("e.some(e=>e.cashback!==!0)", "!1"), 7],
    [JS.replace("{end:i>0?`owed`:`floor`,", "{end:`floor`,"), 8],
    [JS.replace("i.other.length===0&&", ""), 9],
  ];
  for (const [js, i] of planted) {
    const c = facts("", js).carries;
    assert.deepEqual(Object.entries(c).filter(([, v]) => !v).map(([k]) => k), [Object.keys(MARKS)[i]], js.slice(0, 80));
  }
});
