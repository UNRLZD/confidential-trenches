// node --test apps/helper/src/data/evm/handover.test.ts: card market-reads-hold-under-load. A deploy's new helper takes
// over the EVM token pages' GeckoTerminal answers the old one held (evm/token.ts state, evm/swaps.ts state, through the
// warm file, data/warm.ts), so its first holders and chart reads are served from them on a budget the old helper spent,
// with their own read times; the state is hostile input: bounded, each entry checked, a state that fails any check
// restores nothing. Live run 42887823106 (helper at 73d07e68, 19:44Z, two minutes after the deploy): Base and Robinhood
// holders answered 429 in 130 ms, nothing called, the old helper's info not handed over.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeChain, open } from "../../../test/evm-swaps/base.ts";
import { geckoBudget, GT_LIMIT_PER_MIN, GT_SERVE_MS } from "../gecko.ts";
import { evmMarketOf, readWarm, restoreEvmMarket, writeWarm } from "../warm.ts";
import { GT_BASE } from "./lists.ts";
import { HANDOVER_ENTRIES_MAX } from "./swaps.ts";
import { createEvmToken, INFO_HANDOVER_MAX, INFO_SERVE_MS } from "./token.ts";

type Fixture = { recorded_at: string; lists_body: string; info: Record<string, unknown> };
const FX = JSON.parse(readFileSync(new URL("./fixtures/token-info-base.json", import.meta.url), "utf8")) as Fixture;
const NOW = Date.parse(FX.recorded_at);
const COIN = "0x2df14792e7b9c5cc8e9a1eb37140533b32fb8d99";
const LISTS = (() => {
  const snap = JSON.parse(FX.lists_body) as { as_of_ms: number; lists: Record<string, { token: string }[]> };
  const tokens = new Set(Object.values(snap.lists).flat().map((r) => r.token));
  return { get: async () => ({ status: 200, body: FX.lists_body, asOfMs: snap.as_of_ms }), listed: async (t: string) => tokens.has(t) };
})();

/** A helper's EVM token part on its own clock and budget; `calls` counts GeckoTerminal's. */
function tokenPart(clock: { t: number }, spent = false) {
  const gecko = geckoBudget(() => clock.t);
  if (spent) gecko.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => clock.t - 1_000));
  let calls = 0;
  const fetch = async (url: string): Promise<Response> => {
    calls++;
    const a = FX.info[/tokens\/(0x[0-9a-f]{40})\/info$/.exec(url)![1]!];
    return new Response(JSON.stringify(a), { status: 200 });
  };
  const part = createEvmToken("base", { lists: LISTS, gecko, fetch: fetch as never, now: () => clock.t, sleep: async () => undefined });
  return { part, calls: () => calls };
}

test("a holders read the old helper served is served by the next one on a spent budget, dated by the old read, with no call", async () => {
  const clock = { t: NOW };
  const old = tokenPart(clock);
  const first = await old.part.holders(COIN);
  assert.equal(first.status, 200, first.body);
  const handed = JSON.parse(JSON.stringify(old.part.state()));
  clock.t += 120_000; // the deploy: two minutes on, the new helper's budget spent by the old one's calls
  const next = tokenPart(clock, true);
  assert.equal(next.part.restore(handed), true);
  const h = await next.part.holders(COIN);
  assert.equal(h.status, 200, h.body);
  assert.equal(JSON.parse(h.body).as_of_ms, JSON.parse(first.body).as_of_ms, "the old read's time, never now");
  assert.equal(h.asOfMs, first.asOfMs);
  assert.equal(next.calls(), 0, "no GeckoTerminal call");
});

