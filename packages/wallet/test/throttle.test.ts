// node --test packages/wallet/test/throttle.test.ts (card signpage-throttled-read-is-not-asked-again-at-once): a
// provider that answers 429 is not asked again at once. The rule (src/throttle.ts) and the holdings readers' gate
// (src/pool/buy-wallets.ts), on both transports the page reads holdings on: the helper's keyed route (mainnet) and the
// devnet RPC reached directly (the testnet build, solanaHoldingsAt). Every provider is a fake on the kit's test clock,
// so no test waits in real time; time is judged by timers on that clock, never by a difference of clock reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaJsonRpc, solanaPacedRpc } from "@blindfill/kit";
import { SOLANA_KEYLESS_RPC_LIMIT } from "../../kit/src/trade/solana/send.ts";
import { onTestClock } from "../../kit/test/test-clock.ts";
import * as d from "../src/derive/index.ts";
import { HOST_WINDOW_MS, HostLane, HostPaused, PROBE_HELD_MAX_MS, THROTTLE_QUIET_MS, holdHosts, hostLane, PASS_BUDGET, PASS_BUDGET_TRADING, PASS_FLOOR_MS, resetHostLanes, stopHostLaneWaits, THROTTLE_BOUNDS, THROTTLE_PAUSE_FIRST_MS, THROTTLE_PAUSE_MAX_MS, THROTTLE_RETRY_AFTER_MAX_MS, ThrottleGate, throttleWaitMs, TRADE_HOLD_MAX_MS, TRADE_TURN_MAX_MS } from "../src/throttle.ts";
import { buyWallets, evmHoldingsReader, HOLDINGS_THROTTLE_MAX_MS, HOLDINGS_THROTTLED_ROUNDS_60S, solanaHelperHoldings, solanaHoldingsAt, solanaHoldingsReader, type HoldingsReader } from "../src/pool/buy-wallets.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const L = 5n;
const spent = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: i === 0 ? { kind: "deposit" as const, s: 1n, i: 0 } : { kind: "change" as const, l: L, j: i - 1 }, label: L }));

test("the rule: a pause doubling from the first to the cap; a Retry-After the wait when longer, finite and above 0, capped", () => {
  assert.deepEqual([THROTTLE_PAUSE_FIRST_MS, THROTTLE_PAUSE_MAX_MS, THROTTLE_RETRY_AFTER_MAX_MS], [1_000, 10_000, 10_000]);
  const seq: number[] = [];
  for (let p = 0, k = 0; k < 7; k++) seq.push((p = throttleWaitMs(p, null)));
  assert.deepEqual(seq, [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  assert.equal(throttleWaitMs(0, 7_000), 7_000, "a Retry-After past the pause");
  assert.equal(throttleWaitMs(4_000, 3_000), 8_000, "a Retry-After under the pause: the pause");
  assert.equal(throttleWaitMs(0, 300_000), 10_000, "a Retry-After past the cap: the cap");
  for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "7", undefined, null]) assert.equal(throttleWaitMs(0, v), 1_000, `${String(v)} is never the wait`);
  for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -1]) assert.equal(throttleWaitMs(v, null), 1_000, `a previous pause of ${v} starts again`);
  // another loop's own bounds (the buy's read-back pace after PR #604 takes the same rule)
  assert.equal(throttleWaitMs(400, null, { firstMs: 400, maxMs: 8_000, afterMaxMs: 10_000 }), 800);
  assert.equal(THROTTLE_BOUNDS.maxMs, THROTTLE_PAUSE_MAX_MS);
});

test("the gate: one round's throttles count once, an answer never sets the pause back while the provider is in its quiet time, a late Retry-After only moves the time on", () => {
  let now = 0;
  const g = new ThrottleGate({ now: () => now });
  assert.equal(g.left(), 0);
  // a round of three, all 429
  const e0 = g.epoch();
  g.throttled(e0, null), g.throttled(e0, null), g.throttled(e0, null);
  assert.equal(g.left(), 1_000, "three 429s of one round: one pause");
  now = 1_000;
  const e1 = g.epoch();
  g.throttled(e1, null);
  assert.equal(g.left(), 2_000, "the next round's: doubled");
  // a call of the counted round answers late with a longer Retry-After: the time moves, the pause does not grow
  g.throttled(e0, 5_000);
  assert.equal(g.left(), 5_000);
  // card signpage-throttled-provider-has-a-spare (run 9 of 11 Nov: two 200s put the pause back to 1 s, and the next
  // round met 429 at once): an answer ends the doubt, the pause is kept for the next throttle inside the quiet time
  now = 6_000;
  const e2 = g.epoch();
  assert.equal(g.suspect(), true);
  g.answered(e2);
  assert.equal(g.suspect(), false, "an answer sent after the last throttle ends the doubt");
  g.throttled(g.epoch(), null);
  assert.equal(g.left(), 4_000, "1 s after the pause's end, inside the quiet time: the last pause doubled, never 1 s again");
  // an answer from before the last counted throttle ends nothing
  now = 11_000;
  const e3 = g.epoch();
  g.throttled(e3, null);
  g.answered(e3);
  assert.equal(g.suspect(), true, "a stale answer leaves the doubt");
  assert.equal(g.left(), 8_000);
  // the provider open THROTTLE_QUIET_MS with no throttle: its last pause forgotten
  now = 19_000 + THROTTLE_QUIET_MS;
  g.throttled(g.epoch(), null);
  assert.equal(g.left(), 1_000, "after the quiet time, the first pause again");
});

