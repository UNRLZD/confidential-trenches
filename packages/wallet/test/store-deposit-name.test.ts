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

// Review of 395f261 (fold 2): planned indices only grow, so a naming that planned before money reached its index never
// writes that funded index over the newer one another tab named since (W:355-358).
test("a lower index never replaces a higher one for the same scope and seed (16, then 8, leaves 16)", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(s);
  await s.insertSeed(SEED());
  const entropy = () => new Uint8Array(16).fill(0x7f);
  await s.nameDeposit({ entropy: entropy() }, { scope: 5n, index: 16, id: id(16) });
  const kept = await s.nameDeposit({ entropy: entropy() }, { scope: 5n, index: 8, id: id(8) });
  assert.deepEqual(kept, { v: 1, scope: "5", index: 16, id: id(16) }, "the answer is the record kept");
  assert.deepEqual(await s.get("meta", "deposit/5"), { v: 1, scope: "5", index: 16, id: id(16) });
  // a higher index still moves it on
  await s.nameDeposit({ entropy: entropy() }, { scope: 5n, index: 24, id: id(24) });
  assert.equal(((await s.get("meta", "deposit/5")) as { index: number }).index, 24);
});

test("naming the same record again writes nothing and tells no tab", async () => {
  const idb = new IDBFactory();
  const name = `deposit-name-equal-${process.pid}`;
  const s = await openWalletStore({ indexedDB: idb, name });
  closers.push(s);
  await s.insertSeed(SEED());
  const rec = { scope: 5n, index: 8, id: id(8) };
  await s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, rec);
  const raw = (): Promise<{ iv: Uint8Array }> =>
    new Promise((ok, no) => {
      const o = idb.open(name);
      o.onerror = () => no(o.error);
      o.onsuccess = () => {
        const r = o.result.transaction("meta", "readonly").objectStore("meta").get("deposit/5");
        r.onsuccess = () => (o.result.close(), ok(r.result));
        r.onerror = () => no(r.error);
      };
    });
  const heard: unknown[] = [];
  const ch = new BroadcastChannel(`ct-wallet/${name}`);
  ch.onmessage = (m) => heard.push(m.data);
  const before = Buffer.from((await raw()).iv).toString("hex");
  await s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, rec);
  await new Promise((ok) => setTimeout(ok, 30));
  ch.close();
  assert.equal(Buffer.from((await raw()).iv).toString("hex"), before, "the equal record was written again");
  assert.deepEqual(heard, [], "a change was told for an equal record");
});

test("a bad index or id is refused and nothing is stored", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(s);
  await s.insertSeed(SEED());
  for (const bad of [
    { index: -1, id: id(0) },
    { index: 2 ** 32, id: id(0) },
    { index: 1.5, id: id(0) },
    { index: 0, id: "zz" },
    { index: 0, id: id(0).slice(1) },
  ]) {
    await assert.rejects(s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 5n, ...bad }), /a deposit record is/, JSON.stringify(bad));
    assert.deepEqual((await s.keys("meta")).filter((k) => k.startsWith("deposit")), [], `stored for ${JSON.stringify(bad)}`);
  }
});

test("nameDeposit waits for the seed lock (a sign out or a seed write in flight) and writes only after it", async () => {
  const name = `deposit-name-lock-${process.pid}`;
  const s = await openWalletStore({ indexedDB: new IDBFactory(), name });
  closers.push(s);
  await s.insertSeed(SEED());
  let release!: () => void;
  let held!: () => void;
  const isHeld = new Promise<void>((ok) => (held = ok));
  const holder = navigator.locks.request(`ct-wallet/seed/${name}`, { mode: "exclusive" }, () => {
    held();
    return new Promise<void>((ok) => (release = ok));
  });
  await isHeld;
  let done = false;
  const naming = s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 5n, index: 0, id: id(0) }).then((r) => ((done = true), r));
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(done, false, "named while the seed lock was held");
  assert.equal(await s.get("meta", "deposit/5"), undefined, "written while the seed lock was held");
  release();
  await holder;
  assert.deepEqual(await naming, { v: 1, scope: "5", index: 0, id: id(0) });
});

// card pool-deposit-address: an EVM pool's record names U^evm_{s,i} beside U_{s,i}'s 64-hex id (the refund's), so the
// API answers both from public data; the address only in the EIP-55 case it is derived in, and nothing else beside it.
test("an EVM pool's record: the EIP-55 address beside the 64-hex id, read back as written; any other shape refused", async () => {
  const s = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(s);
  await s.insertSeed(SEED());
  const EVM = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55's own vector (its checksum is all upper case)
  const EVM2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"; // another of its vectors
  const named = await s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 9n, index: 0, id: id(0), evm: EVM });
  assert.deepEqual(named, { v: 1, scope: "9", index: 0, id: id(0), evm: EVM });
  const { depositRecordOf } = await import("../src/store/index.ts");
  assert.deepEqual(depositRecordOf(await s.get("meta", "deposit/9")), { v: 1, scope: "9", index: 0, id: id(0), evm: EVM });
  assert.deepEqual(depositRecordOf({ v: 1, scope: "9", index: 0, id: id(0) }), { v: 1, scope: "9", index: 0, id: id(0) }, "a record with no address still reads");
  for (const evm of [EVM.toLowerCase(), EVM2.toLowerCase(), "0xFB" + EVM2.slice(4), EVM.slice(0, -1), "0X" + EVM.slice(2), id(0), 7, null]) {
    await assert.rejects(s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 10n, index: 0, id: id(0), evm: evm as string }), /a deposit record is/, String(evm));
    assert.equal(depositRecordOf({ v: 1, scope: "9", index: 0, id: id(0), evm }), undefined, String(evm));
  }
  assert.equal(depositRecordOf({ v: 1, scope: "9", index: 0, id: id(0), evm: EVM, more: 1 }), undefined, "a sixth key");
  assert.equal(depositRecordOf({ v: 1, scope: "9", index: 0, id: id(0), other: EVM }), undefined, "a fifth key that is not evm");
  // a later naming of the same index with another address is a new record, never the old one kept
  assert.deepEqual(await s.nameDeposit({ entropy: new Uint8Array(16).fill(0x7f) }, { scope: 9n, index: 0, id: id(0), evm: EVM2 }), { v: 1, scope: "9", index: 0, id: id(0), evm: EVM2 });
});
