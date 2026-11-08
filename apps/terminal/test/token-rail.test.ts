// The token page's left rail's data (card app-token-rail, src/screens/token/rail.ts): Discover's lists read, one request
// for every caller in flight (the rail and the top-token read of /), kept across a page hop (an unsubscribe and a
// subscribe at once read nothing new), read again on Discover's cadence, a failed read keeping the last good lists.
// test/discover-data/helper-lists-2026-11-01.json is a recorded answer of GET /v1/market/lists?chain=solana.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HELPER_URL, REFRESH_MS, STALE_MS } from "../src/screens/discover/data.ts";
import type { MarketSnapshot } from "../src/screens/discover/fields.ts";
import { railStore, sharedLists } from "../src/screens/token/rail.ts";
import lists from "./discover-data/helper-lists-2026-11-01.json" with { type: "json" };

const unzip = (values: readonly unknown[]) => Object.fromEntries(lists.fields.map((f, i) => [f, values[i]]));
const answer = () => ({ chain: lists.chain, as_of_ms: lists.as_of_ms, lists: Object.fromEntries(Object.entries(lists.lists).map(([k, rows]) => [k, rows.map(unzip)])) });

/** A fetch that answers the lists URL with the recording after `gate` resolves, and counts its calls. */
function fakeFetch(gate: Promise<void> = Promise.resolve()) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    await gate;
    return new Response(JSON.stringify(answer()), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("sharedLists: callers while a read is in flight share its one request; a later call reads again", async () => {
  let open!: () => void;
  const f = fakeFetch(new Promise<void>((r) => (open = r)));
  const a = sharedLists(f.fn);
  const b = sharedLists(f.fn);
  assert.equal(a, b);
  open();
  const [sa, sb] = await Promise.all([a, b]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls, [HELPER_URL]);
  assert.equal(sa, sb);
  assert.ok(sa.lists.trending.length > 0 && sa.lists.new.length > 0);
  await sharedLists(f.fn);
  assert.equal(f.calls.length, 2, "a call after the read ended is a new read");
});

test("sharedLists: another fetch is another read (a test's own fetch never takes the page's answer)", async () => {
  const f1 = fakeFetch();
  const f2 = fakeFetch();
  await Promise.all([sharedLists(f1.fn), sharedLists(f2.fn)]);
  assert.equal(f1.calls.length, 1);
  assert.equal(f2.calls.length, 1);
});

/** A store on a hand clock and a hand timer. */
function rig(results: (() => Promise<MarketSnapshot>)[]) {
  let t = 1_000_000;
  let reads = 0;
  const timers = new Set<() => void>();
  const store = railStore({
    read: () => results[Math.min(reads++, results.length - 1)]!(),
    now: () => t,
    every: (fn) => {
      timers.add(fn);
      return () => timers.delete(fn);
    },
  });
  return {
    store,
    reads: () => reads,
    tick: async (ms: number) => {
      t += ms;
      for (const f of [...timers]) f();
      await new Promise((r) => setImmediate(r));
    },
    timers: () => timers.size,
  };
}
const ok = () => Promise.resolve(answer() as unknown as MarketSnapshot);
const fail = () => Promise.reject(new Error("lists answered 503"));
const settle = () => new Promise((r) => setImmediate(r));

test("railStore: loading until the first read, then the lists; no read and no timer while nobody listens", async () => {
  const r = rig([ok]);
  assert.equal(r.store.get().data.status, "loading");
  assert.equal(r.reads(), 0);
  const off = r.store.subscribe(() => {});
  assert.equal(r.reads(), 1);
  await settle();
  assert.equal(r.store.get().data.status, "ready");
  off();
  assert.equal(r.timers(), 0, "the timer stops with the last listener");
});

test("railStore: a page hop (unsubscribe, subscribe at once) keeps the lists and reads nothing new", async () => {
  const r = rig([ok]);
  const off = r.store.subscribe(() => {});
  await settle();
  const before = r.store.get();
  off();
  r.store.subscribe(() => {});
  assert.equal(r.reads(), 1, "no second read on the hop");
  assert.equal(r.store.get(), before, "the same lists drawn, no skeleton");
});

test("railStore: read again every REFRESH_MS; a failed read keeps the last good lists until STALE_MS, then the error state", async () => {
  const r = rig([ok, fail]);
  const seen: string[] = [];
  r.store.subscribe(() => seen.push(r.store.get().data.status));
  await settle();
  await r.tick(REFRESH_MS);
  assert.equal(r.reads(), 2);
  assert.equal(r.store.get().data.status, "ready", "a blip keeps the lists");
  await r.tick(STALE_MS);
  assert.equal(r.store.get().data.status, "error");
  assert.deepEqual(seen, ["ready", "ready", "error"]);
});

test("railStore: a failed first read is the error state at once; retry reads again from loading, then on the cadence", async () => {
  const r = rig([fail, ok]);
  const off = r.store.subscribe(() => {});
  await settle();
  assert.equal(r.store.get().data.status, "error", "no good read yet: the error state at once");
  off();
  const states: string[] = [];
  r.store.subscribe(() => states.push(r.store.get().data.status));
  r.store.retry();
  assert.equal(r.store.get().data.status, "loading");
  await settle();
  assert.equal(r.store.get().data.status, "ready");
  assert.deepEqual(states, ["loading", "ready"]);
  await r.tick(REFRESH_MS);
  assert.equal(r.reads(), 3);
});
