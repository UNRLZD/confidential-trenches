// node --test scripts/live-checks/index-evm-swaps.test.mjs: the live check replays recorded answers
// (index-evm-swaps.answers.json). good: apps/helper at card helper-ready-page-warm run on a Mac against the real
// GeckoTerminal lists and Base providers, Base at its 200 ms blocks: PASS. bad_not_deployed: the deployed helper before
// card index-evm-swaps, 404 on every listed Base token's candles: FAIL. bad_base_2s_clock: the deployed helper once Base
// made 200 ms blocks (2026-11-05 18:00:01Z), 503 on every Base read: FAIL. Made from the good answer: a trade source that is the
// vendor, a candles answer with an extra field, a bar whose high is under its open, a tape oldest first, a stale read, no
// CORS echo, a trade time off Base's clock, a trade that is not on chain, a failed receipt, another sender, an amount the
// chain never moved, a swap on chain that the tape lacks, and a provider newest block far from now: each FAIL.
// good_per_read, robinhood_good_per_read (card helper-restart-fresh): the deployed helper read at 2026-11-06 06:51Z with
// each answer's request time and the heads' read time: PASS; made from the good answers in the shape of live run
// 42163488602 (the judged token read 20.6 s into the run): PASS, and a stale, a future-dated or a late-heads read: FAIL.
// robinhood_routed_v4 (card index-evm-swaps-check-reads-the-pool-leg): live run 42908764691's two routed v4 trades, no
// Transfer of their amt in either receipt, each its pool's own Swap leg: PASS; an amt one unit off the leg, a sender's
// one swap whose Transfer does not match, two providers' differing legs: each FAIL by name.
// penny_two_pools (card helper-live-run-green-after-122): the deployed helper's PENNY tape, its side pool's, every sampled
// trade a route through two of the token's pools: judged on the busier over the window, a FAIL or a PASS by which is busier.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HEADER_TIMED, SWAP_RPCS, TOPIC } from "../../apps/helper/src/data/evm/swaps.ts";
import * as check from "./index-evm-swaps.mjs";
import { candlesFault, CANDLES_PATH, judge, read, TRADES_PATH, tradesFault, units } from "./index-evm-swaps.mjs";
import { candlesReader } from "./candles-read.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "index-evm-swaps.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const hex = (n) => `0x${n.toString(16)}`;

