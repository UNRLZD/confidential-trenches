// node --test test/pace-tabs.test.ts: the page's NEAR paces are one budget for every tab of SIGN_HOST's origin (card
// signpage-near-pace-shared-across-tabs). Each tab had its own (src/pace.ts PACES, a module Map), so two tabs asked
// FastNEAR's keyless URL twice its 0.39 a second from one address, and a busy hold one tab met left the other asking.
// Two tabs here are two instances of src/pace.ts (one module record each, as two pages have), on one test clock, sharing
// one lock manager (Web Locks: one exclusive lock per name, granted in request order) and one storage (the page's
// IndexedDB database of its own, paceDb; here a Map, and fake-indexeddb for paceDb itself).
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";

type Pace = typeof import("../src/pace.ts");
type Share = { locks: { request(name: string, options: { signal?: AbortSignal }, fn: (lock: unknown) => unknown): Promise<unknown> }; storage: { get(k: string): Promise<string | null> | string | null; set(k: string, v: string): Promise<void> | void }; origin: number };
const FAST = NEAR_NETWORKS.mainnet.fastnear[0];
const answer = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "blindfill", result: { ok: true } }), { status: 200 });

let n = 0;
/** One tab: its own instance of src/pace.ts, on the shared lock and storage when given. */
async function tab(share: Share | null): Promise<Pace> {
  const P = (await import(new URL(`../src/pace.ts?tab=${++n}`, import.meta.url).href)) as Pace;
  const set = (P as Partial<{ sharePaces(s: Share | null): void }>).sharePaces;
  if (share !== null) set?.(share);
  return P;
}
/** Web Locks as the browser grants them: one holder of a name at a time, in request order; a holder's callback may wait;
 *  a request whose signal ends before it is granted rejects with the signal's reason and never runs (the next in line
 *  waits for the holder alone). `asked` counts the requests. Takes (name, fn) too, the form before the lock wait's bound. */
function locks(): Share["locks"] & { asked: number } {
  const tails = new Map<string, Promise<void>>();
  const l = {
    asked: 0,
    request(name: string, a: unknown, b?: unknown): Promise<unknown> {
      l.asked++;
      const [opts, fn] = (typeof a === "function" ? [{}, a] : [a ?? {}, b]) as [{ signal?: AbortSignal }, (lock: unknown) => unknown];
      const prev = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      tails.set(name, prev.then(() => mine));
      const sig = opts.signal;
      return new Promise((res, rej) => {
        let granted = false;
        const stop = () => void (granted || rej(sig!.reason));
        sig?.addEventListener("abort", stop, { once: true });
        void prev.then(async () => {
          if (sig?.aborted) return release();
          granted = true;
          sig?.removeEventListener("abort", stop);
          try {
            res(await fn({ name, mode: "exclusive" }));
          } catch (e) {
            rej(e);
          } finally {
            release();
          }
        });
      });
    },
  };
  return l;
}
function storage(): Share["storage"] & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}
const share = (): Share => ({ locks: locks(), storage: storage(), origin: 0 });

/** The sends' GCRA read at FastNEAR's pace: the most at one instant, the most in any 60 s, and the first send past the
 *  pace (null for none). */
function read(sends: number[], P: Pace, which: "fastnear" | "drpc" = "fastnear", slack = 1e-6) {
  const p = P.PACE[which];
  const every = 1000 / p.perSec;
  const s = [...sends].sort((a, b) => a - b);
  const most = (win: number) => { let m = 0, j = 0; for (let i = 0; i < s.length; i++) { while (s[i]! - s[j]! > win) j++; m = Math.max(m, i - j + 1); } return m; };
  let tat = -Infinity, past: number | null = null;
  for (const t of s) {
    if (past === null && tat !== -Infinity && t < tat - (p.burst - 1) * every - slack) past = t;
    tat = Math.max(tat, t) + every;
  }
  const span = (s.at(-1)! - s[0]!) / 1000;
  return { atOnce: most(0.001), in60: most(60_000), allowed60: p.burst + Math.floor(60_000 / every), in50: most(50), past, rate: span > 0 ? (s.length - p.burst) / span : Infinity };
}

