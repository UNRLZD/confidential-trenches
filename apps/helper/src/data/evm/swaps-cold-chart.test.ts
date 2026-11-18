// node --test apps/helper/src/data/evm/swaps-cold-chart.test.ts: an EVM chart with no bar of ours yet and GeckoTerminal's
// bars not read. Card evm-chart-opens-without-a-vendor-call: an answer of no bars is only for a token GeckoTerminal
// names none for. The budget's refusal and GeckoTerminal's own 429 answer the 429 with the wait, so the page keeps
// loading and reads again (apps/terminal/src/screens/token/candles.ts loadCandles), and the read waits in the queue
// (../gecko.ts createWanted) for the next free call, after which the chart is served from it; a read is tried in its
// turn even while the queue holds others; a read that fails is a 503. (Live run 42995547054 at 09:29:50Z read an empty
// 200 for a Base token GeckoTerminal charts, the page drawing its empty state.) Shapes from the deployed helper's
// minute lines on 10 Nov: the window filled by the lists and the stale lane with no vendor 429 (19:43-19:45Z), and one
// GeckoTerminal 429 after "pages base bars 3" (19:56Z).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open } from "../../../test/evm-swaps/base.ts";
import { geckoBudget, GT_LIMIT_PER_MIN, WINDOW_MS } from "../gecko.ts";

const T0 = Date.parse("2026-11-02T13:53:00Z");
const HOUR = Math.floor(T0 / 3_600_000) * 3_600;
const BARS = JSON.stringify({ data: { attributes: { ohlcv_list: [[HOUR - 3_600, 0.5, 0.6, 0.4, 0.55, 1000], [HOUR - 7_200, 0.45, 0.5, 0.4, 0.5, 900]] } } });

/** A planted timer: `run(t)` moves the clock to `t` and runs every timer due by then, in order. */
function timers(clock: { t: number }) {
  const due: { at: number; fn: () => void }[] = [];
  return {
    later: (fn: () => void, ms: number) => void due.push({ at: clock.t + ms, fn }),
    async run(t: number) {
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        if (due.length === 0 || due[0]!.at > t) break;
        const d = due.shift()!;
        clock.t = d.at;
        d.fn();
        for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
      }
      clock.t = t;
    },
  };
}

function cold(gtAnswer: (url: string) => Response, fill = 0) {
  const chain = fakeChain();
  const clock = { t: T0 };
  const gt: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (!url.includes("geckoterminal")) return chain.fetch(url, init);
    gt.push(url);
    return gtAnswer(url);
  }) as typeof chain.fetch;
  const budget = geckoBudget(() => clock.t);
  // the lists' and the stale lane's calls of the window, made just before
  if (fill > 0) budget.seed(Array.from({ length: fill }, () => clock.t - 1_000));
  const tm = timers(clock);
  const s = open(chain, clock, { fetch, gecko: budget, sleep: async () => undefined, later: tm.later });
  return { s, gt, clock, tm };
}

test("the budget's window full: a chart with no bar of ours answers 429 with the wait to the next call, never an empty 200; its read is queued and the next free call serves it", async () => {
  const { s, gt, tm } = cold(() => new Response(BARS, { status: 200 }), GT_LIMIT_PER_MIN);
  const a = await s.candles(ICNT, "1h", null, 500);
  assert.equal(a.status, 429, a.body);
  assert.equal(a.retryAfterS, WINDOW_MS / 1000 - 1, "the window's first call leaves it 74 s on");
  assert.deepEqual(gt, [], "no GeckoTerminal call while the window is full");
  // the window's calls leave it WINDOW_MS after they were made: the queued read takes the first free call
  await tm.run(T0 + WINDOW_MS);
  assert.equal(gt.length, 1, "the queued read made its call once the window had room");
  assert.match(gt[0]!, /\/ohlcv\/hour\?/);
  const b = await s.candles(ICNT, "1h", null, 500);
  s.stop();
  assert.equal(b.status, 200, b.body);
  assert.equal(JSON.parse(b.body).candles.length, 2, "served from the queued read");
  assert.equal(gt.length, 1, "and asks GeckoTerminal no more");
});

test("GeckoTerminal answers 429: a chart with no bar of ours answers 429 with GeckoTerminal's pause, never an empty 200, and the read waits it out in the queue", async () => {
  let n = 0;
  const { s, gt, tm } = cold(() => (n++ === 0 ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : new Response(BARS, { status: 200 })));
  const a = await s.candles(ICNT, "1h", null, 500);
  assert.deepEqual([a.status, a.retryAfterS], [429, 30], a.body);
  assert.equal(gt.length, 1);
  await tm.run(T0 + 29_000);
  assert.equal(gt.length, 1, "no call inside GeckoTerminal's pause");
  await tm.run(T0 + 31_000);
  assert.equal(gt.length, 2, "the queued read after the pause");
  const b = await s.candles(ICNT, "1h", null, 500);
  s.stop();
  assert.equal(JSON.parse(b.body).candles.length, 2);
});

