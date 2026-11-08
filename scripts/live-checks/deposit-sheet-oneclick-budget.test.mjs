// node --test scripts/live-checks/deposit-sheet-oneclick-budget.test.mjs: the live check replays its recorded answers
// (deposit-sheet-oneclick-budget.answers.json, its _note says where each was read).
//   bad: the deployed helper before this card: the share read 2 with the helper idle: FAIL, each 429 named.
//   bad_base: a local helper from the base commit: FAIL the same way.
//   good: a local helper from this card's tree: PASS.
// Planted on the good answer, each FAILs: the sheet's quotes cut by 1Click's own slowness (503 cause timeout, the
// 02:07-02:20Z live runs' read), a quote refused 429 past the share, a call that threw, a call missing.
// And read() is replayed: it sends the sheet's five calls (the list, three dry quotes, one dry quote to the placeholder)
// then five list reads, each with Origin SIGN_HOST.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEPOSIT_DRY_PLACEHOLDER, ONECLICK_USDC_ASSETS } from "../../packages/kit/src/index.ts";
import { QUOTE, SIGN, TOKENS, judge, read } from "./deposit-sheet-oneclick-budget.mjs";

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

test("planted on the good answer: 1Click's own timeout, a 429 past the share, a throw, a missing call: each FAIL, named", () => {
  const timeout = plant((a) => a.sheet.slice(1).forEach((c) => Object.assign(c, { status: 503, cause: "timeout" })));
  assert.equal(timeout.ok, false);
  assert.equal(timeout.lines.length, 4);
  assert.match(timeout.lines[0], /^BAD sheet: quote 1 .* answered 503 \(cause timeout\), want 200 or 201$/);
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
