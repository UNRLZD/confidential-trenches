// A stale tab's sign out never deletes another account's database (card wallet-passkey-prf, round 4; the reviewer's
// planted case). Tab B's sign out passes the store's liveness check, then awaits the seed's decrypt for the backup check;
// meanwhile tab A signs out and tab C stores a new seed whose 12 words are its only copy (source "random", code_saved
// false). B's store was closed by A's delete, so B must refuse, and C's seed must still be there.
//   node --test test/store-race.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore } from "../src/store/index.ts";

test("a store closed while its sign out awaits the backup check never deletes a newer account's database", async () => {
  const idb = new IDBFactory();
  const a = await openWalletStore({ indexedDB: idb });
  await a.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(1), source: "prf", code_saved: false });
  const b = await openWalletStore({ indexedDB: idb });
  const subtle = globalThis.crypto.subtle;
  const real = subtle.decrypt;
  let gate: (() => Promise<void>) | null = async () => {
    await a.signOut();
    const c = await openWalletStore({ indexedDB: idb });
    await c.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(2), source: "random", code_saved: false });
    c.close();
  };
  // B's first decrypt is its sign out's read of the seed: A signs out and C stores its seed while it is pending
  subtle.decrypt = (async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
    const g = gate;
    gate = null;
    if (g) await g();
    return real.apply(subtle, args);
  }) as SubtleCrypto["decrypt"];
  let outcome: string;
  try {
    await b.signOut();
    outcome = "deleted";
  } catch (e) {
    outcome = `refused: ${(e as Error).message}`;
  } finally {
    subtle.decrypt = real;
    b.close();
  }
  const d = await openWalletStore({ indexedDB: idb });
  const seed = (await d.get("meta", "seed")) as { source?: string } | undefined;
  d.close();
  assert.equal(gate, null, "the planted race ran");
  assert.match(outcome, /^refused: the wallet store is closed/, `B's sign out: ${outcome}`);
  assert.equal(seed?.source, "random", "C's seed, the only copy of its 12 words, was deleted by B's stale sign out");
});
