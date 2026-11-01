// The note store's states (card wallet-note-store; docs/plan1/wallet.md:198 at research 7838dbe, :385-391, :346-353,
// :176-192): every state, every legal and illegal edge, refusals that write nothing, births, the one unfunded deposit
// index, second arrivals in order, nothing secret stored unwrapped, two tabs on one note.
//   node --test test/note-store.test.ts      (from packages/wallet)
// IndexedDB is fake-indexeddb; WebCrypto and Web Locks are Node's own. Test secrets come from the first published BIP-39
// vector (all-zero entropy), as test/note-secrets.test.ts.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { NOTE_EDGES, NOTE_STATES, openNoteStore, type Leaf, type NoteRecord, type NoteState, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const BIG = 123_456_789_012_345_678_901_234_567n; // above 2^53: amounts stay bigint end to end
const leafOf = (precommitment: bigint, value = BIG, label = 11n, leafIndex = 3n): Leaf => ({ value, label, commitment: noteCommitment(value, label, precommitment), leafIndex });

const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));

type Tab = { idb: IDBFactory; w: WalletStore; ns: NoteStore; puts: () => number };
async function tab(idb = new IDBFactory()): Promise<Tab> {
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  let n = 0;
  const counted: WalletStore = { ...w, put: async (s, k, v) => (n++, w.put(s, k, v)) };
  return { idb, w, ns: await openNoteStore(counted), puts: () => n };
}
function rawNote(idb: IDBFactory, key: string): Promise<{ iv: Uint8Array; ct: ArrayBuffer } | undefined> {
  return new Promise((ok, no) => {
    const o = idb.open("ct-wallet");
    o.onerror = () => no(o.error);
    o.onsuccess = () => {
      const r = o.result.transaction("notes", "readonly").objectStore("notes").get(key);
      r.onsuccess = () => (o.result.close(), ok(r.result));
      r.onerror = () => no(r.error);
    };
  });
}
const contains = (hay: Uint8Array, needle: Uint8Array): boolean => hay.some((_, i) => needle.every((b, j) => hay[i + j] === b));

let scopes = 100n;
const fieldsFor = (from: NoteState, to: NoteState, n: NoteRecord) =>
  from === "INCOMING" && to === "UNSPENT" ? { leaf: leafOf(n.precommitment) } : to === "HELD" ? { deadlineMs: 1_800_000_000_000n } : {};
// a fresh deposit note walked along the legal path to `state`
async function noteIn(ns: NoteStore, state: NoteState): Promise<NoteRecord> {
  const path: NoteState[] = ["PLANNED", "INCOMING", "UNSPENT", "HELD", "RESERVED", "SPENT"];
  let n = await ns.planDeposit(scopes++, pc);
  for (let k = 1; k <= path.indexOf(state); k++) n = await ns.move(n.id, path[k - 1]!, path[k]!, fieldsFor(path[k - 1]!, path[k]!, n));
  assert.equal(n.state, state);
  return n;
}

test("every state, and every edge: the legal ones move, every other is refused with no write", async () => {
  const t = await tab();
  const legal: string[] = [];
  for (const from of NOTE_STATES) {
    for (const to of NOTE_STATES) {
      const n = await noteIn(t.ns, from);
      const raw = await rawNote(t.idb, n.id);
      const puts = t.puts();
      if ((NOTE_EDGES[from] as readonly NoteState[]).includes(to)) {
        const m = await t.ns.move(n.id, from, to, fieldsFor(from, to, n));
        assert.equal((await t.ns.get(n.id))?.state, to);
        assert.equal(t.puts(), puts + 1, "one write per move");
        assert.equal(m.deadlineMs !== undefined, to === "HELD" || to === "RESERVED");
        legal.push(`${from}>${to}`);
      } else {
        await assert.rejects(t.ns.move(n.id, from, to, fieldsFor(from, to, n)), /never goes from/);
        assert.equal(t.puts(), puts, `${from}>${to} wrote`);
        assert.deepEqual(await rawNote(t.idb, n.id), raw, `${from}>${to} changed the record`);
        assert.deepEqual(await t.ns.get(n.id), n);
      }
    }
  }
  // the row's chain, the two ways back to UNSPENT and the other device's spend; nothing else
  assert.deepEqual(legal.sort(), [
    "HELD>RESERVED", "HELD>SPENT", "HELD>UNSPENT", "INCOMING>UNSPENT", "PLANNED>INCOMING",
    "RESERVED>SPENT", "RESERVED>UNSPENT", "UNSPENT>HELD", "UNSPENT>SPENT",
  ]);
});

