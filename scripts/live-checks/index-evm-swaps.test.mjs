// node --test scripts/live-checks/index-evm-swaps.test.mjs: the live check replays recorded answers
// (index-evm-swaps.answers.json). good: apps/helper at card helper-ready-page-warm run on a Mac against the real
// GeckoTerminal lists and Base providers, Base at its 200 ms blocks: PASS. bad_not_deployed: the deployed helper before
// card index-evm-swaps, 404 on every listed Base token's candles: FAIL. bad_base_2s_clock: the deployed helper once Base
// made 200 ms blocks (2026-11-05 18:00:01Z), 503 on every Base read: FAIL. Made from the good answer: a trade source that is the
// vendor, a candles answer with an extra field, a bar whose high is under its open, a tape oldest first, a stale read, no
// CORS echo, a trade time off Base's clock, a trade that is not on chain, a failed receipt, another sender, an amount the
// chain never moved, a swap on chain that the tape lacks, and a provider newest block far from now: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HEADER_TIMED, SWAP_RPCS, TOPIC } from "../../apps/helper/src/data/evm/swaps.ts";
import * as check from "./index-evm-swaps.mjs";
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
    // the pool read goes in spans of at most the chain's widest: each span's logs of the run
    const [lo, hi] = [Number.parseInt(req.params[0].fromBlock, 16), Number.parseInt(req.params[0].toBlock, 16)];
    assert.ok(lo >= c.poolLogs.from && hi <= c.poolLogs.to && lo <= hi, `${lo}..${hi} in ${c.poolLogs.from}..${c.poolLogs.to}`);
    return ok(c.poolLogs.logs.filter((l) => Number.parseInt(l.blockNumber, 16) >= lo && Number.parseInt(l.blockNumber, 16) <= hi));
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

test("the deployed helper on Base's old 2 s clock fails: every Base candles and trades read 503 once Base made 200 ms blocks (card helper-ready-page-warm)", () => {
  const r = run(A.bad_base_2s_clock);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("answers 503")), bad(r).join("\n"));
});

