// node --test test/pace.test.ts: one pace per provider URL for the whole page (src/pace.ts, card wallet-id-reader-paced).
// Delta review 2 of 71cb1284: P1, a request waits for its slot under its caller's own signal only and its deadline starts
// when the slot comes (before, the readers' 10 s deadline ran in the pace queue, so the fourth request queued on
// FastNEAR's 2.56 s gap timed out unsent and four chains at once stalled for good); P3-1, every reader of the page is on
// pacedFetch by default.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
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
test("five FastNEAR chains at once on the page's pace: every request answered, none timed out in the queue", { timeout: 60_000 }, async () => {
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
});

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
test("five FastNEAR chains at once on relayRpc.block and pacedNearRpc: every request answered", { timeout: 60_000 }, async () => {
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
});

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
