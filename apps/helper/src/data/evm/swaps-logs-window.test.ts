// node --test apps/helper/src/data/evm/swaps-logs-window.test.ts: card robinhood-tapes-inside-their-bounds-on-live. A
// provider that refuses a log read for its history window (api.blockvectra.com's public endpoint: -32011 "block reference
// is outside the public history window", about 850 blocks) is asked no read from as far back again while the mark holds:
// 12 Robinhood tapes opened at once from the Mac on the keyless providers (22 Nov 14:0xZ, main ee5c7dac4) sent it 62 log
// reads, 41 refused so and 19 more 429, each a post spent and a pair waited on in the reads every tape fills from, and
// 0 to 3 of the 12 tapes filled inside 45 s.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, MAG, open, REC, URLS } from "../../../test/evm-swaps/robinhood.ts";

const WINDOW = 850;
const VECTRA = "https://c.test";

/** The fake chain as Robinhood's providers were read (swaps-robinhood.test.ts card helper-chart-fresh): one history
 *  provider down, the third keeping WINDOW blocks of logs, the chain's own RPC logging no time; and the log reads the
 *  third was asked from past its window. */
function rig() {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  chain.st.faults.set("https://a.test", { down: true }); // a history provider timing out
  chain.st.faults.set(VECTRA, { window: WINDOW });
  chain.st.faults.set("https://d.test", { zeroTime: true });
  let past = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url === VECTRA) {
      const reqs = [JSON.parse(String(init.body))].flat() as { method: string; params: { fromBlock?: string }[] }[];
      past += reqs.filter((r) => r.method === "eth_getLogs" && parseInt(r.params[0]?.fromBlock ?? "0x0", 16) < chain.st.head - WINDOW).length;
    }
    return chain.fetch(url, init);
  };
  const s = open(chain, undefined, { pools: new Map(), rpcs: [...URLS, "https://d.test"], headerTimed: new Set(["https://d.test"]), fetch: fetch as never });
  return { s, past: () => past };
}

test("card robinhood-tapes-inside-their-bounds-on-live: once a provider refused a log read for its history window, a second tape's first read asks it nothing from as far back (red at main ee5c7dac4: every read asked it again)", async () => {
  const { s, past } = rig();
  const first = await s.trades(CURVE_TOKEN, 50);
  assert.equal(first.status, 200, first.body);
  const afterFirst = past();
  assert.ok(afterFirst > 0, "the first tape's cold read met the window");
  const second = await s.trades(MAG, 50);
  assert.equal(second.status, 200, second.body);
  s.stop();
  assert.equal(past() - afterFirst, 0, `the second tape asked past the window ${past() - afterFirst} more times`);
});
