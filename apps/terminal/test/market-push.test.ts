// The token page's tape and last bar move from the helper's push socket (card market-data-push): followTape takes each
// pushed tape whole, reads the trades route while the socket is down and opens it again, drops a socket that sends what
// is not a tape, and never lets an older read land over a pushed tape; followCandles reads its newest bars at once on a
// wake (a pushed tape) and keeps its own timer, so a dropped socket never stops the chart (card app-chart-live-stall).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AWAY_MS, LIVE_MS, followCandles } from "../src/screens/token/candles.ts";
import type { ReadyCandles } from "../src/screens/token/candles.ts";
import { followTape, groupMarks, nextWait, PUSH_URL, TRADES_POLL_MS, TRADES_PUSHED_POLL_MS } from "../src/screens/token/trades.ts";
import type { PushSocket, Tape, Trade } from "../src/screens/token/trades.ts";

function clock() {
  let t = 1_000_000;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    now: () => t,
    later: (fn: () => void, ms: number) => {
      const d = { at: t + ms, fn, live: true };
      due.push(d);
      return () => {
        d.live = false;
      };
    },
    settle,
    /** Runs the next timer and lets its read settle; the wait it was set for, or null when none is set. */
    async tick(): Promise<number | null> {
      const d = due.filter((x) => x.live).sort((a, b) => a.at - b.at)[0];
      if (!d) return null;
      d.live = false;
      const waited = d.at - t;
      t = d.at;
      d.fn();
      await settle();
      return waited;
    },
    /** The waits of every timer set and not yet run, soonest first. */
    pending: () => due.filter((x) => x.live).map((x) => x.at - t).sort((a, b) => a - b),
  };
}

