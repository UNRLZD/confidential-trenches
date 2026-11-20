// node --test apps/helper/src/data/evm/swaps-book-rests.test.ts: card robinhood-spread-tapes-fill-inside-45s, on both
// chains. A book nobody asks for past IDLE_MS stops being read; before the card it was deleted with its read back, so a
// coin opened again a minute later was read from nothing (live run 44263447481: 8 Robinhood coins still filling past
// 45 s, opened again by a later check of the same run). Now it rests (REST_MAX, the oldest rested out first) and a
// reopen reads only the blocks since: Base's on its providers, Robinhood's from the chain's swap index.
import assert from "node:assert/strict";
import { test } from "node:test";
import { turnSlicer } from "../../limits/turn.ts";
import * as base from "../../../test/evm-swaps/base.ts";
import * as rh from "../../../test/evm-swaps/robinhood.ts";
import { IDLE_MS, type createSwaps, type EvmSwaps } from "./swaps.ts";

type Over = Partial<Parameters<typeof createSwaps>[1]>;
type Rig = { st: { head: number }; fetch: (url: string, init: RequestInit) => Promise<Response>; open: (clock: { t: number }, over: Over) => EvmSwaps };
const CHAINS = [
  { chain: "base" as const, tokens: [base.ICNT, base.VVV], start: base.REC.firstHead + 200, rig: (): Rig => ((c) => ({ st: c.st, fetch: c.fetch, open: (clock, over) => base.open(c, clock, over) }))(base.fakeChain()) },
  { chain: "robinhood" as const, tokens: [rh.MAG, rh.CURVE_TOKEN], start: rh.REC.lastHead - 200, rig: (): Rig => ((c) => ({ st: c.st, fetch: c.fetch, open: (clock, over) => rh.open(c, clock, { index: rh.URLS, ...over }) }))(rh.fakeChain()) },
];

type Tape = { trades: { tx: string }[]; filling?: true };
const read = async (s: EvmSwaps, token: string): Promise<Tape> => {
  const a = await s.trades(token, 50);
  assert.equal(a.status, 200, a.body);
  return JSON.parse(a.body) as Tape;
};
/** Ticks until the token's tape is read to the head and settled, as the page reads it: each tick and read again on a
 *  later turn of the loop, as the helper's ticks (TICK_MS) and the page's reads (TRADES_POLL_MS) come. The fake chain
 *  answers with no I/O, so without the turn every tick ran in one, and a read back waiting its parse turn
 *  (limits/turn.ts) never got it. `before(i)` runs before tick i. */
async function settle(s: EvmSwaps, token: string, before?: (i: number) => void): Promise<Tape> {
  let t = await read(s, token);
  for (let i = 0; i < 8 && t.filling === true; i++) {
    await new Promise<void>((go) => setImmediate(go));
    before?.(i);
    await s.tick();
    t = await read(s, token);
  }
  assert.equal(t.filling, undefined, `never settled: ${JSON.stringify(t).slice(0, 200)}`);
  return t;
}
/** Counts the eth_getLogs reads sent (each request of a batch). */
function counted(fetch: Rig["fetch"]) {
  const n = { logs: 0 };
  return {
    n,
    fetch: (url: string, init: RequestInit) => {
      for (const r of [JSON.parse(String(init.body))].flat() as { method?: string }[]) if (r.method === "eth_getLogs") n.logs++;
      return fetch(url, init);
    },
  };
}

