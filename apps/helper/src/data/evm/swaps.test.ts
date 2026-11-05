// node --test apps/helper/src/data/evm/swaps.test.ts: the Base swap reader (swaps.ts). The decoders on logs as the chain
// writes them; recorded real Base logs (a v3 pool quoted in USDC, an Aerodrome v2 pool quoted in WETH, and the
// ETH price pool) read tick by tick, as the helper reads live, in steps of 1, 3 and 11 blocks equals the same logs
// rebuilt in one go; a lagging, refusing, lying or forking provider changes nothing it should not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBook, TFS, type Event } from "../candles.ts";
import { fakeChain, ICNT, open, POOL_ICNT, POOL_VVV, REC, timeOf, toLog, URLS, VVV, KNOWN } from "../../../test/evm-swaps/base.ts";
import { BASE_VENUES, createSwaps, decodeRef, decodeSwap, hookTakes, parseLog, parseLogs, REF_POOL_ID, sameLogs, swapFilter, TOPIC, traderLeg, v4Key, type Log, type Pool } from "./swaps.ts";

/** The book the same logs make rebuilt in one go: every swap and ETH price in order, all settled. */
function rebuild(pool: Pool, upTo: number) {
  const src = pool === POOL_ICNT ? REC.logs.icnt : REC.logs.vvv;
  const events: Event[] = [];
  for (const l of src.map(toLog)) {
    const s = l.block <= upTo ? decodeSwap(pool, l) : null;
    if (s !== null) events.push({ ...s, t: timeOf(s.block) });
  }
  if (pool.quote.kind === "eth") for (const l of REC.logs.ref.map(toLog)) {
    const r = l.block <= upTo ? decodeRef(l) : null;
    if (r !== null) events.push(r);
  }
  events.sort((a, b) => a.block - b.block || a.index - b.index);
  const book = createBook({ decimals: 18, quote: pool.quote });
  book.ingest(REC.firstHead, events, upTo);
  return book;
}

const bodyOf = async (p: Promise<{ body: string }>) => JSON.parse((await p).body);

// -- decoders --------------------------------------------------------------------------------------------------------

const w = (v: bigint): string => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
const addr = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const log = (address: string, topics: string[], words: bigint[], over: Partial<Log> = {}): Log => ({ block: 100, index: 3, tx: `0x${"ab".repeat(32)}`, address, topics, data: `0x${words.map(w).join("")}`, ...over });
const V4_ID = `0x${"11".repeat(32)}`;
const POOL_V4: Pool = { venue: "v4", id: V4_ID, token: ICNT, tokenIs0: false, quote: { kind: "eth", decimals: 18 } };

test("v4 Swap: the amounts are the swapper's (read on chain: SHIB/ETH pool, amount0 -19580653565 = the ETH the tx sent, amount1 +30881255906197 = the SHIB the PoolManager transferred out): a buy", () => {
  const l = log(BASE_VENUES.poolManager, [TOPIC.swap4, V4_ID, addr("0x6ff5693b99212da76ad316178a184ab56d299b43")], [-19_580_653_565n, 30_881_255_906_197n, 1n << 90n, 5n, 7n, 100n]);
  assert.deepEqual(decodeSwap(POOL_V4, l), { kind: "swap", block: 100, index: 3, tx: l.tx, side: "b", amt: 30_881_255_906_197n, quote: 19_580_653_565n });
  // the token is currency0 instead: the same legs read the other way round
  assert.equal(decodeSwap({ ...POOL_V4, tokenIs0: true }, l)!.side, "s");
});

test("v3 Swap: the amounts are the pool's: a token the pool pays out is a buy, one it receives a sell", () => {
  const topics = [TOPIC.swap3, addr("0x01"), addr("0x02")];
  // token0 = USDC, token1 = ICNT: the pool received 5 USDC and paid out 25 ICNT: a buy of ICNT
  assert.deepEqual(decodeSwap(POOL_ICNT, log(POOL_ICNT.id, topics, [5_000_000n, -25n * 10n ** 18n, 1n, 1n, 0n])), { kind: "swap", block: 100, index: 3, tx: `0x${"ab".repeat(32)}`, side: "b", amt: 25n * 10n ** 18n, quote: 5_000_000n });
  // the pool paid out 5 USDC and received 25 ICNT: a sell
  assert.equal(decodeSwap(POOL_ICNT, log(POOL_ICNT.id, topics, [-5_000_000n, 25n * 10n ** 18n, 1n, 1n, 0n]))!.side, "s");
});

test("v2 Swap: amounts in and out, netted per leg", () => {
  const l = log(POOL_VVV.id, [TOPIC.swap2, addr("0x01"), addr("0x02")], [0n, 3n * 10n ** 18n, 2n * 10n ** 18n, 0n]);
  // WETH is token0 (in 0, out 2e18: the pool paid 2 WETH), token1 = VVV (in 3e18): the pool took VVV in, WETH out: a sell
  assert.deepEqual(decodeSwap(POOL_VVV, l), { kind: "swap", block: 100, index: 3, tx: l.tx, side: "s", amt: 3n * 10n ** 18n, quote: 2n * 10n ** 18n });
});

test("a Swap log is refused unless emitter, topics, data and legs are exactly the venue's", () => {
  const topics = [TOPIC.swap3, addr("0x01"), addr("0x02")];
  const good = log(POOL_ICNT.id, topics, [-5n, 6n, 1n, 1n, 0n]);
  assert.ok(decodeSwap(POOL_ICNT, good));
  const bad: [string, Log][] = [
    ["another emitter", { ...good, address: `0x${"cd".repeat(20)}` }],
    ["another topic0", { ...good, topics: [TOPIC.swap2, ...topics.slice(1)] }],
    ["a topic short", { ...good, topics: topics.slice(0, 2) }],
    ["data short", { ...good, data: good.data.slice(0, -64) }],
    ["data long", { ...good, data: `${good.data}${"0".repeat(64)}` }],
    ["both legs in", log(POOL_ICNT.id, topics, [5n, 6n, 1n, 1n, 0n])],
    ["both legs out", log(POOL_ICNT.id, topics, [-5n, -6n, 1n, 1n, 0n])],
    ["a zero leg", log(POOL_ICNT.id, topics, [0n, 6n, 1n, 1n, 0n])],
  ];
  for (const [what, l] of bad) assert.equal(decodeSwap(POOL_ICNT, l), null, what);
  // v4: a pool id that is not the pool's, an amount past int128
  const v4 = log(BASE_VENUES.poolManager, [TOPIC.swap4, V4_ID, addr("0x01")], [-5n, 6n, 1n, 1n, 0n, 0n]);
  assert.ok(decodeSwap(POOL_V4, v4));
  assert.equal(decodeSwap(POOL_V4, { ...v4, topics: [TOPIC.swap4, `0x${"22".repeat(32)}`, addr("0x01")] }), null);
  assert.equal(decodeSwap(POOL_V4, log(BASE_VENUES.poolManager, [TOPIC.swap4, V4_ID, addr("0x01")], [-(1n << 127n) - 1n, 6n, 1n, 1n, 0n, 0n])), null);
});

