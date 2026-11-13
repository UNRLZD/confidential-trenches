// The token page's chart data (card app-token-chart): the helper's GET /v1/market/candles answer as the chart's bars,
// and every planted bad answer refused whole (the chart's error state, never a partly drawn chart).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDLES_URL, FILL_WAIT_MS, THROTTLE_SPAN_S, isGecko, loadCandles, pricePrecision, priceText, toCandleData, volumeText } from "../src/screens/token/candles.ts";

const T0 = 1_762_000_200; // a 15m bucket start
const good = () => ({
  tf: "15m",
  candles: [
    [T0, "0.0000273", "0.0000290", "0.0000261", "0.0000280", "1520.5"],
    [T0 + 900, "0.0000280", "0.0000281", "0.0000270", "0.0000271", "0"],
    [T0 + 2700, "0.0000271", "0.0000300", "0.0000271", "0.0000299", "98000.25"],
  ],
  src: "geckoterminal",
  as_of_ms: 1_762_003_000_000,
});

test("a good answer: every bar, in ms, as numbers, with the price precision of its smallest low", () => {
  const d = toCandleData(good(), "15m", "geckoterminal");
  assert.ok(d && d.status === "ready");
  assert.equal(d.tf, "15m");
  assert.equal(d.bars.length, 3);
  assert.deepEqual(d.bars[0], { timestamp: T0 * 1000, open: 0.0000273, high: 0.000029, low: 0.0000261, close: 0.000028, volume: 1520.5 });
  assert.equal(d.bars[2]!.timestamp, (T0 + 2700) * 1000); // a gap in time is kept as the helper sent it
  assert.equal(d.precision, 8);
  assert.equal(d.gecko, true);
});

test("the source: the label only while a bar is GeckoTerminal's; the header wins over the body", () => {
  assert.equal(toCandleData({ ...good(), src: "chain" }, "15m", "chain")!.status, "ready");
  assert.equal((toCandleData({ ...good(), src: "chain" }, "15m", "chain") as { gecko: boolean }).gecko, false);
  assert.equal((toCandleData({ ...good(), src: "chain" }, "15m", "chain,geckoterminal") as { gecko: boolean }).gecko, true);
  assert.equal((toCandleData(good(), "15m", null) as { gecko: boolean }).gecko, true, "no header: the body's src");
  assert.equal(isGecko("chain"), false);
  assert.equal(isGecko("geckoterminal"), true);
  assert.equal(isGecko("chain,geckoterminal"), true);
  assert.equal(isGecko("notgeckoterminal"), false);
  assert.equal(isGecko(null), false);
});

test("RED at 6856d0c9: CoinGecko's paid bars (src coingecko, or chain,coingecko on a Base or Solana chart) carry the same label as GeckoTerminal's", () => {
  assert.equal(isGecko("coingecko"), true);
  assert.equal(isGecko("chain,coingecko"), true);
  assert.equal(isGecko("notcoingecko"), false);
  assert.equal((toCandleData({ ...good(), src: "chain" }, "15m", "chain,coingecko") as { gecko: boolean }).gecko, true);
  assert.equal((toCandleData({ ...good(), src: "coingecko" }, "15m", null) as { gecko: boolean }).gecko, true, "no header: the body's src");
});

test("no bars is the empty state, with its source", () => {
  assert.deepEqual(toCandleData({ ...good(), candles: [] }, "15m", "chain"), { status: "empty", gecko: false, held: true });
  assert.deepEqual(toCandleData({ ...good(), candles: [] }, "15m", "geckoterminal"), { status: "empty", gecko: true, held: true });
});

