// node --test apps/helper/src/data/evm/swaps-vendor-reach.test.ts: a coin our reads find no pool of is served the
// vendor's rows (swaps.ts noneTrades), and its tape claims a complete list (`whole_ms`, which the page counts its buys,
// sells and volume by) only while those rows were read within BEHIND_MAX's ms, the bound a chain tape's complete list
// holds to; every vendor tape names how long ago its rows were read in Server-Timing (evm-vendor-read). Card
// evm-vendor-tape-names-its-reach: live run 44290570091 (18 Nov 11:25Z) read Base 0x1668cd48's vendor tape served complete,
// 3 trades, naming no reach, and a held vendor tape whose refresh failed was served with its whole_ms whatever its age.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { geckoBudget } from "../gecko.ts";
import { TAPE_FRESH_MS } from "../solana/token.ts";
import { GT_BASE } from "./lists.ts";
import { BEHIND_MAX } from "./swaps.ts";

const VENDOR_READ = /(?:^|,)\s*evm-vendor-read;desc="rows read (\d+) ms ago"/;

/** The recorded SOGNI vendor answer (fixtures/gt-pool-trades-sogni-base.json), its receipts answered as recorded, and a
 *  switch that fails GeckoTerminal's trades read (500) as a refresh refused would. */
function vendorCoin() {
  const R = JSON.parse(readFileSync(new URL("./fixtures/gt-pool-trades-sogni-base.json", import.meta.url), "utf8")) as { coin: string; pool: string; trades: (Record<string, unknown> & { id: string; legs: { from: [string, string]; to: [string, string] } })[] };
  const receipts = (JSON.parse(readFileSync(new URL("./fixtures/vendor-rows-receipts.json", import.meta.url), "utf8")) as { sogni: Record<string, unknown> }).sogni;
  const answer = { data: R.trades.map(({ id, legs, ...a }) => ({ id, type: "trade", attributes: { ...a, from_token_address: legs.from[0], from_token_amount: legs.from[1], to_token_address: legs.to[0], to_token_amount: legs.to[1] } })) };
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const gt = { up: true, trades: 0 };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith(GT_BASE)) {
      if (url.includes("/pools?page=1")) return new Response(JSON.stringify({ data: [{ attributes: { address: R.pool } }] }), { status: 200 });
      if (url.includes(`/pools/${R.pool}/trades?token=${R.coin}`)) return gt.trades++, gt.up ? new Response(JSON.stringify(answer), { status: 200 }) : new Response("{}", { status: 500 });
      return new Response("{}", { status: 404 });
    }
    const reqs = JSON.parse(String(init.body ?? "null")) as { id: number; method: string; params: unknown[] }[] | null;
    // our reads of the vendor's pool (swaps.ts heldFilters: a list of token addresses) are refused: this coin is one
    // our reads cannot place, whose held tape the vendor's refresh renews (card helper-vendor-tapes-refresh-inside-15s)
    if (Array.isArray(reqs) && reqs.some((r) => r.method === "eth_getLogs" && Array.isArray((r.params[0] as { address?: unknown })?.address)))
      return new Response(JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "refused" } }))), { status: 200 });
    if (!Array.isArray(reqs) || !reqs.every((r) => r.method === "eth_getTransactionReceipt")) return chain.fetch(url, init);
    return new Response(JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: receipts[r.params[0] as string] ?? null }))), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { coin: R.coin, oldest: Date.parse(R.trades.at(-1)!.block_timestamp as string), chain, fetch, gt };
}

type Tape = { trades: unknown[]; whole_ms?: number; filling?: boolean; src: string; as_of_ms: number };

test("a vendor tape read within BEHIND_MAX's ms claims every trade after its oldest row and names its read's age; one held past it (its refresh failed) claims none, its rows still served", async () => {
  const v = vendorCoin();
  const clock = { t: Date.parse("2026-11-14T17:30:00Z") };
  const read0 = clock.t;
  const s = open(v.chain, clock, { pools: new Map(), fetch: v.fetch as never, gecko: geckoBudget(() => clock.t) });
  const ms = BEHIND_MAX.robinhood.ms;
  assert.ok(TAPE_FRESH_MS < ms, "a held tape is read again before its claim runs out");
  try {
    const a = await s.trades(v.coin, 50);
    assert.equal(a.status, 200, a.body);
    const j = JSON.parse(a.body) as Tape;
    assert.deepEqual([j.src, j.as_of_ms, j.filling, j.trades.length, j.whole_ms], ["geckoterminal", read0, undefined, 6, v.oldest + 1_000]);

    // the vendor refuses every refresh from here: the held rows are served, dated by their read
    v.gt.up = false;
    const reads = v.gt.trades;
    clock.t = read0 + ms;
    const edge = await s.trades(v.coin, 50);
    const je = JSON.parse(edge.body) as Tape;
    // the refresh behind the held rows asks our reads of the pool first (refused here), then the vendor
    for (let i = 0; i < 40; i++) await new Promise((ok) => setImmediate(ok));
    assert.ok(v.gt.trades > reads, "a held tape past TAPE_FRESH_MS is read again");
    assert.deepEqual([edge.status, je.as_of_ms, je.trades.length, je.whole_ms], [200, read0, 6, v.oldest + 1_000], "at BEHIND_MAX's ms the claim still stands");

    clock.t = read0 + ms + 1;
    const late = await s.trades(v.coin, 50);
    const jl = JSON.parse(late.body) as Tape;
    assert.deepEqual([late.status, jl.src, jl.as_of_ms, jl.trades.length], [200, "geckoterminal", read0, 6], "the held rows are still served");
    assert.equal(jl.whole_ms, undefined, "rows read past BEHIND_MAX's ms are no complete list: the trades since are not in them");

    // ten minutes on, the same
    clock.t = read0 + 600_000;
    const old = JSON.parse((await s.trades(v.coin, 50)).body) as Tape;
    assert.deepEqual([old.trades.length, old.whole_ms], [6, undefined]);

    // the vendor answers again: a fresh read claims its reach again
    v.gt.up = true;
    clock.t += 1;
    const back = await s.trades(v.coin, 50);
    const jb = JSON.parse(back.body) as Tape;
    assert.deepEqual([jb.as_of_ms, jb.whole_ms], [clock.t, v.oldest + 1_000]);
    // each answer names how long ago its rows were read, the reach the live check judges a vendor tape by
    const named = [a, edge, late, back].map((x) => VENDOR_READ.exec(x.timing ?? "")?.[1] ?? `none in ${JSON.stringify(x.timing)}`);
    assert.deepEqual(named, ["0", String(ms), String(ms + 1), "0"]);
  } finally {
    s.stop();
  }
});
