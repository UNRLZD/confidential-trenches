// node --test apps/helper/src/data/solana/trades-vendor-reach.test.ts: a token the chain tape does not decode (or one
// Discover's lists do not hold) is served its top pool's trades from the vendor (trades.ts poolTape over token.ts tape),
// and its tape claims a complete list (`whole_ms`, which the page counts its buys, sells and volume by) only while those
// rows were read within SOL_VENDOR_REACH_MS; every vendor tape names how long ago its rows were read in Server-Timing
// (sol-vendor-read). Card vendor-tapes-name-their-reach-every-chain: the held rows a refused refresh serves (token.ts
// cached: up to STALE_MS on a failure, at any age on a 429) kept the whole_ms of their read whatever its age, the bug card
// evm-vendor-tape-names-its-reach fixed on Base and Robinhood (../evm/swaps.ts noneTrades).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WINDOW_MS } from "../gecko.ts";
import { createSolanaToken, STALE_MS, TAPE_FRESH_MS } from "./token.ts";
import { createSolanaTrades, SOL_BEHIND_MS, SOL_VENDOR_REACH_MS } from "./trades.ts";

const VENDOR_READ = /(?:^|,)\s*sol-vendor-read;desc="rows read (\d+) ms ago"/;

/** The recorded NEARKAT pool trades (fixtures/sol-pool-trades-nearkat.json, GeckoTerminal), its top pool named, and a
 *  switch that fails the trades read (500) as a refused refresh would. */
function vendor() {
  const o = JSON.parse(readFileSync(new URL("./fixtures/sol-pool-trades-nearkat.json", import.meta.url), "utf8")) as { mint: string; pool: string; trades: (Record<string, unknown> & { id: string; legs: { from: [string, string]; to: [string, string] } })[] };
  const answer = { data: o.trades.map(({ id, legs, ...a }) => ({ id, type: "trade", attributes: { ...a, from_token_address: legs.from[0], from_token_amount: legs.from[1], to_token_address: legs.to[0], to_token_amount: legs.to[1] } })) };
  const gt = { up: true, reads: 0 };
  const fetch = async (url: string): Promise<Response> => {
    if (url.endsWith(`/networks/solana/tokens/${o.mint}`)) return new Response(JSON.stringify({ data: { relationships: { top_pools: { data: [{ id: `solana_${o.pool}`, type: "pool" }] } } } }), { status: 200 });
    if (url.includes(`/networks/solana/pools/${o.pool}/trades`)) return gt.reads++, gt.up ? new Response(JSON.stringify(answer), { status: 200 }) : new Response("{}", { status: 500 });
    return new Response("{}", { status: 404 });
  };
  const oldest = Math.min(...o.trades.map((t) => Date.parse(t.block_timestamp as string)));
  return { mint: o.mint, n: o.trades.length, oldest, fetch, gt };
}

type Tape = { trades: unknown[]; whole_ms?: number; filling?: boolean; src: string; as_of_ms: number };
const down = { handle: async () => ({ status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' }) };
/** Every Solana RPC down: our own reads of the pool fail (card sol-vendor-tape-refresh-from-our-reads), so its tape is
 *  refreshed from the vendor, as before that card. */
const rpcDown = async (): Promise<Response> => new Response("{}", { status: 503 });
/** The event loop's turn: a refresh behind the held rows reaches the vendor in it. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
};

test("a Solana vendor tape read within SOL_VENDOR_REACH_MS claims every trade after its oldest row and names its read's age; one held past it (its refresh failed) claims none, its rows still served", async () => {
  assert.equal(SOL_VENDOR_REACH_MS, TAPE_FRESH_MS + SOL_BEHIND_MS, "a read renewed each TAPE_FRESH_MS, overdue by at most the chain tape's own SOL_BEHIND_MS");
  assert.ok(SOL_VENDOR_REACH_MS < STALE_MS, "a failed refresh serves the held rows past the bound, so the bound is what ends the claim");
  const v = vendor();
  const clock = { t: Date.parse("2026-11-14T17:25:00Z") };
  const read0 = clock.t;
  const token = createSolanaToken(down as never, down as never, { now: () => clock.t, fetch: v.fetch as never, sleep: async () => undefined });
  const t = createSolanaTrades({ now: () => clock.t, listed: async () => false, rpcs: ["https://rpc.test"], fetch: rpcDown as never, source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, tape: (m) => token.tape(m) });
  try {
    const a = await t.trades(v.mint, 50);
    assert.equal(a.status, 200, a.body);
    const j = JSON.parse(a.body) as Tape;
    assert.deepEqual([j.src, j.as_of_ms, j.filling, j.trades.length, j.whole_ms], ["geckoterminal", read0, undefined, v.n, v.oldest + 1_000]);

    // a held read inside its TAPE_FRESH_MS keeps its claim: the normal cycle never drops it
    clock.t = read0 + TAPE_FRESH_MS - 1;
    assert.equal((JSON.parse((await t.trades(v.mint, 50)).body) as Tape).whole_ms, v.oldest + 1_000);

    // the vendor refuses every refresh from here: the held rows are served, dated by their read
    v.gt.up = false;
    const reads = v.gt.reads;
    clock.t = read0 + SOL_VENDOR_REACH_MS;
    const edge = await t.trades(v.mint, 50);
    const je = JSON.parse(edge.body) as Tape;
    await settle();
    assert.ok(v.gt.reads > reads, "a held tape past TAPE_FRESH_MS whose pool our reads cannot renew is read again from the vendor");
    assert.deepEqual([edge.status, je.as_of_ms, je.trades.length, je.whole_ms], [200, read0, v.n, v.oldest + 1_000], "at SOL_VENDOR_REACH_MS the claim still stands");

    clock.t = read0 + SOL_VENDOR_REACH_MS + 1;
    const late = await t.trades(v.mint, 50);
    const jl = JSON.parse(late.body) as Tape;
    assert.deepEqual([late.status, jl.src, jl.as_of_ms, jl.trades.length, jl.filling], [200, "geckoterminal", read0, v.n, undefined], "the held rows are still served");
    assert.equal(jl.whole_ms, undefined, "rows read past SOL_VENDOR_REACH_MS are no complete list: the trades since are not in them");

    // the vendor answers again: a fresh read, once the budget's refresh slot is free (../gecko.ts WINDOW_MS), claims its
    // reach again
    v.gt.up = true;
    clock.t += WINDOW_MS;
    const back = await t.trades(v.mint, 50);
    const jb = JSON.parse(back.body) as Tape;
    assert.deepEqual([jb.as_of_ms, jb.whole_ms], [clock.t, v.oldest + 1_000]);
    // each answer names how long ago its rows were read, the reach the live check judges a vendor tape by
    const named = [a, edge, late, back].map((x) => VENDOR_READ.exec(x.timing ?? "")?.[1] ?? `none in ${JSON.stringify(x.timing)}`);
    assert.deepEqual(named, ["0", String(SOL_VENDOR_REACH_MS), String(SOL_VENDOR_REACH_MS + 1), "0"]);
  } finally {
    t.stop();
  }
});
