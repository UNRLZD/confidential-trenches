// The wallet store: WU-06 (docs/plan1/wallet.md:1045 at research ffcba5e): records are encrypted, the deposit counter
// only grows and is written before its index is handed out, two tabs run under Web Locks; no index used twice in
// 10,000 random runs.
//   node --test test/store.test.ts      (from packages/wallet)
// IndexedDB here is fake-indexeddb (one in-memory IDBFactory per test); WebCrypto, Web Locks and BroadcastChannel are
// Node's own. The same store in real Chromium on SIGN_HOST's origin: test/store.e2e.mjs.
// What "kill" means here: Node has no tab to crash, so a "closed store" below is store.close(), which drops the
// connection and the channel and stops the store answering; it stands in for a dead tab only in that the reserved
// index is never used. A real kill is store.e2e.mjs's: CDP Page.crash takes the renderer down after the reservation.
// That the index is durable before it is returned is checked here directly, by aborting the counter's commit.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { backupFirst, openWalletStore as openStore, openWalletStoreReader, WALLET_LANES, WALLET_LOCK, type WalletEvent, type WalletStore, type WalletStoreOptions } from "../src/store/index.ts";

// every store a test opens is closed at the end, so a failing assertion fails the run instead of leaving it hanging on
// an open BroadcastChannel
const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));
async function openWalletStore(o: WalletStoreOptions): Promise<WalletStore> {
  const s = await openStore(o);
  opened.push(s);
  return s;
}

const SCOPE = 0x2a5f0e3c1d9b7a6e4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a291807060504n;
const SCOPE2 = 7n;

function rawGet(idb: IDBFactory, name: string, store: string, key: string): Promise<unknown> {
  return new Promise((ok, no) => {
    const o = idb.open(name);
    o.onerror = () => no(o.error);
    o.onsuccess = () => {
      const r = o.result.transaction(store, "readonly").objectStore(store).get(key);
      r.onsuccess = () => (o.result.close(), ok(r.result));
      r.onerror = () => no(r.error);
    };
  });
}
function rawPut(idb: IDBFactory, name: string, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((ok, no) => {
    const o = idb.open(name);
    o.onerror = () => no(o.error);
    o.onsuccess = () => {
      const tx = o.result.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => (o.result.close(), ok());
      tx.onerror = () => no(tx.error);
    };
  });
}
const contains = (hay: Uint8Array, needle: Uint8Array): boolean =>
  hay.some((_, i) => needle.every((b, j) => hay[i + j] === b));

test("records are wrapped under a non-extractable K_wrap with aad store/key", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  const note = { scope: SCOPE, value: 1_000_000n, state: "PLANNED", precommitment: new Uint8Array([1, 2, 3, 250]), tag: "MARKER-plain-text" };
  await s.put("notes", "n1", note);
  assert.deepEqual(await s.get("notes", "n1"), note);

  const raw = (await rawGet(idb, "ct-wallet", "notes", "n1")) as { iv: Uint8Array; ct: ArrayBuffer };
  assert.deepEqual(Object.keys(raw).sort(), ["ct", "iv"]);
  assert.equal(raw.iv.length, 12);
  assert.ok(!contains(new Uint8Array(raw.ct), new TextEncoder().encode("MARKER")), "plaintext in the stored record");
  assert.ok(!contains(new Uint8Array(raw.ct), new TextEncoder().encode("PLANNED")), "plaintext in the stored record");

  const k = (await rawGet(idb, "ct-wallet", "meta", "k_wrap")) as CryptoKey;
  assert.equal(k.extractable, false);
  assert.equal(k.algorithm.name, "AES-GCM");
  await assert.rejects(crypto.subtle.exportKey("raw", k));
  const lane = (await rawGet(idb, "ct-wallet", "meta", "lane")) as { iv: Uint8Array };
  assert.ok(lane.iv instanceof Uint8Array, "the lane is wrapped too");

  // a record moved to another key, or one changed bit, does not open
  await rawPut(idb, "ct-wallet", "notes", "n2", raw);
  await assert.rejects(s.get("notes", "n2"));
  await rawPut(idb, "ct-wallet", "wallets", "n1", raw);
  await assert.rejects(s.get("wallets", "n1"));
  const flipped = new Uint8Array(raw.ct.slice(0));
  flipped[0] = (flipped[0] as number) ^ 1;
  await rawPut(idb, "ct-wallet", "notes", "n3", { iv: raw.iv, ct: flipped.buffer });
  await assert.rejects(s.get("notes", "n3"));

  // the seed record keeps 06b's aad
  await s.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "random", code_saved: false });
  const seedRaw = await rawGet(idb, "ct-wallet", "meta", "seed");
  await rawPut(idb, "ct-wallet", "meta", "settings", seedRaw);
  await assert.rejects(s.get("meta", "settings"));

  // K_wrap and the lane stay the store's; counters move only by reservation
  await assert.rejects(s.get("meta", "k_wrap"));
  await assert.rejects(s.put("meta", "k_wrap", 1));
  await assert.rejects(s.put("meta", "lane", 0));
  await assert.rejects(s.put("counters", `i/${SCOPE}`, { next: 0 }));
  await assert.rejects(s.delete("counters", `i/${SCOPE}`));
  await assert.rejects(s.put("notes", "x", { [`$bigint`]: "1" }));
  assert.deepEqual(await s.keys("meta"), ["seed", "settings", "status"]);

  // a second tab opens the same K_wrap and lane
  const t = await openWalletStore({ indexedDB: idb });
  assert.equal(t.lane, s.lane);
  assert.deepEqual(await t.get("notes", "n1"), note);
  s.close();
  t.close();
});

