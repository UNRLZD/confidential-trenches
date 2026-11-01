// A stale tab's sign out never deletes another account's database (card wallet-passkey-prf, round 4; the reviewer's
// planted cases). Three tabs on one origin: A and B hold the same signed-in store, C is a new tab that stores a new seed
// whose 12 words are its only copy (source "random", code_saved false). Whatever order the tabs' steps land in, one
// sign out deletes, the other refuses ("closed"), exactly one delete is sent, and C's seed is there at the end.
// Web Locks here are Node's own navigator.locks (Node 24), the same API the browser gives the page.
//   node --test test/store-race.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, WALLET_SEED_LOCK, type WalletStore } from "../src/store/index.ts";

const PRF = { v: 1, entropy: new Uint8Array(16).fill(1), source: "prf", code_saved: false };
const RANDOM = { v: 1, entropy: new Uint8Array(16).fill(2), source: "random", code_saved: false };
const sleep = (ms: number): Promise<"timeout"> => new Promise((ok) => setTimeout(() => ok("timeout"), ms));
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "deleted",
    (e: Error) => `refused: ${e.message}`,
  );

// the factory with deleteDatabase counted, and a hook run synchronously inside the first call
function counted(idb: IDBFactory, onFirst: () => void = () => {}): { idb: IDBFactory; deletes: () => number; first: Promise<void> } {
  let n = 0;
  let firstDone = (): void => {};
  const first = new Promise<void>((ok) => (firstDone = ok));
  const real = idb.deleteDatabase.bind(idb);
  idb.deleteDatabase = (name: string) => {
    const r = real(name);
    if (++n === 1) {
      onFirst();
      firstDone();
    }
    return r;
  };
  return { idb, deletes: () => n, first };
}

// B's first decrypt (its sign out reading the seed) runs `during` and waits for `until` (at most 300 ms: with the seed
// lock, B holds it and A cannot get there)
function gateDecrypt(during: () => void, until: () => Promise<unknown>): () => void {
  const subtle = globalThis.crypto.subtle;
  const real = subtle.decrypt;
  let gate = true;
  subtle.decrypt = (async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
    const out = await real.apply(subtle, args);
    if (gate) {
      gate = false;
      during();
      await Promise.race([until(), sleep(300)]);
    }
    return out;
  }) as SubtleCrypto["decrypt"];
  return () => (subtle.decrypt = real);
}

async function seedAtEnd(idb: IDBFactory, name: string): Promise<{ source?: string } | undefined> {
  const d = await openWalletStore({ indexedDB: idb, name });
  try {
    return (await d.get("meta", "seed")) as { source?: string } | undefined;
  } finally {
    d.close();
  }
}

test("a store closed while its sign out awaits the backup check never deletes a newer account's database", async () => {
  const name = "race-1";
  const { idb, deletes } = counted(new IDBFactory());
  const a = await openWalletStore({ indexedDB: idb, name });
  await a.insertSeed(PRF);
  const b = await openWalletStore({ indexedDB: idb, name });
  // while B awaits its decrypt: A signs out, then C opens and stores its seed
  let aOut: Promise<string> = Promise.resolve("not run");
  let cDone: Promise<string> = Promise.resolve("not run");
  const restore = gateDecrypt(
    () => {
      aOut = outcome(a.signOut());
      cDone = aOut.then(async () => {
        const c = await openWalletStore({ indexedDB: idb, name });
        try {
          await c.insertSeed(RANDOM);
          return "stored";
        } catch (e) {
          return `failed: ${(e as Error).message}`;
        } finally {
          c.close();
        }
      });
    },
    () => cDone,
  );
  let bOut: string;
  try {
    bOut = await outcome(b.signOut());
  } finally {
    restore();
  }
  const outs = [await aOut, bOut].sort();
  const c = await cDone;
  a.close();
  b.close();
  const seed = await seedAtEnd(idb, name);
  assert.equal(c, "stored", `C: ${c}`);
  assert.deepEqual(outs.map((o) => o.split(":")[0]), ["deleted", "refused"], `A and B: ${outs.join(" | ")}`);
  assert.match(outs[1] as string, /wallet store is closed/);
  assert.equal(deletes(), 1, "one delete only");
  assert.equal(seed?.source, "random", "C's seed, the only copy of its 12 words, was deleted by a stale sign out");
});

