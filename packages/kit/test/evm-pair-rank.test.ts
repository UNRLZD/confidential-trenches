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
import { evmPaceReset, evmProviderHold } from "../src/checks/evm/pace.ts";
import { onTestClock } from "./test-clock.ts";

const v = evmPoolVenues().base;
const [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET] = v.providers!;
// the venue's own pins: publicnode and blastapi 16, mainnet.base.org and Pocket 8
const pin = (u: string) => v.inflight![u]!;
const one = [{ method: "eth_blockNumber", params: [] }];

/** Base's providers, each answering after `ms[url]` of the clock; `hold(url)` keeps that provider's next answer until
 *  the returned function is called; `lose(url, ms)` fails its next post `ms` after it is sent, as a post that timed out. */
function providers(ms: Record<string, number>) {
  const held = new Map<string, Promise<void>>();
  const lost = new Map<string, number>();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const loss = lost.get(u);
    lost.delete(u);
    if (loss !== undefined) {
      await new Promise((go) => setTimeout(go, loss));
      throw new Error("the post timed out");
    }
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
  const lose = (u: string, ms: number) => void lost.set(u, ms);
  // each provider asked once, so each has its measured time
  const measure = () => Promise.all(rpcs.map((r: EvmRpc) => r(one)));
  return { of, hold, lose, measure };
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

// round (D): a lost post holds its provider only at a stall or at its second loss within EVM_HOLD_MS (Envoy's
// outlier detection ejects on consecutive failures); one lost post of a provider that answers the rest is its load
const lostIn = (p: ReturnType<typeof providers>, ms: number) => {
  p.lose(BLASTAPI!, ms);
  return p.of.get(BLASTAPI!)!(one).then(() => assert.fail("the lost post was answered"), () => undefined);
};
const pairOf = () => evmRanked(v.providers!, performance.now(), { posts: 16, pin }).slice(0, 2);

test("R3 one lost post of a provider that answers a post sent after it keeps the provider's seat", () => onTestClock(async () => {
  evmSpeedReset();
  const p = providers({ [PUBLICNODE!]: 100, [BLASTAPI!]: 600, [BASE_ORG!]: 700, [POCKET!]: 900 });
  await p.measure();
  // lost 700 ms after it is sent; a post sent with it is answered at 600
  await Promise.all([lostIn(p, 700), p.of.get(BLASTAPI!)!(one)]);
  assert.deepEqual(pairOf(), [PUBLICNODE, BLASTAPI], "one lost post among answers held the provider");
}));

test("R4 a lost post with no answer since it was sent holds its provider", () => onTestClock(async () => {
  evmSpeedReset();
  const p = providers({ [PUBLICNODE!]: 100, [BLASTAPI!]: 600, [BASE_ORG!]: 700, [POCKET!]: 900 });
  await p.measure();
  await lostIn(p, 700);
  assert.deepEqual(pairOf(), [PUBLICNODE, BASE_ORG], "a provider that answered nothing while its post was out kept its seat");
}));

test("R5 a second lost post within EVM_HOLD_MS holds its provider, though it answers the rest; a loss past it does not", () => onTestClock(async () => {
  evmSpeedReset();
  const p = providers({ [PUBLICNODE!]: 100, [BLASTAPI!]: 600, [BASE_ORG!]: 700, [POCKET!]: 900 });
  await p.measure();
  await Promise.all([lostIn(p, 700), p.of.get(BLASTAPI!)!(one)]);
  assert.deepEqual(pairOf(), [PUBLICNODE, BLASTAPI]);
  // 10 s on, a second loss among answers: held
  await new Promise((r) => setTimeout(r, 10_000));
  await Promise.all([lostIn(p, 700), p.of.get(BLASTAPI!)!(one)]);
  assert.deepEqual(pairOf(), [PUBLICNODE, BASE_ORG], "a second lost post within 30 s left the provider its seat");
  // past the hold and past EVM_HOLD_MS from the last loss, one more loss among answers: the seat kept
  await new Promise((r) => setTimeout(r, 31_000));
  await Promise.all([lostIn(p, 700), p.of.get(BLASTAPI!)!(one)]);
  assert.deepEqual(pairOf(), [PUBLICNODE, BLASTAPI], "a loss more than 30 s after the last held the provider");
}));

// card evm-quote-fewer-rounds: a circuit breaker. A held provider is out of the first seats, after every provider not
// held, a venue's quoteLast too; once its hold ends it is half open, after every one not held, until it answers a post.
// With robinhood.drpc.org held and bloXroute held 30 s by one 429, the two tied by class and dRPC, the faster, sat in the
// pair beside publicnode while Robinhood's own RPC (quoteLast) waited after both: dRPC answered 10 more posts 429 in that
// tap's next quotes (read only from macOS, 2026-11-22 17:3xZ)
const rh = evmPoolVenues().robinhood;
const [RH_PUBLICNODE, RH_DRPC, RH_OWN, RH_BLX] = rh.providers! as [string, string, string, string];
const rhMeasured = async (ms: Record<string, number>) => {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    await new Promise((go) => setTimeout(go, ms[String(url)]));
    const body = JSON.parse(String(init?.body)) as { id: number }[];
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x1" }))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const rpcs = evmProviders(rh.providers!, fetchFn);
  await Promise.all(rpcs.map((r: EvmRpc) => r(one)));
  return new Map(rh.providers!.map((u, k) => [u, rpcs[k]!] as const));
};

test("R6 two providers held: neither takes a first seat while one not held is left, Robinhood's own RPC (quoteLast) included", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  await rhMeasured({ [RH_PUBLICNODE]: 150, [RH_DRPC]: 120, [RH_OWN]: 350, [RH_BLX]: 300 });
  evmProviderHold(RH_DRPC, 30_000);
  evmProviderHold(RH_BLX, 30_000);
  assert.deepEqual(evmRanked(rh.providers!).slice(0, 2), [RH_PUBLICNODE, RH_OWN], `a held provider took a first seat: ${evmRanked(rh.providers!).join(", ")}`);
  assert.deepEqual(evmRanked(rh.providers!).slice(2), [RH_DRPC, RH_BLX], "the held, after every one not held, in their own order");
  evmPaceReset();
}));