test("the deposit counter keeps to the lane, only grows and survives a reopen", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  const d = s.lane;
  assert.ok(d >= 0 && d < WALLET_LANES);
  assert.equal(await s.reserveDepositIndex(SCOPE), d);
  assert.equal(await s.reserveDepositIndex(SCOPE), d + 8);
  assert.equal(await s.reserveDepositIndex(SCOPE2), d, "each scope has its own counter");
  s.close();
  const r = await openWalletStore({ indexedDB: idb });
  assert.equal(r.lane, d);
  assert.equal(await r.reserveDepositIndex(SCOPE), d + 16);
  r.close();
  await assert.rejects(r.reserveDepositIndex(SCOPE), /closed/);
});

test("a store closed between 'counter reserved' and 'account used' never gets that index again (close, not a crash)", async () => {
  const idb = new IDBFactory();
  const a = await openWalletStore({ indexedDB: idb });
  const i = await a.reserveDepositIndex(SCOPE);
  a.close(); // the store goes away here: the index was handed out, its key never used
  const b = await openWalletStore({ indexedDB: idb });
  const j = await b.reserveDepositIndex(SCOPE);
  assert.notEqual(j, i);
  assert.equal(j, i + 8);
  b.close();
});

for (const locks of [undefined, null] as const) {
  test(`two tabs racing for one counter get different values (${locks === null ? "no Web Locks, the transaction alone" : "Web Locks"})`, async () => {
    const idb = new IDBFactory();
    const a = await openWalletStore({ indexedDB: idb, locks });
    const b = await openWalletStore({ indexedDB: idb, locks });
    const got = await Promise.all(Array.from({ length: 200 }, (_, k) => (k % 2 ? a : b).reserveDepositIndex(SCOPE)));
    assert.equal(new Set(got).size, got.length, "an index was handed out twice");
    assert.deepEqual([...got].sort((x, y) => x - y), got.map((_, k) => a.lane + 8 * k));
    a.close();
    b.close();
  });
}

test("sign out broadcasts, closes the other tab and deletes the database", async () => {
  const idb = new IDBFactory();
  const seen: WalletEvent[] = [];
  const a = await openWalletStore({ indexedDB: idb });
  const b = await openWalletStore({ indexedDB: idb, onEvent: (e) => seen.push(e) });
  await a.put("notes", "n1", { v: 1 });
  await a.signOut();
  await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(seen.some((e) => e.kind === "signout"));
  await assert.rejects(b.get("notes", "n1"), /closed/);
  assert.deepEqual(await idb.databases(), []);
  b.close();
  const c = await openWalletStore({ indexedDB: idb });
  assert.equal(await c.get("notes", "n1"), undefined);
  c.close();
});

// WU-06's property: random tabs, random closes (during and after a reservation, before any use), random concurrency,
// with and without Web
// Locks. A run's reservations are checked across every tab and every reopen.
test("WU-06: no deposit index is handed out twice in 10,000 random runs (stores closed, not crashed)", async () => {
  let seed = 0x9e3779b9;
  const rnd = (n: number): number => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    return (seed >>> 0) % n;
  };
  const RUNS = 10_000;
  let reservations = 0;
  for (let run = 0; run < RUNS; run++) {
    const idb = new IDBFactory();
    const locks = rnd(2) ? undefined : null;
    const tabs: WalletStore[] = [];
    for (let t = 0, n = 1 + rnd(3); t < n; t++) tabs.push(await openWalletStore({ indexedDB: idb, locks }));
    const lane = tabs[0]!.lane;
    const seen = new Map<bigint, Set<number>>([[SCOPE, new Set()], [SCOPE2, new Set()]]);
    for (let step = 0, steps = 1 + rnd(4); step < steps; step++) {
      const killed = new Set<number>();
      const batch = Array.from({ length: 1 + rnd(3) }, () => {
        const scope = rnd(4) ? SCOPE : SCOPE2;
        const t = rnd(tabs.length);
        const p = tabs[t]!.reserveDepositIndex(scope).then((i) => [scope, i] as const);
        // now and then the store is closed while its reservation is in flight: any index it got still counts as out
        if (rnd(8) === 0) (tabs[t]!.close(), killed.add(t));
        return p.catch(() => null);
      });
      for (const k of killed) tabs[k] = await openWalletStore({ indexedDB: idb, locks });
      for (const got of await Promise.all(batch)) {
        if (got === null) continue;
        const [scope, i] = got;
        assert.equal(i % WALLET_LANES, lane, `run ${run}: index ${i} is outside lane ${lane}`);
        assert.ok(!seen.get(scope)!.has(i), `run ${run}: index ${i} handed out twice`);
        seen.get(scope)!.add(i);
        reservations++;
      }
      if (rnd(3) === 0) {
        // close a store right after its reservation, before any use, and open a new one
        const k = rnd(tabs.length);
        tabs[k]!.close();
        tabs[k] = await openWalletStore({ indexedDB: idb, locks });
        assert.equal(tabs[k]!.lane, lane);
      }
    }
    for (const t of tabs) t.close();
  }
  assert.ok(reservations > RUNS);
});

// Round 2 (independent review of e63bb39).