/** A fetch that answers the recorded run: the helper's two reads, and the providers' replies built from run.chain. */
const replay = (run) => async (url, init) => {
  if (url.startsWith("https://ct-api.unrealized.trade")) {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
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
/** A replayed run judged as its recording: the replay's own read times (now) dropped where the recording has none, so
 *  both are judged against the recording's start. */
const asRecorded = (again, rec) => {
  again.readAt = rec.readAt;
  for (const k of Object.keys(again.reads)) if (rec.reads?.[k]?.at === undefined) delete again.reads[k].at;
  if (rec.chain?.headsAt === undefined) delete again.chain.headsAt;
  return again;
};
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
  const again = asRecorded(await read("https://ct-api.unrealized.trade", A.good.coin, replay(A.good)), A.good);
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
  // a tape still filling carries `filling: true` between trades and src; any other value or place is a fault
  const g = JSON.parse(A.good.reads.trades.body);
  assert.equal(tradesFault({ trades: g.trades, filling: true, src: g.src, as_of_ms: g.as_of_ms }), null);
  assert.match(tradesFault({ trades: g.trades, filling: 1, src: g.src, as_of_ms: g.as_of_ms }), /keys/);
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
  const again = asRecorded(await read("https://helper.test", rec.coin, fetchFn, rpcs, "robinhood"), rec);
  assert.deepEqual(again.chain.poolLogs, c.poolLogs, "the pool's logs, agreed by two providers that time them");
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
  // the buy whose sender's move is read fails by its pool leg less the hook's cut; the run by the Transfers asked
  assert.deepEqual(bad(b).map((l) => l.replace(/\d+ of 5/, "n of 5").replace(/"[bs]+"/, "")), ["BAD trade 0xe07604eb: amt 500967.19699094996313226 is not the 487190.599073698839146124 its sender, whose one swap this is, moved with the PoolManager (a Transfer or claims of the token; this pool's Swap leg 500967.19699094996313226, read on two providers)", "BAD n of 5 sampled trades carry a Transfer of the token for exactly their amt,  against the pool"], b.lines.join("\n"));
  assert.ok(b.lines.filter((l) => /^-- {2}trade 0x[0-9a-f]{8}: no Transfer of exactly [\d.]+ from the pool/.test(l)).length >= 3);
  const g = judge(A.robinhood_good_hooked);
  assert.ok(g.ok, bad(g).join("\n"));
  // both samples are of a pool whose hook took a cut: its HookFeeCollected logs are in their receipts
  const HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
  for (const rec of [A.robinhood_bad_hooked_buys, A.robinhood_good_hooked]) assert.ok(Object.values(rec.chain.receipts).some((r) => r.logs.some((l) => l.address === HOOK)), rec.coin);
  const sides = JSON.parse(A.robinhood_good_hooked.reads.trades.body).trades.slice(0, 5).map((t) => t.side);
  assert.ok(sides.filter((s) => s === "b").length >= 2, `the sample holds buys: ${sides.join("")}`);
  // its two routed buys (0x8b878e95, 0x18df736c: the router swaps more than once) are judged by their pool's leg less
  // the hook's take; the three of a sender's one swap are asked their Transfer
  const asked = sides.filter((_, i) => i !== 3 && i !== 4).join("");
  assert.ok(g.lines.includes(`ok  3 of 3 sampled trades carry a Transfer of the token for exactly their amt, ${JSON.stringify(asked)} against the pool; 2 routed v4 trades judged by the pool's Swap leg alone`), g.lines.join("\n"));
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
  const got = await read("https://ct-api.unrealized.trade", undefined, fetchFn);
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

/** Card helper-restart-fresh: `rec` read in the shape of live run 42163488602 (6 Nov 04:36Z, straight after a restart):
 *  the run began with the lists, a cold token's not-ready 503 at 12.1 s and ten quiet tokens, so the judged token's
 *  candles were sent 20.6 s into the run and answered in 2903 ms, dated 2.85 s after their request, the trades 104 ms
 *  after, and the providers' heads read after them. */
const restartShape = (rec) => {
  const r = structuredClone(rec);
  const fetched = Date.parse(r.reads.candles.headers["x-fetched-at"]);
  const sent = fetched - 2_850;
  r.reads.candles = { ...r.reads.candles, at: new Date(sent).toISOString(), ms: 2_903 };
  r.reads.trades = { ...r.reads.trades, at: new Date(sent + 2_903).toISOString(), ms: 104 };
  r.reads.trades.headers = { ...r.reads.trades.headers, "x-fetched-at": r.reads.candles.headers["x-fetched-at"] };
  r.chain.headsAt = new Date(sent + 2_903 + 104 + 300).toISOString();
  r.readAt = new Date(sent - 20_636).toISOString();
  r.listsRead = { status: 200, ms: 514, headers: { "server-timing": undefined } };
  r.tried = [{ token: "0xb2000000000000000000008b6fd82bcbd9e97bb2", candles: { status: 503, ms: 12_108, headers: { "server-timing": 'evm-open;dur=12000, evm-queue;dur=0;desc="0 posts: pace 0 ms, in flight 0 ms"' } } }];
  return r;
};

test("card helper-restart-fresh: each answer, and the providers' heads, are judged by their own read, not the run's start: the judged token read 20.6 s into a run straight after a restart (live run 42163488602: a cold token's 503 at 12.1 s and ten quiet tokens before it), its answers fresh at their read, PASSES on Base and on Robinhood", () => {
  for (const rec of [A.good, A.robinhood_good]) {
    const r = run(restartShape(rec));
    assert.deepEqual(bad(r), [], `${rec.net ?? "base"}\n${r.lines.join("\n")}`);
    assert.ok(r.lines.some((l) => /^ok {2}candles X-Fetched-At: .*, within 15 s of its read at .* \(answered in 2903 ms\)$/.test(l)), r.lines.join("\n"));
    assert.ok(r.lines.some((l) => /^ok {2}the providers' newest block's time.* within 20 s of their read at /.test(l)), r.lines.join("\n"));
  }
});

test("card helper-restart-fresh: judged by its own read, an answer whose X-Fetched-At is 16 s before its request FAILs though it is within 15 s of the run's start; one dated after it arrived (past SKEW_MS) FAILs; heads read 45 s after their block's time FAIL", () => {
  const late = (rec, fn) => {
    const r = restartShape(rec);
    fn(r);
    return r;
  };
  // the stale answer: sent 20.6 s into the run, dated 16 s before it (4.6 s after the run began)
  const stale = late(A.good, (r) => {
    const at = new Date(Date.parse(r.reads.candles.at) - 16_000).toISOString();
    for (const k of ["candles", "trades"]) r.reads[k].headers = { ...r.reads[k].headers, "x-fetched-at": at };
  });
  assert.deepEqual(bad(run(stale)).map((l) => l.split(":")[0]), ["BAD candles X-Fetched-At", "BAD trades X-Fetched-At"]);
  // dated 3 s after the answer arrived
  const ahead = late(A.good, (r) => {
    const at = new Date(Date.parse(r.reads.trades.at) + r.reads.trades.ms + check.SKEW_MS + 1_000).toISOString();
    r.reads.trades.headers = { ...r.reads.trades.headers, "x-fetched-at": at };
  });
  assert.deepEqual(bad(run(ahead)).map((l) => l.split(":")[0]), ["BAD trades X-Fetched-At"]);
  // the heads read 45 s after the recording's start, near which their block's time is
  for (const rec of [A.good, A.robinhood_good]) {
    const old = late(rec, (r) => (r.chain.headsAt = new Date(Date.parse(rec.readAt) + 45_000).toISOString()));
    assert.deepEqual(bad(run(old)).map((l) => l.replace(/ at .*$/, "")), [`BAD the providers' newest block's time${rec.net === "robinhood" ? ", read on two providers," : " is on Base's clock and"} within 20 s of their read`], rec.net);
  }
});

test("card helper-restart-fresh: read() dates each answer by its own request and the heads by their read", async () => {
  const before = Date.now();
  const got = await read("https://ct-api.unrealized.trade", A.good.coin, replay(A.good));
  const after = Date.now();
  for (const k of ["candles", "trades"]) {
    const t = Date.parse(got.reads[k].at);
    assert.ok(t >= before && t <= after && Number.isSafeInteger(got.reads[k].ms), k);
  }
  assert.ok(Date.parse(got.reads.candles.at) <= Date.parse(got.reads.trades.at));
  assert.ok(Date.parse(got.chain.headsAt) >= Date.parse(got.reads.trades.at) && Date.parse(got.chain.headsAt) <= after);
});

test("card helper-restart-fresh: good_per_read and robinhood_good_per_read, the deployed helper read with each answer's own request time and the heads' read time, PASS; with the run's start set 20 s before their first read they still PASS, and FAIL only once their reads' own times are dropped", () => {
  for (const rec of [A.good_per_read, A.robinhood_good_per_read]) {
    assert.ok(typeof rec.reads.candles.at === "string" && typeof rec.chain.headsAt === "string", "recorded per read");
    const r = run(rec);
    assert.deepEqual(bad(r), [], r.lines.join("\n"));
    // the run's start set 20 s before its first read: each answer is judged by its own read, so it still passes
    const early = structuredClone(rec);
    early.readAt = new Date(Date.parse(rec.reads.candles.at) - 20_000).toISOString();
    assert.deepEqual(bad(run(early)), []);
    // with its reads' times dropped (judged by that start, as before this card) it fails
    for (const k of ["candles", "trades"]) delete early.reads[k].at;
    delete early.chain.headsAt;
    assert.ok(bad(run(early)).some((l) => l.includes("X-Fetched-At")), rec.net ?? "base");
  }
});

// Card index-evm-swaps-check-reads-the-pool-leg: robinhood_routed_v4 is live run 42908764691's Robinhood read (helper
// 2736dbef): its two trades are routers' v4 routes whose swaps net the token inside the PoolManager, so no Transfer of
// the token is either trade's. Main's check (2736dbef) FAILs them ("0 of 2 sampled trades carry a Transfer"); judged by
// their pool's own Swap leg they PASS. Made from it and from robinhood_good: a tape amount one unit off the pool's leg,
// a sender's one swap whose Transfer does not match, and two providers whose receipts give the pool different legs:
// each FAILs, naming the trade and the fault.
const routed = () => structuredClone(A.robinhood_routed_v4);
const ROUTED_POOL = "0x8366a39cc670b4001a1121b8f6a443a643e40951:0x1fa1e9b5a8b2101da19bcc91428885ff92b35028c5e9400267f504dd0d7c12a2";
const BUY = "0x2c7930a7f2ff1c0731505eaa43afa5b6c7cd217a75a299a59ef7c202df39439f";
const SELL = "0xcdc53645a2b06c7193110bedc56423e1301acbd8ab3c0b6b25d44df498067fb4";

test("card index-evm-swaps-check-reads-the-pool-leg: live run 42908764691's two routed v4 trades PASS, each its pool's own Swap leg; main's check failed them for want of a Transfer", () => {
  const rec = A.robinhood_routed_v4;
  assert.deepEqual(JSON.parse(rec.reads.trades.body).trades.map((t) => [t.tx, t.side, t.amt]), [
    [SELL, "s", "106651.292978592276941884"],
    [BUY, "b", "476.842127889091326311"],
  ]);
  // neither receipt holds a Transfer of the token for its trade's amt: the PoolManager nets each route
  for (const [tx, amt] of [[SELL, 106651292978592276941884n], [BUY, 476842127889091326311n]]) assert.ok(!rec.chain.receipts[tx].logs.some((l) => l.address === rec.coin && l.topics[0] === TOPIC.transfer && BigInt(l.data) === amt), tx);
  const r = judge(rec);
  assert.deepEqual(bad(r), [], r.lines.join("\n"));
  assert.equal(r.ok, true);
  assert.ok(r.lines.includes(`ok  the sampled trades share a pool: ${JSON.stringify([ROUTED_POOL])}`));
  assert.ok(r.lines.includes("ok  trade 0xcdc53645: amt 106651.292978592276941884 is this pool's Swap leg 106651.292978592276941884, read on two providers (its sender's 8 swaps net the token in the PoolManager)"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  trade 0x2c7930a7: amt 476.842127889091326311 is this pool's Swap leg 476.842127889091326311, read on two providers (its sender's 3 swaps net the token in the PoolManager)"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  no sampled trade is asked a Transfer of the token for its amt: 2 routed v4 trades judged by the pool's Swap leg alone"));
  assert.ok(!r.lines.some((l) => /fee on transfer/.test(l)));
});

test("card index-evm-swaps-check-reads-the-pool-leg: a tape amount one unit off its pool's Swap leg FAILs, named, on a buy and on a sell", () => {
  for (const [i, amt, line] of [
    [1, "476.842127889091326312", "BAD trade 0x2c7930a7: amt 476.842127889091326312 is not this pool's Swap leg 476.842127889091326311, read on two providers, nor that leg less one take of the token out of the PoolManager by an address that sent no swap (its sender's 3 swaps net the token in the PoolManager)"],
    [0, "106651.292978592276941883", "BAD trade 0xcdc53645: amt 106651.292978592276941883 is not this pool's Swap leg 106651.292978592276941884, read on two providers, nor that leg less one take of the token out of the PoolManager by an address that sent no swap (its sender's 8 swaps net the token in the PoolManager)"],
  ]) {
    const rec = routed();
    body(rec, "trades", (b) => (b.trades[i].amt = amt));
    const r = judge(rec);
    assert.equal(r.ok, false);
    assert.deepEqual(bad(r), [line], r.lines.join("\n"));
  }
});

test("card index-evm-swaps-check-reads-the-pool-leg: a sender's one swap whose Transfer does not match its amt FAILs, named (one unit less, and one unit more than the pool's leg)", () => {
  const first = JSON.parse(A.robinhood_good.reads.trades.body).trades[0];
  assert.equal(first.side, "s");
  for (const [delta, line] of [
    // a seller that paid less than the pool took: no hook's cut, a wrong leg
    [-1n, `BAD trade ${first.tx.slice(0, 10)}: its sender's move of the token with the PoolManager, 1500860.40017870957016451, is less than this pool's Swap leg ${first.amt}, read on two providers`],
    // a seller that paid more: the amt is not what it paid
    [1n, `BAD trade ${first.tx.slice(0, 10)}: amt ${first.amt} is not the 1500860.400178709570164512 its sender, whose one swap this is, moved with the PoolManager (a Transfer or claims of the token; this pool's Swap leg ${first.amt}, read on two providers)`],
  ]) {
    const rec = structuredClone(A.robinhood_good);
    const rc = rec.chain.receipts[first.tx];
    // the sell's Transfer of the token to the PoolManager
    const l = rc.logs.find((x) => x.address === rec.coin && x.topics[0] === TOPIC.transfer && BigInt(x.data) === units(first.amt, rec.chain.decimals));
    assert.ok(l, "the sell's Transfer");
    l.data = `0x${(BigInt(l.data) + delta).toString(16).padStart(64, "0")}`;
    const r = judge(rec);
    assert.equal(r.ok, false);
    assert.deepEqual(bad(r), [line], r.lines.join("\n"));
    assert.ok(r.lines.includes(`--  trade ${first.tx.slice(0, 10)}: no Transfer of exactly ${first.amt} to the pool`));
  }
});

test("card index-evm-swaps-check-reads-the-pool-leg: two providers whose receipts give the pool different Swap legs FAIL, naming both legs; receipts that differ elsewhere FAIL as differing", () => {
  const rec = routed();
  const a = rec.chain.receipts[BUY];
  const b = structuredClone(a);
  const s = b.logs.find((l) => l.topics[0] === TOPIC.swap4 && l.topics[1] === ROUTED_POOL.split(":")[1]);
  // amount1, the token's leg of this buy: one unit more on the second provider
  s.data = `${s.data.slice(0, 66)}${(BigInt(`0x${s.data.slice(66, 130)}`) + 1n).toString(16).padStart(64, "0")}${s.data.slice(130)}`;
  rec.chain.receipts[BUY] = { differ: [a, b] };
  const r = judge(rec);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD trade 0x2c7930a7: this pool's Swap leg differs on the two providers: 476.842127889091326311 on one, 476.842127889091326312 on the other"], r.lines.join("\n"));
  const other = routed();
  const c = structuredClone(other.chain.receipts[BUY]);
  c.status = "0x0";
  other.chain.receipts[BUY] = { differ: [other.chain.receipts[BUY], c] };
  assert.deepEqual(bad(judge(other)), ["BAD trade 0x2c7930a7: the two providers' receipts differ"]);
});

test("card index-evm-swaps-check-reads-the-pool-leg: read() keeps both receipts when two providers answer and differ, and the run FAILs naming the pool's two legs", async () => {
  const rec = A.good;
  const t0 = JSON.parse(rec.reads.trades.body).trades[0];
  const tx = t0.tx;
  const second = structuredClone(rec.chain.receipts[tx]);
  const s = second.logs.find((l) => l.topics[0] === TOPIC.swap4 && `${l.address}:${l.topics[1]}` === "0x498581ff718922c3f8e6a244956af099b2652b2b:0x943fceb1290dfe98944bc71d7780ce8fc9d233b6f0e2e72a4a32e8631594ed91");
  // the token's word of the Swap (a buy's: the amt, positive), one unit more on the second provider
  const k = [0, 1].find((i) => BigInt(`0x${s.data.slice(2 + 64 * i, 66 + 64 * i)}`) === units(t0.amt, rec.chain.decimals));
  assert.ok(k !== undefined && t0.side === "b");
  s.data = `0x${s.data.slice(2, 2 + 64 * k)}${(units(t0.amt, rec.chain.decimals) + 1n).toString(16).padStart(64, "0")}${s.data.slice(66 + 64 * k)}`;
  const base = replay(rec);
  const fetchFn = async (url, init) => {
    const req = init?.body ? JSON.parse(init.body) : null;
    if (req?.method === "eth_getTransactionReceipt" && req.params[0] === tx && SWAP_RPCS.base.indexOf(url) === 1) return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: second }), { status: 200 });
    return base(url, init);
  };
  const again = asRecorded(await read("https://ct-api.unrealized.trade", rec.coin, fetchFn), rec);
  assert.deepEqual(again.chain.receipts[tx], { differ: [rec.chain.receipts[tx], second] });
  const r = judge(again);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => l.startsWith(`BAD trade ${tx.slice(0, 10)}: this pool's Swap leg differs on the two providers: `)), r.lines.join("\n"));
});

