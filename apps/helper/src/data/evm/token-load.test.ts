// node --test apps/helper/src/data/evm/token-load.test.ts: card evm-token-page-off-the-5-call-window. Fifty users open
// fifty different Base and Robinhood token pages at once, each the page and its holders, then the Holders tab's next
// poll a minute later (apps/terminal/src/screens/token/lower.ts HOLDERS_POLL_MS). In process, against fakes, on a still
// clock: DexScreener's tokens/v1 names each coin (named.ts, its budget DEX_LIMITS), GeckoTerminal's keyless window
// (../gecko.ts, 5 calls in 75 s) holds the live helper's background 3 of 5, and CoinGecko's keyed on-chain API
// (../coingecko.ts) answers on the helper's own pace for the key at 100 calls a minute.
//
// The limits it runs on, each from the vendor's own page: DexScreener tokens/v1 "rate-limit 300 requests per minute"
// (docs.dexscreener.com/api/reference, its OpenAPI spec read 2026-11-18 09:50Z); CoinGecko "Demo plan: 100 calls/min",
// "Paid plans: Rate limit depends on your plan" (docs.coingecko.com/docs/errors-and-rate-limits.md, read 09:52Z), so 100
// is the least any key gets; the deployed key's own rate (COINGECKO_CALLS_PER_MIN) is not read here. GeckoTerminal's
// keyless 5 calls in 75 s is ../gecko.ts GT_LIMIT_PER_MIN and WINDOW_MS.
//
// Measured: the share of answers that are 429, and of holders answers with the token's count, first and at the next
// poll. Red at ff65a0403: no 429 (card evm-chart-opens-without-a-vendor-call already answers a refused count `src
// none`), but the token's info was GeckoTerminal's keyless read, so 2 of 50 had a count, first and at the next poll:
// the five calls the whole helper gets in 75 s, three of them its own lists' and ahead reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { coingeckoPace, createKeyed, CG_DAY, CG_ONCHAIN, CG_URL } from "../coingecko.ts";
import { geckoBudget, type GeckoBudget } from "../gecko.ts";
import { DEX_BASE, DEX_LIMITS } from "../held.ts";
import { PROBE_DAY_SHARE, providerHolds, upstreamBudget } from "../../limits/limits.ts";
import { GT_BASE, type EvmChain } from "./lists.ts";
import { createEvmNamed } from "./named.ts";
import * as token from "./token.ts";

const { createEvmToken } = token;
/** token.ts holdersDay where it exists; before the CO's fold (b25a82fb7) there was none, and each part drew the key's day. */
const holdersDay = (clock: () => number): unknown => ("holdersDay" in token ? (token.holdersDay as (c: () => number) => unknown)(clock) : undefined);

const NOW = Date.parse("2026-11-18T10:00:00Z");
const USERS = 50;
const POLL_MS = 60_000; // apps/terminal/src/screens/token/lower.ts HOLDERS_POLL_MS
const CHAINS: EvmChain[] = ["base", "robinhood"];
/** User i's coin: its own address, half on each chain. */
const coin = (i: number) => ({ chain: CHAINS[i % 2]!, token: `0x${(0xc0de0000 + i).toString(16).padStart(40, "0")}`, holders: 1_000 + i });
const COINS = Array.from({ length: USERS }, (_, i) => coin(i));
const byToken = new Map(COINS.map((c) => [c.token, c]));

