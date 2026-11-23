// node --test scripts/live-checks/held-move-bind-waits-for-its-receipt.test.mjs: the live check replays recorded answers
// (held-move-bind-waits-for-its-receipt.answers.json). bad: SIGN_HOST before this card deployed: both rules missing,
// FAIL. good: this card's build, as SIGN_HOST serves it once deployed: PASS. Planted on the good answer: a served /app.js
// that is not the pinned one, each rule gone, no pin: FAIL. Planted on the build's own minified lines (25d1afe38, as
// build-app.mjs writes them): each rule changed FAILs its own mark alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MARKERS, answerOf, judge } from "./held-move-bind-waits-for-its-receipt.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./held-move-bind-waits-for-its-receipt.answers.json", import.meta.url), "utf8"));

test("recorded bad answer: the page before this card, both rules missing: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, MARKERS.map((m) => `BAD the served /app.js lacks the receipt wait's rule ${m}`));
});

test("recorded good answer: the pinned /app.js waits out a used call's debit: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.app.markers, MARKERS);
});

test("planted: a served /app.js that is not the pinned one, each rule gone, or no pin: FAIL", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, app: { ...g.app, sha384: "sha384-other" } }).lines.includes("BAD the served /app.js is not the one index.html pins"));
  for (const m of MARKERS) assert.deepEqual(judge({ ...g, app: { ...g.app, markers: MARKERS.filter((k) => k !== m) } }).lines, [`BAD the served /app.js lacks the receipt wait's rule ${m}`], m);
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD index.html pins no /app.js"));
});

// The build's lines for each rule, as the minifier writes them at 25d1afe38 (O bindOut, D its first-used heights, OM
// LAPSE_MARGIN; ue moveOutLive, le its first-used heights, Kue MOVE_VALIDITY_BLOCKS; 3n REFUND_HEIGHTS inlined)
const JS = [
  ",D=new Map,O=async()=>{let e=n.notes===void 0?[]:(await n.notes.list()).flatMap(e=>(e.calls??[]).filter(e=>e.sender_id===h));if(e.length===0)return!1;let t=await VM(h,o);if(t===null)return null;let r=t.heights[0]<t.heights[1]?t.heights[0]:t.heights[1];return e.some(e=>{let n=e.max_block_height+OM;return e.nonce>t.nonce?r<=n:(D.has(e.nonce)||D.set(e.nonce,r),r<=n+3n&&r<D.get(e.nonce)+3n)})},",
  ",le=new Map,ue=async()=>{let e=(await w()).flatMap(([,e])=>e.follow.out!==void 0&&e.follow.why!==`moved_out`?[e.follow.out]:[]);if(e.length===0)return!1;let t=await VM(c,s);if(t===null)return!0;let n=t.heights[0]<t.heights[1]?t.heights[0]:t.heights[1];return e.some(e=>{let r=BigInt(e.height)+Kue;return t.nonce<BigInt(e.nonce)?n<=r:(le.has(e.hash)||le.set(e.hash,n),n<=r+3n&&n<le.get(e.hash)+3n)})},",
].join("\n");

test("the build's lines carry every rule; each rule changed FAILs its own mark alone", () => {
  assert.deepEqual(answerOf("", JS).app.markers, MARKERS);
  const planted = [
    // tap_receipt: the rule before this card (a used call read as its debit done), the height bound dropped, the
    // window bound dropped, the first-used height read again each time (the wait never ends), no wait at all past use,
    // a failed read of U taken as no call out
    ["tap_receipt", JS.replace("return e.some(e=>{let n=e.max_block_height+OM;return e.nonce>t.nonce?r<=n:(D.has(e.nonce)||D.set(e.nonce,r),r<=n+3n&&r<D.get(e.nonce)+3n)})", "return e.some(e=>e.nonce>t.nonce&&r<=e.max_block_height+OM)")],
    ["tap_receipt", JS.replace("r<=n+3n&&r<D.get(e.nonce)+3n", "r<=n+3n")],
    ["tap_receipt", JS.replace("r<=n+3n&&r<D.get(e.nonce)+3n", "r<D.get(e.nonce)+3n")],
    ["tap_receipt", JS.replace("D.has(e.nonce)||D.set(e.nonce,r)", "D.set(e.nonce,r)")],
    ["tap_receipt", JS.replace("r<D.get(e.nonce)+3n", "r<D.get(e.nonce)+0n")],
    ["tap_receipt", JS.replace("if(t===null)return null;let r=", "if(t===null)return!1;let r=")],
    // round_receipt: the same plants on the round's move
    ["round_receipt", JS.replace("return e.some(e=>{let r=BigInt(e.height)+Kue;return t.nonce<BigInt(e.nonce)?n<=r:(le.has(e.hash)||le.set(e.hash,n),n<=r+3n&&n<le.get(e.hash)+3n)})", "return e.some(e=>t.nonce<BigInt(e.nonce)&&n<=BigInt(e.height)+Kue)")],
    ["round_receipt", JS.replace("n<=r+3n&&n<le.get(e.hash)+3n", "n<=r+3n")],
    ["round_receipt", JS.replace("n<=r+3n&&n<le.get(e.hash)+3n", "n<le.get(e.hash)+3n")],
    ["round_receipt", JS.replace("le.has(e.hash)||le.set(e.hash,n)", "le.set(e.hash,n)")],
    ["round_receipt", JS.replace("n<le.get(e.hash)+3n", "n<le.get(e.hash)+0n")],
    ["round_receipt", JS.replace("if(t===null)return!0;let n=", "if(t===null)return!1;let n=")],
  ];
  for (const [m, js] of planted) {
    assert.notEqual(js, JS, `${m}: the plant changed the lines`);
    assert.deepEqual(answerOf("", js).app.markers, MARKERS.filter((k) => k !== m), m);
  }
});
