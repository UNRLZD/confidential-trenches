// The token chart is live (card app-chart-live): the fold rule replayed on tapes recorded from the deployed helper, and
// the follow loop's reads, waits and stops. A tape (test/chart-live/*.json, read from HELPER_HOST on 5 Nov 11:54-12:02Z
// with Origin APP_HOST, the token written as <mint>: an active pump.fun coin at 15m, a Base and a Robinhood token at 1m) is one
// page's reads of GET /v1/market/candles: its first read (limit 500), then the newest bars read every second for 100 s
// (the page's own live read), then a full read again. Folding every live read into the first read's bars must give,
// bar for bar, what the helper's full read gives at the end over the bars the live reads covered, and the last bar
// drawn after each read must be that read's newest bar; two planted wrong folds (an update dropped, a price taken from
// the wrong bar) must not. The helper's older bars changed within two tapes (it rebuilt the token's bars): that is the
// follow's full read every RESYNC_MS, tested below.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CANDLES_LIMIT, LIVE_BACKOFF_MAX_MS, LIVE_LIMIT, LIVE_MS, RESYNC_MS, followCandles, foldBars, toCandleData } from "../src/screens/token/candles.ts";
import type { Bar, ChartTf, ReadyCandles } from "../src/screens/token/candles.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "chart-live");
type Read = { at_ms: number; limit: number; status: number; src: string | null; body: unknown };
type Tape = { chain: string; tf: string; token: string; first: Read; polls: Read[]; last: Read };
const TF: Record<string, ChartTf> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
const tapes = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, tape: JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Tape }));

const ready = (r: Read, tf: ChartTf): ReadyCandles => {
  const d = toCandleData(r.body, tf, r.src);
  assert.ok(d && d.status === "ready", `a recorded read the page maps: ${JSON.stringify(r).slice(0, 120)}`);
  return d;
};

type Fold = (bars: readonly Bar[], fresh: readonly Bar[], tf: ChartTf) => Bar[] | null;
/** The bars drawn after every live read of a tape, folded with `fold`: whether each read's newest bar is the last bar
 *  drawn, whether the end equals the helper's own full read over the bars the live reads covered, and whether it
 *  equals it over every bar (`older`: false when the helper rebuilt the token's older bars during the tape). */
function replay(t: Tape, fold: Fold): { marks: boolean; end: boolean; older: boolean; moved: number } {
  const tf = TF[t.tf]!;
  let bars = ready(t.first, tf).bars;
  let marks = true;
  let moved = 0;
  for (const p of t.polls) {
    // a failed live read (the deployed helper answered some 503s while the Base tape was recorded) changes nothing
    if (p.status !== 200) continue;
    const fresh = ready(p, tf).bars;
    const next = fold(bars, fresh, tf);
    assert.ok(next !== null, "a recorded read is on the grid");
    if (JSON.stringify(next.at(-1)) !== JSON.stringify(bars.at(-1))) moved++;
    bars = next;
    if (JSON.stringify(bars.at(-1)) !== JSON.stringify(fresh.at(-1))) marks = false;
  }
  const want = ready(t.last, tf).bars;
  const same = (from: number) => JSON.stringify(bars.filter((b) => b.timestamp >= from)) === JSON.stringify(want.filter((x) => x.timestamp >= from));
  const covered = ready(t.polls.find((p) => p.status === 200)!, tf).bars[0]!.timestamp;
  // the full read holds at most CANDLES_LIMIT bars, and the helper may hold fewer of GeckoTerminal's before its own
  const all = Math.max(want[0]!.timestamp, bars[0]!.timestamp);
  return { marks, end: same(Math.max(all, covered)), older: same(all), moved };
}

// planted wrong folds: a live read only appends a newer bar (the last bar's updates dropped), and a fold that draws the
// fresh close on the bar before the newest (a price on the wrong bar)
const appendOnly: Fold = (bars, fresh) => bars.concat(fresh.filter((b) => b.timestamp > (bars.at(-1)?.timestamp ?? -1)));
const wrongBar: Fold = (bars, fresh, tf) => {
  const f = foldBars(bars, fresh, tf);
  if (f === null || f.length < 2) return f;
  const out = f.slice();
  out[out.length - 2] = { ...out[out.length - 2]!, close: out.at(-1)!.close };
  return out;
};

