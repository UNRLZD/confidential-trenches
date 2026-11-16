// node --test apps/helper/src/data/evm/swaps-day-tape-steps.test.ts: card robinhood-trades-finish-filling. A Robinhood
// coin whose swaps lie apart over the day reads its tape back in several agreed steps; the one wide read that finds its
// swaps (BACK_LOCATE, the chain's own RPC, one post a second) is made once, never again before each step. Live 16 Nov
// 13:5xZ, a cold tape of 0x04fabf48 run in the helper's own container with every provider call timed: the read back read
// the whole day on the chain's own RPC again before each 10,000-block step (864,000, then 811,098, then 791,398 blocks)
// and stood 15.7 s between two steps, while every step's reads answered in 17-168 ms; 4 trades after 27 s, still filling.
// The live checks helper-robinhood-capacity, helper-robinhood-search-ahead and robinhood-listed-tape-opens failed on such
// tapes still filling past 45 s (runs 43861861053, 43865675533, 43874805885).
// The recorded pool's 213 swaps (1,933 blocks) are spread here over 40,000 blocks: the newest 20 where they were, the
// next 100 20,000 blocks before, the rest 40,000 before, the ETH price's logs copied with them; the chain's own RPC
// answers the first whole-range read and refuses (429) every later one, as it did when its one post a second was taken.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, MAG, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, SWAP_RPCS, TRADES_MAX } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

// the spread: each moved log keeps its order, its time moved back with it at Robinhood's 10 blocks a second
const byNewest = [...REC.logs.v4].sort((a, b) => b.b - a.b || b.i - a.i);
const shiftOf = new Map(byNewest.map((l, k) => [l, k < 20 ? 0 : k < 120 ? 20_000 : 40_000]));
const moved = (l: (typeof REC.logs.v4)[number], s: number) => ({ ...l, b: l.b - s, ts: l.ts - s / 10 });
REC.logs.v4.splice(0, REC.logs.v4.length, ...REC.logs.v4.map((l) => moved(l, shiftOf.get(l)!)));
const ref = [...REC.logs.ref];
REC.logs.ref.push(...[20_000, 40_000].flatMap((s) => ref.map((l) => moved(l, s))));
REC.logs.ref.sort((a, b) => a.b - b.b || a.i - b.i);
const LAST = Math.max(...REC.logs.v4.map((l) => l.b));
const HEAD = LAST + 7_200;

function rig() {
  const chain = fakeChain();
  chain.st.head = HEAD;
  chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000 });
  chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
  chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
  chain.st.faults.set("https://robinhood.daybreak-rpc.network", { span: 2_000 });
  const located: number[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    await new Promise((go) => setTimeout(go, 200));
    if (url === OWN) {
      const reqs = [JSON.parse(String(init.body))].flat() as { method: string; params: { fromBlock?: string; toBlock?: string; topics?: unknown[] }[] }[];
      const whole = reqs.some((r) => r.method === "eth_getLogs" && r.params[0]?.topics?.[0] === SWAP && Number(BigInt(r.params[0].toBlock!) - BigInt(r.params[0].fromBlock!)) + 1 > 100_000);
      if (whole) {
        located.push(Number(BigInt(reqs[0]!.params[0]!.toBlock!) - BigInt(reqs[0]!.params[0]!.fromBlock!)) + 1);
        if (located.length > 1) return new Response("{}", { status: 429, headers: { "retry-after": "1", "content-type": "application/json" } });
      }
    }
    return chain.fetch(url, init);
  };
  const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, fetch: fetch as never, holds: providerHolds(() => Date.now()), now: () => Date.now() });
  return { s, located };
}

test("card robinhood-trades-finish-filling: a coin's swaps apart over the day are read back in agreed steps after one wide read of the day, its tape full and done, the chain's own RPC refusing every later whole-range read", async () => {
  const { value } = await onVirtualTime(1_000_000_000, async () => {
    const { s, located } = rig();
    try {
      let last = JSON.parse((await s.trades(MAG, 50)).body);
      let reads = 1;
      for (; reads < 60 && (last.filling === true || last.trades.length === 0); reads++) {
        await new Promise((go) => setTimeout(go, 1_500));
        await s.tick();
        last = JSON.parse((await s.trades(MAG, 50)).body);
      }
      return { last, reads, located };
    } finally {
      s.stop();
    }
  });
  console.log(`${value.last.trades.length} trades, filling ${value.last.filling}, after ${value.reads} reads 1.5 s apart; whole-range reads of the day: ${value.located.join(", ")}`);
  assert.equal(value.last.src, "chain");
  assert.equal(value.last.trades.length, Math.min(TRADES_MAX, 50), `its last ${TRADES_MAX} trades, from three steps apart (${value.last.trades.length})`);
  assert.equal(value.last.filling, undefined, "done reading back");
  assert.equal(value.located.length, 1, `one wide read of the day, never one before each step (${value.located.join(", ")})`);
  // the page's reads 1.5 s apart (TRADES_POLL_MS): full within the live checks' 45 s is 30 of them at most
  assert.ok(value.reads <= 30, `full within the live checks' 45 s: ${value.reads} reads 1.5 s apart`);
});
