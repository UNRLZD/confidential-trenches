// node --test scripts/live-checks/deposit-quote-no-liquidity.test.mjs: the live check replays its recorded answers
// (deposit-quote-no-liquidity.answers.json, its _note says where each was read).
//   good: this card's signing page, every quote answered with 1Click's no-liquidity 400: one ask, not_available: PASS.
//   deployed: the deployed SIGN_HOST, the same run: PASS.
//   bad: this card's first head, whose display read asked again (three asks, the quote lines): FAIL.
// Planted on good: a second ask, an ask that reached the helper, another code, an answer with lines, another request,
// no ready, no answer, an answer past the one ask's window: FAIL each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, NO_LIQUIDITY_BODY, WINDOW_MS, judge } from "./deposit-quote-no-liquidity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "deposit-quote-no-liquidity.answers.json"), "utf8"));
const plant = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};
const answerOf = (a) => a.log.find((m) => m.data?.id === a.id).data;

test("recorded good and deployed answers: one ask on 1Click's no-liquidity answer, then not_available: PASS", () => {
  for (const k of ["good", "deployed"]) {
    const v = judge(A[k]);
    assert.equal(v.verdict, "PASS", `${k}: ${v.lines.join("\n")}`);
    assert.equal(EXIT[v.verdict], 0);
    assert.equal(A[k].quotes.length, 1);
    assert.deepEqual(answerOf(A[k]).error, { code: "not_available" });
  }
});

test("recorded bad answer: this card's first head asked the display read three times: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  assert.equal(EXIT[v.verdict], 1);
  assert.ok(v.lines.includes("BAD the page asked the display quote 3 times on 1Click's no-liquidity answer, want once"), v.lines.join("\n"));
});

test("the planted body is 1Click's no-liquidity answer, and the window the one ask's 10 s", () => {
  assert.equal(JSON.parse(NO_LIQUIDITY_BODY).message, "No liquidity available");
  assert.equal(WINDOW_MS, 10_000);
});

test("planted on good: a re-ask, a request to the helper, another code, lines, another request, no ready, no answer, late: FAIL each", () => {
  const cases = {
    "a second ask": (a) => a.quotes.push({ ...a.quotes[0], t: a.quotes[0].t + 600 }),
    "an ask that reached the helper": (a) => delete a.quotes[0].planted,
    "down": (a) => (answerOf(a).error = { code: "down" }),
    "busy": (a) => (answerOf(a).error = { code: "busy" }),
    "a refusal carrying more than its code": (a) => (answerOf(a).result = {}),
    "the quote lines": (a) => Object.assign(answerOf(a), { ok: true, result: { amount_out_usd: "24.99" } }),
    "a live request": (a) => (a.quotes[0].body = { ...a.quotes[0].body, dry: false }),
    "another recipient": (a) => (a.quotes[0].body = { ...a.quotes[0].body, recipient: "ab".repeat(32) }),
    "another amount": (a) => (a.quotes[0].body = { ...a.quotes[0].body, amount: "1000000" }),
    "no quote request": (a) => (a.quotes = []),
    "no ready": (a) => (a.ready = false),
    "no answer": (a) => (a.log = a.log.filter((m) => m.data?.id !== a.id)),
    "past the window": (a) => (a.answeredT = a.quotes[0].t + WINDOW_MS + 1),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(plant(f).verdict, "FAIL", name);
});