test("HOLDINGS_THROTTLED_ROUNDS_60S is the rule's count: rounds whose start falls in the first 60 s of 429s", () => {
  let at = 0, pause = 0, rounds = 0;
  while (at < 60_000) {
    rounds++;
    at += pause = throttleWaitMs(pause, null);
  }
  assert.equal(HOLDINGS_THROTTLED_ROUNDS_60S, rounds);
  assert.equal(HOLDINGS_THROTTLED_ROUNDS_60S, 9);
  assert.equal(HOLDINGS_THROTTLE_MAX_MS, 30_000);
});

// ---------- a fake provider on the test clock ----------
type Fake = { calls: { method: string; throttled: boolean }[]; restore: () => void };
/** globalThis.fetch for `origin`: a 429 (Retry-After `after` when given) while throttling() holds, else a Solana answer
 *  at slot 1 (no lamports, no accounts); every call kept with whether it was throttled. */
function fakeSolana(origin: string, throttling: () => boolean, after?: string): Fake {
  const real = globalThis.fetch, calls: Fake["calls"] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (!String(u).startsWith(origin)) return real(u, init);
    const q = JSON.parse(String(init?.body)) as { id: string; method: string };
    const t = throttling();
    calls.push({ method: q.method, throttled: t });
    if (t) return new Response("slow down", { status: 429, headers: after === undefined ? {} : { "retry-after": after } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { context: { slot: 1 }, value: q.method === "getBalance" ? 0 : [] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
/** A flag that turns true `ms` from now on the clock. */
const after = (ms: number): (() => boolean) => {
  let past = false;
  setTimeout(() => (past = true), ms);
  return () => past;
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A positions pass's loop as positions.ts runs it: a list read, again 5 s after each failed one, and again at once
 *  each time a buy ends (`kicks`: the times buys end), until a read succeeds or `until` passes. Each pass builds its
 *  reader anew, as the page does (pool-testnet.ts finderOf), so the gate it meets is the route's, not the reader's. */
async function passes(make: () => HoldingsReader, untilMs: number, kicks: readonly number[] = []): Promise<number> {
  const over = after(untilMs);
  let reads = 0;
  const kicked: (() => boolean)[] = kicks.map((k) => after(k));
  let used = 0;
  for (;;) {
    reads++;
    const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: make() }]);
    if (r.failed.length === 0 || over()) return reads;
    // a buy that ended meanwhile runs the pass again at once (positions.refresh), else the 5 s retry
    const fresh = kicked.filter((k) => k()).length;
    if (fresh > used) used = fresh;
    else await wait(5_000);
  }
}

for (const [name, make] of [
  ["the helper's keyed route (mainnet)", (o: string) => solanaHelperHoldings(o)],
  ["the devnet RPC on the holdings transport (testnet)", (o: string) => solanaHoldingsAt(`${o}/`)],
] as const) {
  test(`${name}: under 60 s of 429s a pass run again asks at most HOLDINGS_THROTTLED_ROUNDS_60S rounds, and reads once the provider answers`, async () => {
    const origin = `https://t60-${name.length}.example`;
    await onTestClock(async () => {
      const quiet = after(60_000);
      const f = fakeSolana(origin, () => !quiet());
      try {
        await passes(() => make(origin), 300_000);
      } finally {
        f.restore();
      }
      const hot = f.calls.filter((c) => c.throttled);
      assert.ok(hot.length <= 3 * HOLDINGS_THROTTLED_ROUNDS_60S, `${hot.length} calls under 60 s of 429s, bound ${3 * HOLDINGS_THROTTLED_ROUNDS_60S}`);
      assert.ok(hot.filter((c) => c.method === "getTokenAccountsByOwner").length <= 2 * HOLDINGS_THROTTLED_ROUNDS_60S);
      assert.ok(hot.length >= 3 * 5, `the route is still asked while it throttles: ${hot.length}`);
      assert.equal(f.calls.filter((c) => !c.throttled).length, 3, "one round once it answers");
      // the request list: the three calls of a round, nothing else
      assert.deepEqual([...new Set(f.calls.map((c) => c.method))].sort(), ["getBalance", "getTokenAccountsByOwner"]);
    });
  });
}

test("a run of buys ending during a throttle (each running the pass again at once) does not multiply the calls past the bound", async () => {
  const origin = "https://kicks.example";
  await onTestClock(async () => {
    const quiet = after(60_000);
    const f = fakeSolana(origin, () => !quiet());
    try {
      await passes(() => solanaHelperHoldings(origin), 300_000, [2_000, 4_000, 6_000, 8_000, 10_000, 20_000, 30_000, 40_000, 50_000]);
    } finally {
      f.restore();
    }
    const hot = f.calls.filter((c) => c.throttled).length;
    assert.ok(hot <= 3 * HOLDINGS_THROTTLED_ROUNDS_60S, `${hot} calls under 60 s of 429s with nine buys ending`);
  });
});

test("a provider that throttles one method and answers the others: the pause still grows, round after round", async () => {
  // Solana's public RPC limits each method: getBalance answers while getTokenAccountsByOwner draws 429s, so one call's
  // answer never sets the pause back; only a whole round does
  const origin = "https://one-method.example";
  await onTestClock(async () => {
    const quiet = after(60_000);
    const real = globalThis.fetch, hot: string[] = [];
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      if (!String(u).startsWith(origin)) return real(u, init);
      const q = JSON.parse(String(init?.body)) as { id: string; method: string };
      if (q.method === "getTokenAccountsByOwner" && !quiet()) return hot.push(q.method), new Response("slow down", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { context: { slot: 1 }, value: q.method === "getBalance" ? 0 : [] } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await passes(() => solanaHoldingsAt(`${origin}/`), 300_000);
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(hot.length <= 2 * HOLDINGS_THROTTLED_ROUNDS_60S, `${hot.length} getTokenAccountsByOwner 429s in 60 s, bound ${2 * HOLDINGS_THROTTLED_ROUNDS_60S}`);
  });
});

test("a Retry-After is waited out: the next round of the route goes after it, not before", async () => {
  const origin = "https://ra7.example";
  await onTestClock(async () => {
    const early = after(6_900), late = after(7_100);
    let n = 0;
    const seen: [boolean, boolean][] = [];
    const f = fakeSolana(origin, () => (seen.push([early(), late()]), ++n <= 3), "7");
    try {
      const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHoldingsAt(`${origin}/`) }]);
      assert.deepEqual(r.failed, []);
    } finally {
      f.restore();
    }
    assert.equal(f.calls.length, 6);
    assert.deepEqual(seen.slice(3), [[true, false], [true, false], [true, false]], "the second round at 7 s");
  });
});

