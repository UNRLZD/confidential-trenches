// node --test scripts/live-checks/deposit-quote-no-liquidity.test.mjs: the live check replays its recorded answers
// (deposit-quote-no-liquidity.answers.json, its _note says where each was read).
//   good: this card's signing page with the real helper: two planted no-liquidity answers, then the real quote: PASS.
//   bad: the deployed SIGN_HOST before this card: one ask, then not_available: FAIL.
// Planted on good: the real ask's own no-liquidity 400 or 1Click's own 503 is INCONCLUSIVE; a re-ask of another request,
// too soon, a fourth ask, lines from a 400, a 400 of another message, an answer past the page's deadline each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, NO_LIQUIDITY_BODY, PAUSES_MS, PLANTED, judge } from "./deposit-quote-no-liquidity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "deposit-quote-no-liquidity.answers.json"), "utf8"));
const plant = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};
const answerOf = (a) => a.log.find((m) => m.data?.id === a.id).data;

test("recorded good answer: this card's page asks again twice, then shows the real quote's lines: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 0);
  assert.equal(A.good.quotes.length, PLANTED + 1);
  assert.deepEqual(A.good.quotes.map((q) => q.status), [400, 400, 201]);
});

test("recorded bad answer: the deployed page before this card asks once, then not_available: FAIL", () => {
  const v = judge(A.bad);
  assert.equal(v.verdict, "FAIL");
  assert.equal(EXIT[v.verdict], 1);
  assert.deepEqual(v.lines, ['BAD deposit.dry answered {"code":"not_available"} after 1 quote request, want the quote lines after 3']);
});

test("the planted body is 1Click's no-liquidity answer, and the pauses the page's (500 then 1000 ms, wallet/src/deposit/quote.ts)", () => {
  assert.deepEqual([...PAUSES_MS], [500, 1_000]);
  assert.equal(JSON.parse(NO_LIQUIDITY_BODY).message, "No liquidity available");
});

const realAsk = (a, over) => Object.assign(a.quotes[PLANTED], over);
const refused = (a) => {
  const d = answerOf(a);
  delete d.result;
  Object.assign(d, { ok: false, error: { code: "not_available" } });
};

test("planted: the real ask's own no-liquidity answer, or 1Click's own 503, then not_available: INCONCLUSIVE, never FAIL", () => {
  const nl = plant((a) => (realAsk(a, { status: 400, message: "No liquidity available" }), refused(a)));
  assert.equal(nl.verdict, "INCONCLUSIVE", nl.lines.join("\n"));
  assert.equal(EXIT[nl.verdict], 3);
  assert.deepEqual(nl.lines, ["INCONCLUSIVE the real ask answered 400 No liquidity available: 1Click's own, not the page's"]);
  for (const cause of ["timeout", "5xx", "send"]) assert.equal(plant((a) => (realAsk(a, { status: 503, cause }), refused(a))).verdict, "INCONCLUSIVE", cause);
  // the helper's own refusals are the deploy's
  for (const cause of ["budget", "held", "key"]) assert.equal(plant((a) => (realAsk(a, { status: 503, cause }), refused(a))).verdict, "FAIL", cause);
  assert.equal(plant((a) => (realAsk(a, { status: 400, message: "Amount is too low" }), refused(a))).verdict, "FAIL");
  // an INCONCLUSIVE real ask never hides a BAD re-ask
  assert.equal(plant((a) => (realAsk(a, { status: 400, message: "No liquidity available" }), refused(a), (a.quotes[1].body = { ...a.quotes[1].body, amount: "1" }))).verdict, "FAIL");
});

test("planted: another request, a re-ask too soon, a fourth ask, lines from a 400, an answer past the deadline: FAIL each", () => {
  const other = plant((a) => (a.quotes[2].body = { ...a.quotes[2].body, recipient: "ab".repeat(32) }));
  assert.equal(other.verdict, "FAIL");
  assert.match(other.lines[0], /^BAD re-ask 2 is not the same request/);
  const soon = plant((a) => (a.quotes[1].t = a.quotes[0].answeredT + 100));
  assert.match(soon.lines.join("\n"), /re-ask 1 went 100 ms after the answer before it, under the page's 500 ms pause/);
  const fourth = plant((a) => a.quotes.push({ ...a.quotes[2], t: a.quotes[2].answeredT + 2_000 }));
  assert.equal(fourth.verdict, "FAIL");
  assert.match(fourth.lines.join("\n"), /more than 3/);
  assert.equal(plant((a) => realAsk(a, { status: 400 })).verdict, "FAIL", "lines from a 400");
  assert.equal(plant((a) => (a.answeredT = a.quotes[0].t + 14_001)).verdict, "FAIL");
  assert.equal(plant((a) => (a.ready = false)).verdict, "FAIL");
  assert.equal(plant((a) => (a.quotes[0].body = { ...a.quotes[0].body, dry: false })).verdict, "FAIL", "a live request where the run asked a dry read");
});
