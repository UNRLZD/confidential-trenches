// node --test test/pace.test.ts: one pace per provider URL for the whole page (src/pace.ts, card wallet-id-reader-paced).
// Delta review 2 of 71cb1284: P1, a request waits for its slot under its caller's own signal only and its deadline starts
// when the slot comes (before, the readers' 10 s deadline ran in the pace queue, so the fourth request queued on
// FastNEAR's 2.56 s gap timed out unsent and four chains at once stalled for good); P3-1, every reader of the page is on
// pacedFetch by default.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { onTestClock } from "../../kit/test/test-clock.ts";
import * as P from "../src/pace.ts";
import { bindRpc } from "../src/deposit/bind.ts";
import { followRpc } from "../src/deposit/follow.ts";
import { archivalRpc, moveOutRpc } from "../src/deposit/moveout.ts";
import { relayRpc } from "../src/withdraw/relay.ts";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";

const FAST = NEAR_NETWORKS.mainnet.fastnear[0];
const DRPC = NEAR_NETWORKS.mainnet.drpc;
beforeEach(() => P.resetPaces());
const answer = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "blindfill", result: { ok: true } }), { status: 200 });

// five relay-like chains at once, each three reads in a row on FastNEAR, the readers' own default deadline: 15 requests
// past a burst of 8 at 2.56 s apart, the last slot about 18 s after the first, every one answered
test("five FastNEAR chains at once on the page's pace: every request answered, none timed out in the queue", { timeout: 60_000 }, () => onTestClock(async () => {
  let sent = 0;
  const f = P.pacedFetch(FAST, async (_u, init) => (sent++, assert.equal(init?.signal?.aborted, false), answer()));
  const rpc = relayRpc(FAST, f);
  const chain = async () => {
    for (let k = 0; k < 3; k++) assert.deepEqual(await rpc.query({ request_type: "view_account", finality: "final", account_id: "intents.near" }), { jsonrpc: "2.0", id: "blindfill", result: { ok: true } });
  };
  const t = performance.now();
  await Promise.all([chain(), chain(), chain(), chain(), chain()]);
  assert.equal(sent, 15);
  assert.ok(performance.now() - t > 15_000, `15 requests in ${performance.now() - t} ms: the pace held`);
}));

test("a wait its caller ends gives its slot back, sends nothing and throws the caller's reason", async () => {
  let sent = 0;
  const f = P.pacedFetch(FAST, async () => (sent++, answer()));
  for (let k = 0; k < 8; k++) await f(FAST);
  const p = P.paceOf(FAST);
  const before = p.tat;
  const c = new AbortController();
  setTimeout(() => c.abort(new Error("signed out")), 30);
  await assert.rejects(f(FAST, { signal: c.signal }), /^Error: signed out$/);
  assert.equal(sent, 8);
  assert.ok(p.tat <= before + 1, `tat ${p.tat - before} ms on after the wait was ended`);
  // a signal already aborted takes no slot
  const d = new AbortController();
  d.abort(new Error("gone"));
  const t0 = p.tat;
  await assert.rejects(f(FAST, { signal: d.signal }), /^Error: gone$/);
  assert.equal(p.tat, t0);
});

test("the deadline starts at the slot and still bounds the request", async () => {
  const f = P.pacedFetch(FAST, (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason))), 100);
  const t = performance.now();
  await assert.rejects(f(FAST), (e: Error) => e.name === "TimeoutError");
  assert.ok(performance.now() - t < 2_000);
  // a reader on a pacedFetch leaves its deadline to it; on another fetch the reader bounds it
  assert.equal(P.deadlineOf(f, 10_000), null);
  assert.equal(P.deadlineOf(fetch, 10_000), 10_000);
  assert.equal(P.requestSignal(f, 10_000), undefined);
  assert.ok(P.requestSignal(fetch, 10_000) instanceof AbortSignal);
});

test("every reader of the page is on its URL's one pace by default (review P3-1)", () => {
  for (const u of [FAST, DRPC]) {
    for (const [name, rpc] of [["bindRpc", bindRpc(u)], ["followRpc", followRpc(u)], ["moveOutRpc", moveOutRpc(u)], ["relayRpc", relayRpc(u)], ["archivalRpc", archivalRpc(u)], ["pacedNearRpc", P.pacedNearRpc(u)]] as const) assert.ok(P.isPacedRpc(rpc), `${name}(${u})`);
    // a reader given its own fetch is not paced at its transport (the IdReader then takes the slot itself)
    assert.equal(P.isPacedRpc(relayRpc(u, async () => answer())), false);
  }
});

