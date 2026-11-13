// node --test scripts/live-checks/pool-withdraws-to-any-chain.test.mjs: the live check replays its recorded answers
// (pool-withdraws-to-any-chain.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as served before
// the card: FAIL. Planted on the good one: another /app.js, no pin, each mark taken away: each FAIL. Planted in a
// bundle: the picker gone, the refund on another chain, a recipient not the typed one, a run that never asks: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./pool-withdraws-to-any-chain.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./pool-withdraws-to-any-chain.answers.json", import.meta.url), "utf8"));
const NO_PICKER = "BAD the pool withdraw form takes no chain: a pool pays only to its own chain";
const NO_REQUEST = "BAD no exit request of the device's own: the payout, the typed recipient and the refund on the pool's chain";
const runs = (n) => `BAD ${n} of the 2 withdraw runs pay a checked quote's deposit address`;

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before the card: FAIL, each path named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_PICKER, NO_REQUEST, runs(0)]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  assert.deepEqual(judge({ ...g, picker: false }).lines, [NO_PICKER]);
  assert.deepEqual(judge({ ...g, request: false }).lines, [NO_REQUEST]);
  assert.deepEqual(judge({ ...g, runs: 1 }).lines, [runs(1)]);
});

test("planted in a bundle: each mark broken in place FAILs", () => {
  const js = [
    "g=document.createElement(`select`);g.dataset.input=`dest`,Object.assign(g.style,{})",
    "o={dry:!1,amount:e.payout.toString(),refundTo:e.refundTo,refundType:`ORIGIN_CHAIN`,recipient:e.recipient,recipientType:`DESTINATION_CHAIN`,deadline:d}",
    "return t});e.exit&&(n=await e.exit(E[0].w)),b0(n,e.pin,f,E.map(e=>e.w))&&r0(`to`)",
    "S=await x(b);e.exit&&(n=await e.exit(S[0])),L8(n,e.pin,S)&&x8(`to`)",
  ].join(";");
  const at = (s) => facts("", s);
  assert.deepEqual([at(js).picker, at(js).request, at(js).runs], [true, true, 2]);
  assert.equal(at(js.replace("input=`dest`", "input=`to`")).picker, false, "no picker");
  assert.equal(at(js.replace("refundType:`ORIGIN_CHAIN`", "refundType:`INTENTS`")).request, false, "the refund off the pool's chain");
  assert.equal(at(js.replace("recipient:e.recipient", "recipient:h")).request, false, "a recipient not the typed one");
  assert.equal(at(js.replace("amount:e.payout.toString()", "amount:q")).request, false, "an amount not the payout");
  assert.equal(at(js.replace("e.exit&&(n=await e.exit(E[0].w)),", "")).runs, 1, "the Solana run never asks");
  assert.equal(at(js.replace("e.exit&&(n=await e.exit(S[0])),", "")).runs, 1, "the EVM run never asks");
  assert.equal(at(js.replace("e.exit(S[0])", "e.exit(S[1])")).runs, 1, "a refund to another W than the first");
});
