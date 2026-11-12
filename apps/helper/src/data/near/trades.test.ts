// A NEAR token's tape and chart from Rhea's swap logs (card helper-near-lists-and-token), replayed from one real read of
// FastNEAR's transactions API (fixtures/rhea-reads-2026-11-11.json `tx`) on the recorded pool read (lists.test.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createNearLists } from "./lists.ts";
import { fixtureFetch } from "./fixtures/replay.ts";
import { createNearTrades, ordered, swapsOf, TX_API, type NearSwap } from "./trades.ts";
import type { Fetch } from "./views.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/rhea-reads-2026-11-11.json", import.meta.url), "utf8")) as { tx: { path: string; body: unknown; answer: unknown }[] };
const TXS = new Map(FX.tx.map((t) => [`${t.path} ${JSON.stringify(t.body)}`, t.answer]));
const RHEA = "token.rhealab.near";
const HASH = "9TQmFzu4TLZUdspRnjqmoJeJ5ZAjmwdVY71VdeX8L1xf";

function txFetch(calls: string[] = []): Fetch {
  const rpc = fixtureFetch();
  return async (url, init) => {
    if (!url.startsWith(TX_API)) return rpc(url, init);
    const key = `${new URL(url).pathname} ${String(init.body)}`;
    calls.push(key);
    const a = TXS.get(key);
    return a === undefined ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(a), { status: 200 });
  };
}

const entry = (logs: string[], over: Record<string, unknown> = {}) => ({
  transaction: { hash: HASH, signer_id: "alice.near" },
  receipts: [{ execution_outcome: { block_height: 100, block_timestamp: 1794420335136317000, index: 2, outcome: { executor_id: "v2.ref-finance.near", logs }, ...over } }],
});

test("swapsOf: Rhea's log lines of the token against wNEAR, a buy when wNEAR goes in; every other line, executor or shape dropped", () => {
  const s = swapsOf(RHEA, entry([
    "Swapped 5316212000607981054328052 wrap.near for 512553370962285307909 token.rhealab.near",
    "Swapped 1712821436426918309 token.rhealab.near for 17488972416894112981004 wrap.near, total fee 1997, admin fee 399",
    "Swapped 20000000 usdt.tether-token.near for 19977952 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1, total fee 1997, admin fee 399",
    "Swapped 0 wrap.near for 5 token.rhealab.near",
    "Swapped 1 wrap.near for 5 token.rhealab.near and more",
    "EVENT_JSON:{}",
  ]));
  assert.deepEqual(s, [
    { block: 100, pos: 128, index: 0, tx: HASH, t: 1794420335, side: "b", amt: 512553370962285307909n, quote: 5316212000607981054328052n, trader: "alice.near" },
    { block: 100, pos: 129, index: 0, tx: HASH, t: 1794420335, side: "s", amt: 1712821436426918309n, quote: 17488972416894112981004n, trader: "alice.near" },
  ]);
  assert.deepEqual(swapsOf(RHEA, entry(["Swapped 1 wrap.near for 5 token.rhealab.near"], { outcome: { executor_id: "evil.near", logs: ["Swapped 1 wrap.near for 5 token.rhealab.near"] } })), []);
  assert.deepEqual(swapsOf(RHEA, { transaction: { hash: "nope" }, receipts: [] }), []);
  assert.equal(swapsOf(RHEA, { ...entry(["Swapped 1 wrap.near for 5 token.rhealab.near"]), transaction: { hash: HASH, signer_id: "Bad Signer" } })[0]!.trader, null);
});

test("ordered: two transactions' receipts sharing an outcome index in one block get distinct places, in (block, pos, tx) order", () => {
  const w = (block: number, pos: number, tx: string): NearSwap => ({ block, pos, index: 0, tx, t: 0, side: "b", amt: 1n, quote: 1n, trader: null });
  const o = ordered([w(5, 0, "B"), w(5, 0, "A"), w(4, 9, "C"), w(5, 64, "A")]);
  assert.deepEqual(o.map((s) => [s.block, s.index, s.tx]), [[4, 0, "C"], [5, 0, "A"], [5, 1, "B"], [5, 2, "A"]]);
});

test("trades and candles on the recorded reads: the other chains' shapes, newest first, priced at NEAR's price, src fastnear", async () => {
  const calls: string[] = [];
  const lists = createNearLists({ fetch: txFetch() });
  const tr = createNearTrades(lists, { fetch: txFetch(calls) });
  const a = await tr.trades(RHEA, 50);
  assert.equal(a.status, 200);
  const body = JSON.parse(a.body);
  assert.deepEqual(Object.keys(body), ["trades", "src", "as_of_ms"]);
  assert.equal(body.src, "fastnear");
  assert.ok(body.trades.length > 0);
  for (const r of body.trades) {
    assert.deepEqual(Object.keys(r), ["t_ms", "side", "usd", "amt", "trader", "tx"]);
    assert.ok(r.side === "b" || r.side === "s");
    assert.match(r.usd, /^\d+(\.\d+)?$/);
    assert.match(r.tx, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  }
  const ts = body.trades.map((r: { t_ms: number }) => r.t_ms);
  assert.deepEqual(ts, [...ts].sort((x: number, y: number) => y - x));
  // a cold read asks for one call's worth: the listing, then one batch of 20
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /"max":20/);
  const c = await tr.candles(RHEA, "1m", null, 500);
  const cb = JSON.parse(c.body);
  assert.equal(cb.tf, "1m");
  assert.equal(cb.src, "fastnear");
  assert.ok(cb.candles.length > 0);
  for (const k of cb.candles) assert.equal(k.length, 6);
  // the same reads served again inside FRESH_MS: no new call
  await tr.trades(RHEA, 5);
  assert.equal(calls.length, 2);
  assert.equal((await tr.candles(RHEA, "2m", null, 10)).status, 404);
  assert.equal((await tr.trades(RHEA, 51)).status, 404);
  assert.equal((await tr.trades("no-pool-token.near", 5)).status, 404);
});

test("a tx API that fails on a cold read: 503, never an empty tape passed off as real", async () => {
  const lists = createNearLists({ fetch: fixtureFetch() });
  const tr = createNearTrades(lists, { fetch: async (url, init) => (url.startsWith(TX_API) ? new Response("busy", { status: 429 }) : fixtureFetch()(url, init)) });
  assert.equal((await tr.trades(RHEA, 5)).status, 503);
  assert.equal((await tr.candles(RHEA, "1m", null, 5)).status, 503);
});
