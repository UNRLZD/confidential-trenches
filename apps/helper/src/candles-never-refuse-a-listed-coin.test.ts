// node --test apps/helper/src/candles-never-refuse-a-listed-coin.test.ts (card helper-candles-never-refuse-a-listed-coin):
// release 157's app live run 43763914220 (15 Nov 21:41Z) opened the first listed Solana coin, TTWO, and its chart stayed
// empty: the helper log for 21:29-21:43Z held 33 windows of "refused /v1/market/candles geckoterminal budget filling N in
// 10 s" while every app and sign live check ran at once, and every CoinGecko keyed read that minute was refused by the
// key's day share ("coingecko calls: day N" from the container's start at 21:20Z), so each chart read fell to
// GeckoTerminal's keyless 5 calls in 75 s. A listed coin whose bars were held past GT_SERVE_MS, or held none, answered
// 200 with no bars (`filling`), and a refused read was queued nowhere on Solana. Here a helper runs as the deployed one
// does on a spent keyed day (no key: every chart on the keyless budget): Discover lists LISTED coins off pump.fun, the
// helper ticks its ahead lane as server.ts does, the budget is then spent by others, the bars age past GT_SERVE_MS, and
// a crowd opens every listed coin's first chart (15m) at once. Want: no answer a refusal (non-200, or 200 with no bars).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { handler } from "./server.ts";
import { refusalLog } from "./limits/limits.ts";
import { geckoBudget, GT_LIMIT_PER_MIN, GT_SERVE_MS } from "./data/gecko.ts";
import { b58encode } from "./data/solana/lists.ts";
import { AHEAD_TICK_MS, createSolanaToken } from "./data/solana/token.ts";
import { createSolanaTrades } from "./data/solana/trades.ts";

const FX = JSON.parse(readFileSync(new URL("./data/solana/fixtures/token-page.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-02T13:53:00Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
/** Listed coins off pump.fun (tokenized stocks, majors: TTWO's kind) and the readers of each at once. */
const LISTED = 12;
const CROWD = 6;
/** One mint per coin: 32 bytes of i + 1, in base58 (a valid address, no real coin's). */
const MINTS = Array.from({ length: LISTED }, (_, i) => b58encode(new Uint8Array(32).fill(i + 1)));
const PUMP_COIN = b58encode(new Uint8Array(32).fill(200));
const LISTS = { status: 200, body: JSON.stringify({ lists: { trending: [...MINTS.map((token) => ({ token, launchpad: null })), { token: PUMP_COIN, launchpad: "pump.fun" }], new: [] } }), asOfMs: NOW };

/** GeckoTerminal as recorded (its token and its pool's minute bars), each call counted by kind. */
function gecko() {
  const urls: string[] = [];
  const fetch = async (url: string) => (urls.push(url), new Response(JSON.stringify(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token), { status: 200, headers: { "content-type": "application/json" } }));
  return { urls, fetch };
}
const silent = { async handle() { return { status: 503, headers: {}, body: "{}" }; } };
function get(port: number, path: string, ip: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { origin: APP, "x-forwarded-for": ip }, agent: false }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => done({ status: res.statusCode!, body: b }));
    });
    r.on("error", fail).end();
  });
}
type Ahead = { ahead: () => Promise<string | null> };