for (const c of CHAINS) {
  test(`${c.chain}: a coin unread past IDLE_MS rests; opened again with 20 blocks since it answers the same whole list at once, filling false, with no more log reads than the same reopen of a dropped book (restMax 0, main's behaviour) (red at ff65a0403: the book was deleted and read from nothing)`, async () => {
    const [token] = c.tokens;
    const run = async (over: Over) => {
      const chain = c.rig();
      const net = counted(chain.fetch);
      const clock = { t: 5_000_000 };
      chain.st.head = c.start;
      const s = chain.open(clock, { fetch: net.fetch as never, ...over });
      try {
        const first = await settle(s, token!);
        clock.t += IDLE_MS + 1;
        await s.tick(); // the idle book rests (or, restMax 0, is dropped)
        chain.st.head = c.start + 20;
        const before = net.n.logs;
        const again = await read(s, token!);
        const settled = again.filling === true ? await settle(s, token!) : again;
        return { first, again, settled, reads: net.n.logs - before };
      } finally {
        s.stop();
      }
    };
    const dropped = await run({ restMax: 0 });
    const kept = await run({});
    console.log(`${c.chain}: reopen ${kept.reads} log reads, a dropped book's ${dropped.reads}`);
    assert.equal(kept.again.filling, undefined, `the reopen's first answer is the whole list: ${JSON.stringify(kept.again).slice(0, 200)}`);
    // the same list, with the trades of the blocks since (if any) before it
    const k = kept.again.trades.findIndex((r) => r.tx === kept.first.trades[0]!.tx);
    assert.ok(k >= 0, "the kept list is in the reopen's answer");
    assert.deepEqual(kept.again.trades.slice(k).map((r) => r.tx), kept.first.trades.slice(0, kept.again.trades.length - k).map((r) => r.tx), "the same list, read to the new head");
    assert.deepEqual(kept.settled.trades.map((r) => r.tx), dropped.settled.trades.map((r) => r.tx), "the list a dropped book reads again");
    // Base reads the blocks since alone where a dropped book walks its cold window again; Robinhood's both come from the
    // chain's swap index, so a busy coin's reopen costs the same (a spread coin's: swaps-back-resume.test.ts)
    if (c.chain === "base") assert.ok(kept.reads < dropped.reads, `the reopen sent ${kept.reads} log reads, a dropped book's ${dropped.reads}`);
    else assert.ok(kept.reads <= dropped.reads, `the reopen sent ${kept.reads} log reads, a dropped book's ${dropped.reads}`);
  });

  test(`${c.chain}: rested books are capped (restMax), the oldest rested out first, and each is kept by its own token: a coin rested out opens cold, one still rested opens at once`, async () => {
    const [a, b] = c.tokens;
    const chain = c.rig();
    const net = counted(chain.fetch);
    const clock = { t: 5_000_000 };
    chain.st.head = c.start;
    // no swap index (a chain with none, as Base), so a cold open's reads are posts this counts
    const s = chain.open(clock, { fetch: net.fetch as never, restMax: 1, index: [] });
    try {
      const ta = await settle(s, a!);
      clock.t += IDLE_MS + 1;
      await s.tick(); // a rests
      const tb = await settle(s, b!);
      assert.notDeepEqual(tb.trades.map((r) => r.tx), ta.trades.map((r) => r.tx), "b's list is b's own, never a's kept one");
      clock.t += IDLE_MS + 1;
      await s.tick(); // b rests, a (the oldest) out
      const tb2 = await read(s, b!);
      assert.equal(tb2.filling, undefined, "b, still rested, opens at once");
      assert.deepEqual(tb2.trades.map((r) => r.tx), tb.trades.map((r) => r.tx));
      const before = net.n.logs;
      const ta2 = await settle(s, a!);
      assert.ok(net.n.logs - before > 0, "a, rested out, is read again");
      assert.deepEqual(ta2.trades.map((r) => r.tx), ta.trades.map((r) => r.tx), "and is a's list");
    } finally {
      s.stop();
    }
  });
}

test("base: a read back that waits its parse turn (limits/turn.ts) goes on at a later turn of the loop, so a tape the page reads again, each read a turn of its own, settles; one turn spent before any of the first four ticks (red at b3b5d5f68 for a spend before the first and the third: settle's eight ticks ran in one turn of the loop, the fake chain answering with no I/O, so the read back's turn never came; 1 in 20 under load, merge queue run 44693673920)", async () => {
  const c = CHAINS[0]!;
  for (const at of [0, 1, 2, 3]) {
    const chain = c.rig();
    const clock = { t: 5_000_000 };
    chain.st.head = c.start;
    // the slicer on a clock of its own: still, so every slice has room, but for the one turn spent before tick `at`
    const turn = { ms: 0 };
    const s = chain.open(clock, { restMax: 1, index: [], pass: turnSlicer(() => turn.ms, 20).pass });
    try {
      const t = await settle(s, base.VVV, (i) => {
        if (i === at) turn.ms += 20;
      });
      assert.ok(t.trades.length > 0, `a turn spent before tick ${at}: the settled tape holds the coin's trades`);
    } finally {
      s.stop();
    }
  }
});
