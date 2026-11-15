// node --test scripts/live-checks/solana-buy-preview-complete.test.mjs: the live check replays its recorded answers
// (solana-buy-preview-complete.answers.json). good: the SIGN_HOST build of card solana-buy-reaches-raydium-and-meteora (out
// from the best-venue pick on every venue the buy takes): PASS. liveBefore: SIGN_HOST as served
// at release 129, before this card: FAIL, every mark named. Planted on the good one: another script, no pin, each mark
// taken away: each FAIL; and each mark's minified line as this card's build spells it, changed so its rule no longer
// holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, SAYS } from "./solana-buy-preview-complete.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./solana-buy-preview-complete.answers.json", import.meta.url), "utf8"));
const ALL = Object.values(SAYS).map((s) => `BAD ${s}`);

test("recorded good answer: this card's SIGN_HOST build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded answer liveBefore (release 129's SIGN_HOST): FAIL, every mark named", () => {
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
  "if(e.trading())return{error:`busy`};let s=t.token,c=a!==null&&a>0n?dV(o,{side:`buy`,token:s,amount:a}).catch(()=>null):null,l=await e.ready();",
  'var xp=1024,Sp={"pump-curve":3e5,pumpswap:4e5,dlmm:45e4,"raydium-cpmm":3e5,"raydium-amm-v4":3e5};Uo(Sp);',
  "}var xh=Object.freeze(Object.keys(Sp));",
  "var _z=e=>e?.pools.filter(e=>xh.includes(e.venue)).sort((e,t)=>e.expectedOut>t.expectedOut?-1:1)[0],vz=Object.freeze({});",
  "let y=_z(await c),b=y!==void 0&&u.decimals!==void 0&&y.expectedOut>0n?WV(y.expectedOut,u.decimals):void 0;return{result:{tap_max:f,pieces:v.length,cost:A2(v.reduce((e,t)=>e+t.binding.feeCap,n(v.length))),...b===void 0?{}:{out:b}}}};",
  "if(i.data.length<82)throw Error(`the mint is shorter than a mint`);let s=i.data[44],c=Tf(t);return{kind:e,mint:t,decimals:s,tokenProgram:i.owner};return{kind:e,mint:t,decimals:s,tokenProgram:i.owner}",
  "return i(13,0)?`current`:i(1,13)?`1.13`:i(1,12)?`1.12`:`1.4`}",
  "o_=(e,t)=>{if(typeof t!=`object`||!t||e!==`pool.buy.dry`)return t;let{out:n,...r}=t;return r};function f_(e,t,n){if(e===`current`)return n;let r=o_(t,n);if(e===`1.13`)return r;let i=c_(t,r)}",
  "x=`1.14`",
].join("");
const INDEX = (js) => `<script type="module" src="/app.js" integrity="${facts("", js).sha384}"></script>`;

test("the minified lines this card's build spells: PASS; each one changed so its rule no longer holds: FAIL, that mark named", () => {
  assert.deepEqual(judge(facts(INDEX(JS), JS)).lines, []);
  const cuts = [
    // the quote read after the proofs (it would add its wait to theirs)
    ["quote", JS.replace(",l=await e.ready();", ";await 0;let l=await e.ready();")],
    // a failed quote read rejects the whole answer (the Fee would go with it)
    ["quote", JS.replace(".catch(()=>null)", "")],
    // the quote of another amount than the asked one
    ["quote", JS.replace("amount:a}).catch", "amount:1n}).catch")],
    // out from the first venue, not the best of those the buy chooses from
    ["out", JS.replace(".sort((e,t)=>e.expectedOut>t.expectedOut?-1:1)", "")],
    // out picked on another list than the buy's venues: one venue alone, or a table without pump's curve
    ["out", JS.replace("xh=Object.freeze(Object.keys(Sp))", "xh=Object.freeze([`dlmm`])")],
    ["out", JS.replace('{"pump-curve":3e5,', "{")],
    // out from another pick than the best venue's
    ["out", JS.replace("let y=_z(await c)", "let y=vz(await c)")],
    // out with no decimals read: a raw count
    ["out", JS.replace("WV(y.expectedOut,u.decimals)", "String(y.expectedOut)")],
    // out read off another quote than the one started for this amount
    ["out", JS.replace("_z(await c)", "_z(await z)")],
    // no out in the answer
    ["out", JS.replace(",...b===void 0?{}:{out:b}", "")],
    // the decimals read with no length check, or from another byte
    ["decimals", JS.replace("if(i.data.length<82)throw Error(`the mint is shorter than a mint`);", "")],
    ["decimals", JS.replace("i.data[44]", "i.data[45]")],
    // the decimals read and never put on the venues
    ["decimals", JS.replaceAll("decimals:s,", "")],
    // kit-v1.13 read in full (its schema refuses out) or out never stripped at its level
    ["level", JS.replace("i(1,13)?`1.13`:", "")],
    ["level", JS.replace("if(e===`1.13`)return r;", "")],
    ["level", JS.replace("let{out:n,...r}=t;return r", "return t")],
    ["version", JS.replace("x=`1.14`", "x=`1.13`")],
  ];
  for (const [mark, js] of cuts) {
    assert.notEqual(js, JS, `${mark}: the cut changed nothing`);
    // out is read off the quote the mark found: no quote, no out
    const want = mark === "quote" ? [mark, "out"] : [mark];
    assert.deepEqual(judge(facts(INDEX(js), js)).lines, want.map((m) => `BAD ${SAYS[m]}`), `${mark}: ${js.slice(0, 80)}`);
  }
});
