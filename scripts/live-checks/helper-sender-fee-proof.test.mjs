// node --test scripts/live-checks/helper-sender-fee-proof.test.mjs: the live check replays recorded runs
// (helper-sender-fee-proof.answers.json). good: each EVM testnet's helper-sent sale, its transaction and receipt read on
// both run RPCs, each receipt with the derived Paid log of the fee collector stand-in (no testnet collector yet): PASS.
// bad_no_paid: the same with the Paid log taken out of the second RPC's receipt (landed, status 1, the pool's Deposited
// log still there): FAIL. Made from the good run: a status 0, the Paid log from W, a value under the fee, receipts not
// marked derived, one RPC's read missing, another sale, a sale not read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { COLLECTORS, DERIVE, helperSales, judge, PAID_TOPIC, read, saleOf } from "./helper-sender-fee-proof.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the helper's own keccak (as helper-evm-sender.mjs loads it), not the check's constant
const { keccak_256 } = createRequire(path.join(HERE, "../../apps/helper/package.json"))("@noble/hashes/sha3.js");
const A = JSON.parse(readFileSync(path.join(HERE, "helper-sender-fee-proof.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const onReceipt = (run, i, f) => {
  const r = copy(run);
  for (const s of r.sales) s.reads[i].receipt = f(s.reads[i].receipt);
  return r;
};

test("recorded good run: each testnet's helper-sent sale, with the collector's derived Paid log, proven and paid on both RPCs, every plant charged in full: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(A.good.sales.map((s) => s.network), Object.keys(helperSales()));
});

test("recorded bad run: the second RPC's receipt without the collector's Paid log (landed, status 1, the pool's Deposited log still in it): FAIL on each chain", () => {
  const r = judge(A.bad_no_paid);
  assert.equal(r.ok, false);
  for (const s of A.bad_no_paid.sales) {
    assert.ok(s.reads[1].receipt.logs.some((l) => l.topics[0].toLowerCase().startsWith("0xe3b53cd1")), "the pool's Deposited log is in the bad receipt");
    assert.ok(bad(r).some((l) => l.startsWith(`BAD [${s.network}] the sale as both receipts hold it`)), bad(r).join("\n"));
  }
});

test("the Paid topic is keccak256 of Paid(address,uint256); until a testnet collector exists the receipts are derived and the collectors are a stand-in", () => {
  assert.equal(PAID_TOPIC, `0x${Buffer.from(keccak_256(new TextEncoder().encode("Paid(address,uint256)"))).toString("hex")}`);
  assert.equal(DERIVE, true);
  assert.equal(A.good.derived, true);
  for (const s of A.good.sales) for (const r of s.reads) assert.equal(r.receipt.logs.filter((l) => l.derived === true && l.address === COLLECTORS[s.network]).length, 1);
  assert.equal(judge({ ...A.good, derived: false }).ok, false, "receipts not marked derived");
  assert.equal(judge(A.good, undefined, {}).ok, false, "no collector named");
});

test("made from the good run: a status 0 on either RPC, the log from W, one RPC's read missing, another sale or a sale not read: each FAIL", () => {
  for (const i of [0, 1]) {
    assert.equal(judge(onReceipt(A.good, i, (x) => ({ ...x, status: "0x0" }))).ok, false, `status 0 on ${i}`);
    assert.equal(judge(onReceipt(A.good, i, (x) => ({ ...x, logs: x.logs.map((l) => ({ ...l, address: x.to })) }))).ok, false, `logs from W on ${i}`);
    assert.equal(judge(onReceipt(A.good, i, (x) => ({ ...x, logs: x.logs.map((l) => (l.derived ? { ...l, data: `0x${"00".repeat(32)}` } : l)) }))).ok, false, `a value 0 on ${i}`);
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

test("saleOf() reads W, the pool and the fee from the sale's input, as the helper's Sell holds them", () => {
  for (const s of A.good.sales) {
    const x = saleOf(s.reads[0].tx);
    assert.equal(x.w, s.reads[0].tx.to.toLowerCase());
    // the pool's real Deposited log of the sale: from the Sell's pool, its depositor W
    const dep = s.reads[0].receipt.logs.find((l) => l.topics[0].toLowerCase().startsWith("0xe3b53cd1"));
    assert.equal(dep.address.toLowerCase(), x.pool);
    assert.equal(BigInt(dep.topics[1]), BigInt(x.w));
    assert.ok(x.fee > 0n);
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
    // the RPCs answer the receipts without the derived log, as a chain does today; read() adds it
    const receipt = { ...r.receipt, logs: r.receipt.logs.filter((l) => !l.derived) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_getTransactionByHash" ? r.tx : receipt }));
  };
  const run = await read(fetchFn);
  assert.equal(judge(run).ok, true);
  assert.equal(asked.length, A.good.sales.length * 4);
});
