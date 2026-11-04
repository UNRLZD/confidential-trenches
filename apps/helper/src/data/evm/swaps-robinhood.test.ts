// node --test apps/helper/src/data/evm/swaps-robinhood.test.ts: the swap reader on Robinhood (swaps.ts, card
// index-evm-swaps-2). Recorded real Robinhood logs (a Pons v2 curve quoted in native ETH, a v4 pool quoted in native ETH,
// and the ETH / USDG price pool) read tick by tick in steps of 1, 3 and 11 blocks equal the same logs rebuilt in one go;
// swaps are timed by the block times two providers logged alike, never by a clock; the curve is found from the Pons
// factory's own record; no read asks more than the 100 blocks the keyless providers take.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBook, TFS, type Event } from "../candles.ts";
import { CURVE_TOKEN, fakeChain, KNOWN, MAG, open, POOL_CURVE, POOL_MAG, REC, toLog } from "../../../test/evm-swaps/robinhood.ts";
import { decodeRef, decodeSwap, ROBINHOOD_VENUES, TOPIC, VENUES, type Pool } from "./swaps.ts";

function rebuild(pool: Pool, upTo: number) {
  const src = pool === POOL_CURVE ? REC.logs.curve : REC.logs.v4;
  const events: Event[] = [];
  for (const l of src.map(toLog)) {
    const s = l.block <= upTo ? decodeSwap(pool, l, "robinhood") : null;
    if (s !== null) events.push({ ...s, t: l.t! });
  }
  for (const l of REC.logs.ref.map(toLog)) {
    const r = l.block <= upTo ? decodeRef(l, "robinhood") : null;
    if (r !== null) events.push(r);
  }
  events.sort((a, b) => a.block - b.block || a.index - b.index);
  const book = createBook({ decimals: 18, quote: pool.quote });
  book.ingest(REC.firstHead, events, upTo);
  return book;
}
const bodyOf = async (p: Promise<{ body: string }>) => JSON.parse((await p).body);
/** The head a first open is read at: its cold window ends at the recording's 600th block. */
const START = REC.firstHead + 599;

test("the recording is real Robinhood logs: 2,000 blocks, curve buys and sells, a busy v4 pool and the ETH price, every log with a block time that never goes back", () => {
  assert.ok(REC.lastHead - REC.firstHead >= 1_999);
  const kinds = new Set(REC.logs.curve.map((l) => l.t[0]));
  assert.ok(kinds.has(TOPIC.curveBuy) && kinds.has(TOPIC.curveSell), "both curve events");
  assert.ok(REC.logs.curve.length >= 10 && REC.logs.v4.length > 100 && REC.logs.ref.length > 20);
  for (const src of Object.values(REC.logs)) {
    let last = 0;
    for (const l of [...src].sort((a, b) => a.b - b.b || a.i - b.i)) {
      assert.ok(l.ts >= last && l.ts > 1_700_000_000, `block ${l.b}`);
      last = l.ts;
    }
  }
  // the factory's record names the curve, the token and native ETH as the quote, and exists
  const w = (i: number) => REC.launchedRecord.slice(2 + 64 * i, 2 + 64 * (i + 1));
  assert.equal(`0x${w(0).slice(24)}`, CURVE_TOKEN);
  assert.equal(`0x${w(1).slice(24)}`, REC.curve);
  assert.equal(BigInt(`0x${w(4)}`), 0n);
  assert.equal(BigInt(`0x${w(14)}`), 1n);
});