test("two tabs asking FastNEAR at once send within its one pace: at most 8 at once, at most 31 in any 60 s (0.39 a second)", { timeout: 60_000 }, () => onTestClock(async () => {
  const sh = share();
  const [a, b] = [await tab(sh), await tab(sh)];
  const sends: number[] = [];
  const fs = [a, b].map((P) => P.pacedFetch(FAST, async () => (sends.push(performance.now()), answer())));
  await Promise.all(fs.flatMap((f) => Array.from({ length: 20 }, () => f(FAST))));
  const r = read(sends, a);
  assert.equal(sends.length, 40);
  const said = `two tabs sent ${r.atOnce} at one instant and ${r.in60} in 60 s (${r.rate.toFixed(2)} a second past the burst); FastNEAR's pace allows 8 and ${r.allowed60} (${a.PACE.fastnear.perSec} a second)`;
  assert.ok(r.atOnce <= 8 && r.in60 <= r.allowed60 && r.rate <= a.PACE.fastnear.perSec + 1e-9, said);
  assert.equal(r.past, null, `a send at ${r.past} ms past the pace`);
}));

test("a busy hold one tab meets holds FastNEAR for the other tab too", { timeout: 60_000 }, () => onTestClock(async () => {
  const sh = share();
  const [a, b] = [await tab(sh), await tab(sh)];
  const t0 = performance.now();
  a.paceHold(a.paceOf(FAST), t0, 8_000);
  const sends: number[] = [];
  await b.pacedFetch(FAST, async () => (sends.push(performance.now()), answer()))(FAST);
  assert.ok(sends[0]! - t0 >= 8_000, `the other tab sent ${sends[0]! - t0} ms into the 8000 ms hold`);
  // a 429 one tab's reader is answered (pacedNearRpc) holds the other tab's reads the same way
  const sh2 = share();
  const [e, f] = [await tab(sh2), await tab(sh2)];
  let k = 0;
  const real = globalThis.fetch;
  const sent: number[] = [];
  globalThis.fetch = (async () => (++k === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "5" } }) : answer())) as typeof fetch;
  try {
    const t1 = performance.now();
    const first = e.pacedNearRpc(FAST).query({ request_type: "view_account", finality: "final", account_id: "intents.near" });
    await new Promise((r) => setTimeout(r, 10));
    await f.pacedFetch(FAST, async () => (sent.push(performance.now()), answer()))(FAST);
    await first;
    assert.ok(sent[0]! - t1 >= 5_000, `the other tab sent ${sent[0]! - t1} ms after the 429 that named 5 s`);
  } finally {
    globalThis.fetch = real;
  }
}));

