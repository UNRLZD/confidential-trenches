// node --test apps/helper/src/data/evm/swaps-hang.test.ts: a Robinhood provider that never answers is passed over within
// a bound, and a first open answers within its bound (card helper-robinhood-trades-hang). Live 2026-11-05 14:57-15:25Z
// at c297f61: every cold Robinhood tape hung 60-137 s. Reproduced from the Mac at c48a98f with the real providers: the
// chain's swap index (index.ts) held nothing for 135 s, its first read all or nothing over five chunks with daybreak
// timing out at 8 s on about one post in five, and every first read's range (swaps.ts agreedRange) waited on that index
// read with no bound; each round of the open then waited the full 8 s for the provider that hung before asking the next.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, MAG, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { INDEX_RPCS, OPEN_BOUND_MS, SWAP_RPCS } from "./swaps.ts";

const DAYBREAK = "https://robinhood.daybreak-rpc.network";
const WIDE = [DAYBREAK, "https://rpc-robinhood.blockmachine.io", "https://robinhood.api.pocket.network", "https://rpc.mainnet.chain.robinhood.com"];
/** The bound a first open answers within (scripts/live-checks/helper-robinhood-search-ahead.mjs ANSWER_MS). */
const BOUND_MS = 15_000;
/** What a post to a provider that never answers costs: the helper's own abort of it (swaps.ts TIMEOUT_MS). */
const ABORT_MS = 8_000;
/** Each answer of the providers that do answer, this many virtual ms after its post (their live 0.2 to 0.9 s). */
const LATE_MS = 300;

/** The fake chain behind the real Robinhood provider and index lists, every answer LATE_MS late; `hung` hold every post
 *  until the helper's abort. Made inside the virtual clock, so its waits are on it. */
function rig(hung: readonly string[], pools?: Map<string, never>) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  for (const u of WIDE) chain.st.faults.set(u, { span: 1_000 });
  const posts = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    posts.set(url, (posts.get(url) ?? 0) + 1);
    if (hung.includes(url)) return new Promise((_, no) => setTimeout(() => no(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ABORT_MS));
    await new Promise((go) => setTimeout(go, LATE_MS));
    return chain.fetch(url, init);
  };
  const s = open(chain, { t: 0 }, { rpcs: SWAP_RPCS.robinhood, index: INDEX_RPCS.robinhood, fetch: fetch as never, holds: providerHolds(() => Date.now()), now: () => Date.now(), ...(pools === undefined ? {} : { pools }) });
  return { s, posts };
}

for (const [what, token, pools] of [
  ["a Pons token found by the discovery", CURVE_TOKEN, new Map<string, never>()],
  ["a v4 token whose pool is known", MAG, undefined],
] as const) {
  test(`card helper-robinhood-trades-hang: with daybreak never answering, ${what} answers its first tape 200 within ${BOUND_MS / 1000} s`, async () => {
    let posts = new Map<string, number>();
    const { value: r, ms } = await onVirtualTime(1_000_000_000, async () => {
      const run = rig([DAYBREAK], pools);
      posts = run.posts;
      try {
        return await run.s.trades(token, 50);
      } finally {
        run.s.stop();
      }
    });
    console.log(`${what}: ${r.status} in ${ms} virtual ms, posts ${JSON.stringify(Object.fromEntries(posts))}`);
    assert.equal(r.status, 200, r.body);
    assert.ok(ms <= BOUND_MS, `answered in ${ms} ms, past ${BOUND_MS} ms`);
  });
}

test("card helper-robinhood-trades-hang: with every provider never answering, a first tape and chart answer 503 within the open's bound, never held past it", async () => {
  const { value, ms } = await onVirtualTime(1_000_000_000, async () => {
    const run = rig([...SWAP_RPCS.robinhood], new Map<string, never>());
    try {
      const [tape, chart] = await Promise.all([run.s.trades(CURVE_TOKEN, 50), run.s.candles(MAG, "1m", null, 500)]);
      return { tape, chart };
    } finally {
      run.s.stop();
    }
  });
  console.log(`every provider hung: tape ${value.tape.status}, chart ${value.chart.status}, in ${ms} virtual ms`);
  assert.equal(value.tape.status, 503, value.tape.body);
  assert.equal(value.chart.status, 503, value.chart.body);
  assert.ok(ms <= OPEN_BOUND_MS + 100, `answered in ${ms} ms, past ${OPEN_BOUND_MS} ms`);
});
