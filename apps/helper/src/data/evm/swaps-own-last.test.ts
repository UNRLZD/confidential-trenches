// node --test apps/helper/src/data/evm/swaps-own-last.test.ts: card robinhood-trades-finish-filling. A Robinhood tape's
// read back first reads the pool's swaps over the whole day in one read on the chain's own RPC (locate, BACK_LOCATE),
// one post a second shared by every tape and /v1/rpc/robinhood's callers. That RPC takes 100,000 blocks at most for a
// filter with several values in one topic position. Live 16 Nov 19:5xZ, eight cold tapes at once in the helper's
// container (e44158fd4): every hooked v4 pool's day read (the PoolManager, topics [Swap and the calls, [the pool and its
// siblings]]) was refused -32602 "query spans 864000 blocks ..., but only 100000 are allowed for this request", asked
// again up to three times (22 of the RPC's 62 calls), then walked in 10,000-block steps; the RPC sent its pace, one
// post a second, the whole burst.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, MAG, open, POOL_MAG, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, SWAP_RPCS } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const LAST = Math.max(...REC.logs.v4.map((l) => l.b));
/** MAG's pool read as a hooked one with a sibling pool (poolFilters: several pool ids in the second topic position). */
const HOOKED = { ...POOL_MAG, hook: `0x${"4c".repeat(20)}`, siblings: [`0x${"ab".repeat(32)}`] };

test("a hooked v4 pool's day read is asked of the chain's own RPC one value a topic position, and answered: no refusal, no read again", async () => {
  const { value } = await onVirtualTime(1_000_000_000, async () => {
    const chain = fakeChain();
    chain.st.head = LAST + 7_200;
    chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000, oneValue: true });
    chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
    chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
    chain.st.faults.set("https://robinhood.daybreak-rpc.network", { span: 2_000 });
    const day = { asked: 0, refused: 0 };
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const reqs = JSON.parse(String(init.body)) as { method: string; params: { fromBlock?: string; toBlock?: string }[] }[];
      const wide = (r: (typeof reqs)[number]) => r.method === "eth_getLogs" && r.params[0]?.fromBlock !== undefined && parseInt(r.params[0].toBlock!, 16) - parseInt(r.params[0].fromBlock, 16) + 1 > 100_000;
      await new Promise((go) => setTimeout(go, 200));
      const a = await chain.fetch(url, init);
      if (url === OWN && reqs.some(wide)) {
        const out = (await a.clone().json()) as { error?: unknown }[];
        reqs.forEach((r, i) => wide(r) && (day.asked++, out[i]?.error !== undefined && day.refused++));
      }
      return a;
    };
    const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, pools: new Map([[MAG, { pool: HOOKED, decimals: 18 }]]), fetch: fetch as never, holds: providerHolds(() => Date.now()), now: () => Date.now() });
    try {
      let last = JSON.parse((await s.trades(MAG, 50)).body);
      for (let i = 0; i < 40 && (last.filling === true || last.trades.length === 0); i++) {
        await new Promise((go) => setTimeout(go, 1_500));
        await s.tick();
        last = JSON.parse((await s.trades(MAG, 50)).body);
      }
      return { last, day };
    } finally {
      s.stop();
    }
  });
  assert.equal(value.last.src, "chain");
  assert.ok(value.last.trades.length > 0, `its trades: ${JSON.stringify(value).slice(0, 300)}`);
  assert.ok(value.day.asked > 0, "the day read asked");
  assert.equal(value.day.refused, 0, `${value.day.refused} of ${value.day.asked} day reads refused`);
});
