// node --test scripts/live-checks/buy-spends-several-pieces-screens.test.mjs: the live check replays its recorded
// answers (buy-spends-several-pieces-screens.answers.json). good: this card's builds of APP_HOST and SIGN_HOST, read by
// the check's own read as the hosts serve them: PASS. liveBefore: both hosts as served at release 122, before this card:
// FAIL, every mark named. Planted on the good one: another script, no pin, each mark taken away: each FAIL; and each
// mark's minified line changed so its rule no longer holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_MARKS, facts, judge, SAYS, SIGN_MARKS } from "./buy-spends-several-pieces-screens.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./buy-spends-several-pieces-screens.answers.json", import.meta.url), "utf8"));
const ALL = Object.values(SAYS).map((s) => `BAD ${s}`);

test("recorded good answer: this card's builds: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded answer liveBefore (release 122's hosts): FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  for (const [host, name] of [["app", "APP_HOST"], ["sign", "SIGN_HOST"]]) {
    assert.deepEqual(judge({ ...g, [host]: { ...g[host], sha384: "sha384-other" } }).lines, [`BAD ${name}'s served script is not the one index.html pins`]);
    assert.deepEqual(judge({ ...g, [host]: { ...g[host], index: "<html></html>" } }).lines, [`BAD ${name}'s index.html pins no script`]);
  }
  for (const [i, k] of Object.keys(SAYS).entries()) {
    const [host, mark] = k.split(".");
    assert.deepEqual(judge({ ...g, [host]: { ...g[host], [mark]: false } }).lines, [ALL[i]], k);
  }
  assert.equal(judge(null).ok, false);
});

// The minified lines as this card's builds spell them, each changed so its rule no longer holds.
const SIGN_JS = [
  "return{result:{tap_max:u,pieces:p.length,cost:KB(p.reduce((e,t)=>e+t.binding.feeCap,o(p.length)))}}",
  ",...a===void 0?{}:{making:jB(t.making,t.d)}}",
  "if(ve.length>0){if(!e.piecesOwed)return Wz();await e.piecesOwed.put({address:he.address,l:re.wallet.l.toString(),j:re.wallet.j,primary:re.noteId,pieces:ve.map(e=>e.r.noteId)})}",
  "await Hz(`/v1/pool/solana/pieces`,{pool:e,txs:t.map(e=>Fz(e))})",
].join(";");
const APP_JS = [
  "e(`pool.buy.dry`,{chain:`solana`,token:r,amount:t}).outcome.then(e=>{if(!e)return;if(e.ok)return void(e.result.cost!==void 0&&s({key:a,cost:e.result.cost}))})",
  'R("div",{"data-testid":`trade-cost`,children:[R("span",{children:`Fee`}),R("span",{children:c===null?`—`:Z(c)})]})',
  "n.making!==void 0&&V(n.making)===!0?`making`:`ready`",
].join(";");
const carriesOf = (marks, js) => Object.entries(marks).filter(([, re]) => !re.test(js)).map(([k]) => k);

test("the marks read from this card's lines; a planted line with its rule changed FAILs", () => {
  assert.deepEqual(carriesOf(SIGN_MARKS, SIGN_JS), []);
  assert.deepEqual(carriesOf(APP_MARKS, APP_JS), []);
  const sign = [
    // the cost without the pieces' relay fees, or without the tip
    [SIGN_JS.replace("cost:KB(p.reduce(", "cost:KB(o(p.length),p.reduce("), "dry"],
    [SIGN_JS.replace("pieces:p.length,", ""), "dry"],
    // making from another sum, or always given
    [SIGN_JS.replace("making:jB(t.making,t.d)", "making:jB(t.ready,t.d)"), "making"],
    [SIGN_JS.replace(",...a===void 0?{}:{making:jB(t.making,t.d)}", ",making:jB(t.making,t.d)"), "making"],
    // the owed record not required before the send, or written without W's l and j
    [SIGN_JS.replace("if(!e.piecesOwed)return Wz();", ""), "owed"],
    [SIGN_JS.replace("l:re.wallet.l.toString(),", ""), "owed"],
    // the pieces sent one by one, not as one bundle on the pieces route
    [SIGN_JS.replace("`/v1/pool/solana/pieces`", "`/v1/pool/solana/send`"), "route"],
  ];
  for (const [js, k] of sign) {
    assert.notEqual(js, SIGN_JS, k);
    assert.deepEqual(carriesOf(SIGN_MARKS, js), [k], js.slice(0, 80));
  }
  const app = [
    // the dry run asked with no amount, or its cost dropped
    [APP_JS.replace(",amount:t}", "}"), "ask"],
    [APP_JS.replace("&&s({key:a,cost:e.result.cost})", ""), "ask"],
    // no Fee row, or a row that shows a number before the page's cost
    [APP_JS.replace("`trade-cost`", "`trade-fee`"), "row"],
    [APP_JS.replace("c===null?`—`:Z(c)", "Z(c??0)"), "row"],
    // the proofs being made never read
    [APP_JS.replace("n.making!==void 0&&V(n.making)===!0?`making`", "!1?`making`"), "making"],
  ];
  for (const [js, k] of app) {
    assert.notEqual(js, APP_JS, k);
    assert.deepEqual(carriesOf(APP_MARKS, js), [k], js.slice(0, 80));
  }
});