/** One token's on-chain info, in the shape GeckoTerminal's v2 and CoinGecko's /onchain both answer (fixtures/token-info-*.json). */
const infoOf = (token: string, count: number, at: number) => ({
  data: { id: `x_${token}`, type: "token", attributes: { address: token, name: "Coin", symbol: "C", decimals: 18, holders: { count, distribution_percentage: { top_10: "12.5" }, last_updated: new Date(at - 60_000).toISOString() } } },
});
/** DexScreener's tokens/v1 answer for a coin: one pair, the coin its base token. */
const pairOf = (chain: string, token: string) => [
  { chainId: chain, dexId: "uniswap", pairAddress: `0x${token.slice(-8).padStart(40, "a")}`, baseToken: { address: token, name: "Coin", symbol: "C" }, quoteToken: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" }, priceUsd: "0.01", liquidity: { usd: 50_000 }, fdv: 1_000_000, marketCap: 1_000_000, volume: { h24: 10_000 }, priceChange: { h24: 1 }, txns: { h24: { buys: 10, sells: 5 } }, pairCreatedAt: NOW - 86_400_000 },
];

/** The live helper's GeckoTerminal window: its ahead read and two lists reads, 3 of 5. */
function liveWindow(clock: () => number): GeckoBudget {
  const b = geckoBudget(clock);
  assert.ok(b.take("ahead", false, false, "sol bars"));
  assert.ok(b.take("lists", true));
  assert.ok(b.take("lists", true));
  return b;
}

test("fifty users on fifty Base and Robinhood coins at once: no 429, and every holders answer has its count by the next poll", { timeout: 60_000 }, async () => {
  let t = NOW;
  const clock = () => t;
  const due: { at: number; fn: () => void }[] = [];
  const later = (fn: () => void, ms: number) => void due.push({ at: t + ms, fn });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  /** The fake clock moved `ms`, every queued read run at its time. */
  async function pass(ms: number) {
    const end = t + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at);
      const next = due[0];
      if (next === undefined || next.at > end) break;
      due.shift();
      t = Math.max(t, next.at);
      next.fn();
      await settle();
    }
    t = end;
  }

  const hits = { gt: 0, cg: 0, dex: 0 };
  const fetch = async (url: string): Promise<Response> => {
    const gt = new RegExp(`^${GT_BASE}/networks/(base|robinhood)/tokens/(0x[0-9a-f]{40})/info$`).exec(url);
    const cg = new RegExp(`^${CG_ONCHAIN}/networks/(base|robinhood)/tokens/(0x[0-9a-f]{40})/info$`).exec(url);
    const dex = new RegExp(`^${DEX_BASE}/tokens/v1/(base|robinhood)/(0x[0-9a-f]{40})$`).exec(url);
    const m = gt ?? cg ?? dex;
    if (m === null) throw new Error(`unexpected ${url}`);
    const c = byToken.get(m[2]!);
    if (c === undefined || c.chain !== m[1]) return new Response("[]", { status: dex ? 200 : 404 });
    if (dex) return hits.dex++, new Response(JSON.stringify(pairOf(c.chain, c.token)), { status: 200 });
    if (gt) hits.gt++;
    else hits.cg++;
    return new Response(JSON.stringify(infoOf(c.token, c.holders, t)), { status: 200 });
  };
  const env = { COINGECKO_API_KEY: "load-test-key-0123456789", COINGECKO_CALLS_PER_MIN: "100" };
  const keyed = createKeyed(env, providerHolds(clock, coingeckoPace(env)), { fetch });
  const gecko = liveWindow(clock);
  const dex = upstreamBudget(() => DEX_LIMITS, clock);
  const lists = { get: async () => ({ status: 200, body: JSON.stringify({ as_of_ms: NOW, lists: {} }), asOfMs: NOW }), listed: async () => false };
  const tok = Object.fromEntries(
    CHAINS.map((c) => [c, createEvmToken(c, { lists, named: createEvmNamed(c, { dex, fetch, now: clock }), gecko, keyed, fetch, now: clock, sleep: async () => {}, later } as Parameters<typeof createEvmToken>[1])]),
  ) as Record<EvmChain, ReturnType<typeof createEvmToken>>;
  const client = (i: number) => `198.51.100.${i}`;

  // every user opens their coin: the page and its holders at once
  const first = await Promise.all(COINS.map((c, i) => Promise.all([tok[c.chain].page(c.token, client(i)), tok[c.chain].holders(c.token, client(i))])));
  const pages = first.map(([p]) => p);
  const holders = first.map(([, h]) => h);
  // the Holders tab's next poll
  await pass(POLL_MS);
  const polled = await Promise.all(COINS.map((c, i) => tok[c.chain].holders(c.token, client(i))));

  const all = [...pages, ...holders, ...polled];
  const r429 = all.filter((a) => a.status === 429).length;
  const counted = (as: typeof holders) => as.filter((a, i) => a.status === 200 && JSON.parse(a.body).total === COINS[i]!.holders).length;
  const firstCount = counted(holders);
  const pollCount = counted(polled);
  const pageCount = pages.filter((a, i) => a.status === 200 && JSON.parse(a.body).row.holders === COINS[i]!.holders).length;
  console.log(
    `load: ${USERS} users, ${all.length} answers: 429 ${r429} (${((100 * r429) / all.length).toFixed(1)}%); holders with the count first ${firstCount}/${USERS}, at the next poll ${pollCount}/${USERS}; pages with the count ${pageCount}/${USERS}; calls: GeckoTerminal keyless ${hits.gt}, CoinGecko keyed ${hits.cg}, DexScreener ${hits.dex}; statuses ${JSON.stringify(Object.fromEntries([...new Set(all.map((a) => a.status))].map((s) => [s, all.filter((a) => a.status === s).length])))}`,
  );
  assert.equal(r429, 0, "a 429 under 50 users");
  assert.ok(all.every((a) => a.status === 200), "every page and holders answer is 200");
  assert.equal(pollCount, USERS, "every user's holders has its count by the next poll");
  assert.equal(hits.gt, 0, "the token page and holders take no call from GeckoTerminal's keyless window: it is the charts'");
  assert.ok(gecko.take("pages"), "a chart's first bars still find a GeckoTerminal call");
});

