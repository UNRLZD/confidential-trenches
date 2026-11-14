// node --test scripts/live-checks/helper-pool-logs-outside-the-caller-budget.test.mjs: the live check replays recorded
// runs (helper-pool-logs-outside-the-caller-budget.answers.json). bad_before: the deployed helper at 204ee6b8a, the commit
// before this card, read 14 Nov: the finalized head and both pages answered, each second ask sent to the provider again
// with no cache hit: FAIL. good: made from that run, each second ask naming the cache's hit as this card's helper does
// (apps/helper/src/rpc/rpc.ts timingOf): PASS. Made from the good run: a 429 left after its retry, a head under the
// pages, other logs on the second ask, a missing read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAGES, POOL, SIGN, judge, read } from "./helper-pool-logs-outside-the-caller-budget.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-pool-logs-outside-the-caller-budget.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

/** A recorded read as the HTTP answer it was (rpcAnswer gives back its status, allow-origin and kept headers). */
const answer = (r) => {
  const headers = { "content-type": "application/json", "access-control-allow-origin": r.acao };
  for (const [k, v] of Object.entries(r.kept ?? {})) if (v !== null) headers[k] = v;
  const body = r.status === 429 ? '{"error":{"code":"rate_limited"}}' : JSON.stringify({ jsonrpc: "2.0", id: 1, ...(r.error !== undefined ? { error: r.error } : { result: r.result }) });
  return new Response(body, { status: r.status, headers });
};
// a fetch that answers each call with the recorded read, in order, after checking the check asked the right thing
const replay = (rec) => {
  let n = -1;
  return async (url, init) => {
    assert.equal(url, `${BASE}/v1/rpc/robinhood?keyed=only`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.origin, SIGN);
    const body = JSON.parse(init.body);
    if (n === -1) {
      n = 0;
      assert.deepEqual(body.params, ["finalized", false]);
      return answer(rec.head);
    }
    const r = rec.reads[n++];
    assert.equal(body.method, "eth_getLogs");
    assert.deepEqual(body.params, [{ address: POOL, fromBlock: PAGES[r.page][0], toBlock: PAGES[r.page][1] }]);
    return answer(r);
  };
};
const run = async (rec) => judge(await read(BASE, replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good run: each finalized page's second ask answered from the cache with the same logs: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad run: the helper before this card sends each second ask to its provider again, no cache hit: FAIL", async () => {
  const r = await run(A.bad_before);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.slice(0, l.indexOf("]") + 1)), ["BAD [page 0 ask 1]", "BAD [page 1 ask 1]"]);
  assert.ok(bad(r).every((l) => l.includes("the cache's hit in Server-Timing")));
});

test("made from the good run: a 429 left after its retry, a head under the pages, other logs on a second ask, a missing read: each FAIL", async () => {
  const edit = (f) => {
    const x = structuredClone(A.good);
    f(x);
    return x;
  };
  const throttled = judge(edit((x) => (x.reads[1] = { page: 0, ask: 1, status: 429, acao: SIGN, kept: x.reads[1].kept, noAnswer: "ct-api.unrealized.trade HTTP 429: 429 Too Many Requests" })));
  assert.ok(bad(throttled).some((l) => l.startsWith("BAD [page 0 ask 1] answered: 429")));
  const low = judge(edit((x) => (x.head.result = { number: "0x1" })));
  assert.deepEqual(bad(low).map((l) => l.slice(0, l.indexOf("]") + 1)), ["BAD [page 0]", "BAD [page 1]"]);
  const other = judge(edit((x) => (x.reads[3].result = [{ blockNumber: "0x1", logIndex: "0x0" }])));
  assert.ok(bad(other).some((l) => l.startsWith("BAD [page 1] the same logs both asks")));
  const missing = judge(edit((x) => x.reads.splice(3, 1)));
  assert.ok(bad(missing).includes("BAD [page 1 ask 1] no read"));
});