test("a handed-over info state that fails any check restores nothing: a read time ahead, past INFO_SERVE_MS, a value out of range, a bad address, too many entries", async () => {
  const clock = { t: NOW };
  const old = tokenPart(clock);
  await old.part.holders(COIN);
  const good = JSON.parse(JSON.stringify(old.part.state())) as [string, { info: Record<string, unknown>; at: number }][];
  const filler: [string, { info: string; at: number }] = [`0x${"77".repeat(20)}`, { info: "none", at: NOW }];
  const bad: [string, unknown][] = [
    ["a read time ahead of now", [...good, [filler[0], { info: "none", at: NOW + 60_000 }]]],
    ["past INFO_SERVE_MS", [[good[0]![0], { ...good[0]![1], at: NOW - INFO_SERVE_MS }]]],
    ["holders below 0", [[good[0]![0], { ...good[0]![1], info: { ...good[0]![1].info, holders: -1 } }]]],
    ["top 10 past 100%", [[good[0]![0], { ...good[0]![1], info: { ...good[0]![1].info, top10Bps: 10_001 } }]]],
    ["an info time ahead of now", [[good[0]![0], { ...good[0]![1], info: { ...good[0]![1].info, asOfMs: NOW + 1 } }]]],
    ["an extra key", [[good[0]![0], { ...good[0]![1], info: { ...good[0]![1].info, src: "x" } }]]],
    ["an address not lowercase", [[COIN.toUpperCase().replace("0X", "0x"), good[0]![1]], ...good]],
    ["too many entries", [...good, ...Array.from({ length: INFO_HANDOVER_MAX }, () => filler)]],
    ["not a list", { [COIN]: good[0]![1] }],
  ];
  for (const [why, st] of bad) {
    const next = tokenPart(clock, true);
    assert.equal(next.part.restore(st), false, why);
    // nothing restored: the cold read refused, holders with no count from no source, never a 429 (card
    // evm-chart-opens-without-a-vendor-call)
    const h = await next.part.holders(COIN);
    assert.deepEqual([h.status, JSON.parse(h.body).total, JSON.parse(h.body).src], [200, null, "none"], `${why}: nothing restored`);
  }
});

/** A Base helper's swap reads with GeckoTerminal answering a token our reads find no pool of. */
function swapsPart(clock: { t: number }, spent = false) {
  const { readFileSync: read } = { readFileSync };
  const BARS = JSON.parse(read(new URL("../solana/fixtures/token-page.json", import.meta.url), "utf8")).gt_ohlcv;
  const chain = fakeChain();
  const NOPOOL = `0x${"34".repeat(20)}`;
  let calls = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith(GT_BASE)) {
      calls++;
      if (url.includes("/pools?page=1")) return new Response(JSON.stringify({ data: [{ attributes: { address: `0x${"ab".repeat(32)}` } }] }), { status: 200 });
      return new Response(JSON.stringify(BARS), { status: 200 });
    }
    const reqs = JSON.parse(String(init.body)) as { id: number; method: string; params: { address?: string }[] }[];
    if (reqs.every((c) => c.method === "eth_getLogs" && c.params[0]?.address === NOPOOL)) return new Response(JSON.stringify(reqs.map((c) => ({ jsonrpc: "2.0", id: c.id, result: [] }))), { status: 200 });
    return chain.fetch(url, init);
  };
  const gecko = geckoBudget(() => clock.t);
  if (spent) gecko.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => clock.t - 1_000));
  const s = open(chain, clock, { fetch: fetch as never, gecko, listed: async (t) => t === NOPOOL, pools: new Map(), sleep: async () => undefined });
  return { s, NOPOOL, calls: () => calls };
}

