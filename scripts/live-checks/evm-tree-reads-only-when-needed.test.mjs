// node --test scripts/live-checks/evm-tree-reads-only-when-needed.test.mjs: the live check replays its recorded answers
// (evm-tree-reads-only-when-needed.answers.json). good: a fresh account's walk on this card's SIGN_HOST build (the
// check's --sign-dir, every other request live): PASS. liveBefore: the same walk on the live hosts at release 157,
// before this card: FAIL, both chains' pool index read for an account that holds nothing. Planted on the good one: each
// fault put in FAILs, and the summary reads a filter's kind from its topics.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INITIALIZE, judge, LOGS_PER_LOAD, summarize } from "./evm-tree-reads-only-when-needed.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./evm-tree-reads-only-when-needed.answers.json", import.meta.url), "utf8"));

test("recorded good answer: no pool index read, no EVM answer refused, the logs under the bound: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(ANSWERS.good.logs.index, 0);
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
      post("https://base-rpc.publicnode.com/", 200, logs([INITIALIZE]), { method: "eth_getBlockByNumber", params: [] }),
      post("https://base.api.pocket.network/", 429, logs([INITIALIZE, null, "0x" + "1".repeat(64)])),
      post("https://base.rpc.blxrbdn.com/", 200, logs([["0x" + "a".repeat(64), "0x" + "b".repeat(64)]])),
      { ...post("https://rpc.mainnet.chain.robinhood.com/", undefined, { method: "eth_chainId", params: [] }), failed: "net::ERR_FAILED" },
      post("https://ct-api.unrealized.trade/v1/rpc/solana", 200, { method: "getAccountInfo", params: [] }),
      { url: "https://base-rpc.publicnode.com/", method: "GET", status: 200, calls: [{ method: "eth_getLogs", params: [{ topics: [INITIALIZE] }] }] },
    ],
    2,
  );
  assert.deepEqual(a.logs, { index: 1, scan: 1, other: 1 });
  assert.deepEqual(a.posts, { "base-rpc.publicnode.com": 1, "base.api.pocket.network": 1, "base.rpc.blxrbdn.com": 1, "rpc.mainnet.chain.robinhood.com": 1 });
  assert.deepEqual(a.refused, { "base.api.pocket.network 429": 1, "rpc.mainnet.chain.robinhood.com failed net::ERR_FAILED": 1 });
  assert.equal(a.methods.eth_getLogs, 3);
});
