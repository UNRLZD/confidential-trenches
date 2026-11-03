// node --test apps/helper/src/data/evm/swaps-robinhood.test.ts: the swap reader on Robinhood (swaps.ts, card
// index-evm-swaps-2). Recorded real Robinhood logs (a Pons v2 curve quoted in native ETH, a v4 pool quoted in native ETH,
// and the ETH / USDG price pool) read tick by tick in steps of 1, 3 and 11 blocks equal the same logs rebuilt in one go;
// swaps are timed by the block times two providers logged alike, never by a clock; the curve is found from the Pons
// factory's own record; no read asks more than the 100 blocks the keyless providers take.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBook, TFS, type Event } from "../candles.ts";
import { CURVE_TOKEN, fakeChain, KNOWN, MAG, open, POOL_CURVE, POOL_MAG, REC, toLog } from "../../../test/evm-swaps/robinhood.ts";
import { decodeRef, decodeSwap, TOPIC, VENUES, type Pool } from "./swaps.ts";

function rebuild(pool: Pool, upTo: number) {
  const src = pool === POOL_CURVE ? REC.logs.curve : REC.logs.v4;
  const events: Event[] = [];
  for (const l of src.map(toLog)) {
    const s = l.block <= upTo ? decodeSwap(pool, l, "robinhood") : null;
    if (s !== null) events.push({ ...s, t: l.t! });
  }
  for (const l of REC.logs.ref.map(toLog)) {
    const r = l.block <= upTo ? decodeRef(l, "robinhood") : null;
    if (r !== null) events.push(r);
  }
  events.sort((a, b) => a.block - b.block || a.index - b.index);
  const book = createBook({ decimals: 18, quote: pool.quote });
  book.ingest(REC.firstHead, events, upTo);
  return book;
}
const bodyOf = async (p: Promise<{ body: string }>) => JSON.parse((await p).body);
/** The head a first open is read at: its cold window ends at the recording's 600th block. */
const START = REC.firstHead + 599;

test("the recording is real Robinhood logs: 2,000 blocks, curve buys and sells, a busy v4 pool and the ETH price, every log with a block time that never goes back", () => {
  assert.ok(REC.lastHead - REC.firstHead >= 1_999);
  const kinds = new Set(REC.logs.curve.map((l) => l.t[0]));
  assert.ok(kinds.has(TOPIC.curveBuy) && kinds.has(TOPIC.curveSell), "both curve events");
  assert.ok(REC.logs.curve.length >= 10 && REC.logs.v4.length > 100 && REC.logs.ref.length > 20);
  for (const src of Object.values(REC.logs)) {
    let last = 0;
    for (const l of [...src].sort((a, b) => a.b - b.b || a.i - b.i)) {
      assert.ok(l.ts >= last && l.ts > 1_700_000_000, `block ${l.b}`);
      last = l.ts;
    }
  }
  // the factory's record names the curve, the token and native ETH as the quote, and exists
  const w = (i: number) => REC.launchedRecord.slice(2 + 64 * i, 2 + 64 * (i + 1));
  assert.equal(`0x${w(0).slice(24)}`, CURVE_TOKEN);
  assert.equal(`0x${w(1).slice(24)}`, REC.curve);
  assert.equal(BigInt(`0x${w(4)}`), 0n);
  assert.equal(BigInt(`0x${w(14)}`), 1n);
});

