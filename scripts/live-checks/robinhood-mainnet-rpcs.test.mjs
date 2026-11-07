// node --test scripts/live-checks/robinhood-mainnet-rpcs.test.mjs: card robinhood-mainnet-rpcs's live check, replayed.
// robinhood-mainnet-rpcs.answers.json holds a real run on the kit's Robinhood mainnet pool list (good: Robinhood's own
// and Pocket seated, both answering the pool's filter at the head and 1,000,000 back, their Swap logs the same), a real
// run on the pair the device had before (Robinhood's own and PublicNode: PublicNode's HTTP 403 "Archive requests require
// a personal token"), and the good answers under a list of one operator twice. Good passes; both bad runs fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BEFORE, ONE_OPERATOR, check, kitList, replayer } from "./robinhood-mainnet-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./robinhood-mainnet-rpcs.answers.json", import.meta.url), "utf8"));
const run = (r) => check(replayer(r.log), { list: r.list, address: r.address, poolManager: r.poolManager });

// the filter's address moves to the pool when pool-evm-deploy pins it; the list is the one the run must have read
test("the check reads the kit's own Robinhood pool list, and the good run is a run on it", () => {
  assert.deepEqual(A.good.list, kitList().list);
});

test("the recorded good run passes: Robinhood's own and Pocket, two operators, each paging the pool's filter, their Swap logs one", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^rpc\.mainnet\.chain\.robinhood\.com \(robinhood\.com\): chain 0x1237, head \d+; the pool's filter on 0x[0-9a-f]{40} over 10000 blocks to the head \d+ logs, 10000 blocks 1000000 back \d+ logs$/);
  assert.match(r.lines[1], /^robinhood\.api\.pocket\.network \(pocket\.network\): chain 0x1237, /);
  assert.match(r.lines[2], /^both seats: the PoolManager's Swap logs over blocks \d+-\d+, [1-9]\d* logs, digest [0-9a-f]{16} on both$/);
});

test("the recorded bad run on the pair before fails on PublicNode's archive refusal", async () => {
  assert.deepEqual(A.before.list, BEFORE);
  const r = await run(A.before);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^robinhood-rpc\.publicnode\.com: the pool's filter over 10000 blocks to the head: HTTP 403 RPC error -32602: Archive requests require a personal token/);
});

test("a list of one operator twice fails before any read", async () => {
  assert.deepEqual(A.oneOperator.list, ONE_OPERATOR);
  const r = await run(A.oneOperator);
  assert.equal(r.ok, false);
  assert.equal(r.lines.at(-1), "the two seats are one operator (robinhood.com): rpc.mainnet.chain.robinhood.com and rpc.testnet.chain.robinhood.com");
});

test("two seats whose Swap logs differ fail, and a seat with a read missing fails, never a pass", async () => {
  const swap = (e) => e.method === "eth_getLogs" && e.params[0].topics[0] !== undefined && !Array.isArray(e.params[0].topics[0]);
  const changed = A.good.log.map((e) => (swap(e) && e.url === A.good.list[1] ? { ...e, result: e.result.slice(1) } : e));
  const r = await run({ ...A.good, log: changed });
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^the seats' Swap logs over blocks \d+-\d+ differ: /);
  const missing = await run({ ...A.good, log: A.good.log.filter((e) => !(e.url === A.good.list[1] && e.method === "eth_chainId")) });
  assert.equal(missing.ok, false);
});
