// node --test scripts/live-checks/leftovers-carry-to-cash.test.mjs: the live check replays its recorded answers
// (leftovers-carry-to-cash.answers.json). good: this card's SIGN_HOST build: PASS. liveBefore: SIGN_HOST as served
// before this card: FAIL, every mark named. Planted on the good one: another script, no pin, each mark taken away: each
// FAIL; and each mark's minified line as this card's build spells it, changed so its rule no longer holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, SAYS } from "./leftovers-carry-to-cash.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./leftovers-carry-to-cash.answers.json", import.meta.url), "utf8"));
const ALL = Object.values(SAYS).map((s) => `BAD ${s}`);

test("recorded good answer: this card's SIGN_HOST build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded answer liveBefore (SIGN_HOST before this card): FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const [i, k] of Object.keys(SAYS).entries()) assert.deepEqual(judge({ ...g, [k]: false }).lines, [ALL[i]], k);
  assert.equal(judge(null).ok, false);
});

// The minified lines as this card's build spells them (packages/signpage/scripts/build-app.mjs, mainnet), each changed
// so its rule no longer holds.
const JS = [
  "let l=await a.sendable(i,e.signal).catch(()=>null);if(l===null)return{src:i,end:`unread`};let u=l>0n?e.worth(i.chain,l):0n;if(u===null||u<1000000n)return{src:i,end:`under`}",
  "if(`error`in f||!e.onChain(i.chain,f.address))return{src:i,end:`refused`};let p={to:f.address,amount:l.toString(),quote:d,quotedMs:String(e.now()),sends:[]};try{await e.keep(i,p)}catch{return{src:i,end:`fault`}}return s(await a.send(i,p,o,e.signal));",
  "n.filter(e=>(e.stage===`in_pool`&&e.final===!0||e.stage===`short`)&&e.follow.left!==void 0&&/^[0-9]{1,78}$/.test(e.follow.left)&&BigInt(e.follow.left)!==0n&&!0);",
  "l===`not_funded`&&!a&&(await i(`short`),await t.holds?.(n)),await m(u);",
  "o&&g>c&&!u&&(await i(`short`),await t.holds?.(g),s=!0);",
  "if(eP(r.data,4)!==t.amount)return $(`amount`);if(t.amount!==t.lamports-5000n)return $(`carry_whole`);",
  "i=r?await r.request(`ct-carry-cash`,{ifAvailable:!0},async e=>e?await f():null):null;",
  "dY=e=>`owed/carry-cash-${e.chain}-${e.address}`;",
].join("");
const INDEX = (js) => `<script type="module" src="/app.js" integrity="${facts("", js).sha384}"></script>`;

test("the minified lines this card's build spells: PASS; each one changed so its rule no longer holds: FAIL, that mark named", () => {
  assert.deepEqual(judge(facts(INDEX(JS), JS)).lines, []);
  const cuts = [
    // no floor, another floor, or an unpriced leftover asked anyway
    ["floor", JS.replace("u<1000000n", "u<1n")],
    ["floor", JS.replace("u===null||", "")],
    ["floor", JS.replace("return{src:i,end:`under`}", "return{src:i,end:`dead`}")],
    // Cash's address not checked on the chain, the record written after the send, or a failed write that still sends
    ["record", JS.replace("||!e.onChain(i.chain,f.address)", "")],
    ["record", JS.replace("try{await e.keep(i,p)}catch{return{src:i,end:`fault`}}", "try{await e.keep(i,p)}catch{}")],
    ["record", JS.replace("sends:[]", "sends:x")],
    // only a pool op, a short op not taken, an op still on its way taken, or a 0 left taken
    ["sources", JS.replace("||e.stage===`short`", "")],
    ["sources", JS.replace("&&e.final===!0", "")],
    ["sources", JS.replace("&&BigInt(e.follow.left)!==0n", "")],
    // one short show writes nothing
    ["short", JS.replace("await i(`short`),await t.holds?.(g),s=!0", "await i(`short`),s=!0")],
    ["short", JS.replace("await i(`short`),await t.holds?.(n)", "await i(`short`)")],
    // another amount, or a part of the wallet left behind
    ["rule", JS.replace("if(t.amount!==t.lamports-5000n)return $(`carry_whole`);", "")],
    ["rule", JS.replace("t.lamports-5000n", "t.lamports-10000n")],
    ["rule", JS.replace("eP(r.data,4)!==t.amount", "eP(r.data,4)>t.amount")],
    // every tab at once, a lock that waits, or the record under another key
    ["loop", JS.replace("`ct-carry-cash`", "`ct-carry`")],
    ["loop", JS.replace("{ifAvailable:!0}", "{}")],
    ["loop", JS.replace("`owed/carry-cash-${e.chain}-${e.address}`", "`carry-${e.chain}-${e.address}`")],
  ];
  for (const [mark, js] of cuts) {
    assert.notEqual(js, JS, `${mark}: the cut changed nothing`);
    assert.deepEqual(judge(facts(INDEX(js), js)).lines, [`BAD ${SAYS[mark]}`], `${mark}: ${js.slice(0, 80)}`);
  }
});