test("A's delete queued, B past its liveness check, C's open queued before B's delete: B never deletes", async () => {
  const name = "race-2";
  let cOpen: Promise<WalletStore> | null = null;
  // C's open is queued synchronously inside the first delete call, so it sits between that delete and any later one
  const { idb, deletes, first } = counted(new IDBFactory(), () => {
    cOpen = openWalletStore({ indexedDB: idb, name });
    cOpen.catch(() => {});
  });
  const a = await openWalletStore({ indexedDB: idb, name });
  await a.insertSeed(PRF);
  const b = await openWalletStore({ indexedDB: idb, name });
  let aOut: Promise<string> = Promise.resolve("not run");
  // B's decrypt has its answer; A's sign out runs to its delete; B resumes at once (no task in between, so B's
  // versionchange from A's delete has not run yet)
  const restore = gateDecrypt(
    () => (aOut = outcome(a.signOut())),
    () => first,
  );
  let bOut: string;
  try {
    bOut = await outcome(b.signOut());
  } finally {
    restore();
  }
  const outs = [await aOut, bOut].sort();
  let c = "not opened";
  if (cOpen) {
    try {
      const cs = await (cOpen as Promise<WalletStore>);
      try {
        await cs.insertSeed(RANDOM);
        c = "stored";
      } finally {
        cs.close();
      }
    } catch (e) {
      c = `failed: ${(e as Error).message}`;
    }
  }
  a.close();
  b.close();
  const seed = await seedAtEnd(idb, name);
  assert.equal(deletes(), 1, `deletes sent: ${deletes()} (A and B: ${outs.join(" | ")}; C: ${c})`);
  assert.deepEqual(outs.map((o) => o.split(":")[0]), ["deleted", "refused"], `A and B: ${outs.join(" | ")}`);
  assert.equal(c, "stored", `C: ${c}`);
  assert.equal(seed?.source, "random", "C's seed is gone");
});

// the seed lock's state now: "held" or "free", without waiting for it
const seedLock = (name: string): Promise<string> =>
  navigator.locks.request(`${WALLET_SEED_LOCK}/${name}`, { ifAvailable: true }, async (l) => (l ? "free" : "held")) as Promise<string>;

test("a delete blocked by a connection that never closes holds the seed lock until the delete completes", async () => {
  const name = "race-blocked";
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb, name });
  await s.insertSeed(PRF);
  // a connection with no versionchange handler: it never closes on its own
  const x = await new Promise<IDBDatabase>((ok, no) => {
    const r = idb.open(name);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  let blocked = false;
  const real = idb.deleteDatabase.bind(idb);
  idb.deleteDatabase = (n: string) => {
    const r = real(n);
    r.addEventListener("blocked", () => (blocked = true));
    return r;
  };
  let done = false;
  const out = s.signOut().then(() => (done = true));
  for (let i = 0; i < 100 && !blocked; i++) await sleep(10);
  assert.equal(blocked, true, "the delete reported blocked");
  await sleep(200);
  assert.equal(await seedLock(name), "held", "the seed lock was given back while the delete was blocked");
  assert.equal(done, false, "sign out resolved before its delete");
  x.close();
  await out;
  assert.equal(await seedLock(name), "free", "the seed lock is freed once the delete completes");
  const dbs = await idb.databases();
  assert.equal(dbs.some((d) => d.name === name), false, "the database is deleted once the blocker closes");
});