test("a chart the old helper read from GeckoTerminal is served by the next one on a spent budget, dated by the old read; past GT_SERVE_MS the 429, never the old bars", async () => {
  const clock = { t: Date.parse("2026-11-02T13:53:00Z") };
  const old = swapsPart(clock);
  const first = await old.s.candles(old.NOPOOL, "1m", null, 60);
  old.s.stop();
  assert.equal(first.status, 200, first.body);
  assert.ok(JSON.parse(first.body).candles.length > 0);
  const handed = JSON.parse(JSON.stringify(old.s.state()));
  clock.t += 120_000;
  const next = swapsPart(clock, true);
  assert.equal(next.s.restore(handed), true);
  const c = await next.s.candles(next.NOPOOL, "1m", null, 60);
  assert.equal(c.status, 200, c.body);
  assert.deepEqual(JSON.parse(c.body).candles, JSON.parse(first.body).candles);
  assert.equal(JSON.parse(c.body).as_of_ms, JSON.parse(first.body).as_of_ms, "the old read's time");
  assert.equal(next.calls(), 0, "no GeckoTerminal call");
  next.s.stop();
  clock.t += GT_SERVE_MS;
  const late = swapsPart(clock, true);
  assert.equal(late.s.restore(handed), true);
  const l = await late.s.candles(late.NOPOOL, "1m", null, 60);
  late.s.stop();
  // the newest bars past their bound are not served, and nothing of ours: the 429, never an empty 200 while the read
  // is owed (card evm-chart-opens-without-a-vendor-call: live run 42995547054)
  assert.equal(l.status, 429, "the newest bars past their bound are not served");
});

test("a handed-over swaps state that fails any check restores nothing: bars malformed, a key not ours, a read time ahead, too many entries", async () => {
  const clock = { t: Date.parse("2026-11-02T13:53:00Z") };
  const old = swapsPart(clock);
  await old.s.candles(old.NOPOOL, "1m", null, 60);
  old.s.stop();
  const good = JSON.parse(JSON.stringify(old.s.state())) as { kept: [string, { at: number; bars: unknown[] }][]; history: unknown[]; pools: [string, { id: string; at: number }][] };
  assert.ok(good.kept.length > 0 && good.pools.length > 0);
  const k0 = good.kept[0]!;
  const bad: [string, unknown][] = [
    ["a bar not six fields", { ...good, kept: [[k0[0], { ...k0[1], bars: [[1, "1"]] }]] }],
    ["a bar's price not a decimal", { ...good, kept: [[k0[0], { ...k0[1], bars: [[1_700_000_000, "1e5", "1", "1", "1", "1"]] }]] }],
    ["a key not a pool's", { ...good, kept: [["not-a-pool:1m", k0[1]]] }],
    ["a read time ahead", { ...good, pools: [[good.pools[0]![0], { ...good.pools[0]![1], at: clock.t + 1 }]] }],
    ["a pool id not ours", { ...good, pools: [[good.pools[0]![0], { id: "0xzz", at: clock.t }]] }],
    ["too many entries", { ...good, pools: Array.from({ length: HANDOVER_ENTRIES_MAX + 1 }, () => good.pools[0]) }],
    ["not an object", [good]],
  ];
  for (const [why, st] of bad) {
    const next = swapsPart(clock, true);
    assert.equal(next.s.restore(st), false, why);
    const c = await next.s.candles(next.NOPOOL, "1m", null, 60);
    next.s.stop();
    assert.equal(c.status, 429, `${why}: nothing restored`);
  }
});

test("the warm file carries the EVM market state and gives each chain its own back; a chain it lacks is left as it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "warm-evm-"));
  try {
    const got: string[] = [];
    const part = (c: string) => ({ tokens: { state: () => [`${c} tokens`], restore: (st: unknown) => (got.push(`${c} tokens ${JSON.stringify(st)}`), true) }, swaps: { state: () => ({ c }), restore: (st: unknown) => (got.push(`${c} swaps ${JSON.stringify(st)}`), true) } });
    writeWarm(dir, { at: Date.now(), gecko: [], evm: {}, evmMarket: evmMarketOf(["base"], part) });
    const w = readWarm(dir, Date.now());
    restoreEvmMarket(w, ["base", "robinhood"], part);
    assert.deepEqual(got, ['base tokens ["base tokens"]', 'base swaps {"c":"base"}']);
    restoreEvmMarket({ at: 0, gecko: [], evm: {}, evmMarket: { base: "junk" } }, ["base"], part);
    assert.equal(got.length, 2, "a chain's entry that is no object is not read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