test("the recorded tapes: every chain the chart follows, and at least one whose last bar moved", () => {
  assert.ok(tapes.length >= 3, `${tapes.length} tapes`);
  for (const c of ["solana", "base", "robinhood"]) assert.ok(tapes.some((t) => t.tape.chain === c), `a ${c} tape`);
  for (const { name, tape } of tapes) {
    assert.ok(ready(tape.first, TF[tape.tf]!).own, `${name}: the first read is the helper's own bars (own_from_s)`);
    assert.ok(tape.polls.filter((p) => p.status === 200).length >= 90, `${name}: 90 live reads or more answered 200`);
  }
  assert.ok(tapes.some(({ tape }) => replay(tape, foldBars).moved > 0), "no tape's last bar moved");
});

for (const { name, tape } of tapes) {
  test(`replay ${name} (${tape.chain} ${tape.tf}): after every read the last bar is the read's newest, and the end is the helper's full read`, () => {
    const r = replay(tape, foldBars);
    assert.equal(r.marks, true, "a read's newest bar is the last bar drawn");
    assert.equal(r.end, true, "the folded bars equal the helper's full read at the end, over the bars the live reads covered");
  });
}

test("the helper rebuilt older bars during the Base and Robinhood tapes: why the follow reads in full every RESYNC_MS", () => {
  const rebuilt = tapes.filter(({ tape }) => !replay(tape, foldBars).older).map(({ name }) => name);
  assert.deepEqual(rebuilt.sort(), ["base-1m-2026-11-05.json", "robinhood-1m-2026-11-05.json"]);
  // the full read folds by the same rule: the end is the helper's full read over every bar
  for (const { tape } of tapes) {
    const tf = TF[tape.tf]!;
    let bars = ready(tape.first, tf).bars;
    for (const p of tape.polls) if (p.status === 200) bars = foldBars(bars, ready(p, tf).bars, tf)!;
    bars = foldBars(bars, ready(tape.last, tf).bars, tf)!;
    const want = ready(tape.last, tf).bars;
    assert.deepEqual(bars.filter((b) => b.timestamp >= want[0]!.timestamp), want);
  }
});

test("planted wrong folds fail the replay of a tape whose last bar moved", () => {
  const moving = tapes.filter(({ tape }) => replay(tape, foldBars).moved > 0);
  for (const { name, tape } of moving) {
    const a = replay(tape, appendOnly);
    assert.ok(!(a.marks && a.end), `${name}: the append-only fold passed`);
  }
  const rolled = moving.filter(({ tape }) => ready(tape.last, TF[tape.tf]!).bars.length >= 2);
  assert.ok(rolled.length > 0, "a moving tape with two bars or more");
  for (const { name, tape } of rolled) {
    const w = replay(tape, wrongBar);
    assert.ok(!(w.marks && w.end), `${name}: the wrong-bar fold passed`);
  }
});

// ---------------------------------------------------------------------------------------------- the fold, by case
const M = 60_000;
const bar = (t: number, close: number, volume = 1): Bar => ({ timestamp: t * M, open: 1, high: Math.max(1, close), low: Math.min(1, close), close, volume });

test("the fold: an update of the last bar, a new bar on the grid, the bar before it read again", () => {
  const bars = [bar(1, 1), bar(2, 1.1), bar(3, 1.2)];
  assert.deepEqual(foldBars(bars, [bar(2, 1.1), bar(3, 1.3, 2)], "1m"), [bar(1, 1), bar(2, 1.1), bar(3, 1.3, 2)]);
  assert.deepEqual(foldBars(bars, [bar(3, 1.25), bar(4, 1.4)], "1m"), [bar(1, 1), bar(2, 1.1), bar(3, 1.25), bar(4, 1.4)]);
  // a bar the helper no longer holds (a reorg took its swap) goes
  assert.deepEqual(foldBars(bars, [bar(2, 1.1), bar(4, 1.4)], "1m"), [bar(1, 1), bar(2, 1.1), bar(4, 1.4)]);
  // a gap in time is kept as the helper sends it (a bucket with no swap has no bar)
  assert.deepEqual(foldBars(bars, [bar(3, 1.2), bar(9, 2)], "1m"), [...bars, bar(9, 2)]);
});