test("a trade timed by Base's old 2 s clock, not its block's own time, fails", () => {
  const rec = edit((r) => body(r, "trades", (b) => (b.trades[0].t_ms = (1686789347 + 2 * Number.parseInt(r.chain.receipts[b.trades[0].tx].blockNumber, 16)) * 1000)));
  assert.equal(run(rec).ok, false);
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

test("providers whose newest block is far from now fail, as do two that disagree by more than 50 blocks (10 s of Base's)", () => {
  assert.equal(run(edit((r) => (r.chain.heads = [r.chain.heads[0] - 1000, r.chain.heads[1] - 1000]))).ok, false);
  assert.equal(run(edit((r) => (r.chain.heads = [r.chain.heads[0], r.chain.heads[0] + 60]))).ok, false);
  assert.equal(run(edit((r) => (r.chain.heads = []))).ok, false);
});

test("units reads a decimal string into the token's smallest unit, or null past its decimals", () => {
  assert.equal(units("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(units("12", 6), 12_000_000n);
  assert.equal(units("0.0000001", 6), null);
});

// Robinhood (card index-evm-swaps-2): robinhood_good is apps/helper at the card branch run on a Mac against the real
// lists and Robinhood's keyless providers, PASS; robinhood_bad_not_deployed is the deployed helper before the card, 404
// on Robinhood candles and trades, FAIL. Made from the good answer: a trade time off its block's time on two providers,
// a block time the providers did not agree on, a swap after the oldest trade that the tape lacks: each FAIL.
test("Robinhood: the good answer passes and the deployed helper before this card fails", () => {
  const g = judge(A.robinhood_good);
  assert.ok(g.ok, bad(g).join("\n"));
  assert.equal(A.robinhood_good.net, "robinhood");
  assert.ok(g.lines.some((l) => /whose time on two providers/.test(l)));
  const b = judge(A.robinhood_bad_not_deployed);
  assert.equal(b.ok, false);
  assert.ok(bad(b).some((l) => /answers 404/.test(l)));
});

test("Robinhood: a trade time off its block's time, a block time not read on two providers, and a swap the tape lacks fail", () => {
  const off = structuredClone(A.robinhood_good);
  const t0 = JSON.parse(off.reads.trades.body);
  t0.trades[0].t_ms += 1000;
  off.reads.trades.body = JSON.stringify(t0);
  assert.ok(bad(judge(off)).some((l) => /whose time on two providers/.test(l)));

  const unread = structuredClone(A.robinhood_good);
  const n = Number.parseInt(unread.chain.receipts[JSON.parse(unread.reads.trades.body).trades[0].tx].blockNumber, 16);
  delete unread.chain.blockTimes[n];
  assert.equal(judge(unread).ok, false);

  const lacks = structuredClone(A.robinhood_good);
  const pl = lacks.chain.poolLogs;
  pl.logs.push({ blockNumber: `0x${pl.to.toString(16)}`, transactionHash: `0x${"ab".repeat(32)}`, t: Math.floor(Date.parse(lacks.readAt) / 1000) });
  assert.ok(bad(judge(lacks)).some((l) => /1 missing from the tape/.test(l)));
});

test("a lists answer that is not a 200 with lists is a BAD line naming the chain and the status, never a crash (card app-console-429: robinhood's 503 at 11:03:50Z exited 2)", async () => {
  for (const [status, body] of [[503, JSON.stringify({ error: { code: "upstream" } })], [429, JSON.stringify({ error: { code: "rate_limited" } })], [200, "not json"], [200, JSON.stringify({ lists: null })]]) {
    const asked = [];
    const fetchFn = async (url) => (asked.push(url), new Response(body, { status, headers: { "content-type": "application/json" } }));
    const r = judge(await read("https://helper.test", undefined, fetchFn, [], "robinhood"));
    assert.equal(r.ok, false);
    assert.deepEqual(bad(r), [`BAD GET /v1/market/lists?chain=robinhood answers ${status}${status === 200 ? " with no lists" : ""} (robinhood)`], r.lines.join("\n"));
    assert.deepEqual(asked, ["https://helper.test/v1/market/lists?chain=robinhood"], "nothing read past the lists");
  }
});

test("card helper-restart-fresh: Robinhood's pool logs are agreed on providers that log their block time: the chain's own RPC logs blockTimestamp 0x0 (read 2026-11-04 17:4xZ) and never pairs for them, wherever SWAP_RPCS puts it (live run 41871356171: 'blocks none to none')", async () => {
  const rec = A.robinhood_good;
  const c = rec.chain;
  // the rule, not a position (helper-robinhood-capacity fold 5 put the wide providers first and the chain's own RPC
  // last): the chain's own RPC is header-timed, at least two providers log their block time, and the header-timed one
  // is put second here, where the agreed read would pair it with the first if the check did not leave it out
  const CHAIN_RPC = "https://rpc.mainnet.chain.robinhood.com";
  assert.ok(SWAP_RPCS.robinhood.includes(CHAIN_RPC) && HEADER_TIMED.has(CHAIN_RPC), "the chain's own RPC is a provider, and header-timed");
  const timed = SWAP_RPCS.robinhood.filter((u) => !HEADER_TIMED.has(u));
  assert.ok(timed.length >= 2, "two providers that log their block time can pair");
  const rpcs = [timed[0], ...SWAP_RPCS.robinhood.filter((u) => HEADER_TIMED.has(u)), ...timed.slice(1)];
  assert.ok(HEADER_TIMED.has(rpcs[1]));
  const fetchFn = async (url, init) => {
    if (!rpcs.includes(url)) {
      const k = url.endsWith(CANDLES_PATH(rec.coin, "robinhood")) ? "candles" : "trades";
      return new Response(rec.reads[k].body, { status: rec.reads[k].status, headers: rec.reads[k].headers });
    }
    const req = JSON.parse(init.body);
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200 });
    if (req.method === "eth_blockNumber") return ok(hex(c.heads[Math.min(rpcs.indexOf(url), 1)]));
    if (req.method === "eth_call") return ok(`0x${c.decimals.toString(16).padStart(64, "0")}`);
    if (req.method === "eth_getTransactionReceipt") return ok(c.receipts[req.params[0]]);
    if (req.method === "eth_getBlockByNumber") return ok({ timestamp: hex(c.blockTimes[Number.parseInt(req.params[0], 16)]) });
    if (req.method === "eth_getLogs") {
      const lo = Number.parseInt(req.params[0].fromBlock, 16);
      const hi = Number.parseInt(req.params[0].toBlock, 16);
      const logs = c.poolLogs.logs.filter((l) => Number.parseInt(l.blockNumber, 16) >= lo && Number.parseInt(l.blockNumber, 16) <= hi);
      return ok(logs.map((l) => ({ blockNumber: l.blockNumber, transactionHash: l.transactionHash, blockTimestamp: HEADER_TIMED.has(url) ? "0x0" : hex(l.t) })));
    }
    assert.fail(req.method);
  };
  const again = await read("https://helper.test", rec.coin, fetchFn, rpcs, "robinhood");
  assert.deepEqual(again.chain.poolLogs, c.poolLogs, "the pool's logs, agreed by two providers that time them");
  again.readAt = rec.readAt;
  const r = judge(again);
  assert.deepEqual(bad(r), []);
});

// Card helper-robinhood-swaps: robinhood_bad_hooked_buys is the deployed helper at 0f3ce82 on 2026-11-04 20:14Z, the
// red of live run 41899807434 again on token 0xe23c6618..., whose v4 pool's hook (PonsV2MemeHook) takes 2.75% of a
// buy's token leg after the PoolManager logs Swap: the tape showed each buy's pool leg, which no Transfer moved, FAIL.
// robinhood_good_hooked is apps/helper at the card's fix (main merged) run on a Mac against Robinhood's keyless
// providers on a listed token of the same hook (0xe23c6618... had left the lists), its sample holding buys: every
// buy's amt is the token its buyer was sent, PASS.
test("card helper-robinhood-swaps: a hooked v4 pool's buys on the tape as the pool's leg fail; as the trader's leg they pass", () => {
  const b = judge(A.robinhood_bad_hooked_buys);
  assert.equal(b.ok, false);
  assert.equal(A.robinhood_bad_hooked_buys.coin, "0xe23c6618091c137f56d8486d25492311ccf33ab8");
  assert.deepEqual(bad(b).map((l) => l.replace(/\d+ of 5/, "n of 5").replace(/"[bs]+"/, "")), ["BAD n of 5 sampled trades carry a Transfer of the token for exactly their amt,  against the pool"], b.lines.join("\n"));
  assert.ok(b.lines.filter((l) => /^-- {2}trade 0x[0-9a-f]{8}: no Transfer of exactly [\d.]+ from the pool/.test(l)).length >= 3);
  const g = judge(A.robinhood_good_hooked);
  assert.ok(g.ok, bad(g).join("\n"));
  // both samples are of a pool whose hook took a cut: its HookFeeCollected logs are in their receipts
  const HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
  for (const rec of [A.robinhood_bad_hooked_buys, A.robinhood_good_hooked]) assert.ok(Object.values(rec.chain.receipts).some((r) => r.logs.some((l) => l.address === HOOK)), rec.coin);
  const sides = JSON.parse(A.robinhood_good_hooked.reads.trades.body).trades.slice(0, 5).map((t) => t.side);
  assert.ok(sides.filter((s) => s === "b").length >= 2, `the sample holds buys: ${sides.join("")}`);
  assert.ok(g.lines.includes(`ok  5 of 5 sampled trades carry a Transfer of the token for exactly their amt, ${JSON.stringify(sides.join(""))} against the pool`), g.lines.join("\n"));
});

test("card helper-deploy-reads-fast: a FAIL names each read the helper answered, its status, time and Server-Timing; a PASS prints none (made from the good answer in the shape of live run 42122733397 attempt 1: the judged token's candles 23 s after the read, two listed tokens tried before it)", () => {
  const late = edit((rec) => {
    const at = Date.parse(rec.reads.candles.headers["x-fetched-at"]);
    rec.readAt = new Date(at - 22_967).toISOString();
    rec.listsRead = { status: 200, ms: 160, headers: { "server-timing": "total;dur=1" } };
    rec.tried = [
      { token: "0x00000000000000000000000000000000000000a1", candles: { status: 503, ms: 12_004, headers: { "server-timing": 'evm-open;dur=12000, evm-queue;dur=9100;desc="14 posts: pace 6200 ms, in flight 2900 ms", total;dur=12001' } } },
      { token: "0x00000000000000000000000000000000000000a2", candles: { status: 200, ms: 5_610, headers: { "server-timing": 'evm-open;dur=5600, evm-queue;dur=4100;desc="6 posts: pace 4100 ms, in flight 0 ms", total;dur=5602' } }, trades: { status: 200, ms: 150, headers: {} } },
    ];
    rec.reads.candles.ms = 2_201;
    rec.reads.candles.headers["server-timing"] = 'evm-open;dur=2190, evm-queue;dur=1500;desc="3 posts: pace 1500 ms, in flight 0 ms", total;dur=2191';
  });
  const r = run(late);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.includes("candles X-Fetched-At")), bad(r).join("\n"));
  const reads = r.lines.filter((l) => l.startsWith("--  read:"));
  assert.deepEqual(reads, [
    '--  read: lists 200 in 160 ms, Server-Timing "total;dur=1"',
    '--  read: 0x00000000000000000000000000000000000000a1 before it: candles 503 in 12004 ms, Server-Timing "evm-open;dur=12000, evm-queue;dur=9100;desc=\\"14 posts: pace 6200 ms, in flight 2900 ms\\", total;dur=12001"',
    '--  read: 0x00000000000000000000000000000000000000a2 before it: candles 200 in 5610 ms, Server-Timing "evm-open;dur=5600, evm-queue;dur=4100;desc=\\"6 posts: pace 4100 ms, in flight 0 ms\\", total;dur=5602"; trades 200 in 150 ms, Server-Timing none',
    `--  read: ${late.coin} candles 200 in 2201 ms, Server-Timing "evm-open;dur=2190, evm-queue;dur=1500;desc=\\"3 posts: pace 1500 ms, in flight 0 ms\\", total;dur=2191"`,
    `--  read: ${late.coin} trades 200 in 1 ms, Server-Timing "total;dur=0"`,
  ]);
  // the same run on time passes, and prints no read lines
  const onTime = run({ ...late, readAt: A.good.readAt });
  assert.equal(onTime.ok, true, bad(onTime).join("\n"));
  assert.equal(onTime.lines.filter((l) => l.startsWith("--  read:")).length, 0);
});

