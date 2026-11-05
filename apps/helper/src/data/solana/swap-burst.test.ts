// node --test apps/helper/src/data/solana/swap-burst.test.ts (card helper-crowd-429, fold 5): the helper live suite's
// charts right after a deploy's swap, replayed against GeckoTerminal's one budget (../gecko.ts). Live run 41935321432 at
// 251d468 (swap 23:38:15Z): app-console-429 opened Trending's top 15m chart at 23:39:00.9Z, its bars held from the old
// helper and still servable, and it waited for and took the window's last call (its 25 candles answered 200 in 2.5 s);
// 0.1 s later market-data-solana-token's PUMP 1h, with nothing servable, met the full window, its next free call more than
// GT_PAGE_WAIT_MS away, and answered 429 (helper log: "refused /v1/market/candles geckoterminal budget 1 in 10 s"). The
// window's other four calls are the old helper's, seeded from its warm file (server.ts seedGecko); the helper logged no
// count of them, so their lanes are not read (the minute line, gecko.ts minute(), names them from the next swap on).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { geckoBudget, GT_LIMIT_PER_MIN, GT_SERVE_MS, WINDOW_MS } from "../gecko.ts";
import { createSolanaToken } from "./token.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const TOP = "Q1vecEMQEgDyrw1txmBgFwUrkeQurqkEe1bGMzFpump";
const NOW = Date.parse("2026-11-02T13:53:00Z");
const CROWD = 25;

const unused = { async handle(): Promise<never> { throw new Error("no chain or Jupiter read in a chart") } };
function gecko() {
  const urls: string[] = [];
  const fetch = async (url: string) => (urls.push(url), new Response(JSON.stringify(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token), { status: 200, headers: { "content-type": "application/json" } }));
  return { urls, fetch };
}
type Token = ReturnType<typeof createSolanaToken>;

/** The old helper read PUMP's chart 15 min before the swap (past GT_SERVE_MS: nothing servable) and Trending's top chart
 *  300 s before it (servable); the new helper takes its state over with four of the window's five calls spent. */
async function swapThenBurst() {
  let t = NOW - 900_000;
  const now = () => t;
  const old = createSolanaToken(unused as never, unused as never, { now, fetch: gecko().fetch as never, gecko: geckoBudget(now) });
  assert.equal((await old.candles(PUMP, "1m", null, 24)).status, 200);
  t = NOW - 300_000;
  assert.equal((await old.candles(TOP, "15m", null, 500)).status, 200);
  const file = JSON.parse(JSON.stringify(old.state()));

  t = NOW;
  const budget = geckoBudget(now);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN - 1 }, (_, i) => t - 10_000 + i * 1_000)); // next free call in 65 s
  const gt = gecko();
  const fresh: Token = createSolanaToken(unused as never, unused as never, { now, fetch: gt.fetch as never, gecko: budget });
  fresh.restore(file);
  // as the suite ran: Trending's chart opened first (25 at once), PUMP's a moment after
  const top = Array.from({ length: CROWD }, () => fresh.candles(TOP, "15m", null, 500));
  await Promise.resolve();
  const pump = fresh.candles(PUMP, "1m", null, 24);
  return { top: await Promise.all(top), pump: await pump, gtUrls: gt.urls, line: budget.minute?.() };
}

test("right after a swap, with one call free: PUMP's chart (nothing servable) takes it and answers 200 in the frozen wire form, and Trending's (servable) is served its held bars, dated, with no call", async () => {
  const r = await swapThenBurst();
  assert.equal(r.pump.status, 200, `PUMP's chart answered ${r.pump.status} ${r.pump.body}`);
  const c = JSON.parse(r.pump.body);
  assert.deepEqual(Object.keys(c), ["tf", "candles", "src", "as_of_ms"]);
  assert.equal(c.src, "geckoterminal");
  assert.equal(c.as_of_ms, NOW, "read now, not the old helper's 15-minute-old bars");
  // the frozen wire form (scripts/live-checks/market-data-solana-token.mjs CANDLES and candlesFault): bars oldest first,
  // [t_s, o, h, l, c, vol_usd] with whole-second times on the grid and decimal strings
  assert.ok(c.candles.length > 0 && c.candles.length <= 24, `${c.candles.length} bars`);
  for (const [i, b] of (c.candles as unknown[][]).entries()) {
    assert.ok(b.length === 6 && Number.isSafeInteger(b[0]) && (b[0] as number) % 60 === 0 && b.slice(1).every((v) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v)), `bar ${i} ${JSON.stringify(b)}`);
    if (i > 0) assert.ok((b[0] as number) > (c.candles[i - 1][0] as number), `bar ${i} after bar ${i - 1}`);
  }
  for (const a of r.top) {
    assert.equal(a.status, 200);
    const b = JSON.parse(a.body);
    assert.equal(b.as_of_ms, NOW - 300_000, "the held bars, dated by their read");
    assert.ok(NOW - b.as_of_ms <= GT_SERVE_MS && b.candles.length > 0);
  }
  assert.equal(r.gtUrls.length, 1, `one GeckoTerminal call: ${r.gtUrls.join(" ")}`);
  assert.ok(r.gtUrls[0]!.includes("/ohlcv/minute"), "PUMP's bars, its pool held");
  // PUMP's pool, past its 10 min, is a refresh refused (its held pool serves); Trending's bars a stale read refused
  assert.equal(r.line, "geckoterminal calls: pages sol bars 1; refused: refresh 1, stale 1; 429 0; seeded 4; window 5 of 5");
});

