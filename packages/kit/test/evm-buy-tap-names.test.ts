// Real mainnet buy taps (test/evm-tap-record.ts, 2026-11-15) replayed call by call through the tap and the kit's
// own quote (card base-coin-quote-check-names-its-cause): release 150's mainnet check read Paper on Base and NOVAAI on
// Robinhood end in quote_check_failed, which names no cause. Each tap ends in a quote or a refusal that says why:
//  - Paper (Base, 0xad4b…eb07): its market is an Aerodrome pool; no Uniswap route a buy may take quotes and the kit's
//    whole search finds none either (each refusal's reference null): no_reference;
//  - NOVAAI (Robinhood, 0x5125…b590) as the check asks it, no helper pools served: the same, no_reference;
//  - NOVAAI as the page asks it: test/evm-buy-tap-names-served.test.ts (a process of its own: the kit keeps a token's
//    scan for the module's life).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmBuyTapRefused } from "../src/trade/evm/buy-tap.ts";
import { replayTap } from "./evm-tap-record.ts";
import { onTestClock } from "./test-clock.ts";

for (const [name, coin, code] of [
  ["evm-tap-paper", "Paper on Base", "no_reference"],
  ["evm-tap-novaai", "NOVAAI on Robinhood, no pools served", "no_reference"],
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