test("GeckoTerminal fails: a chart with no bar of ours answers 503", async () => {
  const { s } = cold(() => new Response("{}", { status: 502 }));
  const a = await s.candles(ICNT, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 503, a.body);
});

test("GeckoTerminal answers with no bars: the chart truly has none, 200 with an empty list", async () => {
  const { s } = cold(() => new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [] } } }), { status: 200 }));
  const a = await s.candles(ICNT, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(JSON.parse(a.body).candles, []);
});

test("a listed token our reads find no pool of, GeckoTerminal's pool not read (the budget's window full): 429 with the wait, never an empty 200; its pool, then that pool's bars, are read in the queue", async () => {
  const chain = fakeChain();
  const NOPOOL = `0x${"34".repeat(20)}`;
  const GTPOOL = `0x${"56".repeat(20)}`;
  const gt: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.includes("geckoterminal")) {
      gt.push(url);
      if (url.includes("/pools?")) return new Response(JSON.stringify({ data: [{ attributes: { address: GTPOOL } }] }), { status: 200 });
      return new Response(BARS, { status: 200 });
    }
    const calls = JSON.parse(String(init.body)) as { id: number; method: string; params: { address?: string }[] }[];
    if (calls.every((c) => c.method === "eth_getLogs" && c.params[0]?.address === NOPOOL)) return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] }))), { status: 200 });
    return chain.fetch(url, init);
  }) as typeof chain.fetch;
  const clock = { t: T0 };
  const budget = geckoBudget(() => clock.t);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => clock.t - 1_000));
  const tm = timers(clock);
  const s = open(chain, clock, { fetch, gecko: budget, listed: async (t) => t === NOPOOL, pools: new Map(), sleep: async () => undefined, later: tm.later });
  const a = await s.candles(NOPOOL, "1h", null, 500);
  assert.equal(a.status, 429, a.body);
  assert.ok((a.retryAfterS ?? 0) >= 1);
  assert.deepEqual(gt, []);
  await tm.run(T0 + WINDOW_MS);
  assert.equal(gt.length, 2, gt.join("\n"));
  assert.match(gt[0]!, /\/tokens\/0x3434[0-9a-f]+\/pools\?/);
  assert.match(gt[1]!, new RegExp(`/pools/${GTPOOL}/ohlcv/hour\\?`));
  const b = await s.candles(NOPOOL, "1h", null, 500);
  s.stop();
  assert.equal(b.status, 200, b.body);
  assert.equal(JSON.parse(b.body).candles.length, 2, "GeckoTerminal's bars of its pool, served from the queued reads");
});

test("a cold read behind a queue that holds another's is tried in its turn, never answered empty untried (live run 42995547054: Base 0xb2000000...8c01 answered an empty 200 with no call made)", async () => {
  const chain = fakeChain();
  const NOPOOL = `0x${"34".repeat(20)}`;
  const GTPOOL = `0x${"56".repeat(20)}`;
  const gt: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.includes("geckoterminal")) {
      gt.push(url);
      if (url.includes("/pools?")) return new Response(JSON.stringify({ data: [{ attributes: { address: GTPOOL } }] }), { status: 200 });
      return new Response(BARS, { status: 200 });
    }
    const calls = JSON.parse(String(init.body)) as { id: number; method: string; params: { address?: string }[] }[];
    if (calls.every((c) => c.method === "eth_getLogs" && c.params[0]?.address === NOPOOL)) return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] }))), { status: 200 });
    return chain.fetch(url, init);
  }) as typeof chain.fetch;
  const clock = { t: T0 };
  const budget = geckoBudget(() => clock.t);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => clock.t - 1_000));
  const tm = timers(clock);
  const s = open(chain, clock, { fetch, gecko: budget, listed: async (t) => t === NOPOOL || t === ICNT, sleep: async () => undefined, later: tm.later });
  // ICNT's bars refused on the full window: queued
  assert.equal((await s.candles(ICNT, "1h", null, 500)).status, 429);
  // the window has room again before the queue's timer runs: the next cold page read takes its call itself
  clock.t = T0 + WINDOW_MS;
  const b = await s.candles(NOPOOL, "1h", null, 500);
  s.stop();
  assert.equal(b.status, 200, b.body);
  assert.equal(JSON.parse(b.body).candles.length, 2, "GeckoTerminal's pool, then its bars, read for this page now");
  assert.match(gt[0]!, /\/tokens\/0x3434[0-9a-f]+\/pools\?/);
});

