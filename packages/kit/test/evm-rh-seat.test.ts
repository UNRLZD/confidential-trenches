// Card robinhood-warm-tap-inside-2s: a warm Robinhood tap needs two providers that agree on every read, and the keyless
// list is slow (publicnode 0.6 to 5.7 s a post) or capped (Robinhood's own and bloXroute at 6 calls a second, dRPC held
// after a 429; the tap check's own quotes from the Mac, 26 Nov 15:0xZ). Our helper's seat, POST
// /v1/rpc/robinhood?keyed=alchemy, reads one company's key (Alchemy) under a share sized to a tap (the helper's
// robinhood-seat.test.ts); ranked with the four, a warm tap took 0.36 to 1.6 s where it took 2.7 to 24 s without it
// (the same run with the seat, 15:5xZ). Its answers count as one operator's beside the device's own: a lying helper meets
// another operator's read and the quote is refused (rpc_disagree), never signed. The seat is the venue's `seat`, apart
// from `providers` (the third-party operators the pool index and the list's checks read), as NEAR's is.
//   node --test test/evm-rh-seat.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import * as pace from "../src/checks/evm/pace.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmProviderSeats } from "../src/checks/evm/quote.ts";
import { evmPoolProvidersOf, evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";

const SEAT = `${pace.EVM_HELPER_ORIGIN}/v1/rpc/robinhood?keyed=alchemy`;
const INDEX = `${pace.EVM_HELPER_ORIGIN}/v1/rpc/robinhood?keyed=only`;

test("Robinhood's quote asks our helper's Alchemy seat with the four keyless operators, each on its own host and pinned in flight; the seat is never in the providers or the pool list", () => {
  const v = evmPoolVenues().robinhood;
  assert.equal(v.seat, SEAT);
  const list = v.providers ?? assert.fail("robinhood: no quote list");
  assert.ok(!list.includes(SEAT), "the providers name third-party operators only");
  assert.ok(!(evmPoolProvidersOf(v) ?? []).includes(SEAT), "the pool index never reads the seat");
  const asked = evmProviderSeats("robinhood").map((s) => s.url);
  assert.deepEqual([...asked].sort(), [SEAT, ...list].sort(), "a quote ranks the seat with the four");
  assert.equal(new Set(asked.map((u) => new URL(u).host)).size, asked.length);
  assert.ok((v.inflight ?? {})[SEAT] !== undefined, "the seat's posts at once are pinned");
  assert.ok(pace.evmHelperRoute(SEAT), "the seat is our helper's route: its 429 holds it its Retry-After, never 30 s");
  // Base has no seat: its quote asks its providers alone
  assert.equal(evmPoolVenues().base.seat, undefined);
  assert.deepEqual([...evmProviderSeats("base").map((s) => s.url)].sort(), [...(evmPoolVenues().base.providers ?? [])].sort());
});

test("the seat and the index reader are two readers of one host: a hold of one never holds the other (each is its own allowance at the helper)", () => {
  evmPaceReset();
  assert.notEqual(pace.evmProviderKey(SEAT), pace.evmProviderKey(INDEX));
  pace.evmProviderHold(INDEX, 2_000);
  assert.ok(pace.evmProviderHeld(INDEX));
  assert.ok(!pace.evmProviderHeld(SEAT), "the index reader's 429 left the seat free");
  evmPaceReset();
  pace.evmProviderHold(SEAT, 2_000);
  assert.ok(!pace.evmProviderHeld(INDEX), "the seat's 429 left the index reader free");
  evmPaceReset();
});

test("a provider's key keeps only the helper's keyed mode of its query: any other query is dropped, as before", () => {
  assert.equal(pace.evmProviderKey("https://robinhood-rpc.publicnode.com/"), "https://robinhood-rpc.publicnode.com");
  assert.equal(pace.evmProviderKey("https://robinhood-rpc.publicnode.com/?x=1"), "https://robinhood-rpc.publicnode.com");
  assert.equal(pace.evmProviderKey(`${SEAT}&x=1`), pace.evmProviderKey(SEAT));
});
