// node --test scripts/live-checks/withdraw-max-means-all.test.mjs: the live check replays its recorded answers
// (withdraw-max-means-all.answers.json). good: this card's SIGN_HOST build: PASS. liveBefore: SIGN_HOST as served before
// this card: FAIL, every mark named. Planted on the good one: another script, no pin, each mark taken away: each FAIL;
// and each mark's minified line as this card's build spells it, changed so its rule no longer holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, SAYS } from "./withdraw-max-means-all.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./withdraw-max-means-all.answers.json", import.meta.url), "utf8"));
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
  // the pool form: its check, its listeners, its press, its payable amount and the evaluate that uses it
  "await A,E&&T!==null&&vG(T)>0n&&(y.input.value=gG(vG(T),o));let r=bG(i,v.input.value,y.input.value,t.keys,T,n);",
  "y.input.addEventListener(`input`,()=>{E=!1,L()}),x.addEventListener(`click`,()=>{T===null||x.disabled||(E=!0,y.input.value=gG(vG(T),o),clearTimeout(M),I())});",
  "n?.ready&&n.ready.dest===e.dest&&n.ready.to===e.to&&(E?n.ready.maxFee<=e.maxFee:n.ready.amount===e.amount&&n.ready.maxFee===e.maxFee)&&await t.handoff(n.ready)};",
  "function yG(e,t,n){let r=_G(e,t,n);if(r.ok||r.code!==`insufficient`&&r.code!==`unplannable`)return r;if(r.below!==void 0){let t=_G(e,gG(r.below,dG[e].decimals),n);if(t.ok)return t}return r.code===`unplannable`&&r.above!==void 0?{ok:!1,code:`min`,min:r.above}:r.code===`insufficient`?{ok:!1,code:`insufficient`}:r}",
  "function bG(e,t,n,r,i,a=e){let o=SW(t)===``,s=n.trim()===``,c=o?null:a===e?CW(e,t,r):mG(a,t),l=s?null:yG(e,n,i),u=c?.ok&&l?.ok?Object.freeze({chain:e,to:c.to})};",
  // the Cash form: its check, its Amount line, its listeners and blur, its press, its payable amount and evaluate
  "let n=y.notes===null||y.fee===null?0n:GW(y.notes,y.fee);E&&n>0n&&(s.input.value=iG(n));let r=await rG(o.input.value,s.input.value,{network:t.network,rpcs:t.rpcs,...y,chain:m});return e===C?(O(r),r):null},",
  "v.replaceChildren(),v.hidden=n.ready===null,n.ready){let t=e.createElement(`dt`);t.textContent=$W.amount,nG(t,`amount`,eG);let r=e.createElement(`dd`);r.textContent=`${iG(n.ready.amount)} USDC`,r.dataset.line=`amount`,v.append(t,r)}",
  "s.input.addEventListener(`input`,()=>{E=!1,j()});let M=()=>{T.ready&&VW(s.input.value)!==T.ready.amount&&(s.input.value=iG(T.ready.amount))};s.input.addEventListener(`blur`,M),f.addEventListener(`click`,()=>{y.notes===null||y.fee===null||f.disabled||(E=!0,s.input.value=iG(GW(y.notes,y.fee)),clearTimeout(w),A())});",
  "if(!r?.ready||r.ready.recipient!==e.recipient||r.ready.chain!==e.chain||y.fee===null||(E?n===null||y.fee>n:r.ready.amount!==e.amount||a(r.ready)!==a(e)))return;M(),F(r.ready.parts);",
  "function JW(e,t){let n=qW(e,t);if(n.ok||n.code!==`insufficient`&&n.code!==`unplannable`)return n;if(n.below!==void 0){let e=qW(YW(n.below),t);if(e.ok)return e}return n.code===`unplannable`&&n.above!==void 0?{ok:!1,code:`min`,min:n.above}:n.code===`insufficient`?{ok:!1,code:`insufficient`}:n}",
  "c=a?null:JW(t,{notes:n.notes,fee:n.fee}),l=s?.ok&&c?.ok;",
].join("");
const INDEX = (js) => `<script type="module" src="/app.js" integrity="${facts("", js).sha384}"></script>`;

test("the minified lines this card's build spells: PASS; each one changed so its rule no longer holds: FAIL, that mark named", () => {
  assert.deepEqual(judge(facts(INDEX(JS), JS)).lines, []);
  const cuts = [
    // the pool form: the box keeps the old number after a read, a typed amount does not end Max, or the tap is a number
    ["poolMax", JS.replace("E&&T!==null&&vG(T)>0n&&(y.input.value=gG(vG(T),o));", "")],
    ["poolMax", JS.replace("()=>{E=!1,L()}", "L")],
    ["poolMax", JS.replace("(E=!0,y.input.value=", "(y.input.value=")],
    // the press: Max at any fee, or another amount than drawn
    ["poolPress", JS.replace("n.ready.maxFee<=e.maxFee", "!0")],
    ["poolPress", JS.replace("n.ready.amount===e.amount&&n.ready.maxFee===e.maxFee", "n.ready.maxFee===e.maxFee")],
    // Try again: the strict check on the screen, no amount below tried, or a Try for nothing below
    ["poolPayable", JS.replace("l=s?null:yG(e,n,i)", "l=s?null:_G(e,n,i)")],
    ["poolPayable", JS.replace("if(r.below!==void 0){let t=_G(e,gG(r.below,dG[e].decimals),n);if(t.ok)return t}", "")],
    ["poolPayable", JS.replace("{ok:!1,code:`min`,min:r.above}", "r")],
    // the Cash form: the box keeps the old number, a typed amount does not end Max, or the tap is a number
    ["cashMax", JS.replace("E&&n>0n&&(s.input.value=iG(n));", "")],
    ["cashMax", JS.replace("()=>{E=!1,j()}", "j")],
    ["cashMax", JS.replace("(E=!0,s.input.value=", "(s.input.value=")],
    // the press: Max at any fee bound, or another amount than drawn
    ["cashPress", JS.replace("n===null||y.fee>n", "!1")],
    ["cashPress", JS.replace(":r.ready.amount!==e.amount||a(r.ready)!==a(e)", ":a(r.ready)!==a(e)")],
    // the box rewritten by the check while typing, not on blur, or not at the press
    ["cashSettle", JS.replace("return e===C?(O(r),r):null", "return e===C?(r.ready&&(s.input.value=iG(r.ready.amount)),O(r),r):null")],
    ["cashSettle", JS.replace("s.input.addEventListener(`blur`,M),", "")],
    ["cashSettle", JS.replace("return;M(),F(r.ready.parts)", "return;F(r.ready.parts)")],
    // Try again: the strict check on the form, no amount below tried, or the amount sent not drawn
    ["cashPayable", JS.replace("c=a?null:JW(t,", "c=a?null:qW(t,")],
    ["cashPayable", JS.replace("if(n.below!==void 0){let e=qW(YW(n.below),t);if(e.ok)return e}", "")],
    ["cashPayable", JS.replace("r.textContent=`${iG(n.ready.amount)} USDC`,r.dataset.line=`amount`,", "r.dataset.line=`amount`,")],
  ];
  for (const [mark, js] of cuts) {
    assert.notEqual(js, JS, `${mark}: the cut changed nothing`);
    assert.deepEqual(judge(facts(INDEX(js), js)).lines, [`BAD ${SAYS[mark]}`], `${mark}: ${js.slice(0, 80)}`);
  }
});
