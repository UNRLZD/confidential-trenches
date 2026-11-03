// node --test apps/helper/src/data/gecko-share.test.ts: the token page and the EVM lists on one GeckoTerminal budget,
// on a real server, against a GeckoTerminal that answers one address 5 calls in any 60 s and 429 past them (measured
// 2026-11-03 14:58Z, src/data/gecko.ts). The page goes first: with both chains' lists warmed, a token page's candles
// still answer, and while pages are opened the lists give up their calls; a repeat read inside its age calls nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { start } from "../server.ts";
import { createEvmLists, GT_BASE, GT_READS } from "./evm/lists.ts";
import { geckoBudget, GT_LIMIT_PER_MIN, LIST_FLOOR } from "./gecko.ts";
import { createSolanaToken } from "./solana/token.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = Date.parse("2026-11-02T13:53:00Z"); // the token page fixture's read
const FX = JSON.parse(readFileSync(new URL("./solana/fixtures/token-page.json", import.meta.url), "utf8"));
const evm = (f: string) => readFileSync(new URL(`./evm/fixtures/${f}`, import.meta.url), "utf8");
const LISTS: Record<string, string> = {};
for (const c of ["base", "robinhood"]) {
  LISTS[`${GT_BASE}/networks/${c}/${GT_READS.new}`] = evm(`gt-${c}-new.json`);
  LISTS[`${GT_BASE}/networks/${c}/${GT_READS.trending_5m}`] = evm(`gt-${c}-trending-5m.json`);
  LISTS[`${GT_BASE}/networks/${c}/${GT_READS.trending_1h}`] = evm(`gt-${c}-trending-1h.json`);
}
/** Five Solana mints, each a different token page. */
const MINTS = ["Q1vecEMQEgDyrw1txmBgFwUrkeQurqkEe1bGMzFpump", "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"];

/** One clock, one GeckoTerminal (5 a minute, then 429 "0"), RPC providers down (makers stay unread), and a server with
 *  the token page and both EVM chains' lists on one budget, as the helper's main builds them. */
async function world() {
  const clock = { now: NOW };
  const gt: { at: number; kind: "lists" | "page" }[] = [];
  const doFetch = async (url: string): Promise<Response> => {
    if (!url.startsWith(GT_BASE)) return new Response("down", { status: 503 });
    const t = clock.now;
    const inWindow = gt.filter((c) => t - c.at < 60_000);
    const kind = url.includes("/networks/solana/") ? "page" : "lists";
    gt.push({ at: t, kind });
    if (inWindow.length >= 5) return new Response('{"status":{"error_code":429}}', { status: 429, headers: { "retry-after": "0" } });
    const body = kind === "lists" ? LISTS[url] : JSON.stringify(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token);
    assert.ok(body, `unrecorded ${url}`);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  const now = () => clock.now;
  const budget = geckoBudget(now);
  const down = { handle: async () => ({ status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' }) };
  const token = createSolanaToken(down as never, down as never, { now, fetch: doFetch as never, gecko: budget });
  const lists = { base: createEvmLists("base", budget, { fetch: doFetch as never, now }), robinhood: createEvmLists("robinhood", budget, { fetch: doFetch as never, now }) };
  const server = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, token, undefined, undefined, lists);
  await new Promise<void>((ok) => server.on("listening", () => ok()));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port, path, headers: { origin: "https://confidential.unrealized.trade" } }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d)).on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
      });
      r.on("error", fail).end();
    });
  const candles = (mint: string, tf = "1h") => get(`/v1/market/candles?chain=solana&token=${mint}&tf=${tf}&limit=24`);
  const close = () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok())));
  const listsAnswer = (c: string) => get(`/v1/market/lists?chain=${c}`);
  return { clock, gt, lists, candles, listsAnswer, close };
}

