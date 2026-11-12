// node --test scripts/live-checks/signpage-evm-pool-buy.test.mjs: the live check replays recorded runs
// (signpage-evm-pool-buy.answers.json). good: the card's two buys read back on both pool RPCs of their chains, the
// helper's send route refusing a malformed buy from SIGN_HOST, and SIGN_HOST's mainnet bundle with the EVM buy beside its
// carry and no testnet pool: PASS.
// bad_deposits: the run's two deposits named as buys: FAIL. bad_testnet_page: the testnet build served on SIGN_HOST:
// FAIL. Made from the good run: a buy read back on one RPC only, a reverted receipt, a receipt with no Bought, another
// block, another pool, a helper that sends a malformed buy, a CORS echo of "*", one testnet missing, a bundle that is
// not the pinned one: each FAIL.
// Card evm-pools-on-mainnet: the good and bad_testnet_page answers' page parts are re-made from a local mainnet build (and the testnet
// build for a testnet page) of that card, which pins both EVM pools and keeps the kind closed there; re-recorded from
// SIGN_HOST at the next sign deploy. Card evm-buy-and-sell-on-mainnet re-made both page parts from its builds (the buy
// opens on mainnet beside its carry), and plants the bundle before it (no buy) and a buy with no carry: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RETRY } from "./provider-answer.mjs";
import { BOUGHT, EVM_BUY_MARKS, HELPER, PINS_OF, SIGN, TESTNET_POOL_MARKS, judge, pageFacts, read, txsOf } from "./signpage-evm-pool-buy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
RETRY.ms = 0;
const A = JSON.parse(readFileSync(path.join(HERE, "signpage-evm-pool-buy.answers.json"), "utf8"));
const RECORD = readFileSync(path.join(HERE, "signpage-evm-pool-buy.md"), "utf8");

// a fetch that answers each call with the recorded read for it, after checking the check asked the right thing
const replay = (run) => async (url, init) => {
  if (url.startsWith(SIGN)) return new Response("", { status: 200 }); // the page's facts are the recording's (rec.page)
  const body = JSON.parse(init.body);
  if (url === `${HELPER}/v1/pool/evm/send`) {
    assert.equal(init.method, "POST");
    assert.equal(init.headers.origin, SIGN);
    const s = run.sends.find((x) => PINS_OF[x.network] === body.pool);
    assert.ok(s, `a recorded send for ${body.pool}`);
    return new Response(s.body, { status: s.status, headers: s.headers["access-control-allow-origin"] ? { "access-control-allow-origin": s.headers["access-control-allow-origin"] } : {} });
  }
  assert.equal(init.method, "POST");
  const r = run.reads.find((x) => x.rpc === url && x.method === body.method && x.hash === body.params[0]);
  assert.ok(r, `a recorded read for ${url} ${body.method}`);
  if (r.answer.noAnswer !== undefined) return new Response("", { status: 429 });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...r.answer }), { status: 200 });
};
const mdOf = (run) => run.txs.map((t) => `Buy: ${t.network} ${t.hash}`).join("\n");
const run = async (rec) => judge({ ...(await read(mdOf(rec), replay(rec))), page: rec.page });
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const editRead = (rec, f) => ({ ...rec, reads: rec.reads.map((x, i) => f(x, i) ?? x) });
const withResult = (x, f) => ({ ...x, answer: { result: f(x.answer.result) } });
// a change to each receipt one pool RPC (PublicNode, one of each pair) reads
const receipt = (f) => (x) => (x.method === "eth_getTransactionReceipt" && x.rpc.includes("publicnode") ? withResult(x, f) : undefined);

test("the run record's Buy lines are the recorded good run's buys, and each is a Tx line too", () => {
  assert.deepEqual(txsOf(RECORD), A.good.txs);
  for (const t of A.good.txs) assert.ok(RECORD.includes(`Tx: ${t.network} ${t.hash}\n`));
});

test("pageFacts reads the index's pin, the bundle's sha384 and the EVM buy's marks", () => {
  const js = `x("${EVM_BUY_MARKS[0]}")`;
  const f = pageFacts('<script src="/app.js" integrity="sha384-AAAA"></script>', js);
  assert.equal(f.pin, "sha384-AAAA");
  assert.match(f.sha384, /^sha384-/);
  assert.deepEqual(f.marks, [EVM_BUY_MARKS[0]]);
  assert.deepEqual(pageFacts("", "plain").marks, []);
});

test("recorded good run: both buys read back on both pool RPCs, the helper's route refuses a malformed buy: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad run: the run's deposits named as buys: FAIL", async () => {
  const r = await run(A.bad_deposits);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("buy() to the pinned pool")));
});

