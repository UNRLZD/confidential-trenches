// node --test scripts/live-checks/helper-keyed-logs-serve-a-whole-pool-range.test.mjs: the live check replays recorded
// runs (helper-keyed-logs-serve-a-whole-pool-range.answers.json). good: this card's relay on a Mac, its Base keyed list
// stand-ins shaped as the deployed one, the pool store filled from the deploy block: PASS. bad: the live helper at
// release 158, its range cap on the pool's 3.6 million blocks: FAIL. Made from the good run: a log left out, a log of
// another block, an empty list, the old cap, a 400, a slow answer: each FAIL; a store still filling, a 429 from the
// helper or a reference page unanswered: INCONCLUSIVE, never PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { FROM, HELPER_MS, POOL, REF_PAGE, REFERENCE, SIGN, judge, read } from "./helper-keyed-logs-serve-a-whole-pool-range.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-keyed-logs-serve-a-whole-pool-range.answers.json"), "utf8"));
const HELPER = "https://ct-api.unrealized.trade";
const hex = (n) => `0x${n.toString(16)}`;

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => {
  let page = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.method, "POST");
    if (url === REFERENCE && body.method === "eth_getBlockByNumber") {
      assert.deepEqual(body.params, ["finalized", false]);
      const r = run.reads.findLast((x) => x.who === "head");
      return new Response(r.body, { status: r.status });
    }
    assert.equal(body.method, "eth_getLogs");
    if (url === `${HELPER}/v1/rpc/base?keyed=only`) {
      assert.equal(init.headers.origin, SIGN);
      assert.deepEqual(body.params, [{ address: POOL, fromBlock: hex(FROM), toBlock: hex(run.to) }], "the pool's whole finalized range in one read");
      const r = run.reads.findLast((x) => x.who === "helper");
      return new Response(r.body, { status: r.status });
    }
    assert.equal(url, REFERENCE);
    // the page by its first block (a no-answer is read again once, the same page)
    const i = (Number(BigInt(body.params[0].fromBlock)) - FROM) / REF_PAGE;
    assert.ok(Number.isInteger(i) && i <= page++);
    assert.deepEqual(body.params, [{ address: POOL, fromBlock: hex(FROM + i * REF_PAGE), toBlock: hex(Math.min(FROM + (i + 1) * REF_PAGE - 1, run.to)) }]);
    const r = run.reads.findLast((x) => x.who === "reference" && x.page === i);
    return new Response(r.body, { status: r.status });
  };
};
// a replay's verdict, the helper's time as recorded (a replay's own is a few ms)
const run = async (rec) => {
  const got = await read(HELPER, replay(rec));
  const ms = rec.reads.findLast((x) => x.who === "helper")?.ms;
  return judge({ ...got, reads: got.reads.map((x) => (x.who === "helper" ? { ...x, ms } : x)) });
};
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const helperRead = (rec) => rec.reads.findLast((x) => x.who === "helper");
const withHelper = (f) => ({ ...A.good, reads: A.good.reads.map((x) => (x === helperRead(A.good) ? f(structuredClone(x)) : x)) });
const withLogs = (f) =>
  withHelper((x) => {
    const j = JSON.parse(x.body);
    j.result = f(j.result);
    x.body = JSON.stringify(j);
    return x;
  });
const logsOf = (rec) => JSON.parse(helperRead(rec).body).result;

test("recorded good run: the helper's one read of the pool's whole finalized life is the reference's, log for log: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  const n = logsOf(A.good).length;
  assert.ok(n > 0);
  assert.deepEqual(r.lines, [`ok  helper: ${n} log(s) over ${A.good.to - FROM + 1} blocks in one read`, `ok  helper: answered in ${helperRead(A.good).ms} ms (at most ${HELPER_MS})`, `ok  helper's logs are the reference's, in order (${n} vs ${n})`]);
});

test("recorded bad run: the live helper at release 158 caps the range at 10,000 blocks: FAIL", async () => {
  const r = await run(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r), [`BAD helper: a JSON-RPC error on ${A.bad.to - FROM + 1} blocks: {"code":-32602,"message":"eth_getLogs range too wide, maximum block range: 10000"}`]);
});

test("made from the good run: a log left out, another block, an empty list, the old cap, a 400, a slow answer: each FAIL", async () => {
  assert.equal((await run(withLogs((l) => l.slice(1)))).verdict, "FAIL");
  assert.equal((await run(withLogs((l) => l.map((x, i) => (i === 0 ? { ...x, blockNumber: hex(Number(BigInt(x.blockNumber)) + 1) } : x))))).verdict, "FAIL");
  const empty = await run(withLogs(() => []));
  assert.equal(empty.verdict, "FAIL");
  assert.ok(bad(empty).includes(`BAD helper: 0 log(s) over ${A.good.to - FROM + 1} blocks in one read`));
  const cap = withHelper((x) => ((x.body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"eth_getLogs range too wide, maximum block range: 10000"}}'), x));
  assert.equal((await run(cap)).verdict, "FAIL");
  const refused = withHelper((x) => ((x.status = 400), (x.body = '{"error":{"code":"method_not_allowed"}}'), x));
  assert.equal((await run(refused)).verdict, "FAIL");
  const slow = withHelper((x) => ((x.ms = HELPER_MS + 1), x));
  assert.deepEqual(bad(await run(slow)), [`BAD helper: answered in ${HELPER_MS + 1} ms (at most ${HELPER_MS})`]);
});

test("a store still filling, a 429 from the helper, or a reference page unanswered: INCONCLUSIVE, never PASS", async () => {
  const filling = withHelper((x) => ((x.body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"eth_getLogs range too wide, maximum block range: 10000","data":"pool logs kept to block 55000000"}}'), x));
  const f = await run(filling);
  assert.equal(f.verdict, "INCONCLUSIVE");
  assert.deepEqual(f.lines.slice(0, 1), [`--  helper: its pool store is still filling, kept to block 55000000 of ${A.good.to}`]);
  // words in the data that are not the store's own: the old cap, FAIL
  const other = withHelper((x) => ((x.body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"eth_getLogs range too wide, maximum block range: 10000","data":"pool logs kept to block 1; or not"}}'), x));
  assert.equal((await run(other)).verdict, "FAIL");
  const busy = withHelper((x) => ((x.status = 429), (x.body = '{"error":{"code":"rate_limited"}}'), x));
  assert.equal((await run(busy)).verdict, "INCONCLUSIVE");
  const quiet = { ...A.good, reads: A.good.reads.map((x) => (x.who === "reference" && x.page === 3 ? { ...x, status: 502, body: "bad gateway" } : x)) };
  assert.equal((await run(quiet)).verdict, "INCONCLUSIVE");
});