test("a Pons curve's trades: CurveBuy is a buy of tokensOut for quoteIn, CurveSell a sell of tokensIn for quoteOut (recorded logs)", () => {
  const buy = REC.logs.curve.map(toLog).find((l) => l.topics[0] === TOPIC.curveBuy)!;
  const sell = REC.logs.curve.map(toLog).find((l) => l.topics[0] === TOPIC.curveSell)!;
  const word = (d: string, i: number) => BigInt(`0x${d.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  assert.deepEqual(decodeSwap(POOL_CURVE, buy, "robinhood"), { kind: "swap", block: buy.block, index: buy.index, tx: buy.tx, side: "b", amt: word(buy.data, 1), quote: word(buy.data, 0) });
  assert.deepEqual(decodeSwap(POOL_CURVE, sell, "robinhood"), { kind: "swap", block: sell.block, index: sell.index, tx: sell.tx, side: "s", amt: word(sell.data, 0), quote: word(sell.data, 1) });
  // another curve's log, a short data, another event: refused
  assert.equal(decodeSwap({ ...POOL_CURVE, id: `0x${"12".repeat(20)}` }, buy, "robinhood"), null);
  assert.equal(decodeSwap(POOL_CURVE, { ...buy, data: buy.data.slice(0, -64) }, "robinhood"), null);
  assert.equal(decodeSwap(POOL_CURVE, { ...buy, topics: [TOPIC.swap3, ...buy.topics.slice(1)] }, "robinhood"), null);
});

const reading = (steps: number) =>
  test(`a recorded stretch of Robinhood read live, ${steps} block${steps === 1 ? "" : "s"} a tick, gives the bars and tape of the same logs rebuilt in one go (a Pons curve and a v4 pool, both in ETH)`, async () => {
    const chain = fakeChain();
    chain.st.head = START;
    const s = open(chain);
    await s.candles(CURVE_TOKEN, "1m", null, 500);
    await s.candles(MAG, "1m", null, 500);
    let head = START;
    while (head < REC.lastHead) {
      head = Math.min(REC.lastHead, head + steps);
      chain.st.head = head;
      await s.tick();
    }
    s.stop();
    for (const [token, pool] of [[CURVE_TOKEN, POOL_CURVE], [MAG, POOL_MAG]] as const) {
      const whole = rebuild(pool, REC.lastHead);
      let bars = 0;
      for (const tf of TFS.filter((x) => x !== "1s")) {
        const live = await bodyOf(s.candles(token, tf, null, 500));
        assert.deepEqual(live.candles, whole.candles(tf, null, 500), `${token} ${tf}`);
        bars += live.candles.length;
      }
      assert.ok(bars > 6, "real bars, not an empty match");
      const tape = await bodyOf(s.trades(token, 50));
      assert.ok(tape.trades.length > 5);
      assert.deepEqual(tape.trades.map((t: { tx: string; side: string; usd: string; amt: string; t_ms: number }) => [t.tx, t.side, t.usd, t.amt, t.t_ms]), whole.tape(50).map((t) => [t.tx, t.side, t.usd, t.amt, t.t_ms]), `${token} tape`);
    }
    assert.ok(Math.max(...chain.st.spans) <= 100, "no read asks more than 100 blocks");
  });
for (const n of [1, 3, 11]) reading(n);

test("a Pons token's main pool is its curve, named by the factory's own record (no pool given), and its first read is the discovery's", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const s = open(chain, undefined, { pools: new Map() });
  const tape = await bodyOf(s.trades(CURVE_TOKEN, 50));
  s.stop();
  const whole = rebuild(POOL_CURVE, REC.lastHead);
  // the discovery reads the chain's cold window: the swaps the rebuild has in it
  const inWindow = whole.tape(50).filter((t) => t.block > REC.lastHead - VENUES.robinhood.cold);
  assert.ok(inWindow.length > 0, "the window holds curve trades");
  assert.deepEqual(tape.trades.map((t: { tx: string; usd: string }) => [t.tx, t.usd]), inWindow.map((t) => [t.tx, t.usd]));
  // a token no factory recorded and with no pool: not found, never a guess
  const t = open(chain, undefined, { pools: new Map() });
  const none = await t.trades(`0x${"34".repeat(20)}`, 10);
  t.stop();
  assert.equal(none.status, 404);
});

test("block times: a provider that logs blockTimestamp 0x0 (as rpc.mainnet.chain.robinhood.com does) is outvoted by the two that agree; two that log none serve nothing", async () => {
  const chain = fakeChain();
  chain.st.head = START;
  chain.st.faults.set("https://a.test", { zeroTime: true });
  const s = open(chain);
  const tape = await bodyOf(s.trades(CURVE_TOKEN, 50));
  s.stop();
  const whole = rebuild(POOL_CURVE, START);
  assert.deepEqual(tape.trades.map((t: { t_ms: number }) => t.t_ms), whole.tape(50).map((t) => t.t_ms));
  assert.ok(tape.trades.every((t: { t_ms: number }) => t.t_ms > 1_700_000_000_000));

  const both = fakeChain();
  both.st.head = START;
  both.st.faults.set("https://a.test", { zeroTime: true });
  both.st.faults.set("https://b.test", { zeroTime: true });
  both.st.faults.set("https://c.test", { skewTime: true });
  const z = open(both);
  const r = await z.trades(CURVE_TOKEN, 50);
  z.stop();
  assert.equal(r.status, 503, "no time two providers agree on but 0: nothing served");

  // two providers agree on times that go back: not a chain's, nothing served
  const back = fakeChain();
  back.st.head = START;
  for (const u of ["https://a.test", "https://b.test", "https://c.test"]) back.st.faults.set(u, { backTime: true });
  const b = open(back);
  const rb = await b.trades(CURVE_TOKEN, 50);
  b.stop();
  assert.equal(rb.status, 503, "times that go back: nothing served");
});