test("card helper-deploy-reads-fast: read() keeps the lists read and each listed token tried before the judged one, with status, time and Server-Timing", async () => {
  const list = { lists: { new: [{ token: "0x00000000000000000000000000000000000000a1" }, { token: A.good.coin }] } };
  const fetchFn = async (url, init) => {
    if (url.endsWith("/v1/market/lists?chain=base")) return new Response(JSON.stringify(list), { status: 200, headers: { "server-timing": "total;dur=1" } });
    if (url.includes("0x00000000000000000000000000000000000000a1")) return new Response('{"error":{"code":"upstream"}}', { status: 503, headers: { "server-timing": 'evm-open;dur=12000, evm-queue;dur=9100;desc="14 posts: pace 6200 ms, in flight 2900 ms"' } });
    return replay(A.good)(url, init);
  };
  const got = await read("https://api.confidential.unrealized.trade", undefined, fetchFn);
  assert.equal(got.coin, A.good.coin);
  assert.deepEqual([got.listsRead.status, got.listsRead.headers["server-timing"]], [200, "total;dur=1"]);
  assert.equal(got.tried.length, 1);
  assert.deepEqual([got.tried[0].token, got.tried[0].candles.status, got.tried[0].candles.headers["server-timing"]], ["0x00000000000000000000000000000000000000a1", 503, 'evm-open;dur=12000, evm-queue;dur=9100;desc="14 posts: pace 6200 ms, in flight 2900 ms"']);
  assert.ok(Number.isFinite(got.tried[0].candles.ms));
});

