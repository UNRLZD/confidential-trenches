/// <reference types="node" />
// Every Solana reference on the page reads the coin's Raydium CPMM and AMM v4 pools (card
// solana-buy-reaches-raydium-and-meteora): src/page-rpc.ts pageReference asks the page's finders (keptPoolFinders, set
// at start by main.ts on mainnet) beside the pump venues' read. Replays HIGH's CPMM pool CqvMZmWD… and CzLSuj's AMM v4
// pool 9Tb2ohu5… as two mainnet providers answered them (the kit's test/vectors/high-cpmm.json, czlsuj-amm-v4.json).
// Good: with its finder each coin's buy and sell have the pool's reference, E the program's own out on mainnet's
// simulation; the tap's venue (readCoinVenue) is the pool while the page pins that venue's table. Bad: no finder, one that
// finds none or fails leaves the pump venues alone (no reference, what b6657467d answered for both coins), never a throw;
// with no table pinned for the venue the tap has no venue, so it moves nothing from Cash.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { raydiumProviders, raydiumVectors } from "../../kit/test/solana-pool-buy-fx.ts";
import { pageReference, pinnedPoolFinders, POOL_FINDER_VENUES, type PoolFinders } from "../src/page-rpc.ts";
import { readCoinVenue } from "../src/pools.ts";

const KINDS = [["raydium-cpmm", "cpmmPools"], ["raydium-amm-v4", "ammV4Pools"]] as const;
const named = (k: (typeof KINDS)[number][0]) => {
  const [a, b] = raydiumProviders(k);
  return [Object.assign(a, { url: "https://a.example" }), Object.assign(b, { url: "https://b.example" })] as readonly [SolanaRpc, SolanaRpc];
};

for (const [kind, field] of KINDS) {
  const vec = raydiumVectors[kind];
  const finders = (f: PoolFinders[typeof field]): PoolFinders => ({ [field]: f });

  test(`${kind}: with the page's finder the coin's buy and sell have the pool's reference, E the program's own out`, async () => {
    for (const name of Object.keys(vec.programOut)) {
      const [side, amount] = name.split(" ") as ["buy" | "sell", string];
      const asked: string[] = [];
      const ref = await pageReference(named(kind), { side, token: vec.mint, amount: BigInt(amount) }, finders(async (t) => (asked.push(t), [vec.pool])));
      assert.deepEqual(asked, [vec.mint]);
      assert.ok(ref !== null, name);
      assert.equal(ref.pools[0]!.venue, kind);
      assert.equal(ref.pools[0]!.address, vec.pool);
      assert.equal(ref.expectedOut, BigInt(vec.programOut[name]!.E), name);
    }
  });

  test(`${kind}: no finder, one that finds none, or one that fails: the pump venues alone, no reference, never a throw`, async () => {
    const buy = { side: "buy" as const, token: vec.mint, amount: 100_000_000n };
    assert.equal(await pageReference(named(kind), buy, null), null);
    assert.equal(await pageReference(named(kind), buy, finders(async () => [])), null);
    assert.equal(await pageReference(named(kind), buy, finders(async () => Promise.reject(new Error("scan down")))), null);
    // the other venue's finder alone finds nothing for this coin
    const other = kind === "raydium-cpmm" ? "ammV4Pools" : "cpmmPools";
    assert.equal(await pageReference(named(kind), buy, { [other]: async () => [] }), null);
    // a request that names its pools is read with those, the finder never asked
    const ref = await pageReference(named(kind), { ...buy, [field]: [vec.pool] }, finders(async () => assert.fail("asked")));
    assert.equal(ref?.pools[0]?.venue, kind);
  });

  test(`${kind}: the tap's venue (readCoinVenue) is the pool while the page pins its table; with none it throws, so the tap moves nothing from Cash`, async () => {
    const all: PoolFinders = { dlmmPairs: async () => [], cpmmPools: async () => [], ammV4Pools: async () => [], [field]: async () => [vec.pool] };
    const v = await readCoinVenue(named(kind), vec.mint, all);
    assert.deepEqual({ ...v }, { kind, tokenAccountSize: 165, cashback: false, decimals: 6 });
    await assert.rejects(readCoinVenue(named(kind), vec.mint));
    await assert.rejects(readCoinVenue(named(kind), vec.mint, finders(async () => [])));
    // a pool the finder names that is not this coin's is no venue
    await assert.rejects(readCoinVenue(named(kind), vec.mint, finders(async () => ["11111111111111111111111111111111"])));
    // main.ts gives pool.buy.dry only the finders of the venues the page pins a table for
    const venue = POOL_FINDER_VENUES[field];
    assert.equal(venue, kind);
    assert.equal(pinnedPoolFinders(all, {}), null);
    assert.equal(pinnedPoolFinders(all, { [venue]: [] }), null);
    assert.deepEqual(Object.keys(pinnedPoolFinders(all, { [venue]: ["BShWZ8FbDPYGpoc1ebj4TiELvVFmBQwW4XMYuLtQoHYZ"] })!), [field]);
    await assert.rejects(readCoinVenue(named(kind), vec.mint, pinnedPoolFinders(all, { dlmm: ["BShWZ8FbDPYGpoc1ebj4TiELvVFmBQwW4XMYuLtQoHYZ"] })));
  });
}