// delta review 3, P2-1: an ended wait gives back only the queue's last slot (before, any ended wait lowered tat one gap,
// so a later request took a slot still held by another waiter: 12 sends at one instant on FastNEAR's burst of 8, and a
// busy hold cut 2564 ms short). On a virtual clock (performance.now and setTimeout replaced for the test's length).
test("queued waits ended in any order never send past the burst at once or the rate over 60 s, and a busy hold stands", async () => {
  const realNow = Object.getOwnPropertyDescriptor(performance, "now");
  const [realSet, realClear] = [globalThis.setTimeout, globalThis.clearTimeout];
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  Object.defineProperty(performance, "now", { value: () => now, configurable: true });
  globalThis.setTimeout = ((fn: () => void, ms?: number) => (timers.set(++id, { at: now + Math.max(0, ms ?? 0), fn }), id)) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((k: number) => void timers.delete(k)) as unknown as typeof clearTimeout;
  const turn = () => new Promise<void>((r) => setImmediate(r));
  const runTo = async (t: number): Promise<void> => {
    for (;;) {
      await turn(); await turn();
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const [k, v] of timers) if (v.at <= t && (best === null || v.at < best[1].at)) best = [k, v];
      if (best === null) break;
      timers.delete(best[0]);
      now = Math.max(now, best[1].at);
      best[1].fn();
    }
    now = t;
    await turn(); await turn();
  };
  try {
    for (const order of [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], [5, 0, 11, 3, 8, 1, 10, 2, 7, 4, 9, 6]]) {
      P.resetPaces(); now = 0; timers.clear();
      const sends: number[] = [];
      const f = P.pacedFetch(FAST, async () => (sends.push(now), answer()));
      const p = P.paceOf(FAST);
      const fire = (signal?: AbortSignal) => void f(FAST, signal ? { signal } : undefined).catch(() => {});
      for (let k = 0; k < 8; k++) fire();
      const cs = Array.from({ length: 12 }, () => new AbortController());
      for (const c of cs) fire(c.signal);
      for (const i of order) { await runTo(now + 700); cs[i]!.abort(new Error("x")); fire(); }
      for (let k = 0; k < 20; k++) fire();
      await runTo(now + 3_600_000);
      sends.sort((a, b) => a - b);
      // GCRA: each send no earlier than its theoretical arrival less the burst's allowance
      let tat = -Infinity;
      for (const t of sends) {
        if (tat !== -Infinity) assert.ok(t >= tat - (p.burst - 1) * p.every - 1e-6, `${order.join(",")}: a send at ${t} ms past the pace`);
        tat = Math.max(tat, t) + p.every;
      }
      const most = (win: number) => { let m = 0, j = 0; for (let i = 0; i < sends.length; i++) { while (sends[i]! - sends[j]! > win) j++; m = Math.max(m, i - j + 1); } return m; };
      assert.ok(most(0.001) <= p.burst, `${order.join(",")}: ${most(0.001)} at one instant`);
      assert.ok(most(60_000) <= p.burst + Math.floor(60_000 / p.every), `${order.join(",")}: ${most(60_000)} in 60 s`);
    }
    // a busy hold during the queue, then a queued wait ended: nothing goes before the hold ends
    P.resetPaces(); now = 0; timers.clear();
    const sends: number[] = [];
    const f = P.pacedFetch(FAST, async () => (sends.push(now), answer()));
    const p = P.paceOf(FAST);
    for (let k = 0; k < 8; k++) void f(FAST).catch(() => {});
    const c = new AbortController();
    void f(FAST, { signal: c.signal }).catch(() => {});
    await runTo(100);
    P.paceHold(p, now, 8_000);
    c.abort(new Error("x"));
    void f(FAST).catch(() => {});
    await runTo(60_000);
    assert.ok(sends[8]! >= 8_100, `sent at ${sends[8]} ms, the hold ends at 8100 ms`);
  } finally {
    if (realNow) Object.defineProperty(performance, "now", realNow); else delete (performance as { now?: unknown }).now;
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

// delta review 3, P2-2: relayRpc.block and pacedNearRpc leave the deadline to the paced fetch as query does (with their
// own 10 s deadline back, five chains at once gave 15 queue timeouts in 60 s)
test("five FastNEAR chains at once on relayRpc.block and pacedNearRpc: every request answered", { timeout: 60_000 }, () => onTestClock(async () => {
  const real = globalThis.fetch;
  let sent = 0;
  const stub = async (_u: unknown, init?: RequestInit) => (sent++, assert.equal(init?.signal?.aborted, false), answer());
  globalThis.fetch = stub as typeof fetch;
  try {
    const relay = relayRpc(FAST, P.pacedFetch(FAST, stub as typeof fetch));
    const near = P.pacedNearRpc(FAST);
    const ok = { jsonrpc: "2.0", id: "blindfill", result: { ok: true } };
    const chain = async (read: () => Promise<unknown>) => { for (let k = 0; k < 3; k++) assert.deepEqual(await read(), ok); };
    await Promise.all([
      chain(() => relay.block({ finality: "final" })), chain(() => relay.block({ finality: "final" })), chain(() => relay.block({ finality: "final" })),
      chain(() => near.query({ request_type: "view_account", finality: "final", account_id: "intents.near" })), chain(() => near.query({ request_type: "view_account", finality: "final", account_id: "intents.near" })),
    ]);
    assert.equal(sent, 15);
  } finally {
    globalThis.fetch = real;
  }
}));

// delta review 4: the real pacedFetch on a virtual clock (performance.now and setTimeout replaced for the body's length)
async function onVirtualClock(body: (c: { now: () => number; setNow: (t: number) => void; runTo: (t: number) => Promise<void>; turn: () => Promise<void> }) => Promise<void>): Promise<void> {
  const realNow = Object.getOwnPropertyDescriptor(performance, "now");
  const [realSet, realClear] = [globalThis.setTimeout, globalThis.clearTimeout];
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  Object.defineProperty(performance, "now", { value: () => now, configurable: true });
  globalThis.setTimeout = ((fn: () => void, ms?: number) => (timers.set(++id, { at: now + Math.max(0, ms ?? 0), fn }), id)) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((k: number) => void timers.delete(k)) as unknown as typeof clearTimeout;
  const turn = () => new Promise<void>((r) => setImmediate(r));
  const runTo = async (t: number): Promise<void> => {
    for (;;) {
      await turn(); await turn();
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const [k, v] of timers) if (v.at <= t && (best === null || v.at < best[1].at || (v.at === best[1].at && k < best[0]))) best = [k, v];
      if (best === null) break;
      timers.delete(best[0]);
      now = Math.max(now, best[1].at);
      best[1].fn();
    }
    now = t;
    await turn(); await turn();
  };
  try {
    await body({ now: () => now, setNow: (t) => void (now = t), runTo, turn });
  } finally {
    if (realNow) Object.defineProperty(performance, "now", realNow); else delete (performance as { now?: unknown }).now;
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

// delta review 4, P2-1: a sign-out ends many queued waits on one signal, whose listeners run in slot order, so a give-back
// of the queue's tail alone freed only the last (8 burst + 20 queued on FastNEAR, one abort: the next request waited
// 51.2 s); and `===` on a float tat missed the tail about 1.2% of the time, which kept every slot before it
test("one signal ending the burst and 20 queued waits frees every queued slot: the next request waits at most one gap", async () => {
  await onVirtualClock(async ({ now, setNow, runTo, turn }) => {
    const sends: number[] = [];
    const f = P.pacedFetch(FAST, async () => (sends.push(now()), answer()));
    const p = P.paceOf(FAST);
    const c = new AbortController();
    for (let k = 0; k < 28; k++) void f(FAST, { signal: c.signal }).catch(() => {});
    await runTo(100);
    c.abort(new Error("signed out"));
    await turn();
    assert.equal(sends.length, 8);
    const t0 = now();
    void f(FAST).catch(() => {});
    await runTo(t0 + 120_000);
    assert.equal(sends.length, 9);
    assert.ok(sends[8]! - t0 <= p.every, `the next request waited ${sends[8]! - t0} ms, over one gap of ${p.every} ms`);
    // waits ended last first on a fractional clock: every queued slot comes back (8 gaps ahead, the burst's, stay)
    P.resetPaces();
    setNow(1234.5678901);
    const q = P.pacedFetch(FAST, async () => answer());
    const p2 = P.paceOf(FAST);
    const cs = Array.from({ length: 40 }, () => new AbortController());
    for (const x of cs) void q(FAST, { signal: x.signal }).catch(() => {});
    await runTo(now() + 0.3333);
    for (let i = cs.length - 1; i >= 8; i--) { cs[i]!.abort(new Error("x")); await turn(); }
    assert.ok(Math.abs(p2.tat - now() - 8 * p2.every) < 1, `tat ${p2.tat - now()} ms ahead, the burst's ${8 * p2.every} ms`);
  });
});

// delta review 4, P3-1: a busy hold that moved nothing (tat already past its end) was cut short by one ended wait: 11
// requests at 0, a 9000 ms Retry-After at 10, the queue's tail ended, and a new request went at 7692 ms
test("a busy hold stands when an ended wait gives a slot back, even a hold the queue already reached past", async () => {
  await onVirtualClock(async ({ now, runTo, turn }) => {
    const sends: number[] = [];
    const f = P.pacedFetch(FAST, async () => (sends.push(now()), answer()));
    const p = P.paceOf(FAST);
    const cs = Array.from({ length: 11 }, () => new AbortController());
    for (const c of cs) void f(FAST, { signal: c.signal }).catch(() => {});
    await runTo(10);
    P.paceHold(p, now(), 9_000);
    const end = now() + 9_000;
    cs[10]!.abort(new Error("x"));
    await turn();
    const t0 = now();
    void f(FAST).catch(() => {});
    await runTo(t0 + 60_000);
    const last = sends[sends.length - 1]!;
    assert.equal(sends.length, 11);
    assert.ok(last >= end, `the new request went at ${last} ms, inside the hold that ends at ${end} ms`);
  });
});

// card near-quote-under-the-pace: the page's NEAR trade pair (pacedNearRpc) on the real fetch, stubbed here
const withFetch = async (stub: typeof fetch, run: () => Promise<void>): Promise<void> => {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
};
const busy = (retryAfter?: string) => new Response("busy", { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });

test("a busy answer from dRPC holds its pace and the read is asked again, not failed; past NEAR_BUSY_TRIES it fails", () => onTestClock(async () => {
  let n = 0;
  await withFetch(async () => (++n <= 2 ? busy("0") : answer()), async () => {
    const rpc = P.pacedNearRpc(DRPC);
    const t = performance.now();
    assert.deepEqual(await rpc.query({ request_type: "view_account", finality: "final", account_id: "intents.near" }), { jsonrpc: "2.0", id: "blindfill", result: { ok: true } });
    assert.equal(n, 3);
    // each busy answer held dRPC for at least its pace's gap before the next try
    assert.ok(performance.now() - t >= 2 * P.paceOf(DRPC).every - 5, `${performance.now() - t} ms`);
  });
  P.resetPaces();
  // a hard cap on turns: past twice the bound the stub answers, so a loop with no bound fails here, never hangs
  let m = 0;
  await withFetch(async () => (++m > 2 * P.NEAR_BUSY_TRIES ? answer() : busy("0")), async () => {
    await assert.rejects(P.pacedNearRpc(DRPC).query({ request_type: "view_account", finality: "final", account_id: "intents.near" }), /HTTP 429/);
    assert.equal(m, P.NEAR_BUSY_TRIES);
  });
}));

test("reserve takes the provider's turn once: its first query goes at once with no second turn, the next ones take turns", () => onTestClock(async () => {
  await withFetch(async () => answer(), async () => {
    const rpc = P.pacedNearRpc(FAST);
    const p = P.paceOf(FAST);
    const q = { request_type: "view_account", finality: "final", account_id: "intents.near" };
    for (let k = 0; k < 8; k++) await rpc.query(q); // FastNEAR's burst spent
    const t0 = performance.now();
    const now = await rpc.reserve!();
    const waited = performance.now() - t0;
    assert.ok(waited >= p.every - 50, `the turn waited ${waited} ms`);
    const tat = p.tat;
    const t1 = performance.now();
    await now.query(q);
    assert.ok(performance.now() - t1 < 200, "the reserved turn's query went at once");
    assert.equal(p.tat, tat, "no second turn taken");
    // the same sender's next query takes a turn of its own
    const t2 = performance.now();
    await now.query(q);
    assert.ok(performance.now() - t2 >= p.every - 50);
  });
}));

// card near-quote-under-the-pace: the helper's FastNEAR seat (nearSeatRpc) at the key's pace, its keyless spare
const SEAT = NEAR_NETWORKS.mainnet.seat;
/** A key's pace as the helper holds it (5 a second, 5 at once, GCRA on the real clock): past it, 429 with Retry-After 1. */
const keyPace = (perSec = 5, burst = 5) => {
  let tat = 0;
  const every = 1000 / perSec;
  return () => {
    const now = performance.now();
    const t = Math.max(tat, now);
    if (t > now + (burst - 1) * every + 2) return false;
    tat = t + every;
    return true;
  };
};
const VIEW = { request_type: "view_account", finality: "final", account_id: "intents.near" };

test("the seat: 11 reads asked at once go out 5 at once, then one every 200 ms; the key never answers 429 and none goes to the keyless seat", () => onTestClock(async () => {
  const take = keyPace();
  const sent: number[] = [];
  // the timers the pace set that have fired by each send: work done, never real time elapsed, so a loaded runner's slow
  // work cannot fail the burst (the box at load 8, 13 Nov: "the first 5 at once" read real milliseconds)
  let fired = 0;
  const firedAt: number[] = [];
  const set = globalThis.setTimeout;
  globalThis.setTimeout = ((f: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => set((...x: unknown[]) => (fired++, f(...x)), ms, ...a)) as typeof setTimeout;
  let keyless = 0;
  let refused = 0;
  await withFetch((async (u: string) => {
    if (u === SEAT) {
      sent.push(performance.now());
      firedAt.push(fired);
      return take() ? answer() : (refused++, busy("1"));
    }
    keyless++;
    return answer();
  }) as typeof fetch, async () => {
    const rpc = P.nearSeatRpc("mainnet");
    assert.equal(rpc.name, SEAT);
    const t = performance.now();
    const all = await Promise.all(Array.from({ length: 11 }, () => rpc.query(VIEW)));
    assert.equal(all.length, 11);
    assert.equal(refused, 0, "the device's pace keeps under the key's");
    assert.equal(keyless, 0);
    assert.equal(sent.length, 11);
    // the first 5 at once: none waited on a pace timer; each later read not before its own 200 ms slot on the clock
    assert.deepEqual(firedAt.slice(0, 5), [0, 0, 0, 0, 0], "the first 5 at once");
    for (let k = 5; k < 11; k++) assert.ok(sent[k]! - t >= (k - 4) * 200 - 5, `read ${k} at ${sent[k]! - t} ms`);
  }).finally(() => void (globalThis.setTimeout = set));
}));

test("the seat falls to FastNEAR's keyless URL when the helper is busy past its tries, down (5xx), slow or unreachable; never on a 4xx or the caller's own abort", async () => {
  const cases: [string, () => Response | Promise<Response>, boolean][] = [
    // a hard cap on turns: past twice the bound the seat answers, so a loop with no bound fails here, never hangs
    ["429 past NEAR_BUSY_TRIES", (() => { let k = 0; return () => (++k > 2 * P.NEAR_BUSY_TRIES ? answer() : busy("0")); })(), true],
    ["503 upstream", () => new Response(JSON.stringify({ error: { code: "upstream" } }), { status: 503 }), true],
    ["502", () => new Response("bad gateway", { status: 502 }), true],
    ["no answer in time", () => Promise.reject(new DOMException("timed out", "TimeoutError")), true],
    ["unreachable", () => Promise.reject(new TypeError("fetch failed")), true],
    ["400 method_not_allowed", () => new Response(JSON.stringify({ error: { code: "method_not_allowed" } }), { status: 400 }), false],
    ["403", () => new Response("no", { status: 403 }), false],
  ];
  for (const [what, seatAnswer, falls] of cases) {
    P.resetPaces();
    let keyless = 0;
    let seat = 0;
    await withFetch((async (u: string) => (u === SEAT ? (seat++, seatAnswer()) : (keyless++, assert.equal(u, NEAR_NETWORKS.mainnet.fastnear[0]), answer()))) as typeof fetch, async () => {
      const rpc = P.nearSeatRpc("mainnet");
      if (falls) assert.deepEqual(await rpc.query(VIEW), { jsonrpc: "2.0", id: "blindfill", result: { ok: true } }, what);
      else await assert.rejects(rpc.query(VIEW), /HTTP 4/, what);
      assert.equal(keyless, falls ? 1 : 0, what);
      assert.equal(seat, what.startsWith("429") ? P.NEAR_BUSY_TRIES : 1, what);
      // the reserved turn falls the same way
      if (falls) assert.deepEqual(await (await rpc.reserve!()).query(VIEW), { jsonrpc: "2.0", id: "blindfill", result: { ok: true } }, `${what} (reserve)`);
    });
  }
  // the caller's own abort: thrown, the keyless seat never asked
  P.resetPaces();
  let keyless = 0;
  const stop = new AbortController();
  await withFetch((async (u: string, init?: RequestInit) => {
    if (u !== SEAT) return keyless++, answer();
    stop.abort(new Error("signed out"));
    throw init?.signal?.reason ?? new Error("aborted");
  }) as typeof fetch, async () => {
    await assert.rejects(P.nearSeatRpc("mainnet").query(VIEW, stop.signal), /signed out/);
    assert.equal(keyless, 0);
  });
  // testnet has no seat: FastNEAR's keyless URL itself
  assert.equal(P.nearSeatRpc("testnet").name, NEAR_NETWORKS.testnet.fastnear[0]);
});
