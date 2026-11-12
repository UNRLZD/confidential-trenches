// node --test scripts/live-checks/fresh-money-spendable-at-once.test.mjs: the live check replays its recorded answers
// (fresh-money-spendable-at-once.answers.json, its _note says where each was read). good: this card's signing page
// build: PASS. bad: SIGN_HOST as served before the card: FAIL, every mark named. planted: the good answer with one thing
// changed each: FAIL on it. And the marks on code shapes: the old queue rule (a deposit's own note only) and the old
// withdraw (the newest read for a deposit's note alone) are not taken for the new ones.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKS, facts, judge } from "./fresh-money-spendable-at-once.mjs";

const A = JSON.parse(readFileSync(new URL("./fresh-money-spendable-at-once.answers.json", import.meta.url), "utf8"));
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const no = (k) => `BAD the served bundle does not carry: ${k}`;
const KEYS = Object.keys(MARKS);

test("recorded good answer: this card's build carries every mark: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(v.lines.filter((l) => l.startsWith("ok ")).length, KEYS.length);
});

test("recorded bad answer: SIGN_HOST before the card carries none of the marks: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(bads(v), KEYS.map(no));
});

test("planted on good: another /app.js, no pin, each mark missing: FAIL on it", () => {
  const g = A.good;
  assert.deepEqual(bads(judge({ ...g, sha384: "sha384-x" })), ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(bads(judge({ ...g, index: "<html></html>" })), ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of KEYS) assert.deepEqual(bads(judge({ ...g, carries: { ...g.carries, [k]: false } })), [no(k)], k);
});

test("the marks read the new shapes, never the old ones", () => {
  const html = '<script type="module" src="/app.js" integrity="X"></script>';
  const has = (js) => facts(html, js).carries;
  // the queue: the newest root for any fresh note once that cut holds its leaf; the old rule (a deposit's own only) is not it
  const queueNew = "E instanceof Error?l.failed.push({noteId:e.id,error:Uk(E)}):e.leaf.leafIndex<BigInt(E.stateTree.size)&&D.push({n:e,trees:E,root:`newest`})";
  const queueOld = "e.ref.kind===`deposit`||e.ref.kind===`second`&&e.ref.id.id===`U`)&&(T??=await r.trees(d+1n,t,{newest:!0}),T instanceof Error?l.failed.push({noteId:e.id,error:Uk(T)}):D.push({n:e,trees:T,root:`newest`}))";
  assert.equal(has(queueNew)[KEYS[0]], true);
  assert.equal(has(queueOld)[KEYS[0]], false);
  // the withdraw: the loop that proves on the newest root; the old one-shot newest read for a deposit's note is not it
  assert.equal(has("C),T=`epoch`;for(let e=!1;!S(w);){let t=await x(y+1n,{newest:!0});if(S(t)){w=t,T=`newest`,e&&(_=await g());break}")[KEYS[1]], true);
  assert.equal(has("dex>=BigInt(T.stateTree.size)&&(T=await l.trees(g+1n,void 0,{newest:!0}));")[KEYS[1]], false);
  // the buy: epoch-root proofs first; the smallest chunk alone is not it
  assert.equal(has("ee=f(await e.ready()).sort((e,t)=>e.root===t.root?e.chunk<t.chunk?-1:+(e.chunk>t.chunk):e.root===`epoch`?-1:1).filter(")[KEYS[2]], true);
  assert.equal(has("ee=f(await e.ready()).sort((e,t)=>e.chunk<t.chunk?-1:+(e.chunk>t.chunk)).filter(")[KEYS[2]], false);
  // the root index: bounded by the agreed size; the page's own length alone is not it
  assert.equal(has("let a=Math.min((t.data.length-pH)/mH,n-r*hH);for(let e=a-1;e>=0;e--){")[KEYS[3]], true);
  assert.equal(has("let a=(t.data.length-pH)/mH;for(let e=a-1;e>=0;e--){")[KEYS[3]], false);
});
