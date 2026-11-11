// node --test apps/helper/src/data/evm/swaps-wanted.test.ts: card evm-chart-opens-without-a-vendor-call. The history a
// page asks for before our first bar takes the next free GeckoTerminal call ahead of the lists' reads that are not
// urgent and ahead of the "ahead" lane (../gecko.ts WANTED_LANE, createWanted), and every page is answered at once from
// our own bars, never a 429. Ten cold Base tokens opened in one minute, one every 6 s, on a planted clock: the wait for
// each one's history is measured from its open to its GeckoTerminal call, which the planted vendor answers at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, KNOWN, open, POOL_ICNT, REC, timeMsOf } from "../../../test/evm-swaps/base.ts";
import { geckoBudget, WANTED_LANE, WINDOW_MS } from "../gecko.ts";

const T0 = timeMsOf(REC.lastHead) + 2_000;
const N = 10;
const EVERY_MS = 6_000;
const tokens = Array.from({ length: N }, (_, i) => `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`);
const pools = tokens.map((_, i) => `0x${(0xa1 + i).toString(16).repeat(20)}`);

test("ten cold tokens opened in one minute: each is answered 200 from our own bars at once, and its history is read in the order asked, ahead of the lists' reads that are not urgent", async () => {
  const chain = fakeChain();
  // a head inside the recorded hour: each book's cold read holds the recorded pool's swaps, bars of ours
  chain.st.head = REC.lastHead - 40;
  const clock = { t: T0 };
  const due: { at: number; fn: () => void }[] = [];
  const later = (fn: () => void, ms: number) => void due.push({ at: clock.t + ms, fn });
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((ok) => setImmediate(ok));
  };
  const runTo = async (t: number) => {
    for (;;) {
      due.sort((a, b) => a.at - b.at);
      if (due.length === 0 || due[0]!.at > t) break;
      const d = due.shift()!;
      clock.t = d.at;
      d.fn();
      await settle();
    }
    clock.t = t;
  };
  // every planted pool answers as ICNT's recorded pool, under its own address
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.includes("geckoterminal")) {
      const pool = /\/pools\/(0x[0-9a-f]{40})\//.exec(url)?.[1];
      gtAt.set(pool!, clock.t);
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[Math.floor(T0 / 1000 / 900) * 900 - 86_400, 1, 1, 1, 1, 1]] } } }), { status: 200 });
    }
    const body = String(init.body);
    const i = pools.findIndex((p) => body.includes(p));
    if (i === -1) return chain.fetch(url, init);
    const r = await chain.fetch(url, { ...init, body: body.split(pools[i]!).join(POOL_ICNT.id) });
    return new Response((await r.text()).split(POOL_ICNT.id).join(pools[i]!), { status: r.status, headers: r.headers });
  }) as typeof chain.fetch;
  const gtAt = new Map<string, number>();
  const budget = geckoBudget(() => clock.t);
  const known = new Map(KNOWN);
  tokens.forEach((t, i) => known.set(t, { pool: { ...POOL_ICNT, id: pools[i]!, token: t }, decimals: 18 }));
  const s = open(chain, clock, { fetch, gecko: budget, pools: known, sleep: async () => undefined, later });
  const opened: number[] = [];
  const lists: { at: number; took: boolean }[] = [];
  for (let i = 0; i < N; i++) {
    await runTo(T0 + i * EVERY_MS);
    opened.push(clock.t);
    const a = await s.candles(tokens[i]!, "15m", null, 500);
    assert.equal(a.status, 200, `token ${i}: ${a.body}`);
    assert.equal(a.src, JSON.parse(a.body).src);
    assert.ok(JSON.parse(a.body).own_from_s > 0, `token ${i} has bars of ours`);
    // the lists' tick asks a call that is not urgent every 10 s, as lists.ts does
    if (i % 2 === 1) lists.push({ at: clock.t, took: budget.take("lists", false, false, "base lists") });
  }
  await runTo(T0 + 5 * WINDOW_MS);
  s.stop();
  const waits = pools.map((p, i) => {
    assert.ok(gtAt.has(p), `token ${i}'s history was read`);
    return gtAt.get(p)! - opened[i]!;
  });
  const order = [...pools].sort((a, b) => gtAt.get(a)! - gtAt.get(b)!);
  assert.deepEqual(order, pools, "history read in the order the pages asked");
  const sorted = [...waits].sort((a, b) => a - b);
  const median = (sorted[N / 2 - 1]! + sorted[N / 2]!) / 2;
  console.log(`history wait, ten cold tokens opened one every ${EVERY_MS / 1000} s: first ${waits[0]! / 1000} s, median ${median / 1000} s, last ${waits[N - 1]! / 1000} s, max ${sorted[N - 1]! / 1000} s; each ${waits.map((w) => w / 1000).join(", ")}`);
  // five calls in any 75 s, the last left to a page with nothing to serve (STALE_RESERVE): the first four at once,
  // each later one when a call leaves the window
  assert.deepEqual(waits.slice(0, 4), [0, 0, 0, 0]);
  assert.ok(sorted[N - 1]! <= 2 * WINDOW_MS, `none waits past two windows: ${sorted[N - 1]}`);
  // while history waited, the lists' reads that are not urgent took no call
  const backlog = lists.filter((l) => l.at >= T0 + 5 * EVERY_MS);
  assert.ok(backlog.length > 0 && backlog.every((l) => !l.took), JSON.stringify(lists));
});

test("the budget with a read queued: the lists' reads that are not urgent and the ahead lane are refused, an urgent list read inside its floor and the queue's own lane are not", () => {
  const clock = { t: 1_000_000 };
  const b = geckoBudget(() => clock.t);
  b.wanting("base bars", 1);
  assert.equal(b.take("lists", false), false, "a list read that is not urgent waits for the queue");
  assert.equal(b.take("ahead"), false, "ahead waits for the queue");
  assert.equal(b.take(WANTED_LANE), true, "the queue's read");
  assert.equal(b.take("lists", true), true, "an urgent list read within LIST_FLOOR");
  b.wanting("base bars", 0);
  clock.t += 61_000 + WINDOW_MS;
  assert.equal(b.take("lists", false), true, "with the queue empty, the lists as before");
});

test("a cold page waiting its turn comes before the queue", () => {
  const clock = { t: 1_000_000 };
  const b = geckoBudget(() => clock.t);
  b.wanting("base bars", 1);
  const ticket = b.queue("caller");
  assert.equal(b.take(WANTED_LANE), false, "the queue waits while a cold page read waits");
  assert.equal(b.take("pages", false, false, "", { ticket, client: "caller" }), true);
  b.leave(ticket);
  assert.equal(b.take(WANTED_LANE), true);
});
