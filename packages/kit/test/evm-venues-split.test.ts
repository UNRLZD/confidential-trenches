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
 *  one batch of at most 10 at once; 6,087 characters before it), and one entry added, Robinhood's quoteLast (card
 *  robinhood-quotes-inside-provider-limits; 6,124 characters before it). */
const BEFORE = "df2664634ab5b17d38e043d26bab95fe86bcb99e362c46b77f15988276b52604";

test("the two halves together are the venue list before the split, entry for entry and in its order", () => {
  const all = evmPoolVenues();
  assert.deepEqual(Object.keys(all), ["base", "robinhood", "base-sepolia", "robinhood-testnet"]);
  assert.deepEqual(Object.keys(evmMainnetVenues()), ["base", "robinhood"]);
  assert.deepEqual(Object.keys(evmTestnetVenues()), ["base-sepolia", "robinhood-testnet"]);
  assert.deepEqual({ ...all }, { ...evmMainnetVenues(), ...evmTestnetVenues() });
  const json = JSON.stringify(all);
  assert.equal(json.length, 6_180);
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