test("card helper-listed-charts-own-reads: bars of ours with the history before them refused (the window full) say filling, never a short chart as the coin's whole; the queued read then serves the full chart, not filling (live run 43776130630: Base DRB 1 bar, src chain, after 9 reads)", async () => {
  const B = await import("../../../test/evm-swaps/base.ts");
  const chain = fakeChain();
  const head = B.REC.firstHead + 200;
  // the clock at the head's own time, so the bars before our first are in the past
  const T1 = B.timeMsOf(head) + 5_000;
  const clock = { t: T1 };
  const gt: string[] = [];
  // 300 1m bars before whatever time the read asks before
  const fetch = (async (url: string, init: RequestInit) => {
    if (!url.includes("geckoterminal")) return chain.fetch(url, init);
    gt.push(url);
    const before = Number(/before_timestamp=(\d+)/.exec(url)?.[1] ?? Math.floor(clock.t / 1000));
    const list = Array.from({ length: 300 }, (_, i) => [before - 60 * (i + 1), 1, 1, 1, 1, 10]);
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }), { status: 200 });
  }) as typeof chain.fetch;
  const budget = geckoBudget(() => clock.t);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => clock.t - 1_000));
  const tm = timers(clock);
  const s = open(chain, clock, { fetch, gecko: budget, sleep: async () => undefined, later: tm.later });
  chain.st.head = head;
  const a = JSON.parse((await s.candles(ICNT, "1m", null, 500)).body);
  assert.ok(a.own_from_s !== undefined && a.candles.length > 0 && a.candles.length < 50, `bars of ours alone: ${a.candles.length}`);
  assert.equal(a.src, "chain");
  assert.equal(a.filling, true, "short: its history refused, so filling");
  assert.deepEqual(gt, [], "no call while the window is full");
  await tm.run(T1 + WINDOW_MS);
  assert.equal(gt.length, 1, "the queued history read made its call");
  // the helper's tick, as its timer runs it every TICK_MS (the rig has none): a book no tick read for a minute is behind
  // the chain and its live chart says filling (card every-tape-and-chart-says-filling-behind-the-head, BEHIND_MAX)
  await s.tick();
  const b = JSON.parse((await s.candles(ICNT, "1m", null, 500)).body);
  s.stop();
  assert.equal(b.src, "chain,geckoterminal");
  assert.ok(b.candles.length >= 300, `${b.candles.length} bars`);
  assert.equal(b.filling, undefined, "full: not filling");
});

// card helper-listed-charts-own-reads round 3: no chart answer waits on GeckoTerminal while bars are held (the warm live
// run of 16 Nov 00:33Z: Base's listed charts p95 4,997 ms, Robinhood's 3,042 ms). One rule with the Solana charts.
test("card helper-listed-charts-own-reads: with a call free and GeckoTerminal slow (1.5 s), a chart's held bars answer at once and the read goes on; the next answer is the fresh read", async () => {
  let slow = false;
  // GeckoTerminal's slow answers come 1.5 s on; `answered` counts those that came
  let answered = 0;
  const answer = (async () => {
    if (slow) await new Promise((go) => setTimeout(go, 1_500)), answered++;
    return new Response(BARS, { status: 200 });
  }) as unknown as (url: string) => Response;
  const { s, clock, gt } = cold(answer);
  const first = await s.candles(ICNT, "1h", null, 500);
  assert.equal(first.status, 200, first.body);
  assert.ok(JSON.parse(first.body).candles.length > 0);
  clock.t += 2 * 3_600_000; // past every freshness of the bars held
  slow = true;
  const n = gt.length;
  const a = await s.candles(ICNT, "1h", null, 500);
  assert.equal(a.status, 200, a.body);
  assert.equal(answered, 0, "the held bars' answer waited on GeckoTerminal's");
  assert.deepEqual(JSON.parse(a.body).candles, JSON.parse(first.body).candles, "the held bars");
  assert.equal(gt.length, n + 1, "the read goes on");
  await new Promise((go) => setTimeout(go, 1_700));
  slow = false;
  const n2 = gt.length;
  const b = await s.candles(ICNT, "1h", null, 500);
  assert.equal(b.status, 200);
  assert.equal(gt.length, n2, "the next answer is the read that went on, with no call of its own");
});
