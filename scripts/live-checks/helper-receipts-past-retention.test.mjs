// node --test scripts/live-checks/helper-receipts-past-retention.test.mjs: the live check replays its recorded runs
// (helper-receipts-past-retention.answers.json), each written by its own read from this Mac, 19 Nov 2026, the block
// 1,500,000 below the reference reader's head and its transactions read on base-rpc.publicnode.com and
// robinhood-rpc.publicnode.com:
//   goodLocal (02:50Z): this card's apps/helper/src/rpc/rpc.ts behind a local route; each chain's first keyed upstream
//   the chain's own public RPC with every receipt, transaction and numbered block older than 750,000 blocks answered
//   null (an upstream past its retention, as 19 Nov 02:20Z), the second robinhood.drpc.org or base.drpc.org: PASS;
//   bad (02:50Z): main 98b75faf3's rpc.ts on the same upstreams: every one of them null: FAIL;
//   deployed (02:49Z): the deployed helper (X-Helper-Commit fc3c11b6e): every single read answered, Robinhood's
//   batches answered, Base's keyed batch of 9 receipts a 503 upstream: FAIL.
// Then cases planted on the good run, one end state undone each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEPTH, REF, judge, read } from "./helper-receipts-past-retention.mjs";

const A = JSON.parse(readFileSync(new URL("./helper-receipts-past-retention.answers.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const verdict = (run, want, start) => {
  const r = judge(run);
  assert.equal(r.verdict, want, r.lines.join("\n"));
  if (start !== undefined) assert.ok(r.lines.some((l) => l.startsWith(start)), `${start}\n${r.lines.join("\n")}`);
};

test("the good answer: the card's helper with one upstream that forgot old records answers each from the next: PASS", () => {
  verdict(A.goodLocal, "PASS");
  for (const c of Object.keys(REF)) assert.ok(A.goodLocal.chains[c].ref.txs.length > 0, c);
});

test("the bad answer: main's helper on the same upstreams passes the forgetting upstream's nulls on: FAIL", () => {
  verdict(A.bad, "FAIL", "BAD robinhood receipt");
  verdict(A.bad, "FAIL", "BAD robinhood block");
  verdict(A.bad, "FAIL", "BAD base transaction");
  verdict(A.bad, "FAIL", "BAD robinhood keyed route receipt 1");
});

test("the deployed run of 02:49Z: a 503 to Base's keyed batch of receipts: FAIL", () => {
  verdict(A.deployed, "FAIL", "BAD base keyed route, a batch of 9 receipts: HTTP 503");
});

test("planted on the good run: a null, a call's error, another block's receipt, a smaller depth and a batch left short each FAIL", () => {
  const nul = clone(A.goodLocal);
  nul.chains.robinhood.receipt = { result: null };
  verdict(nul, "FAIL", "BAD robinhood receipt");
  const err = clone(A.goodLocal);
  err.chains.base.tx = { error: { code: -32000, message: "missing trie node" } };
  verdict(err, "FAIL", "BAD base transaction");
  const other = clone(A.goodLocal);
  other.chains.base.keyedBatch.answers[0].result.blockNumber = "0x1";
  verdict(other, "FAIL", "BAD base keyed route receipt 1");
  const shallow = clone(A.goodLocal);
  shallow.depth = 10;
  verdict(shallow, "FAIL", "BAD the run's block is 10 below");
  const short = clone(A.goodLocal);
  short.chains.robinhood.plainBatch.answers.pop();
  verdict(short, "FAIL", "BAD robinhood device's route, a batch of");
  const nulBatch = clone(A.goodLocal);
  nulBatch.chains.robinhood.plainBatch.answers[0] = { result: null };
  verdict(nulBatch, "FAIL", "BAD robinhood device's route receipt 1");
});

test("planted on the good run: the reference naming no block, or a helper 429, is INCONCLUSIVE", () => {
  const noRef = clone(A.goodLocal);
  noRef.chains.base = { ref: { head: { noAnswer: "base-rpc.publicnode.com HTTP 429: 429 Too Many Requests" } } };
  verdict(noRef, "INCONCLUSIVE", "--- base: the reference reader named no block");
  const busy = clone(A.goodLocal);
  busy.chains.robinhood.keyedBatch = { status: 429, noAnswer: "ct-api.unrealized.trade HTTP 429: 429 Too Many Requests" };
  verdict(busy, "INCONCLUSIVE", "--- robinhood keyed route");
});

test("read() asks REF for its head and the block DEPTH below, then the helper's keyed route 4 times and its device route once a chain", async () => {
  const sent = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push([url, Array.isArray(body) ? body.map((c) => c.method) : body.method]);
    const tx = "0x" + "c".repeat(64);
    const one = (c) => {
      const r = { eth_blockNumber: "0x2000000", eth_getBlockByNumber: { number: c.params[0], hash: "0x" + "b".repeat(64), transactions: [tx] } }[c.method] ?? { hash: tx, transactionHash: tx, blockNumber: c.params[0] === tx ? `0x${(0x2000000 - DEPTH).toString(16)}` : "0x0", blockHash: "0x" + "b".repeat(64) };
      return { jsonrpc: "2.0", id: c.id, result: r };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const run = await read("https://helper.test/", fetchFn);
  for (const [chain, ref] of Object.entries(REF)) {
    const mine = sent.filter(([u]) => u === ref || u.startsWith(`https://helper.test/v1/rpc/${chain}`));
    assert.deepEqual(mine.map(([u, m]) => [u.replace("https://helper.test", ""), m]), [
      [ref, "eth_blockNumber"],
      [ref, "eth_getBlockByNumber"],
      [`/v1/rpc/${chain}?keyed=only`, "eth_getBlockByNumber"],
      [`/v1/rpc/${chain}?keyed=only`, "eth_getTransactionByHash"],
      [`/v1/rpc/${chain}?keyed=only`, "eth_getTransactionReceipt"],
      [`/v1/rpc/${chain}?keyed=only`, ["eth_getTransactionReceipt"]],
      [`/v1/rpc/${chain}`, ["eth_getTransactionReceipt"]],
    ]);
  }
  verdict(run, "PASS");
});
