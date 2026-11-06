// node --test apps/helper/src/data/evm/swaps-lanes.test.ts (card helper-deploy-reads-fast): a user's read never waits
// behind the helper's own reads on a chain's providers. Live run 42122733397 attempt 1, the first live checks after a
// helper deploy: every Base tape was cold, the checks opened dozens at once (helper-live-bars-no-503: first reads 2.3 to
// 5.6 s; helper-v4-hook-liquidity: a tape 503 at OPEN_BOUND_MS), and index-evm-swaps' candles came 23 s after its read.
// Each open book ticks every TICK_MS, and at e89cfae0 a caller's open drew each provider's pace and in-flight queue as a
// background read, level with those ticks, the lists' pool search (ahead) and the maker reads. Planted here on the real
// Base providers' paces (limits.ts PROVIDER_PACE), on virtual time, every fake answer 300 ms: 39 open books ticking, the
// lists restored from a warm file written before it named its block clock (so every none maker is read again,
// MAKER_PER_TICK a tick, through the same paces), and the pool search of 40 more tokens. Alone a cold candles read
// answers in 1.2 s; under that load at e89cfae0 it took 6.0 to 6.5 s, and with a burst of maker reads beside it, 503 at
// OPEN_BOUND_MS (12 s); with the lanes 1.0 to 1.3 s.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeChain, FAST_SHIFT, ICNT, KNOWN, open, POOL_ICNT, REC } from "../../../test/evm-swaps/base.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { geckoBudget } from "../gecko.ts";
import { createEvmLists } from "./lists.ts";
import { SWAP_RPCS } from "./swaps.ts";

const ANSWER_MS = 300;
const BOOKS = Array.from({ length: 39 }, (_, i) => `0x${(0xdd000 + i).toString(16).padStart(40, "0")}`);
const SEARCHED = Array.from({ length: 40 }, (_, i) => `0x${(0xabc00 + i).toString(16).padStart(40, "0")}`);
const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const gtAnswer = (url: string) => fx(url.includes("new_pools") ? "gt-base-new.json" : url.includes("duration=5m") ? "gt-base-trending-5m.json" : "gt-base-trending-1h.json");

/** The recorded Base chain behind the real swap providers (base-pokt.nodies.app down) and GeckoTerminal's recorded
 *  lists; every answer takes ANSWER_MS. */
function rig() {
  const chain = fakeChain({ shift: FAST_SHIFT });
  chain.st.head = REC.lastHead + FAST_SHIFT;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    await new Promise((go) => setTimeout(go, ANSWER_MS));
    if (url.includes("geckoterminal")) return new Response(gtAnswer(url), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("nodies")) return new Response("down", { status: 503 });
    return chain.fetch(url, init);
  };
  return { chain, fetch };
}

/** One cold candles read of ICNT on a helper whose providers carry `load`; its status, ms and Server-Timing. */
async function coldCandles(load: boolean) {
  const r = rig();
  const { value } = await onVirtualTime(1_793_918_000_000, async () => {
    const holds = providerHolds();
    const pools = new Map(KNOWN);
    for (const t of BOOKS) pools.set(t, { pool: { ...POOL_ICNT, token: t }, decimals: 18 });
    const s = open(r.chain, { get t() { return Date.now(); } }, { rpcs: SWAP_RPCS.base, holds, fetch: r.fetch as never, pools, tickMs: load ? 1_000 : 0 });
    let stopLists = () => undefined as void;
    if (load) {
      // the lists as a helper restarted from a warm file with no block clock takes them: every none read again, its
      // maker reads on the same providers' paces (lists.ts heldFetch)
      const seed = createEvmLists("base", geckoBudget(Date.now), { fetch: r.fetch as never });
      await seed.tick();
      const st = seed.state();
      const toks: string[] = [...new Set(Object.values(JSON.parse((await seed.get()).body).lists).flatMap((rows) => (rows as { token: string }[]).map((x) => x.token)))];
      const lists = createEvmLists("base", geckoBudget(Date.now), { fetch: r.fetch as never, holds });
      assert.equal(lists.restore({ reads: st.reads, makers: toks.map((t) => [t, null]) }), true, "the warm file's lists taken over");
      assert.ok(JSON.parse((await lists.get()).body).unsettled.length >= 20, "every none of a file with no clock read again");
      stopLists = lists.warm();
      // 39 books open and read, then kept open (a page polls each well inside IDLE_MS), each ticking every TICK_MS
      for (let k = 0; k < 10; k++) if ((await Promise.all(BOOKS.map((t) => s.trades(t, 50)))).every((a) => a.status === 200)) break;
      void s.ahead(SEARCHED);
      await new Promise((go) => setTimeout(go, 3_000));
    }
    const t0 = Date.now();
    const c = await s.candles(ICNT, "1m", null, 60);
    const ms = Date.now() - t0;
    s.stop();
    stopLists();
    return { status: c.status, ms, timing: c.timing ?? "" };
  });
  return value;
}

test("card helper-deploy-reads-fast: a cold Base candles read behind 39 ticking books, the maker reads of a clockless warm file and the pool search answers 200 within 3 s, its queue wait named in Server-Timing (e89cfae0: 6.0 to 6.5 s)", async () => {
  const alone = await coldCandles(false);
  assert.equal(alone.status, 200);
  const loaded = await coldCandles(true);
  assert.equal(loaded.status, 200, `the loaded read answered ${loaded.status} in ${loaded.ms} ms (alone: ${alone.ms} ms)`);
  assert.ok(loaded.ms <= 3_000, `the loaded read took ${loaded.ms} ms, alone ${alone.ms} ms: ${loaded.timing}`);
  assert.match(loaded.timing, /(^|, )evm-open;dur=\d+, evm-queue;dur=\d+;desc="\d+ posts: pace \d+ ms, in flight \d+ ms"/, "the answer names its open and queue waits");
});
