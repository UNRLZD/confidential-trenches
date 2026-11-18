// node --test scripts/live-checks/helper-rpc-batch-learns-reader-size.test.mjs: the live check replays its recorded
// runs (helper-rpc-batch-learns-reader-size.answers.json), each written by its own --record from this Mac, 18 Nov 2026:
//   good (23:22Z): the deployed helper (X-Helper-Commit fc3c11b6e), a batch of 10 eth_blockNumber on Base and on
//   Robinhood, every call a block: PASS;
//   goodLocal (23:22Z): this card's apps/helper/src/rpc/rpc.ts behind a local server, every upstream a local fake
//   refusing by a mainnet reader's own shape (Base: Pocket's 413 past 5, then dRPC's 400 code 31 past 3; Robinhood:
//   Sentio's 429 code 8 past 5, then daybreak's 413 naming its max): PASS, each batch served in parts;
//   bad (23:22Z): main 52d51b5b9's rpc.ts on the same fakes: Base answered dRPC's 400 refusal of every call, Robinhood
//   daybreak's 413: FAIL.
// Then cases planted on the good run, one end state undone each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BATCH, judge, read } from "./helper-rpc-batch-learns-reader-size.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-rpc-batch-learns-reader-size.answers.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const verdict = (run, want, start) => {
  const r = judge(run);
  assert.equal(r.verdict, want, r.lines.join("\n"));
  if (start !== undefined) assert.ok(r.lines.some((l) => l.startsWith(start)), `${start}\n${r.lines.join("\n")}`);
};

test("the good answer: the deployed helper answers a batch of 10 in full on Base and Robinhood: PASS", () => {
  verdict(A.good, "PASS");
  assert.equal(A.good.base, "https://ct-api.unrealized.trade");
  for (const c of ["base", "robinhood"]) assert.equal(A.good.reads[c].answers.length, BATCH);
});

test("the card's helper on upstreams that each refuse a batch of 10 for its size: PASS", () => {
  verdict(A.goodLocal, "PASS");
});

test("the bad answer: main's helper on the same upstreams passes dRPC's 400 and daybreak's 413 to the device: FAIL", () => {
  verdict(A.bad, "FAIL", "BAD base: HTTP 400");
  verdict(A.bad, "FAIL", "BAD robinhood: HTTP 413 with one error for the batch");
});

test("planted on the good run: the helper's 503 upstream is FAIL; a 429 is INCONCLUSIVE", () => {
  const down = clone(A.good);
  down.reads.base = { status: 503, error: { code: "upstream" } };
  verdict(down, "FAIL", "BAD base: HTTP 503 with one error");
  const busy = clone(A.good);
  busy.reads.robinhood = { status: 429, noAnswer: "ct-api.unrealized.trade HTTP 429: 429 Too Many Requests" };
  verdict(busy, "INCONCLUSIVE", "--- robinhood");
});

test("planted on the good run: a call left out, a call's error, a result that is no block, a spread past SPREAD and a smaller batch each FAIL", () => {
  const left = clone(A.good);
  left.reads.base.answers[3] = { noAnswer: `ct-api.unrealized.trade HTTP 200: no answer for call 4 of ${BATCH}` };
  verdict(left, "FAIL", "BAD base call 4: left out");
  const err = clone(A.good);
  err.reads.robinhood.answers[9] = { error: { code: 31, message: "Batch of more than 3 requests are not allowed on free plan" } };
  verdict(err, "FAIL", "BAD robinhood call 10: an error");
  const odd = clone(A.good);
  odd.reads.base.answers[0] = { result: { number: "0x1" } };
  verdict(odd, "FAIL", "BAD base call 1: no block number");
  const far = clone(A.good);
  far.reads.base.answers[5] = { result: "0x1" };
  verdict(far, "FAIL", "BAD base: 10 of 10 calls answered blocks 1 to");
  const small = clone(A.good);
  small.batch = 3;
  verdict(small, "FAIL", "BAD the run's batch is 3 calls");
  const throttled = clone(A.good);
  throttled.reads.base.answers[2] = { noAnswer: "ct-api.unrealized.trade HTTP 200: rate limit {}" };
  verdict(throttled, "INCONCLUSIVE", "--- base call 3");
});

test("read() sends one POST of BATCH eth_blockNumber to each chain's /v1/rpc, ids 1 to BATCH", async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push([url, body]);
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x10" }))), { status: 200, headers: { "content-type": "application/json" } });
  };
  const run = await read("https://helper.test/", fetchFn);
  assert.deepEqual(sent.map(([u]) => u), ["https://helper.test/v1/rpc/base", "https://helper.test/v1/rpc/robinhood"]);
  for (const [, b] of sent) {
    assert.deepEqual(b.map((c) => c.id), Array.from({ length: BATCH }, (_, i) => i + 1));
    assert.ok(b.every((c) => c.method === "eth_blockNumber"));
  }
  verdict(run, "PASS");
});