// The store owns its lock: a caller that holds the old paper's "ct-wallet" lock (06b:743-744) around a reservation
// must not hang it (Web Locks are not re-entrant).
test("a caller holding the 'ct-wallet' lock around a reservation does not hang it", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  const got = await navigator.locks.request("ct-wallet", () =>
    Promise.race([s.reserveDepositIndex(SCOPE), new Promise((ok) => setTimeout(() => ok("hung"), 2000))]),
  );
  assert.equal(got, s.lane);
  assert.equal(WALLET_LOCK, "ct-wallet/counters");
});

// Fault injection on fake-indexeddb: `when` picks the object store call to break, `fault` breaks it.
async function withFault<T>(
  method: "put" | "get",
  when: (os: { name: string; transaction: IDBTransaction }) => boolean,
  body: () => Promise<T>,
): Promise<T> {
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto[method]!;
  proto[method] = function (this: { name: string; transaction: IDBTransaction }, ...a: unknown[]) {
    const r = orig.apply(this, a);
    if (when(this)) this.transaction.abort();
    return r;
  };
  try {
    return await body();
  } finally {
    proto[method] = orig;
  }
}

test("an index is returned only after its counter commits: an aborted commit rejects the reservation", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  await withFault("put", (os) => os.name === "counters", () => assert.rejects(s.reserveDepositIndex(SCOPE)));
  // nothing was written and nothing went out, so the lane's first index is still the next
  assert.equal(await s.reserveDepositIndex(SCOPE), s.lane);
  assert.equal(await s.reserveDepositIndex(SCOPE), s.lane + 8);
});

test("a counter transaction that aborts during its read leaves no unhandled rejection", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  const loose: unknown[] = [];
  const on = (e: unknown): void => void loose.push(e);
  process.on("unhandledRejection", on);
  try {
    await withFault("get", (os) => os.name === "counters" && os.transaction.mode === "readwrite", () =>
      assert.rejects(s.reserveDepositIndex(SCOPE)),
    );
    await new Promise((ok) => setTimeout(ok, 50));
  } finally {
    process.off("unhandledRejection", on);
  }
  assert.equal(loose.length, 0, `unhandled: ${String(loose[0])}`);
});

for (const locks of [undefined, null] as const) {
  test(`three tabs opening at once share one K_wrap and one lane (${locks === null ? "no Web Locks" : "Web Locks"})`, async () => {
    for (let round = 0; round < 20; round++) {
      const idb = new IDBFactory();
      const tabs = await Promise.all([0, 1, 2].map(() => openWalletStore({ indexedDB: idb, locks })));
      await Promise.all(tabs.map((t, i) => t.put("notes", `t${i}`, { i })));
      for (const t of tabs) {
        assert.equal(t.lane, tabs[0]!.lane);
        for (let i = 0; i < 3; i++) assert.deepEqual(await t.get("notes", `t${i}`), { i }, `round ${round}`);
      }
      for (const t of tabs) t.close();
    }
  });
}

test("a closed store's sign out refuses, so it never deletes a newer account's database", async () => {
  // b: shut by a's sign out broadcast only; b2: also closed by close()
  for (const closeIt of [false, true]) {
    const idb = new IDBFactory();
    const a = await openWalletStore({ indexedDB: idb });
    const b = await openWalletStore({ indexedDB: idb });
    await a.signOut();
    await new Promise((ok) => setTimeout(ok, 20));
    if (closeIt) b.close();
    const c = await openWalletStore({ indexedDB: idb });
    await c.insertSeed({ v: 1 });
    await assert.rejects(b.signOut(), /wallet store is closed/);
    await new Promise((ok) => setTimeout(ok, 20));
    assert.deepEqual(await c.get("meta", "seed"), { v: 1 }, `close() called: ${closeIt}`);
  }
});

test("the record codec refuses every value it would change", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  class Thing {
    x = 1;
  }
  const bad: [string, unknown][] = [
    ["Date", new Date(0)], ["Map", new Map()], ["Set", new Set()], ["ArrayBuffer", new ArrayBuffer(2)],
    ["Uint16Array", new Uint16Array(2)], ["Buffer", Buffer.from([1])], ["undefined", undefined], ["NaN", NaN],
    ["Infinity", Infinity], ["-0", -0], ["undefined field", { a: undefined }], ["undefined item", [undefined]],
    ["hole", [1, , 2]], ["class instance", new Thing()], ["symbol key", { [Symbol("s")]: 1 }],
    ["function", { f: () => 1 }], ["tag key", { $bigint: "1" }], ["nested Date", { a: [{ d: new Date(0) }] }],
  ];
  for (const [what, v] of bad) await assert.rejects(s.put("notes", "x", v), Error, `${what} was accepted`);
  assert.equal(await s.get("notes", "x"), undefined);
  const good = { a: null, b: true, c: "s", d: 1.5, e: -3, f: 2n ** 200n, g: new Uint8Array([0, 255]), h: [1, [2, { i: "j" }]] };
  await s.put("notes", "x", good);
  assert.deepEqual(await s.get("notes", "x"), good);
});

