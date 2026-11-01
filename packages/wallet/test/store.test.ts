// The wallet store: WU-06 (docs/plan1/wallet.md:1045 at research ffcba5e): records are encrypted, the deposit counter
// only grows and is written before its index is handed out, two tabs run under Web Locks; no index used twice in
// 10,000 random runs.
//   node --test test/store.test.ts      (from packages/wallet)
// IndexedDB here is fake-indexeddb (one in-memory IDBFactory per test); WebCrypto, Web Locks and BroadcastChannel are
// Node's own. The same store in real Chromium on SIGN_HOST's origin: test/store.e2e.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, WALLET_LANES, type WalletEvent, type WalletStore } from "../src/store/index.ts";

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
  await s.put("meta", "seed", { v: 1, entropy: new Uint8Array(16), source: "random", code_saved: false });
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
  assert.deepEqual(await s.keys("meta"), ["seed", "settings"]);

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

test("a tab killed between 'counter reserved' and 'account used' never gets that index again", async () => {
  const idb = new IDBFactory();
  const a = await openWalletStore({ indexedDB: idb });
  const i = await a.reserveDepositIndex(SCOPE);
  a.close(); // the tab dies here: the index was handed out, its key never used
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

// WU-06's property: random tabs, random kills between reservation and use, random concurrency, with and without Web
// Locks. A run's reservations are checked across every tab and every reopen.
test("WU-06: no deposit index is handed out twice in 10,000 random runs", async () => {
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
        // now and then the tab dies while its reservation is in flight: any index it got still counts as handed out
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
        // kill a tab right after its reservation, before any use, and open a new one
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
