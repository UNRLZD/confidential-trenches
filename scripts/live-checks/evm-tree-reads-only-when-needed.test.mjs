// node --test scripts/live-checks/evm-tree-reads-only-when-needed.test.mjs: the live check replays its recorded answers
// (evm-tree-reads-only-when-needed.answers.json). good: a fresh account's walk on this card's SIGN_HOST build (the
// check's --sign-dir, every other request live): PASS. liveBefore: the same walk on the live hosts at release 157,
// before this card: FAIL, both chains' pool index read for an account that holds nothing. release158: the walk on the
// live hosts at release 158 with each answer's JSON-RPC errors read: PASS. Planted on the good one: each
// fault put in FAILs, a provider's refusal FAILs and the page's own cancel does not, and the summary reads a filter's
// kind from its topics and counts each chain's eth_getLogs by load.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { errorsOf, INITIALIZE, judge, LOGS_PER_LOAD, refusalsOf, summarize } from "./evm-tree-reads-only-when-needed.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-tree-reads-only-when-needed.answers.json", import.meta.url), "utf8"));

test("recorded good answer: no pool index read, no EVM answer refused, the logs under the bound: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(ANSWERS.good.logs.index, 0);
});

test("recorded answer release158 (SIGN_HOST live, 15 Nov 23:24Z, the reader that reads each answer's errors): PASS, no provider refusal", () => {
  const v = judge(ANSWERS.release158);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(ANSWERS.release158.refused, {});
  assert.equal(ANSWERS.release158.signDir, null);
});

test("recorded answer liveBefore (release 157): FAIL, the pool index read for an account that holds nothing", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.match(v.lines[0], /^BAD the page read the pool index \d+ times/);
});

test("planted on the good answer: each fault FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, logs: { ...g.logs, index: 3 } }).lines, ["BAD the page read the pool index 3 times (the PoolManager's Initialize logs) for an account that holds nothing"]);
  assert.deepEqual(judge({ ...g, refused: { "base-rpc.publicnode.com 429": 2 } }).lines, ["BAD base-rpc.publicnode.com 429: 2 EVM RPC answers refused"]);
  assert.deepEqual(judge({ ...g, refused: { "rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED": 1 } }).lines, ["BAD rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED: 1 EVM RPC answers refused"]);
  const over = LOGS_PER_LOAD * g.loads + 1;
  assert.deepEqual(judge({ ...g, methods: { ...g.methods, eth_getLogs: over } }).lines, [`BAD ${over} eth_getLogs in ${g.loads} loads, over ${LOGS_PER_LOAD} a load`]);
  for (const bad of [null, {}, { ...g, loads: 0 }, { ...g, logs: undefined }]) assert.deepEqual(judge(bad).lines, ["BAD the walk was not read"]);
});

test("the summary: an Initialize filter alone is the index, one with a currency a quote scan, any other a pool read; a 429 and a failure are refused", () => {
  const post = (url, status, ...calls) => ({ url, method: "POST", status, calls });
  const logs = (topics) => ({ method: "eth_getLogs", params: [{ topics }] });
  const a = summarize(
    [
      { ...post("https://base-rpc.publicnode.com/", 200, logs([INITIALIZE]), { method: "eth_getBlockByNumber", params: [] }), load: 1 },
      { ...post("https://base.api.pocket.network/", 429, logs([INITIALIZE, null, "0x" + "1".repeat(64)])), load: 2 },
      { ...post("https://ct-api.unrealized.trade/v1/rpc/base?keyed=only", 200, logs([["0x" + "a".repeat(64)]])), load: 2 },
      post("https://base.rpc.blxrbdn.com/", 200, logs([["0x" + "a".repeat(64), "0x" + "b".repeat(64)]])),
      { ...post("https://rpc.mainnet.chain.robinhood.com/", undefined, { method: "eth_chainId", params: [] }), failed: "net::ERR_FAILED" },
      post("https://ct-api.unrealized.trade/v1/rpc/solana", 200, { method: "getAccountInfo", params: [] }),
      { url: "https://base-rpc.publicnode.com/", method: "GET", status: 200, calls: [{ method: "eth_getLogs", params: [{ topics: [INITIALIZE] }] }] },
    ],
    2,
  );
  assert.deepEqual(a.logs, { index: 1, scan: 1, other: 2 });
  assert.deepEqual(a.posts, { "base-rpc.publicnode.com": 1, "base.api.pocket.network": 1, "ct-api.unrealized.trade": 1, "base.rpc.blxrbdn.com": 1, "rpc.mainnet.chain.robinhood.com": 1 });
  assert.deepEqual(a.refused, { "base.api.pocket.network 429": 1, "rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED": 1 });
  assert.equal(a.methods.eth_getLogs, 4);
  // by load: the helper's Base route is Base's; a post with no load is the walk's last
  assert.deepEqual(a.byLoad, { base: [1, 3] });
});

// release 158's sign run 43773291937 (job 132993911514) failed on one "base.rpc.blxrbdn.com failed net::ERR_ABORTED":
// the page's own cancel (a navigation between loads, its AbortController), no provider's refusal. A provider's refusal
// stays BAD: an HTTP 4xx or 5xx, any other network failure, a JSON-RPC error that is no range cap.
test("planted refusals: the page's own ERR_ABORTED alone passes; a 429, a 5xx, an ERR_FAILED and a JSON-RPC rate-limit error each FAIL; a range cap is the pager's probe", () => {
  const g = ANSWERS.good;
  const req = (extra) => ({ url: "https://base.rpc.blxrbdn.com/", method: "POST", status: 200, load: 2, calls: [{ method: "eth_blockNumber", params: [] }], ...extra });
  const verdict = (extra) => judge({ ...g, refused: summarize([req(extra)], g.loads).refused });
  assert.equal(verdict({ status: undefined, failed: "net::ERR_ABORTED" }).ok, true, "the page's own cancel");
  assert.equal(verdict({ errors: errorsOf('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"eth_getLogs range too wide, maximum block range: 10000"}}') }).ok, true, "a named range cap");
  const bad = [
    [{ status: 429 }, "base.rpc.blxrbdn.com 429"],
    [{ status: 503 }, "base.rpc.blxrbdn.com 503"],
    [{ status: 403 }, "base.rpc.blxrbdn.com 403"],
    [{ status: undefined, failed: "net::ERR_FAILED" }, "base.rpc.blxrbdn.com failed net::ERR_FAILED"],
    [{ status: undefined, failed: "net::ERR_CONNECTION_RESET" }, "base.rpc.blxrbdn.com failed net::ERR_CONNECTION_RESET"],
    [{ errors: errorsOf('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit exceeded"}}') }, "base.rpc.blxrbdn.com rpc error -32005"],
    [{ errors: errorsOf('[{"jsonrpc":"2.0","id":1,"result":"0x1"},{"jsonrpc":"2.0","id":2,"error":{"code":429,"message":"Too Many Requests"}}]') }, "base.rpc.blxrbdn.com rpc error 429"],
  ];
  for (const [extra, key] of bad) assert.deepEqual(verdict(extra).lines, [`BAD ${key}: 1 EVM RPC answers refused`], key);
  assert.deepEqual(refusalsOf({ failed: "net::ERR_ABORTED", status: 502 }), ["502"], "a cancel after a 5xx is the 5xx");
});
