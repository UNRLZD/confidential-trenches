// node --test apps/helper/src/data/evm/swaps-tapes-ahead.test.ts: card robinhood-tapes-read-ahead. Live helper run
// 44279880076 (18 Nov 10:17Z, helper at ff65a0403): 10 of the 12 listed Robinhood coins opened cold were "still filling
// 45xxx ms after its first read (21 reads), past 45000 ms" in index-evm-swaps, robinhood-spread-tapes-fill-inside-45s,
// robinhood-listed-tape-opens and helper-robinhood-capacity. A book rested past IDLE_MS reopens at once (card
// robinhood-spread-tapes-fill-inside-45s), but a coin nobody had opened was read from nothing at its first open: its pool
// was looked for ahead (helper-robinhood-search-ahead), its tape only when a page asked, a dozen at once. Now the lists'
// coins' tapes are read ahead too (swaps.ts ahead), in the helper's background lane, at most AHEAD_AT_ONCE at a time,
// none started while a first open waits for its pool or while a provider is held, and rested ready for the first open.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as base from "../../../test/evm-swaps/base.ts";
import { open } from "../../../test/evm-swaps/robinhood.ts";
import { LATE_MS, LISTED, PAGE, POCKET, rig, SWAPS, TOKENS } from "../../../test/evm-swaps/spread.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { LOOP_BUSY_MS } from "../../limits/loop-busy.ts";
import { HEADER_TIMED, OPEN_BOUND_MS, SWAP_RPCS, type Pool } from "./swaps.ts";

const clock = { get t() { return Date.now(); } };
const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
type Tape = { status: number; filling: boolean; n: number; ms: number };
const tapeOf = (a: { status: number; body: string }, ms: number): Tape => {
  const j = a.status === 200 ? (JSON.parse(a.body) as { trades: unknown[]; filling?: boolean }) : null;
  return { status: a.status, filling: j?.filling === true, n: j?.trades.length ?? -1, ms };
};
const line = (got: Tape[], toks = TOKENS) => got.map((g, i) => `${toks[i]!.token.slice(-2)} ${g.status}${g.filling ? " filling" : ""} n${g.n} ${(g.ms / 1000).toFixed(1)} s`).join(", ");

test("card robinhood-tapes-read-ahead: Robinhood, 12 listed spread coins nobody opened, the lists loaded a minute before a page opens them all at once: every first answer is the whole list (20 trades, not filling), within the open's bound (red at f5049c481: each read its tape from nothing at its first open, its first answer filling, 2.1 to 8.0 s)", async () => {
  const r = rig();
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    // the lists' answer loads (server.ts evmSwapsFromEnv calls ahead with its tokens), and a minute passes
    void s.ahead(LISTED.map((x) => x.token));
    await sleep(60_000);
    const t0 = clock.t;
    const got = await Promise.all(LISTED.map(({ token }) => s.trades(token, 50).then((a) => tapeOf(a, clock.t - t0))));
    s.stop();
    return got;
  });
  const l = line(value);
  console.log(`first answers: ${l}`);
  for (const g of value) {
    assert.equal(g.status, 200, l);
    assert.equal(g.filling, false, `a first answer still filling: ${l}`);
    assert.equal(g.n, SWAPS, `the coin's whole list: ${l}`);
    assert.ok(g.ms < OPEN_BOUND_MS, `a first answer at the open's bound: ${l}`);
  }
});