test("a chart whose pool is held waits up to GT_CHART_WAIT_MS for the next free call instead of a 429", async () => {
  const { GT_CHART_WAIT_MS, GT_PAGE_WAIT_MS } = (await import("./token.ts")) as { GT_CHART_WAIT_MS?: number; GT_PAGE_WAIT_MS: number };
  const start = Date.now();
  const now = () => Date.now();
  const seedAt = start - WINDOW_MS + GT_PAGE_WAIT_MS + 1_000; // the next free call 5 s away: past one call's wait, inside a chart's
  const old = createSolanaToken(unused as never, unused as never, { now, fetch: gecko().fetch as never, gecko: geckoBudget(now) });
  assert.equal((await old.candles(PUMP, "1m", null, 24)).status, 200);
  const state = JSON.parse(JSON.stringify(old.state()));
  state.kept = []; // the pool held, no bars
  const budget = geckoBudget(now);
  budget.seed(Array.from({ length: GT_LIMIT_PER_MIN }, (_, i) => seedAt + i * 10));
  const gt = gecko();
  const fresh = createSolanaToken(unused as never, unused as never, { now, fetch: gt.fetch as never, gecko: budget });
  fresh.restore(state);
  const a = await fresh.candles(PUMP, "1m", null, 24);
  const waited = Date.now() - start;
  assert.equal(a.status, 200, `answered ${a.status} ${a.body} after ${waited} ms`);
  assert.ok(GT_CHART_WAIT_MS! > GT_PAGE_WAIT_MS && GT_CHART_WAIT_MS! <= 8_000, "inside the app's 10 s request with GeckoTerminal's answer");
  assert.ok(waited >= GT_PAGE_WAIT_MS && waited < GT_CHART_WAIT_MS! + 1_000, `waited ${waited} ms`);
  assert.equal(gt.urls.length, 1);
});

test("bars before a time are closed once read: a range the handed-over bars cover is served from them after a swap, with no GeckoTerminal call", async () => {
  let t = NOW - 60_000;
  const now = () => t;
  const old = createSolanaToken(unused as never, unused as never, { now, fetch: gecko().fetch as never, gecko: geckoBudget(now) });
  const first = JSON.parse((await old.candles(PUMP, "1m", null, 500)).body).candles as unknown[][];
  const file = JSON.parse(JSON.stringify(old.state()));
  t = NOW;
  const budget = geckoBudget(now);
  budget.seed([t - 1_000]); // the window has room: the call is not spent because the bars are held, not because it is refused
  const gt = gecko();
  const fresh = createSolanaToken(unused as never, unused as never, { now, fetch: gt.fetch as never, gecko: budget });
  fresh.restore(file);
  const to = first.at(-5)![0] as number; // the bars before our own first, as solana/trades.ts asks them
  const a = await fresh.candles(PUMP, "1m", to, 500);
  assert.equal(a.status, 200, `answered ${a.status} ${a.body}`);
  const c = JSON.parse(a.body);
  assert.deepEqual(c.candles, first.filter((b) => (b[0] as number) < to), "every held bar before the time, oldest first");
  assert.equal(gt.urls.length, 0, "no GeckoTerminal call");
  // a time after their read is not history they hold: it goes to GeckoTerminal
  assert.equal((await fresh.candles(PUMP, "1m", Math.floor(NOW / 1000) + 60, 500)).status, 200);
  assert.equal(gt.urls.length, 1, "a range past the held bars' read is read");
});
