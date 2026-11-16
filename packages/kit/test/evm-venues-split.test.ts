// The kit's EVM venue list in two halves (card evm-pools-on-mainnet): evmMainnetVenues (Base, Robinhood) and
// evmTestnetVenues (Base Sepolia, Robinhood testnet), so SIGN_HOST's build folds the testnets' half away
// (packages/signpage/scripts/build-network.test.mjs reads the built bundle). Everywhere else evmPoolVenues() is the
// whole list as it was before the split, entry for entry: the helper and the terminal read every network.
//   node --test test/evm-venues-split.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { evmMainnetVenues, evmPoolVenues, evmTestnetVenues } from "../src/trade/evm/buy-unpinned.ts";

/** sha256 of JSON.stringify(evmPoolVenues()): the list before the split (d893f5e6) with one entry moved since, Robinhood's
 *  index (card signpage-evm-reads-draw-no-refusal: Robinhood's own and the helper's keyed route, 500,000-block spans,
 *  one batch of at most 10 at once; 6,087 characters before it), and two entries added on Robinhood and one on Base:
 *  Robinhood's quoteLast (card robinhood-quotes-inside-provider-limits; 6,124 characters before it) and each mainnet's
 *  in-flight pin per quote provider (the same card; 6,180 characters before them), and one more on Robinhood, its
 *  poolProviders spare rpc-robinhood.globalstake.io (card first-sign-in-reads-fast, measured 2026-11-14 05:01Z and
 *  05:13Z: the pool's whole life in one page; 6,546 characters before it). The list with that one poolProviders entry
 *  taken out hashes to the pin before it, 7e26e86db0c698f5677abf45ed712803b3552c7d47f1e757fe940ae41075fcbb, so
 *  nothing else moved. Then each mainnet's sellDelegate moved to SellDelegate v2 (card evm-pool-amounts-are-standard-sizes,
 *  same length): the list with the first set's two delegates put back hashes to the pin before it,
 *  6a80dd95709b43dcba99f0c30e4c7309c311260056c98f2efc12b9b36841d417, so nothing else moved. Then one entry added on
 *  Base, its poolProviders second seat base.rpc.blxrbdn.com, Pocket after it (card first-sign-in-reads-fast-on-live,
 *  measured 2026-11-14 16:06-16:17Z; 6,585 characters before it): the list with that one entry taken out hashes to the
 *  pin before it, 654639cf7943e0a05961477f2ace244a03375ecc9dc96fb244f6392411b9ab1f, so nothing else moved. */
const BEFORE = "e50afe03bdf2d0f151b32bda6f2a8bf1550ce7dd5a6edc807152dca6d6fdeab7";

test("the two halves together are the venue list before the split, entry for entry and in its order", () => {
  const all = evmPoolVenues();
  assert.deepEqual(Object.keys(all), ["base", "robinhood", "base-sepolia", "robinhood-testnet"]);
  assert.deepEqual(Object.keys(evmMainnetVenues()), ["base", "robinhood"]);
  assert.deepEqual(Object.keys(evmTestnetVenues()), ["base-sepolia", "robinhood-testnet"]);
  assert.deepEqual({ ...all }, { ...evmMainnetVenues(), ...evmTestnetVenues() });
  const json = JSON.stringify(all);
  assert.equal(json.length, 6_616);
  assert.equal(createHash("sha256").update(json).digest("hex"), BEFORE);
});

test("each half is frozen with no prototype at every level, as the whole list is", () => {
  const deep = (v: unknown, at: string) => {
    if (typeof v !== "object" || v === null) return;
    assert.ok(Object.isFrozen(v), `${at} frozen`);
    if (!Array.isArray(v)) assert.equal(Object.getPrototypeOf(v), null, `${at} has no prototype`);
    for (const [k, x] of Object.entries(v)) deep(x, `${at}.${k}`);
  };
  deep(evmMainnetVenues(), "mainnet");
  deep(evmTestnetVenues(), "testnet");
  deep(evmPoolVenues(), "all");
  // the whole list is made once
  assert.equal(evmPoolVenues(), evmPoolVenues());
});
