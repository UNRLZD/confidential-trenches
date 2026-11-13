// node --test scripts/live-checks/deposit-quote-no-liquidity.test.mjs: the live check replays its recorded answers
// (deposit-quote-no-liquidity.answers.json, its _note says where each was read).
//   good: the signing page built from this tree (since a704c14fb every quote path asks a 1Click 400 that is not about
//     the request again, the display read too), every quote answered with 1Click's no-liquidity 400: the first ask and
//     its re-asks, the same request, inside the one ask's window, then not_available: PASS.
//   deployed: the deployed SIGN_HOST on release 128, the same run: PASS.
//   bad: the card's first head, whose third ask reached the helper and was answered with quote lines: FAIL.
// Planted on good: one ask more than the rule's, an ask after the window, a re-ask of another request, an ask that
// reached the helper, another code, an answer with lines, another request, no ready, no answer, an answer past the
// window: FAIL each. The rule's numbers are quote.ts's own literals (QUOTE_RULE), never a copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, NO_LIQUIDITY_BODY, QUOTE_RULE, QUOTE_SOURCE, WINDOW_MS, judge, parseQuoteRule } from "./deposit-quote-no-liquidity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "deposit-quote-no-liquidity.answers.json"), "utf8"));
const plant = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};
const answerOf = (a) => a.log.find((m) => m.data?.id === a.id).data;

test("recorded good and deployed answers: the first ask and its re-asks on 1Click's no-liquidity answer, then not_available: PASS", () => {
  for (const k of ["good", "deployed"]) {
    const v = judge(A[k]);
    assert.equal(v.verdict, "PASS", `${k}: ${v.lines.join("\n")}`);
    assert.equal(EXIT[v.verdict], 0);
    // since a704c14fb the page asks again: each recorded run asked more than once, never past the rule
    assert.ok(A[k].quotes.length > 1 && A[k].quotes.length <= QUOTE_RULE.maxAsks, `${k}: ${A[k].quotes.length} asks`);
    assert.deepEqual(answerOf(A[k]).error, { code: "not_available" });
  }
});

test("recorded bad answer: the card's first head let its third ask reach the helper and answered quote lines: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  assert.equal(EXIT[v.verdict], 1);
  assert.ok(v.lines.includes("BAD a quote request reached the helper: this run answers every one"), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith("BAD deposit.dry answered {")), v.lines.join("\n"));
});

test("the planted body is 1Click's no-liquidity answer, and the rule is quote.ts's own literals", () => {
  assert.equal(JSON.parse(NO_LIQUIDITY_BODY).message, "No liquidity available");
  assert.deepEqual(QUOTE_RULE, parseQuoteRule(readFileSync(QUOTE_SOURCE, "utf8")));
  assert.equal(WINDOW_MS, QUOTE_RULE.windowMs);
  // planted source text: the numbers follow the literals, and a reshaped literal is an error, never a stale pass
  const src = (w, p) => `export const DEPOSIT_QUOTE_TIMEOUT_MS = ${w};\nexport const NO_LIQUIDITY_PAUSES_MS: readonly number[] = Object.freeze([${p}]);\n`;
  assert.deepEqual(parseQuoteRule(src("7_000", "250, 500, 1_000")), { windowMs: 7000, maxAsks: 4 });
  assert.throws(() => parseQuoteRule(src("7_000", "").replace("Object.freeze([])", "PAUSES")), /NO_LIQUIDITY_PAUSES_MS not found/);
  assert.throws(() => parseQuoteRule(src("WINDOW", "500")), /DEPOSIT_QUOTE_TIMEOUT_MS not found/);
  assert.throws(() => parseQuoteRule(src("10_000", "")), /not positive numbers/);
});

test("planted on good: one ask more, a late ask, a changed re-ask, a request to the helper, another code, lines, another request, no ready, no answer, late: FAIL each", () => {
  const n = A.good.quotes.length;
  const cases = {
    "one ask more than the rule's": [(a) => {
      while (a.quotes.length <= QUOTE_RULE.maxAsks) a.quotes.push({ ...a.quotes.at(-1), t: a.quotes.at(-1).t + 100 });
    }, `BAD the page asked the display quote ${QUOTE_RULE.maxAsks + 1} times on 1Click's no-liquidity answer, want ${QUOTE_RULE.maxAsks} at most (the first and its re-asks)`],
    "an ask after the window": [(a) => (a.quotes[n - 1].t = a.quotes[0].t + WINDOW_MS + 1), "BAD 1 ask(s) sent outside the one ask's"],
    "an ask with no time": [(a) => delete a.quotes[n - 1].t, "BAD 1 ask(s) sent outside the one ask's"],
    "a re-ask of another amount": [(a) => (a.quotes[1].body = { ...a.quotes[1].body, amount: "26000000" }), "BAD ask 2 is not the first ask's request"],
    "a re-ask naming another recipient": [(a) => (a.quotes[1].body = { ...a.quotes[1].body, recipient: "ab".repeat(32) }), "BAD ask 2 is not the first ask's request"],
    "an ask that reached the helper": [(a) => delete a.quotes[n - 1].planted, "BAD a quote request reached the helper"],
    "down": [(a) => (answerOf(a).error = { code: "down" }), "BAD deposit.dry answered"],
    "busy": [(a) => (answerOf(a).error = { code: "busy" }), "BAD deposit.dry answered"],
    "a refusal carrying more than its code": [(a) => (answerOf(a).result = {}), "BAD deposit.dry answered"],
    "the quote lines": [(a) => Object.assign(answerOf(a), { ok: true, result: { amount_out_usd: "24.99" } }), "BAD deposit.dry answered"],
    "a live request": [(a) => (a.quotes[0].body = { ...a.quotes[0].body, dry: false }), "BAD the quote request is not the dry 25 USDC"],
    "another recipient": [(a) => (a.quotes[0].body = { ...a.quotes[0].body, recipient: "ab".repeat(32) }), "BAD the quote request names someone other"],
    "another amount": [(a) => (a.quotes[0].body = { ...a.quotes[0].body, amount: "1000000" }), "BAD the quote request is not the dry 25 USDC"],
    "no quote request": [(a) => (a.quotes = []), "BAD the page sent no quote request"],
    "no ready": [(a) => (a.ready = false), "BAD the shell's ready did not arrive"],
    "no answer": [(a) => (a.log = a.log.filter((m) => m.data?.id !== a.id)), "BAD the page sent no answer"],
    "past the window": [(a) => (a.answeredT = a.quotes[0].t + WINDOW_MS + 1), "BAD the answer came"],
  };
  for (const [name, [f, line]] of Object.entries(cases)) {
    const v = plant(f);
    assert.equal(v.verdict, "FAIL", name);
    assert.ok(v.lines.some((l) => l.startsWith(line)), `${name}: ${v.lines.join("\n")}`);
  }
});