test("the ETH price: USD per ETH from the reference pool's price after a swap, and nothing outside 1 to 10,000,000 USD", () => {
  // sqrtPriceX96 = sqrt(2295.6 USD per ETH * 1e6 / 1e18) * 2^96 (read: the pool's last swap, 17:08Z)
  const sqrt = 3_795_300_000_000_000_000_000_000n; // ~ sqrt(2295.6e-12) * 2^96
  const l = log(BASE_VENUES.poolManager, [TOPIC.swap4, REF_POOL_ID, addr("0x01")], [1n, -1n, sqrt, 1n, 1n, 1n]);
  const r = decodeRef(l)!;
  assert.equal(r.kind, "ref");
  const usd = Number(r.ethUsd / 10n ** 12n) / 1e6;
  assert.ok(usd > 2_000 && usd < 2_700, `ETH at ${usd}`);
  assert.equal(decodeRef(log(BASE_VENUES.poolManager, [TOPIC.swap4, REF_POOL_ID, addr("0x01")], [1n, -1n, 1n << 70n, 1n, 1n, 1n])), null, "a price below 1 USD");
  assert.equal(decodeRef(log(BASE_VENUES.poolManager, [TOPIC.swap4, V4_ID, addr("0x01")], [1n, -1n, sqrt, 1n, 1n, 1n])), null, "another pool");
  assert.equal(decodeRef({ ...l, address: POOL_ICNT.id }), null, "another emitter");
});

test("logs from a provider are hostile input: malformed ones refuse the whole answer, removed ones are skipped", () => {
  const ok = { address: POOL_ICNT.id, topics: [TOPIC.swap3], data: "0x", blockNumber: "0x10", logIndex: "0x2", transactionHash: `0x${"ab".repeat(32)}` };
  assert.equal(parseLog(ok)!.block, 16);
  for (const bad of [{ ...ok, blockNumber: "16" }, { ...ok, logIndex: "0xzz" }, { ...ok, address: "0x12" }, { ...ok, topics: [] }, { ...ok, topics: ["0x1"] }, { ...ok, topics: Array(5).fill(TOPIC.swap3) }, { ...ok, data: "0x123" }, { ...ok, data: `0x${"00".repeat(64 * 17)}` }, { ...ok, transactionHash: "0x12" }, null, 5, "x"]) {
    assert.equal(parseLog(bad), null);
    assert.equal(parseLogs([ok, bad]), null);
  }
  assert.deepEqual(parseLogs([{ ...ok, removed: true }]), []);
  assert.equal(parseLogs({}), null);
  assert.equal(parseLogs(new Array(20_001).fill(ok)), null, "more logs than a read may hold");
  assert.deepEqual(parseLogs([{ ...ok, blockNumber: "0x20" }, ok])!.map((l) => l.block), [16, 32], "in block order");
});

test("sameLogs: two answers are alike only if every log is", () => {
  const a = REC.logs.icnt.slice(0, 5).map(toLog);
  assert.ok(sameLogs(a, a.map((l) => ({ ...l }))));
  assert.ok(!sameLogs(a, a.slice(1)));
  assert.ok(!sameLogs(a, [...a.slice(0, 4), { ...a[4]!, data: `${a[4]!.data.slice(0, -2)}00` }]));
});

test("swapFilter: a v4 pool by the PoolManager and its id, any other by its address", () => {
  assert.deepEqual(swapFilter(POOL_V4, 16, 32), { address: BASE_VENUES.poolManager, topics: [TOPIC.swap4, V4_ID], fromBlock: "0x10", toBlock: "0x20" });
  assert.deepEqual(swapFilter(POOL_ICNT, 16, 32), { address: POOL_ICNT.id, topics: [TOPIC.swap3], fromBlock: "0x10", toBlock: "0x20" });
  assert.deepEqual(swapFilter(POOL_VVV, 16, 32).topics, [TOPIC.swap2]);
});