test("card robinhood-tapes-read-ahead: Base, a listed coin nobody opened, the lists loaded before its first open: the first answer is its whole list at once, the list a cold open reads (red at f5049c481: the first open read it from nothing)", async () => {
  const run = async (ahead: boolean) => {
    const c = base.fakeChain();
    c.st.head = base.REC.firstHead + 200;
    const clk = { t: 5_000_000 };
    const s = base.open(c, clk, {});
    try {
      if (ahead) await s.ahead([base.VVV]);
      const a = await s.trades(base.VVV, 50);
      assert.equal(a.status, 200, a.body);
      return JSON.parse(a.body) as { trades: { tx: string }[]; filling?: true };
    } finally {
      s.stop();
    }
  };
  const cold = await run(false);
  const ahead = await run(true);
  console.log(`base: cold first answer ${cold.trades.length} trades${cold.filling ? " filling" : ""}; read ahead ${ahead.trades.length}${ahead.filling ? " filling" : ""}`);
  assert.equal(ahead.filling, undefined, `the first answer after the read ahead is still filling: ${JSON.stringify(ahead).slice(0, 200)}`);
  assert.deepEqual(ahead.trades.map((r) => r.tx), (await (async () => {
    // the list a cold open reads once it is whole (settled by ticks), the same as the read ahead's
    const c = base.fakeChain();
    c.st.head = base.REC.firstHead + 200;
    const s = base.open(c, { t: 5_000_000 }, {});
    try {
      let j = JSON.parse((await s.trades(base.VVV, 50)).body) as { trades: { tx: string }[]; filling?: true };
      for (let i = 0; i < 20 && j.filling === true; i++) {
        await s.tick();
        j = JSON.parse((await s.trades(base.VVV, 50)).body) as typeof j;
      }
      return j.trades.map((r) => r.tx);
    } finally {
      s.stop();
    }
  })()), "the read ahead's list is the one a cold open settles on");
  assert.ok(cold.filling === true, "the rig's cold first open fills (else this test proves nothing)");
});

test("card robinhood-tapes-read-ahead: a page's open of a coin no list carries, arriving while the lists' 12 tapes are read ahead, answers as fast as with no read ahead running (its posts go first: the read ahead is the background lane and starts no tape while a first open waits)", async () => {
  const pageOpen = async (withAhead: boolean) => {
    const r = rig();
    const { value } = await onVirtualTime(9_000_000, async () => {
      const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
      if (withAhead) {
        void s.ahead(LISTED.map((x) => x.token));
        await sleep(3_000);
      }
      const t0 = clock.t;
      const a = await s.trades(PAGE.token, 50);
      const got = tapeOf(a, clock.t - t0);
      s.stop();
      return got;
    });
    return value;
  };
  const alone = await pageOpen(false);
  const mid = await pageOpen(true);
  console.log(`page open alone ${alone.ms} ms (${alone.status}${alone.filling ? " filling" : ""} n${alone.n}), mid read ahead ${mid.ms} ms (${mid.status}${mid.filling ? " filling" : ""} n${mid.n})`);
  assert.equal(mid.status, 200);
  assert.ok(mid.n > 0, "the page's coin answered its trades");
  assert.ok(mid.ms <= alone.ms + 2 * LATE_MS, `the page's open took ${mid.ms} ms mid read ahead, ${alone.ms} ms alone`);
});

test("card robinhood-tapes-read-ahead: a provider held (its 429) when the lists load: no tape is read ahead (no pool read at all, the pools kept); once no provider is held the next lists answer reads them, and their first opens are whole", async () => {
  const r = rig();
  // the two coins' pools kept (an earlier search's), so every pool read here is a tape's
  const kept = new Map(LISTED.slice(0, 2).map(({ token, pool }) => [token, { pool: { venue: "v3", id: pool, token, tokenIs0: true, quote: { kind: "usd", decimals: 6 } } as Pool, decimals: 18 }]));
  const { value } = await onVirtualTime(9_000_000, async () => {
    const holds = providerHolds(() => Date.now());
    holds.hold(POCKET, 30);
    const s = open(r.chain, clock, { pools: kept, rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never, holds });
    await s.ahead(LISTED.slice(0, 2).map((x) => x.token));
    const held = LISTED.slice(0, 2).map(({ pool }) => r.n.poolReads.get(pool) ?? 0);
    await sleep(31_000);
    await s.ahead(LISTED.slice(0, 2).map((x) => x.token));
    const after = LISTED.slice(0, 2).map(({ pool }) => r.n.poolReads.get(pool) ?? 0);
    const t0 = clock.t;
    const got = await Promise.all(LISTED.slice(0, 2).map(({ token }) => s.trades(token, 50).then((a) => tapeOf(a, clock.t - t0))));
    s.stop();
    return { held, after, got };
  });
  console.log(`pool reads while held ${value.held.join(", ")}; after ${value.after.join(", ")}; ${line(value.got)}`);
  for (const x of value.held) assert.equal(x, 0, `a tape was read ahead while a provider was held: ${value.held.join(", ")}`);
  for (const x of value.after) assert.ok(x > 0, `no tape was read ahead once no provider was held: ${value.after.join(", ")}`);
  for (const g of value.got) assert.equal(g.filling, false, `read ahead once no provider was held: ${line(value.got)}`);
});