// card evm-chart-opens-without-a-vendor-call: the candles read as the token page reads it (candles-read.mjs)
test("the candles read as the page reads it: a 429 that clears inside the span passes, with the replay's own lines", async () => {
  const clock = { t: 0 };
  const reader = candlesReader({ now: () => clock.t, wait: async (ms) => void (clock.t += ms) });
  let refused = 2;
  const base = replay(A.good);
  const fetchFn = async (url, init) => (url.endsWith(CANDLES_PATH(A.good.coin)) && refused-- > 0 ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : base(url, init));
  const again = asRecorded(await read("https://ct-api.unrealized.trade", A.good.coin, fetchFn, undefined, "base", reader), A.good);
  assert.deepEqual(again.reads.candles.waits, [30_000, 30_000]);
  assert.equal(again.reads.candles.status, 200);
  for (const k of ["candles", "trades"]) delete again.reads[k].ms;
  delete again.reads.candles.waits;
  assert.deepEqual(judge(again).lines, judge(A.good).lines);
});

test("a candles 429 still standing after the span fails, its waits named; an empty 200 fails", () => {
  const stood = edit((rec) => Object.assign(rec.reads.candles, { status: 429, body: '{"error":{"code":"rate_limited"}}', waits: [60_000, 15_000] }));
  assert.ok(bad(run(stood)).some((l) => l.includes("answers 429 after 75 s of reads at each Retry-After (60, 15 s)")), bad(run(stood)).join("\n"));
  const empty = edit((rec) => body(rec, "candles", (b) => (b.candles = [])));
  assert.ok(bad(run(empty)).some((l) => /candles: exactly the frozen fields in their wire forms: (keys|candles 0)/.test(l)), bad(run(empty)).join("\n"));
  const cleared = edit((rec) => (rec.reads.candles.waits = [30_000]));
  assert.deepEqual(bad(run(cleared)), [], "a 200 after a wait inside the span passes");
});

