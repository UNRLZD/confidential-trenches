// node --test apps/helper/src/candles-never-429.test.ts (card chart-candles-never-429): no viewer's chart read is ever
// answered 429. Live run 43396216450 (13 Nov 08:54-08:56Z, helper 6de76338d) logged "refused /v1/market/candles
// geckoterminal budget" three times while GeckoTerminal's own 429 count was 0 and 1: the helper's own budget (5 calls in
// 75 s, data/gecko.ts) refused cold charts with nothing held, and the route answered 429, which the browser logs as a
// failed load (app-shell BAD on "/" and "/token/<first listed>"). Now the route answers 200 with no bars and `filling`
// true, the form the page reads again FILL_WAIT_MS on (apps/terminal/src/screens/token/candles.ts loadCandles), on every
// chain, and a cached proxy answer is never refused to an address past its share.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { geckoBudget, GT_LIMIT_PER_MIN, WINDOW_MS } from "./data/gecko.ts";
import { createSolanaToken, type DataAnswer } from "./data/solana/token.ts";
import { createProxy } from "./proxy/proxy.ts";
import { handler } from "./server.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
const FX = JSON.parse(readFileSync(new URL("./data/solana/fixtures/token-page.json", import.meta.url), "utf8"));
/** BONK, the chart app-faults-seen-on-126 opens (a mint off Discover's lists: its bars are GeckoTerminal's). */
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const BASE_TOKEN = "0x4200000000000000000000000000000000000006";
/** Viewers behind one address (a judge room, a live run's runners) and as many on addresses of their own. */
const VIEWERS = 40;
/** One address's share of Jupiter's calls in the test's plan. */
const SHARE = 4;

const servers: ReturnType<typeof createServer>[] = [];
after(() => Promise.all(servers.map((s) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))))).then(() => undefined));
async function listen(h: ReturnType<typeof handler>): Promise<number> {
  const s = createServer(h);
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  return (s.address() as AddressInfo).port;
}
function get(port: number, path: string, xff: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { origin: APP, "x-forwarded-for": xff } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", fail).end();
  });
}
const unused = { async handle(): Promise<never> { throw new Error("no chain or Jupiter read in a chart") } };
/** Each answer's status, and of the 200s how many are `filling` with no bars and how many carry bars. */
function shape(as: { status: number; body: string }[]) {
  const st = new Map<number, number>();
  let filling = 0;
  let bars = 0;
  for (const a of as) {
    st.set(a.status, (st.get(a.status) ?? 0) + 1);
    if (a.status !== 200) continue;
    const b = JSON.parse(a.body) as { candles: unknown[]; filling?: boolean };
    if (b.filling === true && b.candles.length === 0) filling++;
    else if (b.candles.length > 0) bars++;
  }
  return { statuses: Object.fromEntries(st), filling, bars };
}

test(`Solana: GeckoTerminal's budget spent, ${VIEWERS} viewers behind one address and ${VIEWERS} on their own open a cold chart: zero 429, each answered filling; once the window turns one read fills it and every viewer is served its bars from the one read`, async () => {
  let t = Date.parse("2026-11-13T08:54:50Z");
  const now = () => t;
  const sleep = async (ms: number) => void (t += ms);
  const budget = geckoBudget(now);
  // the window spent a second ago: its next free call 74 s away, past a chart's wait (token.ts GT_CHART_WAIT_MS)
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN }, () => t - 1_000));
  const urls: string[] = [];
  const fetch = async (url: string) => (urls.push(url), new Response(JSON.stringify(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token), { status: 200, headers: { "content-type": "application/json" } }));
  const token = createSolanaToken(unused as never, unused as never, { now, sleep, fetch: fetch as never, gecko: budget });
  const port = await listen(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, token));
  const path = `/v1/market/candles?chain=solana&token=${BONK}&tf=15m&limit=500`;
  const crowd = () => Promise.all([...Array.from({ length: VIEWERS }, () => get(port, path, "198.18.0.1")), ...Array.from({ length: VIEWERS }, (_, i) => get(port, path, `198.18.1.${i + 1}`))]);

  const cold = shape(await crowd());
  assert.deepEqual(cold, { statuses: { 200: 2 * VIEWERS }, filling: 2 * VIEWERS, bars: 0 }, "no 429: every viewer is told the chart is filling");
  assert.equal(urls.length, 0, "no GeckoTerminal call past its budget");

  t += WINDOW_MS; // the window turns: the next read takes its calls (the top pool, then the bars)
  const warm = shape(await crowd());
  assert.equal(warm.statuses[429], undefined, JSON.stringify(warm));
  assert.equal(warm.bars, 2 * VIEWERS, `every viewer served its bars: ${JSON.stringify(warm)}`);
  assert.equal(urls.length, 2, `one read for every viewer: ${urls.join(" ")}`);
});

