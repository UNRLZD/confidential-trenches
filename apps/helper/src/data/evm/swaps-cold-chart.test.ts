// node --test apps/helper/src/data/evm/swaps-cold-chart.test.ts: card market-reads-hold-under-load. An EVM chart with
// no bar of ours yet (a book opened a minute ago) and GeckoTerminal's bars not read is never a 200 with no bars: the
// budget's refusal is a 429 naming its wait, GeckoTerminal's own 429 too, a failed read a 503, so the page reads again.
// Only GeckoTerminal answering with no bars is an empty chart. Shapes from the deployed helper's minute lines on 10 Nov:
// the window filled by the lists and the stale lane with no vendor 429 (19:43-19:45Z), and one GeckoTerminal 429 after
// "pages base bars 3" (19:56Z), when Base 0xfbb75a59's 1h answered 200 with no bars.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open } from "../../../test/evm-swaps/base.ts";
import { geckoBudget, GT_LIMIT_PER_MIN } from "../gecko.ts";

const T0 = Date.parse("2026-11-02T13:53:00Z");

function cold(gtAnswer: () => Response, fill = 0) {
  const chain = fakeChain();
  const clock = { t: T0 };
  const gt: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (!url.includes("geckoterminal")) return chain.fetch(url, init);
    gt.push(url);
    return gtAnswer();
  }) as typeof chain.fetch;
  const budget = geckoBudget(() => clock.t);
  // the lists' and the stale lane's calls of the window, made just before
  if (fill > 0) budget.seed(Array.from({ length: fill }, () => clock.t - 1_000));
  const s = open(chain, clock, { fetch, gecko: budget, sleep: async () => undefined });
  return { s, gt };
}

test("the budget's window full (the lists and the stale lane, no vendor 429): a chart with no bar of ours answers 429 with its wait, never 200 with no bars", async () => {
  const { s, gt } = cold(() => new Response("{}", { status: 500 }), GT_LIMIT_PER_MIN);
  const a = await s.candles(ICNT, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 429, a.body);
  assert.ok((a.retryAfterS ?? 0) >= 1, "names its wait");
  assert.equal(a.why, "geckoterminal budget");
  assert.deepEqual(gt, [], "no GeckoTerminal call");
});

test("GeckoTerminal answers 429: a chart with no bar of ours answers 429, never 200 with no bars", async () => {
  const { s, gt } = cold(() => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
  const a = await s.candles(ICNT, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 429, a.body);
  assert.equal(a.why, "geckoterminal 429");
  assert.equal(gt.length, 1);
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

test("a listed token our reads find no pool of, GeckoTerminal's pool not read (the budget's window full): 429 with its wait, never 200 with no bars", async () => {
  const chain = fakeChain();
  const NOPOOL = `0x${"34".repeat(20)}`;
  const fetch = (async (url: string, init: RequestInit) => {
    const calls = JSON.parse(String(init.body)) as { id: number; method: string; params: { address?: string }[] }[];
    if (calls.every((c) => c.method === "eth_getLogs" && c.params[0]?.address === NOPOOL)) return new Response(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] }))), { status: 200 });
    return chain.fetch(url, init);
  }) as typeof chain.fetch;
  const clock = { t: T0 };
  const budget = geckoBudget(() => clock.t);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => clock.t - 1_000));
  const s = open(chain, clock, { fetch, gecko: budget, listed: async (t) => t === NOPOOL, pools: new Map(), sleep: async () => undefined });
  const a = await s.candles(NOPOOL, "1h", null, 500);
  s.stop();
  assert.equal(a.status, 429, a.body);
  assert.equal(a.why, "geckoterminal budget");
});
