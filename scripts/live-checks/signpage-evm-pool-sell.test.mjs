// node --test scripts/live-checks/signpage-evm-pool-sell.test.mjs: the live check replays recorded runs
// (signpage-evm-pool-sell.answers.json). good: the card's two sales read back on both pool RPCs of their chains, the
// helper's sell route refusing a malformed sale from SIGN_HOST, and SIGN_HOST's mainnet bundle with no EVM sell: PASS.
// bad_buys: the sold holdings' own buys named as sales: FAIL. Made from the good run: a sale read back on one RPC only,
// a reverted receipt, a receipt with no Deposited, a Deposited from another address, another block, another chain id,
// another sender, another delegate, no authorization, a helper that sends a malformed sale, a CORS echo of "*", one
// testnet missing, a bundle that is not the pinned one, the EVM sell in the served bundle: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { PINS } from "./evm-pool-pins.mjs";
import { DEPOSITED, EVM_SELL_MARKS, HELPER, SIGN, judge, pageFacts, read, txsOf } from "./signpage-evm-pool-sell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
RETRY.ms = 0;
const A = JSON.parse(readFileSync(path.join(HERE, "signpage-evm-pool-sell.answers.json"), "utf8"));
const RECORD = readFileSync(path.join(HERE, "signpage-evm-pool-sell.md"), "utf8");

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  if (url.startsWith(SIGN)) return new Response("", { status: 200 }); // the page's facts are the recording's (rec.page)
  const body = JSON.parse(init.body);
  if (url === `${HELPER}/v1/pool/evm/sell`) {
    assert.equal(init.method, "POST");
    assert.equal(init.headers.origin, SIGN);
    const s = run.sends.find((x) => PINS[x.network].pool === body.pool);
    assert.ok(s, `a recorded send for ${body.pool}`);
    return new Response(s.body, { status: s.status, headers: s.headers["access-control-allow-origin"] ? { "access-control-allow-origin": s.headers["access-control-allow-origin"] } : {} });
  }
  assert.equal(init.method, "POST");
  const r = run.reads.find((x) => x.rpc === url && x.method === body.method && x.hash === body.params[0]);
  assert.ok(r, `a recorded read for ${url} ${body.method}`);
  if (r.answer.noAnswer !== undefined) return new Response("", { status: 429 });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...r.answer }), { status: 200 });
};
const mdOf = (run) => run.txs.map((t) => `Sell: ${t.network} ${t.hash}`).join("\n");
const run = async (rec) => judge({ ...(await read(mdOf(rec), replay(rec))), page: rec.page });
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const editRead = (rec, f) => ({ ...rec, reads: rec.reads.map((x, i) => f(x, i) ?? x) });
const withResult = (x, f) => ({ ...x, answer: { result: f(x.answer.result) } });
const receipt = (f) => (x) => (x.method === "eth_getTransactionReceipt" && x.rpc.includes("publicnode") ? withResult(x, f) : undefined);
const txn = (f) => (x) => (x.method === "eth_getTransactionByHash" && x.rpc.includes("publicnode") ? withResult(x, f) : undefined);

test("the run record's Sell lines are the recorded good run's sales, and each is a Tx line too", () => {
  assert.deepEqual(txsOf(RECORD), A.good.txs);
  for (const t of A.good.txs) assert.ok(RECORD.includes(`Tx: ${t.network} ${t.hash}\n`));
  assert.match(RECORD, /^Money path: yes$/m);
});

test("pageFacts reads the index's pin, the bundle's sha384 and the EVM sell's marks", () => {
  const js = `x("${EVM_SELL_MARKS[0]}")`;
  const f = pageFacts('<script src="/app.js" integrity="sha384-AAAA"></script>', js);
  assert.equal(f.pin, "sha384-AAAA");
  assert.match(f.sha384, /^sha384-/);
  assert.deepEqual(f.marks, [EVM_SELL_MARKS[0]]);
  assert.deepEqual(pageFacts("", "plain").marks, []);
});