test("a spent note never goes back to UNSPENT (or anywhere): refused, nothing written", async () => {
  const t = await tab();
  const n = await noteIn(t.ns, "SPENT");
  const raw = await rawNote(t.idb, n.id);
  const puts = t.puts();
  for (const to of NOTE_STATES) await assert.rejects(t.ns.move(n.id, "SPENT", to));
  assert.equal(t.puts(), puts);
  assert.deepEqual(await rawNote(t.idb, n.id), raw);
  assert.equal((await t.ns.get(n.id))?.state, "SPENT");
});

test("a move names the state it expects: a stale read changes nothing", async () => {
  const t = await tab();
  const n = await noteIn(t.ns, "HELD");
  const puts = t.puts();
  await assert.rejects(t.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 5n }), /is HELD, not UNSPENT/);
  await assert.rejects(t.ns.move("nope", "UNSPENT", "HELD", { deadlineMs: 5n }), /no note/);
  await assert.rejects(t.ns.move(n.id, "HELD", "BURNT" as NoteState), /unknown note state/);
  assert.equal(t.puts(), puts);
});

test("fields: a leaf only when it lands and only one that hashes to its commitment, a deadline only when held, bigint only", async () => {
  const t = await tab();
  const inc = await noteIn(t.ns, "INCOMING");
  const good = leafOf(inc.precommitment);
  const puts = t.puts();
  await assert.rejects(t.ns.move(inc.id, "INCOMING", "UNSPENT"), /leaf/);
  await assert.rejects(t.ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: { ...good, commitment: good.commitment + 1n } }), /commitment is not this note's/);
  await assert.rejects(t.ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: { ...good, value: Number(5) as unknown as bigint } }), /u128 bigint/);
  await assert.rejects(t.ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: { ...good, value: 1n << 128n } }), /u128/);
  await assert.rejects(t.ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: { ...good, leafIndex: 3 as unknown as bigint } }), /leafIndex/);
  await assert.rejects(t.ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: { ...good, nullifier: 1n } as Leaf }), /may not hold nullifier/);
  await assert.rejects(t.ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: good, deadlineMs: 9n }), /deadlineMs/);
  assert.equal(t.puts(), puts);
  const un = await t.ns.move(inc.id, "INCOMING", "UNSPENT", { leaf: good });
  assert.equal(un.leaf?.value, BIG);
  await assert.rejects(t.ns.move(un.id, "UNSPENT", "HELD"), /deadlineMs/);
  await assert.rejects(t.ns.move(un.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_000_000 as unknown as bigint }), /deadlineMs/);
  await assert.rejects(t.ns.move(un.id, "UNSPENT", "HELD", { deadlineMs: 1n, leaf: good }), /leaf is set once/);
  const held = await t.ns.move(un.id, "UNSPENT", "HELD", { deadlineMs: 77n });
  assert.equal((await t.ns.move(held.id, "HELD", "RESERVED")).deadlineMs, 77n, "RESERVED keeps the attempt's deadline");
  assert.equal((await t.ns.move(held.id, "RESERVED", "UNSPENT")).deadlineMs, undefined, "back to UNSPENT drops it");
});

