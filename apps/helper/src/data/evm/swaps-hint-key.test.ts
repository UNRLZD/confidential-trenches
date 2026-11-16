// node --test apps/helper/src/data/evm/swaps-hint-key.test.ts: card robinhood-trades-finish-filling. A listed Robinhood
// coin whose list names a v4 pool the PositionManager holds no key for, quiet in the five-minute cold window, answers
// its trades from our own reads. Live 16 Nov 17:00Z (run 43913769986): XOXO (0x866409f3...) was served GeckoTerminal's
// trades ("coingecko") with 28 swaps over the day in its hooked native ETH pool 0xb1bbab6c... (fee 0, tick spacing 60,
// hooks 0x0af57f62..., made without the PositionManager): the hint was dropped for want of the PositionManager's key, and
// the discovery's cold window held no PoolManager transaction of the coin. The pool's key is in its own swap's
// transaction (v4Key: the fee its Swap logs and the addresses its receipt holds), read 17:5xZ from the chain's own RPC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, MAG, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, SWAP_RPCS } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
/** The pool's newest recorded swap, then 7,200 blocks (12 minutes) with none: the head, past the cold window. */
const LAST = Math.max(...REC.logs.v4.map((l) => l.b));
const HEAD = LAST + 7_200;

test("a listed coin whose list names a v4 pool the PositionManager holds no key for, quiet past the cold window: its trades from our reads, the key worked out from the pool's own swap", async () => {
  const { value } = await onVirtualTime(1_000_000_000, async () => {
    const chain = fakeChain();
    chain.st.head = HEAD;
    chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000 });
    chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
    chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
    chain.st.faults.set("https://robinhood.daybreak-rpc.network", { span: 2_000 });
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      await new Promise((go) => setTimeout(go, 200));
      return chain.fetch(url, init);
    };
    // no pool known: the coin is opened cold, its list naming the pool's id (the fake's PositionManager reverts poolKeys)
    const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, pools: new Map(), hint: async () => REC.v4id, fetch: fetch as never, holds: providerHolds(() => Date.now()), now: () => Date.now() });
    try {
      let last = JSON.parse((await s.trades(MAG, 50)).body);
      for (let i = 0; i < 40 && (last.filling === true || last.trades.length === 0); i++) {
        await new Promise((go) => setTimeout(go, 1_500));
        await s.tick();
        last = JSON.parse((await s.trades(MAG, 50)).body);
      }
      return last;
    } finally {
      s.stop();
    }
  });
  assert.equal(value.src, "chain", JSON.stringify(value).slice(0, 200));
  assert.ok(value.trades.length > 0, "its last trades, not none");
  const newest = REC.logs.v4.reduce((a, l) => (l.b > a.b || (l.b === a.b && l.i > a.i) ? l : a));
  assert.equal(value.trades[0].tx, newest.tx, "newest first: the pool's last recorded swap");
});
