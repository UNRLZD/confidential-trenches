// node --test apps/helper/src/data/evm/swaps-names-pool.test.ts: card tape-names-its-pool. A Base or Robinhood coin's
// tape and chart are read from one pool of the coin (the pool it trades on), and the answer's Server-Timing names that
// pool (evm-pool;desc="<venue> <id>"), so a reader judges the tape against the pool it is, never another pool of the
// coin. Helper live run 45256973001 (23 Nov 20:1xZ) judged Robinhood STATICS's tape against its listed pool 0xe79228d6
// because every tape row's transaction also swapped there (a bot's triangle through 0x20aa1721, 0xe79228d6 and
// 0x84bd4e2d) and called two swaps of 0xe79228d6 alone missing; the tape was 0x20aa1721's, all 26 of its swaps on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as base from "../../../test/evm-swaps/base.ts";
import * as rh from "../../../test/evm-swaps/robinhood.ts";
import type { EvmSwaps, Pool } from "./swaps.ts";

const POOL_TIMING = /(?:^|,)\s*evm-pool;desc="([a-z0-9]+) (0x[0-9a-f]+)"/;

const CHAINS: { chain: string; token: string; pool: Pool; open: (clock: { t: number }) => EvmSwaps }[] = [
  { chain: "base", token: base.ICNT, pool: base.POOL_ICNT, open: (clock) => ((c) => (c.st.head = base.REC.firstHead + 200, base.open(c, clock)))(base.fakeChain()) },
  { chain: "robinhood", token: rh.MAG, pool: rh.POOL_MAG, open: (clock) => ((c) => (c.st.head = rh.REC.lastHead - 200, rh.open(c, clock, { index: rh.URLS })))(rh.fakeChain()) },
];

for (const c of CHAINS) {
  test(`${c.chain}: the tape's and the chart's answers name the pool their rows are read from (${c.pool.venue} ${c.pool.id.slice(0, 10)})`, async () => {
    const s = c.open({ t: 5_000_000 });
    try {
      let tape = await s.trades(c.token, 50);
      for (let i = 0; i < 4 && JSON.parse(tape.body).filling === true; i++) {
        await s.tick();
        tape = await s.trades(c.token, 50);
      }
      assert.equal(tape.status, 200, tape.body.slice(0, 200));
      assert.ok(JSON.parse(tape.body).trades.length > 0, "the tape has rows");
      assert.deepEqual(POOL_TIMING.exec(tape.timing ?? "")?.slice(1), [c.pool.venue, c.pool.id], `the tape names its pool: ${tape.timing}`);
      const chart = await s.candles(c.token, "1m", null, 2);
      assert.equal(chart.status, 200, chart.body.slice(0, 200));
      assert.deepEqual(POOL_TIMING.exec(chart.timing ?? "")?.slice(1), [c.pool.venue, c.pool.id], `the chart names its pool: ${chart.timing}`);
    } finally {
      s.stop();
    }
  });
}
