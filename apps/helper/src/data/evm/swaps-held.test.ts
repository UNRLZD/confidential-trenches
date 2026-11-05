// node --test apps/helper/src/data/evm/swaps-held.test.ts: card helper-live-bars-no-503. A token whose book the helper
// holds answers its chart's live read (limit 2) and its tape 200 with the bars and swaps it holds, dated by their last
// read (as_of_ms, which server.ts sends as X-Fetched-At), however long its providers fail or stall: Chrome prints "Failed
// to load resource" for every non-2xx answer and no page code can stop it (card app-chart-live, 5 Nov 13:16Z; a 12:00Z
// read of 100 Base live reads of the deployed helper got 6 answers of 503). A token the helper holds nothing for still
// answers 503, so the page reads again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, REC, URLS } from "../../../test/evm-swaps/base.ts";
import { STALE_MS } from "./swaps.ts";

/** The fake chain's fetch, or with `stalled` set a read that never answers until its own timeout aborts it or
 *  `release` drops it (the provider's connection reset, so the test waits no 8 s timeout). */
function stalling(chain: ReturnType<typeof fakeChain>) {
  const st = { stalled: false };
  const out: ((e: Error) => void)[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> =>
    st.stalled
      ? new Promise((_, no) => {
          out.push(no);
          init.signal?.addEventListener("abort", () => no(init.signal!.reason), { once: true });
        })
      : chain.fetch(url, init);
  const release = () => {
    st.stalled = false;
    for (const no of out.splice(0)) no(new Error("reset"));
  };
  return { st, fetch, release };
}

for (const how of ["fail", "stall"] as const) {
  test(`a held Base token's live read (limit 2) and tape answer 200 with what is held, dated by its last read, while every provider ${how}s, past STALE_MS and 30 minutes on; the next read once they answer is fresh`, async () => {
    const chain = fakeChain();
    const clock = { t: 5_000_000 };
    const net = stalling(chain);
    const s = open(chain, clock, { fetch: net.fetch as never });
    chain.st.head = REC.firstHead + 200;
    const good = await s.candles(ICNT, "1m", null, 2);
    const tape = await s.trades(ICNT, 50);
    assert.equal(good.status, 200, good.body);
    assert.equal(tape.status, 200, tape.body);
    const held = JSON.parse(good.body);
    assert.equal(held.candles.length, 2);
    const readAt = good.asOfMs!;

    if (how === "fail") for (const u of URLS) chain.st.faults.set(u, { down: true });
    else net.st.stalled = true;
    chain.st.head = REC.firstHead + 220;
    for (const step of [STALE_MS + 1_000, 4 * 60_000, 25 * 60_000]) {
      clock.t += step;
      const live = await s.candles(ICNT, "1m", null, 2);
      assert.equal(live.status, 200, `${clock.t - readAt} ms after the last read: ${live.status} ${live.body}`);
      assert.deepEqual(JSON.parse(live.body), held, "the held bars, as_of_ms their last read");
      assert.equal(live.asOfMs, readAt, "X-Fetched-At is the last read, never now");
      const t = await s.trades(ICNT, 50);
      assert.equal(t.status, 200, t.body);
      assert.equal(t.body, tape.body, "the held tape, dated by its last read");
    }

    // the providers answer again: the held answer started a read, and the next one is dated now
    for (const u of URLS) chain.st.faults.delete(u);
    net.release();
    await s.tick();
    const fresh = await s.candles(ICNT, "1m", null, 2);
    s.stop();
    assert.equal(fresh.status, 200, fresh.body);
    assert.equal(fresh.asOfMs, clock.t, "read again once the providers answer");
  });
}

test("control: a Base token the helper holds nothing for answers 503 upstream while every provider fails, so the page reads again", async () => {
  const chain = fakeChain();
  for (const u of URLS) chain.st.faults.set(u, { down: true });
  const s = open(chain, { t: 5_000_000 });
  chain.st.head = REC.firstHead + 200;
  const none = await s.candles(ICNT, "1m", null, 2);
  s.stop();
  assert.equal(none.status, 503);
  assert.deepEqual(JSON.parse(none.body), { error: { code: "upstream" } });
});