test("the helper's timeframe names: 1H, 4H and 1D are asked for as 1h, 4h and 1d", () => {
  assert.equal(CANDLES_URL("solana", "Mint111", "1H"), "https://ct-api.unrealized.trade/v1/market/candles?chain=solana&token=Mint111&tf=1h&limit=500");
  assert.match(CANDLES_URL("base", "0xab", "1D"), /tf=1d&limit=500$/);
  assert.equal(toCandleData({ ...good(), tf: "1h" }, "1H", "chain")!.status, "ready");
  assert.equal(toCandleData({ ...good(), tf: "1h" }, "15m", "chain"), null);
});

test("planted bad answers: each refused whole", () => {
  const row = (i: number, v: unknown) => {
    const b = good();
    (b.candles[1] as unknown[])[i] = v;
    return b;
  };
  const bad: [string, unknown][] = [
    ["not an object", [good()]],
    ["null", null],
    ["another timeframe", { ...good(), tf: "5m" }],
    ["no candles list", { ...good(), candles: { 0: [] } }],
    ["a row of five", (() => { const b = good(); (b.candles[1] as unknown[]).pop(); return b; })()],
    ["a row of seven", (() => { const b = good(); (b.candles[1] as unknown[]).push("1"); return b; })()],
    ["a row that is an object", { ...good(), candles: [{ t: T0 }] }],
    ["time as a string", row(0, String(T0 + 900))],
    ["time fractional", row(0, T0 + 900.5)],
    ["time zero", { ...good(), candles: [[0, "1", "1", "1", "1", "1"]] }],
    ["time negative", { ...good(), candles: [[-60, "1", "1", "1", "1", "1"]] }],
    ["time repeated", row(0, T0)],
    ["time going back", row(0, T0 - 900)],
    ["price as a number", row(1, 0.000028)],
    ["price in exponent form", row(1, "2.8e-5")],
    ["price negative", row(1, "-0.000028")],
    ["price with a sign", row(1, "+0.000028")],
    ["price NaN", row(1, "NaN")],
    ["price Infinity", row(1, "Infinity")],
    ["price empty", row(1, "")],
    ["price grouped", row(1, "1,000.5")],
    ["open zero", row(1, "0")],
    ["low zero", row(3, "0")],
    ["high under the close", row(2, "0.0000275")],
    ["low over the open", row(3, "0.0000281")],
    ["volume null", row(5, null)],
    ["volume negative", row(5, "-1")],
    ["a huge number string", row(5, "9".repeat(400))],
  ];
  for (const [what, body] of bad) assert.equal(toCandleData(body, "15m", "geckoterminal"), null, what);
  const noSrc: Record<string, unknown> = good();
  delete noSrc.src;
  assert.equal(toCandleData(noSrc, "15m", null), null, "no source in the header or the body");
});

test("the price precision: three significant digits of the smallest low, 2 at or above $1, at most 20", () => {
  const b = (low: number) => [{ timestamp: 1, open: low, high: low, low, close: low, volume: 0 }];
  assert.equal(pricePrecision(b(65_000)), 2);
  assert.equal(pricePrecision(b(1)), 2);
  assert.equal(pricePrecision(b(0.5)), 4);
  assert.equal(pricePrecision(b(0.00273)), 6);
  assert.equal(pricePrecision(b(1e-30)), 20);
  assert.equal(pricePrecision([]), 2);
});

test("the chart's text: prices and volume as Discover draws them; any other text unchanged", () => {
  assert.equal(priceText("0.00002730"), "$0.0₄273");
  assert.equal(priceText("0.00273"), "$0.00273");
  assert.equal(priceText("65000.00"), "$65,000.00");
  assert.equal(priceText("$4.82K"), "$4.82K");
  assert.equal(priceText("-5.17%"), "-5.17%");
  assert.equal(volumeText("4820"), "$4.82K");
  assert.equal(volumeText("0"), "$0");
});

