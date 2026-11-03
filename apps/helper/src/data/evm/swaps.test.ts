// node --test apps/helper/src/data/evm/swaps.test.ts: the Base swap reader (swaps.ts). The decoders on logs as the chain
// writes them; recorded real Base logs (a v3 pool quoted in USDC, an Aerodrome v2 pool quoted in WETH, and the
// ETH price pool) read tick by tick, as the helper reads live, in steps of 1, 3 and 11 blocks equals the same logs
// rebuilt in one go; a lagging, refusing, lying or forking provider changes nothing it should not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBook, TFS, type Event } from "../candles.ts";
import { fakeChain, ICNT, open, POOL_ICNT, POOL_VVV, REC, timeOf, toLog, URLS, VVV, KNOWN } from "./swaps.fake.ts";
import { BASE_VENUES, createSwaps, decodeRef, decodeSwap, parseLog, parseLogs, REF_POOL_ID, sameLogs, swapFilter, TOPIC, v4Key, type Log, type Pool } from "./swaps.ts";

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