test("the fold: nothing new returns the bars drawn themselves", () => {
  const bars = [bar(1, 1), bar(2, 1.1)];
  assert.equal(foldBars(bars, [], "1m"), bars);
  assert.equal(foldBars(bars, [bar(1, 1), bar(2, 1.1)], "1m"), bars);
  assert.equal(foldBars(bars, [bar(2, 1.1)], "1m"), bars);
});

test("the fold: a bar off the timeframe's grid refuses the whole read", () => {
  const bars = [bar(15, 1)];
  assert.equal(foldBars(bars, [{ ...bar(15, 1.1), timestamp: 15 * M + 1000 }], "1m"), null);
  assert.equal(foldBars(bars, [bar(16, 1.1)], "15m"), null, "a 1m bucket start is off the 15m grid");
  assert.deepEqual(foldBars(bars, [bar(30, 1.1)], "15m"), [bars[0], bar(30, 1.1)]);
});

test("a live read never spans more than one new bar: the full read comes within the shortest bar", () => {
  assert.equal(LIVE_LIMIT, 2);
  assert.ok(RESYNC_MS <= 60_000, "RESYNC_MS is at most the 1m bar");
});

// ------------------------------------------------------------------------------------------------ the follow loop
const HEAD = "https://api.confidential.unrealized.trade/v1/market/candles";
function clock() {
  let t = 1_000_000;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => t,
    later: (fn: () => void, ms: number) => {
      const d = { at: t + ms, fn, live: true };
      due.push(d);
      return () => {
        d.live = false;
      };
    },
    /** Runs the next timer, then lets its read settle. Returns the wait it was set for. */
    async tick(): Promise<number | null> {
      const live = due.filter((d) => d.live).sort((a, b) => a.at - b.at);
      const d = live[0];
      if (!d) return null;
      d.live = false;
      const waited = d.at - t;
      t = d.at;
      d.fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      return waited;
    },
  };
}
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const start: ReadyCandles = { status: "ready", tf: "1m", bars: [bar(1, 1), bar(2, 1.1)], gecko: false, precision: 4, own: true };
const own = (candles: unknown[]) => ({ tf: "1m", candles, src: "chain", own_from_s: 60, as_of_ms: 1 });
const row = (t: number, c: string) => [t * 60, "1", c > "1" ? c : "1", c < "1" ? c : "1", c, "1"];

test("the follow: one read of the newest bars a second, each folded and handed on only when it changed", async () => {
  const c = clock();
  const urls: string[] = [];
  const answers = [own([row(1, "1"), row(2, "1.1")]), own([row(2, "1.1"), row(3, "1.5")]), own([row(2, "1.1"), row(3, "1.6")])];
  const fetchFn = (async (u: string) => {
    urls.push(u);
    return answer(200, answers.shift());
  }) as typeof fetch;
  const got: ReadyCandles[] = [];
  const stop = followCandles("solana", "Mint1", start, (r) => got.push(r), { fetchFn, now: c.now, later: c.later, hidden: () => false });
  for (let i = 0; i < 3; i++) assert.equal(await c.tick(), LIVE_MS);
  assert.deepEqual(urls, Array(3).fill(`${HEAD}?chain=solana&token=Mint1&tf=1m&limit=${LIVE_LIMIT}`));
  assert.equal(got.length, 2, "the unchanged read is not handed on");
  assert.equal(got[0]!.bars.at(-1)!.close, 1.5);
  assert.equal(got[1]!.bars.at(-1)!.close, 1.6);
  assert.equal(got[1]!.bars.length, 3);
  stop();
  assert.equal(await c.tick(), null, "stopped: no read is set");
});

test("the follow: a 429 waits its Retry-After, a 503 or a bad answer doubles the wait, and the read back is a full one", async () => {
  const c = clock();
  const limits: string[] = [];
  const answers = [answer(429, { error: { code: "rate_limited" } }, { "Retry-After": "7" }), answer(503, { error: { code: "upstream" } }), answer(200, { tf: "15m", candles: [] }), answer(429, {}, { "Retry-After": "900" }), answer(200, own([row(2, "1.2")])), answer(200, own([row(2, "1.2")]))];
  const fetchFn = (async (u: string) => {
    limits.push(new URL(u).searchParams.get("limit")!);
    return answers.shift()!;
  }) as typeof fetch;
  const got: ReadyCandles[] = [];
  followCandles("base", "0xab", start, (r) => got.push(r), { fetchFn, now: c.now, later: c.later, hidden: () => false });
  const waits = [];
  for (let i = 0; i < 6; i++) waits.push(await c.tick());
  assert.deepEqual(waits, [LIVE_MS, 7_000, 4 * LIVE_MS, 8 * LIVE_MS, LIVE_BACKOFF_MAX_MS, LIVE_MS]);
  // every read after a failed one is a full read, until one is good
  assert.deepEqual(limits, ["2", "500", "500", "500", "500", "2"]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.bars.at(-1)!.close, 1.2);
});

