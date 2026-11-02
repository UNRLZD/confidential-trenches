// Naming U ahead (src/deposit-name.ts; card signpage-deposit-quote-wire): the index a quote names is the note store's
// one PLANNED deposit note, so bindDeposit later finds U's note; it moves on once money reached it; every copy of the
// seed is zeroed; the frame names nothing; a quote waits for startup, a naming in flight and a resync's naming.
// On fake-indexeddb with the wallet's real store and note store and the published all-zero entropy vector.
//   node --test test/deposit-name.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { depositId, entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { depositNamer, type DepositNamerDeps } from "../src/deposit-name.ts";

const ENTROPY = () => new Uint8Array(16); // the published all-zero vector (packages/wallet/test/vectors/a8.json)
const SEED64 = wordsToSeed64(entropyToWords(ENTROPY()));
const SCOPE = 77n;
const U = (i: number): string => {
  const u = depositId(SEED64, SCOPE, i);
  u.secretKey.fill(0);
  return u.id;
};
const pc = (ref: NoteRef): bigint => noteSecrets(SEED64, ref).precommitment;

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

async function signedIn(entropy = ENTROPY()): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy, source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { w, ns };
}
const namerOn = (w: WalletStore, over: Partial<DepositNamerDeps> = {}) =>
  depositNamer({ top: true, scope: () => SCOPE, open: async () => w, startup: () => Promise.resolve(), resyncing: () => null, ...over });
const deposits = async (ns: NoteStore) => (await ns.list()).filter((n) => n.ref.kind === "deposit");
const indexOf = (ref: NoteRef): number => (ref as { i: number }).i;

test("a landing names the note store's one PLANNED deposit index, and U_{s,i} of the stored seed", async () => {
  const { w, ns } = await signedIn();
  const n = namerOn(w);
  n.name(ENTROPY());
  await n.named();
  const notes = await deposits(ns);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.state, "PLANNED");
  const i = indexOf(notes[0]!.ref);
  assert.deepEqual(await w.get("meta", `deposit/${SCOPE}`), { v: 1, scope: SCOPE.toString(), index: i, id: U(i) });
  // again: the same index, no second note
  n.name(ENTROPY());
  await n.named();
  assert.equal((await deposits(ns)).length, 1);
  assert.equal(((await w.get("meta", `deposit/${SCOPE}`)) as { index: number }).index, i);
});

test("planned first by a deposit flow, then named: the same index, the U the quote shows", async () => {
  const { w, ns } = await signedIn();
  const note = await ns.planDeposit(SCOPE, pc);
  const n = namerOn(w);
  n.name(ENTROPY());
  await n.named();
  assert.equal(((await w.get("meta", `deposit/${SCOPE}`)) as { index: number }).index, indexOf(note.ref));
  assert.equal((await deposits(ns)).length, 1);
});

test("money reached the named index: the next naming names a new index, never the funded one (W:355-358)", async () => {
  const { w, ns } = await signedIn();
  const n = namerOn(w);
  n.name(ENTROPY());
  await n.named();
  const first = (await deposits(ns))[0]!;
  await ns.move(first.id, "PLANNED", "INCOMING");
  n.name(ENTROPY());
  await n.named();
  const planned = (await deposits(ns)).filter((x) => x.state === "PLANNED");
  assert.equal(planned.length, 1);
  const rec = (await w.get("meta", `deposit/${SCOPE}`)) as { index: number; id: string };
  assert.notEqual(rec.index, indexOf(first.ref));
  assert.equal(rec.index, indexOf(planned[0]!.ref));
  assert.equal(rec.id, U(rec.index));
});

