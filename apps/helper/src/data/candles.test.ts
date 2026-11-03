// node --test apps/helper/src/data/candles.test.ts: the candle and tape builder (candles.ts). The same swaps always give
// the same bars and tape: a fixed answer written out by hand, the same swaps read in 1, 2 and 7 chunks, with the tail
// replaced as a reorg would, and one pricing rule for USD and ETH quotes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUCKETS_MAX, createBook, fixed, price, TAPE_MAX, TFS, type BookConfig, type Event, type Ref, type Swap, type Tf } from "./candles.ts";

const USD: BookConfig = { decimals: 18, quote: { kind: "usd", decimals: 6 } };
const ETH: BookConfig = { decimals: 18, quote: { kind: "eth", decimals: 18 } };
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const swap = (block: number, index: number, t: number, side: "b" | "s", tokens: bigint, quoteUnits: bigint): Swap => ({ kind: "swap", block, index, tx: tx(block * 1000 + index), t, side, amt: tokens * E18, quote: quoteUnits });
const ref = (block: number, index: number, usdPerEth: bigint): Ref => ({ kind: "ref", block, index, ethUsd: usdPerEth * E18 });
const all = (b: ReturnType<typeof createBook>, limit = 1000) => Object.fromEntries(TFS.map((tf) => [tf, b.candles(tf, null, limit)]));

test("fixed: scaled integers as plain decimals, no exponent, no trailing zeros", () => {
  assert.equal(fixed(0n, 30), "0");
  assert.equal(fixed(1n, 30), "0.000000000000000000000000000001");
  assert.equal(fixed(1_500_000n, 6), "1.5");
  assert.equal(fixed(123n * 10n ** 30n, 30), "123");
  assert.equal(fixed(12_345n, 2), "123.45");
});

test("price: a USD quote is its units over the token's, an ETH quote the wei at the ETH price in force; nothing priced without one", () => {
  // 2 USDC for 4 tokens: 0.5 USD each
  const p = price(USD, swap(1, 0, 100, "b", 4n, 2n * E6), null)!;
  assert.equal(fixed(p.price, 30), "0.5");
  assert.equal(fixed(p.usd, 18), "2");
  // 0.001 ETH at 2,500 USD for 5 tokens: 0.5 USD each
  const e = price(ETH, swap(1, 0, 100, "s", 5n, E18 / 1000n), 2_500n * E18)!;
  assert.equal(fixed(e.price, 30), "0.5");
  assert.equal(fixed(e.usd, 18), "2.5");
  assert.equal(price(ETH, swap(1, 0, 100, "s", 5n, E18 / 1000n), null), null, "an ETH quote with no ETH price yet");
  assert.equal(price(USD, { ...swap(1, 0, 100, "b", 4n, 2n * E6), quote: 0n }, null), null, "a zero leg");
  assert.equal(price(USD, { ...swap(1, 0, 100, "b", 4n, 2n * E6), amt: 0n }, null), null, "a zero leg");
  // a price that floors to zero is dropped, never a bar of 0
  const dust = { ...swap(1, 0, 100, "b", 1n, 1n), amt: 10n ** 60n };
  assert.equal(price({ decimals: 0, quote: { kind: "usd", decimals: 6 } }, dust, null), null);
});

// -- the fixed answer ----------------------------------------------------------------------------------------------

/** Twelve swaps over three minutes (block time 2 s from t=1000020), written out so the answer below is checkable by hand. */
const FIXED: Event[] = [
  swap(10, 0, 1_000_020, "b", 10n, 10n * E6), // 1.00, minute 1000020 = 16667 * 60 + 0? (see below)
  swap(10, 1, 1_000_020, "b", 10n, 12n * E6), // 1.20
  swap(11, 0, 1_000_022, "s", 5n, 5n * E6), // 1.00
  swap(12, 0, 1_000_024, "b", 4n, 8n * E6), // 2.00
  swap(20, 0, 1_000_080, "s", 2n, 3n * E6), // 1.50, next minute
  swap(21, 0, 1_000_082, "b", 2n, 2n * E6), // 1.00
  swap(21, 1, 1_000_082, "b", 1n, 3n * E6), // 3.00
  swap(30, 0, 1_000_140, "s", 1n, 1n * E6), // 1.00, third minute
  swap(31, 0, 1_000_142, "s", 4n, 2n * E6), // 0.50
  swap(31, 1, 1_000_142, "b", 4n, 6n * E6), // 1.50
  swap(32, 0, 1_000_144, "b", 1n, 1n * E6), // 1.00
  swap(32, 1, 1_000_144, "s", 8n, 4n * E6), // 0.50
];

