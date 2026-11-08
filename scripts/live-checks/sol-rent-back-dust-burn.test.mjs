// node --test scripts/live-checks/sol-rent-back-dust-burn.test.mjs: the live check replays its recorded answers
// (sol-rent-back-dust-burn.answers.json). good: this card's SIGN_HOST build, a stranger's balance on W's token account
// after its full sell burned, closed and swept: PASS. bad: card/sol-w-sweep ca2d252a's build, before this card: FAIL.
// liveBefore: SIGN_HOST before this card's deploy: FAIL. beforeFix: b9fc0c5b's build, before the review of bf467ae7's
// fold: FAIL on the stranger's-balance rule alone. Planted on the good one: another /app.js, no pin, each mark
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

// The review of bf467ae7's fold: the build before it (b9fc0c5b's committed bundle) held a balance its full sell left as
// W's own and read the sell at confirmed after W's accounts: FAIL on that rule's mark alone
test("recorded answer beforeFix: FAIL on the stranger's-balance rule alone", () => {
  const v = judge(ANSWERS.beforeFix);
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

// The minified lines as the good build spells them (each mark's text and the code it is tied to).
const JS = [
  "Se.sell={...t?.sell,[l]:{tx:F.encode(ve),last:M.lastHeight}},await e.owed?.put(Se).catch(()=>{})}await e.signed?.(",
  "r=async e=>{let n=t.sell?.[e];if(n===void 0)return`no`;let r=F.decode(n.tx);if(r.length<65||r[0]!==1)throw Error(`the owed record's sell is not one signed transaction`);let i=await YH(s,e=>NR(e,I.encode(r.subarray(1,65)),r,`finalized`));if(i.every(e=>e.got===`failed`))return`no`;if(i.every(e=>e.got===`none`))return await kR(s,n.last)?`no`:`unsure`;if(!i.every(e=>e.got===`ok`))throw Error(`the sell reads ${i.map(e=>e.got).join(`/`)}`);let[a,o]=i.map(t=>yU(t.meta,c.address,e));if(a===null||o===null||a!==o)throw Error(`the sell's meta does not say plainly what W's account held after it`);return`yes`},a=async e=>{let i=new Map;for(let e of t.mints)t.sell?.[e.mint]!==void 0&&i.set(e.mint,await r(e.mint).catch(e=>({fault:e})));let a=await YH(s,e=>ZH(e,[c.address,...n]))",
  "async function NR(e,t,n,r=`confirmed`){let i=await e(`getTransaction`,[t,{encoding:`base64`,commitment:r,",
  "function yU(e,t,n){let r=e?.postTokenBalances;if(!Array.isArray(r))return null;let i=null;for(let e of r){let r=e;if(typeof r!=`object`||!r)return null;if(r.mint!==n||r.owner!==t)continue;let a=r.uiTokenAmount?.amount;if(typeof a!=`string`||!/^(0|[1-9][0-9]{0,77})$/.test(a))return null;i=(i??0n)+BigInt(a)}return i}",
  "return n>0n?[{ata:t,mint:e.mint}]:[]}),u=`yes`;for(let e of l){let t=i.get(e.mint)??`no`;if(typeof t==`object`)throw t.fault;t===`no`?u=`no`:t===`unsure`&&u===`yes`&&(u=`unsure`)}if(u!==`yes`)return{k:`holds`,steady:u===`no`};let d=l.map(e=>e.ata);try{return{k:`plan`,held:a,accounts:o,burn:d,plan:fC(c.address,o,e,d)}}",
  "async e=>{let t=[];for(let r of e)t.push(await YH(s,e=>aw(e,r.wire,c.address,n)));return t},e.burn);",
  "let x=b.find(e=>e!==aC),S=!g&&m>0n&&r.includes(t)&&x===void 0&&![...c.values()].some(e=>e.to===t);h===1?!g&&m>0n&&!S?o.keep.push(",
  ",aC=7,",
  ",lamports:n.lamports,...S?{burn:m}:{}})",
  "(i=fC(t,n.accounts,n.unclaimed,n.burn)",
  "&&b.length===9&&b[0]===8&&y.length===3){let n=a.get(y[0]?.key),i=x[e+1],o=i?.program===r.program&&i.data.length===1&&i.data[0]===9&&i.accounts[0]?.key===n?.address;if(!n||n.kind!==`token`||n.burn===void 0||n.program!==r.program||eS(b,1)!==n.burn||y[1]?.key!==n.mint||y[2]?.key!==t||!y[2]?.signer||!y[0]?.writable||!y[1]?.writable||!o){",
  "e.kind===`token`&&(f.get(e.address)??0)!==(e.burn===void 0?0:1)&&y.push(",
].join(";");

test("the facts read from a bundle; a planted line with its rule changed FAILs on that rule's mark alone", () => {
  const index = `<script type="module" src="/app.js" integrity="${facts("", JS).sha384}"></script>`;
  assert.deepEqual(judge(facts(index, JS)).lines, []);
  const plants = [
    [
      "the sell not recorded",
      "Se.sell={...t?.sell,[l]:{tx:F.encode(ve),last:M.lastHeight}},",
      "",
      0
    ],
    [
      "a balance a full sell left held as W's own",
      "the sell's meta does not say plainly what W's account held after it`);return`yes`}",
      "the sell's meta does not say plainly what W's account held after it`);if(a!==0n)return`no`;return`yes`}",
      1
    ],
    [
      "the RPCs' metas may differ",
      "if(a===null||o===null||a!==o)throw",
      "if(a===null||o===null)throw",
      1
    ],
    [
      "a sell not read yet taken as sold",
      "?`no`:`unsure`;",
      "?`no`:`yes`;",
      1
    ],
    [
      "a sell past its blockhash taken as sold",
      "?`no`:`unsure`;",
      "?`yes`:`unsure`;",
      1
    ],
    [
      "a failed sell taken as sold",
      "if(i.every(e=>e.got===`failed`))return`no`;",
      "",
      1
    ],
    [
      "no record taken as sold",
      "if(n===void 0)return`no`;",
      "if(n===void 0)return`yes`;",
      1
    ],
    [
      "a held mint with no sell read taken as sold",
      "i.get(e.mint)??`no`",
      "i.get(e.mint)??`yes`",
      1
    ],
    [
      "another mint's sell used",
      "let n=t.sell?.[e];",
      "let n=Object.values(t.sell??{})[0];",
      1
    ],
    [
      "the sell read at confirmed",
      ",r,`finalized`));",
      ",r));",
      1
    ],
    [
      "the sell read after W's accounts",
      "for(let e of t.mints)t.sell?.[e.mint]!==void 0&&i.set(e.mint,await r(e.mint).catch(e=>({fault:e})));let a=await YH(s,e=>ZH(e,[c.address,...n]))",
      "let a=await YH(s,e=>ZH(e,[c.address,...n]));for(let e of t.mints)t.sell?.[e.mint]!==void 0&&i.set(e.mint,await r(e.mint).catch(e=>({fault:e})))",
      1
    ],
    [
      "a sell read's fault for a mint W no longer holds",
      "await r(e.mint).catch(e=>({fault:e}))",
      "await r(e.mint)",
      1
    ],
    [
      "the sell's read not at the commitment asked",
      "commitment:r,",
      "commitment:`confirmed`,",
      1
    ],
    [
      "an unsure read stored as W's own state",
      "steady:u===`no`}",
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
      "the meta read without its mint",
      "if(r.mint!==n||r.owner!==t)continue;",
      "if(r.owner!==t)continue;",
      1
    ],
    [
      "a meta with no entry of W's read as 0",
      "BigInt(a)}return i}",
      "BigInt(a)}return i??0n}",
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
      "burn:d,plan:fC(c.address,o,e,d)",
      "burn:d,plan:fC(c.address,o,e)",
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
      ",aC=7,",
      ",aC=16,",
      2
    ],
    [
      "the burn's amount unchecked",
      "||eS(b,1)!==n.burn||",
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
      "a burn whose next close is another account's",
      "&&i.accounts[0]?.key===n?.address;",
      ";",
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