test("card robinhood-tapes-read-ahead: posts and 429s against the base, every provider refusing past 4 posts a second: the lists load and answer again each minute (LIST_MS), three minutes on a page opens the 12 at once and reads each until whole; every tape whole by 45 s (FILLED_MS), the posts and 429s printed (red at f5049c481: all 12 still filling at 45 s, 6 to 20 trades each, the opens' 429s 104 of 435 posts; now whole by 5.1 s, 7 of 67)", async () => {
  const r = rig({ limit: 4 });
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
    // the read ahead stops at a provider's hold (its 429) and the lists' next answer asks again
    for (let k = 0; k < 3; k++) {
      void s.ahead(LISTED.map((x) => x.token));
      await sleep(60_000);
    }
    const before = { posts: r.n.posts, refused: r.n.refused };
    const t0 = clock.t;
    let over = false;
    const latest = new Map<string, Tape>();
    const poll = async (token: string) => {
      while (!over) {
        const a = await s.trades(token, 50);
        const g = tapeOf(a, clock.t - t0);
        latest.set(token, g);
        if (g.status === 200 && !g.filling) return;
        await sleep(2_000);
      }
    };
    const polls = Promise.all(LISTED.map(({ token }) => poll(token)));
    const bound = sleep(45_000).then(() => (over = true));
    while (!over && [...latest.values()].filter((g) => !g.filling && g.status === 200).length < LISTED.length) {
      await sleep(1_000);
      await s.tick();
    }
    over = true;
    void bound;
    await polls;
    s.stop();
    return { got: LISTED.map(({ token }) => latest.get(token)!), ahead: before, opens: { posts: r.n.posts - before.posts, refused: r.n.refused - before.refused } };
  });
  const l = line(value.got);
  console.log(`429s: read ahead ${value.ahead.refused} of ${value.ahead.posts} posts; the opens' ${value.opens.refused} of ${value.opens.posts} posts; ${l}`);
  for (const g of value.got) {
    assert.equal(g.status, 200, l);
    assert.equal(g.filling, false, `a tape still filling at 45 s: ${l}`);
  }
});

test("card robinhood-tapes-read-ahead-bounded: while the helper's loop is busy (a live run's burst) the lists' tapes are not read ahead; once the loop is free they are read and their first opens are whole (red at 6b1926fc9: the read ahead ran through a busy loop, its reads on top of the burst's)", async () => {
  const r = rig();
  const kept = new Map(LISTED.slice(0, 2).map(({ token, pool }) => [token, { pool: { venue: "v3", id: pool, token, tokenIs0: true, quote: { kind: "usd", decimals: 6 } } as Pool, decimals: 18 }]));
  const loop = { busy: true };
  const { value } = await onVirtualTime(9_000_000, async () => {
    const s = open(r.chain, clock, { pools: kept, rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never, busy: () => loop.busy });
    void s.ahead(LISTED.slice(0, 2).map((x) => x.token));
    await sleep(20_000);
    const busy = LISTED.slice(0, 2).map(({ pool }) => r.n.poolReads.get(pool) ?? 0);
    loop.busy = false;
    await sleep(20_000);
    const free = LISTED.slice(0, 2).map(({ pool }) => r.n.poolReads.get(pool) ?? 0);
    const t0 = clock.t;
    const got = await Promise.all(LISTED.slice(0, 2).map(({ token }) => s.trades(token, 50).then((a) => tapeOf(a, clock.t - t0))));
    s.stop();
    return { busy, free, got };
  });
  console.log(`pool reads while busy ${value.busy.join(", ")}; once free ${value.free.join(", ")}; ${line(value.got)}`);
  for (const x of value.busy) assert.equal(x, 0, `a tape was read ahead while the loop was busy: ${value.busy.join(", ")}`);
  for (const x of value.free) assert.ok(x > 0, `no tape was read ahead once the loop was free: ${value.free.join(", ")}`);
  for (const g of value.got) {
    assert.equal(g.filling, false, `read ahead once the loop was free: ${line(value.got)}`);
    assert.equal(g.n, SWAPS, line(value.got));
  }
});

