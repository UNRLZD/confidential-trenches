// node --test scripts/live-checks/move-one-confidential-swap.test.mjs: the live check replays its recorded answers
// (move-one-confidential-swap.answers.json). good: this card's SIGN_HOST build (build-app.mjs --out at the card's head)
// with the network reads of 2026-11-14 04:1xZ (12 dry "advanced" quotes through the helper, 1Click's keyless status of
// the two recorded addresses): PASS. liveBefore: SIGN_HOST as served then (release 133) with the same reads: FAIL, the
// Move's three marks named. Planted on the good answer: another /app.js, each mark gone, a pair throttled or answered
// public, 1Click answering the confidential address or hiding the public one: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONF_COLLECTOR, HIDDEN, PAIRS, facts, judge, pairOf } from "./move-one-confidential-swap.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./move-one-confidential-swap.answers.json", import.meta.url), "utf8"));
const clone = (v) => structuredClone(v);

test("recorded good answer: this card's build carries the Move's marks, every pair quotes confidential, 1Click's tell holds: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  assert.equal(ANSWERS.good.pairs.length, 12);
});

test("recorded bad answer liveBefore (release 133 as served): FAIL, the three marks named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD SIGN_HOST's /app.js lacks the Move's collector, mode, tell: a Move is not asked or checked as one confidential swap"]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  const fails = (change, re) => {
    const a = clone(g);
    change(a);
    const v = judge(a);
    assert.equal(v.ok, false);
    assert.ok(v.lines.some((l) => re.test(l)), v.lines.join("\n"));
  };
  fails((a) => { a.sha384 = "sha384-x"; }, /not the one index.html pins/);
  fails((a) => { a.index = ""; }, /pins no \/app\.js/);
  for (const m of ["collector", "mode", "tell"]) fails((a) => { a.marks = a.marks.filter((x) => x !== m); }, new RegExp(`lacks the Move's ${m}`));
  fails((a) => { a.pairs = a.pairs.filter((p) => p.pair !== "solana>base"); }, /no dry quote read for solana>base/);
  fails((a) => { a.pairs[0].status = 429; }, /answered HTTP 429/);
  fails((a) => { a.pairs[1].mode = "public"; }, /not a confidential quote/);
  fails((a) => { a.pairs[2].collector = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd"; }, /not a confidential quote/);
  fails((a) => { a.pairs[3].out = null; }, /not a confidential quote/);
  fails((a) => { a.tell.hidden = { status: 200, message: null, state: "PENDING_DEPOSIT" }; }, /no longer answers not found/);
  fails((a) => { a.tell.hidden.message = "Deposit address X not found"; }, /no longer answers not found/);
  fails((a) => { a.tell.public = { status: 404, message: "Deposit address x not found", state: null }; }, /cannot see a public swap/);
});

test("facts() and pairOf() read the marks and the answers as minified and as 1Click answers", () => {
  const js = `x=\`${CONF_COLLECTOR}\`;y={confidentiality:\`advanced\`};z=\`https://1click.chaindefuser.com/v0/status\``;
  assert.deepEqual(facts("", js).marks, ["collector", "mode", "tell"]);
  assert.deepEqual(facts("", js.replace("advanced", "public")).marks, ["collector", "tell"]);
  assert.deepEqual(pairOf("a>b", 201, { quoteRequest: { confidentiality: "advanced", appFees: [{ recipient: CONF_COLLECTOR, fee: 20 }] }, quote: { amountOut: "5" } }), { pair: "a>b", status: 201, mode: "advanced", collector: CONF_COLLECTOR, out: "5" });
  assert.deepEqual(pairOf("a>b", 401, { message: "User authentication is required for confidential intent quotes" }), { pair: "a>b", status: 401, mode: null, collector: null, out: null });
  assert.equal(PAIRS.length, 12);
  assert.equal(HIDDEN.length, 44);
});