// Chromium fires blocked at a delete as soon as one connection reports it ignored the versionchange
// (connection_coordinator.cc:102-105, :700-705), which a connection closed mid-transaction does at once
// (idb_database.cc:301-305), so blocked can come before another tab has had its versionchange. The model: stale tab D
// hears A's sign out late (its versionchange and the "signout" message reach it LATE ms after they are sent), so A's
// delete reports blocked while D is still open; D's sign out is waiting on the seed lock; C's open is queued behind A's
// delete. D must refuse, one delete is sent, and C's seed stays. (The reviewer's model, round 4.)
const LATE = 200;
test("blocked before stale tab D has heard the sign out (Chromium): D refuses, one delete, C's seed stays", async () => {
  const name = "race-early-blocked";
  let cOpen: Promise<WalletStore> | null = null;
  let blocked = 0;
  const { idb, deletes } = counted(new IDBFactory(), () => {
    cOpen = openWalletStore({ indexedDB: idb, name });
    cOpen.catch(() => {});
  });
  const realDelete = idb.deleteDatabase.bind(idb);
  idb.deleteDatabase = (n: string) => {
    const r = realDelete(n);
    r.addEventListener("blocked", () => blocked++);
    return r;
  };
  const a = await openWalletStore({ indexedDB: idb, name });
  await a.insertSeed(PRF);
  // D's connection and channel deliver late
  const realOpen = idb.open.bind(idb);
  const RealChannel = globalThis.BroadcastChannel;
  idb.open = (n: string, v?: number) => {
    const r = realOpen(n, v);
    r.addEventListener("success", () => {
      const c = r.result;
      const send = c.dispatchEvent.bind(c);
      c.dispatchEvent = (e: Event) => (e.type === "versionchange" ? (setTimeout(() => send(e), LATE), true) : send(e));
    });
    return r;
  };
  globalThis.BroadcastChannel = class extends RealChannel {
    set onmessage(fn: ((m: MessageEvent) => void) | null) {
      super.onmessage = fn && ((m: MessageEvent) => void setTimeout(() => fn.call(this, m), LATE));
    }
  };
  let d: WalletStore;
  try {
    d = await openWalletStore({ indexedDB: idb, name });
  } finally {
    idb.open = realOpen;
    globalThis.BroadcastChannel = RealChannel;
  }
  const aOut = outcome(a.signOut());
  const dOut = outcome(d.signOut());
  const outs = [await aOut, await dOut];
  let c = "not opened";
  if (cOpen) {
    try {
      const cs = await (cOpen as Promise<WalletStore>);
      try {
        await cs.insertSeed(RANDOM);
        c = "stored";
      } finally {
        cs.close();
      }
    } catch (e) {
      c = `failed: ${(e as Error).message}`;
    }
  }
  await sleep(2 * LATE);
  a.close();
  d.close();
  const seed = await seedAtEnd(idb, name);
  assert.ok(blocked >= 1, "A's delete never reported blocked: the model did not run");
  assert.equal(outs[0], "deleted", `A: ${outs[0]}`);
  assert.match(outs[1] as string, /^refused: .*wallet store is closed/, `D: ${outs[1]}`);
  assert.equal(deletes(), 1, `deletes sent: ${deletes()} (A, D: ${outs.join(" | ")}; C: ${c})`);
  assert.equal(c, "stored", `C: ${c}`);
  assert.equal(seed?.source, "random", "C's seed, the only copy of its 12 words, was deleted by a stale sign out");
});

test("with no Web Locks, sign out, insertSeed and setCodeSaved refuse: never unlocked", async () => {
  const idb = new IDBFactory();
  const s = await openWalletStore({ indexedDB: idb, name: "nolocks", locks: null });
  await assert.rejects(s.insertSeed(PRF), /no Web Locks/);
  await assert.rejects(s.setCodeSaved(), /no Web Locks/);
  await assert.rejects(s.signOut(), /no Web Locks/);
  assert.equal(await s.get("meta", "seed"), undefined);
  s.close();
});
