// node --test scripts/live-checks/helper-sender-fee-proof.test.mjs: the live check replays recorded runs
// (helper-sender-fee-proof.answers.json). good: each EVM testnet's helper-sent sale, its transaction and receipt read on
// both run RPCs: PASS. bad_no_log: the same with the pool's Deposited log taken out of the second RPC's receipt (a
// landed-without-event answer): FAIL. Made from the good run: a status 0, a log from W, one RPC's read missing, another
// sale, a sale not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { helperSales, judge, read, saleOf } from "./helper-sender-fee-proof.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-sender-fee-proof.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const onReceipt = (run, i, f) => {
  const r = copy(run);
  for (const s of r.sales) s.reads[i].receipt = f(s.reads[i].receipt);
  return r;
};

test("recorded good run: each testnet's helper-sent sale proven and paid on both RPCs, every plant charged in full: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.sales.map((s) => s.network), Object.keys(helperSales()));
});

test("recorded bad run: the second RPC's receipt without the pool's Deposited log (landed, status 1, no proof): FAIL on each chain", () => {
  const r = judge(A.bad_no_log);
  assert.equal(r.ok, false);
  for (const s of A.bad_no_log.sales) assert.ok(bad(r).some((l) => l.startsWith(`BAD [${s.network}] the sale as both RPCs answer it`)), bad(r).join("\n"));
});

test("made from the good run: a status 0 on either RPC, the log from W, one RPC's read missing, another sale or a sale not read: each FAIL", () => {
  for (const i of [0, 1]) {
    assert.equal(judge(onReceipt(A.good, i, (x) => ({ ...x, status: "0x0" }))).ok, false, `status 0 on ${i}`);
    assert.equal(judge(onReceipt(A.good, i, (x) => ({ ...x, logs: x.logs.map((l) => ({ ...l, address: x.to })) }))).ok, false, `logs from W on ${i}`);
  }
  const one = copy(A.good);
  one.sales[0].reads = one.sales[0].reads.slice(0, 1);
  assert.equal(judge(one).ok, false, "one RPC only");
  const other = copy(A.good);
  other.sales[0].hash = `0x${"11".repeat(32)}`;
  assert.equal(judge(other).ok, false, "another sale");
  assert.equal(judge({ sales: A.good.sales.slice(1) }).ok, false, "a sale not read");
  assert.equal(judge({ sales: [] }).ok, false);
});

test("saleOf() reads W, the pool, the precommitment and the fee from the sale's input, as the helper's Sell holds them", () => {
  for (const s of A.good.sales) {
    const x = saleOf(s.reads[0].tx);
    assert.equal(x.w, s.reads[0].tx.to.toLowerCase());
    const dep = s.reads[0].receipt.logs.find((l) => l.topics[0].toLowerCase().startsWith("0xe3b53cd1"));
    assert.equal(dep.address.toLowerCase(), x.pool);
    assert.equal(BigInt(`0x${dep.data.slice(2 + 3 * 64)}`), x.precommitment);
  }
  assert.throws(() => saleOf({ input: "0x", to: "0x" }));
});

test("read() asks both run RPCs for each sale's transaction and receipt (replayed RPCs)", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    asked.push(`${new URL(url).host} ${method}`);
    const s = A.good.sales.find((x) => x.hash === params[0]);
    const r = s.reads.find((x) => x.url === url);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_getTransactionByHash" ? r.tx : r.receipt }));
  };
  const run = await read(fetchFn);
  assert.equal(judge(run).ok, true);
  assert.equal(asked.length, A.good.sales.length * 4);
});