test("the read: 404 is empty, another status, a bad body or a failed fetch is the error state, the header is read", async () => {
  const answer = (status: number, body: unknown, src: string | null) => async () =>
    new Response(JSON.stringify(body), { status, headers: src === null ? {} : { "X-Helper-Source": src } });
  assert.deepEqual(await loadCandles("solana", "M", "15m", answer(404, { error: { code: "not_found" } }, null)), { status: "empty", gecko: false, held: false });
  assert.deepEqual(await loadCandles("solana", "M", "15m", answer(503, {}, null)), { status: "error" });
  assert.deepEqual(await loadCandles("solana", "M", "15m", answer(200, { ...good(), tf: "1m" }, "geckoterminal")), { status: "error" });
  assert.deepEqual(await loadCandles("solana", "M", "15m", async () => { throw new Error("offline"); }), { status: "error" });
  const d = await loadCandles("base", "0xab", "15m", answer(200, { ...good(), src: "chain" }, "chain,geckoterminal"));
  assert.ok(d.status === "ready" && d.gecko === true);
  let asked = "";
  await loadCandles("base", "0xab", "4H", async (u) => { asked = String(u); return new Response("{}", { status: 503 }); });
  assert.match(asked, /chain=base&token=0xab&tf=4h&limit=500$/);
});

// card token-page-data-complete-and-fast: a cold Base or Robinhood chart past the helper's open bound answers no bars and
// `filling` true (apps/helper/src/data/evm/swaps.ts candles); the chart stays loading and reads again, never the empty
// state of a token with no bars, nor the error state of a failed read
test("a filling answer with no bars: read again every FILL_WAIT_MS while loading, drawn once its bars come; still filling past THROTTLE_SPAN_S is the error state", async () => {
  const filling = { tf: "15m", candles: [], filling: true, src: "chain", as_of_ms: 1 };
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);
  let n = 0;
  const d = await loadCandles("base", "0xab", "15m", async () => new Response(JSON.stringify(n++ < 3 ? filling : { ...good(), src: "chain" }), { status: 200 }), wait);
  assert.equal(d.status, "ready");
  assert.deepEqual(waits, [FILL_WAIT_MS, FILL_WAIT_MS, FILL_WAIT_MS]);
  waits.length = 0;
  const never = await loadCandles("base", "0xab", "15m", async () => new Response(JSON.stringify(filling), { status: 200 }), wait);
  assert.deepEqual(never, { status: "error" });
  assert.equal(waits.reduce((a, b) => a + b, 0), THROTTLE_SPAN_S * 1000, "one span waited, no more");
  // a filling answer that holds bars is drawn as it is
  assert.equal((await loadCandles("base", "0xab", "15m", async () => new Response(JSON.stringify({ ...good(), filling: true, src: "chain" }), { status: 200 }), wait)).status, "ready");
});

test("a 429: read again at each Retry-After until one budget window (THROTTLE_SPAN_S) is waited, then the error state", async () => {
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);
  let n = 0;
  // card evm-chart-opens-without-a-vendor-call: the helper's honest wait on a spent budget is up to 75 s; two reads at
  // most 10 s apart ended in the error state before the bars came (red at ffb2ec33: waits [3000, 10000], then error)
  const throttledThenGood = async () => {
    n++;
    return n <= 3 ? new Response("{}", { status: 429, headers: { "Retry-After": n === 1 ? "3" : n === 2 ? "40" : "600" } }) : new Response(JSON.stringify(good()), { status: 200, headers: { "X-Helper-Source": "geckoterminal" } });
  };
  const d = await loadCandles("solana", "M", "15m", throttledThenGood, wait);
  assert.equal(d.status, "ready");
  assert.deepEqual(waits, [3000, 40000, (THROTTLE_SPAN_S - 43) * 1000], "each Retry-After, the last cut to what is left of the window");
  n = 0;
  waits.length = 0;
  const always = async () => (n++, new Response("{}", { status: 429 }));
  assert.deepEqual(await loadCandles("solana", "M", "15m", always, wait), { status: "error" });
  assert.equal(n, THROTTLE_SPAN_S + 1, "no Retry-After: a second apart, the window through");
  assert.ok(waits.every((w) => w === 1000));
});