// The CO's fold at b25a82fb7: holder counts drew the CoinGecko key's one day (CG_DAY, 3,225 calls) with the charts, each
// open token re-read every 5 min, so 50 tokens open all day spent the whole day and the charts lost their calls (red at
// b25a82fb7: the holders took the day). A count is read again every 30 min, and only within the holders' own quarter
// of the day (token.ts HOLDERS_DAY), so the charts' three quarters stay whole.
test("a day of 50 open tokens, their holders tabs polling each minute: the holders spend at most their quarter of the key's day and never a chart's call", { timeout: 120_000 }, async () => {
  let t = Date.parse("2026-11-18T00:00:00Z");
  const clock = () => t;
  const due: { at: number; fn: () => void }[] = [];
  const later = (fn: () => void, ms: number) => void due.push({ at: t + ms, fn });
  let cg = 0;
  const fetch = async (url: string): Promise<Response> => {
    const cgm = new RegExp(`^${CG_ONCHAIN}/networks/(base|robinhood)/tokens/(0x[0-9a-f]{40})/info$`).exec(url);
    const dex = new RegExp(`^${DEX_BASE}/tokens/v1/(base|robinhood)/(0x[0-9a-f]{40})$`).exec(url);
    const m = cgm ?? dex;
    if (m === null) throw new Error(`unexpected ${url}`);
    const c = byToken.get(m[2]!)!;
    if (dex) return new Response(JSON.stringify(pairOf(c.chain, c.token)), { status: 200 });
    cg++;
    return new Response(JSON.stringify(infoOf(c.token, c.holders, t)), { status: 200 });
  };
  const env = { COINGECKO_API_KEY: "load-test-key-0123456789", COINGECKO_CALLS_PER_MIN: "100" };
  const holds = providerHolds(clock, coingeckoPace(env));
  const keyed = createKeyed(env, holds, { fetch });
  const dex = upstreamBudget(() => DEX_LIMITS, clock);
  const lists = { get: async () => ({ status: 200, body: JSON.stringify({ as_of_ms: t, lists: {} }), asOfMs: t }), listed: async () => false };
  // one holders' day for both chains, as the server's
  const day = holdersDay(clock);
  const tok = Object.fromEntries(
    CHAINS.map((c) => [c, createEvmToken(c, { lists, named: createEvmNamed(c, { dex, fetch, now: clock }), keyed, now: clock, later, day } as Parameters<typeof createEvmToken>[1])]),
  ) as Record<EvmChain, ReturnType<typeof createEvmToken>>;
  const end = t + 86_400_000 - 60_000;
  let counted = 0;
  let r429 = 0;
  for (; t <= end; t += 60_000) {
    while (due.length > 0 && due[0]!.at <= t) {
      due.sort((a, b) => a.at - b.at);
      due.shift()!.fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
    const got = await Promise.all(COINS.map((c, i) => tok[c.chain].holders(c.token, `198.51.100.${i}`)));
    r429 += got.filter((a) => a.status === 429).length;
    counted += got.filter((a) => a.status === 200 && JSON.parse(a.body).total !== null).length;
  }
  t = end; // the day's last minute, still the same UTC day
  const quarter = Math.floor(CG_DAY / 4);
  const charts = CG_DAY - Math.floor(CG_DAY * PROBE_DAY_SHARE) - quarter;
  console.log(`day: ${USERS} tokens polled each minute for 24 h: CoinGecko calls by holders ${cg} (their quarter ${quarter}, the day ${CG_DAY}); answers with a count ${counted} of ${USERS * 1440}; 429 ${r429}; the charts can still take ${charts}: ${!holds.dayOut(CG_URL, charts)}`);
  assert.equal(r429, 0);
  assert.ok(cg <= quarter, `the holders made ${cg} calls, their quarter is ${quarter}`);
  assert.equal(holds.dayOut(CG_URL, charts), false, `the charts' ${charts} calls of the day are still theirs`);
});
