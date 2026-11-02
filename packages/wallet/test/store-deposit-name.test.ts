// nameDeposit's guards (card signpage-deposit-quote-wire; the review of 8e7d7b1, folded onto nameDeposit): two tabs
// naming at once write one record; the compare is on the seed record the pass read and checked, not a read taken just
// before the write; the store's own entropy copy and every seed it decrypts are zeroed, named or refused.
//   node --test test/store-deposit-name.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const closers: WalletStore[] = [];
after(() => closers.forEach((s) => s.close()));
const id = (i: number) => i.toString(16).padStart(64, "0");
const SEED = () => ({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });

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

test("two tabs naming U at once: one record, the same for both, and no index reserved", async () => {
  const idb = new IDBFactory();
  const name = `deposit-name-tabs-${process.pid}`;
  const a = await openWalletStore({ indexedDB: idb, name });
  const b = await openWalletStore({ indexedDB: idb, name });
  closers.push(a, b);
  await a.insertSeed(SEED());
  const entropy = () => new Uint8Array(16).fill(0x7f);
  for (let round = 0; round < 5; round++) {
    const scope = 1000n + BigInt(round);
    const rec = { scope, index: a.lane, id: id(round) };
    const [x, y] = await Promise.all([a.nameDeposit({ entropy: entropy() }, rec), b.nameDeposit({ entropy: entropy() }, rec)]);
    assert.deepEqual(x, y, `round ${round}`);
    assert.deepEqual(await a.get("meta", `deposit/${scope}`), x);
    assert.equal(await a.reserveDepositIndex(scope), a.lane, `round ${round}: an index was reserved`);
  }
});

test("a seed record changed after the pass checked it gets no deposit record", async () => {
  const idb = new IDBFactory();
  const name = `deposit-name-compare-${process.pid}`;
  const s = await openWalletStore({ indexedDB: idb, name });
  closers.push(s);
  await s.insertSeed(SEED());
  // another writer replaces the seed record after this pass checked it and before its write: the store wraps the deposit
  // record between the two, so the replacement lands there (once)
  const subtle = globalThis.crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const encrypt = subtle.encrypt!;
  let fired = 0;
  subtle.encrypt = async function (this: unknown, ...a: unknown[]) {
    const aad = new TextDecoder().decode((a[0] as { additionalData?: Uint8Array }).additionalData);
    if (aad === "meta/deposit/5" && fired++ === 0) await rawPut(idb, name, "meta", "seed", { iv: new Uint8Array(12).fill(9), ct: new ArrayBuffer(32) });
    return encrypt.apply(this, a);
  };
  let ok: boolean;
  try {
    ok = await s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 5n, index: s.lane, id: id(1) }).then(() => true, () => false);
  } finally {
    subtle.encrypt = encrypt;
  }
  assert.equal(fired, 1);
  assert.equal(ok, false, "a deposit record was written for a seed record the pass never checked");
  assert.equal(await s.get("meta", "deposit/5"), undefined);
});

test("nameDeposit zeroes its own copy of the entropy, named or refused", async () => {
  const copies: Uint8Array<ArrayBuffer>[] = [];
  class Tracked extends Uint8Array {
    override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
      const c = Uint8Array.prototype.slice.call(this, start, end) as Uint8Array<ArrayBuffer>;
      copies.push(c);
      return c;
    }
  }
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(s);
  await s.insertSeed(SEED());
  await s.nameDeposit({ entropy: new Tracked(16).fill(0x7f) }, { scope: 5n, index: 0, id: id(0) });
  await assert.rejects(s.nameDeposit({ entropy: new Tracked(16).fill(0x01) }, { scope: 5n, index: 0, id: id(0) }));
  assert.equal(copies.length, 2);
  for (const c of copies) assert.ok(c.every((b) => b === 0), "the store's entropy copy was left in memory");
});

test("nameDeposit wipes the seed it decrypted to compare, named or refused", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(s);
  await s.insertSeed(SEED());
  // the record codec turns the seed's entropy back into bytes with Uint8Array.from (unhex): track every 16-byte result
  const from = Uint8Array.from;
  const made: Uint8Array[] = [];
  (Uint8Array as unknown as { from: unknown }).from = function (this: unknown, ...a: unknown[]) {
    const r = (from as (...x: unknown[]) => Uint8Array).apply(this, a);
    if (r.length === 16) made.push(r);
    return r;
  };
  try {
    await s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 6n, index: 0, id: id(0) });
    await assert.rejects(s.nameDeposit({ entropy: new Uint8Array(16).fill(0x01) }, { scope: 6n, index: 0, id: id(0) }));
  } finally {
    (Uint8Array as unknown as { from: unknown }).from = from;
  }
  assert.ok(made.length >= 2, `saw ${made.length} decrypted seeds`);
  for (const m of made) assert.ok(m.every((b) => b === 0), "a decrypted seed's entropy was left in memory");
});