test("raiseDepositIndex never lowers the counter and keeps the lane (restore step 7)", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  const d = s.lane;
  const up = 100 + ((((d - 100) % 8) + 8) % 8); // the lane's first index at or past 100
  assert.equal(await s.raiseDepositIndex(SCOPE, 100), up);
  assert.equal(await s.reserveDepositIndex(SCOPE), up);
  assert.equal(await s.raiseDepositIndex(SCOPE, 3), up + 8, "a lower minimum changes nothing");
  assert.equal(await s.raiseDepositIndex(SCOPE, up + 8), up + 8);
  assert.equal(await s.reserveDepositIndex(SCOPE), up + 8);
  for (const m of [-1, 1.5, 2 ** 32, NaN]) await assert.rejects(s.raiseDepositIndex(SCOPE, m));
  // racing with reservations in other tabs: no index twice, every one in the lane
  const t = await openWalletStore({ indexedDB: idb });
  const got = await Promise.all(
    Array.from({ length: 60 }, (_, k) => (k % 3 === 0 ? s.raiseDepositIndex(SCOPE, 200 + k).then(() => null) : (k % 2 ? s : t).reserveDepositIndex(SCOPE))),
  );
  const idx = got.filter((x): x is number => x !== null);
  assert.equal(new Set(idx).size, idx.length);
  assert.ok(idx.every((i) => i % 8 === d && i > up + 8));
  assert.ok((await s.reserveDepositIndex(SCOPE)) >= 200 + 57);
});

// Round 3 (re-check of 59c8b3c).

test("the record codec refuses an own __proto__ key and keeps constructor and prototype as plain keys", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  const answer = JSON.parse('{"__proto__":{"x":1},"a":1}'); // a reply parsed as received has __proto__ as an own key
  await assert.rejects(s.put("quotes", "q", answer), /__proto__/);
  await assert.rejects(s.put("quotes", "q", { deep: [answer] }), /__proto__/);
  assert.equal(await s.get("quotes", "q"), undefined);
  // assignment makes these own keys and changes nothing, so they round-trip as they are
  const plain = JSON.parse('{"constructor":{"y":2},"prototype":3,"a":1}');
  await s.put("quotes", "q", plain);
  assert.deepEqual(await s.get("quotes", "q"), plain);
});

test("raiseDepositIndex refuses a min whose lane index is past 2^32 - 1, before any write", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  const d = s.lane;
  const top = 0xffffffff - ((((0xffffffff - d) % 8) + 8) % 8); // the lane's last u32 index
  assert.equal(await s.raiseDepositIndex(SCOPE, top), top);
  // 2^32 - 1 is in lane 7; in every other lane it rounds up past the last u32 index (lane 7 has no such min)
  if (top < 0xffffffff) await assert.rejects(s.raiseDepositIndex(SCOPE, 0xffffffff), /past 2\^32 - 1/);
  assert.equal(await s.reserveDepositIndex(SCOPE), top, "the refused raises wrote nothing");
});

test("insertSeed writes the seed only when none is stored: two tabs that both read 'no seed' never write over each other", async () => {
  const idb = new IDBFactory();
  const a = await openWalletStore({ indexedDB: idb });
  const b = await openWalletStore({ indexedDB: idb });
  assert.equal(await a.get("meta", "seed"), undefined);
  assert.equal(await b.get("meta", "seed"), undefined);
  const A = { entropy: new Uint8Array(16).fill(1), source: "prf", code_saved: false };
  const B = { entropy: new Uint8Array(16).fill(2), source: "prf", code_saved: false };
  const [ra, rb] = await Promise.all([a.insertSeed(A), b.insertSeed(B)]);
  assert.equal([ra.inserted, rb.inserted].filter(Boolean).length, 1, "exactly one tab inserts");
  const winner = ra.inserted ? A : B;
  assert.deepEqual(ra.seed, winner);
  assert.deepEqual(rb.seed, winner);
  assert.deepEqual(await a.get("meta", "seed"), winner);
  assert.deepEqual(await b.get("meta", "seed"), winner);
  // a later insert never replaces it either
  const again = await a.insertSeed({ entropy: new Uint8Array(16).fill(3), source: "prf", code_saved: false });
  assert.equal(again.inserted, false);
  assert.deepEqual(again.seed, winner);
});

test("the seed record is never written by put or removed by delete: insertSeed and setCodeSaved only", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  await assert.rejects(s.put("meta", "seed", { entropy: new Uint8Array(16), source: "prf", code_saved: false }), /insertSeed and setCodeSaved only/);
  await s.insertSeed({ entropy: new Uint8Array(16).fill(7), source: "random", code_saved: false });
  await assert.rejects(s.put("meta", "seed", { entropy: new Uint8Array(16).fill(8), source: "prf", code_saved: true }), /insertSeed and setCodeSaved only/);
  await assert.rejects(s.delete("meta", "seed"), /insertSeed and setCodeSaved only/);
  assert.deepEqual(await s.get("meta", "seed"), { entropy: new Uint8Array(16).fill(7), source: "random", code_saved: false });
  // setCodeSaved changes code_saved only
  await s.setCodeSaved({ entropy: new Uint8Array(16).fill(7) });
  assert.deepEqual(await s.get("meta", "seed"), { entropy: new Uint8Array(16).fill(7), source: "random", code_saved: true });
  await s.setCodeSaved({ entropy: new Uint8Array(16).fill(7) });
  assert.deepEqual(await s.get("meta", "seed"), { entropy: new Uint8Array(16).fill(7), source: "random", code_saved: true });
  await assert.rejects((await openWalletStore({ indexedDB: new IDBFactory() })).setCodeSaved({ entropy: new Uint8Array(16).fill(7) }), /no seed is stored/);
  // settings stay writable
  await s.put("meta", "settings", { x: 1 });
  assert.deepEqual(await s.get("meta", "settings"), { x: 1 });
});

