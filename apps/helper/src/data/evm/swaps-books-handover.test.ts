// node --test apps/helper/src/data/evm/swaps-books-handover.test.ts: card helper-tape-handover. A deploy's new helper
// takes over each EVM book the old one held (its pool, its settled block, its swaps and bars, its done read back),
// through the warm file (data/warm.ts), so a Base or Robinhood tape and chart are as full right after a deploy as before
// it: before this a swap started every book over from VENUES.base.cold (1,500 blocks, about 5 minutes of Base), and
// quiet tokens answered an empty tape and a silent chart for minutes (runs 42114989001 and 42114981904; helper update 22
// rolled back on 22 Nov 10:57Z with fresh tapes' checks red right after the deploy). The state is hostile input:
// bounded, each entry checked, one bad entry restores nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, REC, VVV } from "../../../test/evm-swaps/base.ts";

const bodyOf = async (p: Promise<{ body: string }>) => JSON.parse((await p).body);
const handed = (s: { state(): unknown }) => JSON.parse(JSON.stringify(s.state())) as Record<string, unknown>;
const logsAsked = (c: ReturnType<typeof fakeChain>) => [...c.st.methods].filter(([k]) => k.endsWith(" eth_getLogs")).reduce((n, [, v]) => n + v, 0);

async function warmOld() {
  const clock = { t: 1_000_000 };
  const c = fakeChain();
  c.st.head = REC.lastHead - 40;
  const old = open(c, clock);
  for (const t of [ICNT, VVV]) await old.candles(t, "1m", null, 500);
  for (let h = REC.lastHead - 40; h < REC.lastHead - 5; h += 5) {
    c.st.head = h;
    await old.tick();
  }
  const was = {
    trades: await Promise.all([ICNT, VVV].map(async (t) => (await bodyOf(old.trades(t, 50))).trades)),
    bars: await Promise.all([ICNT, VVV].map(async (t) => (await bodyOf(old.candles(t, "1m", null, 500))).candles)),
  };
  const st = handed(old);
  old.stop();
  return { clock, head: c.st.head, was, st };
}

test("card helper-tape-handover: a second helper restored from the first one's state answers the same trades and candles, with no eth_getLogs before its first tick (red at main a2458a619: swaps.ts hands no book over)", async () => {
  const { clock, head, was, st } = await warmOld();
  assert.ok(was.trades.every((r) => r.length > 0) && was.bars.every((b) => b.length > 0), "the old helper held trades and bars");
  clock.t += 30_000;
  const c = fakeChain();
  c.st.head = head;
  const next = open(c, clock, { pools: new Map() });
  assert.equal(next.restore(st), true);
  const now = {
    trades: await Promise.all([ICNT, VVV].map(async (t) => (await bodyOf(next.trades(t, 50))).trades)),
    bars: await Promise.all([ICNT, VVV].map(async (t) => (await bodyOf(next.candles(t, "1m", null, 500))).candles)),
  };
  assert.equal(logsAsked(c), 0, "no eth_getLogs before the first tick");
  assert.deepEqual(now.trades, was.trades);
  assert.deepEqual(now.bars, was.bars);
  // the first tick goes on from the settled block less the rewind, and the book still answers what it did
  await next.tick();
  assert.ok(logsAsked(c) > 0, "the tick reads on");
  assert.deepEqual((await bodyOf(next.trades(ICNT, 50))).trades, was.trades[0]);
  next.stop();
});

test("card helper-tape-handover (hostile): a book whose bars, swaps or blocks are not a book's restores nothing, and the helper reads its tapes itself", async () => {
  const { clock, head, st } = await warmOld();
  const books = st.books as [string, Record<string, unknown>][];
  assert.ok(Array.isArray(books) && books.length === 2, "two books handed over");
  const bad = (f: (b: Record<string, unknown>) => void) => {
    const s = JSON.parse(JSON.stringify(st)) as { books: [string, Record<string, unknown>][] };
    f(s.books[0]![1]);
    return s;
  };
  const book = (b: Record<string, unknown>) => b.book as Record<string, unknown>;
  const cases: [string, ReturnType<typeof bad>][] = [
    ["a price that is no integer", bad((b) => ((book(b).tape as unknown[][])[0]![10] = "1e30"))],
    ["a swap out of order", bad((b) => (book(b).tape as unknown[]).reverse())],
    ["a settled block ahead of the head read", bad((b) => (b.headN = -1))],
    ["a bar off its bucket", bad((b) => (((book(b).bars as Record<string, unknown[][]>)["1m"]![0]![0] as number) += 1))],
    ["a token that is not its pool's", bad((b) => ((b.pool as Record<string, unknown>).token = VVV))],
    ["a tail swap at or before the settled block", bad((b) => (book(b).tail as unknown[]).push(["s", 1, 0, `0x${"ab".repeat(32)}`, 1, "b", "1", "1", null, 1]))],
  ];
  for (const [what, s] of cases) {
    const c = fakeChain();
    c.st.head = head;
    // the pools known (KNOWN), so the tape is the book's own first read, not a pool search
    const next = open(c, clock);
    assert.equal(next.restore(s), false, what);
    const a = await bodyOf(next.trades(ICNT, 50));
    assert.ok(logsAsked(c) > 0, `${what}: the tape read again`);
    assert.ok(Array.isArray(a.trades) && a.trades.length > 0, `${what}: the tape answered from its own read`);
    next.stop();
  }
});