/** The read-ahead answers that may land while a burst holds the loop busy, when none was in flight as it began: none,
 *  so the read ahead adds no synchronous span to a burst's (its longest span alone, printed below, is measured on this
 *  machine's clock: a unit test judges no real elapsed time, scripts/ci/no-wall-clock-asserts.mjs). */
const BURST_ANSWERS_MAX = 0;
/** How long the burst holds the loop busy here, from the lists' load: most of the read ahead's answers land inside it
 *  with the loop free (asserted below, else the burst run proves nothing). */
const BURST_MS = 40_000;

test("card robinhood-tapes-read-ahead-bounded: the 12 listed coins read ahead on the injected clock, each synchronous span of its work timed: while a burst holds the loop busy from the lists' load for BURST_MS the read ahead adds no span to it (BURST_ANSWERS_MAX of its answers land inside it, none was in flight when it began); once the burst ends every first open is whole (red at 6b1926fc9: its answers land inside the burst, their work on top of the burst's)", async () => {
  const run = async (burst: boolean) => {
    const r = rig();
    const loop = { busy: burst };
    /** Each turn's real ms on a virtual ms a read-ahead answer landed at: the helper's work on that answer. */
    const spans: { ms: number; at: number }[] = [];
    const { value } = await onVirtualTime(
      9_000_000,
      async () => {
        const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never, busy: () => loop.busy });
        const t0 = clock.t;
        void s.ahead(LISTED.map((x) => x.token));
        await sleep(BURST_MS);
        loop.busy = false;
        await sleep(60_000);
        const got = await Promise.all(LISTED.map(({ token }) => s.trades(token, 50).then((a) => tapeOf(a, 0))));
        s.stop();
        return { t0, got };
      },
      (ms, at) => {
        if (r.n.answeredAt.has(at)) spans.push({ ms, at });
      },
    );
    const inBurst = spans.filter((x) => x.at - value.t0 < BURST_MS);
    const answersInBurst = [...r.n.answeredAt].filter((at) => at - value.t0 < BURST_MS).length;
    return { got: value.got, longest: Math.max(0, ...spans.map((x) => x.ms)), burstMs: inBurst.reduce((a, x) => a + x.ms, 0), answersInBurst, answers: r.n.answeredAt.size };
  };
  const free = await run(false);
  const held = await run(true);
  const f = (x: number) => `${x.toFixed(1)} ms`;
  console.log(`loop free: longest span ${f(free.longest)}, ${free.answersInBurst} of ${free.answers} answer ms inside the first ${BURST_MS} ms (${f(free.burstMs)}); burst: longest span ${f(held.longest)}, ${held.answersInBurst} answer ms inside it (${f(held.burstMs)}); LOOP_BUSY_MS ${LOOP_BUSY_MS} ms; ${line(held.got)}`);
  assert.ok(free.answersInBurst * 2 > free.answers, `with the loop free only ${free.answersInBurst} of ${free.answers} answer ms are in the first ${BURST_MS} ms: the burst run proves nothing`);
  assert.ok(held.answersInBurst <= BURST_ANSWERS_MAX, `read-ahead answers landed at ${held.answersInBurst} virtual ms inside the burst, ${f(held.burstMs)} of loop time on top of it`);
  for (const g of held.got) {
    assert.equal(g.filling, false, `read ahead once the burst ended: ${line(held.got)}`);
    assert.equal(g.n, SWAPS, line(held.got));
  }
});