test("facts() keeps each host's index, its script's sha384 and every mark", () => {
  const f = facts({ index: "i", js: APP_JS }, { index: "s", js: SIGN_JS });
  assert.deepEqual(Object.keys(f.app), ["index", "sha384", ...Object.keys(APP_MARKS)]);
  assert.deepEqual(Object.keys(f.sign), ["index", "sha384", ...Object.keys(SIGN_MARKS)]);
  assert.ok(Object.values(APP_MARKS).every((_, i) => Object.values(f.app)[2 + i] === true));
  assert.ok(Object.values(SIGN_MARKS).every((_, i) => Object.values(f.sign)[2 + i] === true));
});

// card you-receive-on-every-chain: the dry's cost read (src/pools.ts solanaBuyCost) and its answer; the trade box asks on
// the NEAR path too
const SIGN_READ = [
  "function O2(e,t,n,r,i,a){let o=Uz(e,t),s=e=>t=>Wz(t),c=XV(o,s(a));if(c!==null)return{cost:c.reduce((e,t)=>e+t.binding.feeCap,i(c.length)),pieces:c.length};return null}",
  "let e=O2(m,h,f,p,n,i);if(e===null)return{result:{tap_max:u}};let t=await g();return{result:{tap_max:u,...e.pieces===void 0?{}:{pieces:e.pieces},cost:D2(e.cost),...t===void 0?{}:{out:t}}}",
].join(";");
const SIGN_JS2 = SIGN_JS.replace("return{result:{tap_max:u,pieces:p.length,cost:KB(p.reduce((e,t)=>e+t.binding.feeCap,o(p.length)))}}", SIGN_READ);
const APP_JS2 = APP_JS.replace("{chain:`solana`,", "{chain:n===`near`?`near`:`solana`,");

test("the dry's cost read and the NEAR path's ask (card you-receive-on-every-chain): PASS; the cost without the relay fees or the tip, no pieces, another count, a cost not from the read, or the ask on another chain: FAIL, that mark named", () => {
  assert.notEqual(SIGN_JS2, SIGN_JS);
  assert.notEqual(APP_JS2, APP_JS);
  assert.deepEqual(carriesOf(SIGN_MARKS, SIGN_JS2), []);
  assert.deepEqual(carriesOf(APP_MARKS, APP_JS2), []);
  for (const js of [
    SIGN_JS2.replace("e+t.binding.feeCap,i(c.length)", "e,i(c.length)"),
    SIGN_JS2.replace("e+t.binding.feeCap,i(c.length)", "e+t.binding.feeCap,0n"),
    SIGN_JS2.replace("...e.pieces===void 0?{}:{pieces:e.pieces},", ""),
    SIGN_JS2.replace("pieces:c.length}", "pieces:1}"),
    SIGN_JS2.replace("cost:D2(e.cost)", "cost:D2(0n)"),
    SIGN_JS2.replace("let e=O2(m,h,f,p,n,i)", "let e=P2(m,h,f,p,n,i)"),
  ]) {
    assert.notEqual(js, SIGN_JS2);
    assert.deepEqual(carriesOf(SIGN_MARKS, js), ["dry"], js.slice(0, 80));
  }
  for (const js of [APP_JS2.replace("n===`near`?`near`:`solana`", "n===`near`?`near`:`base`"), APP_JS2.replace(",amount:t}", "}")]) {
    assert.notEqual(js, APP_JS2);
    assert.deepEqual(carriesOf(APP_MARKS, js), ["ask"], js.slice(0, 80));
  }
});

// card buy-box-quotes-before-funds: the box keeps the answer through the model's feeReadOf (an answer with out and no
// cost is kept too), as its build spells it; the inline lines above still read
const FEE_READ = "function Wh(e,t,n){return t.cost===void 0&&t.out===void 0?null:{key:e,...t.cost===void 0?{}:{cost:t.cost},...t.out===void 0?{}:{out:t.out},...n===null?{}:{amount:n}}}";
const APP_JS3 = APP_JS2.replace(
  "outcome.then(e=>{if(!e)return;if(e.ok)return void(e.result.cost!==void 0&&s({key:a,cost:e.result.cost}))})",
  "outcome.then(e=>{if(!i)return;if(e.ok){let t=Wh(ge,e.result,M);t!==null&&ve(t);return}let t=Jh(e.error.code)})",
) + ";" + FEE_READ;

test("the answer kept through feeReadOf (card buy-box-quotes-before-funds): PASS; no amount asked, the cost not kept, another function, or the result not handed to it: FAIL, ask named", () => {
  assert.notEqual(APP_JS3, APP_JS2 + ";" + FEE_READ);
  assert.deepEqual(carriesOf(APP_MARKS, APP_JS3), []);
  for (const js of [
    APP_JS3.replace(",amount:t}", "}"),
    APP_JS3.replace("...t.cost===void 0?{}:{cost:t.cost},", ""),
    APP_JS3.replace("let t=Wh(ge,e.result,M)", "let t=Xh(ge,e.result,M)"),
    APP_JS3.replace("let t=Wh(ge,e.result,M)", "let t=Wh(ge,null,M)"),
    APP_JS3.replace("t!==null&&ve(t);", ""),
    APP_JS3.replace(FEE_READ, ""),
  ]) {
    assert.notEqual(js, APP_JS3);
    assert.deepEqual(carriesOf(APP_MARKS, js), ["ask"], js.slice(0, 80));
  }
});