// A head one provider reported, which another does not hold yet (a null block by number: the pattern of release 116's
// sign live run 43024665974 on Base), is read again, and still unknown on the last read is INCONCLUSIVE naming the
// providers; two providers that hold it and differ still fail.
test("planted: a head no second provider knew yet is INCONCLUSIVE, named; a head time missing with no lag named still fails", () => {
  const head = A.robinhood_good.chain.heads[1];
  const edit = (f) => {
    const r = structuredClone(A.robinhood_good);
    f(r);
    return judge(r);
  };
  const lag = edit((r) => {
    delete r.chain.blockTimes[head];
    r.chain.behind = { [head]: ["robinhood-rpc.publicnode.com", "robinhood.api.pocket.network"] };
  });
  assert.equal(lag.verdict, "INCONCLUSIVE", lag.lines.join("\n"));
  assert.equal(lag.ok, false, "never a pass");
  assert.ok(lag.lines.some((l) => l === `--  the newest block ${head}: robinhood-rpc.publicnode.com and robinhood.api.pocket.network did not know it yet after 5 reads 2000 ms apart: INCONCLUSIVE`), lag.lines.join("\n"));
  assert.equal(edit((r) => delete r.chain.blockTimes[head]).verdict, "FAIL", "no time and no provider named");
  assert.equal(edit((r) => ((r.chain.behind = { [head]: ["x"] }), (r.chain.heads = [r.chain.heads[0] - 1000, r.chain.heads[1] - 1000]))).verdict, "FAIL", "a real FAIL beside it");
  assert.equal(judge(A.robinhood_good).verdict, "PASS");
});

