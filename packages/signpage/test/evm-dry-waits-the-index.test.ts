// Card robinhood-quote-answers-cold: a fresh device's first EVM coin quote starts the chain's pool index sync (from the
// release's snapshot) and the dry's quote waits for it, bounded, so it reads its pools from the index instead of
// racing the sync with deep scans on the same provider. On a fresh account every cold Robinhood dry quote sent 20 to
// 100+ deep getLogs posts to rpc.mainnet.chain.robinhood.com at about one a second and ended stale_quote, 6 of 8 coins,
// while the same coins answered 5.6 to 10.8 s once the index was served (box and Mac runs, 2026-11-16 03:2xZ).
import { test } from "node:test";
import assert from "node:assert/strict";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import * as dry from "../src/pool-buy-evm.ts";

const TOKEN = "0x00000000000000000000000000000000000c0001";
const hostOf = (indexed: () => Promise<boolean>, at: number[], t0: number) => ({
  network: "robinhood" as const,
  venues: evmPoolVenues(),
  indexPools: () => null,
  decimals: async () => 18,
  quote: async () => {
    at.push(Math.round(performance.now() - t0));
    throw Object.assign(new Error("no route"), { code: "no_quote" });
  },
  indexed,
});

test("DRYIX1 the dry's quote is asked once the chain's index sync it started ends, never before it", { timeout: 30_000 }, () => onTestClock(async () => {
  const at: number[] = [];
  const t0 = performance.now();
  let asked = 0;
  const h = hostOf(() => (asked++, new Promise<boolean>((r) => setTimeout(() => r(true), 3_000))), at, t0);
  assert.equal(await dry.evmDryOut(h as never, TOKEN, 10n ** 15n), null);
  assert.equal(asked, 1, "the dry did not start the chain's index");
  assert.ok(at.length > 0 && at[0] === 3_000, `the first quote was asked at ${at[0]} ms, not when the index was served (3,000 ms)`);
}));

test("DRYIX2 an index sync that does not end within EVM_DRY_INDEX_WAIT_MS holds the dry no longer: its quote is asked then, as with no index", { timeout: 60_000 }, () => onTestClock(async () => {
  const wait = (dry as unknown as { EVM_DRY_INDEX_WAIT_MS?: number }).EVM_DRY_INDEX_WAIT_MS;
  assert.equal(typeof wait, "number", "pool-buy-evm.ts has no EVM_DRY_INDEX_WAIT_MS");
  const at: number[] = [];
  const t0 = performance.now();
  const h = hostOf(() => new Promise<boolean>(() => {}), at, t0);
  await dry.evmDryOut(h as never, TOKEN, 10n ** 15n);
  assert.equal(at[0], wait);
  // a sync that fails at once (another tab's, a partial one): asked at once
  const at2: number[] = [];
  const t1 = performance.now();
  await dry.evmDryOut(hostOf(() => Promise.reject(new Error("no lock")), at2, t1) as never, TOKEN, 10n ** 15n);
  assert.equal(at2[0], 0);
}));