// card signpage-frame-state: meta/"status" = { v: 1, source, code_saved }, the seed's public facts with no secret, is the
// store's own record, written in the seed's own transaction; SIGN_HOST's frame reads it through openWalletStoreReader.
function rawDelete(idb: IDBFactory, name: string, store: string, key: string): Promise<void> {
  return new Promise((ok, no) => {
    const o = idb.open(name);
    o.onerror = () => no(o.error);
    o.onsuccess = () => {
      const tx = o.result.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => (o.result.close(), ok());
      tx.onerror = () => no(tx.error);
    };
  });
}
/** Runs body with every put of `key` aborting its transaction. */
async function failingPut<T>(key: string, body: () => Promise<T>): Promise<T> {
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto.put!;
  proto.put = function (this: { transaction: IDBTransaction }, ...a: unknown[]) {
    const r = orig.apply(this, a);
    if (a[1] === key) this.transaction.abort();
    return r;
  };
  try {
    return await body();
  } finally {
    proto.put = orig;
  }
}
const SEED = (code_saved = false) => ({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "random", code_saved, created_ms: 1 });

test("setCodeSaved marks only the seed whose 12 words were shown: another seed stored since is refused, unchanged", async () => {
  const idb = new IDBFactory();
  const a = await openWalletStore({ indexedDB: idb });
  const shownS1 = new Uint8Array(16).fill(0x11);
  // S1 was shown in one tab; meanwhile another tab signed S1 out and stored S2, whose words were never shown here
  await a.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x22), source: "random", code_saved: false, created_ms: 2 });
  await assert.rejects(a.setCodeSaved({ entropy: shownS1 }), /not the seed shown/);
  assert.equal(((await a.get("meta", "seed")) as { code_saved: boolean }).code_saved, false, "S2 marked saved by S1's Saved");
  assert.equal(((await a.get("meta", "status")) as { code_saved: boolean }).code_saved, false);
  await assert.rejects(a.signOut(), /back up the 12 words/);
  // the words shown are S2's: marked
  await a.setCodeSaved({ entropy: new Uint8Array(16).fill(0x22) });
  assert.equal(((await a.get("meta", "seed")) as { code_saved: boolean }).code_saved, true);
  // a call naming no seed, or not 16 bytes, is refused before any read
  await assert.rejects(a.setCodeSaved(undefined as never), /the seed shown/);
  await assert.rejects(a.setCodeSaved({ entropy: new Uint8Array(15) }), /the seed shown/);
});