test("R7 a provider whose hold has ended is half open: seated once as the probe before quoteLast, after every one not held while the probe is out, and back in its seat once it answers", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  const of = await rhMeasured({ [RH_PUBLICNODE]: 150, [RH_DRPC]: 120, [RH_OWN]: 350, [RH_BLX]: 300 });
  evmProviderHold(RH_DRPC, 60_000);
  evmProviderHold(RH_BLX, 1_000);
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(evmRanked(rh.providers!), [RH_PUBLICNODE, RH_OWN, RH_DRPC, RH_BLX], "a held provider took a seat");
  await new Promise((r) => setTimeout(r, 200));
  // the hold over, the rest healthy: the next quote seats it once, as the probe, before Robinhood's own RPC (quoteLast)
  assert.deepEqual(evmRanked(rh.providers!), [RH_PUBLICNODE, RH_BLX, RH_OWN, RH_DRPC], "a provider out of its hold was never probed");
  // its probe out: after every provider not held, so no other quote seats it before the answer
  const probe = of.get(RH_BLX)!(one);
  assert.deepEqual(evmRanked(rh.providers!), [RH_PUBLICNODE, RH_OWN, RH_BLX, RH_DRPC], "a provider whose probe is out was seated again");
  await probe;
  assert.deepEqual(evmRanked(rh.providers!).slice(0, 2), [RH_PUBLICNODE, RH_BLX], "a provider whose probe answered stayed out of its seat");
  evmPaceReset();
}));

test("R9 a half-open provider whose probe answers past its hedge time is held again, and one in time is closed", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  const ms = { [RH_PUBLICNODE]: 150, [RH_DRPC]: 120, [RH_OWN]: 350, [RH_BLX]: 300 };
  const of = await rhMeasured(ms);
  evmProviderHold(RH_BLX, 1_000);
  await new Promise((r) => setTimeout(r, 1_100));
  ms[RH_BLX] = 2_000;
  await of.get(RH_BLX)!(one);
  assert.equal(evmRanked(rh.providers!).at(-1), RH_BLX, "a provider whose probe answered late was closed");
  await new Promise((r) => setTimeout(r, 31_000));
  ms[RH_BLX] = 300;
  await of.get(RH_BLX)!(one);
  // closed: back among the providers not held, before Robinhood's own RPC (quoteLast), at its measured time
  assert.deepEqual(evmRanked(rh.providers!), [RH_DRPC, RH_PUBLICNODE, RH_BLX, RH_OWN], "a provider whose probe answered in time stayed out of its seat");
  evmPaceReset();
}));

test("R8 a half-open provider whose probe is lost is held again", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  let lose = false;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    await new Promise((go) => setTimeout(go, 100));
    if (lose && String(url) === RH_BLX) throw new Error("the post timed out");
    const body = JSON.parse(String(init?.body)) as { id: number }[];
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x1" }))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const rpcs = evmProviders(rh.providers!, fetchFn);
  await Promise.all(rpcs.map((r: EvmRpc) => r(one)));
  evmProviderHold(RH_BLX, 1_000);
  await new Promise((r) => setTimeout(r, 1_100));
  lose = true;
  await assert.rejects(rpcs[rh.providers!.indexOf(RH_BLX)]!(one));
  assert.equal(evmRanked(rh.providers!).at(-1), RH_BLX, "a provider whose probe was lost was not held again");
  evmPaceReset();
}));
