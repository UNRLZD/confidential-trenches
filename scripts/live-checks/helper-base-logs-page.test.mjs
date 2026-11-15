// node --test scripts/live-checks/helper-base-logs-page.test.mjs: the live check replays recorded runs
// (helper-base-logs-page.answers.json). good: this card's relay on a Mac, its Base keyed list stand-ins shaped as the
// deployed one, paging 10,000 blocks: PASS. bad: the live helper at ffe3c1bf5 (release 144), 503 upstream: FAIL.
// Made from the good run: a log left out, a log of another block, an empty list, a range cap, a 400: each FAIL; a 429 from
// the helper or no reference answer: INCONCLUSIVE, never PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { FILTER, REFERENCE, SIGN, judge, read } from "./helper-base-logs-page.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-base-logs-page.answers.json"), "utf8"));
const HELPER = "https://ct-api.unrealized.trade";

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  const who = url === REFERENCE ? "reference" : url === `${HELPER}/v1/rpc/base?keyed=only` ? "helper" : null;
  assert.ok(who, url);
  assert.equal(init.method, "POST");
  if (who === "helper") assert.equal(init.headers.origin, SIGN);
  const body = JSON.parse(init.body);
  assert.equal(body.method, "eth_getLogs");
  assert.deepEqual(body.params, [FILTER]);
  const r = run.reads.findLast((x) => x.who === who);
  return new Response(r.body, { status: r.status });
};
const run = async (rec) => judge(await read(HELPER, replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const helperRead = () => A.good.reads.findLast((x) => x.who === "helper");
const withHelper = (f) => ({ ...A.good, reads: A.good.reads.map((x) => (x === helperRead() ? f(structuredClone(x)) : x)) });
const withLogs = (f) =>
  withHelper((x) => {
    const j = JSON.parse(x.body);
    j.result = f(j.result);
    x.body = JSON.stringify(j);
    return x;
  });

test("recorded good run: the helper's 10,000-block log read is the reference's, 11 logs in order: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual(r.lines, ["ok  helper: 11 log(s) over 10000 blocks", "ok  helper's logs are the reference's, in order (11 vs 11)"]);
});

test("recorded bad run: the live helper at release 144 answers 503 upstream: FAIL", async () => {
  const r = await run(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r), ['BAD helper: 503 on 10000 blocks, it does not serve the range ({"error":{"code":"upstream"}})']);
});

test("made from the good run: a log left out, another block, an empty list, a range cap, a 400: each FAIL", async () => {
  assert.equal((await run(withLogs((l) => l.slice(1)))).verdict, "FAIL");
  assert.equal((await run(withLogs((l) => l.map((x, i) => (i === 3 ? { ...x, blockNumber: "0x36d4914" } : x))))).verdict, "FAIL");
  const empty = await run(withLogs(() => []));
  assert.equal(empty.verdict, "FAIL");
  assert.ok(bad(empty).includes("BAD helper: 0 log(s) over 10000 blocks"));
  const cap = withHelper((x) => ((x.body = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"eth_getLogs range too wide, maximum block range: 5000"}}'), x));
  assert.equal((await run(cap)).verdict, "FAIL");
  const refused = withHelper((x) => ((x.status = 400), (x.body = '{"error":{"code":"method_not_allowed"}}'), x));
  assert.equal((await run(refused)).verdict, "FAIL");
});

test("a 429 from the helper, or no answer from the reference: INCONCLUSIVE, never PASS", async () => {
  const busy = withHelper((x) => ((x.status = 429), (x.body = '{"error":{"code":"rate_limited"}}'), x));
  assert.equal((await run(busy)).verdict, "INCONCLUSIVE");
  const quiet = { ...A.good, reads: A.good.reads.map((x) => (x.who === "reference" ? { ...x, status: 502, body: "bad gateway" } : x)) };
  assert.equal((await run(quiet)).verdict, "INCONCLUSIVE");
});
