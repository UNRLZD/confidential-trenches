// node --test apps/helper/src/data/evm/swaps-back-short.test.ts: card robinhood-trades-finish-filling. A tape says
// filling false only once it holds every trade back to its floor (TRADES_MAX trades, the pool's birth, or the chain's
// tapeBack). Live 16 Nov 20:4xZ, eight cold Robinhood tapes at once in the helper's container (d3ae40db4): the read back
// of 0xcec185eb asked the chain's own RPC for the day (locate, BACK_LOCATE), went unanswered three times, and settled
// the tape at 17 trades, not filling, with more trades over the day; across four such bursts, TORCH settled at 0 to 3
// and others at 1 to 9. Here the same: the own RPC refuses the day-wide read, every time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, MAG, open, POOL_MAG, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, SWAP_RPCS, TRADES_MAX } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const LAST = Math.max(...REC.logs.v4.map((l) => l.b));

test("a short Robinhood tape whose day read (locate) is never answered keeps filling and reads back in the agreed steps to its floor: never settled short", async () => {
  const { value } = await onVirtualTime(1_000_000_000, async () => {
    const chain = fakeChain();
    // the cold window (3,000 blocks) holds the pool's last ~100 blocks of swaps: a short first tape, more before it
    chain.st.head = LAST + 2_900;
    chain.st.faults.set(OWN, { zeroTime: true, span: 10_000 }); // refuses the day-wide read: locate unanswered
    chain.st.faults.set("https://robinhood.api.pocket.network", { span: 10_000, addressOnly: true });
    chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000 });
    chain.st.faults.set("https://robinhood.daybreak-rpc.network", { span: 2_000 });
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      await new Promise((go) => setTimeout(go, 200));
      return chain.fetch(url, init);
    };
    const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, pools: new Map([[MAG, { pool: POOL_MAG, decimals: 18 }]]), fetch: fetch as never, holds: providerHolds(() => Date.now()), now: () => Date.now() });
    const seen: { n: number; filling: boolean }[] = [];
    try {
      let last = JSON.parse((await s.trades(MAG, TRADES_MAX)).body);
      seen.push({ n: last.trades.length, filling: last.filling === true });
      for (let i = 0; i < 60 && last.filling === true; i++) {
        await new Promise((go) => setTimeout(go, 1_500));
        await s.tick();
        last = JSON.parse((await s.trades(MAG, TRADES_MAX)).body);
        seen.push({ n: last.trades.length, filling: last.filling === true });
      }
      return { last, seen };
    } finally {
      s.stop();
    }
  });
  const first = value.seen[0]!;
  assert.ok(first.n > 0 && first.n < TRADES_MAX, `a short first tape: ${JSON.stringify(first)}`);
  // every answer short of the floor says filling
  for (const a of value.seen) assert.ok(a.filling || a.n >= TRADES_MAX, `settled short: ${JSON.stringify(value.seen)}`);
  assert.equal(value.last.trades.length, TRADES_MAX, `the tape at its floor: ${JSON.stringify(value.seen)}`);
});