test("status: insertSeed and setCodeSaved write it with the seed, in one transaction; no caller puts or deletes it", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  // the status's put fails: the seed is not written either
  await failingPut("status", () => assert.rejects(s.insertSeed(SEED())));
  assert.equal(await s.get("meta", "seed"), undefined);
  assert.equal(await s.get("meta", "status"), undefined);
  await s.insertSeed(SEED());
  assert.deepEqual(await s.get("meta", "status"), { v: 1, source: "random", code_saved: false });
  await failingPut("status", () => assert.rejects(s.setCodeSaved(SEED())));
  assert.equal(((await s.get("meta", "seed")) as { code_saved: boolean }).code_saved, false);
  await s.setCodeSaved(SEED());
  assert.equal(((await s.get("meta", "seed")) as { code_saved: boolean }).code_saved, true);
  assert.deepEqual(await s.get("meta", "status"), { v: 1, source: "random", code_saved: true });
  await assert.rejects(s.put("meta", "status", { v: 1, source: "prf", code_saved: true }), /is the store's own/);
  await assert.rejects(s.delete("meta", "status"), /is the store's own/);
});

test("a versionchange that closes the store's connection is an event: \"closed\"", async () => {
  const idb = new IDBFactory();
  const seen: WalletEvent[] = [];
  const s = await openWalletStore({ indexedDB: idb, onEvent: (e) => seen.push(e) });
  await new Promise<void>((ok, no) => {
    const r = idb.deleteDatabase("ct-wallet");
    r.onsuccess = () => ok();
    r.onerror = () => no(r.error);
  });
  assert.deepEqual(seen, [{ kind: "closed" }]);
  await assert.rejects(s.get("meta", "seed"), /closed/);
});

test("syncStatus: writes a missing or behind status from the seed, and nothing with no seed", async () => {
  const idb = new IDBFactory();
  const seen: WalletEvent[] = [];
  const s = await openWalletStore({ indexedDB: idb });
  const other = await openWalletStore({ indexedDB: idb, onEvent: (e) => seen.push(e) });
  await s.syncStatus();
  assert.equal(await s.get("meta", "status"), undefined);
  await s.insertSeed(SEED());
  const early = await rawGet(idb, "ct-wallet", "meta", "status");
  await s.setCodeSaved(SEED());
  // a database from before the status record: none stored
  await rawDelete(idb, "ct-wallet", "meta", "status");
  seen.length = 0;
  await s.syncStatus();
  assert.deepEqual(await other.get("meta", "status"), { v: 1, source: "random", code_saved: true });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(seen.some((e) => e.kind === "changed" && e.stores.includes("meta")), JSON.stringify(seen));
  // a status behind the seed (code_saved false while the seed says true): brought up
  await rawPut(idb, "ct-wallet", "meta", "status", early);
  assert.deepEqual(await s.get("meta", "status"), { v: 1, source: "random", code_saved: false });
  await s.syncStatus();
  assert.deepEqual(await s.get("meta", "status"), { v: 1, source: "random", code_saved: true });
});

test("openWalletStoreReader: makes no database, writes nothing, reads records and keys, hears a delete", async () => {
  const idb = new IDBFactory();
  assert.equal(await openWalletStoreReader({ indexedDB: idb }), null);
  assert.deepEqual(await idb.databases(), [], "no database was made");
  // a database with its stores but no K_wrap yet: nothing to read
  await new Promise<void>((ok, no) => {
    const r = idb.open("ct-wallet", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("meta");
    r.onsuccess = () => (r.result.close(), ok());
    r.onerror = () => no(r.error);
  });
  assert.equal(await openWalletStoreReader({ indexedDB: idb }), null);
  await new Promise<void>((ok, no) => {
    const r = idb.deleteDatabase("ct-wallet");
    r.onsuccess = () => ok();
    r.onerror = () => no(r.error);
  });
  const s = await openWalletStore({ indexedDB: idb });
  await s.insertSeed(SEED(true));
  await s.put("ops", "op1", { kind: "deposit", stage: "waiting", txs: [] });
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const writes: string[] = [];
  const saved = Object.fromEntries(["put", "add", "delete", "clear"].map((m) => [m, proto[m]!]));
  for (const m of Object.keys(saved)) proto[m] = function (this: { name: string }, ...a: unknown[]) {
    writes.push(`${m} ${this.name}`);
    return saved[m]!.apply(this, a);
  };
  const seen: WalletEvent[] = [];
  let r;
  try {
    r = await openWalletStoreReader({ indexedDB: idb, onEvent: (e) => seen.push(e) });
    assert.ok(r);
    assert.deepEqual(await r.keys("meta"), ["seed", "status"]);
    assert.deepEqual(await r.get("meta", "status"), { v: 1, source: "random", code_saved: true });
    assert.deepEqual(await r.get("ops", "op1"), { kind: "deposit", stage: "waiting", txs: [] });
    await assert.rejects(r.get("meta", "k_wrap"));
    // the frame's reader opens meta/status, meta/deposit/<scope> and ops only: never the seed, nor a note or a wallet
    assert.equal(await r.get("meta", "deposit/7"), undefined);
    for (const [st, k] of [["meta", "seed"], ["meta", "settings"], ["meta", "deposit"], ["meta", "deposit/07"], ["meta", "deposit/x"], ["notes", "n1"]] as const) {
      await assert.rejects(r.get(st, k), /meta\/status, meta\/deposit\/<scope> and ops only/, `${st}/${k}`);
    }
  } finally {
    for (const m of Object.keys(saved)) proto[m] = saved[m]!;
  }
  assert.deepEqual(writes, []);
  // another tab's sign out deletes the database: the reader closes and says so
  await s.signOut();
  assert.ok(seen.some((e) => e.kind === "closed"), JSON.stringify(seen));
  await assert.rejects(r.keys("meta"), /closed/);
  assert.equal(await openWalletStoreReader({ indexedDB: idb }), null);
});

test("sign out refuses while a no-PRF seed's 12 words are the only copy and not saved (wallet.md:922)", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  for (const source of ["random", "code", "wallet"]) assert.equal(backupFirst({ source, code_saved: false }), true, source);
  assert.equal(backupFirst({ source: "prf", code_saved: false }), false);
  assert.equal(backupFirst({ source: "random", code_saved: true }), false);
  assert.equal(backupFirst({ source: "random" }), true, "a missing code_saved is not saved");
  assert.equal(backupFirst(undefined), false);
  await s.insertSeed({ entropy: new Uint8Array(16).fill(5), source: "random", code_saved: false });
  await assert.rejects(s.signOut(), /back up the 12 words/);
  // nothing was deleted and the store still answers
  assert.deepEqual(await s.get("meta", "seed"), { entropy: new Uint8Array(16).fill(5), source: "random", code_saved: false });
  assert.deepEqual(await rawKeys(idb), true);
  await s.setCodeSaved({ entropy: new Uint8Array(16).fill(5) });
  await s.signOut();
  assert.deepEqual(await rawKeys(idb), false);
  // a PRF seed signs out with code_saved false: the passkey gives the words back
  const p = await openWalletStore({ indexedDB: idb });
  await p.insertSeed({ entropy: new Uint8Array(16).fill(6), source: "prf", code_saved: false });
  await p.signOut();
  assert.deepEqual(await rawKeys(idb), false);
});
async function rawKeys(idb: IDBFactory): Promise<boolean> {
  return (await idb.databases()).some((d) => d.name === "ct-wallet");
}

// The plaintext buffers (a seed record's hold its entropy as hex) are zeroed once used, also when a step fails
// (round 4's review, P3): the bytes wrap hands to encrypt, and the bytes decrypt hands back to unwrap.
test("wrap's encoded plaintext and unwrap's decrypted buffer are zeroed after use, on error paths too", async () => {
  const subtle = globalThis.crypto.subtle;
  const realEncrypt = subtle.encrypt;
  const realDecrypt = subtle.decrypt;
  const given: Uint8Array[] = [];
  const got: ArrayBuffer[] = [];
  let failEncrypt = false;
  let garble = false;
  subtle.encrypt = (async (alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => {
    given.push(data as Uint8Array);
    if (failEncrypt) throw new Error("planted encrypt failure");
    return realEncrypt.call(subtle, alg, key, data);
  }) as SubtleCrypto["encrypt"];
  subtle.decrypt = (async (alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) => {
    const out = await realDecrypt.call(subtle, alg, key, data);
    if (garble) new Uint8Array(out).set(new TextEncoder().encode("{not json"));
    got.push(out);
    return out;
  }) as SubtleCrypto["decrypt"];
  const zero = (b: ArrayBuffer | Uint8Array): boolean => (b instanceof Uint8Array ? b : new Uint8Array(b)).every((x) => x === 0);
  try {
    const s = await openWalletStore({ indexedDB: new IDBFactory() });
    given.length = 0;
    got.length = 0;
    const entropy = new Uint8Array(16).fill(0xab);
    await s.insertSeed({ v: 1, entropy, source: "prf", code_saved: false });
    assert.ok(given.length >= 1 && got.length >= 1, "insertSeed wrapped and read back");
    // the seed's plaintext held its entropy as hex until it was wiped
    for (const b of given) assert.ok(zero(b), "wrap's plaintext not zeroed");
    for (const b of got) assert.ok(zero(b), "unwrap's plaintext not zeroed");
    await s.setCodeSaved({ entropy: new Uint8Array(16).fill(0xab) });
    await s.get("meta", "seed");
    await s.put("notes", "n1", { precommitment: new Uint8Array(32).fill(7) });
    await s.get("notes", "n1");
    for (const b of given) assert.ok(zero(b), "wrap's plaintext not zeroed");
    for (const b of got) assert.ok(zero(b), "unwrap's plaintext not zeroed");
    // error paths: encrypt fails, decode fails
    given.length = 0;
    failEncrypt = true;
    await assert.rejects(s.put("notes", "n2", { secret: new Uint8Array(16).fill(9) }), /planted encrypt failure/);
    failEncrypt = false;
    assert.equal(given.length, 1);
    assert.ok(zero(given[0] as Uint8Array), "wrap's plaintext not zeroed when encrypt failed");
    got.length = 0;
    garble = true;
    await assert.rejects(s.get("meta", "seed"));
    garble = false;
    assert.equal(got.length, 1);
    assert.ok(zero(got[0] as ArrayBuffer), "unwrap's plaintext not zeroed when decode failed");
  } finally {
    subtle.encrypt = realEncrypt;
    subtle.decrypt = realDecrypt;
  }
});

// card signpage-deposit-quote-wire: the public copy of the deposit source's one unfunded index, meta/"deposit/<scope>"
// { v, scope, index, id }, written on SIGN_HOST's top-level page so the API never opens the seed. The index is the note
// store's PLANNED deposit note's (planDeposit); nameDeposit reserves nothing (wallet.md §2.3 the deposit index rule).
const HEXID = (i: number) => i.toString(16).padStart(64, "0");
test("nameDeposit: writes the scope's record for the seed shown, reserves nothing, refuses another seed", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  const shown = () => ({ entropy: new Uint8Array(16).fill(0x7f) });
  await assert.rejects(s.nameDeposit(shown(), { scope: SCOPE, index: 3, id: HEXID(3) }), /no seed is stored/);
  await s.insertSeed(SEED(true));
  const first = await s.nameDeposit(shown(), { scope: SCOPE, index: s.lane, id: HEXID(1) });
  assert.deepEqual(first, { v: 1, scope: SCOPE.toString(), index: s.lane, id: HEXID(1) });
  // nothing reserved: the counter still hands out the lane's first index
  assert.equal(await s.reserveDepositIndex(SCOPE), s.lane);
  // one record per scope
  const other = await s.nameDeposit(shown(), { scope: SCOPE2, index: 9, id: HEXID(9) });
  assert.deepEqual(await s.get("meta", `deposit/${SCOPE}`), first);
  assert.deepEqual(await s.get("meta", "deposit/7"), other);
  // the reader reads them, never the seed
  const r = await openWalletStoreReader({ indexedDB: idb });
  assert.ok(r);
  assert.deepEqual(await r.get("meta", `deposit/${SCOPE}`), first);
  r.close();
  // the index moved on (the note left PLANNED): the record follows
  const moved = await s.nameDeposit(shown(), { scope: SCOPE, index: s.lane + WALLET_LANES, id: HEXID(2) });
  assert.equal(moved.index, s.lane + WALLET_LANES);
  // another seed than the one stored: refused, the record left as it is
  await assert.rejects(s.nameDeposit({ entropy: new Uint8Array(16).fill(1) }, { scope: SCOPE, index: 0, id: HEXID(0) }), /not the seed shown/);
  assert.deepEqual(await s.get("meta", `deposit/${SCOPE}`), moved);
  // the record is the store's own: no caller puts or deletes it
  await assert.rejects(s.put("meta", `deposit/${SCOPE}` as never, first), /store's own/);
  await assert.rejects(s.delete("meta", `deposit/${SCOPE}` as never), /store's own/);
  // bad input writes nothing
  for (const bad of [{ scope: SCOPE, index: 0, id: "U" }, { scope: SCOPE, index: -1, id: HEXID(0) }, { scope: SCOPE, index: 2 ** 32, id: HEXID(0) }, { scope: -1n, index: 0, id: HEXID(0) }]) {
    await assert.rejects(s.nameDeposit(shown(), bad));
  }
  await assert.rejects(s.nameDeposit({ entropy: new Uint8Array(15) }, { scope: SCOPE, index: 0, id: HEXID(0) }), /the seed shown/);
  assert.deepEqual(await s.get("meta", `deposit/${SCOPE}`), moved);
});

test("nameDeposit: the record is written only by a compare on the seed record: a seed changed before it is read again", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  await s.insertSeed(SEED(true));
  // the first compare finds another seed record (a stale tab's write) and aborts, leaving the seed as it was; the next
  // pass reads and checks the seed again before it writes
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto.get!;
  let fired = 0;
  proto.get = function (this: { transaction: IDBTransaction; name: string; put: (v: unknown, k: string) => unknown }, ...a: unknown[]) {
    if (fired === 0 && this.name === "meta" && a[0] === "seed" && this.transaction.mode === "readwrite") {
      fired++;
      this.put({ iv: new Uint8Array(12).fill(9), ct: new ArrayBuffer(16) }, "seed");
    }
    return orig.apply(this, a);
  };
  try {
    const rec = await s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: SCOPE, index: s.lane, id: HEXID(5) });
    assert.equal(fired, 1);
    assert.equal(rec.id, HEXID(5));
  } finally {
    proto.get = orig;
  }
  assert.deepEqual(await s.get("meta", "seed"), SEED(true), "the aborted compare left the seed as it was");
});

