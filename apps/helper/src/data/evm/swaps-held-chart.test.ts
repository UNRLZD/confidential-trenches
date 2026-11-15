// node --test apps/helper/src/data/evm/swaps-held-chart.test.ts: card helper-listed-charts-own-reads. A listed EVM chart
// is held ahead (warm: the lists name each pool, its bars read once in GeckoTerminal's keyless "ahead" lane), and a book
// that opens past its bound (OPEN_BOUND_MS) is served those held bars, dated, where before it answered no bars and
// `filling` (live 15 Nov 22:4xZ: Base listed charts' cold open p50 5.8 s, past the route's 5 s bound, 0 bars).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, POOL_ICNT } from "../../../test/evm-swaps/base.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { geckoBudget } from "../gecko.ts";
import { OPEN_BOUND_MS, WARM_TF } from "./swaps.ts";

const T0 = Date.parse("2026-11-15T22:40:00Z");
const Q = Math.floor(T0 / 900_000) * 900;
const BARS = JSON.stringify({ data: { attributes: { ohlcv_list: [[Q - 900, 0.5, 0.6, 0.4, 0.55, 1000], [Q - 1_800, 0.45, 0.5, 0.4, 0.5, 900]] } } });

/** Base's providers each answer `rpcMs` late (virtual), GeckoTerminal at once with two 15m bars. */
function rig(rpcMs: number) {
  const chain = fakeChain();
  const gt: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.includes("geckoterminal")) {
      gt.push(url);
      return new Response(BARS, { status: 200 });
    }
    await new Promise((go) => setTimeout(go, rpcMs));
    return chain.fetch(url, init);
  }) as typeof chain.fetch;
  const s = open(chain, { t: T0 }, { fetch, now: () => Date.now(), gecko: geckoBudget(() => Date.now()), sleep: async () => undefined, later: () => undefined });
  return { s, gt };
}

test("card helper-listed-charts-own-reads: a listed chart held ahead is served, dated, while its book opens past its bound", async () => {
  const { value } = await onVirtualTime(T0, async () => {
    const { s, gt } = rig(OPEN_BOUND_MS * 2);
    try {
      const warmed = await s.warm({ [ICNT]: POOL_ICNT.id });
      const a = await s.candles(ICNT, WARM_TF, null, 500);
      return { warmed, gt: [...gt], a };
    } finally {
      s.stop();
    }
  });
  assert.equal(value.warmed, POOL_ICNT.id, "warm read the pool the lists name");
  assert.equal(value.gt.length, 1, "one GeckoTerminal call");
  assert.match(value.gt[0]!, new RegExp(`/pools/${POOL_ICNT.id}/ohlcv/minute\\?aggregate=15`));
  const body = JSON.parse(value.a.body);
  assert.equal(value.a.status, 200, value.a.body);
  assert.equal(body.candles.length, 2, `the held bars, not none (filling ${body.filling})`);
  assert.equal(body.src, "geckoterminal");
  assert.ok(typeof body.as_of_ms === "number" && body.as_of_ms <= Date.now(), "dated when they were read");
});

test("card helper-listed-charts-own-reads: warm reads a pool once, and a chart held is not read again", async () => {
  const { value } = await onVirtualTime(T0, async () => {
    const { s, gt } = rig(10);
    try {
      const first = await s.warm({ [ICNT]: POOL_ICNT.id });
      const again = await s.warm({ [ICNT]: POOL_ICNT.id });
      const bad = await s.warm({ [ICNT]: "https://evil.test/" });
      return { first, again, bad, gt: gt.length };
    } finally {
      s.stop();
    }
  });
  assert.deepEqual(value, { first: POOL_ICNT.id, again: null, bad: null, gt: 1 });
});
