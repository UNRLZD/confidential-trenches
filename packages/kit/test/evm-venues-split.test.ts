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
 *  pin before it, 654639cf7943e0a05961477f2ace244a03375ecc9dc96fb244f6392411b9ab1f, so nothing else moved. Then
 *  rpc-robinhood.globalstake.io left Robinhood's quote list and its in-flight pin (card rh-provider-fails-64-read-batch:
 *  HTTP 500 to the kit's batch; 6,616 characters before it): the list with those two put back hashes to the pin before
 *  it, e50afe03bdf2d0f151b32bda6f2a8bf1550ce7dd5a6edc807152dca6d6fdeab7, so nothing else moved. Then Base
 *  publicnode's in-flight pin went from 2 to 8 (card evm-first-quote-inside-the-kpi, same length): the list with its 2
 *  put back hashes to the pin before it, 335426e132ba2336276daf62450687750e090d388bab4c0cbcea4e0e15aec395, so nothing
 *  else moved. Then each mainnet's v3Factory added (card robinhood-tap-asks-no-missing-v3-tier; 6,536 characters before
 *  them): the list with those two taken out hashes to the pin before it,
 *  aaca27e76a69e65f0793ccd60e1759d25f0ecda7c44d8c8b73c58016fb7456f0, so nothing else moved. Then each mainnet's scan
 *  gained its measured Initialize rate, `initialized` (card evm-scan-chain-tail: the chain's tail spans and its flood
 *  bound; 6,650 characters before it): the list with those two taken out hashes to the pin before it,
 *  b0239a3ac9c10f43a2db48ea15f4ed26f3fce85189c257f98ac061724d7fed23, so nothing else moved. Then Base's second index
 *  reader went from Pocket to bloXroute's base.rpc.blxrbdn.com (card evm-index-kept-at-the-head: 100 of 100 posts
 *  answered at the gap sync's rate where Pocket answered 7 of 101 429; 6,742 characters before it): the list with
 *  Pocket put back hashes to the pin before it, cec5fcd8ee010c5043cac23cb21ee3ff6d9ba3195f542c19ca62b89726849760, so
 *  nothing else moved. Then Base's publicnode and blastapi went from 8 posts at once to 16 (card
 *  evm-warm-tap-ends-inside-two-seconds, measured; 6,739 characters before it): the list with the two put back at 8
 *  hashes to the pin before it, d913eec85caaec57b2db40fd469a9d2772a19385e8bf3118c217a684a9e20023, so nothing else
 *  moved. Then Base's index read 50,000-block spans, each reader its own pieces and pace (card
 *  evm-sync-inside-the-kpi-at-any-age: parts, perBatch and parallel per reader; 6,741 characters before it): the list
 *  with its index put back as { span 10,000, perBatch 5, parallel 4 } hashes to the pin before it,
 *  c1b10c22de65c9a8042e0e87a1c0db8b6d8849a0fcb42c87e80fc8697daa69c9, so nothing else moved. Then each mainnet gained
 *  logProviders, its quote providers that answer a getLogs of the newest blocks (card evm-cut-logs-only-where-served,
 *  read 2026-11-24 20:46Z; 6,763 characters before them): the list with those two taken out hashes to the pin before
 *  it, f65d0a54be350de090712004f20fe9c46de4d3dbaba6e01b16ea19a1c1d2f245, so nothing else moved. */
const BEFORE = "bb558142a6d1e8a4a00df33d16e6b88dfbdd4a83e89415e88ef33d71d2281f80";

test("the two halves together are the venue list before the split, entry for entry and in its order", () => {
  const all = evmPoolVenues();
  assert.deepEqual(Object.keys(all), ["base", "robinhood", "base-sepolia", "robinhood-testnet"]);
  assert.deepEqual(Object.keys(evmMainnetVenues()), ["base", "robinhood"]);
  assert.deepEqual(Object.keys(evmTestnetVenues()), ["base-sepolia", "robinhood-testnet"]);
  assert.deepEqual({ ...all }, { ...evmMainnetVenues(), ...evmTestnetVenues() });
  const json = JSON.stringify(all);
  assert.equal(json.length, 6_978);
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