test("a sell's read during a throttle that ends inside its bound waits and reads; one that outlasts it is refused at the bound, asking nothing more", async () => {
  await onTestClock(async () => {
    // the route throttled for 25 s: the sell's list read (two Ws) from its tap reads both
    const quiet = after(25_000);
    const f = fakeSolana("https://sell-25.example", () => !quiet());
    try {
      const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(2), reader: solanaHelperHoldings("https://sell-25.example") }]);
      assert.deepEqual(r.failed, []);
      assert.equal(r.wallets.length, 2);
    } finally {
      f.restore();
    }
  });
  await onTestClock(async () => {
    // throttled for good: refused once its next wait would end past HOLDINGS_THROTTLE_MAX_MS from the tap
    const bound = after(HOLDINGS_THROTTLE_MAX_MS);
    let pastBound = 0;
    const f = fakeSolana("https://sell-hot.example", () => (bound() && pastBound++, true));
    try {
      const r = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(2), reader: solanaHelperHoldings("https://sell-hot.example") }]);
      assert.equal(r.failed.length, 1);
      assert.match(r.failed[0]!.error, /its reads drew the provider's 429 past 30 s$/);
      assert.equal(pastBound, 0, "no call after the bound");
    } finally {
      f.restore();
    }
  });
});

test("the gate is the holdings route's own: a throttled route never holds back the trade path's read on the same URL", async () => {
  const origin = "https://own-gate.example";
  await onTestClock(async () => {
    const f = fakeSolana(origin, () => true);
    const trade = solanaPacedRpc(solanaJsonRpc(`${origin}/`), { windowMs: 10_000, total: 100, perMethod: 40 });
    try {
      const reader = solanaHoldingsAt(`${origin}/`);
      const read = buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader }]);
      await wait(100); // the first round drew its 429s: the route's gate is closed for 1 s
      const before = f.calls.length;
      const ahead = after(500);
      const got = await trade("getBalance", ["x", { commitment: "finalized" }]).then(() => "answered", (e: unknown) => String(e));
      assert.match(got, /HTTP 429/);
      assert.equal(ahead(), false, "the trade path's read went out at once");
      assert.equal(f.calls.length, before + 1);
      await read;
    } finally {
      f.restore();
    }
  });
});

// ---------- the review of 8522bdf8 ----------

// F1: two or three list reads at once on one route ask it no faster than one (one round of the route at a time)
for (const k of [2, 3]) {
  test(`${k} list reads at once on one route, the provider always 429 for 60 s: at most HOLDINGS_THROTTLED_ROUNDS_60S rounds`, async () => {
    const origin = `https://k${k}.example`;
    await onTestClock(async () => {
      const quiet = after(60_000);
      const f = fakeSolana(origin, () => !quiet());
      try {
        await Promise.all(Array.from({ length: k }, () => passes(() => solanaHelperHoldings(origin), 300_000)));
      } finally {
        f.restore();
      }
      const hot = f.calls.filter((c) => c.throttled).length;
      assert.ok(hot <= 3 * HOLDINGS_THROTTLED_ROUNDS_60S, `${hot / 3} rounds under 60 s of 429s with ${k} reads at once, bound ${HOLDINGS_THROTTLED_ROUNDS_60S}`);
    });
  });
}

