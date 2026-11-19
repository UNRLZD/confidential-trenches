// node --test apps/helper/src/data/evm/swaps-ref-once.test.ts: card helper-tape-reopen-whole-from-what-it-holds. Live
// run 44489623436 (helper at c0d9d08c7): 1 of 12 listed Robinhood tapes answered whole at its first open, where 12 of 12
// did on 282da1e4b. Twelve listed Robinhood tapes opened at once on live at 09:34:06Z: six answered at once, the others
// waited 1.4, 2.5, 4.2, 4.5, 5.4, 5.6 and 8.0 s, each with "0 posts" of its own and each read to the head: a stair of waits
// on reads another had in flight. Every reopen of an ETH-quoted tape read the ETH price to the shared head itself
// (reopen: readRef fresh), one after another (refLock), each behind the background's ETH price reads the read ahead and
// the ticks had queued before it. Now a read of the ETH price that one queued or in flight already makes, to the same
// block or past it and back as far, is that one's: joined (lifted to the caller's lane), never queued again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, MAG, open, REC } from "../../../test/evm-swaps/robinhood.ts";

const refReads = (seq: readonly string[]) => seq.filter((x) => x === "ref").length;

/** Both ETH-quoted coins read ahead and rested, the chain 100 blocks on and 30 s later; `tokens` opened at once. */
async function reopenAtOnce(tokens: readonly string[]) {
  const c = fakeChain();
  c.st.head = REC.lastHead - 400;
  const clk = { t: 7_000_000 };
  const s = open(c, clk, {});
  try {
    await s.ahead([CURVE_TOKEN, MAG]);
    c.st.head += 100;
    clk.t += 30_000;
    const before = refReads(c.st.seq);
    const got = await Promise.all(tokens.map((t) => s.trades(t, 50).then((a) => ({ status: a.status, body: JSON.parse(a.body) as { trades: unknown[]; filling?: true } }))));
    return { refs: refReads(c.st.seq) - before, got };
  } finally {
    s.stop();
  }
}

test("card helper-tape-reopen-whole-from-what-it-holds: two rested ETH-quoted Robinhood tapes reopened at once read the ETH price to their shared head once, as one reopened alone does, and both answer whole (red at c0d9d08c7: each reopen read it again, one after another)", async () => {
  const alone = await reopenAtOnce([CURVE_TOKEN]);
  const both = await reopenAtOnce([CURVE_TOKEN, MAG]);
  const l = `ETH price reads: one reopen ${alone.refs}, two at once ${both.refs}; answers ${both.got.map((g) => `${g.status}${g.body.filling ? " filling" : " whole"} n${g.body.trades.length}`).join(", ")}`;
  console.log(l);
  assert.ok(alone.refs > 0, `a reopen read no ETH price: the test proves nothing (${l})`);
  assert.equal(both.refs, alone.refs, `two reopens at once read the ETH price more than one does: ${l}`);
  for (const g of both.got) {
    assert.equal(g.status, 200, l);
    assert.equal(g.body.filling, undefined, `a reopen answered filling: ${l}`);
  }
});
