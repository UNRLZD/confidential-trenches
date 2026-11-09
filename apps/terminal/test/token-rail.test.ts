// The token page's left rail's data (card app-token-rail, src/screens/token/rail.ts): Discover's read of every chain's
// lists (card app-chains-evm-rail), one read for every caller in flight (the rail, the top-token read of / and
// Discover), kept across a page hop (an unsubscribe and a subscribe at once read nothing new), read again on Discover's
// cadence, a failed read keeping the last good lists; the rail narrows them to the shell's chain filter (pickSnapshot).
// test/discover-data/helper-lists-2026-11-01.json is a recorded answer of GET /v1/market/lists?chain=solana,
// test/chains-evm/lists-{base,robinhood}-2026-11-09.json of ?chain=base and ?chain=robinhood.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIST_CHAINS, listsUrl, pickSnapshot, REFRESH_MS, sharedAllLists, STALE_MS } from "../src/screens/discover/data.ts";
import type { MarketSnapshot } from "../src/screens/discover/fields.ts";
import { columnRows } from "../src/screens/discover/model.ts";
import { railStore } from "../src/screens/token/rail.ts";
import lists from "./discover-data/helper-lists-2026-11-01.json" with { type: "json" };
import baseRec from "./chains-evm/lists-base-2026-11-09.json" with { type: "json" };
import robinhoodRec from "./chains-evm/lists-robinhood-2026-11-09.json" with { type: "json" };

type Rec = { chain: string; as_of_ms: number; fields: string[]; lists: Record<string, unknown[][]> };
const answerOf = (rec: Rec) => ({ chain: rec.chain, as_of_ms: rec.as_of_ms, lists: Object.fromEntries(Object.entries(rec.lists).map(([k, rows]) => [k, rows.map((v) => Object.fromEntries(rec.fields.map((f, i) => [f, v[i]])))])) });
const RECS: Record<string, Rec> = { solana: lists as Rec, base: baseRec as Rec, robinhood: robinhoodRec as Rec };
const answer = () => answerOf(lists as Rec);

/** A fetch that answers each chain's lists URL with its recording after `gate` resolves, and counts its calls. */
function fakeFetch(gate: Promise<void> = Promise.resolve()) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    await gate;
    const rec = RECS[new URL(String(url)).searchParams.get("chain") ?? ""];
    if (!rec) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(answerOf(rec)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("sharedAllLists: callers while a read is in flight share its one read of every chain; a later call reads again", async () => {
  let open!: () => void;
  const f = fakeFetch(new Promise<void>((r) => (open = r)));
  const a = sharedAllLists(f.fn);
  const b = sharedAllLists(f.fn);
  assert.equal(a, b);
  open();
  const [sa, sb] = await Promise.all([a, b]);
  assert.deepEqual(f.calls, LIST_CHAINS.map(listsUrl), "one read of each chain's lists");
  assert.equal(sa, sb);
  assert.ok(sa.lists.trending.length > 0 && sa.lists.new.length > 0);
  await sharedAllLists(f.fn);
  assert.equal(f.calls.length, 2 * LIST_CHAINS.length, "a call after the read ended is a new read");
});

test("sharedAllLists: another fetch is another read (a test's own fetch never takes the page's answer)", async () => {
  const f1 = fakeFetch();
  const f2 = fakeFetch();
  await Promise.all([sharedAllLists(f1.fn), sharedAllLists(f2.fn)]);
  assert.equal(f1.calls.length, LIST_CHAINS.length);
  assert.equal(f2.calls.length, LIST_CHAINS.length);
});

test("railStore: its own read is every chain's lists (sharedAllLists); the rail on a pick draws only that chain's rows, on All every chain's in Discover's order", async () => {
  const real = globalThis.fetch;
  const f = fakeFetch();
  globalThis.fetch = f.fn;
  try {
    const store = railStore({ every: () => () => {} });
    const off = store.subscribe(() => {});
    for (let i = 0; i < 20 && store.get().data.status === "loading"; i++) await new Promise((r) => setImmediate(r));
    off();
    const d = store.get().data;
    assert.equal(d.status, "ready");
    if (d.status !== "ready") return;
    assert.deepEqual([...f.calls].sort(), LIST_CHAINS.map(listsUrl).sort(), "the store read Solana, Base and Robinhood");
    assert.equal(d.snapshot.chain, "all");
    for (const list of ["trending", "new"] as const) {
      const all = columnRows(pickSnapshot(d.snapshot, "all"), list);
      assert.deepEqual(new Set(all.map((r) => r.chain)), new Set(LIST_CHAINS), `${list} on All: rows of every chain`);
      assert.deepEqual(all, columnRows(d.snapshot, list), `${list} on All: Discover's own order (columnRows of the merged lists)`);
      for (const c of LIST_CHAINS) {
        const one = columnRows(pickSnapshot(d.snapshot, c), list);
        assert.ok(one.length > 0, `${list} on ${c}: rows drawn`);
        assert.ok(one.every((r) => r.chain === c), `${list} on ${c}: only ${c} rows`);
        assert.deepEqual(one.map((r) => r.token), all.filter((r) => r.chain === c).map((r) => r.token), `${list} on ${c}: the All order, narrowed`);
      }
    }
  } finally {
    globalThis.fetch = real;
  }
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
