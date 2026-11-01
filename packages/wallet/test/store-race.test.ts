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

test("a delete blocked by a connection that never closes gives the seed lock back; sign out resolves once it closes", async () => {
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
  let done = false;
  const out = s.signOut().then(() => (done = true));
  const lock = await Promise.race([navigator.locks.request(`${WALLET_SEED_LOCK}/${name}`, async () => "free"), sleep(2_000)]);
  assert.equal(lock, "free", "the seed lock is held while the delete is blocked");
  assert.equal(done, false, "sign out resolved before its delete");
  x.close();
  await out;
  const dbs = await idb.databases();
  assert.equal(dbs.some((d) => d.name === name), false, "the database is deleted once the blocker closes");
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