test("headTime: a null block is read again; still null is the providers behind; two that differ name none", async () => {
  const rpcs = ["https://a.example", "https://b.example", "https://c.example"];
  const answers = (table) => async (url, init) => {
    const k = new URL(url).host;
    const v = table[k].length > 1 ? table[k].shift() : table[k][0];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: v }), { status: 200 });
  };
  const blk = (ts) => ({ number: "0x10", timestamp: ts });
  const waits = [];
  const sleep = async (ms) => void waits.push(ms);
  assert.deepEqual(await check.headTime(16, answers({ "a.example": [null, blk("0x5")], "b.example": [null, blk("0x5")], "c.example": [blk("0x5")] }), rpcs, 5, sleep), { ts: "0x5", behind: [] });
  assert.deepEqual(waits, [2_000]);
  waits.length = 0;
  assert.deepEqual(await check.headTime(16, answers({ "a.example": [null], "b.example": [null], "c.example": [blk("0x5")] }), rpcs, 5, sleep), { behind: ["a.example", "b.example"] });
  assert.equal(waits.length, 4);
  assert.deepEqual(await check.headTime(16, answers({ "a.example": [blk("0x5")], "b.example": [blk("0x6")], "c.example": [blk("0x5")] }), rpcs, 5, sleep), { behind: [] }, "two that differ");
});

