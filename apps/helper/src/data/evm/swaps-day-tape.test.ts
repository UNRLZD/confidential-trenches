// node --test apps/helper/src/data/evm/swaps-day-tape.test.ts: card helper-listed-charts-own-reads. A Robinhood coin
// whose pool traded within the day but not in the cold window answers its last trades from our own swap reads. Live
// 15 Nov 23:1xZ: MOW (0x0b7c6c13..., a v4 pool) answered GET /v1/market/trades 0 trades, src chain, with 745 trades over
// the day and its newest 12 minutes back: Robinhood read no further back than its five-minute cold window (tapeBack 0).
// The providers as read from the Mac 23:2xZ (swaps.ts BACK_SPAN): the chain's own RPC and pocket serve 10,000 blocks a
// call of old blocks, the chain's own with no block time; blockmachine keyless the newest 5,000 only; daybreak 2,000.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, MAG, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, SWAP_RPCS, TRADES_MAX } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
/** The pool's newest recorded swap, then 7,200 blocks (12 minutes) with none: the head. */
const LAST = Math.max(...REC.logs.v4.map((l) => l.b));
const HEAD = LAST + 7_200;

function rig() {
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
  const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, fetch: fetch as never, holds: providerHolds(() => Date.now()), now: () => Date.now() });
  return { s, chain };
}

test("card helper-listed-charts-own-reads: a Robinhood v4 coin quiet for 12 minutes answers its last trades from our own reads, in a few wide reads", async () => {
  const { value } = await onVirtualTime(1_000_000_000, async () => {
    const { s, chain } = rig();
    try {
      const first = JSON.parse((await s.trades(MAG, 50)).body);
      let last = first;
      // the page reads a filling tape again every 1.5 s (apps/terminal/src/screens/token/trades.ts TRADES_POLL_MS); the
      // helper's tick (tickMs 0: the test's) starts the read back
      for (let i = 0; i < 40 && (last.filling === true || last.trades.length === 0); i++) {
        await new Promise((go) => setTimeout(go, 1_500));
        await s.tick();
        last = JSON.parse((await s.trades(MAG, 50)).body);
      }
      const wide = chain.st.spans.filter((n) => n > 3_000).length;
      return { first, last, wide, own: chain.st.own };
    } finally {
      s.stop();
    }
  });
  console.log(`first ${value.first.trades.length} trades filling ${value.first.filling}; then ${value.last.trades.length}, filling ${value.last.filling}; ${value.wide} reads over 3,000 blocks, ${value.own} own log reads`);
  assert.equal(value.last.src, "chain");
  assert.equal(value.last.trades.length, Math.min(TRADES_MAX, 50), "its last trades, not none");
  assert.equal(value.last.filling, undefined, "done reading back");
  const newest = REC.logs.v4.reduce((a, l) => (l.b > a.b || (l.b === a.b && l.i > a.i) ? l : a));
  assert.equal(value.last.trades[0].tx, newest.tx, "newest first: the pool's last recorded swap");
  assert.ok(value.own <= 40, `${value.own} own log reads: a few wide ones, not a day in 100-block reads`);
});