const EP06 = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
const BUNDLER = A.bundle_base?.bundler ?? "0x4b5c33c3c7a31bd108f5a99b64683b0056a62226";
const word = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;

test("card helper-deploy-reads-fast fold: the recorded bundle (Base tx 0x672edabc, EntryPoint v0.6): its swaps' sender is the user operation's account, never the bundler", () => {
  assert.equal(typeof check.swapSenders, "function", "index-evm-swaps.mjs swapSenders");
  const b = A.bundle_base;
  const swap = (l) => [TOPIC.swap2, TOPIC.swap3, TOPIC.swap4, TOPIC.curveBuy, TOPIC.curveSell].includes(l.topics?.[0]);
  const got = check.swapSenders(b.receipt, swap);
  assert.deepEqual(got, { bundle: true, senders: [b.account] });
  assert.ok(!got.senders.includes(b.bundler), "the bundler named");
  // a swap before the EntryPoint's BeforeExecution is validation, in no operation's run
  const [mark, ...rest] = b.receipt.logs;
  const swaps = rest.filter(swap);
  assert.ok(swaps.length > 0 && mark.topics[0].startsWith("0xbb47ee3e"));
  assert.deepEqual(check.swapSenders({ ...b.receipt, logs: [...swaps, mark, rest.at(-1)] }, swap).senders, []);
  // a UserOperationEvent logged by another contract marks nothing
  assert.deepEqual(check.swapSenders({ ...b.receipt, logs: [mark, ...swaps, { ...rest.at(-1), address: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae" }] }, swap).senders, []);
  // the same logs sent by an ordinary transaction: its sender
  assert.deepEqual(check.swapSenders({ ...b.receipt, to: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae" }, swap), { bundle: false, senders: [b.bundler] });
});

/** The good run with its first sampled trade's receipt made a bundle to EntryPoint v0.6: the bundler sends it, the
 *  trade's own logs sit in one user operation's run (BeforeExecution before them, its UserOperationEvent naming the
 *  trade's trader after), as Base tx 0x672edabc logged them. `trader` names who the tape says traded. */
const bundled = (trader) =>
  edit((rec) => {
    const tape = JSON.parse(rec.reads.trades.body).trades;
    const t0 = tape[0];
    const r = rec.chain.receipts[t0.tx];
    const ev = A.bundle_base.receipt.logs;
    const before = ev.find((l) => l.topics[0].startsWith("0xbb47ee3e"));
    const uoe = ev.find((l) => l.topics[0].startsWith("0x49628fd1"));
    r.logs = [before, ...r.logs, { ...uoe, topics: [uoe.topics[0], uoe.topics[1], word(t0.trader), uoe.topics[3]] }];
    r.from = BUNDLER;
    r.to = EP06;
    body(rec, "trades", (b) => (b.trades[0].trader = trader === "bundler" ? BUNDLER : t0.trader));
  });

test("card helper-deploy-reads-fast fold: a sampled bundle trade named by its user operation's account passes; named by the bundler (the receipt's from) it fails", () => {
  const good = run(bundled("account"));
  assert.deepEqual(bad(good), []);
  assert.ok(good.lines.some((l) => l.includes("the account of the user operation whose run holds its swap")));
  const wrong = run(bundled("bundler"));
  assert.equal(wrong.ok, false);
  assert.ok(bad(wrong).some((l) => l.includes(`sent by "${BUNDLER}"`)), bad(wrong).join("\n"));
});