// card helper-live-run-green-after-122: live run 43250937996 judged PENNY's tape on the first Swap key of the first
// receipt, though every sampled trade was a route through two of its pools. penny_two_pools is the deployed helper read at
// 16:46Z (its tape the side pool's); made from it: the busy pool carrying more swaps over the window than the tape's pool
// FAILs, judged on the busy pool, and the tape's pool carrying more PASSES; shared keys with no swap count read FAIL.
const PENNY = A.penny_two_pools;
const [BUSY, SIDE] = ["0x498581ff718922c3f8e6a244956af099b2652b2b:0xeae6a45e7b72b1ad74bddb5f8c74a1f6b6d8748ff1d74319ec671e37ab7b4f55", "0x498581ff718922c3f8e6a244956af099b2652b2b:0x724b25c5d56e61ef328641ef669e9c4cb16d7c697a7c78efb609ea20085d50d0"];
/** PENNY's run with `n` more swap transactions of pool `key` inside the window, its logs read as the busiest's if so. */
const withSwaps = (key, n) => {
  const rec = structuredClone(PENNY);
  const s = rec.chain.shared.find((x) => x.key === key);
  for (let i = 0; i < n; i++) s.logs.push({ blockNumber: hex(s.to - i), transactionHash: `0x${(i + 1).toString(16).padStart(64, "a")}` });
  rec.chain.poolLogs = rec.chain.shared.find((x) => x.key === check.sharedCounts(rec.chain.shared, [BUSY, SIDE])[0].key);
  return rec;
};