test("v4Key: a Doppler pool the PositionManager never made has its key worked out and proved by its hash (read on chain 2026-11-03: USDDT, WETH, dynamic fee, spacing 200, the Doppler hook)", () => {
  const id = "0xcabbd9e6629b78fcdf6af95f67a102c8dc2b9c66c964377879969081f5fafade";
  const coin = "0xd5e61aca87b93d8558e4a187d57302cdf0638ba3";
  const hook = "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544";
  const around = [BASE_VENUES.weth, BASE_VENUES.poolManager, "0x9982538f41f2ae29ddb9d3d9307010052984fdbb", coin, hook];
  const k = v4Key(id, coin, 7000, around)!;
  const w = (x: string) => x.slice(2).padStart(64, "0");
  assert.equal(k, `0x${w(coin)}${w(BASE_VENUES.weth)}${(0x800000).toString(16).padStart(64, "0")}${(200).toString(16).padStart(64, "0")}${w(hook)}`.replace(`${w(coin)}${w(BASE_VENUES.weth)}`, coin < BASE_VENUES.weth ? `${w(coin)}${w(BASE_VENUES.weth)}` : `${w(BASE_VENUES.weth)}${w(coin)}`));
  assert.equal(v4Key(id, coin, 7000, around.filter((a) => a !== hook)), null, "without the hook among the addresses there is no key");
  assert.equal(v4Key(id, "0x0000000000000000000000000000000000000abc", 7000, around), null, "another token");
  assert.equal(v4Key(`0x${"11".repeat(32)}`, coin, 7000, Array.from({ length: 5_000 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`)), null, "a transaction of thousands of addresses is searched in bounded time");
});

// -- the recorded logs -----------------------------------------------------------------------------------------------

test("the recording is real Base logs: 500 blocks (16 minutes) or more, hundreds of swaps, and Base's clock held at every block time read", () => {
  assert.ok(REC.lastHead - REC.firstHead >= 500, `${REC.lastHead - REC.firstHead} blocks`);
  assert.ok(REC.logs.icnt.length > 100 && REC.logs.vvv.length > 30 && REC.logs.ref.length > 20);
  const read = Object.entries(REC.blockTimes);
  assert.ok(read.length >= 5);
  for (const [n, t] of read) assert.equal(t, timeOf(Number(n)), `block ${n}`);
});

const reading = (steps: number) =>
  test(`a recorded stretch of Base read live, ${steps} block${steps === 1 ? "" : "s"} a tick, gives the bars and tape of the same logs rebuilt in one go (USDC-quoted v3 and WETH-quoted v2)`, async () => {
    const chain = fakeChain();
    const s = open(chain);
    await s.candles(ICNT, "1m", null, 500); // the first open: the cold read, before any recorded block
    await s.candles(VVV, "1m", null, 500);
    let head = REC.firstHead;
    while (head < REC.lastHead) {
      head = Math.min(REC.lastHead, head + steps);
      chain.st.head = head;
      await s.tick();
    }
    s.stop();
    for (const [token, pool] of [[ICNT, POOL_ICNT], [VVV, POOL_VVV]] as const) {
      const whole = rebuild(pool, REC.lastHead);
      let bars = 0;
      for (const tf of TFS.filter((x) => x !== "1s")) {
        const live = await bodyOf(s.candles(token, tf, null, 500));
        assert.deepEqual(live.candles, whole.candles(tf, null, 500), `${token} ${tf}`);
        bars += live.candles.length;
        assert.equal(live.src, "chain");
      }
      assert.ok(bars > 8, "real bars, not an empty match");
      const tape = await bodyOf(s.trades(token, 50));
      assert.deepEqual(tape.trades.map((t: { tx: string; side: string; usd: string; amt: string; t_ms: number }) => [t.tx, t.side, t.usd, t.amt, t.t_ms]), whole.tape(50).map((t) => [t.tx, t.side, t.usd, t.amt, t.t_ms]), `${token} tape`);
      assert.ok(tape.trades.every((t: { trader: string }) => /^0x[0-9a-f]{40}$/.test(t.trader)));
    }
  });
for (const n of [1, 3, 11]) reading(n);

test("the newest blocks are read again every tick: a fork of the last blocks replaces them", async () => {
  const chain = fakeChain();
  const s = open(chain);
  chain.st.head = REC.lastHead - 40;
  await s.candles(ICNT, "1m", null, 500);
  for (let h = REC.lastHead - 40; h < REC.lastHead - 5; h += 2) {
    chain.st.head = h;
    await s.tick();
  }
  const before = await bodyOf(s.trades(ICNT, 20));
  // the chain forks 7 blocks behind its head: from there the logs are different ones
  const forkAt = REC.lastHead - 5 - 7;
  chain.st.fork = { from: forkAt };
  chain.st.head = REC.lastHead - 5;
  await s.tick();
  const after = await bodyOf(s.trades(ICNT, 20));
  assert.notDeepEqual(after.trades.map((t: { amt: string }) => t.amt), before.trades.map((t: { amt: string }) => t.amt), "the forked swaps are not the old ones");
  // and the newest swaps equal those of a book that only ever saw the forked chain
  const only = open(chain);
  const direct = await bodyOf(only.trades(ICNT, 20));
  s.stop();
  only.stop();
  assert.deepEqual(after.trades, direct.trades);
});

test("a provider 30 blocks behind is passed over for the third; the agreed block is the newest two have", async () => {
  const chain = fakeChain();
  chain.st.faults.set(URLS[0]!, { lag: 30 });
  const s = open(chain);
  chain.st.head = REC.firstHead + 200;
  const got = await bodyOf(s.candles(ICNT, "1m", null, 500));
  s.stop();
  assert.ok(got.candles.length > 0);
  const whole = rebuild(POOL_ICNT, REC.firstHead + 200);
  assert.deepEqual(got.candles, whole.candles("1m", null, 500));
  assert.ok((chain.st.calls.get(URLS[2]!) ?? 0) > 0, "the third was asked");
});

test("one provider lies in some logs: the other two agree and the answer is the true one", async () => {
  const chain = fakeChain();
  chain.st.faults.set(URLS[1]!, { corrupt: true });
  const s = open(chain);
  chain.st.head = REC.firstHead + 200;
  const got = await bodyOf(s.candles(ICNT, "1m", null, 500));
  s.stop();
  assert.deepEqual(got.candles, rebuild(POOL_ICNT, REC.firstHead + 200).candles("1m", null, 500));
});

test("two providers that differ and no third to decide: nothing is served (503), and a book that was serving keeps its bars", async () => {
  const chain = fakeChain();
  const s = open(chain);
  chain.st.head = REC.firstHead + 200;
  const good = await bodyOf(s.candles(ICNT, "1m", null, 500));
  chain.st.faults.set(URLS[0]!, { corrupt: true });
  chain.st.faults.set(URLS[1]!, { down: true });
  chain.st.head = REC.firstHead + 220;
  await s.tick();
  const kept = await bodyOf(s.candles(ICNT, "1m", null, 500));
  assert.deepEqual(kept.candles, good.candles, "unchanged while the providers cannot agree");
  const fresh = open(chain);
  const none = await fresh.candles(VVV, "1m", null, 500);
  s.stop();
  fresh.stop();
  assert.equal(none.status, 503);
  assert.deepEqual(JSON.parse(none.body), { error: { code: "upstream" } });
});

test("a provider that refuses is held for the wait it names (the helper's RPC rules): -32005 with backoff_seconds 7, and a 429, are not asked again before it", async () => {
  const clock = { t: 5_000_000 };
  const chain = fakeChain();
  chain.st.faults.set(URLS[0]!, { limit: 7 });
  chain.st.faults.set(URLS[1]!, { status: 429 });
  const s = open(chain, clock);
  chain.st.head = REC.firstHead + 100;
  await s.candles(ICNT, "1m", null, 500); // only the third answers: no two agree, nothing is served
  const [a0, b0] = [chain.st.calls.get(URLS[0]!)!, chain.st.calls.get(URLS[1]!)!];
  await s.tick();
  assert.equal(chain.st.calls.get(URLS[0]!), a0, "held 7 s: not asked");
  clock.t += 7_000;
  chain.st.faults.delete(URLS[0]!);
  chain.st.faults.delete(URLS[1]!);
  // the third down, so the pair after the wait is the two that refused (which two free providers are asked first
  // takes turns: swaps.ts ranked)
  chain.st.faults.set(URLS[2]!, { down: true });
  await s.tick();
  s.stop();
  assert.ok(chain.st.calls.get(URLS[0]!)! > a0, "asked again after the wait");
  assert.ok(chain.st.calls.get(URLS[1]!)! > b0);
});

test("a provider whose newest block is not on Base's clock reads nothing", async () => {
  const chain = fakeChain();
  chain.st.faults.set(URLS[0]!, { badClock: true });
  chain.st.faults.set(URLS[1]!, { badClock: true });
  const s = open(chain);
  chain.st.head = REC.firstHead + 100;
  const none = await s.candles(ICNT, "1m", null, 500);
  s.stop();
  assert.equal(none.status, 503);
});

test("the routes' arguments: 1s on Base, an unlisted token, a bad address, a limit out of range answer 404", async () => {
  const chain = fakeChain();
  const s = createSwaps("base", { fetch: chain.fetch, now: () => 1, listed: async (t) => t === ICNT, rpcs: URLS, pools: new Map([[ICNT, KNOWN.get(ICNT)!]]) });
  chain.st.head = REC.firstHead + 100;
  for (const [what, p] of [
    ["1s", s.candles(ICNT, "1s", null, 10)],
    ["an unknown tf", s.candles(ICNT, "2m", null, 10)],
    ["an unlisted token", s.candles(VVV, "1m", null, 10)],
    ["a bad address", s.candles("0x12", "1m", null, 10)],
    ["limit 0", s.candles(ICNT, "1m", null, 0)],
    ["limit 501", s.candles(ICNT, "1m", null, 501)],
    ["tape 51", s.trades(ICNT, 51)],
    ["tape 0", s.trades(ICNT, 0)],
  ] as const) assert.equal((await p).status, 404, what);
  s.stop();
});

test("a tick reads the open tokens at once, not one after another (a dozen books one by one outlast several blocks)", async () => {
  const chain = fakeChain();
  let flying = 0;
  let most = 0;
  const slow = async (url: string, init: RequestInit): Promise<Response> => {
    flying++;
    most = Math.max(most, flying);
    await new Promise((r) => setTimeout(r, 15));
    try {
      return await chain.fetch(url, init);
    } finally {
      flying--;
    }
  };
  const s = createSwaps("base", { fetch: slow, now: () => 1_000_000, listed: async () => true, rpcs: URLS, pools: KNOWN, tickMs: 0 });
  chain.st.head = REC.firstHead + 100;
  await s.candles(ICNT, "1m", null, 5);
  await s.candles(VVV, "1m", null, 5);
  most = 0;
  chain.st.head = REC.firstHead + 110;
  await s.tick();
  s.stop();
  // each book's read asks two providers at once; two books at once make four
  assert.ok(most >= 4, `at most ${most} requests in flight`);
});

/** A fetch that waits `ms` before each answer and keeps what was asked, with when. */
function slowChain(ms: number) {
  const chain = fakeChain();
  const st = { flying: 0, most: 0, heads: 0 };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    st.flying++;
    st.most = Math.max(st.most, st.flying);
    if (String(init.body).includes("eth_getBlockByNumber")) st.heads++;
    await new Promise((r) => setTimeout(r, ms));
    try {
      return await chain.fetch(url, init);
    } finally {
      st.flying--;
    }
  };
  return { chain, st, fetch };
}

test("a tick reads the ETH price and an ETH-quoted book at once, not the price first (three rounds outlast a 1 s tick on Robinhood's providers)", async () => {
  const { chain, st, fetch } = slowChain(15);
  const s = createSwaps("base", { fetch, now: () => 1_000_000, listed: async () => true, rpcs: URLS, pools: new Map([[VVV, KNOWN.get(VVV)!]]), tickMs: 0 });
  chain.st.head = REC.firstHead + 100;
  await s.candles(VVV, "1m", null, 5);
  st.most = 0;
  chain.st.head = REC.firstHead + 110;
  await s.tick();
  s.stop();
  // two providers asked for the ETH price and two for the book, at once
  assert.ok(st.most >= 4, `at most ${st.most} requests in flight`);
});

test("a tick that outlasts the period is followed at once by the next, never a skipped period", async () => {
  // each request takes 150 ms, so a tick (the head, then the book and the ETH price) takes about 300 ms, past the 250 ms
  // period: ticks back to back make about five in 1.5 s; a timer that drops the period a tick overran makes three
  const { chain, st, fetch } = slowChain(150);
  const s = createSwaps("base", { fetch, now: () => 1_000_000, listed: async () => true, rpcs: URLS, pools: new Map([[VVV, KNOWN.get(VVV)!]]), tickMs: 250 });
  chain.st.head = REC.firstHead + 100;
  await s.candles(VVV, "1m", null, 5);
  st.heads = 0;
  await new Promise((r) => setTimeout(r, 1_500));
  s.stop();
  const ticks = st.heads / 2; // each tick reads two providers' heads
  assert.ok(ticks >= 4, `${ticks} ticks in 1.5 s`);
});

test("a listed token whose pool our reads do not find answers 200 empty from our own reads (src chain), never 404; an unlisted one stays 404", async () => {
  const chain = fakeChain();
  const NOPOOL = `0x${"34".repeat(20)}`;
  // the chain holds no transfer of the token in the window, so no address is a pool of it
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const calls = JSON.parse(String(init.body)) as { id: number; method: string; params: { address?: string }[] }[];
    if (calls.every((c) => c.method === "eth_getLogs" && c.params[0]?.address === NOPOOL)) return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] }))), { status: 200 });
    return chain.fetch(url, init);
  };
  const s = createSwaps("base", { fetch, now: () => 1_000_000, listed: async (t) => t === NOPOOL, rpcs: URLS, pools: new Map(), tickMs: 0 });
  chain.st.head = REC.firstHead + 100;
  const c = await s.candles(NOPOOL, "1m", null, 10);
  const t = await s.trades(NOPOOL, 10);
  // a second ask is served from the kept "no pool" the same way
  const again = await s.trades(NOPOOL, 10);
  const off = await s.candles(`0x${"56".repeat(20)}`, "1m", null, 10);
  s.stop();
  assert.equal(c.status, 200, c.body);
  assert.deepEqual(JSON.parse(c.body), { tf: "1m", candles: [], src: "chain", as_of_ms: 1_000_000 });
  assert.equal((c as { src?: string }).src, "chain");
  assert.equal((c as { asOfMs?: number }).asOfMs, 1_000_000);
  assert.equal(t.status, 200, t.body);
  assert.deepEqual(JSON.parse(t.body), { trades: [], src: "chain", as_of_ms: 1_000_000 });
  assert.equal(again.status, 200, again.body);
  assert.equal(off.status, 404);
});

test("GeckoTerminal's bars before ours: the newest range asked once; a 429 later serves the last good bars of that pool and tf; with none kept, the chain's own bars alone (card helper-crowd-429: the seed is optional, its 429 never the answer)", async () => {
  // app live run 41787804457 (4 Nov 06:49Z): a throttled GeckoTerminal read left a chart with no bars (the Solana
  // path; the EVM path merged GeckoTerminal the same way)
  const { readFileSync } = await import("node:fs");
  const FX = JSON.parse(readFileSync(new URL("../solana/fixtures/token-page.json", import.meta.url), "utf8"));
  const { geckoBudget } = await import("../gecko.ts");
  const chain = fakeChain();
  const clock = { t: Date.parse("2026-11-02T13:53:00Z") };
  let refuse = false;
  const gt: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (!url.includes("geckoterminal")) return chain.fetch(url, init);
    gt.push(url);
    return refuse ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : new Response(JSON.stringify(FX.gt_ohlcv), { status: 200 });
  }) as typeof chain.fetch;
  const s = open(chain, clock, { fetch: fetchFn, gecko: geckoBudget(() => clock.t) });
  const first = await bodyOf(s.candles(ICNT, "1m", null, 500));
  assert.equal(first.own_from_s, undefined, "no bars of ours yet");
  assert.equal(first.src, "chain,geckoterminal");
  assert.ok(first.candles.length > 2);
  assert.ok(!gt[0]!.includes("before_timestamp"), "the newest range, one cache key");
  clock.t += 2 * 3_600_000; // past GeckoTerminal's freshness
  await s.tick();
  refuse = true;
  const kept = await s.candles(ICNT, "1m", null, 500);
  assert.equal(kept.status, 200, kept.body);
  assert.deepEqual(JSON.parse(kept.body).candles, first.candles);
  assert.equal(kept.src, "chain,geckoterminal");
  const none = await s.candles(ICNT, "5m", null, 500); // paused by the 429, nothing kept for 5m
  assert.equal(none.status, 200, none.body);
  assert.deepEqual([none.src, JSON.parse(none.body).candles], ["chain", []], "our own bars alone: none yet");
  s.stop();
});

test("card helper-crowd-429: GeckoTerminal's bars before a book of ours are an optional seed, a stale read: with one call left in the window it is not taken, the chart answers our own bars, and the call stays for a chart with nothing to serve", async () => {
  const { geckoBudget, GT_LIMIT_PER_MIN } = await import("../gecko.ts");
  const chain = fakeChain();
  const clock = { t: Date.parse("2026-11-02T13:53:00Z") };
  const gt: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (!url.includes("geckoterminal")) return chain.fetch(url, init);
    gt.push(url);
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [] } } }), { status: 200 });
  }) as typeof chain.fetch;
  const budget = geckoBudget(() => clock.t);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN - 1 }, () => clock.t - 1_000)); // the old helper's calls at a swap
  const s = open(chain, clock, { fetch: fetchFn, gecko: budget });
  chain.st.head = REC.firstHead + 200;
  const got = await bodyOf(s.candles(ICNT, "1m", null, 500));
  s.stop();
  assert.ok(got.own_from_s !== undefined && got.candles.length > 0, "bars of ours");
  assert.equal(got.src, "chain");
  assert.deepEqual(gt, [], "no GeckoTerminal call for the seed");
  assert.equal(budget.take("pages"), true, "the window's last call is still there for a cold chart");
});

// Card helper-v4-hook-liquidity: Base tx 0x02b8198c518595444576c2e52c9a8a536b179a2341b09aa2d58c732a61b0a2e5 (block
// 53,529,320, receipt read from mainnet.base.org 2026-11-05 03:2xZ) launches a token on a hooked v4 pool and buys it in one
// transaction: 1e9 minted to the hook (713), Initialize (717), ModifyLiquidity (721), the hook's 1e9 in to the
// PoolManager for that liquidity (722), the Swap (730), and 5,978.99 out to the router and on to the buyer (737, 738,
// 741). At c68e2b7 hookTakes counted 722 as the swap's cut and the tape showed a buy of 1,000,005,978.99.
const LAUNCH: [number, string, string[], string][] = [
  [713, "0xc98d5da74a488b9857a8d676d828860f59e7cccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc"], "0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000"],
  [717, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438","0x2273c4b8ed2f570523372c6f26664bb4ccf01242f6f457fc32738afec620a5f1","0x0000000000000000000000000000000000000000000000000000000000000000","0x000000000000000000000000c98d5da74a488b9857a8d676d828860f59e7cccc"], "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c80000000000000000000000005e320ea6278107968c119942e57d876c5f922acc0000000000000000000000000000000000005fff3c531962481c82e8ccb0bfdb00000000000000000000000000000000000000000000000000000000000315d8"],
  [721, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec","0x2273c4b8ed2f570523372c6f26664bb4ccf01242f6f457fc32738afec620a5f1","0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2766000000000000000000000000000000000000000000000000000000000000315d800000000000000000000000000000000000000000000089de231e289aecd747c0000000000000000000000000000000000000000000000000000000000000000"],
  [722, "0xc98d5da74a488b9857a8d676d828860f59e7cccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x0000000000000000000000000000000000000000033b2e3c9fd0803ce7ffc991"],
  [730, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0x2273c4b8ed2f570523372c6f26664bb4ccf01242f6f457fc32738afec620a5f1","0x000000000000000000000000c3ace43169bbf51752b1603067f91ef60f8a662a"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffffff6fefa0448000000000000000000000000000000000000000000000001441f2f04bdf958c7d80000000000000000000000000000000000005fff16b58ece5ff657a52365dc7b00000000000000000000000000000000000000000000089de231e289aecd747c00000000000000000000000000000000000000000000000000000000000315d70000000000000000000000000000000000000000000000000000000000000000"],
  [737, "0xc98d5da74a488b9857a8d676d828860f59e7cccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b","0x000000000000000000000000c3ace43169bbf51752b1603067f91ef60f8a662a"], "0x0000000000000000000000000000000000000000000001441f2f04bdf958c7d8"],
  [738, "0xc98d5da74a488b9857a8d676d828860f59e7cccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000c3ace43169bbf51752b1603067f91ef60f8a662a","0x0000000000000000000000005c65823dc5eaf0c37205f73213fc2f73d359da4d"], "0x0000000000000000000000000000000000000000000001441f2f04bdf958c7d8"],
  [741, "0xc98d5da74a488b9857a8d676d828860f59e7cccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000005c65823dc5eaf0c37205f73213fc2f73d359da4d","0x000000000000000000000000f04c41cf7d0046fd0895f24e885b3abfc5162187"], "0x0000000000000000000000000000000000000000000001441f2f04bdf958c7d8"],
];
test("card helper-v4-hook-liquidity: a hook's transfer that settles the pool's liquidity (after its ModifyLiquidity) is no cut of the next swap: the launch's first buy is the 5,978.99 its buyer got", () => {
  const logs: Log[] = LAUNCH.map(([index, address, topics, data]) => ({ block: 0x330cae8, index, tx: "0x02b8198c518595444576c2e52c9a8a536b179a2341b09aa2d58c732a61b0a2e5", address, topics, data }));
  const swap = logs.find((l) => l.index === 730)!;
  const pool: Pool = { venue: "v4", id: swap.topics[1]!, token: logs.find((l) => l.index === 713)!.address, tokenIs0: false, quote: { kind: "eth", decimals: 18 }, hook: "0x5e320ea6278107968c119942e57d876c5f922acc" };
  const s = decodeSwap(pool, swap, "base")!;
  assert.equal(s.kind, "swap");
  const got = traderLeg(s as { side: "b" | "s"; amt: bigint }, hookTakes(pool, logs, "base").get(`${swap.tx}:${swap.index}`)) ?? (s as { amt: bigint }).amt;
  const toBuyer = BigInt(logs.find((l) => l.index === 741)!.data);
  assert.equal(got, toBuyer, `the buy is the ${toBuyer} the buyer got, not ${got}`);
  // the same transfer with no ModifyLiquidity before it, and no move of the swap's sender read, is a hook's cut as
  // before (a hook paying the swap in)
  const noCall = logs.filter((l) => l.index !== 721 && l.index !== 717 && l.index !== 737);
  assert.equal(hookTakes(pool, noCall, "base").get(`${swap.tx}:${swap.index}`), -BigInt(logs.find((l) => l.index === 722)!.data));
});

// Card helper-v4-hook-liquidity, live run 41990876403 at 04bb10f: Base tx
// 0xfaaa9cc939fffb787b906da0c1309746e5229d722df371b1a44322b2994c1460 (block 53,537,870, receipt read from
// base-rpc.publicnode.com and base.gateway.tenderly.co alike, 2026-11-05 09:2xZ). A buy of 0xe2969931... on the pool
// whose key's hook is 0xbdf93814... (afterSwap with a return delta; the PoolManager's key, v4Key): the buy's Swap (178,
// sender the router 0xf8cd946a), the cut taken by 0x9982538f, a contract the hook calls (180), that contract's two sells
// (181, 185) paid in (183, 187), its ModifyLiquidity (189) paid in (192), the hook's move out and back (193, 194), and the
// buyer's tokens minted to the router as ERC-6909 claims (197: 44,726,051,716,064, no Transfer). The tape showed
// 51,015,555,490,232 at 04bb10f.
const OWN_SELLS: [number, string, string[], string][] = [
  [178, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0x894c4d2aac7d50f1a6e4367e2928a0a1bb876a9cb435d43fe024d2fcd76ef173","0x000000000000000000000000f8cd946adb3e56c6c246fd8eaa32c4c94ec889ed"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff79d00000000000000000000000000000000000000000000000000002e65fc1021b80000000000000000000000000000000000025c64ad57fb18d558a41852b05664000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58"],
  [180, "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0x000000000000000000000000000000000000000000000000000005b863a365d8"],
  [181, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0x894c4d2aac7d50f1a6e4367e2928a0a1bb876a9cb435d43fe024d2fcd76ef173","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0x00000000000000000000000000000000000000000000000000000000000000b1fffffffffffffffffffffffffffffffffffffffffffffffffffffc1e4eac8d2e0000000000000000000000000000000000025c64ad57fb1928d68394dd8d79a1000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58"],
  [183, "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x000000000000000000000000000000000000000000000000000003e1b15372d2"],
  [185, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0x894c4d2aac7d50f1a6e4367e2928a0a1bb876a9cb435d43fe024d2fcd76ef173","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0x0000000000000000000000000000000000000000000000000000000000000023ffffffffffffffffffffffffffffffffffffffffffffffffffffff3942ef4f700000000000000000000000000000000000025c64ad57fb19398949e0f941f945000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58"],
  [187, "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x000000000000000000000000000000000000000000000000000000c6bd10b090"],
  [189, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec","0x894c4d2aac7d50f1a6e4367e2928a0a1bb876a9cb435d43fe024d2fcd76ef173","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2766000000000000000000000000000000000000000000000000000000000000d89a0000000000000000000000000000000000000000000000000000000000050455f84d425564d25e000e629db464057c45d862ce4a5dd192c74cfc9ab2250404026"],
  [192, "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x000000000000000000000000000000000000000000000000000000bd833d9794"],
  [193, "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b","0x000000000000000000000000bdf938149ac6a781f94faa0ed45e6a0e984c6544"], "0x000000000000000000000000000000000000000000000000000005b863a365d8"],
  [194, "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000bdf938149ac6a781f94faa0ed45e6a0e984c6544","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x000000000000000000000000000000000000000000000000000005b863a365d8"],
  [197, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859","0x0000000000000000000000000000000000000000000000000000000000000000","0x000000000000000000000000f8cd946adb3e56c6c246fd8eaa32c4c94ec889ed","0x000000000000000000000000e2969931f5f0d2e2d53e8077e6a923b16512eba3"], "0x000000000000000000000000f8cd946adb3e56c6c246fd8eaa32c4c94ec889ed000000000000000000000000000000000000000000000000000028ad986cbbe0"],
];
test("card helper-v4-hook-liquidity: a buy taken as ERC-6909 claims by its router is what the router was minted: Base tx 0xfaaa9cc9's buy is the 44,726,051,716,064 its buyer got", () => {
  const tx = "0xfaaa9cc939fffb787b906da0c1309746e5229d722df371b1a44322b2994c1460";
  const logs: Log[] = OWN_SELLS.map(([index, address, topics, data]) => ({ block: 53_537_870, index, tx, address, topics, data }));
  const swap = logs.find((l) => l.index === 178)!;
  const coin = "0xe2969931f5f0d2e2d53e8077e6a923b16512eba3";
  const pool: Pool = { venue: "v4", id: swap.topics[1]!, token: coin, tokenIs0: false, quote: { kind: "eth", decimals: 18 }, hook: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544" };
  const s = decodeSwap(pool, swap, "base") as { side: "b" | "s"; amt: bigint };
  const got = traderLeg(s, hookTakes(pool, logs, "base").get(`${tx}:178`)) ?? s.amt;
  // the ERC-6909 mint's amount (its data's second word) is what the buyer got
  const minted = BigInt(`0x${logs.find((l) => l.index === 197)!.data.slice(2 + 64)}`);
  assert.equal(minted, 44_726_051_716_064n);
  assert.equal(got, minted, `the buy is the ${minted} the buyer was minted, not ${got}`);
});

// Card helper-v4-hook-liquidity: Base tx 0x72c376b79a5f6bd08cb1a05d1c79ee55ee3f0e724aa398a928d11e950a5f83b8 (block
// 53,540,767, receipt agreed by two Base providers in the check's run on the fix at 6e4c723, 2026-11-05 09:4xZ), the
// same hook 0xbdf93814...: the buy's Swap (342, sender the router 0x10350290), the cut of 123.74 taken by 0x9982538f (344),
// its two sells (345, 349) paid in (347, 351), its ModifyLiquidity (353) paid in (356), the hook's move out and back (357,
// 358), and the router's 11,661.28 out (360) and on (362, 363). None of the cut moves between the PoolManager and the
// hook, so the tape showed the pool's 11,785.03.
const ROUTER_TAKE: [number, string, string[], string][] = [
  [342, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0xd9a01d7c963aac102aa13b4a59b6eb606d0840ea3f0f519fc4eb682fdc587598","0x000000000000000000000000103502909141f7025a94b7b99a276dcd128e21a8"], "0xffffffffffffffffffffffffffffffffffffffffffffffffffffff8c92ff528000000000000000000000000000000000000000000000027ede177243567d4e930000000000000000000000000000000000025c6477495cfb265dfddc9d3eca26000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58"],
  [344, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0x000000000000000000000000000000000000000000000006b546a56c7ba8fee7"],
  [345, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0xd9a01d7c963aac102aa13b4a59b6eb606d0840ea3f0f519fc4eb682fdc587598","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0x00000000000000000000000000000000000000000000000000000000cf9987cdfffffffffffffffffffffffffffffffffffffffffffffffb72b4a208ac1677790000000000000000000000000000000000025c6477ab45eda3064c23f98f0538000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58"],
  [347, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x0000000000000000000000000000000000000000000000048d4b5df753e98887"],
  [349, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0xd9a01d7c963aac102aa13b4a59b6eb606d0840ea3f0f519fc4eb682fdc587598","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0x0000000000000000000000000000000000000000000000000000000029aea03cffffffffffffffffffffffffffffffffffffffffffffffff1607de222426e9490000000000000000000000000000000000025c6477beee7fec74170eb1c58ef9000000000000000000000000000000000000000000000bd1819559a425426917000000000000000000000000000000000000000000000000000000000003a5970000000000000000000000000000000000000000000000000000000000001b58"],
  [351, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x000000000000000000000000000000000000000000000000e9f821dddbd916b7"],
  [353, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec","0xd9a01d7c963aac102aa13b4a59b6eb606d0840ea3f0f519fc4eb682fdc587598","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2766000000000000000000000000000000000000000000000000000000000000d89a000000000000000000000000000000000000000000000000000006254863bd9afc59f81f949d75c831c07bda27c1fc3c6d255479e5a451f7be229603b0b7271f7"],
  [356, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000009982538f41f2ae29ddb9d3d9307010052984fdbb","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x000000000000000000000000000000000000000000000000e82603b845b71685"],
  [357, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b","0x000000000000000000000000bdf938149ac6a781f94faa0ed45e6a0e984c6544"], "0x000000000000000000000000000000000000000000000006b546a56c7ba8fee7"],
  [358, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000bdf938149ac6a781f94faa0ed45e6a0e984c6544","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x000000000000000000000000000000000000000000000006b546a56c7ba8fee7"],
  [360, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b","0x000000000000000000000000103502909141f7025a94b7b99a276dcd128e21a8"], "0x00000000000000000000000000000000000000000000027828d0ccd6dad44fac"],
  [362, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000103502909141f7025a94b7b99a276dcd128e21a8","0x00000000000000000000000000000000009726632680fb29d3f7a9734e3010e2"], "0x00000000000000000000000000000000000000000000027828d0ccd6dad44fab"],
  [363, "0x9984b642b639b4e9397c0bd0463228f2586e9ba3", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000000000000009726632680fb29d3f7a9734e3010e2","0x000000000000000000000000b2322fb6b8a3b9bafeccde9dfc44ba9faf6ce6e7"], "0x00000000000000000000000000000000000000000000027828d0ccd6dad44fab"],
];
const routerTake = () => {
  const tx = "0x72c376b79a5f6bd08cb1a05d1c79ee55ee3f0e724aa398a928d11e950a5f83b8";
  const logs: Log[] = ROUTER_TAKE.map(([index, address, topics, data]) => ({ block: 53_540_767, index, tx, address, topics, data }));
  const swap = logs.find((l) => l.index === 342)!;
  const coin = logs.find((l) => l.index === 344)!.address;
  const pool: Pool = { venue: "v4", id: swap.topics[1]!, token: coin, tokenIs0: false, quote: { kind: "eth", decimals: 18 }, hook: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544" };
  const s = decodeSwap(pool, swap, "base") as { side: "b" | "s"; amt: bigint };
  return { tx, logs, swap, pool, s, leg: (l: Log[], p: Pool = pool) => traderLeg(s, hookTakes(p, l, "base").get(`${tx}:342`)) ?? s.amt };
};
test("card helper-v4-hook-liquidity: a buy is what its router took from the PoolManager, wherever the hook's cut went: Base tx 0x72c376b7's buy is the 11,661.28 its buyer got, not the pool's 11,785.03", () => {
  const { logs, s, leg } = routerTake();
  const toRouter = BigInt(logs.find((l) => l.index === 360)!.data);
  assert.equal(s.amt, 11_785_026_104_461_117_705_875n);
  assert.equal(leg(logs), toRouter, `the buy is the ${toRouter} the router took, not ${leg(logs)}`);
});
test("card helper-v4-hook-liquidity: a sender with a second swap of the token in a sibling pool, or none of the token moved (a route through it, its deltas netted in the PoolManager), is no read: the hook's own moves decide, never a leg of 0", () => {
  const { tx, logs, swap, pool, s, leg } = routerTake();
  // a split buy: the same router swaps the token in a sibling pool too, so its one take is both swaps'
  const sib = `0x${"5".repeat(64)}`;
  const split = [...logs, { ...swap, index: 343, topics: [swap.topics[0]!, sib, swap.topics[2]!] }];
  assert.equal(leg(split, { ...pool, siblings: [sib] }), s.amt, "no read: the hook's moves settle its ModifyLiquidity, no cut");
  assert.notEqual(leg(split, pool), s.amt, "without the sibling read, the router's take is read");
  // a multi-hop through the token (ETH to the token here, the token on to another coin in a pool not read): the router
  // takes none of it, so no Transfer or claim of it moves with the PoolManager
  const hop = logs.filter((l) => l.index !== 360);
  assert.equal(leg(hop), s.amt, "no read: the pool's amount, not 0");
  assert.equal(hookTakes(pool, hop, "base").get(`${tx}:342`), undefined);
  // the sender moved the token out and back (net 0) is no read either
  const back = [...hop, { ...logs.find((l) => l.index === 360)!, index: 361 }, { ...logs.find((l) => l.index === 360)!, index: 364, topics: [TOPIC.transfer, logs.find((l) => l.index === 360)!.topics[2]!, logs.find((l) => l.index === 360)!.topics[1]!] }];
  assert.equal(leg(back), s.amt);
});

// Card helper-v4-hook-liquidity: Base tx 0x655b2818f4ac086365f25052f2628ddfb433b687238b481c0f03b585de09500e (block
// 53,524,257, receipt read from base-rpc.publicnode.com and base.gateway.tenderly.co alike, 2026-11-05 09:3xZ), one of 4
// launches of hook 0x5e320ea6... in 20,000 blocks whose buy af04d30 still read wrong: 1e9 minted to the hook (6),
// Initialize (27), ModifyLiquidity (31) and the hook's 1e9 paid in (32), the buy's Swap (43), the hook's cut taken as
// ERC-6909 claims of the token the PoolManager minted to its fee recipient 0x5dd237d1 (52: 302,577,162,698,952,813; 44 is
// a claim of USDC, no cut of the token), and the buyer's 599,102,782,143,926,570,213 out (55). The tape showed the pool's
// 599,405,359,306,625,523,026.
const CLAIMS_CUT: [number, string, string[], string][] = [
  [6, "0x2890717c770b52061408d1a88039eb7f479dcccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc"], "0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000"],
  [27, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438","0x42094dd1660acd9b7420e62c24726dfc711a247319bbb9e84b009e67799a0e36","0x0000000000000000000000002890717c770b52061408d1a88039eb7f479dcccc","0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913"], "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c80000000000000000000000005e320ea6278107968c119942e57d876c5f922acc00000000000000000000000000000000000000000000000883956ab34ccb0338fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9e260"],
  [31, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec","0x42094dd1660acd9b7420e62c24726dfc711a247319bbb9e84b009e67799a0e36","0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc"], "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9e32800000000000000000000000000000000000000000000000000000000000d89a00000000000000000000000000000000000000000000000001bc963f9e7260c830000000000000000000000000000000000000000000000000000000000000000"],
  [32, "0x2890717c770b52061408d1a88039eb7f479dcccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b"], "0x0000000000000000000000000000000000000000033b2e3c9fd0803cdcf274c4"],
  [43, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f","0x42094dd1660acd9b7420e62c24726dfc711a247319bbb9e84b009e67799a0e36","0x000000000000000000000000c3ace43169bbf51752b1603067f91ef60f8a662a"], "0x0000000000000000000000000000000000000000000000207e6b9e80f0cc1d52fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff69d000000000000000000000000000000000000000000000008997d32eb9c288cef0000000000000000000000000000000000000000000000001bc963f9e7260c83fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9e3280000000000000000000000000000000000000000000000000000000000000000"],
  [44, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000005dd237d1f716c65426ccd2fae82b95109825fa61","0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913"], "0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc0000000000000000000000000000000000000000000000000000000000000017"],
  [52, "0x498581ff718922c3f8e6a244956af099b2652b2b", ["0x1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000005dd237d1f716c65426ccd2fae82b95109825fa61","0x0000000000000000000000002890717c770b52061408d1a88039eb7f479dcccc"], "0x0000000000000000000000005e320ea6278107968c119942e57d876c5f922acc0000000000000000000000000000000000000000000000000432f8538bd1106d"],
  [55, "0x2890717c770b52061408d1a88039eb7f479dcccc", ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b","0x000000000000000000000000c3ace43169bbf51752b1603067f91ef60f8a662a"], "0x0000000000000000000000000000000000000000000000207a38a62d64fb0ce5"],
];
test("card helper-v4-hook-liquidity: a hook's cut taken as ERC-6909 claims of the token it has the PoolManager mint is the swap's cut: the launch's buy is the 599,102,782,143,926,570,213 its buyer got", () => {
  const tx = "0x655b2818f4ac086365f25052f2628ddfb433b687238b481c0f03b585de09500e";
  const logs: Log[] = CLAIMS_CUT.map(([index, address, topics, data]) => ({ block: 53_524_257, index, tx, address, topics, data }));
  const swap = logs.find((l) => l.index === 43)!;
  const coin = logs.find((l) => l.index === 6)!.address;
  // the token is currency0, USDC currency1 (Initialize's topics)
  const pool: Pool = { venue: "v4", id: swap.topics[1]!, token: coin, tokenIs0: true, quote: { kind: "usd", decimals: 6 }, hook: "0x5e320ea6278107968c119942e57d876c5f922acc" };
  const s = decodeSwap(pool, swap, "base") as { side: "b" | "s"; amt: bigint };
  assert.equal(s.side, "b");
  const got = traderLeg(s, hookTakes(pool, logs, "base").get(`${tx}:43`)) ?? s.amt;
  const toBuyer = BigInt(logs.find((l) => l.index === 55)!.data);
  assert.equal(got, toBuyer, `the buy is the ${toBuyer} the buyer got, not ${got}`);
  // with no move of the swap's sender read (55 left out), the hook's claims are its cut; a claim the hook did not have
  // minted (another caller) is none
  const noSender = logs.filter((l) => l.index !== 55);
  assert.equal(hookTakes(pool, noSender, "base").get(`${tx}:43`), BigInt(`0x${logs.find((l) => l.index === 52)!.data.slice(66)}`));
  const other = noSender.map((l) => (l.index === 52 ? { ...l, data: `0x${"0".repeat(24)}${"9".repeat(40)}${l.data.slice(66)}` } : l));
  assert.equal(hookTakes(pool, other, "base").get(`${tx}:43`), undefined);
});

test("card helper-v4-hook-liquidity: a beforeSwap-only hook's take right after a pool call is the next swap's cut; its paying in there settles the call", () => {
  const pm = BASE_VENUES.poolManager;
  const coin = `0x${"c1".repeat(20)}`;
  const hook = `0x${"1".repeat(36)}0008`; // beforeSwap's return delta, no afterSwap
  const id = `0x${"ab".repeat(32)}`;
  const tx = `0x${"0e".repeat(32)}`;
  const w = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const amt = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const at = (index: number, address: string, topics: string[], data = "0x"): Log => ({ block: 9, index, tx, address, topics, data });
  const logs: Log[] = [
    at(1, pm, [TOPIC.initialize, id, w(`0x${"0".repeat(40)}`), w(coin)]),
    at(2, pm, [TOPIC.modifyLiquidity, id, w(hook)]),
    at(3, coin, [TOPIC.transfer, w(hook), w(pm)], amt(1_000n)), // the liquidity paid in
    at(4, coin, [TOPIC.transfer, w(pm), w(hook)], amt(30n)), // beforeSwap's fee taken
    at(5, pm, [TOPIC.swap4, id, w(`0x${"7".repeat(40)}`)], "0x"),
  ];
  const pool: Pool = { venue: "v4", id, token: coin, tokenIs0: false, quote: { kind: "eth", decimals: 18 }, hook };
  assert.equal(hookTakes(pool, logs, "base").get(`${tx}:5`), 30n, "the fee is the swap's cut, the liquidity is not");
  assert.equal(traderLeg({ side: "b", amt: 1_030n }, 30n), 1_000n);
  // the same moves for an afterSwap hook before its swap settle the call, as the launch's (today's rule)
  const afterHook = `0x${"1".repeat(36)}000c`;
  const relabel = (l: Log) => ({ ...l, topics: l.topics.map((t) => (t === w(hook) ? w(afterHook) : t)) });
  assert.equal(hookTakes({ ...pool, hook: afterHook }, logs.map(relabel), "base").get(`${tx}:5`), undefined);
});
