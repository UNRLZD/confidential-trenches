// Card rh-provider-fails-64-read-batch: a Robinhood quote never waits on a provider that cannot answer the kit's batch.
// rpc-robinhood.globalstake.io answered a request of more than about 12 reads HTTP 500 in some hours (18 Nov 00:43-00:45Z
// from the Mac, 3 rounds: 1 call of 16 and 64, and every batch of 2 or 3 calls of 6 to 64 reads; the gas-starve live
// check's 64-read call on GitHub's runners in 8 of 47 runs, 12-17 Nov, all 22:28Z-04:08Z), while a quote's batch is
// CALLS_PER_BATCH (3) calls of the venue's perCall (64). It left the quote list; the four left answered every shape to
// 3 x 64 in the same minutes. Live check rh-provider-fails-64-read-batch reads each of the list at the batch after
// every app deploy.
//   node --test test/evm-rh-quote-list.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmPoolProvidersOf, evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";

const GLOBALSTAKE = "https://rpc-robinhood.globalstake.io";

test("Robinhood's quote list holds no provider that answered the kit's batch HTTP 500, and keeps four operators, each pinned", () => {
  const v = evmPoolVenues().robinhood;
  const list = v.providers ?? assert.fail("robinhood: no quote list");
  assert.ok(!list.includes(GLOBALSTAKE), `${GLOBALSTAKE} answered the kit's batch HTTP 500 and is still asked for quotes`);
  assert.deepEqual(list, ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com", "https://robinhood.rpc.blxrbdn.com"]);
  // four operators on four hosts: a quote takes two that agree, with two spares
  assert.equal(new Set(list.map((u) => new URL(u).host)).size, 4);
  // each one's posts at once pinned, and none for a provider the list no longer asks
  assert.deepEqual(Object.keys(v.inflight ?? {}).sort(), [...list].sort());
  // the batch the four answered: 64 reads a call
  assert.equal(v.reads?.perCall, 64);
});

test("globalstake stays in Robinhood's pool list, whose log pages it answers (card first-sign-in-reads-fast)", () => {
  assert.ok((evmPoolProvidersOf(evmPoolVenues().robinhood) ?? []).includes(GLOBALSTAKE));
});