async function flood() {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const budget = geckoBudget(now);
  const tok = createSolanaToken(silent as never, silent as never, { now, fetch: gt.fetch as never, gecko: budget, listed: async () => LISTS, later: () => undefined } as never) as ReturnType<typeof createSolanaToken> & Ahead;
  // the lists stand for 40 min before the run, the server ticking the ahead lane every AHEAD_TICK_MS
  for (const end = t + 40 * 60_000; t < end; t += AHEAD_TICK_MS) await tok.ahead();
  const warmCalls = gt.urls.length;
  // another hour: no listed chart is read again for its own sake (the warm-up is a few hundred calls once, not a rate);
  // the list's first row is the Trending row token.ts keeps fresh (TOP_MAX), as before this card
  for (const end = t + 60 * 60_000; t < end; t += AHEAD_TICK_MS) await tok.ahead();
  const idleCalls = gt.urls.slice(warmCalls).filter((u) => !u.includes(MINTS[0]!)).length;
  // the run: the bars are past GT_SERVE_MS, the window spent by others' reads
  t += GT_SERVE_MS;
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) budget.take("pages");
  const lines: string[] = [];
  const refusals = refusalLog((l) => lines.push(l));
  const h = createServer(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, tok as never, undefined, null, new Map(), new Map(), now, {}, {}, () => true, Promise.resolve(), () => ({}), refusals));
  await new Promise<void>((r) => h.listen(0, "127.0.0.1", () => r()));
  const port = (h.address() as AddressInfo).port;
  try {
    const reads = MINTS.flatMap((m) => Array.from({ length: CROWD }, (_, i) => ({ m, ip: `198.18.0.${i + 1}` })));
    const answers = await Promise.all(reads.map(({ m, ip }) => get(port, `/v1/market/candles?chain=solana&token=${m}&tf=15m&limit=500`, ip).then((a) => ({ m, ...a }))));
    refusals.flush();
    const refused = answers.filter((a) => a.status !== 200 || !(JSON.parse(a.body).candles?.length > 0));
    return { answers, refused, lines, warmCalls, idleCalls, t, pumpRead: gt.urls.some((u) => u.includes(PUMP_COIN)) };
  } finally {
    h.closeAllConnections();
    await new Promise<void>((r) => h.close(() => r()));
  }
}

test(`${LISTED} listed coins off our own venues, ${CROWD} readers each at once, the budget spent and their bars past GT_SERVE_MS: no candles read is refused (non-200 or no bars)`, async () => {
  const r = await flood();
  assert.equal(r.answers.length, LISTED * CROWD);
  assert.deepEqual(r.refused.map((a) => `${a.m.slice(0, 6)} ${a.status} ${a.body.slice(0, 60)}`), [], `${r.refused.length} of ${r.answers.length} refused`);
  assert.deepEqual(r.lines, [], "no refusal logged");
  for (const a of r.answers) {
    const c = JSON.parse(a.body);
    assert.ok(c.as_of_ms <= r.t && c.as_of_ms >= NOW, "dated by the bars' own read, never as fresher than they are");
  }
});

test("the listed charts are read once ahead, never as a rate, and a pump.fun coin (our own trade reads' venue) is not read ahead", async () => {
  const r = await flood();
  assert.ok(r.warmCalls <= 2 * LISTED + 8, `the warm-up: ${r.warmCalls} calls, its top pool and bars a coin`);
  assert.equal(r.idleCalls, 0, "no listed chart read again for its own sake");
  assert.equal(r.pumpRead, false);
});

test("a chart nobody holds, refused by the budget, is queued and read at the next free call: the page's next read is its bars", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const budget = geckoBudget(now);
  const later: (() => void)[] = [];
  const tok = createSolanaToken(silent as never, silent as never, { now, fetch: gt.fetch as never, gecko: budget, later: (fn: () => void) => void later.push(fn) } as never);
  const COLD = MINTS[0]!;
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) budget.take("pages");
  const first = await tok.candles(COLD, "15m", null, 500);
  assert.equal(first.status, 429, "nothing held, the window spent: the route answers it filling (server.ts fillingOf)");
  t += 80_000; // the window frees
  while (later.length > 0) {
    later.shift()!();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(gt.urls.map((u) => (u.includes("/ohlcv/") ? "bars" : "pool")), ["pool", "bars"], "the queue read its top pool, then its bars");
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) budget.take("pages"); // spent again
  const next = await tok.candles(COLD, "15m", null, 500);
  assert.equal(next.status, 200, next.body.slice(0, 80));
  assert.ok(JSON.parse(next.body).candles.length > 0);
});

test("a listed coin whose walk of ours cannot open (its reads fail, or OPEN_MAX walks are open) is served the history source's chart, never the open's refusal", async () => {
  const bars = [[Math.floor(NOW / 1000) - 900, "1", "1", "1", "1", "0"]];
  const hist = { status: 200, body: JSON.stringify({ tf: "15m", candles: bars, src: "geckoterminal", as_of_ms: NOW }), src: "geckoterminal", asOfMs: NOW };
  const t = createSolanaTrades({ fetch: (async () => new Response("down", { status: 503 })) as never, now: () => NOW, listed: async () => true, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: async () => undefined, history: async () => hist } as never);
  const a = await t.candles(MINTS[0]!, "15m", null, 500);
  t.stop();
  assert.equal(a.status, 200, a.body.slice(0, 80));
  assert.deepEqual(JSON.parse(a.body).candles, bars);
});