test("a fixed answer: twelve swaps give exactly these bars on every timeframe and this tape", () => {
  const b = createBook(USD);
  b.ingest(0, FIXED, 100);
  // 1_000_020 = 16_667 * 60: the minutes start at 1_000_020, 1_000_080 and 1_000_140
  assert.deepEqual(b.candles("1m", null, 10), [
    [1_000_020, "1", "2", "1", "2", "35"], // prices 1.00, 1.20, 1.00, 2.00; volume 10 + 12 + 5 + 8
    [1_000_080, "1.5", "3", "1", "3", "8"], // 1.50, 1.00, 3.00; 3 + 2 + 3
    [1_000_140, "1", "1.5", "0.5", "0.5", "14"], // 1.00, 0.50, 1.50, 1.00, 0.50; 1 + 2 + 6 + 1 + 4
  ]);
  // 1s: one bar per second that held a swap
  assert.deepEqual(b.candles("1s", null, 100).map((c) => [c[0], c[1], c[4]]), [
    [1_000_020, "1", "1.2"],
    [1_000_022, "1", "1"],
    [1_000_024, "2", "2"],
    [1_000_080, "1.5", "1.5"],
    [1_000_082, "1", "3"],
    [1_000_140, "1", "1"],
    [1_000_142, "0.5", "1.5"],
    [1_000_144, "1", "0.5"],
  ]);
  // 1h: all twelve in one bar: first 1.00, last 0.5; high 3, low 0.5; volume 35 + 8 + 14
  assert.deepEqual(b.candles("1h", null, 10), [[997_200, "1", "3", "0.5", "0.5", "57"]]);
  assert.deepEqual(b.candles("1d", null, 10), [[950_400, "1", "3", "0.5", "0.5", "57"]]);
  // the tape: newest first, 12 rows, the last swap first
  const tape = b.tape(50);
  assert.equal(tape.length, 12);
  assert.deepEqual(tape[0], { t_ms: 1_000_144_000, side: "s", usd: "4", amt: "8", trader: null, tx: tx(32_001), block: 32, index: 1 });
  assert.deepEqual(tape[11]!.tx, tx(10_000));
});

// -- the same swaps, however they are read ---------------------------------------------------------------------------

/** A deterministic stream: a seeded generator, 25 blocks of 2 s, up to 4 swaps a block, an ETH price every 5 blocks. */
function stream(blocks: number, eth: boolean): Event[] {
  let s = 12_345;
  const next = (n: number) => ((s = (s * 1_103_515_245 + 12_345) % 2_147_483_648), s % n);
  const out: Event[] = [];
  for (let block = 100; block < 100 + blocks; block++) {
    let index = 0;
    if (eth && block % 5 === 0) out.push(ref(block, index++, BigInt(2_000 + next(500))));
    for (let k = next(5); k > 0; k--) {
      const amt = BigInt(1 + next(1_000)) * E18 + BigInt(next(1_000_000));
      const quote = eth ? BigInt(1 + next(10_000)) * 10n ** 12n : BigInt(1 + next(5_000)) * 10n ** 3n;
      out.push({ kind: "swap", block, index: index++, tx: tx(block * 100 + index), t: 1_700_000_000 + (block - 100) * 2, side: next(2) === 0 ? "b" : "s", amt, quote });
    }
  }
  return out;
}

/** The book after reading `events` in `n` chunks of blocks; each read re-reads the last REWIND blocks and settles all but them. */
function read(cfg: BookConfig, events: Event[], blocks: number, n: number, rewind = 3) {
  const b = createBook(cfg);
  const first = 100;
  const last = 100 + blocks - 1;
  const size = Math.ceil(blocks / n);
  for (let end = first + size - 1; ; end = Math.min(last, end + size)) {
    const from = Math.max(first, b.settledTo + 1);
    b.ingest(from, events.filter((e) => e.block >= from && e.block <= end), end === last ? end : end - rewind);
    if (end >= last) break;
  }
  return b;
}

for (const eth of [false, true]) {
  test(`split reads: the same ${eth ? "ETH-quoted" : "USD-quoted"} swaps read in 1, 2 and 7 chunks give identical bars and tape`, () => {
    const events = stream(240, eth);
    const cfg = eth ? ETH : USD;
    const whole = read(cfg, events, 240, 1);
    assert.ok(whole.candles("1s", null, 10_000).length > 50, "a real stream, not a trivial one");
    for (const n of [2, 7]) {
      const split = read(cfg, events, 240, n);
      assert.deepEqual(all(split, 10_000), all(whole, 10_000), `${n} chunks`);
      assert.deepEqual(split.tape(50), whole.tape(50), `${n} chunks, tape`);
      for (const tf of TFS) assert.equal(split.ownFrom(tf), whole.ownFrom(tf));
    }
    // a read never settled (all in the tail) is the same too
    const live = createBook(cfg);
    live.ingest(100, events, -1 + 100);
    assert.deepEqual(all(live, 10_000), all(whole, 10_000), "unsettled");
  });
}

