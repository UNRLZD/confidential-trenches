// node --test scripts/live-checks/sol-rent-back-dust-burn.test.mjs: the live check replays its recorded answers
// (sol-rent-back-dust-burn.answers.json). good: this card's SIGN_HOST build, a stranger's balance on W's token account
// after its full sell burned, closed and swept: PASS. bad: card/sol-w-sweep ca2d252a's build, before this card: FAIL.
// liveBefore: SIGN_HOST before this card's deploy: FAIL. Planted on the good one: another /app.js, no pin, each mark
// taken away: each FAIL; and the good build's lines with one rule changed: each FAIL on that rule's mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./sol-rent-back-dust-burn.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./sol-rent-back-dust-burn.answers.json", import.meta.url), "utf8"));
const ALL = Object.keys(MARKS).map((k) => `BAD the served bundle has no ${k}`);

test("recorded good answer: this card's build burns a stranger's balance after a full sell: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, every mark named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, ALL);
  });
}

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(MARKS).entries()) assert.deepEqual(judge({ ...g, carries: { ...g.carries, [k]: false } }).lines, [ALL[i]]);
  assert.equal(judge(null).ok, false);
});

// The minified lines as the good build spells them (each mark's text and the code it is tied to).
const JS = [
  "be.sell={...t?.sell,[l]:{tx:L.encode(ge),last:N.lastHeight}},await e.owed?.put(be).catch(()=>{})}await e.signed?.(",
  "a=async e=>{let n=!1;for(let r of e){let e=t.sell?.[r];if(e===void 0)return`no`;let i=L.decode(e.tx);if(i.length<65||i[0]!==1)throw Error(`the owed record's sell is not one signed transaction`);let a=await ER(s,e=>HP(e,R.encode(i.subarray(1,65)),i));if(a.every(e=>e.got===`failed`))return`no`;if(a.every(e=>e.got===`none`)){if(await RP(s,e.last))return`no`;n=!0;continue}if(!a.every(e=>e.got===`ok`))throw Error(`the sell reads ${a.map(e=>e.got).join(`/`)}`);let[o,l]=a.map(e=>XR(e.meta,c.address,r));if(o===null||l===null||o!==l)throw Error(`the sell's meta does not say plainly what W's account held after it`);if(o!==0n)return`no`}return n?`unsure`:`yes`}",
  "async function HP(e,t,n){let r=await e(`getTransaction`,[t,",
  "function XR(e,t,n){let r=e?.postTokenBalances;if(!Array.isArray(r))return null;let i=null;for(let e of r){let r=e;if(typeof r!=`object`||!r)return null;if(r.mint!==n||r.owner!==t)continue;let a=r.uiTokenAmount?.amount;if(typeof a!=`string`||!/^(0|[1-9][0-9]{0,77})$/.test(a))return null;i=(i??0n)+BigInt(a)}return i}",
  "return n>0n?[{ata:t,mint:e.mint}]:[]}),l=o.length>0?await a(o.map(e=>e.mint)):`yes`;if(l!==`yes`)return{k:`holds`,steady:l===`no`};let u=o.map(e=>e.ata);try{return{k:`plan`,held:n,accounts:i,burn:u,plan:Pf(c.address,i,e,u)}}",
  "async e=>{let t=[];for(let n of e)t.push(await ER(s,e=>Pg(e,n.wire,c.address,r)));return t},e.burn);",
  "let x=b.find(e=>e!==Df),S=!g&&m>0n&&r.includes(t)&&x===void 0&&![...c.values()].some(e=>e.to===t);h===1?!g&&m>0n&&!S?o.keep.push(",
  ",Df=7,",
  ",lamports:n.lamports,...S?{burn:m}:{}})",
  "(i=Pf(t,n.accounts,n.unclaimed,n.burn)",
  "&&b.length===9&&b[0]===8&&y.length===3){let n=a.get(y[0]?.key),i=x[e+1],o=i?.program===r.program&&i.data.length===1&&i.data[0]===9&&i.accounts[0]?.key===n?.address;if(!n||n.kind!==`token`||n.burn===void 0||n.program!==r.program||xd(b,1)!==n.burn||y[1]?.key!==n.mint||y[2]?.key!==t||!y[2]?.signer||!y[0]?.writable||!y[1]?.writable||!o){",
  "e.kind===`token`&&(f.get(e.address)??0)!==(e.burn===void 0?0:1)&&y.push(",
].join(";");