test("a Pons curve's trades: CurveBuy is a buy of tokensOut for quoteIn, CurveSell a sell of tokensIn for quoteOut (recorded logs)", () => {
  const buy = REC.logs.curve.map(toLog).find((l) => l.topics[0] === TOPIC.curveBuy)!;
  const sell = REC.logs.curve.map(toLog).find((l) => l.topics[0] === TOPIC.curveSell)!;
  const word = (d: string, i: number) => BigInt(`0x${d.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  assert.deepEqual(decodeSwap(POOL_CURVE, buy, "robinhood"), { kind: "swap", block: buy.block, index: buy.index, tx: buy.tx, side: "b", amt: word(buy.data, 1), quote: word(buy.data, 0) });
  assert.deepEqual(decodeSwap(POOL_CURVE, sell, "robinhood"), { kind: "swap", block: sell.block, index: sell.index, tx: sell.tx, side: "s", amt: word(sell.data, 0), quote: word(sell.data, 1) });
  // another curve's log, a short data, another event: refused
  assert.equal(decodeSwap({ ...POOL_CURVE, id: `0x${"12".repeat(20)}` }, buy, "robinhood"), null);
  assert.equal(decodeSwap(POOL_CURVE, { ...buy, data: buy.data.slice(0, -64) }, "robinhood"), null);
  assert.equal(decodeSwap(POOL_CURVE, { ...buy, topics: [TOPIC.swap3, ...buy.topics.slice(1)] }, "robinhood"), null);
});

const reading = (steps: number) =>
  test(`a recorded stretch of Robinhood read live, ${steps} block${steps === 1 ? "" : "s"} a tick, gives the bars and tape of the same logs rebuilt in one go (a Pons curve and a v4 pool, both in ETH)`, async () => {
    const chain = fakeChain();
    chain.st.head = START;
    const s = open(chain);
    await s.candles(CURVE_TOKEN, "1m", null, 500);
    await s.candles(MAG, "1m", null, 500);
    let head = START;
    while (head < REC.lastHead) {
      head = Math.min(REC.lastHead, head + steps);
      chain.st.head = head;
      await s.tick();
    }
    s.stop();
    for (const [token, pool] of [[CURVE_TOKEN, POOL_CURVE], [MAG, POOL_MAG]] as const) {
      const whole = rebuild(pool, REC.lastHead);
      let bars = 0;
      for (const tf of TFS.filter((x) => x !== "1s")) {
        const live = await bodyOf(s.candles(token, tf, null, 500));
        assert.deepEqual(live.candles, whole.candles(tf, null, 500), `${token} ${tf}`);
        bars += live.candles.length;
      }
      assert.ok(bars > 6, "real bars, not an empty match");
      const tape = await bodyOf(s.trades(token, 50));
      assert.ok(tape.trades.length > 5);
      assert.deepEqual(tape.trades.map((t: { tx: string; side: string; usd: string; amt: string; t_ms: number }) => [t.tx, t.side, t.usd, t.amt, t.t_ms]), whole.tape(50).map((t) => [t.tx, t.side, t.usd, t.amt, t.t_ms]), `${token} tape`);
    }
    assert.ok(Math.max(...chain.st.spans) <= 100, "no read asks more than 100 blocks");
  });
for (const n of [1, 3, 11]) reading(n);

test("a Pons token's main pool is its curve, named by the factory's own record (no pool given), and its first read is the discovery's", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const s = open(chain, undefined, { pools: new Map() });
  const tape = await bodyOf(s.trades(CURVE_TOKEN, 50));
  s.stop();
  const whole = rebuild(POOL_CURVE, REC.lastHead);
  // the discovery reads the chain's cold window: the swaps the rebuild has in it
  const inWindow = whole.tape(50).filter((t) => t.block > REC.lastHead - VENUES.robinhood.cold);
  assert.ok(inWindow.length > 0, "the window holds curve trades");
  assert.deepEqual(tape.trades.map((t: { tx: string; usd: string }) => [t.tx, t.usd]), inWindow.map((t) => [t.tx, t.usd]));
  // a listed token no factory recorded and with no pool: an empty tape from our own reads, never a guess and never a 404
  const t = open(chain, undefined, { pools: new Map() });
  const none = await t.trades(`0x${"34".repeat(20)}`, 10);
  t.stop();
  assert.equal(none.status, 200, none.body);
  assert.deepEqual(JSON.parse(none.body).trades, []);
  assert.equal(JSON.parse(none.body).src, "chain");
});

test("block times: a provider that logs blockTimestamp 0x0 (as rpc.mainnet.chain.robinhood.com does) is outvoted by the two that agree; two that log none serve nothing", async () => {
  const chain = fakeChain();
  chain.st.head = START;
  chain.st.faults.set("https://a.test", { zeroTime: true });
  const s = open(chain);
  const tape = await bodyOf(s.trades(CURVE_TOKEN, 50));
  s.stop();
  const whole = rebuild(POOL_CURVE, START);
  assert.deepEqual(tape.trades.map((t: { t_ms: number }) => t.t_ms), whole.tape(50).map((t) => t.t_ms));
  assert.ok(tape.trades.every((t: { t_ms: number }) => t.t_ms > 1_700_000_000_000));

  const both = fakeChain();
  both.st.head = START;
  both.st.faults.set("https://a.test", { zeroTime: true });
  both.st.faults.set("https://b.test", { zeroTime: true });
  both.st.faults.set("https://c.test", { skewTime: true });
  const z = open(both);
  const r = await z.trades(CURVE_TOKEN, 50);
  z.stop();
  assert.equal(r.status, 503, "no time two providers agree on but 0: nothing served");

  // two providers agree on times that go back: not a chain's, nothing served
  const back = fakeChain();
  back.st.head = START;
  for (const u of ["https://a.test", "https://b.test", "https://c.test"]) back.st.faults.set(u, { backTime: true });
  const b = open(back);
  const rb = await b.trades(CURVE_TOKEN, 50);
  b.stop();
  assert.equal(rb.status, 503, "times that go back: nothing served");
});

test("a Pons record the providers fail to answer is no answer (503, read again), never kept as no pool: the next ask finds the curve", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  let failing = true;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const calls = JSON.parse(String(init.body)) as { id: number; method: string; params: { to?: string }[] }[];
    if (failing && calls.some((c) => c.method === "eth_call" && c.params[0]?.to === ROBINHOOD_VENUES.ponsV2))
      return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "execution timeout" } }))), { status: 200 });
    return chain.fetch(url, init);
  };
  const s = open(chain, undefined, { fetch, pools: new Map() });
  const first = await s.trades(CURVE_TOKEN, 50);
  failing = false;
  const next = await s.trades(CURVE_TOKEN, 50);
  s.stop();
  assert.equal(first.status, 503, first.body);
  assert.equal(next.status, 200, next.body);
  assert.ok(JSON.parse(next.body).trades.length > 0, "the curve's trades are served");
});

// card helper-rpc-hex-case: robinhood-testnet.drpc.org writes hex in upper case (eth_chainId "0xB626", read 3 Nov 23:07Z)
test("providers that write hex in upper case: the Pons curve is found and its tape is the same, trade for trade, as from lower-case ones", async () => {
  const up = (v: unknown): unknown =>
    typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? `0x${v.slice(2).toUpperCase()}` : Array.isArray(v) ? v.map(up) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "jsonrpc" ? x : up(x)])) : v;
  const tapeWith = async (upper: readonly string[]) => {
    const chain = fakeChain();
    chain.st.head = REC.lastHead;
    const fetch = chain.fetch;
    let seen = 0;
    const c = {
      ...chain,
      fetch: async (url: string, init: RequestInit) => {
        const r = await fetch(url, init);
        if (!upper.includes(url) || r.status !== 200) return r;
        const text = JSON.stringify(up(await r.json()));
        if (/0x[0-9A-F]*[A-F]/.test(text)) seen++;
        return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const s = open(c, undefined, { pools: new Map() });
    const tape = await bodyOf(s.trades(CURVE_TOKEN, 50));
    s.stop();
    return { tape, seen };
  };
  const lower = await tapeWith([]);
  assert.ok(lower.tape.trades.length > 0);
  const one = await tapeWith(["https://a.test"]);
  assert.ok(one.seen > 0, "the upper-case provider answered");
  assert.deepEqual(one.tape.trades, lower.tape.trades, "one provider in upper case agrees with the others");
  const all = await tapeWith(["https://a.test", "https://b.test", "https://c.test"]);
  assert.deepEqual(all.tape.trades, lower.tape.trades, "every provider in upper case");
});

// card app-console-429: Robinhood's window was 3,000 blocks, its last 306 s (2026-11-04 12:59Z), so a token quiet for five
// minutes answered an empty chart and tape though it had a pool and trades; the window is now COLD_S on every chain,
// walked newest first a step at a time
test("a token quiet for longer than a step (its last trades 5,000 blocks back) is still found and its tape served: the walk goes back to COLD_S", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead + 5_000;
  const s = open(chain, undefined, { pools: new Map() });
  const tape = await bodyOf(s.trades(CURVE_TOKEN, 50));
  s.stop();
  const whole = rebuild(POOL_CURVE, REC.lastHead);
  assert.ok(whole.tape(50).length > 0, "the recording holds curve trades");
  assert.deepEqual(tape.trades.map((t: { tx: string }) => t.tx), whole.tape(50).map((t) => t.tx), "every recorded curve trade, 5,000 blocks back");
  assert.ok(VENUES.robinhood.cold * 102 >= 1_200_000, "the window is 20 minutes of Robinhood's 102 ms blocks");
});

test("an active token stops after its first step: its first read asks no more spans than before the wider window", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const s = open(chain);
  const tape = await bodyOf(s.trades(MAG, 50));
  s.stop();
  assert.equal(tape.trades.length, 50, "a full tape");
  const step = VENUES.robinhood.step / VENUES.robinhood.span;
  const ref = (VENUES.robinhood.step + VENUES.robinhood.refBack) / VENUES.robinhood.span;
  // every range is asked of two providers that must agree
  const asked = chain.st.spans.length / 2;
  assert.ok(asked <= step + ref + 1, `${asked} getLogs ranges, at most one step (${step}), the ETH price's first read (${ref}) and the head's`);
  assert.ok(asked < VENUES.robinhood.cold / VENUES.robinhood.span, "never the whole window");
});

test("a listed token our reads find no pool of: its candles are GeckoTerminal's bars of its top pool, src geckoterminal, dated by their read; with GeckoTerminal silent, the empty chart as before", async () => {
  const { readFileSync } = await import("node:fs");
  const FX = JSON.parse(readFileSync(new URL("../solana/fixtures/token-page.json", import.meta.url), "utf8"));
  const { geckoBudget } = await import("../gecko.ts");
  const { GT_BASE } = await import("./lists.ts");
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const clock = { t: Date.parse("2026-11-02T13:53:00Z") };
  const gtUrls: string[] = [];
  let gtUp = true;
  const fetch = async (url: string, init: RequestInit) => {
    if (!url.startsWith(GT_BASE)) return chain.fetch(url, init);
    gtUrls.push(url);
    if (!gtUp) return new Response("down", { status: 503 });
    if (url.includes("/pools?page=1")) return new Response(JSON.stringify({ data: [{ attributes: { address: `0x${"ab".repeat(32)}` } }] }), { status: 200 });
    return new Response(JSON.stringify(FX.gt_ohlcv), { status: 200 });
  };
  const s = open(chain, clock, { pools: new Map(), fetch: fetch as never, gecko: geckoBudget(() => clock.t) });
  const token = `0x${"34".repeat(20)}`;
  const a = await s.candles(token, "1m", null, 60);
  assert.equal(a.status, 200, a.body);
  const c = JSON.parse(a.body);
  assert.deepEqual([Object.keys(c), c.src, a.src, c.as_of_ms, a.asOfMs], [["tf", "candles", "src", "as_of_ms"], "geckoterminal", "geckoterminal", clock.t, clock.t]);
  assert.ok(c.candles.length > 0, "GeckoTerminal's bars");
  assert.ok(gtUrls.some((u) => u.includes(`/pools/0x${"ab".repeat(32)}/ohlcv/`)), "of the top pool GeckoTerminal names");
  const tape = JSON.parse((await s.trades(token, 10)).body);
  assert.deepEqual([tape.trades, tape.src], [[], "chain"], "the tape is ours alone: empty, never a vendor's");
  const quiet = open(chain, clock, { pools: new Map(), fetch: ((u: string, i: RequestInit) => ((gtUp = false), fetch(u, i))) as never, gecko: geckoBudget(() => clock.t) });
  const e = JSON.parse((await quiet.candles(`0x${"35".repeat(20)}`, "1m", null, 60)).body);
  assert.deepEqual([e.candles, e.src], [[], "chain"], "GeckoTerminal silent: the empty chart");
  s.stop();
  quiet.stop();
});

test("card helper-chart-fresh: a listed token with no pool of ours, its GeckoTerminal bars past their hour while the lists hold the budget at the refresh lane's room: the re-read is a page read and the chart is dated now, never its first read", async () => {
  const { readFileSync } = await import("node:fs");
  const FX = JSON.parse(readFileSync(new URL("../solana/fixtures/token-page.json", import.meta.url), "utf8"));
  const { geckoBudget, GT_LIMIT_PER_MIN, PAGE_RESERVE, WINDOW_MS } = await import("../gecko.ts");
  const { GT_BASE } = await import("./lists.ts");
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const clock = { t: Date.parse("2026-11-02T13:53:00Z") };
  const fetch = async (url: string, init: RequestInit) => {
    if (!url.startsWith(GT_BASE)) return chain.fetch(url, init);
    if (url.includes("/pools?page=1")) return new Response(JSON.stringify({ data: [{ attributes: { address: `0x${"ab".repeat(32)}` } }] }), { status: 200 });
    return new Response(JSON.stringify(FX.gt_ohlcv), { status: 200 });
  };
  const budget = geckoBudget(() => clock.t);
  const s = open(chain, clock, { pools: new Map(), fetch: fetch as never, gecko: budget });
  const token = `0x${"34".repeat(20)}`;
  const first = JSON.parse((await s.candles(token, "1m", null, 60)).body);
  assert.equal(first.as_of_ms, clock.t, "the first read, dated now");
  for (const hours of [2, 3, 4]) {
    clock.t = Date.parse("2026-11-02T13:53:00Z") + hours * 3_600_000; // past GT_FRESH_MS and the pool's 10 minutes
    // the EVM lists keep the window at what they may take: every call but PAGE_RESERVE
    for (let i = 0; i < GT_LIMIT_PER_MIN - PAGE_RESERVE; i++) assert.equal(budget.take("lists"), true);
    const again = await s.candles(token, "1m", null, 60);
    assert.equal(again.status, 200, again.body);
    assert.equal(JSON.parse(again.body).as_of_ms, clock.t, `${hours} h on, the bars are read again, not served from ${new Date(first.as_of_ms).toISOString()}`);
    clock.t += WINDOW_MS;
  }
  s.stop();
});

test("card helper-chart-fresh: GeckoTerminal history before a time held past its hour stays a refresh: with the window at the refresh lane's room it is served as held, no call made, and a cold token's first read finds its calls", async () => {
  const { readFileSync } = await import("node:fs");
  const FX = JSON.parse(readFileSync(new URL("../solana/fixtures/token-page.json", import.meta.url), "utf8"));
  const { geckoBudget, GT_LIMIT_PER_MIN, PAGE_RESERVE } = await import("../gecko.ts");
  const { GT_BASE } = await import("./lists.ts");
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const start = Date.parse("2026-11-02T13:53:00Z");
  const clock = { t: start };
  const ohlcv: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    if (!url.startsWith(GT_BASE)) return chain.fetch(url, init);
    if (url.includes("/pools?page=1")) return new Response(JSON.stringify({ data: [{ attributes: { address: `0x${"ab".repeat(32)}` } }] }), { status: 200 });
    ohlcv.push(url);
    return new Response(JSON.stringify(FX.gt_ohlcv), { status: 200 });
  };
  const budget = geckoBudget(() => clock.t);
  const s = open(chain, clock, { pools: new Map(), fetch: fetch as never, gecko: budget });
  const before = Math.floor(start / 1000) - 600;
  const first = JSON.parse((await s.candles(`0x${"34".repeat(20)}`, "1m", before, 60)).body);
  assert.ok(first.candles.length > 0 && ohlcv.length === 1);
  clock.t = start + 2 * 3_600_000;
  for (let i = 0; i < GT_LIMIT_PER_MIN - PAGE_RESERVE; i++) assert.equal(budget.take("lists"), true);
  const held = JSON.parse((await s.candles(`0x${"34".repeat(20)}`, "1m", before, 60)).body);
  assert.deepEqual([held.candles, ohlcv.length], [first.candles, 1], "the history held is served, not read again");
  const cold = await s.candles(`0x${"35".repeat(20)}`, "1m", null, 60);
  assert.equal(cold.status, 200, cold.body);
  assert.equal(JSON.parse(cold.body).src, "geckoterminal", "a cold token's first read finds its calls");
  s.stop();
});
