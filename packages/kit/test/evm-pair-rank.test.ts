// card evm-warm-tap-ends-inside-two-seconds, round (C): the pair a quote asks first is ranked by the time a round of the
// quote's size takes on each provider, and a request out counts against a provider only past its own measured time.
// Base's blastapi left the pair for mainnet.base.org twice in 20 runs (2026-11-21 12:17Z and 13:0xZ): one post of
// blastapi's out 8 s while it answered the rest in about 300 ms put it behind at a request out past 400 ms, and
// mainnet.base.org, faster a post on small posts at half the pin, then took ANTc's 16-post rounds in two waves: warm
// taps of 5.4 to 6.2 s. Each provider here answers after its own delay on the test's clock (test-clock.ts), so each
// measured time is exact.
//   node --test test/evm-pair-rank.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmProviders, evmRanked, evmSpeedReset, type EvmRpc } from "../src/checks/evm/quote.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { onTestClock } from "./test-clock.ts";

const v = evmPoolVenues().base;
const [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET] = v.providers!;
// the venue's own pins: publicnode and blastapi 16, mainnet.base.org and Pocket 8
const pin = (u: string) => v.inflight![u]!;
const one = [{ method: "eth_blockNumber", params: [] }];

/** Base's providers, each answering after `ms[url]` of the clock; `hold(url)` keeps that provider's next answer until
 *  the returned function is called. */
function providers(ms: Record<string, number>) {
  const held = new Map<string, Promise<void>>();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const wait = held.get(u);
    held.delete(u);
    await (wait ?? new Promise((go) => setTimeout(go, ms[u])));
    const body = JSON.parse(String(init?.body)) as { id: number }[];
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x1" }))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const rpcs = evmProviders(v.providers!, fetchFn);
  const of = new Map(v.providers!.map((u, k) => [u, rpcs[k]!] as const));
  const hold = (u: string): (() => void) => {
    let go!: () => void;
    held.set(u, new Promise<void>((r) => (go = r)));
    return () => go();
  };
  // each provider asked once, so each has its measured time
  const measure = () => Promise.all(rpcs.map((r: EvmRpc) => r(one)));
  return { of, hold, measure };
}

test("R1 a provider faster a post at half the pin never takes a 16-post round's seat: mainnet.base.org's 8 beside blastapi's 16", () => onTestClock(async () => {
  evmSpeedReset();
  const p = providers({ [PUBLICNODE!]: 100, [BLASTAPI!]: 300, [BASE_ORG!]: 200, [POCKET!]: 500 });
  await p.measure();
  // 16 posts: blastapi's one wave of 300 ms beats mainnet.base.org's two of 200
  assert.deepEqual(evmRanked(v.providers!, performance.now(), { posts: 16, pin }).slice(0, 2), [PUBLICNODE, BLASTAPI]);
  // 2 posts: one wave on each, and mainnet.base.org's 200 ms is the faster
  assert.deepEqual(evmRanked(v.providers!, performance.now(), { posts: 2, pin }).slice(0, 2), [PUBLICNODE, BASE_ORG]);
}));

test("R2 a request out past 400 ms but under its provider's own measured time keeps its seat; one out past it with no answer since loses the seat at once; one late while the provider answers the rest is its load", () => onTestClock(async () => {
  evmSpeedReset();
  const p = providers({ [PUBLICNODE!]: 100, [BLASTAPI!]: 600, [BASE_ORG!]: 700, [POCKET!]: 900 });
  await p.measure();
  const size = { posts: 16, pin };
  assert.deepEqual(evmRanked(v.providers!, performance.now(), size).slice(0, 2), [PUBLICNODE, BLASTAPI]);
  // a post of blastapi's out 450 ms: past 400, under its own 600
  const go = p.hold(BLASTAPI!);
  const out = p.of.get(BLASTAPI!)!(one);
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(evmRanked(v.providers!, performance.now(), size).slice(0, 2), [PUBLICNODE, BLASTAPI], "a request out 450 ms, under the provider's own 600 ms, cost it its seat");
  // out 650 ms, past its own 600, and nothing answered since it was sent: stalled, the seat goes at once
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(evmRanked(v.providers!, performance.now(), size).slice(0, 2), [PUBLICNODE, BASE_ORG], "a provider that answers nothing past its own time kept its seat");
  // it answers a post sent after the late one: it works, and the late post is one more post of its load. A 16-post
  // round: ceil(17 / 16) = 2 waves of 600 against mainnet.base.org's 2 of 700, the seat kept
  await p.of.get(BLASTAPI!)!(one);
  assert.deepEqual(evmRanked(v.providers!, performance.now(), size).slice(0, 2), [PUBLICNODE, BLASTAPI], "one late post of a provider that answers the rest cost it its seat");
  go();
  await out;
}));