test("three single reads at 0, 0 and 2 s on a route that throttles for good: no more rounds in 30 s than one read meets", async () => {
  const origin = "https://three.example";
  await onTestClock(async () => {
    const f = fakeSolana(origin, () => true);
    const one = () => buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHelperHoldings(origin) }]);
    try {
      await Promise.all([one(), one(), wait(2_000).then(one)]);
    } finally {
      f.restore();
    }
    // the gate's rounds in 30 s: at 0, 1, 3, 7, 15 and 25 s
    assert.ok(f.calls.length <= 3 * 6, `${f.calls.length / 3} rounds in 30 s, bound 6`);
  });
});

test("the route's turn is given back when a round throws and when a read is stopped: no reader waits for good", async () => {
  await onTestClock(async () => {
    // a round that fails with a 500 (not a throttle) ends its read; the next read on the route then reads
    let first = true;
    const f = fakeSolana("https://turn-500.example", () => false);
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      if (String(u).startsWith("https://turn-500.example") && first) return (first = false), new Response("down", { status: 500 });
      return real(u, init);
    }) as typeof fetch;
    try {
      const a = buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHelperHoldings("https://turn-500.example") }]);
      const b = buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHelperHoldings("https://turn-500.example") }]);
      assert.equal((await a).failed.length, 1, "the round's 500 fails the read");
      assert.deepEqual((await b).failed, [], "the next read had its turn");
    } finally {
      globalThis.fetch = real;
      f.restore();
    }
  });
  await onTestClock(async () => {
    // a read stopped while it waits the gate in its turn, and one stopped while it waits for the turn: the next reads
    const quiet = after(1_500);
    const f = fakeSolana("https://turn-stop.example", () => !quiet());
    const read = (signal?: AbortSignal) => buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHelperHoldings("https://turn-stop.example") }], signal ? { signal } : {});
    try {
      const s1 = new AbortController(), s2 = new AbortController();
      const a = read(s1.signal).then(() => "read", (e: unknown) => (s1.signal.aborted ? "stopped" : String(e)));
      await wait(100); // a's first round drew its 429s: a waits the gate (1 s) holding the turn
      const b = read(s2.signal).then(() => "read", (e: unknown) => (s2.signal.aborted ? "stopped" : String(e)));
      const c = read();
      await wait(100);
      s2.abort(), s1.abort();
      assert.deepEqual(await Promise.all([a, b]), ["stopped", "stopped"]);
      assert.deepEqual((await c).failed, [], "the third read had its turn");
    } finally {
      f.restore();
    }
  });
});

// F4: the gate's time is the page's monotonic clock; a wall clock moved either way never moves it
test("a wall clock set back or on moves no gate: the gate keeps performance.now, and left() never passes the longest wait", () => {
  const g = new ThrottleGate();
  for (let k = 0; k < 6; k++) g.throttled(g.epoch(), null);
  const real = Date.now;
  try {
    for (const by of [-3_600_000, 3_600_000]) {
      Date.now = () => real() + by;
      const w = g.left();
      assert.ok(w > 0 && w <= 10_000, `the clock moved ${by} ms: left ${w}`);
    }
  } finally {
    Date.now = real;
  }
  // a gate on a given clock set back an hour: left() at most the longest wait, never the setback's length
  let now = 3_600_000;
  const h = new ThrottleGate({ now: () => now });
  for (let k = 0; k < 6; k++) h.throttled(h.epoch(), null);
  now = 0;
  assert.equal(h.left(), Math.max(THROTTLE_PAUSE_MAX_MS, THROTTLE_RETRY_AFTER_MAX_MS));
  now = 7_200_000;
  assert.equal(h.left(), 0, "set on: open");
});

// F2: the 30 s bound is the whole list's, from its start, never each wallet's
test("two pools on one route throttled for good: the list's bound runs from its start, so no call goes past 30 s", async () => {
  const origin = "https://two-pools.example";
  await onTestClock(async () => {
    const bound = after(HOLDINGS_THROTTLE_MAX_MS);
    let past = 0;
    const f = fakeSolana(origin, () => (bound() && past++, true));
    try {
      const r = await buyWallets(SEED, [
        { id: "sol-a", chain: "sol", spent: spent(1), reader: solanaHelperHoldings(origin) },
        { id: "sol-b", chain: "sol", spent: [{ ref: { kind: "deposit" as const, s: 2n, i: 0 }, label: 6n }], reader: solanaHelperHoldings(origin) },
      ]);
      assert.equal(r.failed.length, 2);
    } finally {
      f.restore();
    }
    assert.equal(past, 0, "no call past the list's bound");
  });
});

// F2: a JSON-RPC throttle code in a 200 on the one-try client (the testnet transport's real path) is a throttle
test("a JSON-RPC throttle code (-32029) on the devnet transport counts as a throttle: the gate holds it to the bound", async () => {
  const origin = "https://code.example";
  await onTestClock(async () => {
    const quiet = after(60_000);
    const real = globalThis.fetch;
    let hot = 0;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      if (!String(u).startsWith(origin)) return real(u, init);
      const q = JSON.parse(String(init?.body)) as { id: string; method: string };
      if (!quiet()) return hot++, new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32029, message: "too many requests" } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { context: { slot: 1 }, value: q.method === "getBalance" ? 0 : [] } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await passes(() => solanaHoldingsAt(`${origin}/`), 300_000);
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(hot <= 3 * HOLDINGS_THROTTLED_ROUNDS_60S && hot >= 3 * 5, `${hot} calls under 60 s of -32029`);
  });
});