// The delta-review cases of src/pace.ts's header on the shared pace, across two tabs: waits ended in any order never send
// past the burst at once or the rate over 60 s (delta review 3, P2-1), an ended wait frees its turn so the next request
// waits at most one gap (delta review 4, P2-1), and a busy hold stands when a wait is ended (delta review 4, P3-1).
test("across two tabs, queued waits ended in any order keep the pace, free their turns, and a busy hold stands", { timeout: 120_000 }, () => onTestClock(async () => {
  for (const order of [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], [5, 0, 11, 3, 8, 1, 10, 2, 7, 4, 9, 6]]) {
    const sh = share();
    const tabs = [await tab(sh), await tab(sh)];
    const sends: number[] = [];
    const fs = tabs.map((P) => P.pacedFetch(FAST, async () => (sends.push(performance.now()), answer())));
    const all: Promise<unknown>[] = [];
    const fire = (i: number, signal?: AbortSignal) => void all.push(fs[i % 2]!(FAST, signal ? { signal } : undefined).catch(() => {}));
    for (let k = 0; k < 8; k++) fire(k);
    const cs = Array.from({ length: 12 }, () => new AbortController());
    cs.forEach((c, i) => fire(i, c.signal));
    for (const i of order) { await new Promise((r) => setTimeout(r, 700)); cs[i]!.abort(new Error("x")); fire(i + 1); }
    for (let k = 0; k < 20; k++) fire(k);
    await Promise.all(all);
    const r = read(sends, tabs[0]!);
    // 52 asked, 12 ended: each ended one sent only if its turn came before its end
    assert.ok(sends.length >= 40 && sends.length <= 52, `${order.join(",")}: ${sends.length} sent`);
    assert.equal(r.past, null, `${order.join(",")}: a send at ${r.past} ms past the pace`);
    assert.ok(r.atOnce <= 8, `${order.join(",")}: ${r.atOnce} at one instant`);
    assert.ok(r.in60 <= r.allowed60, `${order.join(",")}: ${r.in60} in 60 s`);
  }
  // one tab's burst and 20 queued waits ended on one signal: the other tab's next request waits at most one gap
  {
    const sh = share();
    const [a, b] = [await tab(sh), await tab(sh)];
    const sends: number[] = [];
    const c = new AbortController();
    const fa = a.pacedFetch(FAST, async () => (sends.push(performance.now()), answer()));
    const queued = Array.from({ length: 28 }, () => fa(FAST, { signal: c.signal }).catch(() => {}));
    await new Promise((r) => setTimeout(r, 100));
    c.abort(new Error("signed out"));
    await Promise.all(queued);
    assert.equal(sends.length, 8);
    const t0 = performance.now();
    await b.pacedFetch(FAST, async () => (sends.push(performance.now()), answer()))(FAST);
    const every = 1000 / a.PACE.fastnear.perSec;
    assert.ok(sends[8]! - t0 <= every, `the other tab's next request waited ${sends[8]! - t0} ms, over one gap of ${every} ms`);
  }
  // a busy hold during one tab's queue, then a queued wait ended: neither tab sends before the hold ends
  {
    const sh = share();
    const [a, b] = [await tab(sh), await tab(sh)];
    const sends: number[] = [];
    const fa = a.pacedFetch(FAST, async () => (sends.push(performance.now()), answer()));
    const fb = b.pacedFetch(FAST, async () => (sends.push(performance.now()), answer()));
    const t0 = performance.now();
    const cs = Array.from({ length: 11 }, () => new AbortController());
    const all = cs.map((c, i) => (i % 2 ? fa : fb)(FAST, { signal: c.signal }).catch(() => {}));
    await new Promise((r) => setTimeout(r, 10));
    a.paceHold(a.paceOf(FAST), performance.now(), 9_000);
    const end = performance.now() + 9_000;
    cs[10]!.abort(new Error("x"));
    all.push(fb(FAST).catch(() => {}));
    await Promise.all(all);
    assert.equal(sends.length, 11);
    // the burst's 8 went at 0 ms, before the hold; every later send waits it out, in either tab
    const after = sends.slice(8);
    assert.ok(after.length === 3 && after.every((t) => t >= end), `sent at ${after.join(", ")} ms, inside the hold that ends at ${end} ms`);
  }
}));

test("a tab whose shared storage throws, never answers or holds garbage keeps its pace and never fails a read", { timeout: 60_000 }, () => onTestClock(async () => {
  const refused = { get: () => { throw new DOMException("denied", "SecurityError"); }, set: () => Promise.reject(new DOMException("full", "QuotaExceededError")) };
  const silent = { get: () => new Promise<null>(() => {}), set: () => new Promise<void>(() => {}) }; // an open another tab blocks
  for (const storage of [refused, silent]) {
    const P = await tab({ locks: locks(), storage, origin: 0 });
    const sends: number[] = [];
    const f = P.pacedFetch(FAST, async () => (sends.push(performance.now()), answer()));
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 10 }, () => f(FAST)));
    assert.equal(sends.length, 10);
    assert.equal(read(sends, P).past, null);
    // a storage that fails or never answers costs one turn SHARE_STORAGE_MS at most, then the tab keeps its own pace:
    // its burst of 8 goes at once after that one wait, never one turn of SHARE_STORAGE_MS each
    assert.ok(sends[0]! - t0 <= P.SHARE_STORAGE_MS, `the first read waited ${sends[0]! - t0} ms`);
    assert.ok(sends[7]! - t0 <= P.SHARE_STORAGE_MS, `the burst's last read waited ${sends[7]! - t0} ms`);
  }
  const junk = storage();
  // the last: a record 1e13 ms ahead of the clock, past any hold the page sets (a clock moved back, a broken write)
  for (const v of ["{", "null", '{"tat":"x","floor":1e400}', '{"tat":-1,"floor":[]}', '{"tat":1e13,"floor":0}']) {
    junk.map.set(`ct-pace:${FAST}`, v);
    const Q = await tab({ locks: locks(), storage: junk, origin: 0 });
    const asked = performance.now();
    let at = -1;
    await Q.pacedFetch(FAST, async () => ((at = performance.now()), answer()))(FAST);
    assert.equal(at, asked, `${v}: the first read waited (the test clock moves only by a wait set)`);
  }
}));