test("a reorg: the tail replaced from an earlier block gives the bars of the final chain only", () => {
  const events = stream(120, false);
  const b = createBook(USD);
  b.ingest(100, events, 200); // nothing settled yet except through block 200 > last: settle all
  const c = createBook(USD);
  // chain A to block 219 with the last 10 blocks unsettled, then the chain reorgs: blocks 210+ differ
  const a = events.filter((e) => e.block < 210);
  const forked = events.filter((e) => e.block >= 210).map((e) => (e.kind === "swap" ? { ...e, amt: e.amt + E18, tx: tx(Number(BigInt(e.tx) + 7n)) } : e));
  c.ingest(100, a.concat(forked.slice(0, 3)), 205);
  c.ingest(206, a.concat(forked).filter((e) => e.block >= 206), 219);
  const d = createBook(USD);
  d.ingest(100, a.concat(forked), 219);
  assert.deepEqual(all(c, 10_000), all(d, 10_000));
  assert.notDeepEqual(all(c, 10_000), all(b, 10_000), "and the fork is not the old chain");
});

test("ETH quotes are priced by the last ETH price before the swap in block and log order, and carried across a settle", () => {
  const events: Event[] = [
    swap(1, 0, 100, "b", 1n, E18 / 100n), // no ETH price yet: dropped
    ref(1, 1, 2_000n),
    swap(1, 2, 100, "b", 1n, E18 / 100n), // 0.01 ETH at 2,000: 20 USD
    ref(2, 0, 3_000n),
    swap(2, 1, 102, "s", 1n, E18 / 100n), // 30 USD
  ];
  const cfg: BookConfig = { decimals: 18, quote: { kind: "eth", decimals: 18 } };
  const one = createBook(cfg);
  one.ingest(0, events, 2);
  assert.deepEqual(one.candles("1m", null, 10).map((c) => [c[1], c[4], c[5]]), [["20", "30", "50"]]);
  const two = createBook(cfg);
  two.ingest(0, events.filter((e) => e.block <= 1), 1);
  two.ingest(2, events.filter((e) => e.block >= 2), 2);
  assert.deepEqual(two.candles("1m", null, 10), one.candles("1m", null, 10));
});

test("ingest refuses a call that would rewrite what is settled or events out of order", () => {
  const b = createBook(USD);
  b.ingest(0, [swap(5, 0, 100, "b", 1n, E6)], 5);
  assert.throws(() => b.ingest(5, [], 6), /not after settledTo/);
  assert.throws(() => b.ingest(6, [swap(7, 1, 100, "b", 1n, E6), swap(7, 0, 100, "b", 1n, E6)], 7), /not in order/);
  assert.throws(() => b.ingest(6, [swap(5, 9, 100, "b", 1n, E6)], 7), /not in order/);
  assert.throws(() => b.ingest(6, [], 4), /goes back/);
  assert.throws(() => createBook({ decimals: 78, quote: { kind: "usd", decimals: 6 } }), /decimals/);
});

test("to and limit: bars before `to`, the newest `limit` of them", () => {
  const b = createBook(USD);
  b.ingest(0, FIXED, 100);
  assert.deepEqual(b.candles("1m", 1_000_140, 10).map((c) => c[0]), [1_000_020, 1_000_080]);
  assert.deepEqual(b.candles("1m", null, 2).map((c) => c[0]), [1_000_080, 1_000_140]);
  assert.deepEqual(b.candles("1m", 1_000_020, 10), []);
});

test("bounded: the oldest buckets and tape rows go", () => {
  const b = createBook(USD);
  const n = BUCKETS_MAX["1s"] + 50;
  const events: Event[] = [];
  for (let i = 0; i < n; i++) events.push(swap(i, 0, 1_000_000 + i, "b", 1n, E6));
  b.ingest(0, events, n);
  const secs = b.candles("1s", null, 100_000);
  assert.equal(secs.length, BUCKETS_MAX["1s"]);
  assert.equal(secs[0]![0], 1_000_050, "the oldest 50 went");
  assert.equal(b.tape(10_000).length, TAPE_MAX);
});

test("every timeframe's bars sit on its grid and a bar's high and low hold its open and close", () => {
  const events = stream(240, false);
  const b = read(USD, events, 240, 1);
  for (const tf of TFS as readonly Tf[]) {
    const step = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[tf];
    let prev = -1;
    for (const c of b.candles(tf, null, 10_000)) {
      assert.equal(c[0] % step, 0);
      assert.ok(c[0] > prev);
      prev = c[0];
      const [o, h, l, cl] = c.slice(1, 5).map(Number);
      assert.ok(l! <= o! && l! <= cl! && h! >= o! && h! >= cl!);
    }
  }
});
