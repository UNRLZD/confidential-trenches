// node --test apps/helper/src/data/evm/trend.test.ts: card robinhood-lists-own-reads. Discover's Robinhood Trending 5m and
// 1h from the chain's own swaps (the swap index, counted by trend.ts) and DexScreener's pairs of the busiest pools, never
// a GeckoTerminal list call. Recorded 2026-11-25 07:37Z (fixtures/ds-robinhood-pairs.json): the 40 Robinhood pools with
// the most v4 PoolManager and v3 Swap logs over blocks 122,874,321-122,876,920 on rpc.mainnet.chain.robinhood.com, with
// their counts, and DexScreener's latest/dex/pairs answers for them as read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { geckoBudget } from "../gecko.ts";
import { DEX_BASE, DEX_LIMITS } from "../held.ts";
import { upstreamBudget } from "../../limits/limits.ts";
import { ownTrending } from "../../server.ts";
import { createEvmLists, GT_BASE, GT_READS, LIST_MS, OWN_ROWS, ownRows } from "./lists.ts";
import { SWAP_TOPICS, TOPIC, VENUES, type Log } from "./swaps.ts";
import { candidates, countSwaps, countsState, emptyCounts, POOLS_PER_MINUTE, restoreCounts, TREND_MINUTES } from "./trend.ts";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
type Pair = { chainId: string; pairAddress: string; baseToken: { address: string; symbol: string }; liquidity?: { usd?: number }; volume?: { m5?: number; h1?: number } };
const REC = JSON.parse(fx("ds-robinhood-pairs.json")) as { recorded_at: string; head: number; counts: [string, number][]; answers: { ids: string[]; body: { pairs: Pair[] | null } }[] };
const NOW = Date.parse(REC.recorded_at);
const PAIRS = new Map(REC.answers.flatMap((a) => a.body.pairs ?? []).map((p) => [p.pairAddress.toLowerCase(), p]));
const RH = VENUES.robinhood;
const QUOTES = new Set([RH.weth, RH.usd, "0x0000000000000000000000000000000000000000"]);
const TOPICS = new Set(SWAP_TOPICS);
const GT_NEW = `${GT_BASE}/networks/robinhood/${GT_READS.new}`;

/** The recorded counts as the index's logs: each pool's swaps, a v4 pool's from the PoolManager, at `t`, from `block`. */
function logsOf(counts: readonly [string, number][], t: number, block = REC.head - 2_000): Log[] {
  const out: Log[] = [];
  for (const [key, n] of counts)
    for (let i = 0; i < n; i++) {
      const v4 = key.length === 66;
      out.push({ block: block++, index: 0, tx: `0x${"ab".repeat(32)}`, address: v4 ? RH.poolManager : key, topics: v4 ? [TOPIC.swap4, key] : [TOPIC.swap3], data: "0x", t });
    }
  return out;
}
function indexOf(logs: Log[]) {
  return { range: () => (logs.length === 0 ? null : { from: logs[0]!.block, to: logs.at(-1)!.block }), logs: (lo: number, hi: number) => logs.filter((l) => l.block >= lo && l.block <= hi) };
}

/** GeckoTerminal's recorded Robinhood new_pools, DexScreener's recorded pairs of the pools asked, and a JSON-RPC error
 *  for every maker read (their tags are not this card's). */
function rig(opts: { dex?: (ids: string[]) => Response | null } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url === GT_NEW) return new Response(fx("gt-robinhood-new.json"), { status: 200, headers: { "content-type": "application/json" } });
    assert.ok(!url.startsWith(GT_BASE), `no other GeckoTerminal read: ${url}`);
    const pre = `${DEX_BASE}/latest/dex/pairs/robinhood/`;
    if (url.startsWith(pre)) {
      const ids = url.slice(pre.length).split(",");
      assert.ok(ids.length <= 30, "at most 30 pools a call");
      const own = opts.dex?.(ids);
      if (own) return own;
      const pairs = ids.map((id) => PAIRS.get(id)).filter((p) => p !== undefined);
      return new Response(JSON.stringify({ schemaVersion: "1.0.0", pairs: pairs.length === 0 ? null : pairs }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const reqs = JSON.parse(String(init.body)) as { id: number }[] | { id: number };
    const err = (id: number) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "not recorded" } });
    return new Response(JSON.stringify(Array.isArray(reqs) ? reqs.map((r) => err(r.id)) : err(reqs.id)), { status: 200 });
  };
  return { fetch, calls };
}
const dexCalls = (calls: string[]) => calls.filter((u) => u.startsWith(`${DEX_BASE}/latest/dex/pairs/`)).length;
type RowOut = { token: string; symbol: string; src: string; liq_usd: string | null; vol_5m_usd: string | null; vol_1h_usd: string | null };