// F2: the pause goes back to none after a whole round, on both readers
test("after a throttle, a whole round that goes through keeps the pause for a throttle inside the quiet time, and the first pause comes back only after it (Solana and EVM)", async () => {
  const run = async (make: (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>, o: { gate: ThrottleGate; sleep: (ms: number) => Promise<void> }) => HoldingsReader, answer: (m: string) => unknown, quiet = 0) => {
    let now = 0, hot = 0;
    const sleeps: number[] = [];
    const gate = new ThrottleGate({ now: () => now });
    // each read: its first round throttled, its second answered
    const rpc = async (m: string) => {
      if (hot > 0) return hot--, Promise.reject(new Error("HTTP 429"));
      return answer(m);
    };
    const reader = make(rpc, { gate, sleep: async (ms) => void (sleeps.push(ms), (now += ms)) });
    const W = make === solanaMake ? "11111111111111111111111111111112" : `0x${"11".repeat(20)}`;
    for (let k = 0; k < 3; k++) {
      hot = make === solanaMake ? 3 : 1;
      await reader.read(W);
      now += quiet;
    }
    return sleeps;
  };
  const solanaMake = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>, o: { gate: ThrottleGate; sleep: (ms: number) => Promise<void> }) => solanaHoldingsReader(rpc as never, o);
  const solAnswer = (m: string) => ({ context: { slot: 1 }, value: m === "getBalance" ? 0 : [] });
  assert.deepEqual(await run(solanaMake, solAnswer), [1_000, 2_000, 4_000], "Solana: a throttle right after the round doubles the last pause");
  assert.deepEqual(await run(solanaMake, solAnswer, THROTTLE_QUIET_MS), [1_000, 1_000, 1_000], "Solana: the first pause again after the quiet time");
  const evmMake = (rpc: (m: string, p: readonly unknown[]) => Promise<unknown>, o: { gate: ThrottleGate; sleep: (ms: number) => Promise<void> }) => evmHoldingsReader(rpc, [], o);
  const evmAnswer = (m: string) => (m === "eth_getBlockByNumber" ? { hash: `0x${"1".repeat(64)}`, number: "0x1" } : "0x0");
  assert.deepEqual(await run(evmMake, evmAnswer), [1_000, 2_000, 4_000], "EVM: the same");
  assert.deepEqual(await run(evmMake, evmAnswer, THROTTLE_QUIET_MS), [1_000, 1_000, 1_000], "EVM: the same after the quiet time");
});

// F2: one gate per route, never one for all; a reader with no route's gate holds one per rpc it reads on
test("one gate per route: a throttled route never holds another route's read", async () => {
  await onTestClock(async () => {
    const hotF = fakeSolana("https://route-a.example", () => true);
    const okF = fakeSolana("https://route-b.example", () => false);
    try {
      const a = buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHelperHoldings("https://route-a.example") }]);
      await wait(100); // route a's gate is closed for 1 s
      const soon = after(500);
      const b = await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHelperHoldings("https://route-b.example") }]);
      assert.deepEqual(b.failed, []);
      assert.equal(soon(), false, "route b read at once");
      await a;
    } finally {
      okF.restore();
      hotF.restore();
    }
  });
});

test("a reader given no gate holds one per rpc: two readers on one rpc share it, a reader on another rpc does not", async () => {
  await onTestClock(async () => {
    let hot = 3;
    const answer = (m: string) => ({ context: { slot: 1 }, value: m === "getBalance" ? 0 : [] });
    const x = async (m: string) => (hot > 0 ? (hot--, Promise.reject(new Error("HTTP 429"))) : answer(m));
    const y = async (m: string) => answer(m);
    const W = "11111111111111111111111111111112";
    const first = solanaHoldingsReader(x as never).read(W);
    await wait(100); // x's gate closed for 1 s
    const early = after(500);
    const other = await solanaHoldingsReader(y as never).read(W).then(() => early());
    assert.equal(other, false, "another rpc's reader read at once");
    const same = await solanaHoldingsReader(x as never).read(W).then(() => early());
    assert.equal(same, true, "a second reader on the same rpc waited its gate");
    await first;
  });
});