// card signpage-withdraw-own-spend: a withdraw's owed sends (attempt, context) live in "owed", which the frame's reader
// never opens; a database from before it (version 1) is upgraded at the next top-level open
test("the owed store: a version 1 database gets it at the next open, and the frame's reader refuses to read it", async () => {
  const idb = new IDBFactory();
  await new Promise<void>((ok, no) => {
    const r = idb.open("ct-wallet", 1);
    r.onupgradeneeded = () => {
      for (const s of ["notes", "wallets", "quotes", "orders", "ops", "counters", "meta"]) r.result.createObjectStore(s);
    };
    r.onsuccess = () => (r.result.close(), ok());
    r.onerror = () => no(r.error);
  });
  const s = await openWalletStore({ indexedDB: idb });
  await s.insertSeed(SEED(true));
  await s.put("owed", "op1", { n1: { noteId: "n1", context: "7" } });
  assert.deepEqual(await s.get("owed", "op1"), { n1: { noteId: "n1", context: "7" } });
  const reader = (await openWalletStoreReader({ indexedDB: idb }))!;
  assert.ok(reader, "the reader opens the upgraded database");
  await assert.rejects(reader.get("owed", "op1"), /reader opens meta\/status, meta\/deposit\/<scope> and ops only/);
  reader.close();
  s.close();
});