test("every copy is zeroed, named or refused: the entropy copy, seed64 and U's secret key", async () => {
  const { w } = await signedIn();
  const seen: Uint8Array[] = [];
  const n = namerOn(w, {
    seed64Of: (e) => {
      seen.push(e);
      const s = wordsToSeed64(entropyToWords(e));
      seen.push(s);
      return s;
    },
    derive: (s64, s, i) => {
      const u = depositId(s64, s, i);
      seen.push(u.secretKey);
      return u;
    },
  });
  const mine = ENTROPY();
  n.name(mine);
  await n.named();
  assert.equal(seen.length, 3);
  for (const c of seen) assert.ok(c.every((b) => b === 0), "a copy was left in memory");
  assert.notEqual(seen[0], mine, "the namer works on its own copy");
  // refused (another seed is stored): its copy is zeroed too, and nothing is derived
  const other = await signedIn(new Uint8Array(16).fill(1));
  const copies: Uint8Array<ArrayBuffer>[] = [];
  class Tracked extends Uint8Array {
    override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
      const c = Uint8Array.prototype.slice.call(this, start, end) as Uint8Array<ArrayBuffer>;
      copies.push(c);
      return c;
    }
  }
  const m = namerOn(other.w);
  m.name(new Tracked(16));
  await m.named();
  assert.equal(copies.length, 1);
  assert.ok(copies[0]!.every((b) => b === 0));
  assert.equal(await other.w.get("meta", `deposit/${SCOPE}`), undefined, "a U named for a seed that is not stored");
  assert.deepEqual(await deposits(other.ns), [], "a note planned for a seed that is not stored");
});

test("the frame names nothing, and nothing is named while no vault is named on the page's network", async () => {
  for (const over of [{ top: false }, { scope: () => null }] as Partial<DepositNamerDeps>[]) {
    const { w, ns } = await signedIn();
    let derived = 0;
    const n = namerOn(w, { ...over, seed64Of: (e) => (derived++, wordsToSeed64(entropyToWords(e))) });
    n.name(ENTROPY());
    await n.named();
    assert.equal(derived, 0);
    assert.deepEqual(await deposits(ns), []);
    assert.deepEqual((await w.keys("meta")).filter((k) => k.startsWith("deposit")), []);
  }
});

test("a quote waits for the first load's read, a naming in flight and a resync's naming", async () => {
  const { w } = await signedIn();
  let startDone!: () => void;
  const start = new Promise<void>((ok) => (startDone = ok));
  let resync: Promise<void> | null = null;
  const n = namerOn(w, { startup: () => start, resyncing: () => resync });
  let settled = false;
  const waiting = n.named().then(() => (settled = true));
  const tick = () => new Promise((ok) => setTimeout(ok, 20));
  await tick();
  assert.equal(settled, false, "settled before the first load's read");
  // the first load lands and names; then another tab's sign-in starts a resync that lands and names again
  n.name(ENTROPY());
  let resyncDone!: () => void;
  resync = new Promise<void>((ok) => (resyncDone = ok)).finally(() => (resync = null));
  startDone();
  await tick();
  assert.equal(settled, false, "settled during a resync");
  // the resync's landing names before the resync itself settles
  n.name(ENTROPY());
  resyncDone();
  await waiting;
  assert.ok((await w.get("meta", `deposit/${SCOPE}`)) !== undefined, "settled before the resync's naming wrote");
});

// Review of 395f261 (fold 2): two tabs, and each guard of the namer on its own.
let dbs = 0;
async function tab(idb: IDBFactory, name: string, seed = false): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: idb, name });
  closers.push(() => w.close());
  if (seed) await w.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { w, ns };
}
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((ok) => (open = ok));
  return { p, open };
};
const tick = (ms = 20) => new Promise((ok) => setTimeout(ok, ms));

test("two tabs: a naming that planned before money arrived never writes that funded index over the newer one", async () => {
  const idb = new IDBFactory();
  const name = `two-tabs-${process.pid}-${dbs++}`;
  const a = await tab(idb, name, true);
  const b = await tab(idb, name);
  // tab A plans, then is slow before it names (a busy main thread, the seed lock held by another tab's naming)
  const slow = gate();
  const planned = gate();
  const slowNotes = async (st: WalletStore) => {
    const ns = await openNoteStore(st);
    return {
      planDeposit: async (s: bigint, f: (ref: NoteRef) => bigint) => {
        const n = await ns.planDeposit(s, f);
        planned.open();
        await slow.p;
        return n;
      },
      close: () => ns.close(),
    };
  };
  const nA = namerOn(a.w, { openNotes: slowNotes });
  nA.name(ENTROPY());
  await planned.p;
  // meanwhile, in tab B: money reaches that index, the note store moves on, and B names the next index
  const first = (await deposits(b.ns)).find((n) => n.state === "PLANNED")!;
  await b.ns.move(first.id, "PLANNED", "INCOMING");
  const nB = namerOn(b.w);
  nB.name(ENTROPY());
  await nB.named();
  const next = (await deposits(b.ns)).find((n) => n.state === "PLANNED")!;
  assert.equal(((await b.w.get("meta", `deposit/${SCOPE}`)) as { index: number }).index, indexOf(next.ref));
  // tab A goes on
  slow.open();
  await nA.named();
  const rec = (await b.w.get("meta", `deposit/${SCOPE}`)) as { index: number };
  assert.notEqual(rec.index, indexOf(first.ref), "a quote names the funded index again (W:355-358)");
  assert.equal(rec.index, indexOf(next.ref));
});

