// node --test apps/helper/src/data/evm/swaps-cold-chart.test.ts: an EVM chart with no bar of ours yet and GeckoTerminal's
// bars not read. Card evm-chart-opens-without-a-vendor-call: a listed token never answers 429 on candles. The budget's
// refusal and GeckoTerminal's own 429 are answered at once from our own reads (an empty chart the page reads again), and
// the read waits in the queue (../gecko.ts createWanted) for the next free call, after which the chart is served from
// it; a read that fails is a 503, so the page retries; GeckoTerminal answering with no bars is an empty chart. (At card
// market-reads-hold-under-load these answered 429; the helper's live run at 06:58Z on 11 Nov then read 429 for Base
// candles on every cold token, the budget being 5 calls in 75 s for the whole server.) Shapes from the deployed helper's
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

test("the budget's window full: a chart with no bar of ours answers 200 from our own reads with no bars, never a 429; its read is queued and the next free call serves it", async () => {
  const { s, gt, tm } = cold(() => new Response(BARS, { status: 200 }), GT_LIMIT_PER_MIN);
  const a = await s.candles(ICNT, "1h", null, 500);
  assert.equal(a.status, 200, a.body);
  assert.equal(a.src, "chain");
  assert.deepEqual(JSON.parse(a.body).candles, []);
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

test("GeckoTerminal answers 429: a chart with no bar of ours answers 200 with no bars, never a 429, and the read waits out GeckoTerminal's pause in the queue", async () => {
  let n = 0;
  const { s, gt, tm } = cold(() => (n++ === 0 ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : new Response(BARS, { status: 200 })));
  const a = await s.candles(ICNT, "1h", null, 500);
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(JSON.parse(a.body).candles, []);
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

test("a listed token our reads find no pool of, GeckoTerminal's pool not read (the budget's window full): 200 with no bars, never a 429; its pool, then that pool's bars, are read in the queue", async () => {
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
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(JSON.parse(a.body).candles, []);
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