// F6: the devnet transport is paced in the URL's one queue, the page's pair's own: the host's calls in a window never
// pass the kit's keyless budget, however the holdings reads and the pair's reads mix
test("the devnet holdings reads share the URL's one queue with the page's pair: the host is never asked past the keyless budget in a window", async () => {
  const origin = "https://one-queue.example";
  await onTestClock(async () => {
    const f = fakeSolana(origin, () => false);
    // the window from the host's first call, a timer on the test clock: a call before it fires is in that window
    let inWindow = 0, closed = false, all = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      if (String(u).startsWith(origin)) {
        if (all++ === 0) setTimeout(() => (closed = true), SOLANA_KEYLESS_RPC_LIMIT.windowMs);
        if (!closed) inWindow++;
      }
      return real(u, init);
    }) as typeof fetch;
    const pair = solanaPacedRpc(solanaJsonRpc(`${origin}/`));
    try {
      const ten = after(10_000);
      const hold = (async () => {
        while (!ten()) await buyWallets(SEED, [{ id: "sol", chain: "sol", spent: spent(1), reader: solanaHoldingsAt(`${origin}/`) }]);
      })();
      const methods = ["getSlot", "getBlockHeight", "getEpochInfo"];
      const per = [SOLANA_KEYLESS_RPC_LIMIT.perMethod, SOLANA_KEYLESS_RPC_LIMIT.perMethod, SOLANA_KEYLESS_RPC_LIMIT.total - 2 * SOLANA_KEYLESS_RPC_LIMIT.perMethod];
      const trade = methods.flatMap((m, i) => Array.from({ length: per[i]! }, () => pair(m, []).catch(() => null)));
      await Promise.all([hold, ...trade]);
    } finally {
      globalThis.fetch = real;
      f.restore();
    }
    assert.ok(inWindow <= SOLANA_KEYLESS_RPC_LIMIT.total, `${inWindow} calls to the host in its first ${SOLANA_KEYLESS_RPC_LIMIT.windowMs} ms, budget ${SOLANA_KEYLESS_RPC_LIMIT.total}`);
  });
});

test("a round ends once all its calls settle: a call that fails at once never lets the next round go while the others are out", async () => {
  // getBalance answers 429 at once, the token reads 429 two seconds later: the next round waits for them
  const origin = "https://settle.example";
  await onTestClock(async () => {
    const quiet = after(20_000);
    const real = globalThis.fetch;
    let out = 0, most = 0;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      if (!String(u).startsWith(origin)) return real(u, init);
      const q = JSON.parse(String(init?.body)) as { id: string; method: string };
      most = Math.max(most, ++out);
      try {
        if (!quiet() && q.method !== "getBalance") await wait(2_000);
        if (!quiet()) return new Response("slow down", { status: 429 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { context: { slot: 1 }, value: q.method === "getBalance" ? 0 : [] } }), { headers: { "content-type": "application/json" } });
      } finally {
        out--;
      }
    }) as typeof fetch;
    try {
      // the devnet transport: its URL's queue allows a round a second, so only the turn holds the next round back
      await passes(() => solanaHoldingsAt(`${origin}/`), 300_000);
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(most <= 3, `${most} calls out at once`);
  });
});

// HostLane (card signpage-passes-yield-to-a-trade): one provider host's budget for the whole page, on a clock of its own.
/** A lane on a test clock: `sleep` moves the clock, so a wait shows as time passed, at once. */
function lane(): { l: HostLane; clock: { t: number } } {
  const clock = { t: 0 };
  const l = new HostLane({ now: () => clock.t, sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.t += ms; } });
  return { l, clock };
}

test("HostLane: a pass goes while the host's window holds fewer than PASS_BUDGET requests, else when the oldest leaves it; a trade's read never waits on the budget", async () => {
  const { l, clock } = lane();
  for (let i = 0; i < PASS_BUDGET; i++) l.sent("trade");
  assert.equal(l.open("pass"), false);
  assert.equal(l.open("trade"), true);
  await l.turn("pass");
  assert.equal(clock.t, HOST_WINDOW_MS, "room once the first request left the window");
  assert.equal(l.inWindow(), 1, "the pass counted, the rest gone");
});

test("HostLane: while a trade holds the host, passes take what its reads leave of PASS_BUDGET_TRADING, and at least one every PASS_FLOOR_MS", async () => {
  const { l, clock } = lane();
  const give = l.trade();
  for (let i = 0; i < 100; i++) l.sent("trade");
  // the first pass goes at once (none went before), the next at the floor, whatever the window holds
  await l.turn("pass");
  assert.equal(clock.t, 0);
  await l.turn("pass");
  assert.equal(clock.t, PASS_FLOOR_MS);
  for (let i = 0; i < 100; i++) l.sent("trade");
  await l.turn("pass");
  assert.equal(clock.t, 2 * PASS_FLOOR_MS);
  // the trade's reads past PASS_BUDGET_TRADING in the window: the floor; under it, at once
  give();
  assert.equal(l.trading(), false);
  // no trade: no floor, the plain budget: room once all but PASS_BUDGET - 1 of the window's requests left it
  await l.turn("pass");
  assert.equal(clock.t, PASS_FLOOR_MS + HOST_WINDOW_MS, "the second hundred's turn to leave, not the floor");
  const { l: m } = lane();
  m.trade();
  for (let i = 0; i < PASS_BUDGET_TRADING - 1; i++) m.sent("trade");
  m.sent("pass");
  assert.equal(m.open("pass"), false, "a trade's reads and a pass at PASS_BUDGET_TRADING: the next waits for the floor");
});

