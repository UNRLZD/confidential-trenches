// NOVAAI on Robinhood (0x5125…b590) as the signing page taps it, the helper's pools of the token served first
// (signpage src/evm-served.ts), recorded on mainnet (test/evm-tap-record.ts … served, 2026-11-15) and replayed call by
// call (card base-coin-quote-check-names-its-cause): the kit's best route for it is a v4 pool behind a hook the venue
// does not list (0xe5e7…f044), which a buy may not take, so the tap's true refusal is not_allowed, never the generic
// quote_check_failed release 150's run read. Its own file: the kit keeps a token's scan for the module's life
// (test/evm-buy-tap-names.test.ts replays the same token with no pools served).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmBuyTapRefused } from "../src/trade/evm/buy-tap.ts";
import { replayTap } from "./evm-tap-record.ts";
import { onTestClock } from "./test-clock.ts";

for (const [name, coin, code] of [
  ["evm-tap-novaai-served", "NOVAAI on Robinhood, the helper's pools served as the page serves them", "not_allowed"],
] as const) {
  test(`${coin}: the recorded tap ends in ${code}, never the generic quote_check_failed`, () => onTestClock(async () => {
    const { end, missed, F } = await replayTap(name);
    assert.deepEqual(missed, [], "every call the replay asks is in the recording");
    // the recording's own end, which the tap named quote_check_failed (release 150's run 43708088495)
    assert.equal(F.outcome.code, "quote_check_failed");
    assert.ok(end instanceof EvmBuyTapRefused, String(end));
    assert.equal(end.code, code, end.message);
  }));
}
