// node --test scripts/live-checks/deposit-sheet-oneclick-budget.test.mjs: the live check replays its recorded answers
// (deposit-sheet-oneclick-budget.answers.json, its _note says where each was read).
//   bad: the deployed helper before this card: the share read 2 with the helper idle: FAIL, each 429 named.
//   bad_base: a local helper from the base commit: FAIL the same way.
//   good: a local helper from this card's tree: PASS.
// Planted on the good answer: the sheet's quotes cut by 1Click's own slowness (503 cause timeout, the 02:07-02:20Z live
// runs' read) or its 5xx is INCONCLUSIVE; a quote refused 429 past the share, a 503 budget or held, a call that threw,
// a call missing each FAIL.
// And read() is replayed: it sends the sheet's five calls (the list, three dry quotes, one dry quote to the placeholder)
// then five list reads, each with Origin SIGN_HOST.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEPOSIT_DRY_PLACEHOLDER, ONECLICK_USDC_ASSETS } from "../../packages/kit/src/index.ts";
import { EXIT, NO_LIQUIDITY_MESSAGE_MAX, QUOTE, SIGN, TOKENS, judge, messageOf, read } from "./deposit-sheet-oneclick-budget.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "deposit-sheet-oneclick-budget.answers.json"), "utf8"));
const plant = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};

test("recorded good answer: a local helper from this card's tree: every call answered: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(v.verdict, "PASS");
});

test("recorded bad answer: the deployed helper before this card: three of five list reads 429 at a share of 2: FAIL, each named", () => {
  const v = judge(A.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    "BAD share: tokens 1 of 5 answered 429, Retry-After 9, want 200",
    "BAD share: tokens 2 of 5 answered 429, Retry-After 9, want 200",
    "BAD share: tokens 5 of 5 answered 429, Retry-After 9, want 200",
  ]);
  assert.equal(judge(A.bad_base).ok, false);
});

test("planted on the good answer: 1Click's own timeout or 5xx is INCONCLUSIVE, never PASS; beside a refusal of the helper's, FAIL", () => {
  const timeout = plant((a) => a.sheet.slice(1).forEach((c) => Object.assign(c, { status: 503, cause: "timeout" })));
  assert.equal(timeout.verdict, "INCONCLUSIVE");
  assert.equal(timeout.ok, false);
  assert.equal(timeout.lines.length, 4);
  assert.match(timeout.lines[0], /^INCONCLUSIVE sheet: quote 1 .* answered 503 \(cause timeout\): 1Click's own, not the helper's budget$/);
  assert.equal(plant((a) => Object.assign(a.share[1], { status: 503, cause: "5xx" })).verdict, "INCONCLUSIVE");
  const both = plant((a) => (Object.assign(a.sheet[1], { status: 503, cause: "timeout" }), Object.assign(a.share[2], { status: 429, retryAfter: "9" })));
  assert.equal(both.verdict, "FAIL");
  assert.deepEqual(both.lines, [`BAD share: ${A.good.share[2].what} answered 429, Retry-After 9, want 200`]);
  for (const cause of ["budget", "held", "429", "key", "answer"]) assert.equal(plant((a) => Object.assign(a.sheet[2], { status: 503, cause })).verdict, "FAIL", `cause ${cause} is the helper's`);
});

test("planted on the good answer: a 429 past the share, a throw, a missing call: each FAIL, named", () => {
  const share = plant((a) => Object.assign(a.sheet[3], { status: 429, retryAfter: "8" }));
  assert.deepEqual(share.lines, [`BAD sheet: ${A.good.sheet[3].what} answered 429, Retry-After 8, want 200 or 201`]);
  assert.equal(plant((a) => (a.share[0].status = "threw TimeoutError")).ok, false);
  assert.deepEqual(plant((a) => a.sheet.pop()).lines, ["BAD sheet: 4 calls recorded, want 5"]);
  assert.equal(plant((a) => (a.sheet[0].status = 201)).ok, false, "the list answers 200, never 201");
});