test("HostLane: a trade's turn waits the host's pause, at most TRADE_TURN_MAX_MS however often the pause is renewed, and is then refused unsent", async () => {
  const clock = { t: 0 };
  // another reader's 429 (a Retry-After of an hour) renews the pause each time this one wakes
  const l: HostLane = new HostLane({ now: () => clock.t, sleep: async (ms) => { clock.t += ms; l.gate.throttled(l.gate.epoch(), 3_600_000); } });
  l.gate.throttled(l.gate.epoch(), 3_600_000);
  await assert.rejects(l.turn("trade"), HostPaused);
  assert.equal(clock.t, TRADE_TURN_MAX_MS, "its turn's deadline, the pause still on");
  assert.ok(l.gate.left() > 0);
  assert.equal(l.inWindow(), 0, "nothing sent into the pause, nothing counted");
});

test("HostLane: a hold is counted, given back once, ends at its bound; holdHosts holds each host once, whatever its spelling", async () => {
  resetHostLanes();
  const a = new HostLane();
  const g1 = a.trade();
  const g2 = a.trade();
  g1();
  g1();
  assert.equal(a.trading(), true, "a second give-back of one hold does nothing");
  g2();
  assert.equal(a.trading(), false);
  a.trade(20);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(a.trading(), false, "given back at its bound");
  assert.ok(TRADE_HOLD_MAX_MS >= 120_000);
  const release = holdHosts(["https://API.devnet.solana.com/", "https://api.devnet.solana.com/x", undefined]);
  assert.equal(hostLane("https://api.devnet.solana.com").trading(), true);
  release();
  assert.equal(hostLane("https://api.devnet.solana.com").trading(), false);
  resetHostLanes();
});

test("HostLane: a sign out ends a waiting turn at once with its reason, and a turn after it waits as before", async () => {
  resetHostLanes();
  const l = hostLane("https://api.devnet.solana.com");
  for (let i = 0; i < PASS_BUDGET; i++) l.sent("trade");
  const waiting = l.turn("pass");
  stopHostLaneWaits(new Error("signed out"));
  await assert.rejects(waiting, /signed out/);
  const a = new AbortController();
  const next = l.turn("pass", a.signal);
  a.abort(new Error("stopped"));
  await assert.rejects(next, /stopped/, "the next sign-in's waits are not ended by the last sign out");
  resetHostLanes();
});

// The delta review of ed85d367 (P2-A): a pass asleep for room when a trade starts slept on to its room's end (10 s
// measured), so the floor (one every PASS_FLOOR_MS) did not hold from the trade's start.
test("HostLane: a pass asleep for room learns of a trade's start at once, and goes by the floor", async () => {
  // a planted clock and a sleep that never ends by itself: only a wake moves the pass on
  const clock = { t: 0 };
  const slept: number[] = [];
  const l = new HostLane({ now: () => clock.t, sleep: (ms) => (slept.push(ms), new Promise<void>(() => {})) });
  for (let i = 0; i < PASS_BUDGET; i++) l.sent("trade");
  let went = false;
  const pass = l.turn("pass").then(() => (went = true));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(slept, [HOST_WINDOW_MS], "asleep for the window's room, no trade yet");
  assert.equal(went, false);
  clock.t = 100;
  const give = l.trade(1_000);
  await pass;
  assert.equal(went, true, "the trade's start woke it, and the floor let it go");
  assert.deepEqual(slept, [HOST_WINDOW_MS], "it slept no more: woken at the trade's start, not at its room's end");
  give();
});

// Card signpage-throttled-provider-has-a-spare (run 9 of 11 Nov: every read parked on a pause left within 3 ms of its
// end, 10 to 15 at a time, and each burst met 429 again). On a planted clock and sleep.
function plantedLane(): { l: HostLane; clock: { t: number }; advance: (t: number) => Promise<void>; flush: () => Promise<void> } {
  const clock = { t: 0 };
  const sleeps: { at: number; r: () => void }[] = [];
  const l = new HostLane({ now: () => clock.t, sleep: (ms) => new Promise<void>((r) => void sleeps.push({ at: clock.t + ms, r })) });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const advance = async (t: number): Promise<void> => {
    clock.t = t;
    for (const s of sleeps.splice(0)) if (s.at <= t) s.r();
      else sleeps.push(s);
    await flush();
  };
  return { l, clock, advance, flush };
}

test("HostLane: after a pause one probe goes, a trade's though a pass asked first; the rest wait for it, its 429 starts the next pause doubled, and its answer lets the trades go before any pass", async () => {
  const { l, advance, flush } = plantedLane();
  l.throttled(l.gate.epoch(), null);
  assert.equal(l.gate.left(), 1_000);
  const order: string[] = [];
  const turn = (kind: "trade" | "pass", name: string) => l.turn(kind, undefined, true, { reports: true }).then(() => void order.push(name));
  const all = [turn("pass", "pass"), turn("trade", "t1"), turn("trade", "t2")];
  await flush();
  assert.deepEqual(order, [], "nothing leaves inside the pause");
  await advance(1_000);
  assert.deepEqual(order, ["t1"], "one read at the pause's end: the probe, a trade's");
  // the probe's 429: the next pause, doubled from the last (never 1 s again), and still nobody else goes
  l.throttled(l.gate.epoch(), null);
  assert.equal(l.gate.left(), 2_000);
  await flush();
  assert.deepEqual(order, ["t1"]);
  // t2's turn ends at its 10 s deadline, so the next probe is the pass's or t2's: at 3 s, t2 (a trade) again
  await advance(3_000);
  assert.deepEqual(order, ["t1", "t2"], "the next probe, a trade's");
  // its answer: the host open, the pass goes after the trades
  l.answered(l.gate.epoch());
  await flush();
  assert.deepEqual(order, ["t1", "t2", "pass"]);
  await Promise.all(all);
  assert.equal(l.inWindow(), 3, "each read counted once, as it left");
});