class FakeSocket implements PushSocket {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close(): void {
    this.closed = true;
  }
  send(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const trade = (tx: string, t_ms: number, usd = "10"): Trade => ({ t_ms, side: "buy", usd, amt: "1000", trader: "Trader111", tx });
const body = (trades: Trade[]) => JSON.stringify({ trades, src: "chain", as_of_ms: 1 });
const answer = (status: number, text: string) => new Response(text, { status, headers: { "content-type": "application/json" } });

function rig(fetchFn: typeof fetch) {
  const c = clock();
  const sockets: FakeSocket[] = [];
  const tapes: Tape[] = [];
  const stop = followTape("solana", "Mint1", (t) => tapes.push(t), {
    fetchFn,
    later: c.later,
    hidden: () => false,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { c, sockets, tapes, stop };
}

test("the socket is the helper's push path for the token, on wss", () => {
  assert.equal(PUSH_URL("solana", "Mint1"), "wss://ct-api.unrealized.trade/v1/market/push?chain=solana&token=Mint1");
  assert.equal(PUSH_URL("base", "0xAb&x=1"), "wss://ct-api.unrealized.trade/v1/market/push?chain=base&token=0xAb%26x%3D1");
});

test("a pushed tape is drawn at once and replaces the tape whole: a trade in two tapes is drawn once", async () => {
  const a = trade("tx-a", 60_000);
  const b = trade("tx-b", 61_000);
  let reads = 0;
  const { c, sockets, tapes, stop } = rig((async () => (reads++, answer(200, body([a])))) as typeof fetch);
  await c.settle();
  assert.equal(reads, 1, "the tape is read on mount");
  assert.deepEqual(tapes.at(-1), { trades: [a], status: "ready" });
  assert.equal(sockets.length, 1);
  sockets[0]!.send(body([b, a]));
  assert.deepEqual(tapes.at(-1)!.trades.map((t) => t.tx), ["tx-b", "tx-a"], "the pushed tape is the tape");
  sockets[0]!.send(body([b, a]));
  assert.equal(tapes.length, 2, "a tape equal to the one drawn is not handed on");
  // the marks are grouped from the one tape: tx-a counted once, beside tx-b
  const bars = [{ timestamp: 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  const marks = groupMarks(tapes.at(-1)!.trades, bars, "1m");
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.n, 2, "two trades, each once");
  assert.equal(marks[0]!.usd, 20);
  // while the socket sends, the route is read only TRADES_PUSHED_POLL_MS after the last tape
  assert.deepEqual(c.pending(), [TRADES_PUSHED_POLL_MS]);
  stop();
  assert.equal(sockets[0]!.closed, true, "the stop closes the socket");
  assert.equal(await c.tick(), null, "stopped: nothing is set");
});

test("a read still out when a tape is pushed is dropped: an older answer never lands over the pushed tape", async () => {
  let release: (r: Response) => void = () => undefined;
  const { c, sockets, tapes, stop } = rig((async (_u: string, init?: RequestInit) => {
    const r = await new Promise<Response>((ok) => (release = ok));
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return r;
  }) as typeof fetch);
  await c.settle();
  sockets[0]!.send(body([trade("tx-new", 2)]));
  release(answer(200, body([trade("tx-old", 1)])));
  await c.settle();
  assert.deepEqual(
    tapes.map((t) => t.trades.map((x) => x.tx)),
    [["tx-new"]],
    "only the pushed tape is drawn",
  );
  stop();
});

test("a dropped socket: the tape is read at once, then every TRADES_POLL_MS, and the socket opened again after nextWait", async () => {
  let n = 0;
  const { c, sockets, tapes, stop } = rig((async () => answer(200, body([trade(`tx-${++n}`, n)]))) as typeof fetch);
  await c.settle();
  sockets[0]!.send(body([trade("tx-p", 9)]));
  assert.equal(n, 1);
  sockets[0]!.onclose!();
  await c.settle();
  assert.equal(n, 2, "read at once when the socket drops");
  assert.deepEqual(tapes.at(-1)!.trades.map((t) => t.tx), ["tx-2"]);
  assert.deepEqual(c.pending(), [nextWait(0), TRADES_POLL_MS].sort((a, b) => a - b));
  await c.tick(); // the socket opened again and the next read, both at TRADES_POLL_MS
  await c.tick();
  assert.equal(sockets.length, 2, "opened again");
  assert.equal(n, 3, "the route read again while it has sent nothing");
  // it drops again before any tape: the next opening waits twice as long
  const s1 = sockets[1]!;
  const onclose = s1.onclose!;
  s1.onerror!();
  onclose(); // a browser fires both: one drop
  await c.settle();
  assert.equal(c.pending().filter((w) => w === nextWait(1)).length, 1, `one opening set, nextWait(1) away: ${c.pending()}`);
  assert.equal(sockets[1]!.closed, true);
  stop();
});

test("a message that is not a tape drops the socket and the route is read: over the size, not text, not JSON, a bad row, too many rows", async () => {
  const bad: unknown[] = [
    `{"trades":[],"pad":"${"x".repeat(1_000_001)}"}`,
    new Uint8Array([123, 125]),
    "<html>",
    JSON.stringify({ trades: [{ t_ms: "soon", side: "buy", usd: "1", amt: "1", trader: null, tx: "x" }] }),
    JSON.stringify({ trades: Array.from({ length: 51 }, (_, i) => trade(`t${i}`, i)) }),
    JSON.stringify({ trades: [{ ...trade("x", 1), usd: "-1" }] }),
  ];
  for (const m of bad) {
    let reads = 0;
    const { c, sockets, tapes, stop } = rig((async () => (reads++, answer(200, body([trade("tx-r", 1)])))) as typeof fetch);
    await c.settle();
    sockets[0]!.send(m);
    await c.settle();
    assert.equal(sockets[0]!.closed, true, `dropped on ${String(m).slice(0, 40)}`);
    assert.equal(reads, 2, "the route read at once");
    assert.ok(tapes.every((t) => t.trades.every((x) => x.tx === "tx-r")), "nothing of the message is drawn");
    stop();
  }
});

test("a socket left open and silent never holds the tape: the route is read TRADES_PUSHED_POLL_MS after the last tape", async () => {
  let n = 0;
  const { c, sockets, tapes, stop } = rig((async () => answer(200, body([trade(`tx-${++n}`, n)]))) as typeof fetch);
  await c.settle();
  sockets[0]!.send(body([trade("tx-p", 5)]));
  assert.equal(await c.tick(), TRADES_PUSHED_POLL_MS);
  assert.equal(n, 2);
  assert.deepEqual(tapes.at(-1)!.trades.map((t) => t.tx), ["tx-2"]);
  assert.deepEqual(c.pending(), [TRADES_PUSHED_POLL_MS], "still sending: the next read as long after");
  stop();
});

test("no WebSocket in the runtime: the tape is read every TRADES_POLL_MS as before; a failed read is none and backs off", async () => {
  const c = clock();
  const tapes: Tape[] = [];
  const answers = [answer(200, body([trade("a", 1)])), answer(503, "{}"), answer(200, body([trade("b", 2)]))];
  followTape("base", "0xab", (t) => tapes.push(t), { fetchFn: (async () => answers.shift()!) as typeof fetch, later: c.later, hidden: () => false, socket: null });
  await c.settle();
  assert.equal(await c.tick(), TRADES_POLL_MS);
  assert.equal(tapes.at(-1)!.status, "none");
  assert.equal(await c.tick(), nextWait(1));
  assert.deepEqual(tapes.map((t) => t.status), ["ready", "none", "ready"]);
});

// ------------------------------------------------------------------------------------------------ the chart's wake
const own = (candles: unknown[]) => ({ tf: "1m", candles, src: "chain", own_from_s: 60, as_of_ms: 1 });
const row = (t: number, c: string) => [t * 60, "1", c > "1" ? c : "1", c < "1" ? c : "1", c, "1"];
const bar = (t: number, c: number) => ({ timestamp: t * 60_000, open: 1, high: Math.max(1, c), low: Math.min(1, c), close: c, volume: 1 });
const start: ReadyCandles = { status: "ready", tf: "1m", bars: [bar(1, 1), bar(2, 1.1)], gecko: false, precision: 4, own: true };

function wakeRig(answers: () => Response, ready: ReadyCandles = start) {
  const c = clock();
  let wake: (() => void) | null = null;
  let reads = 0;
  const got: ReadyCandles[] = [];
  const stop = followCandles("solana", "Mint1", ready, (r) => got.push(r), {
    fetchFn: (async () => (reads++, answers())) as typeof fetch,
    now: c.now,
    later: c.later,
    hidden: () => false,
    wake: (fn) => {
      wake = fn;
      return () => (wake = null);
    },
  });
  return { c, got, stop, wake: () => wake?.(), has: () => wake !== null, reads: () => reads };
}

test("a wake (a pushed tape) reads the newest bars at once and moves the last bar; the timer goes on after it", async () => {
  const w = wakeRig(() => answer(200, JSON.stringify(own([row(2, "1.1"), row(3, "1.7")]))));
  assert.deepEqual(w.c.pending(), [LIVE_MS]);
  w.wake();
  await w.c.settle();
  assert.equal(w.reads(), 1, "read at once");
  assert.equal(w.got.at(-1)!.bars.at(-1)!.close, 1.7, "the last bar moved");
  assert.deepEqual(w.c.pending(), [LIVE_MS], "the timer set again, one only");
  w.stop();
  assert.equal(w.has(), false, "the stop removes the wake");
});

test("a wake while a read is out is one read right after it; a dropped socket (no wake) leaves the chart read every LIVE_MS", async () => {
  let release: (r: Response) => void = () => undefined;
  const c = clock();
  let wake: () => void = () => undefined;
  let reads = 0;
  followCandles("solana", "Mint1", start, () => undefined, {
    fetchFn: (async () => (reads++, new Promise<Response>((ok) => (release = ok)))) as typeof fetch,
    now: c.now,
    later: c.later,
    hidden: () => false,
    wake: (fn) => ((wake = fn), () => undefined),
  });
  wake();
  await c.settle();
  wake();
  wake();
  assert.equal(reads, 1, "one read at a time");
  release(answer(200, JSON.stringify(own([row(2, "1.1")]))));
  await c.settle();
  assert.deepEqual(c.pending(), [0], "the wake's read right after");
  await c.tick();
  release(answer(200, JSON.stringify(own([row(2, "1.1")]))));
  await c.settle();
  assert.equal(reads, 2);
  // no more wakes: the timer alone, every LIVE_MS
  for (let i = 0; i < 3; i++) {
    assert.equal(await c.tick(), LIVE_MS);
    release(answer(200, JSON.stringify(own([row(2, "1.1")]))));
    await c.settle();
  }
  assert.equal(reads, 5);
});

test("a wake changes nothing while the chart waits AWAY_MS or backs off after a failed read", async () => {
  const away = wakeRig(() => answer(200, JSON.stringify(own([row(2, "1.1")]))), { ...start, own: false });
  assert.deepEqual(away.c.pending(), [AWAY_MS]);
  away.wake();
  await away.c.settle();
  assert.equal(away.reads(), 0, "away: no read on a wake");
  away.stop();
  const failing = wakeRig(() => answer(503, "{}"));
  await failing.c.tick();
  assert.equal(failing.reads(), 1);
  failing.wake();
  await failing.c.settle();
  assert.equal(failing.reads(), 1, "backing off: no read on a wake");
  assert.deepEqual(failing.c.pending(), [2 * LIVE_MS]);
  failing.stop();
});
