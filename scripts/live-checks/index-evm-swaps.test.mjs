// node --test scripts/live-checks/index-evm-swaps.test.mjs: the live check replays recorded answers
// (index-evm-swaps.answers.json). good: apps/helper at the card branch run on a Mac against the real GeckoTerminal lists
// and Base providers (the deployed helper has no Base candles yet): PASS. bad_not_deployed: the deployed helper before
// this card, 404 on every listed Base token's candles: FAIL. Made from the good answer: a trade source that is the
// vendor, a candles answer with an extra field, a bar whose high is under its open, a tape oldest first, a stale read, no
// CORS echo, a trade time off Base's clock, a trade that is not on chain, a failed receipt, another sender, an amount the
// chain never moved, a swap on chain that the tape lacks, and a provider newest block far from now: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SWAP_RPCS } from "../../apps/helper/src/data/evm/swaps.ts";
import { candlesFault, CANDLES_PATH, judge, read, TRADES_PATH, tradesFault, units } from "./index-evm-swaps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "index-evm-swaps.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const hex = (n) => `0x${n.toString(16)}`;

/** A fetch that answers the recorded run: the helper's two reads, and the providers' replies built from run.chain. */
const replay = (run) => async (url, init) => {
  if (url.startsWith("https://api.confidential.unrealized.trade")) {
    assert.equal(init.headers.origin, "https://confidential.unrealized.trade");
    const k = url.endsWith(CANDLES_PATH(run.coin)) ? "candles" : url.endsWith(TRADES_PATH(run.coin)) ? "trades" : null;
    assert.ok(k, url);
    return new Response(run.reads[k].body, { status: run.reads[k].status, headers: run.reads[k].headers });
  }
  const i = SWAP_RPCS.base.indexOf(url);
  assert.ok(i >= 0, url);
  const req = JSON.parse(init.body);
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200 });
  const c = run.chain;
  if (req.method === "eth_blockNumber") return ok(hex(c.heads[i]));
  if (req.method === "eth_call") return ok(`0x${c.decimals.toString(16).padStart(64, "0")}`);
  if (req.method === "eth_getTransactionReceipt") return ok(c.receipts[req.params[0]]);
  if (req.method === "eth_getLogs") {
    assert.equal(req.params[0].fromBlock, hex(c.poolLogs.from));
    assert.equal(req.params[0].toBlock, hex(c.poolLogs.to));
    return ok(c.poolLogs.logs);
  }
  assert.fail(req.method);
};
const run = (rec) => judge(rec);
const edit = (fn) => {
  const rec = structuredClone(A.good);
  fn(rec);
  return rec;
};
const body = (rec, k, fn) => {
  const b = JSON.parse(rec.reads[k].body);
  fn(b);
  rec.reads[k].body = JSON.stringify(b);
};

test("the good answer passes", () => {
  const r = run(A.good);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
  assert.ok(r.lines.length > 25);
  assert.ok(r.lines.some((l) => /swap transactions? of the pool/.test(l) && l.includes("0 missing")));
});

test("read() asks the helper and the providers what the check judges: the replay of the good run passes with the same lines", async () => {
  const again = await read("https://api.confidential.unrealized.trade", A.good.coin, replay(A.good));
  again.readAt = A.good.readAt;
  for (const k of ["candles", "trades"]) delete again.reads[k].ms;
  assert.deepEqual(again.chain, A.good.chain);
  assert.deepEqual(judge(again).lines, judge(A.good).lines);
});

test("the deployed helper before this card fails", async () => {
  const r = run(A.bad_not_deployed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).length >= 2);
});

test("a source that is not our own reads fails", () => {
  const rec = edit((r) => (r.reads.trades.headers["x-helper-source"] = "geckoterminal"));
  assert.equal(run(rec).ok, false);
  assert.ok(bad(run(rec)).some((l) => l.includes("X-Helper-Source")));
  const rec2 = edit((r) => (r.reads.candles.headers["x-helper-source"] = "geckoterminal"));
  assert.equal(run(rec2).ok, false);
});