test("card robinhood-lists-own-reads: Robinhood's Trending 5m and 1h come from the index's swaps and DexScreener's pairs of the busiest pools, with no GeckoTerminal trending call", async () => {
  const now = NOW;
  const r = rig();
  const l = createEvmLists("robinhood", geckoBudget(() => now), { fetch: r.fetch, now: () => now });
  l.own({ index: indexOf(logsOf(REC.counts, Math.floor(NOW / 1000) - 30)), poolManager: RH.poolManager, topics: SWAP_TOPICS, quotes: [...QUOTES], dex: upstreamBudget(() => DEX_LIMITS, () => now) });
  await l.tick();
  const a = await l.get();
  assert.equal(a.status, 200);
  const s = JSON.parse(a.body) as { lists: Record<string, RowOut[]>; pools: Record<string, string> };
  assert.deepEqual(r.calls.filter((u) => u.startsWith(GT_BASE)), [GT_NEW], "GeckoTerminal is asked for New only");
  assert.equal(dexCalls(r.calls), 2, "the 40 candidates of both windows in two calls of 30 at most");
  for (const [k, vol] of [["trending_5m", "vol_5m_usd"], ["trending_1h", "vol_1h_usd"]] as const) {
    const rows = s.lists[k]!;
    assert.ok(rows.length >= 15 && rows.length <= OWN_ROWS, `${k}: ${rows.length} rows`);
    assert.equal(new Set(rows.map((x) => x.token)).size, rows.length, `${k}: each token once (NVDA trades on 7 of the pools)`);
    for (const x of rows) {
      assert.equal(x.src, "dexscreener");
      assert.ok(!QUOTES.has(x.token), `${k}: ${x.symbol} is no chain quote (WETH/USDG, ETH/USDG are no coin's row)`);
      assert.ok(Number(x.liq_usd) >= 1_000, `${k}: ${x.symbol} liquidity ${x.liq_usd}`);
      assert.ok(Object.hasOwn(s.pools, x.token) && PAIRS.has(s.pools[x.token]!), `${k}: ${x.symbol}'s pool is the pair's`);
    }
    for (let i = 1; i < rows.length; i++) assert.ok(Number(rows[i - 1]![vol]) >= Number(rows[i]![vol]), `${k}: by its window's volume, the busiest first`);
    assert.ok(!rows.some((x) => x.symbol === "Basket"), `${k}: the Basket pool of 1.07 USD is no row`);
  }
  // the recorded busiest coin of each window, read off the fixture by hand: ANT/USDG, m5 213,323 and h1 986,532 USD
  assert.equal(s.lists.trending_5m![0]!.symbol, "ANT");
  assert.equal(s.lists.trending_1h![0]!.symbol, "ANT");
  assert.deepEqual(s.lists.trending, s.lists.trending_1h);

  // within LIST_MS no list is read again; past it the own lists are, still with no GeckoTerminal trending call
  await l.tick();
  assert.equal(dexCalls(r.calls), 2);
});