test("recorded good run: both sales read back on both pool RPCs, the helper's route refuses a malformed sale: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad run: the sold holdings' buys named as sales: FAIL", async () => {
  const r = await run(A.bad_buys);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("a type 4 sell()")), bad(r).join("\n"));
});

test("made from the good run: each break FAILs", async () => {
  const cases = {
    "one RPC only": editRead(A.good, (x) => (x.rpc.includes("publicnode") ? withResult(x, () => null) : undefined)),
    reverted: editRead(A.good, receipt((r) => ({ ...r, status: "0x0" }))),
    "no Deposited": editRead(A.good, receipt((r) => ({ ...r, logs: r.logs.filter((l) => l.topics[0] !== DEPOSITED) }))),
    "a Deposited from another address": editRead(A.good, receipt((r) => ({ ...r, logs: r.logs.map((l) => (l.topics[0] === DEPOSITED ? { ...l, topics: [l.topics[0], "0x" + "00".repeat(12) + "11".repeat(20), ...l.topics.slice(2)] } : l)) }))),
    "another pool's Deposited": editRead(A.good, receipt((r) => ({ ...r, logs: r.logs.map((l) => (l.topics[0] === DEPOSITED ? { ...l, address: "0x00000000000000000000000000000000000f0011" } : l)) }))),
    "another block": editRead(A.good, receipt((r) => ({ ...r, blockNumber: "0x1" }))),
    "another chain id": editRead(A.good, txn((t) => ({ ...t, chainId: "0x1" }))),
    "a type 2 transaction": editRead(A.good, txn((t) => ({ ...t, type: "0x2" }))),
    "another sender": editRead(A.good, txn((t) => ({ ...t, from: "0x00000000000000000000000000000000000f0011" }))),
    "another delegate": editRead(A.good, txn((t) => ({ ...t, authorizationList: t.authorizationList.map((a) => ({ ...a, address: "0x00000000000000000000000000000000000f0011" })) }))),
    "an authorization for another chain": editRead(A.good, txn((t) => ({ ...t, authorizationList: t.authorizationList.map((a) => ({ ...a, chainId: "0x0" })) }))),
    "no authorization": editRead(A.good, txn((t) => ({ ...t, authorizationList: [] }))),
    "not sell()": editRead(A.good, txn((t) => ({ ...t, input: "0x3edadd79" + t.input.slice(10) }))),
    "another transaction": editRead(A.good, txn((t) => ({ ...t, hash: "0x" + "ef".repeat(32) }))),
    "helper sends it": { ...A.good, sends: A.good.sends.map((s) => ({ ...s, status: 200, body: JSON.stringify({ hash: "0x" + "ab".repeat(32) }) })) },
    "CORS *": { ...A.good, sends: A.good.sends.map((s) => ({ ...s, headers: { "access-control-allow-origin": "*" } })) },
    "one testnet": { ...A.good, txs: A.good.txs.slice(0, 1) },
    "not the pinned bundle": { ...A.good, page: { ...A.good.page, sha384: "sha384-other" } },
    "the EVM sell served on SIGN_HOST": { ...A.good, page: { ...A.good.page, marks: [...EVM_SELL_MARKS] } },
    "page not read": { ...A.good, page: undefined },
  };
  for (const [name, rec] of Object.entries(cases)) {
    const r = await run(rec);
    assert.equal(r.ok, false, `${name}: ${r.lines.join("\n")}`);
  }
});

test("a pool RPC with no answer leaves the run INCONCLUSIVE, never PASS; a wrong answer beside it is still FAIL", async () => {
  const quiet = editRead(A.good, (x) => (x.rpc.includes("pocket") ? { ...x, answer: { noAnswer: "base-testnet.api.pocket.network: HTTP 429" } } : undefined));
  const r = await run(quiet);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("NOTE [base-sepolia")));
  const both = editRead(quiet, receipt((rc) => ({ ...rc, status: "0x0" })));
  assert.equal((await run(both)).verdict, "FAIL");
});