test("card helper-live-run-green-after-122: sampled trades that share two pools are judged on the busier over the window: the tape of the side pool FAILs once the other pool is busier, naming both counts", () => {
  const r = run(withSwaps(BUSY, 3));
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("ok ") && l.includes(`judged on the busiest over the window, ${BUSY} 3 swap transactions, ${SIDE} 0 swap transactions`)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /is not this pool's Swap leg/.test(l)), bad(r).join("\n"));
  assert.ok(bad(r).some((l) => /3 missing from the tape/.test(l)), bad(r).join("\n"));
});

test("card helper-live-run-green-after-122: the same tape PASSES where its own pool is the busier: the verdict follows the busier pool, never the receipts' log order", () => {
  const rec = withSwaps(SIDE, 1);
  // the one swap added is the tape's own trade's transaction: on the tape, nothing missing
  rec.chain.shared.find((x) => x.key === SIDE).logs[0].transactionHash = JSON.parse(rec.reads.trades.body).trades[0].tx;
  const r = run(rec);
  assert.deepEqual(bad(r), []);
  assert.ok(r.lines.some((l) => l.includes(`judged on the busiest over the window, ${SIDE} 1 swap transaction, ${BUSY} 0 swap transactions`)), r.lines.join("\n"));
});

test("card helper-live-run-green-after-122: sampled trades that share two pools with no swap count read for each FAIL, named", () => {
  for (const fn of [(r) => delete r.chain.shared, (r) => r.chain.shared.pop()]) {
    const rec = structuredClone(PENNY);
    fn(rec);
    const r = run(rec);
    assert.equal(r.ok, false);
    assert.ok(bad(r).some((l) => l.includes("no swap count read for each of them")), bad(r).join("\n"));
  }
  assert.deepEqual(check.sharedCounts(undefined, [BUSY]), null);
});