test("the facts read from a bundle; a planted line with its rule changed FAILs on that rule's mark alone", () => {
  const index = `<script type="module" src="/app.js" integrity="${facts("", JS).sha384}"></script>`;
  assert.deepEqual(judge(facts(index, JS)).lines, []);
  const plants = [
  [
    "the sell not recorded",
    "be.sell={...t?.sell,[l]:{tx:L.encode(ge),last:N.lastHeight}},",
    "",
    0
  ],
  [
    "a balance the sell left taken as a stranger's",
    "if(o!==0n)return`no`}return n?",
    "}return n?",
    1
  ],
  [
    "the RPCs' metas may differ",
    "if(o===null||l===null||o!==l)throw",
    "if(o===null||l===null)throw",
    1
  ],
  [
    "a sell not read yet taken as sold",
    "n=!0;continue}",
    "continue}",
    1
  ],
  [
    "a sell past its blockhash taken as sold",
    "if(await RP(s,e.last))return`no`;",
    "",
    1
  ],
  [
    "a failed sell taken as sold",
    "if(a.every(e=>e.got===`failed`))return`no`;",
    "",
    1
  ],
  [
    "no record taken as sold",
    "if(e===void 0)return`no`;",
    "if(e===void 0)continue;",
    1
  ],
  [
    "an unsure read stored as W's own state",
    "steady:l===`no`}",
    "steady:!0}",
    1
  ],
  [
    "the meta read without its owner",
    "if(r.mint!==n||r.owner!==t)continue;",
    "if(r.mint!==n)continue;",
    1
  ],
  [
    "the check not handed the burn list",
    "return t},e.burn);",
    "return t});",
    1
  ],
  [
    "the plan not handed the burn list",
    "burn:u,plan:Pf(c.address,i,e,u)",
    "burn:u,plan:Pf(c.address,i,e)",
    1
  ],
  [
    "an extension burned",
    "&&x===void 0&&![...c.values()]",
    "&&![...c.values()]",
    2
  ],
  [
    "a claim's destination burned",
    "&&x===void 0&&![...c.values()].some(e=>e.to===t)",
    "&&x===void 0",
    2
  ],
  [
    "a native account burned",
    "S=!g&&m>0n&&r.includes(t)",
    "S=m>0n&&r.includes(t)",
    2
  ],
  [
    "ImmutableOwner not 7",
    ",Df=7,",
    ",Df=16,",
    2
  ],
  [
    "the burn's amount unchecked",
    "||xd(b,1)!==n.burn||",
    "||",
    3
  ],
  [
    "the burn's mint unchecked",
    "||y[1]?.key!==n.mint||",
    "||",
    3
  ],
  [
    "the burn's signer unchecked",
    "||y[2]?.key!==t||!y[2]?.signer||",
    "||",
    3
  ],
  [
    "a burn not right before its close",
    "||!y[1]?.writable||!o){",
    "||!y[1]?.writable){",
    3
  ],
  [
    "a planned burn counted at least once",
    "!==(e.burn===void 0?0:1)&&y.push",
    "<(e.burn===void 0?0:1)&&y.push",
    4
  ]
];
  for (const [what, from, to, mark] of plants) {
    assert.equal(JS.split(from).length, 2, what);
    const js = JS.replace(from, to);
    assert.deepEqual(judge({ ...facts(index, js), sha384: facts("", JS).sha384 }).lines, [ALL[mark]], what);
  }
});