test("recorded bad run: the testnet build, the EVM buy in it, served on SIGN_HOST: FAIL", async () => {
  const r = await run(A.bad_testnet_page);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), [`BAD [SIGN_HOST] the mainnet build carries the EVM buy beside its carry and no testnet pool: buy ${EVM_BUY_MARKS.join(", ")}; testnet ${A.bad_testnet_page.page.testnet.join(", ")}`]);
});

test("made from the good run: each break FAILs", async () => {
  const cases = {
    "one RPC only": editRead(A.good, (x) => (x.rpc.includes("publicnode") ? withResult(x, () => null) : undefined)),
    reverted: editRead(A.good, receipt((r) => ({ ...r, status: "0x0" }))),
    "no Bought": editRead(A.good, receipt((r) => ({ ...r, logs: r.logs.filter((l) => l.topics[0] !== BOUGHT) }))),
    "another block": editRead(A.good, receipt((r) => ({ ...r, blockNumber: "0x1" }))),
    "another pool": editRead(A.good, (x) => (x.method === "eth_getTransactionByHash" ? withResult(x, (t) => ({ ...t, to: "0x00000000000000000000000000000000000f0011" })) : undefined)),
    "another chain id": editRead(A.good, (x) => (x.method === "eth_getTransactionByHash" ? withResult(x, (t) => ({ ...t, chainId: "0x1" })) : undefined)),
    "another transaction": editRead(A.good, (x) => (x.method === "eth_getTransactionByHash" && x.rpc.includes("publicnode") ? withResult(x, (t) => ({ ...t, hash: "0x" + "ef".repeat(32) })) : undefined)),
    "another contract's Bought": editRead(A.good, receipt((r) => ({ ...r, logs: r.logs.map((l) => (l.topics[0] === BOUGHT ? { ...l, address: "0x00000000000000000000000000000000000f0011" } : l)) }))),
    "helper sends it": { ...A.good, sends: A.good.sends.map((s) => ({ ...s, status: 200, body: JSON.stringify({ hash: "0x" + "ab".repeat(32) }) })) },
    "CORS *": { ...A.good, sends: A.good.sends.map((s) => ({ ...s, headers: { "access-control-allow-origin": "*" } })) },
    "one testnet": { ...A.good, txs: A.good.txs.slice(0, 1) },
    "not the pinned bundle": { ...A.good, page: { ...A.good.page, sha384: "sha384-other" } },
    "the bundle before the buy opened": { ...A.good, page: { ...A.good.page, marks: [] } },
    "a buy with no carry": { ...A.good, page: { ...A.good.page, marks: ["uniswap-v4"] } },
    "a testnet pool": { ...A.good, page: { ...A.good.page, testnet: [TESTNET_POOL_MARKS[0]] } },
    "page not read": { ...A.good, page: undefined },
  };
  for (const [name, rec] of Object.entries(cases)) {
    const r = await run(rec);
    assert.equal(r.ok, false, `${name}: ${r.lines.join("\n")}`);
  }
});

test("a null for a recorded buy from one RPC (a load-balanced backend that lacks it, read live 2026-11-10 17:1xZ on Pocket) is read again: a later answer PASSes, nulls only leave the run INCONCLUSIVE, never FAIL or PASS", async () => {
  const nulls = (n) => {
    let left = n;
    const base = replay(A.good);
    return async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (url.includes("pocket") && body?.method === "eth_getTransactionReceipt" && left > 0) {
        left--;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), { status: 200 });
      }
      return base(url, init);
    };
  };
  const once = judge({ ...(await read(mdOf(A.good), nulls(1))), page: A.good.page });
  assert.equal(once.verdict, "PASS", once.lines.join("\n"));
  const always = judge({ ...(await read(mdOf(A.good), nulls(1_000))), page: A.good.page });
  assert.equal(always.verdict, "INCONCLUSIVE", always.lines.join("\n"));
});

test("a pool RPC with no answer leaves the run INCONCLUSIVE, never PASS; a wrong answer beside it is still FAIL", async () => {
  const quiet = editRead(A.good, (x) => (x.rpc.includes("pocket") ? { ...x, answer: { noAnswer: "base-testnet.api.pocket.network: HTTP 429" } } : undefined));
  const r = await run(quiet);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("NOTE [base-sepolia")));
  const both = editRead(quiet, receipt((rc) => ({ ...rc, status: "0x0" })));
  assert.equal((await run(both)).verdict, "FAIL");
});