test("card robinhood-lists-own-reads: a pool DexScreener does not name, or names on another chain, is never listed; a refused or failed DexScreener read keeps the last own lists and asks GeckoTerminal for none", async () => {
  let now = NOW;
  const drop = new Set([...PAIRS.keys()].filter((k) => PAIRS.get(k)!.baseToken.symbol === "ANT"));
  let mode: "drop" | "429" | "500" = "drop";
  const r = rig({
    dex: (ids) => {
      if (mode === "429") return new Response("{}", { status: 429, headers: { "retry-after": "5" } });
      if (mode === "500") return new Response("{}", { status: 500 });
      // ANT's pools unnamed, and MFLO's named on Base
      const pairs = ids.filter((id) => !drop.has(id)).map((id) => PAIRS.get(id)).filter((p) => p !== undefined).map((p) => (p.baseToken.symbol === "MFLO" ? { ...p, chainId: "base" } : p));
      return new Response(JSON.stringify({ pairs }), { status: 200 });
    },
  });
  const dex = upstreamBudget(() => DEX_LIMITS, () => now);
  const l = createEvmLists("robinhood", geckoBudget(() => now), { fetch: r.fetch, now: () => now });
  l.own({ index: indexOf(logsOf(REC.counts, Math.floor(NOW / 1000) - 30)), poolManager: RH.poolManager, topics: SWAP_TOPICS, quotes: [...QUOTES], dex });
  await l.tick();
  const first = JSON.parse((await l.get()).body) as { lists: Record<string, RowOut[]> };
  for (const k of ["trending_5m", "trending_1h"]) {
    assert.ok(first.lists[k]!.length > 0);
    assert.ok(!first.lists[k]!.some((x) => x.symbol === "ANT" || x.symbol === "MFLO"), `${k}: unnamed and other-chain pairs are no rows`);
  }
  for (const m of ["429", "500"] as const) {
    mode = m;
    now += LIST_MS;
    await l.tick();
    const again = JSON.parse((await l.get()).body) as { lists: Record<string, RowOut[]> };
    assert.deepEqual(again.lists.trending_1h, first.lists.trending_1h, `DexScreener ${m}: the last own list is served`);
  }
  assert.ok(!r.calls.some((u) => u.startsWith(GT_BASE) && u !== GT_NEW), "never a GeckoTerminal trending call");
  // the 429 held the budget: the next tick inside its retry-after makes no DexScreener call
  mode = "drop";
  const before = dexCalls(r.calls);
  now += 1_000;
  const held = createEvmLists("robinhood", geckoBudget(() => now), { fetch: r.fetch, now: () => now });
  held.own({ index: indexOf(logsOf(REC.counts, Math.floor(now / 1000) - 30)), poolManager: RH.poolManager, topics: SWAP_TOPICS, quotes: [...QUOTES], dex });
  dex.hold("dexscreener", now + 60_000);
  await held.tick();
  assert.equal(dexCalls(r.calls), before, "a held budget sends nothing");
});

test("card robinhood-lists-own-reads: a restart takes over the own lists and the swaps counted; the new process answers the same rows with no call, and its 1h candidates still hold the hour before it", async () => {
  const now = NOW;
  const r = rig();
  const dex = upstreamBudget(() => DEX_LIMITS, () => now);
  const old = createEvmLists("robinhood", geckoBudget(() => now), { fetch: r.fetch, now: () => now });
  // the hour before: the recorded counts 40 minutes ago, past the 5m window, in the 1h one
  old.own({ index: indexOf(logsOf(REC.counts, Math.floor(NOW / 1000) - 40 * 60)), poolManager: RH.poolManager, topics: SWAP_TOPICS, quotes: [...QUOTES], dex });
  await old.tick();
  const before = JSON.parse((await old.get()).body) as { lists: Record<string, RowOut[]> };
  assert.equal(before.lists.trending_5m!.length, 0, "no swap in the last 5 minutes: no 5m row");
  assert.ok(before.lists.trending_1h!.length > 0);
  const st = JSON.parse(JSON.stringify(old.state()));
  const calls = r.calls.length;
  const next = createEvmLists("robinhood", geckoBudget(() => now), { fetch: r.fetch, now: () => now });
  assert.equal(next.restore(st), true, "every list held from the file");
  const after = JSON.parse((await next.get()).body) as { lists: Record<string, RowOut[]> };
  assert.equal(r.calls.length, calls, "no call to answer");
  assert.deepEqual(after.lists.trending_1h, before.lists.trending_1h);
  assert.deepEqual(after.lists.trending_5m, before.lists.trending_5m);
  // the swaps counted came over whole, so the 1h candidates are the old hour's; the blocks counted are never again
  assert.equal(st.trend?.minutes.length, 1, "the warm state carries the minute of swaps counted");
  assert.equal(st.trend.minutes[0][1].length, REC.counts.length);
  assert.deepEqual(next.state().trend, old.state().trend);
  const nowS = Math.floor(NOW / 1000);
  assert.deepEqual(candidates(restoreCounts(st.trend, nowS), nowS, 3_600), candidates(restoreCounts(old.state().trend, nowS), nowS, 3_600));
  next.own({ index: indexOf(logsOf(REC.counts, nowS - 40 * 60)), poolManager: RH.poolManager, topics: SWAP_TOPICS, quotes: [...QUOTES], dex });
  await next.tick();
  assert.deepEqual(next.state().trend, old.state().trend, "the index's copy of blocks already counted adds nothing");
});