// the published 7f..7f and 80..80 entropy vectors (BIP-39's), so a zeroed copy is told apart from the vector itself
const V7F = () => new Uint8Array(16).fill(0x7f);
const V80 = () => new Uint8Array(16).fill(0x80);

test("the stored seed the namer reads to compare is zeroed, named or refused", async () => {
  for (const entropy of [V7F(), V80()]) {
    const { w } = await signedIn(V7F());
    const read: Uint8Array[] = [];
    const view = Object.create(w) as WalletStore;
    view.get = (async (store: never, key: never) => {
      const v = await w.get(store, key);
      if (key === "seed") read.push((v as { entropy: Uint8Array }).entropy);
      return v;
    }) as WalletStore["get"];
    const n = namerOn(w, { open: async () => view });
    n.name(entropy);
    await n.named();
    assert.equal(read.length, 1);
    assert.ok(read[0]!.every((b) => b === 0), "the stored seed's entropy was left in memory");
    assert.ok((await w.keys("meta")).includes(`deposit/${SCOPE}`) === (entropy[0] === 0x7f), "named for the wrong seed");
  }
});

test("the note store is closed after planning, planned or failed", async () => {
  for (const fail of [false, true]) {
    const { w } = await signedIn();
    let closed = 0;
    const n = namerOn(w, {
      openNotes: async (st) => {
        const ns = await openNoteStore(st);
        return {
          planDeposit: (s, f) => (fail ? Promise.reject(new Error("planned nothing")) : ns.planDeposit(s, f)),
          close: () => (closed++, ns.close()),
        };
      },
    });
    n.name(ENTROPY());
    await n.named();
    assert.equal(closed, 1, fail ? "left open on a failed plan" : "left open");
  }
});

test("the namer's own entropy copy is zeroed once its naming is done, named or failed", async () => {
  for (const fail of [false, true]) {
    const { w } = await signedIn(V7F());
    const copies: Uint8Array<ArrayBuffer>[] = [];
    class Tracked extends Uint8Array {
      override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
        const c = Uint8Array.prototype.slice.call(this, start, end) as Uint8Array<ArrayBuffer>;
        copies.push(c);
        return c;
      }
    }
    const n = namerOn(w, fail ? { openNotes: () => Promise.reject(new Error("no note store")) } : {});
    n.name(new Tracked(16).fill(0x7f));
    await n.named();
    // the first is the namer's own; the store's nameDeposit takes its own copy of that one when it is called
    assert.ok(copies.length >= 1);
    for (const c of copies) assert.ok(c.every((b) => b === 0), "a copy was left in memory");
  }
});

test("named() waits for a resync that starts while a naming is in flight, and that resync's naming", async () => {
  const { w } = await signedIn();
  const slow = gate();
  let resync: Promise<void> | null = null;
  const n = namerOn(w, {
    resyncing: () => resync,
    openNotes: async (st) => {
      await slow.p;
      return openNoteStore(st);
    },
  });
  n.name(ENTROPY());
  let settled = false;
  const waiting = n.named().then(() => (settled = true));
  await tick();
  // another tab signs in: a resync starts while the first naming is still in flight
  const rs = gate();
  resync = rs.p.finally(() => (resync = null));
  slow.open();
  await tick();
  assert.equal(settled, false, "settled during a resync that started while it waited");
  rs.open();
  await waiting;
});

test("namings run one at a time, in order", async () => {
  const { w } = await signedIn();
  const first = gate();
  let opened = 0;
  const n = namerOn(w, {
    openNotes: async (st) => {
      if (opened++ === 0) await first.p;
      return openNoteStore(st);
    },
  });
  n.name(ENTROPY());
  n.name(ENTROPY());
  await tick();
  assert.equal(opened, 1, "the second naming started before the first was done");
  first.open();
  await n.named();
  assert.equal(opened, 2);
});
