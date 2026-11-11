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
import { openWalletStore, SeedChanged, WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { depositNamer, type DepositNamerDeps } from "../src/deposit-name.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";

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

// ---------- card pool-deposit-address: each pool's U_X, named ahead as the vault's U ----------
const SOL_SCOPE = 4242n, BASE_SCOPE = 5151n;
const evmOf = (s: bigint, i: number): string => {
  const k = depositIdEvm(SEED64, s, i);
  k.secretKey.fill(0);
  return k.address;
};
const idOf = (s: bigint, i: number): string => {
  const k = depositId(SEED64, s, i);
  k.secretKey.fill(0);
  return k.id;
};

test("a landing names each pool's planned index too: U_{s,i} on Solana; on an EVM pool U^evm_{s,i} beside U_{s,i}'s id", async () => {
  const { w, ns } = await signedIn();
  const n = namerOn(w, { pools: () => [{ chain: "solana", scope: SOL_SCOPE }, { chain: "base", scope: BASE_SCOPE }] });
  n.name(ENTROPY());
  await n.named();
  const notes = await deposits(ns);
  assert.deepEqual(notes.map((x) => x.scope).sort(), [SCOPE, SOL_SCOPE, BASE_SCOPE].sort());
  assert.ok(notes.every((x) => x.state === "PLANNED"));
  const at = (s: bigint) => indexOf(notes.find((x) => x.scope === s)!.ref);
  assert.deepEqual(await w.get("meta", `deposit/${SCOPE}`), { v: 1, scope: SCOPE.toString(), index: at(SCOPE), id: U(at(SCOPE)) });
  assert.deepEqual(await w.get("meta", `deposit/${SOL_SCOPE}`), { v: 1, scope: SOL_SCOPE.toString(), index: at(SOL_SCOPE), id: idOf(SOL_SCOPE, at(SOL_SCOPE)) });
  assert.deepEqual(await w.get("meta", `deposit/${BASE_SCOPE}`),
    { v: 1, scope: BASE_SCOPE.toString(), index: at(BASE_SCOPE), id: idOf(BASE_SCOPE, at(BASE_SCOPE)), evm: evmOf(BASE_SCOPE, at(BASE_SCOPE)) });
  // again: the same indices, no second note on any scope
  n.name(ENTROPY());
  await n.named();
  assert.equal((await deposits(ns)).length, 3);
});

test("review F4 N1: a Robinhood pool is named as an EVM pool: its record carries U^evm_{s,i} beside U_{s,i}'s id", async () => {
  const HOOD_SCOPE = 6161n;
  const { w, ns } = await signedIn();
  const n = namerOn(w, { scope: () => null, pools: () => [{ chain: "robinhood", scope: HOOD_SCOPE }] });
  n.name(ENTROPY());
  await n.named();
  const at = indexOf((await deposits(ns)).find((x) => x.scope === HOOD_SCOPE)!.ref);
  assert.deepEqual(await w.get("meta", `deposit/${HOOD_SCOPE}`),
    { v: 1, scope: HOOD_SCOPE.toString(), index: at, id: idOf(HOOD_SCOPE, at), evm: evmOf(HOOD_SCOPE, at) });
});

test("a pool's U_X moves on once money reached it, as the vault's; pools are named with no vault on the network", async () => {
  const { w, ns } = await signedIn();
  const n = namerOn(w, { scope: () => null, pools: () => [{ chain: "base", scope: BASE_SCOPE }] });
  n.name(ENTROPY());
  await n.named();
  const first = (await deposits(ns))[0]!;
  assert.equal(first.scope, BASE_SCOPE);
  await ns.move(first.id, "PLANNED", "INCOMING");
  n.name(ENTROPY());
  await n.named();
  const rec = (await w.get("meta", `deposit/${BASE_SCOPE}`)) as { index: number; id: string; evm: string };
  assert.notEqual(rec.index, indexOf(first.ref));
  assert.equal(rec.evm, evmOf(BASE_SCOPE, rec.index));
  assert.equal(rec.id, idOf(BASE_SCOPE, rec.index));
  assert.equal(await w.get("meta", `deposit/${SCOPE}`), undefined, "no vault on the network: no vault record");
});

test("one pool's naming that fails leaves the others named", async () => {
  const { w, ns } = await signedIn();
  const real = await openNoteStore(w);
  closers.push(() => real.close());
  const openNotes = async () => ({
    planDeposit: (s: bigint, f: (r: NoteRef) => bigint) => (s === SOL_SCOPE ? Promise.reject(new Error("notes down")) : real.planDeposit(s, f)),
    close: () => {},
  });
  const n = namerOn(w, { openNotes, pools: () => [{ chain: "solana", scope: SOL_SCOPE }, { chain: "base", scope: BASE_SCOPE }] });
  n.name(ENTROPY());
  await n.named();
  assert.equal(await w.get("meta", `deposit/${SOL_SCOPE}`), undefined);
  assert.ok(await w.get("meta", `deposit/${BASE_SCOPE}`));
  assert.ok(await w.get("meta", `deposit/${SCOPE}`));
  void ns;
});

// Card signpage-passes-yield-to-a-trade, devnet run 10 of 11 Nov: a sell tapped 3 s after a buy sent nothing for 12.7 s.
// The buy holds the seed lock shared to its Final; its note writes post "changed", the page names the deposit again,
// and every naming asked the seed lock exclusive. Web Locks grant in request order (Node's navigator.locks, as a
// browser's), so the sell's shared request queued behind that exclusive one, itself waiting for the buy.
/** Polls (no clock) until `f` holds or `n` turns of the event loop pass; whether it held. */
const until = async (f: () => Promise<boolean>, n = 2_000): Promise<boolean> => {
  for (let i = 0; i < n; i++) {
    if (await f()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
};
const exclusivePending = async (): Promise<boolean> => ((await navigator.locks.query()).pending ?? []).some((l) => l.name === WALLET_SEED_LOCK && l.mode === "exclusive");
/** A trade's hold on the seed lock (shared) until the give-back is called. */
const tradeHold = async (): Promise<() => void> => {
  let give!: () => void;
  const granted = new Promise<void>((on) => void navigator.locks.request(WALLET_SEED_LOCK, { mode: "shared" }, () => (on(), new Promise<void>((r) => (give = r)))));
  await granted;
  return () => give();
};
/** Counts the store's nameDeposit calls, each one's outcome kept. */
const counted = (w: WalletStore): { calls: unknown[] } => {
  const real = w.nameDeposit.bind(w);
  const out = { calls: [] as unknown[] };
  w.nameDeposit = (shown, r) => {
    const p = real(shown, r);
    p.then((x) => out.calls.push(x), (e: unknown) => out.calls.push(e));
    return p;
  };
  return out;
};

test("a naming that would change nothing asks no exclusive seed lock: a trade's shared hold stays the only holder, and a second trade's shared request is granted at once", async () => {
  const { w } = await signedIn();
  const n = namerOn(w);
  n.name(ENTROPY());
  await n.named();
  const named = await w.get("meta", `deposit/${SCOPE}`);
  const c = counted(w);
  const give = await tradeHold();
  try {
    // a note write of the trade's posts "changed": the page names again
    n.name(ENTROPY());
    const done = n.named().then(() => true);
    const settled = await until(async () => (await Promise.race([done, Promise.resolve(false)])) || (await exclusivePending()));
    assert.ok(settled);
    assert.equal(await exclusivePending(), false, "no exclusive request on the seed lock is queued behind the trade's hold");
    // the second trade (a sell): its shared request is granted now, not queued
    const now = await navigator.locks.request(WALLET_SEED_LOCK, { mode: "shared", ifAvailable: true }, async (l) => l !== null);
    assert.equal(now, true, "the sell's shared request is granted at once");
    assert.equal(await done, true, "the naming ended while the trade still held the lock");
    assert.equal(c.calls.length, 0, "nameDeposit not asked");
    assert.deepEqual(await w.get("meta", `deposit/${SCOPE}`), named);
  } finally {
    give();
  }
});

test("a naming that does change the record still takes the seed lock and writes it once", async () => {
  const { w, ns } = await signedIn();
  const n = namerOn(w);
  n.name(ENTROPY());
  await n.named();
  // money reached the named index: the next naming names a new one
  const first = (await deposits(ns)).find((x) => x.state === "PLANNED")!;
  await ns.move(first.id, "PLANNED", "INCOMING");
  const c = counted(w);
  const give = await tradeHold();
  n.name(ENTROPY());
  const done = n.named();
  assert.ok(await until(exclusivePending), "the change asks the seed lock exclusive, behind the trade's hold");
  give();
  await done;
  assert.equal(c.calls.length, 1, "nameDeposit asked once");
  const next = (await deposits(ns)).find((x) => x.state === "PLANNED")!;
  assert.deepEqual(await w.get("meta", `deposit/${SCOPE}`), { v: 1, scope: SCOPE.toString(), index: indexOf(next.ref), id: U(indexOf(next.ref)) });
});

test("a seed changed between the lock-free read and the lock: nameDeposit still refuses with SeedChanged and nothing is written", async () => {
  // the store holds the 7f..7f seed; the namer's own read of it answers the seed it was given (all zero), as a read
  // made before another tab's sign out and sign in would
  const { w } = await signedIn(new Uint8Array(16).fill(0x7f));
  const seen = new Proxy(w, {
    get(t, p) {
      if (p === "get") return async (store: string, key: string) => (store === "meta" && key === "seed" ? { entropy: ENTROPY() } : t.get(store as never, key));
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const c = counted(w);
  const n = namerOn(seen as WalletStore);
  n.name(ENTROPY());
  await n.named();
  assert.equal(c.calls.length, 1, "the record would change: nameDeposit asked");
  assert.ok(c.calls[0] instanceof SeedChanged, String(c.calls[0]));
  assert.equal(await w.get("meta", `deposit/${SCOPE}`), undefined, "nothing written");
});