test("both EVM chains' lists warmed, then a token page: its candles answer 200, never 429", async (t) => {
  const w = await world();
  t.after(w.close);
  await w.lists.base.tick();
  await w.lists.robinhood.tick();
  w.clock.now += 1_000;
  const c = await w.candles(MINTS[0]!);
  assert.equal(c.status, 200, `candles: ${c.status} ${c.body}`);
  assert.equal(w.gt.filter((x) => w.clock.now - x.at < 60_000).length <= 5, true, "GeckoTerminal never asked past its limit");
  // a repeat read inside its age calls GeckoTerminal no more
  const n = w.gt.length;
  w.clock.now += 30_000;
  assert.equal((await w.candles(MINTS[0]!)).status, 200);
  assert.equal(w.gt.length, n, "a repeat candles read inside CANDLES_FRESH_MS is served from the cache");
});

test("five token pages in a minute while the lists keep ticking: the lists take a call only for a list never read, within LIST_FLOOR; a page meets 429 only once pages themselves hold the other GT_LIMIT_PER_MIN - LIST_FLOOR of the minute (5 first opens need 10 calls, keyless GeckoTerminal gives 5)", async (t) => {
  const w = await world();
  t.after(w.close);
  await w.lists.base.tick();
  await w.lists.robinhood.tick();
  w.clock.now += 61_000; // the warm-up's calls have left the window
  const firstPage = w.clock.now;
  let answered = 0;
  for (const [i, mint] of MINTS.entries()) {
    const c = await w.candles(mint);
    const pagesHeld = w.gt.filter((x) => x.kind === "page" && w.clock.now - x.at < 60_000).length;
    if (c.status === 200) answered++;
    else {
      assert.equal(c.status, 429, `page ${i + 1}`);
      assert.ok(pagesHeld >= GT_LIMIT_PER_MIN - LIST_FLOOR, `page ${i + 1}: a 429 with only ${pagesHeld} page calls in the minute`);
    }
    w.clock.now += 12_000; // a page every 12 s, a lists tick between each
    await w.lists.base.tick();
    await w.lists.robinhood.tick();
  }
  assert.ok(answered >= 1, `pages answered: ${answered}`);
  const neverRead = 6 - w.gt.filter((x) => x.kind === "lists" && x.at < firstPage).length; // the warm-up read 3 of the 6
  assert.ok(w.gt.filter((x) => x.kind === "lists" && x.at >= firstPage).length <= neverRead, "while pages were opened the lists read only lists never read");
  assert.ok(w.gt.filter((x) => x.kind === "page").length <= 5, "and GeckoTerminal was asked no page call past its limit");
  // pages stop: within YIELD_MS and LIST_MS after the last page the lists read again
  w.clock.now += 120_000;
  await w.lists.base.tick();
  assert.ok(w.gt.some((x) => x.kind === "lists" && x.at === w.clock.now), "the lists read again once pages are quiet");
});

test("a helper started while a token page is open still serves its lists: a list never read is read past the yield (seen live: both chains 503 for 8 minutes under one page's candles every 20 s, the tf rotating)", async (t) => {
  const w = await world();
  t.after(w.close);
  const tfs = ["1h", "1m", "5m", "15m", "4h", "1d"];
  await w.candles(MINTS[1]!); // the page opens as the helper starts, then a tf each 20 s
  for (let i = 0; i < 12; i++) {
    await w.lists.base.tick();
    await w.lists.robinhood.tick();
    w.clock.now += 20_000;
    await w.candles(MINTS[1]!, tfs[(i + 1) % 6]);
  }
  for (const c of ["base", "robinhood"]) assert.equal((await w.listsAnswer(c)).status, 200, `${c} lists after ${(w.clock.now - NOW) / 1000} s`);
  for (let s = NOW; s < w.clock.now; s += 1_000) assert.ok(w.gt.filter((x) => x.at <= s && s - x.at < 60_000).length <= 5, "GeckoTerminal never asked past its limit");
});
