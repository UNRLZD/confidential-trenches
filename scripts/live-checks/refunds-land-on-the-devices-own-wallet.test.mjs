// node --test scripts/live-checks/refunds-land-on-the-devices-own-wallet.test.mjs: the live check replays its recorded
// answers (refunds-land-on-the-devices-own-wallet.answers.json). good: this card's SIGN_HOST build (build-app.mjs --out
// at the card's head) with the network reads of 2026-11-14 07:12Z (9 dry "advanced" quotes through the helper, each
// refunding ORIGIN_CHAIN on its origin chain): PASS. liveBefore: SIGN_HOST as served at 07:11Z (release 134) with the same
// kind of reads: FAIL, the two marks named. Planted on the good answer: another /app.js, each mark gone, a leg throttled,
// echoing INTENTS or another refund address: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LEGS, facts, judge, legOf, refundOf } from "./refunds-land-on-the-devices-own-wallet.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./refunds-land-on-the-devices-own-wallet.answers.json", import.meta.url), "utf8"));
const clone = (v) => structuredClone(v);

test("recorded good answer: this card's build carries the origin refund, every leg's dry quote refunds on its own chain: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.deepEqual(v.lines, []);
  assert.equal(v.ok, true);
  assert.equal(ANSWERS.good.legs.length, 9);
});

test("recorded bad answer liveBefore (SIGN_HOST as served before the card): FAIL, both marks named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["BAD SIGN_HOST's /app.js lacks the origin refund's rule, record: a failed swap's refund still rests in intents.near"]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const fails = (change, re) => {
    const a = clone(ANSWERS.good);
    change(a);
    const v = judge(a);
    assert.equal(v.ok, false);
    assert.ok(v.lines.some((l) => re.test(l)), v.lines.join("\n"));
  };
  fails((a) => { a.sha384 = "sha384-x"; }, /not the one index.html pins/);
  fails((a) => { a.index = ""; }, /pins no \/app\.js/);
  for (const m of ["rule", "record"]) fails((a) => { a.marks = a.marks.filter((x) => x !== m); }, new RegExp(`lacks the origin refund's ${m}`));
  fails((a) => { a.legs = a.legs.filter((l) => l.leg !== "base>cash"); }, /no dry quote read for base>cash/);
  fails((a) => { a.legs[0].status = 429; }, /answered HTTP 429/);
  fails((a) => { a.legs[1].refundType = "INTENTS"; }, /does not refund on the origin chain/);
  fails((a) => { a.legs[2].refundTo = "ab".repeat(32); }, /does not refund on the origin chain/);
  fails((a) => { a.legs[3].out = null; }, /does not refund on the origin chain/);
});

test("facts() and legOf() read the marks and the answers as minified and as 1Click answers", () => {
  const js = "e=`origin refund: not the origin coin's own chain`;k=`owed/refund-${c}-${a}`";
  assert.deepEqual(facts("", js).marks, ["rule", "record"]);
  assert.deepEqual(facts("", js.replace("owed/refund-", "owed/x-")).marks, ["rule"]);
  assert.deepEqual(legOf("solana>cash", 201, { quoteRequest: { refundType: "ORIGIN_CHAIN", refundTo: refundOf("solana>cash") }, quote: { amountOut: "5" } }),
    { leg: "solana>cash", status: 201, refundType: "ORIGIN_CHAIN", refundTo: "2KesqqvtnrxmqFzTKDWNt2WyP4bA2pJqJbrJDZppE6aT", out: "5" });
  assert.deepEqual(legOf("a>b", 400, { message: "x" }), { leg: "a>b", status: 400, refundType: null, refundTo: null, out: null });
  assert.equal(LEGS.length, 9);
  assert.ok(!LEGS.some((l) => l.startsWith("cash>")), "Cash's NEAR USDC keeps INTENTS: no Cash-origin leg is held to ORIGIN_CHAIN");
});