test("card helper-live-run-green-after-122: read() reads each shared key's logs over one window and keeps the busier as the pool's", async () => {
  const rec = withSwaps(BUSY, 2);
  const f = async (url, init) => {
    if (url.startsWith("https://ct-api.unrealized.trade")) return replay(rec)(url, init);
    const req = JSON.parse(init.body);
    if (req.method !== "eth_getLogs") return replay(rec)(url, init);
    const q = req.params[0];
    const s = rec.chain.shared.find((x) => x.key === `${q.address}:${q.topics[1]}`);
    assert.ok(s, `${q.address} ${q.topics[1]}`);
    const [lo, hi] = [Number.parseInt(q.fromBlock, 16), Number.parseInt(q.toBlock, 16)];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: s.logs.filter((l) => Number.parseInt(l.blockNumber, 16) >= lo && Number.parseInt(l.blockNumber, 16) <= hi).map((l) => ({ ...l, logIndex: "0x0" })) }), { status: 200 });
  };
  const again = await read("https://ct-api.unrealized.trade", rec.coin, f, undefined, "base", candlesReader(), async () => undefined);
  assert.deepEqual(again.chain.shared.map((x) => [x.key, x.logs.length]), [[BUSY, 2], [SIDE, 0]]);
  assert.equal(again.chain.poolLogs.key, BUSY);
});

test("card charts-say-coingecko: a Base chart from CoinGecko's paid plan before our first bar (recorded good_coingecko, X-Helper-Source chain,coingecko) PASSES; the same chart named by the vendor alone, or by a name the helper never gives, FAILs", () => {
  const r = run(A.good_coingecko);
  assert.deepEqual(bad(r), []);
  assert.equal(r.ok, true);
  assert.equal(A.good_coingecko.reads.candles.headers["x-helper-source"], "chain,coingecko");
  for (const src of ["coingecko", "chain,coingeckox"]) {
    const rec = structuredClone(A.good_coingecko);
    rec.reads.candles.headers["x-helper-source"] = src;
    body(rec, "candles", (b) => (b.src = src));
    assert.equal(run(rec).ok, false, src);
  }
  assert.equal(run(A.bad_not_deployed).ok, false);
});
