// node --test scripts/live-checks/helper-says-why-a-vendor-refused.test.mjs: the live check replays its recorded answers
// (helper-says-why-a-vendor-refused.answers.json, its _note says where each was read).
//   good: a local helper from this card's tree, 1Click mocked with its own words: PASS.
//   bad_base: the same at 059a7cef0 (the deployed helper's commit): its 400 names no refusal: FAIL.
//   live_oneclick_down: the deployed helper while 1Click's quote API failed: 503 cause timeout: INCONCLUSIVE.
// Planted on the good answer: a 400 with no message, a refusal named ours, a 400 to the 10 USDC quote that 1Click quotes
// keyless (FAIL), or refuses keyless too (INCONCLUSIVE). And read() is replayed: two quotes to the proxy path, the twin only
// on a 400.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEPOSIT_DRY_PLACEHOLDER } from "../../packages/kit/src/index.ts";
import { EXIT, ONECLICK_QUOTE, QUOTE, QUOTE_AMOUNT, SHORT_AMOUNT, judge, read } from "./helper-says-why-a-vendor-refused.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-says-why-a-vendor-refused.answers.json", import.meta.url), "utf8"));
const plant = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};

test("recorded good answer: a local helper from this card's tree: 1Click's 400 carries its message and refusal vendor: PASS", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 0);
});

test("recorded bad answer: the helper at 059a7cef0 names no refusal on 1Click's 400: FAIL, named", () => {
  const v = judge(A.bad_base);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.lines, ['BAD short: the helper\'s 400 names no refusal in its Server-Timing, want refusal;desc="vendor"']);
  assert.equal(EXIT[v.verdict], 1);
});

test("recorded live answer: 1Click's quote API down, both 503 cause timeout: INCONCLUSIVE, exit 3", () => {
  const v = judge(A.live_oneclick_down);
  assert.equal(v.verdict, "INCONCLUSIVE", v.lines.join("\n"));
  assert.equal(EXIT[v.verdict], 3);
});

test("planted: a 400 with no message, one named ours, another status: FAIL", () => {
  assert.deepEqual(plant((a) => (a.short.message = null)).lines, ["BAD short: the helper's 400 carries no message of 1Click's"]);
  assert.deepEqual(plant((a) => (a.short.refusal = "ours")).lines, ['BAD short: the helper\'s 400 names refusal "ours" in its Server-Timing, want refusal;desc="vendor"']);
  assert.equal(plant((a) => Object.assign(a.short, { status: 201, message: null })).verdict, "FAIL");
  for (const cause of ["budget", "held", "429", "key", "answer"]) assert.equal(plant((a) => Object.assign(a.quote, { status: 503, cause })).verdict, "FAIL", cause);
});

test("planted: the 10 USDC quote refused 400 by the helper: FAIL when 1Click quotes it keyless, INCONCLUSIVE when 1Click refuses it too", () => {
  const ours = plant((a) => (Object.assign(a.quote, { status: 400, message: "Failed to get quote", refusal: "vendor" }), (a.twin = { status: 201, message: null })));
  assert.deepEqual(ours.lines, ['BAD quote: the helper answered 400 "Failed to get quote" where 1Click quotes the same request keyless (201): the helper\'s path refused it']);
  const theirs = plant((a) => (Object.assign(a.quote, { status: 400, message: "Failed to get quote", refusal: "vendor" }), (a.twin = { status: 400, message: "Failed to get quote" })));
  assert.equal(theirs.verdict, "INCONCLUSIVE");
  assert.deepEqual(theirs.lines, ['INCONCLUSIVE quote: the helper answered 400 "Failed to get quote" and 1Click keyless 400 "Failed to get quote": 1Click\'s own']);
  const down = plant((a) => (Object.assign(a.quote, { status: 400, message: "x" }), (a.twin = { status: 500, message: "Failed to receive response" })));
  assert.equal(down.verdict, "INCONCLUSIVE");
  assert.equal(plant((a) => Object.assign(a.quote, { status: 400, message: "x" })).verdict, "FAIL", "a 400 with no keyless read");
  // a 1Click refusal never hides a BAD line
  const both = plant((a) => (Object.assign(a.quote, { status: 503, cause: "timeout" }), (a.short.refusal = null)));
  assert.equal(both.verdict, "FAIL");
});

test("read() sends two dry quotes to the placeholder through the proxy path, and the keyless twin only on a 400", async () => {
  for (const [quoteStatus, twinWanted] of [[201, false], [400, true]]) {
    const sent = [];
    const fetchFn = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, body, cookie: init.credentials });
      const status = url === ONECLICK_QUOTE ? 201 : body.amount === SHORT_AMOUNT ? 400 : quoteStatus;
      return new Response(JSON.stringify(status === 400 ? { message: "m\nn" } : {}), { status, headers: { "content-type": "application/json", "server-timing": 'budget;dur=0, refusal;desc="vendor"' } });
    };
    const a = await read("https://helper.test/", fetchFn, () => 1_700_000_000_000);
    assert.deepEqual(sent.map((s) => s.url), ["https://helper.test" + QUOTE, "https://helper.test" + QUOTE, ...(twinWanted ? [ONECLICK_QUOTE] : [])]);
    assert.deepEqual(sent.map((s) => s.body.amount), [SHORT_AMOUNT, QUOTE_AMOUNT, ...(twinWanted ? [QUOTE_AMOUNT] : [])]);
    for (const s of sent) {
      assert.equal(s.body.dry, true);
      assert.equal(s.body.recipient, DEPOSIT_DRY_PLACEHOLDER);
      assert.equal(s.body.refundTo, DEPOSIT_DRY_PLACEHOLDER);
      assert.equal(s.cookie, "omit");
    }
    assert.deepEqual(a.short, { status: 400, ms: a.short.ms, message: "m n", refusal: "vendor", cause: null });
    assert.equal("twin" in a, twinWanted);
  }
});