test("wire faults fail: an extra candles field, a missing own_from_s, a bar whose high is under its open, a bar off the minute, a bar not after the one before", () => {
  for (const [what, fn] of [
    ["extra field", (b) => (b.mc_usd = "1")],
    ["no own_from_s", (b) => delete b.own_from_s],
    ["high under open", (b) => (b.candles[0][2] = "0")],
    ["off the minute", (b) => (b.candles[0][0] += 1)],
    ["order", (b) => b.candles.push(b.candles.at(-1))],
    ["tf", (b) => (b.tf = "5m")],
  ]) {
    const rec = edit((r) => body(r, "candles", fn));
    assert.equal(run(rec).ok, false, what);
  }
  assert.equal(candlesFault(JSON.parse(A.good.reads.candles.body)), null);
});

test("tape faults fail: oldest first, a bad side, an extra field, a trader that is not an address, a tape over 50", () => {
  for (const [what, fn] of [
    ["oldest first", (b) => b.trades.reverse()],
    ["side", (b) => (b.trades[0].side = "x")],
    ["extra field", (b) => (b.trades[0].pool = "0x")],
    ["trader", (b) => (b.trades[0].trader = "bob")],
    ["over 50", (b) => (b.trades = Array.from({ length: 51 }, () => b.trades[0]))],
    ["empty", (b) => (b.trades = [])],
  ]) {
    const rec = edit((r) => body(r, "trades", fn));
    assert.equal(run(rec).ok, false, what);
  }
  assert.equal(tradesFault(JSON.parse(A.good.reads.trades.body)), null);
});

test("a stale read and a missing CORS echo fail", () => {
  assert.equal(run(edit((r) => (r.reads.trades.headers["x-fetched-at"] = "2026-11-03T17:00:00.000Z"))).ok, false);
  assert.equal(run(edit((r) => delete r.reads.candles.headers["access-control-allow-origin"])).ok, false);
  assert.equal(run(edit((r) => (r.reads.candles.headers["x-helper-commit"] = "dev"))).ok, false);
});

test("the chain disagrees: a trade time off Base's clock, no receipt, a failed receipt, another sender, an amount never moved, another side", () => {
  const first = (r) => JSON.parse(r.reads.trades.body).trades[0];
  for (const [what, fn] of [
    ["time", (r) => body(r, "trades", (b) => (b.trades[0].t_ms += 2000))],
    ["no receipt", (r) => (r.chain.receipts[first(r).tx] = null)],
    ["failed", (r) => (r.chain.receipts[first(r).tx].status = "0x0")],
    ["sender", (r) => (r.chain.receipts[first(r).tx].from = "0x000000000000000000000000000000000000dead")],
  ]) {
    const rec = edit(fn);
    assert.equal(run(rec).ok, false, what);
  }
  // every sampled trade's amount altered, or its side flipped: no Transfer of the token to or from the pool matches
  assert.equal(run(edit((r) => body(r, "trades", (b) => b.trades.forEach((t) => (t.amt = `${t.amt}1`))))).ok, false, "amount");
  assert.equal(run(edit((r) => body(r, "trades", (b) => b.trades.forEach((t) => (t.side = t.side === "b" ? "s" : "b"))))).ok, false, "side");
});

test("a swap on chain that the tape lacks fails, and so does a pool whose Swap logs could not be read", () => {
  const extra = edit((r) => r.chain.poolLogs.logs.push({ blockNumber: hex(r.chain.poolLogs.to), transactionHash: `0x${"99".repeat(32)}` }));
  const r = run(extra);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("1 missing")));
  assert.equal(run(edit((r) => (r.chain.poolLogs = null))).ok, false);
  const dropped = edit((r) => body(r, "trades", (b) => b.trades.splice(1, 1)));
  assert.equal(run(dropped).ok, false, "a trade missing from the tape");
});

test("providers whose newest block is far from now fail, as do two that disagree by more than 10 blocks", () => {
  assert.equal(run(edit((r) => (r.chain.heads = [r.chain.heads[0] - 1000, r.chain.heads[1] - 1000]))).ok, false);
  assert.equal(run(edit((r) => (r.chain.heads = [r.chain.heads[0], r.chain.heads[0] + 50]))).ok, false);
  assert.equal(run(edit((r) => (r.chain.heads = []))).ok, false);
});

test("units reads a decimal string into the token's smallest unit, or null past its decimals", () => {
  assert.equal(units("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(units("12", 6), 12_000_000n);
  assert.equal(units("0.0000001", 6), null);
});
