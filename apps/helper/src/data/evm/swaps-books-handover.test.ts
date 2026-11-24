// node --test apps/helper/src/data/evm/swaps-books-handover.test.ts: card helper-tape-handover. A deploy's new helper
// takes over each EVM book the old one held (its pool, its settled block, its swaps and bars, its done read back),
// through the warm file (data/warm.ts), so a Base or Robinhood tape and chart are as full right after a deploy as before
// it: before this a swap started every book over from VENUES.base.cold (1,500 blocks, about 5 minutes of Base), and
// quiet tokens answered an empty tape and a silent chart for minutes (runs 42114989001 and 42114981904; helper update 22
// rolled back on 22 Nov 10:57Z with fresh tapes' checks red right after the deploy). The state is hostile input:
// bounded, each entry checked, one bad entry restores nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, POOL_ICNT, REC, VVV } from "../../../test/evm-swaps/base.ts";
import { HANDED_TIMING, IDLE_MS } from "./swaps.ts";

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

test("card helper-tape-handover: a book at rest on the old helper (idle past IDLE_MS) is handed over at rest; its first open on the new one answers its rows and reads only the blocks after its settled one", async () => {
  const clock = { t: 1_000_000 };
  const c = fakeChain();
  c.st.head = REC.lastHead - 40;
  const old = open(c, clock);
  await old.candles(ICNT, "1m", null, 500);
  for (let h = REC.lastHead - 40; h < REC.lastHead - 20; h += 5) {
    c.st.head = h;
    await old.tick();
  }
  const was = (await bodyOf(old.trades(ICNT, 50))).trades;
  clock.t += IDLE_MS + 1;
  await old.tick();
  const st = handed(old);
  old.stop();
  const books = st.books as [string, { rest?: true; book: { settledTo: number } }][];
  assert.deepEqual(books.map(([t, b]) => [t, b.rest]), [[ICNT, true]], "the idle book handed over at rest");
  const settled = books[0]![1].book.settledTo;
  clock.t += 30_000;
  const n = fakeChain();
  n.st.head = REC.lastHead - 20;
  const from: number[] = [];
  const fetch = (url: string, init: RequestInit) => {
    for (const r of JSON.parse(String(init.body)) as { method: string; params: { fromBlock?: string }[] }[]) if (r.method === "eth_getLogs") from.push(parseInt(r.params[0]!.fromBlock!, 16));
    return n.fetch(url, init);
  };
  const next = open({ ...n, fetch }, clock, { pools: new Map() });
  assert.equal(next.restore(st), true);
  assert.equal(logsAsked(n), 0, "nothing read at the restore: the book rests");
  const now = (await bodyOf(next.trades(ICNT, 50))).trades;
  assert.deepEqual(now.slice(-was.length), was, "its rows as the old helper held them");
  assert.ok(from.length > 0 && from.every((b) => b > settled), `only the blocks after its settled ${settled} read (${from.join(",")})`);
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

test("card helper-tape-handover-judges-handed-books: a restored book's trades answer names the handover in its Server-Timing, and a cold one names nothing, so the live check judges only a book the old helper handed over (red at main 5d7c3a99d: no answer said where its book came from)", async () => {
  const { clock, head, st } = await warmOld();
  clock.t += 30_000;
  const c = fakeChain();
  c.st.head = head;
  const next = open(c, clock, { pools: new Map() });
  assert.equal(next.restore(st), true);
  const handedOver = await next.trades(ICNT, 50);
  assert.ok((JSON.parse(handedOver.body).trades as unknown[]).length > 0, "the restored book answers its rows");
  assert.ok((handedOver.timing ?? "").includes(HANDED_TIMING), `a handed book is named: ${handedOver.timing}`);
  // a coin the old helper never held opens cold on the same helper, and an old helper's own book is never named
  const c2 = fakeChain();
  c2.st.head = head;
  const cold = open(c2, { t: clock.t });
  await cold.candles(ICNT, "1m", null, 500);
  const coldAnswer = await cold.trades(ICNT, 50);
  assert.ok((JSON.parse(coldAnswer.body).trades as unknown[]).length > 0, "the cold book answers its rows");
  assert.ok(!(coldAnswer.timing ?? "").includes("handed"), `a cold book is not named: ${coldAnswer.timing}`);
  next.stop();
  cold.stop();
});

test("card helper-handover-books-take-room: the handover's file (the old helper's last, read once the senders are held) restores every book it holds at rest; a book the start's file left at rest that the old helper has since dropped gives up its room (red at main 4be15c065: held 1 restored 0; live run 45276410984: base held 101 restored 99, robinhood held 100 restored 99)", async () => {
  const clock = { t: 1_000_000 };
  const c = fakeChain();
  // an old helper that keeps one book at rest: ICNT rests, then VVV rests and ICNT is dropped for it
  const old = open(c, clock, { restMax: 1 });
  const rest = async (t: string, from: number) => {
    await old.candles(t, "1m", null, 500);
    for (let h = from; h < from + 20; h += 5) {
      c.st.head = h;
      await old.tick();
    }
    clock.t += IDLE_MS + 1;
    await old.tick();
  };
  await rest(ICNT, REC.lastHead - 45);
  const atStart = handed(old);
  await rest(VVV, REC.lastHead - 25);
  const atStop = handed(old);
  old.stop();
  const restingIn = (st: Record<string, unknown>) => (st.books as [string, { rest?: true }][]).map(([t, b]) => [t, b.rest]);
  assert.deepEqual(restingIn(atStart), [[ICNT, true]], "the start's file: ICNT at rest");
  assert.deepEqual(restingIn(atStop), [[VVV, true]], "the stop's file: VVV at rest, ICNT dropped");
  clock.t += 30_000;
  const n = fakeChain();
  n.st.head = c.st.head;
  const next = open(n, clock, { pools: new Map(), restMax: 1 });
  assert.equal(next.restore(atStart), true);
  assert.deepEqual(next.handover(), { held: 1, restored: 1 }, "the start's file");
  assert.equal(next.restore(atStop), true);
  assert.deepEqual(next.handover(), { held: 1, restored: 1 }, "the handover's file: VVV takes the room of ICNT, which the old helper dropped");
  const a = await next.trades(VVV, 50);
  assert.ok((JSON.parse(a.body).trades as unknown[]).length > 0, "VVV answers its rows");
  assert.ok((a.timing ?? "").includes(HANDED_TIMING), `VVV answers as handed: ${a.timing}`);
  next.stop();
});

// card handover-rest-keeps-the-hottest: the redeploy at dc876a2c2 (24 Nov 14:28Z) restored 100 of 100 books on each chain,
// yet of the coins its warm file held at rest, Base's 20 newest answered 1 handed of 16 and Robinhood's 1 h trending 6 of
// 10, the rest cold (read right after, every listed coin at once). The restore set the books at rest most recently asked
// first, and rest() makes room by dropping the map's first: so each new book put at rest after a deploy (a listed coin
// the old helper did not hold, read ahead) dropped the hottest handed book, not the coldest.
test("card handover-rest-keeps-the-hottest: a book put at rest after a restore that fills REST_MAX drops the handed book least recently asked, never the most (red at dc876a2c2: it dropped VVV, the most recently asked, and VVV opened cold)", async () => {
  const clock = { t: 1_000_000 };
  const c = fakeChain();
  const old = open(c, clock, { restMax: 2 });
  const rest = async (t: string, from: number) => {
    await old.candles(t, "1m", null, 500);
    for (let h = from; h < from + 20; h += 5) {
      c.st.head = h;
      await old.tick();
    }
    clock.t += IDLE_MS + 1;
    await old.tick();
  };
  // ICNT asked first, VVV after: VVV is the hotter
  await rest(ICNT, REC.lastHead - 45);
  await rest(VVV, REC.lastHead - 25);
  const st = handed(old);
  old.stop();
  assert.deepEqual((st.books as [string, { rest?: true }][]).map(([t, b]) => [t, b.rest]), [[VVV, true], [ICNT, true]], "both handed at rest, the most recently asked first");
  clock.t += 30_000;
  const n = fakeChain();
  n.st.head = c.st.head;
  // a third coin the old helper never held (its own address on ICNT's pool's logs), opened and left idle on the new helper
  const X = `0x${"77".repeat(20)}`;
  const next = open(n, clock, { pools: new Map([[X, { pool: { ...POOL_ICNT, token: X }, decimals: 18 }]]), restMax: 2 });
  assert.equal(next.restore(st), true);
  assert.deepEqual(next.handover(), { held: 2, restored: 2 });
  await next.candles(X, "1m", null, 500);
  clock.t += IDLE_MS + 1;
  await next.tick();
  const hot = await next.trades(VVV, 50);
  assert.ok((hot.timing ?? "").includes(HANDED_TIMING), `VVV, the most recently asked, still answers as handed: ${hot.timing}`);
  const cold = await next.trades(ICNT, 50);
  assert.ok(!(cold.timing ?? "").includes(HANDED_TIMING), `ICNT, the least recently asked, gave its room to X: ${cold.timing}`);
  next.stop();
});

test("card helper-tape-handover-judges-handed-books: the swaps name what the warm file held and what they restored (handover(), on /v1/health): after a restore 2 of 2, at a cold start 0 of 0, after a file with a hostile book 0 of 2 (a restore is whole or nothing), so the live check fails a deploy that dropped books (red at main 5d7c3a99d: no counts)", async () => {
  const { clock, head, st } = await warmOld();
  const at = () => {
    const c = fakeChain();
    c.st.head = head;
    return open(c, clock, { pools: new Map() });
  };
  const cold = at();
  assert.deepEqual(cold.handover(), { held: 0, restored: 0 }, "a cold start");
  assert.equal(cold.restore(undefined), false);
  assert.deepEqual(cold.handover(), { held: 0, restored: 0 }, "no swaps part handed over: nothing held");
  cold.stop();
  const next = at();
  assert.equal(next.restore(st), true);
  assert.deepEqual(next.handover(), { held: 2, restored: 2 }, "after a restore");
  // the same file read again at the handover (server.ts restores at the start and once the senders are held) counts its
  // books once: they are held already
  assert.equal(next.restore(st), true);
  assert.deepEqual(next.handover(), { held: 2, restored: 2 }, "the same file again");
  next.stop();
  const hostile = JSON.parse(JSON.stringify(st)) as { books: [string, Record<string, unknown>][] };
  (hostile.books[1]![1].book as { tape: unknown[] }).tape.reverse();
  const after = at();
  assert.equal(after.restore(hostile), false);
  assert.deepEqual(after.handover(), { held: 2, restored: 0 }, "a hostile book: the file held 2, none restored");
  after.stop();
  for (const [what, part] of [["no state", 7], ["books that are no list", { books: {} }]] as const) {
    const odd = at();
    assert.equal(odd.restore(part), false, what);
    assert.deepEqual(odd.handover(), { held: 1, restored: 0 }, `${what}: something held, nothing restored`);
    odd.stop();
  }
});