test("births: PLANNED for a return, move or second note; UNSPENT with its leaf; never a repeat", async () => {
  const t = await tab();
  const L = 41n;
  const ret: NoteRef = { kind: "return", c: "sol", l: L, j: 0 };
  const r = await t.ns.add({ ref: ret, scope: 5n, precommitment: pc(ret), state: "PLANNED" });
  assert.equal(r.state, "PLANNED");
  const puts = t.puts();
  await assert.rejects(t.ns.add({ ref: ret, scope: 5n, precommitment: pc(ret) + 1n, state: "PLANNED" }), /already in the store/);
  const mv: NoteRef = { kind: "move", l: L, j: 0 };
  await assert.rejects(t.ns.add({ ref: mv, scope: 5n, precommitment: pc(ret), state: "PLANNED" }), /precommitment is already/);
  const dep: NoteRef = { kind: "deposit", s: 5n, i: 0 };
  await assert.rejects(t.ns.add({ ref: dep, scope: 5n, precommitment: pc(dep), state: "PLANNED" }), /planDeposit/);
  const ch: NoteRef = { kind: "change", l: L, j: 0 };
  await assert.rejects(t.ns.add({ ref: ch, scope: 5n, precommitment: pc(ch), state: "PLANNED" }), /born UNSPENT/);
  await assert.rejects(t.ns.add({ ref: ch, scope: 5n, precommitment: pc(ch), state: "UNSPENT" }), /leaf/);
  await assert.rejects(t.ns.add({ ref: ch, scope: 5n, precommitment: pc(ch), state: "HELD" as "UNSPENT", leaf: leafOf(pc(ch)) }), /born PLANNED or UNSPENT/);
  await assert.rejects(t.ns.add({ ref: ch, scope: 5n, precommitment: pc(ch), state: "UNSPENT", leaf: leafOf(pc(ch)), parent: r.id }), /not a landed note/);
  await assert.rejects(t.ns.add({ ref: mv, scope: 5n, precommitment: pc(mv), state: "UNSPENT", leaf: leafOf(pc(mv)), parent: r.id }), /only a change or refund/);
  await assert.rejects(t.ns.add({ ref: mv, scope: 5n, precommitment: pc(mv), state: "PLANNED", nullifier: 1n } as never), /may not hold nullifier/);
  await assert.rejects(t.ns.add({ ref: { kind: "deposit", s: 6n, i: 0 }, scope: 5n, precommitment: pc(dep), state: "UNSPENT", leaf: leafOf(pc(dep)) }), /scope is its s/);
  assert.equal(t.puts(), puts, "every refusal wrote nothing");
  // restore finds a note already on chain: born UNSPENT with its leaf
  const found = await t.ns.add({ ref: mv, scope: 5n, precommitment: pc(mv), state: "UNSPENT", leaf: leafOf(pc(mv)) });
  assert.equal(found.state, "UNSPENT");
});

test("a change note is born UNSPENT naming its parent, and the parent goes to SPENT after it", async () => {
  const t = await tab();
  const p = await noteIn(t.ns, "RESERVED");
  const L = p.leaf!.label;
  const ch: NoteRef = { kind: "change", l: L, j: d.changeIndex({ kind: "deposit" }) };
  const writes: string[] = [];
  const w2: WalletStore = { ...t.w, put: async (s, k, v) => (writes.push(`${k}:${(v as NoteRecord).state}`), t.w.put(s, k, v)) };
  const ns = await openNoteStore(w2);
  const c = await ns.add({ ref: ch, scope: p.scope, precommitment: pc(ch), state: "UNSPENT", leaf: leafOf(pc(ch), 5n, L, 4n), parent: p.id });
  assert.deepEqual(writes, [`${c.id}:UNSPENT`, `${p.id}:SPENT`], "child first, then its parent");
  assert.equal((await ns.get(p.id))?.state, "SPENT");
  // the refund note of the same withdrawal also names it, and leaves a SPENT parent alone
  const rf: NoteRef = { kind: "refund", l: L, j: 0 };
  await ns.add({ ref: rf, scope: p.scope, precommitment: pc(rf), state: "UNSPENT", leaf: leafOf(pc(rf), 9n, 12n, 5n), parent: p.id });
  assert.equal(writes.length, 3);
});

test("deposit index: one unfunded index per scope, a new one only once money reached it, kept across a reopen", async () => {
  const idb = new IDBFactory();
  const t = await tab(idb);
  const lane = t.w.lane;
  const a = await t.ns.planDeposit(9n, pc);
  assert.deepEqual(a.ref, { kind: "deposit", s: 9n, i: lane });
  assert.equal(a.precommitment, pc(a.ref));
  assert.equal((await t.ns.planDeposit(9n, pc)).id, a.id, "every quote names the same index until money reaches it");
  const other = await t.ns.planDeposit(10n, pc);
  assert.equal((other.ref as { i: number }).i, lane, "each scope its own counter");
  t.w.close();
  const u = await tab(idb);
  assert.equal((await u.ns.planDeposit(9n, pc)).id, a.id, "the same after a reopen");
  await u.ns.move(a.id, "PLANNED", "INCOMING");
  const b = await u.ns.planDeposit(9n, pc);
  assert.deepEqual(b.ref, { kind: "deposit", s: 9n, i: lane + 8 });
  await u.ns.move(b.id, "PLANNED", "INCOMING");
  await assert.rejects(u.ns.planDeposit(9n, () => a.precommitment), /precommitment is already/);
});