// paceDb itself, apart from any clock (fake-indexeddb answers on the event loop, which the test clock may skip past to
// SHARE_STORAGE_MS): a record one tab's instance writes is the one another tab's reads, in a database of its own
test("paceDb: the shared records live in an IndexedDB database of their own, ct-pace, one string per URL, read by every tab's instance", async () => {
  const idb = new IDBFactory();
  const [a, b] = [await tab(null), await tab(null)];
  const [da, db] = [a.paceDb(idb), b.paceDb(idb)];
  assert.equal(await db.get(`ct-pace:${FAST}`), null);
  await da.set(`ct-pace:${FAST}`, '{"tat":1,"floor":0}');
  assert.equal(await db.get(`ct-pace:${FAST}`), '{"tat":1,"floor":0}');
  await db.set(`ct-pace:${FAST}`, '{"tat":2,"floor":0}');
  assert.equal(await da.get(`ct-pace:${FAST}`), '{"tat":2,"floor":0}');
  assert.equal(await da.get(`ct-pace:${NEAR_NETWORKS.mainnet.drpc}`), null);
  assert.deepEqual((await idb.databases()).map((d) => d.name), [a.PACE_DB]);
  assert.equal(a.PACE_DB, "ct-pace");
});

// The lock's own wait is bounded too. A tab holding a URL's lock whose timers stop (a throttled or frozen
// tab mid-callback, a devtools pause) would otherwise hold every NEAR read of every tab for as long, and no storage
// bound ever runs. A turn waits SHARE_LOCK_MS at most to be granted the lock, then takes the tab's own pace, as a
// storage fault does, and asks the lock no more; a busy hold's write-through is bounded the same way.
test("a lock another tab never releases: the turn goes on this tab's own pace within SHARE_LOCK_MS, and later turns never ask the lock", { timeout: 60_000 }, () => onTestClock(async () => {
  const sh = share() as Share & { locks: ReturnType<typeof locks> };
  const [a, b] = [await tab(sh), await tab(sh)];
  void b;
  // the other tab holds FastNEAR's lock and never lets go
  void sh.locks.request(`ct-pace:${FAST}`, {}, () => new Promise(() => {}));
  const sends: number[] = [];
  const f = a.pacedFetch(FAST, async () => (sends.push(performance.now()), answer()));
  const t0 = performance.now();
  const bound = (a as Partial<{ SHARE_LOCK_MS: number }>).SHARE_LOCK_MS ?? 3_000;
  const first = f(FAST);
  await Promise.race([first, new Promise((r) => setTimeout(r, 30_000))]);
  assert.equal(sends.length, 1, "the read is sent, never held by the other tab's lock");
  assert.ok(sends[0]! <= t0 + bound, `sent at ${sends[0]} ms, past the lock's bound at ${t0 + bound} ms`);
  const asked = sh.locks.asked;
  await Promise.all(Array.from({ length: 9 }, () => f(FAST)));
  assert.equal(sends.length, 10);
  assert.equal(sh.locks.asked, asked, "later turns ask no lock");
  assert.equal(read(sends, a).past, null, "the tab's own pace holds");
  // a busy hold written through while the lock is held never waits on it: the tab's own hold stands
  const [c] = [await tab(sh)];
  const p = c.paceOf(FAST);
  c.paceHold(p, performance.now(), 5_000);
  const at = performance.now();
  const got: number[] = [];
  await c.pacedFetch(FAST, async () => (got.push(performance.now()), answer()))(FAST);
  assert.ok(got[0]! >= at + 5_000 && got[0]! <= at + 5_000 + bound, `sent at ${got[0]} ms, the hold ends at ${at + 5_000} ms`);
  // the caller's own end of a wait for the lock is thrown as it is and keeps the share: the next turn asks the lock again
  const sh2 = share() as Share & { locks: ReturnType<typeof locks> };
  const d = await tab(sh2);
  let release!: () => void;
  void sh2.locks.request(`ct-pace:${FAST}`, {}, () => new Promise<void>((r) => (release = r)));
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("signed out")), 100);
  const fd = d.pacedFetch(FAST, async () => answer());
  await assert.rejects(fd(FAST, { signal: stop.signal }), /^Error: signed out$/);
  const before = sh2.locks.asked;
  release();
  await fd(FAST);
  assert.equal(sh2.locks.asked, before + 1, "still shared: the next turn asked the lock");
}));
