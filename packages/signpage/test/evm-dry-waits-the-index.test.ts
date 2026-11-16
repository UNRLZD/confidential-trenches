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
// judged on the test clock's own timers, never by reading a clock: each mark set at a time reads how many quotes had
// been asked by then
const hostOf = (indexed: () => Promise<boolean>, q: { asked: number }) => ({
  network: "robinhood" as const,
  venues: evmPoolVenues(),
  indexPools: () => null,
  decimals: async () => 18,
  quote: async () => {
    q.asked++;
    throw Object.assign(new Error("no route"), { code: "no_quote" });
  },
  indexed,
});
const marks = (q: { asked: number }, at: number[]) => {
  const by: number[] = [];
  for (const m of at) setTimeout(() => by.push(q.asked), m);
  return by;
};
const past = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("DRYIX1 the dry's quote is asked once the chain's index sync it started ends, never before it", { timeout: 30_000 }, () => onTestClock(async () => {
  const q = { asked: 0 };
  let started = 0;
  const by = marks(q, [2_999, 3_001]);
  const h = hostOf(() => (started++, new Promise<boolean>((r) => setTimeout(() => r(true), 3_000))), q);
  assert.equal(await dry.evmDryOut(h as never, TOKEN, 10n ** 15n), null);
  await past(10);
  assert.equal(started, 1, "the dry did not start the chain's index");
  assert.ok(by[0] === 0 && by[1]! > 0, `quotes asked by 2,999 and 3,001 ms: ${by.join(", ")} (none before the index is served at 3,000 ms, then the quote)`);
}));

test("DRYIX2 an index sync that does not end within EVM_DRY_INDEX_WAIT_MS holds the dry no longer: its quote is asked then, as with no index", { timeout: 60_000 }, () => onTestClock(async () => {
  const wait = (dry as unknown as { EVM_DRY_INDEX_WAIT_MS?: number }).EVM_DRY_INDEX_WAIT_MS;
  assert.equal(typeof wait, "number", "pool-buy-evm.ts has no EVM_DRY_INDEX_WAIT_MS");
  const q = { asked: 0 };
  const by = marks(q, [wait! - 1, wait! + 1]);
  await dry.evmDryOut(hostOf(() => new Promise<boolean>(() => {}), q) as never, TOKEN, 10n ** 15n);
  await past(10);
  assert.ok(by[0] === 0 && by[1]! > 0, `quotes asked by ${wait! - 1} and ${wait! + 1} ms: ${by.join(", ")}`);
  // a sync that fails at once (another tab's, a partial one): asked at once
  const q2 = { asked: 0 };
  const by2 = marks(q2, [1]);
  await dry.evmDryOut(hostOf(() => Promise.reject(new Error("no lock")), q2) as never, TOKEN, 10n ** 15n);
  await past(10);
  assert.ok(by2[0]! > 0, "no quote asked by 1 ms");
}));
