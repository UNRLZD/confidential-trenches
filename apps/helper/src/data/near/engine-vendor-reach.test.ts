// node --test apps/helper/src/data/near/engine-vendor-reach.test.ts: a NEAR token's tape from the unrealized.trade
// engine (engine.ts trades) claims a complete list (`whole_ms`, which the page counts its buys, sells and volume by) only
// while the engine's rows were read within NEAR_VENDOR_REACH_MS; every such tape names how long ago its rows were read in
// Server-Timing (near-vendor-read). Card vendor-tapes-name-their-reach-every-chain: the engine's cache serves its held
// rows while a renewal runs and after it fails, at any age, and they kept the whole_ms of their read, the bug card
// evm-vendor-tape-names-its-reach fixed on Base and Robinhood (../evm/swaps.ts noneTrades). Replayed from the engine's
// recorded answers of 2026-11-14 03:53Z (fixtures/engine-2026-11-14, as engine.test.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createEngineNear, engineFirst, ENGINE, FRESH_MS, NEAR_VENDOR_REACH_MS } from "./engine.ts";
import { FRESH_MS as RHEA_FRESH_MS } from "./trades.ts";
import type { NearMarket } from "./token.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/engine-2026-11-14/${name}.json`, import.meta.url), "utf8");
const T = "dragons-2.nearlytrade.near";
const VENDOR_READ = /(?:^|,)\s*near-vendor-read;desc="rows read (\d+) ms ago"/;
const rhea = { trades: { trades: async () => ({ status: 200, body: '{"rhea":"trades"}' }) } } as unknown as NearMarket;

type Tape = { trades: { t_ms: number }[]; whole_ms?: number; src: string; as_of_ms: number };

test("a NEAR engine tape read within NEAR_VENDOR_REACH_MS claims every trade after its oldest row and names its read's age; one held past it (its renewal failed) claims none, its rows still served", async () => {
  assert.equal(NEAR_VENDOR_REACH_MS, FRESH_MS + RHEA_FRESH_MS, "a read renewed past FRESH_MS, overdue by at most the bound the NEAR chain tape is read again at");
  const clock = { t: Date.UTC(2026, 10, 14, 3, 53) };
  const read0 = clock.t;
  const engine = { up: true, trades: 0 };
  const fetch = async (url: string): Promise<Response> => {
    const path = url.slice(ENGINE.length);
    if (path === `/token/${T}/trades`) engine.trades++;
    if (!engine.up) return new Response("bad gateway", { status: 502 });
    if (path === `/token/${T}`) return new Response(fx("token"), { status: 200 });
    if (path === `/token/${T}/trades`) return new Response(fx("trades"), { status: 200 });
    return new Response('{"error":"not found"}', { status: 404 });
  };
  const near = engineFirst(rhea, createEngineNear({ fetch: fetch as never, now: () => clock.t }));
  const read = async () => {
    const a = await near.trades.trades(T, 50);
    await new Promise((r) => setImmediate(r)); // a renewal started by this read lands before the next
    return { a, j: JSON.parse(a.body) as Tape };
  };

  const first = await read();
  assert.equal(first.a.status, 200, first.a.body);
  const oldest = first.j.trades.at(-1)!.t_ms;
  assert.deepEqual([first.j.src, first.j.as_of_ms, first.j.whole_ms], ["unrealized", read0, oldest + 1_000]);

  // the engine answers no renewal from here: the held rows are served, dated by their read
  engine.up = false;
  const asked = engine.trades;
  clock.t = read0 + NEAR_VENDOR_REACH_MS;
  const edge = await read();
  assert.ok(engine.trades > asked, "a held tape past FRESH_MS is read again");
  assert.deepEqual([edge.a.status, edge.j.as_of_ms, edge.j.whole_ms], [200, read0, oldest + 1_000], "at NEAR_VENDOR_REACH_MS the claim still stands");

  clock.t = read0 + NEAR_VENDOR_REACH_MS + 1;
  const late = await read();
  assert.deepEqual([late.a.status, late.j.src, late.j.as_of_ms, late.j.trades.length], [200, "unrealized", read0, first.j.trades.length], "the held rows are still served");
  assert.equal(late.j.whole_ms, undefined, "rows read past NEAR_VENDOR_REACH_MS are no complete list: the trades since are not in them");

  // ten minutes on, the same
  clock.t = read0 + 600_000;
  const old = await read();
  assert.deepEqual([old.j.trades.length, old.j.whole_ms], [first.j.trades.length, undefined]);

  // the engine answers again: the renewal this read starts lands, and the next read claims its reach again
  engine.up = true;
  clock.t += 1;
  await read();
  const back = await read();
  assert.deepEqual([back.j.as_of_ms, back.j.whole_ms], [clock.t, oldest + 1_000]);
  // each answer names how long ago its rows were read, the reach the live check judges a NEAR tape by
  const named = [first, edge, late, back].map((x) => VENDOR_READ.exec(x.a.timing ?? "")?.[1] ?? `none in ${JSON.stringify(x.a.timing)}`);
  assert.deepEqual(named, ["0", String(NEAR_VENDOR_REACH_MS), String(NEAR_VENDOR_REACH_MS + 1), "0"]);
});

test("a NEAR engine tape keeps its claim through a normal renewal: the held rows served while it runs are inside the bound", async () => {
  const clock = { t: Date.UTC(2026, 10, 14, 3, 53) };
  const read0 = clock.t;
  const fetch = async (url: string): Promise<Response> => {
    const path = url.slice(ENGINE.length);
    return path === `/token/${T}` ? new Response(fx("token"), { status: 200 }) : path === `/token/${T}/trades` ? new Response(fx("trades"), { status: 200 }) : new Response("{}", { status: 404 });
  };
  const near = engineFirst(rhea, createEngineNear({ fetch: fetch as never, now: () => clock.t }));
  await near.trades.trades(T, 50);
  // the first read past FRESH_MS starts the renewal and is answered the held rows
  clock.t = read0 + FRESH_MS + 1;
  const during = JSON.parse((await near.trades.trades(T, 50)).body) as Tape;
  assert.equal(during.as_of_ms, read0, "the held rows serve while the renewal runs");
  assert.notEqual(during.whole_ms, undefined, "a renewal running is no reason to drop the claim");
});