test("Base, Robinhood and NEAR: a chart read the data layer answers 429 (its budget, a vendor's 429, its open books full) is answered 200 filling with no bars, never 429", async () => {
  const limited = async (): Promise<DataAnswer> => ({ status: 429, body: '{"error":{"code":"rate_limited"}}', retryAfterS: 9, why: "geckoterminal budget" });
  const swaps = { candles: limited, trades: limited, change4h: () => null };
  const near = { trades: { candles: limited, trades: limited }, token: { page: limited, holders: limited }, lists: { get: limited } };
  const port = await listen(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), new Map(), () => Date.now(), {}, { base: swaps, robinhood: swaps } as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, near as never));
  for (const [chain, tok] of [["base", BASE_TOKEN], ["robinhood", BASE_TOKEN], ["near", "wrap.near"]] as const) {
    const as = await Promise.all(Array.from({ length: VIEWERS }, () => get(port, `/v1/market/candles?chain=${chain}&token=${tok}&tf=15m`, "198.18.2.1")));
    assert.deepEqual(shape(as), { statuses: { 200: VIEWERS }, filling: VIEWERS, bars: 0 }, chain);
    const b = JSON.parse(as[0]!.body);
    assert.deepEqual(Object.keys(b), ["tf", "candles", "filling", "src", "as_of_ms"], "the EVM books' filling form");
    assert.equal(b.tf, "15m");
  }
});

test("a cached proxy answer, and a call joining one in flight, are never refused to an address past its share: one vendor call serves them all", async () => {
  let t = 1_800_000_000_000;
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const fetch = async (url: string) => (seen.push(url), await gate, new Response(JSON.stringify({ list: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  // Jupiter's keyless plan named: 60 calls a minute, a share of SHARE an address
  const p = createProxy({ PROXY_BUDGET_JUPITER: `60,${SHARE}` }, { burstMs: 0, fetch: fetch as never, now: () => t, sleep: async (ms: number) => void (t += ms) });
  // the viewers behind one address join the first read in flight, then read its cached answer, ten shares' worth
  const joined = Array.from({ length: SHARE * 10 }, () => p.handle("jupiter", "/tokens/v2/toptrending/1h", "limit=100", "", "198.18.3.1"));
  release();
  const js = await Promise.all(joined);
  assert.deepEqual([...new Set(js.map((a) => a.status))], [200], "every join served");
  const hits = await Promise.all(Array.from({ length: SHARE * 10 }, () => p.handle("jupiter", "/tokens/v2/toptrending/1h", "limit=100", "", "198.18.3.1")));
  assert.deepEqual([...new Set(hits.map((a) => a.status))], [200], "every hit served");
  assert.equal(seen.length, 1, "one vendor call");
});

test("a chart's read held past CANDLES_ANSWER_MS (a cold Solana chart waiting up to 8 s for GeckoTerminal's next call) is answered filling inside the page's 10 s request, and its next read is served what the read got", async () => {
  const { CANDLES_ANSWER_MS } = await import("./server.ts");
  assert.ok(CANDLES_ANSWER_MS <= 5_000, "half the page's 10 s request");
  const BAR = [1_794_000_600, "1", "1", "1", "1", "1"];
  let held: DataAnswer | null = null;
  let running: Promise<DataAnswer> | null = null;
  // the data layer as token.ts's cache is: one read in flight per key, its answer held once it lands
  const candles = (): Promise<DataAnswer> => {
    if (held !== null) return Promise.resolve(held);
    running ??= new Promise<DataAnswer>((ok) => setTimeout(() => ok((held = { status: 200, body: JSON.stringify({ tf: "15m", candles: [BAR], src: "geckoterminal", as_of_ms: Date.now() }), src: "geckoterminal", asOfMs: Date.now() })), CANDLES_ANSWER_MS + 1_000));
    return running;
  };
  const port = await listen(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, { candles } as never));
  const path = `/v1/market/candles?chain=solana&token=${BONK}&tf=15m`;
  const first = await get(port, path, "198.18.4.1");
  // answered before the read landed: the bound answered it, not the read
  assert.equal(held, null, "the read was still out when the page was answered");
  assert.equal(first.status, 200, first.body);
  assert.deepEqual(shape([first]).filling, 1, first.body);
  await running;
  const next = await get(port, path, "198.18.4.1");
  assert.deepEqual(JSON.parse(next.body).candles, [BAR], "the read that went on is served");
});