test("second arrivals: n from 0 with no gap, and n + 1 only once n has landed", async () => {
  const t = await tab();
  const L = 77n;
  const A = { id: "A" as const, l: L, j: 0 };
  const sec = (n: number): NoteRef => ({ kind: "second", id: A, n });
  await assert.rejects(t.ns.add({ ref: sec(1), scope: 1n, precommitment: pc(sec(1)), state: "PLANNED" }), /waits until the note before it has landed/);
  const s0 = await t.ns.add({ ref: sec(0), scope: 1n, precommitment: pc(sec(0)), state: "PLANNED" });
  await assert.rejects(t.ns.add({ ref: sec(1), scope: 1n, precommitment: pc(sec(1)), state: "PLANNED" }), /waits/);
  await t.ns.move(s0.id, "PLANNED", "INCOMING");
  await assert.rejects(t.ns.add({ ref: sec(1), scope: 1n, precommitment: pc(sec(1)), state: "PLANNED" }), /waits/);
  await t.ns.move(s0.id, "INCOMING", "UNSPENT", { leaf: leafOf(s0.precommitment) });
  await t.ns.add({ ref: sec(1), scope: 1n, precommitment: pc(sec(1)), state: "PLANNED" });
  // U's second arrival 0 follows U's deposit note
  const dep = await t.ns.planDeposit(3n, pc);
  const U = { id: "U" as const, s: 3n, i: (dep.ref as { i: number }).i };
  const u0: NoteRef = { kind: "second", id: U, n: 0 };
  await assert.rejects(t.ns.add({ ref: u0, scope: 3n, precommitment: pc(u0), state: "PLANNED" }), /waits/);
  await t.ns.move(dep.id, "PLANNED", "INCOMING");
  await t.ns.move(dep.id, "INCOMING", "UNSPENT", { leaf: leafOf(dep.precommitment) });
  await t.ns.add({ ref: u0, scope: 3n, precommitment: pc(u0), state: "PLANNED" });
});

test("nothing is stored unwrapped, and a note holds no nullifier or secret", async () => {
  const t = await tab();
  const n = await noteIn(t.ns, "HELD");
  const raw = (await rawNote(t.idb, n.id))!;
  assert.deepEqual(Object.keys(raw).sort(), ["ct", "iv"]);
  const ct = new Uint8Array(raw.ct);
  for (const s of [n.precommitment.toString(), BIG.toString(), "HELD", "deposit", n.id]) assert.ok(!contains(ct, new TextEncoder().encode(s)), `${s} in clear`);
  const { nullifier, secret } = noteSecrets(SEED, n.ref);
  const back = (await t.w.get("notes", n.id)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(back).sort(), ["deadlineMs", "id", "leaf", "precommitment", "ref", "scope", "state"]);
  const text = JSON.stringify(back, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!text.includes(nullifier.toString()) && !text.includes(secret.toString()), "a secret in the record");
});

test("two tabs holding one note at once: exactly one holds it", async () => {
  const idb = new IDBFactory();
  const a = await tab(idb);
  const b = await tab(idb);
  const n = await noteIn(a.ns, "UNSPENT");
  const r = await Promise.allSettled([a.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1n }), b.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 2n })]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(String((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason), /is HELD, not UNSPENT/);
});

test("a write that fails part way leaves the note as it was", async () => {
  const t = await tab();
  const n = await noteIn(t.ns, "UNSPENT");
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
    if (this.name === "notes") throw new DOMException("killed mid-write", "AbortError");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(t.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1n }));
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  assert.deepEqual(await t.ns.get(n.id), n);
});

test("no Web Locks: the note store does not open", async () => {
  const t = await tab();
  await assert.rejects(openNoteStore(t.w, { locks: null }), /no Web Locks/);
});