test("HostLane: with a trade parked, a pass never leaves before it, and a turn that reports nothing never takes the probe", async () => {
  const { l, advance, flush } = plantedLane();
  l.throttled(l.gate.epoch(), null);
  const order: string[] = [];
  // a turn whose transport reports no outcome (the finder's): it goes once the pause ends, but not as the probe
  const finder = l.turn("pass", undefined, false).then(() => void order.push("finder"));
  const trade = l.turn("trade", undefined, true, { reports: true }).then(() => void order.push("trade"));
  await advance(1_000);
  assert.ok(order.includes("trade"), "the trade's read probes");
  // the probe out: a reporting pass waits for it
  const pass = l.turn("pass", undefined, true, { reports: true }).then(() => void order.push("pass"));
  await flush();
  assert.ok(!order.includes("pass"), "a pass waits for the probe");
  l.answered(l.gate.epoch());
  await Promise.all([finder, trade, pass]);
  assert.equal(order.at(-1), "pass");
  // alone after a pause, a turn that reports nothing goes, but leaves the probe to a read that reports: one goes at once
  const m = plantedLane();
  m.l.throttled(m.l.gate.epoch(), null);
  const alone = m.l.turn("pass", undefined, false);
  await m.advance(1_000);
  await alone;
  let probed = false;
  const next = m.l.turn("trade", undefined, true, { reports: true }).then(() => (probed = true));
  await m.flush();
  assert.equal(probed, true, "the probe was not taken by a turn that reports no outcome");
  await next;
});

// The review of 507431c0, P2: a 10 s pause (the doubling's cap, the helper's own Retry-After ceiling) is as long as a
// trade's turn, so every parked trade read but the probe was refused unsent at the pause's end. The wait for the probe's
// verdict has its own bound: each read that waited the pause out goes once the probe settles.
test("HostLane: after a 10 s pause, every trade read that waited it out goes once the probe answers, none refused", async () => {
  const { l, advance, flush } = plantedLane();
  l.throttled(l.gate.epoch(), 10_000);
  assert.equal(l.gate.left(), 10_000);
  await advance(5);
  const out: string[] = [];
  const turn = (n: string) => l.turn("trade", undefined, true, { reports: true }).then(() => void out.push(`${n}:sent`), (e: unknown) => void out.push(`${n}:${e instanceof HostPaused ? "HostPaused" : String(e)}`));
  const all = [turn("t1"), turn("t2"), turn("t3")];
  await flush();
  await advance(10_000);
  assert.deepEqual(out, ["t1:sent"], "the probe alone at the pause's end");
  const probe = l.gate.epoch();
  await advance(10_100);
  assert.deepEqual(out, ["t1:sent"], "the rest wait for the probe, past the turn's 10 s from their start");
  l.answered(probe);
  await Promise.all(all);
  assert.deepEqual(out, ["t1:sent", "t2:sent", "t3:sent"]);
  assert.equal(l.inWindow(), 3);
});

test("HostLane: a known 10 s pause against a 3.5 s bound is refused at once, nothing sent or counted", async () => {
  const { l, flush } = plantedLane();
  l.throttled(l.gate.epoch(), 10_000);
  let err: unknown = null;
  const p = l.turn("trade", undefined, true, { reports: true, by: 3_500 }).catch((e: unknown) => void (err = e));
  await flush();
  assert.ok(err instanceof HostPaused, "refused at once, not at 3.5 s");
  await p;
  assert.equal(l.inWindow(), 0);
});

test("HostLane: a probe that fails any other way settles it (the host still in doubt, the next read probes); a lost probe is given up at PROBE_HELD_MAX_MS", async () => {
  const { l, advance, flush } = plantedLane();
  l.throttled(l.gate.epoch(), null);
  const order: string[] = [];
  const t = (n: string) => l.turn("trade", undefined, true, { reports: true }).then(() => void order.push(n));
  const a = t("a");
  const b = t("b");
  const c = t("c");
  await advance(1_000);
  assert.deepEqual(order, ["a"]);
  // a's read stalled and was dropped: failed() settles the probe, so b probes at once (no dead lane)
  l.failed(l.gate.epoch());
  await flush();
  assert.deepEqual(order, ["a", "b"], "the next read probes after a failed probe");
  // b's read is never reported: c waits PROBE_HELD_MAX_MS for it, then probes in its place
  await advance(1_000 + PROBE_HELD_MAX_MS - 1);
  assert.deepEqual(order, ["a", "b"]);
  await advance(1_000 + PROBE_HELD_MAX_MS);
  assert.deepEqual(order, ["a", "b", "c"], "a lost probe is given up at its try's timeout");
  await Promise.all([a, b, c]);
});
