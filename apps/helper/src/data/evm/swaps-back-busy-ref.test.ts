// node --test apps/helper/src/data/evm/swaps-back-busy-ref.test.ts: card robinhood-trades-finish-filling. An ETH-quoted
// Robinhood coin reads its tape back in 10,000-block steps, and each step that holds a swap reads the ETH price's pool
// over the step: on mainnet a busy pool, 931 swaps in the step of 0x75d87437 read live on 16 Nov 15:5xZ in the helper's
// own container, every provider call timed. The chain's own RPC answered the 931 logs at once but logs no block time, so
// its answer waits on its own headers, 10 a post at one post a second: it was asked three times in the one read (the
// first pair, again as a wide provider, first in the patient round) and could time none, 8 s; daybreak, the other
// provider that times old blocks, was sent the step as one post per run of 100-block spans with logs (20 posts, the
// empty spans between already agreed), past its 7 posts a second within the read's 1.5 s, and the rest waited for the
// patient round behind the chain's own. 14 s a step; the tape still filling past 45 s (live checks
// helper-robinhood-capacity and helper-robinhood-search-ahead, run 43891883180, 46,267 ms).
// Here the recorded coin's swaps are spread one step apart, and the ETH price's pool logs a swap every 15th block of
// two 100-block spans in three, as busy as live; the chain's own RPC logs no time, as it does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, MAG, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, ROBINHOOD_REF_POOL_ID, SWAP_RPCS, TRADES_MAX } from "./swaps.ts";

const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const DAYBREAK = "https://robinhood.daybreak-rpc.network";
// each provider's answer time as timed live (16 Nov 15:5xZ): the chain's own 120-200 ms, pocket 10-500, daybreak 30-150
const LATENCY: Record<string, number> = { [OWN]: 150, [POCKET]: 100, [DAYBREAK]: 80 };
const REF = ROBINHOOD_REF_POOL_ID;

// the newest 20 swaps where they were, then 6 a step back for five steps, the rest a sixth step back (live, 3 to 5 a step)
const byNewest = [...REC.logs.v4].sort((a, b) => b.b - a.b || b.i - a.i);
const shiftOf = new Map(byNewest.map((l, k) => [l, k < 20 ? 0 : 10_000 * Math.min(6, Math.ceil((k - 19) / 6))]));
const moved = (l: (typeof REC.logs.v4)[number], s: number) => ({ ...l, b: l.b - s, ts: l.ts - s / 10 });
REC.logs.v4.splice(0, REC.logs.v4.length, ...REC.logs.v4.map((l) => moved(l, shiftOf.get(l)!)));
const LAST = Math.max(...REC.logs.v4.map((l) => l.b));
const FIRST = Math.min(...REC.logs.v4.map((l) => l.b));
const HEAD = LAST + 7_200;
// the busy ETH price: a recorded ref swap's data every 15th block of the read-back blocks, two 100-block spans in three
const [r0] = REC.logs.ref;
const timeOf = (b: number) => Math.floor(r0!.ts + (b - r0!.b) / 10);
const busy = [];
for (let b = FIRST - 10_000; b < REC.firstHead; b++) {
  if (b % 15 !== 0 || Math.floor(b / 100) % 3 === 0) continue;
  const like = REC.logs.ref[b % REC.logs.ref.length]!;
  busy.push({ ...like, b, i: 0, ts: timeOf(b), tx: `0x${b.toString(16).padStart(64, "0")}` });
}
REC.logs.ref.push(...busy);
REC.logs.ref.sort((a, b) => a.b - b.b || a.i - b.i);

function rig() {
  const chain = fakeChain();
  chain.st.head = HEAD;
  chain.st.faults.set(OWN, { zeroTime: true, span: 1_000_000 });
  chain.st.faults.set(POCKET, { span: 10_000, addressOnly: true });
  chain.st.faults.set("https://rpc-robinhood.blockmachine.io", { span: 1_000, window: 5_000 });
  chain.st.faults.set("https://robinhood.daybreak-rpc.network", { span: 2_000 });
  let headers = 0;
  let ownRef = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    await new Promise((go) => setTimeout(go, LATENCY[url] ?? 200));
    if (url === OWN && String(init.body).includes(REF)) ownRef++;
    if (url === OWN && String(init.body).includes("eth_getBlockByNumber") && !String(init.body).includes('"latest"')) headers++;
    return chain.fetch(url, init);
  };
  const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, fetch: fetch as never, holds: providerHolds(() => Date.now()), now: () => Date.now() });
  return { s, headers: () => headers, ownRef: () => ownRef };
}

test("card robinhood-trades-finish-filling: an ETH-quoted coin's tape reads back step after step past a busy ETH price pool, full and done inside 45 s", async () => {
  const { value } = await onVirtualTime(1_000_000_000, async () => {
    const { s, headers, ownRef } = rig();
    try {
      let last = JSON.parse((await s.trades(MAG, 50)).body);
      let reads = 1;
      for (; reads < 60 && (last.filling === true || last.trades.length === 0); reads++) {
        await new Promise((go) => setTimeout(go, 1_500));
        await s.tick();
        last = JSON.parse((await s.trades(MAG, 50)).body);
      }
      return { last, reads, headers: headers(), ownRef: ownRef() };
    } finally {
      s.stop();
    }
  });
  console.log(`${value.last.trades.length} trades, filling ${value.last.filling}, after ${value.reads} reads 1.5 s apart; the chain's own header posts ${value.headers}, its ETH price reads ${value.ownRef}`);
  assert.equal(value.last.src, "chain");
  assert.equal(value.last.trades.length, Math.min(TRADES_MAX, 50), `its last ${TRADES_MAX} trades, from six steps back (${value.last.trades.length})`);
  assert.equal(value.last.filling, undefined, "done reading back");
  // the page's reads 1.5 s apart (TRADES_POLL_MS): full within the live checks' 45 s is 30 of them at most
  assert.ok(value.reads <= 30, `full within the live checks' 45 s: ${value.reads} reads 1.5 s apart`);
});