test("the follow: a full read every RESYNC_MS, the live reads between", async () => {
  const c = clock();
  const limits: string[] = [];
  const fetchFn = (async (u: string) => {
    limits.push(new URL(u).searchParams.get("limit")!);
    return answer(200, own([row(2, "1.1")]));
  }) as typeof fetch;
  followCandles("solana", "Mint1", start, () => undefined, { fetchFn, now: c.now, later: c.later, hidden: () => false });
  for (let i = 0; i < 2 * (RESYNC_MS / LIVE_MS); i++) await c.tick();
  const full = limits.flatMap((l, i) => (l === String(CANDLES_LIMIT) ? [i + 1] : []));
  assert.deepEqual(full, [RESYNC_MS / LIVE_MS, (2 * RESYNC_MS) / LIVE_MS], "the 60th and 120th reads are full");
});

test("the follow: a page out of sight reads nothing, and its first read back is a full one", async () => {
  const c = clock();
  let hidden = true;
  const limits: string[] = [];
  const fetchFn = (async (u: string) => {
    limits.push(new URL(u).searchParams.get("limit")!);
    return answer(200, own([row(2, "1.1")]));
  }) as typeof fetch;
  followCandles("robinhood", "0xcd", start, () => undefined, { fetchFn, now: c.now, later: c.later, hidden: () => hidden });
  for (let i = 0; i < 300; i++) await c.tick();
  assert.deepEqual(limits, []);
  hidden = false;
  await c.tick();
  assert.deepEqual(limits, [String(CANDLES_LIMIT)], "301 s away: a full read");
});

test("the follow: an answer with none of the helper's own bars (a helper restarted, its book not read yet) waits RESYNC_MS, reads in full, and follows again once its own bars are back", async () => {
  const c = clock();
  const limits: string[] = [];
  const gecko = { tf: "1m", candles: [row(2, "1.3")], src: "chain,geckoterminal", as_of_ms: 1 };
  const answers = [answer(200, own([row(2, "1.2")])), answer(200, gecko, { "X-Helper-Source": "chain,geckoterminal" }), answer(200, own([row(2, "1.3"), row(3, "1.4")])), answer(200, own([row(3, "1.5")]))];
  const fetchFn = (async (u: string) => {
    limits.push(new URL(u).searchParams.get("limit")!);
    return answers.shift()!;
  }) as typeof fetch;
  const got: ReadyCandles[] = [];
  followCandles("solana", "Mint1", start, (r) => got.push(r), { fetchFn, now: c.now, later: c.later, hidden: () => false });
  const waits = [];
  for (let i = 0; i < 4; i++) waits.push(await c.tick());
  assert.deepEqual(waits, [LIVE_MS, LIVE_MS, RESYNC_MS, LIVE_MS], "no own bars: the next read a minute later");
  assert.deepEqual(limits, ["2", "2", String(CANDLES_LIMIT), "2"], "the read after the gap is a full one");
  assert.equal(got.at(-1)!.bars.at(-1)!.close, 1.5, "the bars after the gap are drawn");
  assert.equal(got.at(-1)!.bars.length, 3);
  assert.equal(got[1]!.gecko, true, "CoinGecko's label once a drawn bar is theirs");
  assert.notEqual(await c.tick(), null, "still following");
});

test("the follow: a throw is a failed read, never an error out of the loop", async () => {
  const c = clock();
  const fetchFn = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  followCandles("solana", "Mint1", start, () => assert.fail("no bars"), { fetchFn, now: c.now, later: c.later, hidden: () => false });
  assert.equal(await c.tick(), LIVE_MS);
  assert.equal(await c.tick(), 2 * LIVE_MS);
});