test("trend.ts counts only what it must: a swap topic the index reads, a pool key in its exact form, a block time, each block once, an hour kept; a minute holds POOLS_PER_MINUTE pools at most", () => {
  const nowS = Math.floor(NOW / 1000);
  const c = emptyCounts();
  const v3 = "0x" + "11".repeat(20);
  const id = "0x" + "22".repeat(32);
  const base: Log = { block: 10, index: 0, tx: "0x" + "ab".repeat(32), address: v3, topics: [TOPIC.swap3], data: "0x", t: nowS };
  countSwaps(c, [
    base,
    { ...base, block: 11, address: RH.poolManager, topics: [TOPIC.swap4, id] },
    { ...base, block: 12, topics: [TOPIC.initialize] }, // not a swap
    { ...base, block: 13, address: RH.poolManager, topics: [TOPIC.swap4, "0x12"] }, // no pool id
    { ...base, block: 14, t: null }, // no block time
    { ...base, block: 15, t: nowS - (TREND_MINUTES + 1) * 60 }, // past the hour
  ], 15, nowS, RH.poolManager, TOPICS);
  assert.deepEqual(candidates(c, nowS, 300), [id, v3].sort((a, b) => (a < b ? -1 : 1)));
  countSwaps(c, [{ ...base, block: 9 }, { ...base, block: 15 }], 16, nowS, RH.poolManager, TOPICS);
  assert.equal(c.minutes.get(Math.floor(nowS / 60))!.get(v3), 1, "a block counted before is not counted again");
  const flood = Array.from({ length: POOLS_PER_MINUTE + 50 }, (_, i) => ({ ...base, block: 100 + i, address: `0x${i.toString(16).padStart(40, "0")}` }));
  countSwaps(c, flood, 100 + flood.length, nowS, RH.poolManager, TOPICS);
  assert.equal(c.minutes.get(Math.floor(nowS / 60))!.size, POOLS_PER_MINUTE, "a minute keeps POOLS_PER_MINUTE pools");
  // an hour on, the minute is gone
  countSwaps(c, [], 0, nowS + (TREND_MINUTES + 1) * 60, RH.poolManager, TOPICS);
  assert.equal(c.minutes.size, 0);
});

test("trend.ts takes over a previous process's counts as hostile input: a minute past the hour or ahead of now, a key out of form, a count that is not a positive integer are dropped", () => {
  const nowS = Math.floor(NOW / 1000);
  const m = Math.floor(nowS / 60);
  const good = "0x" + "11".repeat(20);
  const st = {
    seen: 42,
    minutes: [
      [m, [[good, 3], ["0xnothex", 1], [good.toUpperCase(), 1], ["0x" + "22".repeat(32), 0], ["0x" + "33".repeat(32), 1.5]]],
      [m - TREND_MINUTES, [[good, 9]]],
      [m + 1, [[good, 9]]],
      ["x", [[good, 9]]],
    ],
  };
  const c = restoreCounts(st, nowS);
  assert.equal(c.seen, 42);
  assert.deepEqual(countsState(c).minutes, [[m, [[good, 3]]]]);
  assert.equal(restoreCounts({ minutes: [] }, nowS).seen, -1, "no seen block: nothing taken over");
});

test("ownRows refuses what is not a list, and a pair under LIQ_MIN_USD or with no volume in its window", () => {
  assert.equal(ownRows("robinhood", { pairs: [] }, NOW, "trending_1h"), null);
  const ant = [...PAIRS.values()].find((p) => p.baseToken.symbol === "ANT")!;
  assert.equal(ownRows("robinhood", [{ ...ant, liquidity: { usd: 999 } }], NOW, "trending_1h")!.rows.length, 0);
  assert.equal(ownRows("robinhood", [{ ...ant, volume: { ...ant.volume, m5: 0 } }], NOW, "trending_5m")!.rows.length, 0);
  assert.equal(ownRows("robinhood", [ant], NOW, "trending_5m")!.rows.length, 1);
});

test("card robinhood-lists-own-reads: the helper wires its own trending on each chain whose swaps hold an index (Robinhood's), with that chain's PoolManager, swap topics and own quotes; a chain with none keeps GeckoTerminal", () => {
  const got: Record<string, unknown> = {};
  const lists = (chain: string) => ({ own: (s: unknown) => (got[chain] = s) }) as unknown as ReturnType<typeof createEvmLists>;
  const index = indexOf([]);
  const dex = upstreamBudget(() => DEX_LIMITS);
  const wired = ownTrending({ base: lists("base"), robinhood: lists("robinhood") }, { base: { index: null }, robinhood: { index: index as never } }, dex);
  assert.deepEqual(wired, ["robinhood"]);
  assert.equal(got.base, undefined);
  const s = got.robinhood as { poolManager: string; topics: readonly string[]; quotes: string[]; index: unknown; dex: unknown };
  assert.equal(s.poolManager, RH.poolManager);
  assert.deepEqual(s.topics, SWAP_TOPICS);
  assert.deepEqual(new Set(s.quotes), QUOTES);
  assert.equal(s.index, index);
  assert.equal(s.dex, dex);
});