test("read(): the sheet's five calls as the page sends them, then five list reads, each with Origin SIGN_HOST", async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ path: new URL(url).pathname, origin: init.headers.origin, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return new Response("{}", { status: url.endsWith("/quote") ? 201 : 200, headers: { "content-type": "application/json" } });
  };
  const a = await read("https://helper.test", f, async () => {});
  assert.equal(judge(a).ok, true, judge(a).lines.join("\n"));
  assert.deepEqual(seen.map((s) => s.path), [TOKENS, QUOTE, QUOTE, QUOTE, QUOTE, TOKENS, TOKENS, TOKENS, TOKENS, TOKENS]);
  assert.ok(seen.every((s) => s.origin === SIGN));
  const quotes = seen.filter((s) => s.path === QUOTE).map((s) => s.body);
  assert.deepEqual(quotes.map((q) => [q.originAsset, q.amount]), [...ONECLICK_USDC_ASSETS.map((id) => [id, "10000000"]), [ONECLICK_USDC_ASSETS[1], "25000000"]]);
  for (const q of quotes) {
    assert.equal(q.dry, true);
    assert.equal(q.recipient, DEPOSIT_DRY_PLACEHOLDER);
    assert.equal(q.refundTo, DEPOSIT_DRY_PLACEHOLDER);
  }
  assert.ok(seen.filter((s) => s.path === TOKENS).every((s) => s.body === undefined));
});

// Card deposit-quote-no-liquidity: the sheet's 25 USDC quote answered 1Click's 400 "No liquidity available" went through the
// helper's budget and back: 1Click's liquidity, not the helper's: INCONCLUSIVE (exit 3), never FAIL; any other 400 stays FAIL.
test("recorded: 1Click had no liquidity for the sheet's 25 USDC quote, every other call answered: INCONCLUSIVE, exit 3, no BAD line", () => {
  const v = judge(A.no_liquidity);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ["INCONCLUSIVE sheet: quote 4 (25 USDC from Solana) answered 400 No liquidity available: 1Click's own, not the helper's budget"]);
  assert.equal(EXIT[v.verdict], 3);
});

test("planted: a 400 of another message, a no-liquidity message on a list read or another status, and beside a 429 past the share: FAIL", () => {
  const nl = (f) => {
    const a = structuredClone(A.no_liquidity);
    f(a);
    return judge(a);
  };
  assert.equal(nl((a) => (a.sheet[4].message = "Amount is too low for bridge")).verdict, "FAIL");
  assert.equal(nl((a) => delete a.sheet[4].message).verdict, "FAIL", "a 400 with no message");
  assert.equal(nl((a) => (a.sheet[4].status = 503)).verdict, "FAIL", "the message under the helper's 503");
  assert.equal(nl((a) => Object.assign(a.sheet[0], { status: 400, message: "No liquidity available" })).verdict, "FAIL", "the list never answers no liquidity");
  const both = nl((a) => Object.assign(a.sheet[2], { status: 429, retryAfter: "8" }));
  assert.equal(both.verdict, "FAIL");
  assert.deepEqual(both.lines, [`BAD sheet: ${A.good.sheet[2].what} answered 429, Retry-After 8, want 200 or 201`]);
});

test("read() keeps a 400's message, bounded, and nothing of any other answer's body", async () => {
  const NL = JSON.stringify({ message: "No liquidity available", correlationId: "2357c43d-9fdf-4c05-9732-edaa447fcb6a", timestamp: "2026-11-10T19:06:57.250Z", path: "/v0/quote" });
  const f = async (url, init) => {
    const q = init.body === undefined ? null : JSON.parse(init.body);
    if (q?.amount === "25000000") return new Response(NL, { status: 400, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ message: "kept nowhere" }), { status: url.endsWith("/quote") ? 201 : 200, headers: { "content-type": "application/json" } });
  };
  const a = await read("https://helper.test", f, async () => {});
  assert.equal(judge(a).verdict, "INCONCLUSIVE", judge(a).lines.join("\n"));
  assert.equal(a.sheet[4].message, "No liquidity available");
  assert.ok([...a.sheet.slice(0, 4), ...a.share].every((c) => !("message" in c)));
  assert.equal(messageOf(JSON.stringify({ message: "x".repeat(500) })).length, NO_LIQUIDITY_MESSAGE_MAX);
  assert.equal(messageOf("<html>"), null);
  assert.equal(messageOf(JSON.stringify({ message: 5 })), null);
});