test("the frame's reader opens a database with no owed store (one from before it): it never needs it", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  await s.insertSeed(SEED(true));
  await s.put("ops", "op1", { kind: "deposit", stage: "waiting", txs: [] });
  s.close();
  // the same database with its owed store taken away, as a version 1 database lacks it
  await new Promise<void>((ok, no) => {
    const r = idb.open("ct-wallet", 3);
    r.onupgradeneeded = () => r.result.deleteObjectStore("owed");
    r.onsuccess = () => (r.result.close(), ok());
    r.onerror = () => no(r.error);
  });
  const reader = await openWalletStoreReader({ indexedDB: idb });
  assert.ok(reader, "the reader still opens it");
  assert.deepEqual(await reader!.keys("ops"), ["op1"]);
  reader!.close();
});

// fold 2 (review MEDIUM 3): the store opens the database at its own version and goes one up only for a store it is
// missing, so a release never meets a version it cannot open (a VersionError locked every signing until a deploy)
const versionOf = (idb: IDBFactory): Promise<number> =>
  new Promise((ok, no) => {
    const r = idb.open("ct-wallet");
    r.onsuccess = () => {
      const v = r.result.version;
      r.result.close();
      ok(v);
    };
    r.onerror = () => no(r.error);
  });
test("a database a later release took to a higher version, with a store this one does not know, opens with every record kept", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb });
  await s.insertSeed(SEED(true));
  await s.put("ops", "op1", { kind: "deposit", stage: "waiting", txs: [] });
  s.close();
  await new Promise<void>((ok, no) => {
    const r = idb.open("ct-wallet", 7);
    r.onupgradeneeded = () => r.result.createObjectStore("later");
    r.onsuccess = () => (r.result.close(), ok());
    r.onerror = () => no(r.error);
  });
  const again = await openWalletStore({ indexedDB: idb });
  assert.deepEqual(await again.get("ops", "op1"), { kind: "deposit", stage: "waiting", txs: [] });
  assert.equal(await versionOf(idb), 7, "opened at its own version, never up");
  again.close();
});
test("a new database holds every store at version 1; one from before owed goes to version 2 once; two tabs opening it at once both open", async () => {
  const fresh = new IDBFactory();
  (await openWalletStore({ indexedDB: fresh })).close();
  assert.equal(await versionOf(fresh), 1);
  const old = new IDBFactory();
  await new Promise<void>((ok, no) => {
    const r = old.open("ct-wallet", 1);
    r.onupgradeneeded = () => {
      for (const s of ["notes", "wallets", "quotes", "orders", "ops", "counters", "meta"]) r.result.createObjectStore(s);
    };
    r.onsuccess = () => (r.result.close(), ok());
    r.onerror = () => no(r.error);
  });
  const [a, b] = await Promise.all([openWalletStore({ indexedDB: old, locks: null }), openWalletStore({ indexedDB: old, locks: null })]);
  await a.put("owed", "op1", { n1: { noteId: "n1" } });
  a.close();
  b.close();
  assert.equal(await versionOf(old), 2);
  const c = await openWalletStore({ indexedDB: old });
  assert.deepEqual(await c.get("owed", "op1"), { n1: { noteId: "n1" } });
  c.close();
  assert.equal(await versionOf(old), 2, "no step up when every store is there");
});
