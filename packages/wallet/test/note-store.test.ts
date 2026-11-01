// The note store's states (card wallet-note-store; docs/plan1/wallet.md:198 at research 7838dbe, :385-391, :346-353,
// :176-192): every state, every legal and illegal edge, refusals that write nothing, births, the one unfunded deposit
// index, second arrivals in order, nothing secret stored unwrapped, two tabs on one note.
//   node --test test/note-store.test.ts      (from packages/wallet)
// IndexedDB is fake-indexeddb; WebCrypto and Web Locks are Node's own. Test secrets come from the first published BIP-39
// vector (all-zero entropy), as test/note-secrets.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, vaultNote, type NoteRef } from "../src/notes/secrets.ts";
import { NOTE_EDGES, NOTE_STATES, SEND_MARGIN_MS, openNoteStore, type Leaf, type NoteRecord, type NoteState, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const BIG = 123_456_789_012_345_678_901_234_567n; // above 2^53: amounts stay bigint end to end
const leafOf = (precommitment: bigint, value = BIG, label = 11n, leafIndex = 3n): Leaf => ({ value, label, commitment: noteCommitment(value, label, precommitment), leafIndex });

const opened: WalletStore[] = [];
const notes: NoteStore[] = [];
after(() => (opened.forEach((s) => s.close()), notes.forEach((n) => (n as { close?: () => void }).close?.())));

type Tab = { idb: IDBFactory; w: WalletStore; ns: NoteStore; puts: () => number };
async function tab(idb = new IDBFactory()): Promise<Tab> {
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  let n = 0;
  const counted: WalletStore = { ...w, put: async (s, k, v) => (n++, w.put(s, k, v)) };
  const ns = await openNoteStore(counted);
  notes.push(ns);
  return { idb, w, ns, puts: () => n };
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
let contexts = 1; // each attempt's own context (a decimal below p), as a withdrawal's
const fieldsFor = (from: NoteState, to: NoteState, n: NoteRecord) =>
  from === "INCOMING" && to === "UNSPENT"
    ? { leaf: leafOf(n.precommitment) }
    : to === "HELD"
      ? { deadlineMs: 1_800_000_000_000n, context: String(contexts++) }
      : from === "HELD"
        ? { attempt: n.attempt }
        : from === "RESERVED" && to === "UNSPENT"
          ? { blockTimeMs: n.deadlineMs! + 1n }
          : {};
// a fresh deposit note walked along the legal path to `state`
async function noteIn(ns: NoteStore, state: NoteState): Promise<NoteRecord> {
  const path: NoteState[] = ["PLANNED", "INCOMING", "UNSPENT", "HELD", "RESERVED", "SPENT"];
  let n = await ns.planDeposit(scopes++, pc);
  if (state === "TAKEN") return ns.move(n.id, "PLANNED", "TAKEN");
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
    "HELD>RESERVED", "HELD>SPENT", "HELD>UNSPENT", "INCOMING>UNSPENT", "PLANNED>INCOMING", "PLANNED>TAKEN",
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
  const held = await t.ns.move(un.id, "UNSPENT", "HELD", { deadlineMs: 77n, context: "77" });
  const res = await t.ns.move(held.id, "HELD", "RESERVED", { attempt: held.attempt });
  assert.equal(res.deadlineMs, 77n, "RESERVED keeps the attempt's deadline");
  assert.equal(res.attempt, held.attempt, "and its attempt");
  const back = await t.ns.move(held.id, "RESERVED", "UNSPENT", { blockTimeMs: 78n });
  assert.equal(back.deadlineMs, undefined, "back to UNSPENT drops it");
  assert.equal(back.attempt, undefined);
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
  await assert.rejects(t.ns.add({ ref: ch, scope: 5n, precommitment: pc(ch), state: "UNSPENT", leaf: leafOf(pc(ch), BIG, L), parent: r.id }), /is not the note change index 0 of label 41 comes from/);
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
  assert.notEqual(other.id, a.id, "the second scope gets its own deposit note");
  assert.deepEqual(other.ref, { kind: "deposit", s: 10n, i: lane }, "each scope its own counter");
  assert.equal(other.scope, 10n);
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
  assert.deepEqual(Object.keys(back).sort(), ["attempt", "contexts", "deadlineMs", "id", "leaf", "precommitment", "ref", "scope", "state", "tab"]);
  const text = JSON.stringify(back, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!text.includes(nullifier.toString()) && !text.includes(secret.toString()), "a secret in the record");
});

test("two tabs holding one note at once: exactly one holds it", async () => {
  const idb = new IDBFactory();
  const a = await tab(idb);
  const b = await tab(idb);
  const n = await noteIn(a.ns, "UNSPENT");
  const r = await Promise.allSettled([a.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "1" }), b.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 2n, context: "2" })]);
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
    await assert.rejects(t.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "1" }));
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  assert.deepEqual(await t.ns.get(n.id), n);
});

test("no Web Locks: the note store does not open", async () => {
  const t = await tab();
  await assert.rejects(openNoteStore(t.w, { locks: null }), /no Web Locks/);
});

// A tab that dies while it holds a note (wallet.md:389-390, the coordinator's call on 09af69f): each tab holds the Web
// Lock "ct-wallet/tab/<id>" for its life and its HELD notes name that id; the next open, or any list(), moves a HELD note
// whose tab lock is not held back to UNSPENT at once. Safe: RESERVED is written before a proof leaves the device.
const closeNotes = (ns: NoteStore): void => (ns as { close?: () => void }).close?.();

test("a HELD note from a dead tab is UNSPENT on the next open", async () => {
  const idb = new IDBFactory();
  const a = await tab(idb);
  const n = await noteIn(a.ns, "HELD");
  closeNotes(a.ns); // the tab dies: its tab lock goes
  a.w.close();
  const b = await tab(idb);
  const back = await b.ns.get(n.id);
  assert.equal(back?.state, "UNSPENT", "a dead tab's note waits for nothing");
  assert.equal(back?.deadlineMs, undefined);
  await assert.rejects(a.ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: "1" }), /closed/, "a dead tab holds nothing");
});

test("a HELD note from a live tab stays HELD, on open and on list, until that tab dies", async () => {
  const idb = new IDBFactory();
  const a = await tab(idb);
  const n = await noteIn(a.ns, "HELD");
  const b = await tab(idb); // a second tab opens while the first proves
  assert.equal((await b.ns.get(n.id))?.state, "HELD");
  assert.equal((await b.ns.list()).find((x) => x.id === n.id)?.state, "HELD");
  await assert.rejects(b.ns.move(n.id, "HELD", "RESERVED", { attempt: n.attempt }), /another attempt/, "only the tab that made the proof sends it");
  closeNotes(a.ns); // now it dies
  assert.equal((await b.ns.list()).find((x) => x.id === n.id)?.state, "UNSPENT", "list frees it at once");
});

// ---------- the review round on 171b8f5 (F1-F6, T1, T3) ----------
const A8 = JSON.parse(readFileSync(new URL("./vectors/a8.json", import.meta.url), "utf8"));

test("T1: noteCommitment is the vault note's commitment on A.8's deposit line", () => {
  const e = (A8.notes as { note: string; s: string; i: string; value?: string; label?: string; commitment?: string }[]).find((x) => x.note === "deposit" && x.commitment)!;
  const ref: NoteRef = { kind: "deposit", s: BigInt(`0x${e.s}`), i: Number(e.i) };
  const s = noteSecrets(SEED, ref);
  const value = BigInt(e.value!);
  const label = BigInt(`0x${e.label}`);
  const want = vaultNote(s, value, label).commitment;
  assert.equal(want, BigInt(`0x${e.commitment}`), "A.8's line");
  assert.equal(noteCommitment(value, label, s.precommitment), want);
});

// a landed note of `label` in `scope`, walked from PLANNED (a deposit note) or added UNSPENT (a change note)
async function landed(ns: NoteStore, scope: bigint, label: bigint, value: bigint): Promise<NoteRecord> {
  const n = await ns.planDeposit(scope, pc);
  await ns.move(n.id, "PLANNED", "INCOMING");
  return ns.move(n.id, "INCOMING", "UNSPENT", { leaf: leafOf(n.precommitment, value, label) });
}
async function reserved(ns: NoteStore, n: NoteRecord, deadlineMs: bigint): Promise<NoteRecord> {
  const h = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs, context: String(contexts++) });
  return ns.move(n.id, "HELD", "RESERVED", { attempt: h.attempt });
}

test("F1: RESERVED goes back to UNSPENT only once block time is past its deadline_ms; a proof landing at its deadline is SPENT, never counted twice", async () => {
  const t = await tab();
  const X = await landed(t.ns, 901n, 9001n, 100n);
  const r = await reserved(t.ns, X, 5_000n);
  const puts = t.puts();
  await assert.rejects(t.ns.move(X.id, "RESERVED", "UNSPENT"), /can still land/, "the relayer said refused: not evidence");
  await assert.rejects(t.ns.move(X.id, "RESERVED", "UNSPENT", { blockTimeMs: 5_000n }), /can still land/, "at its deadline it can still land");
  await assert.rejects(t.ns.move(X.id, "RESERVED", "UNSPENT", { blockTimeMs: 4_000 as unknown as bigint }), /blockTimeMs/);
  assert.equal(t.puts(), puts);
  // the world: the refused proof lands at block time 5,000 after all; the store still says RESERVED, so the spend is
  // recorded through its change note and nothing is counted twice
  const ch: NoteRef = { kind: "change", l: 9001n, j: 0 };
  await t.ns.add({ ref: ch, scope: 901n, precommitment: pc(ch), state: "UNSPENT", leaf: leafOf(pc(ch), 40n, 9001n, 8n), parent: r.id });
  const all = await t.ns.list();
  assert.equal(all.find((n) => n.id === X.id)?.state, "SPENT");
  assert.equal(all.filter((n) => n.state === "UNSPENT" || n.state === "HELD").reduce((a, n) => a + n.leaf!.value, 0n), 40n);
  // a RESERVED note whose deadline has passed with nothing landed goes back
  const Y = await landed(t.ns, 902n, 9002n, 7n);
  await reserved(t.ns, Y, 6_000n);
  assert.equal((await t.ns.move(Y.id, "RESERVED", "UNSPENT", { blockTimeMs: 6_001n })).state, "UNSPENT");
});

test("F2: the parent comes from the child's (l, j): a wrong parent, j, label or scope is refused; an unnamed parent is found", async () => {
  const t = await tab();
  const X = await landed(t.ns, 911n, 9101n, 100n);
  const Y = await landed(t.ns, 911n, 9102n, 50n);
  await t.ns.move(X.id, "UNSPENT", "HELD", { deadlineMs: 9n, context: String(contexts++) }).then((h) => t.ns.move(X.id, "HELD", "RESERVED", { attempt: h.attempt }));
  const ch0: NoteRef = { kind: "change", l: 9101n, j: 0 };
  const puts = t.puts();
  await assert.rejects(t.ns.add({ ref: ch0, scope: 911n, precommitment: pc(ch0), state: "UNSPENT", leaf: leafOf(pc(ch0), 60n, 9101n, 9n), parent: Y.id }), /is not the note/, "X's change naming Y");
  const ch1: NoteRef = { kind: "change", l: 9101n, j: 1 };
  await assert.rejects(t.ns.add({ ref: ch1, scope: 911n, precommitment: pc(ch1), state: "UNSPENT", leaf: leafOf(pc(ch1), 60n, 9101n, 9n), parent: X.id }), /is not the note/, "j 1 is not a deposit's change");
  await assert.rejects(t.ns.add({ ref: ch0, scope: 911n, precommitment: pc(ch0), state: "UNSPENT", leaf: leafOf(pc(ch0), 60n, 9999n, 9n), parent: X.id }), /keeps its label/);
  await assert.rejects(t.ns.add({ ref: ch0, scope: 912n, precommitment: pc(ch0), state: "UNSPENT", leaf: leafOf(pc(ch0), 60n, 9101n, 9n), parent: X.id }), /is not the note/, "another scope");
  assert.equal(t.puts(), puts);
  // named nowhere, still linked: the store finds X from (l, j) and X goes SPENT
  const c = await t.ns.add({ ref: ch0, scope: 911n, precommitment: pc(ch0), state: "UNSPENT", leaf: leafOf(pc(ch0), 60n, 9101n, 9n) });
  assert.equal(c.parent, X.id);
  assert.equal((await t.ns.get(X.id))?.state, "SPENT");
  assert.equal((await t.ns.get(Y.id))?.state, "UNSPENT", "Y untouched");
  // change note 1 comes from change note 0
  await t.ns.move(c.id, "UNSPENT", "HELD", { deadlineMs: 9n, context: String(contexts++) }).then((h) => t.ns.move(c.id, "HELD", "RESERVED", { attempt: h.attempt }));
  const c1 = await t.ns.add({ ref: ch1, scope: 911n, precommitment: pc(ch1), state: "UNSPENT", leaf: leafOf(pc(ch1), 10n, 9101n, 10n), parent: c.id });
  assert.equal(c1.parent, c.id);
});

test("F3: only the attempt that holds a note sends or drops it; another tab frees it only past deadline_ms less the send margin", async () => {
  const idb = new IDBFactory();
  const a = await tab(idb);
  const b = await tab(idb);
  const X = await landed(a.ns, 921n, 9201n, 100n);
  // same tab: P1 dropped, P2 holds, P1's late finish is refused
  const p1 = await a.ns.move(X.id, "UNSPENT", "HELD", { deadlineMs: 1_000_000n, context: String(contexts++) });
  await a.ns.move(X.id, "HELD", "UNSPENT", { attempt: p1.attempt });
  const p2 = await a.ns.move(X.id, "UNSPENT", "HELD", { deadlineMs: 2_000_000n, context: String(contexts++) });
  assert.notEqual(p2.attempt, p1.attempt);
  await assert.rejects(a.ns.move(X.id, "HELD", "RESERVED", { attempt: p1.attempt }), /another attempt/);
  await assert.rejects(a.ns.move(X.id, "HELD", "RESERVED"), /another attempt/);
  // another (live) tab: not before deadline_ms - margin
  await assert.rejects(b.ns.move(X.id, "HELD", "UNSPENT"), /another attempt/);
  await assert.rejects(b.ns.move(X.id, "HELD", "UNSPENT", { blockTimeMs: 2_000_000n - SEND_MARGIN_MS }), /another attempt/);
  await assert.rejects(b.ns.move(X.id, "HELD", "UNSPENT", { attempt: p2.attempt }), /another attempt/, "the token alone is not the tab");
  assert.equal((await b.ns.move(X.id, "HELD", "UNSPENT", { blockTimeMs: 2_000_000n - SEND_MARGIN_MS + 1n })).state, "UNSPENT");
  await assert.rejects(a.ns.move(X.id, "HELD", "RESERVED", { attempt: p2.attempt }), /is UNSPENT, not HELD/, "P2 freed: its send is refused");
});

test("F4: a PLANNED deposit index with history this store did not record is TAKEN for good, and the next plan names a new index", async () => {
  const t = await tab();
  const a = await t.ns.planDeposit(931n, pc);
  const taken = await t.ns.move(a.id, "PLANNED", "TAKEN");
  assert.equal(taken.state, "TAKEN");
  for (const to of NOTE_STATES) await assert.rejects(t.ns.move(a.id, "TAKEN", to), /never goes from/);
  const b = await t.ns.planDeposit(931n, pc);
  assert.notEqual(b.id, a.id);
  assert.equal((b.ref as { i: number }).i, (a.ref as { i: number }).i + 8);
  const r: NoteRef = { kind: "return", c: "sol", l: 5n, j: 0 };
  const ret = await t.ns.add({ ref: r, scope: 931n, precommitment: pc(r), state: "PLANNED" });
  await assert.rejects(t.ns.move(ret.id, "PLANNED", "TAKEN"), /only a deposit index/);
});

test("F5: a precommitmentOf that throws burns no index", async () => {
  const t = await tab();
  for (let k = 0; k < 5; k++) await assert.rejects(t.ns.planDeposit(941n, () => { throw new Error("seed not ready"); }), /seed not ready/);
  assert.equal(((await t.ns.planDeposit(941n, pc)).ref as { i: number }).i, t.w.lane, "the first index is the lane's first");
});

test("T3/F6: tab A killed between the child and the parent write: already-open tab B sees the parent SPENT whichever it calls first, list, get or move (RESERVED and UNSPENT parents)", async () => {
  for (const [parentState, first] of [["RESERVED", "list"], ["UNSPENT", "list"], ["RESERVED", "get"], ["UNSPENT", "get"], ["RESERVED", "move"], ["UNSPENT", "move"]] as const) {
    const idb = new IDBFactory();
    const wa = await openWalletStore({ indexedDB: idb });
    opened.push(wa);
    let n = 0;
    let killAfter = Infinity;
    const dying: WalletStore = {
      ...wa,
      put: async (s, k, v) => {
        await wa.put(s, k, v);
        if (++n >= killAfter) throw new Error("killed");
      },
    };
    const a = await openNoteStore(dying);
    notes.push(a);
    const b = (await tab(idb)).ns; // open before the kill
    const X = await landed(a, 951n, 9501n, 100n);
    if (parentState === "RESERVED") await reserved(a, X, 7n);
    const ch: NoteRef = { kind: "change", l: 9501n, j: 0 };
    killAfter = n + 1; // the child's write lands, then the page dies
    await assert.rejects(a.add({ ref: ch, scope: 951n, precommitment: pc(ch), state: "UNSPENT", leaf: leafOf(pc(ch), 30n, 9501n, 9n), parent: X.id }), /killed/);
    a.close();
    // B's first call after the kill is `first`; each must see the parent SPENT on its own
    const at = `${parentState}, ${first} first`;
    if (first === "list") {
      const all = await b.list();
      assert.equal(all.find((x) => x.id === X.id)?.state, "SPENT", at);
      assert.equal(all.filter((x) => x.state === "UNSPENT" || x.state === "HELD").reduce((s, x) => s + x.leaf!.value, 0n), 30n, `${at}: counted once`);
    } else if (first === "get") {
      assert.equal((await b.get(X.id))?.state, "SPENT", at);
    } else {
      // an edge that would be legal for the stale state
      const stale = parentState === "RESERVED" ? b.move(X.id, "RESERVED", "UNSPENT", { blockTimeMs: 8n }) : b.move(X.id, "UNSPENT", "HELD", { deadlineMs: 1n, context: String(contexts++) });
      await assert.rejects(stale, /is SPENT/, at);
    }
    const all = await b.list();
    assert.equal(all.filter((x) => x.state === "UNSPENT" || x.state === "HELD").reduce((s, x) => s + x.leaf!.value, 0n), 30n, `${at}: counted once after`);
  }
});

test("F6: a move of a parent that is not yet SPENT is finished first: only the move to SPENT is answered", async () => {
  const idb = new IDBFactory();
  const wa = await openWalletStore({ indexedDB: idb });
  opened.push(wa);
  let kill = false;
  const a = await openNoteStore({ ...wa, put: async (s, k, v) => { await wa.put(s, k, v); if (kill) throw new Error("killed"); } });
  notes.push(a);
  const b = (await tab(idb)).ns;
  const X = await landed(a, 961n, 9601n, 100n);
  const r = await reserved(a, X, 7n);
  const ch: NoteRef = { kind: "change", l: 9601n, j: 0 };
  kill = true;
  await assert.rejects(a.add({ ref: ch, scope: 961n, precommitment: pc(ch), state: "UNSPENT", leaf: leafOf(pc(ch), 30n, 9601n, 9n), parent: X.id }), /killed/);
  a.close();
  assert.equal((await b.move(X.id, "RESERVED", "SPENT")).state, "SPENT", "the move it asked for is done");
  await assert.rejects(b.move(X.id, "RESERVED", "UNSPENT", { blockTimeMs: r.deadlineMs! + 1n }), /is SPENT, not RESERVED/);
});

test("a closed store writes nothing, also for a move already in flight", async () => {
  const t = await tab();
  const X = await landed(t.ns, 971n, 9701n, 100n);
  const h = await t.ns.move(X.id, "UNSPENT", "HELD", { deadlineMs: 5_000n, context: String(contexts++) });
  const p = t.ns.move(X.id, "HELD", "RESERVED", { attempt: h.attempt });
  t.ns.close();
  await assert.rejects(p, /closed/);
  assert.equal((await (await tab(t.idb)).ns.get(X.id))?.state, "UNSPENT", "the dead tab's HELD note is freed, never RESERVED");
});

test("N1: a change note keeps its label: one whose leaf label is not its l is refused, with or without a parent in the store", async () => {
  const t = await tab();
  const c0: NoteRef = { kind: "change", l: 5n, j: 0 };
  const puts = t.puts();
  await assert.rejects(t.ns.add({ ref: c0, scope: 3n, precommitment: pc(c0), state: "UNSPENT", leaf: leafOf(pc(c0), 100n, 77n) }), /keeps its label/);
  assert.equal(t.puts(), puts);
  // with the right label it is a note restore found, and its own change finds it as parent
  const a = await t.ns.add({ ref: c0, scope: 3n, precommitment: pc(c0), state: "UNSPENT", leaf: leafOf(pc(c0), 100n, 5n) });
  const c1: NoteRef = { kind: "change", l: 5n, j: 1 };
  const b = await t.ns.add({ ref: c1, scope: 3n, precommitment: pc(c1), state: "UNSPENT", leaf: leafOf(pc(c1), 60n, 5n, 4n) });
  assert.equal(b.parent, a.id);
  assert.equal((await t.ns.list()).filter((n) => n.state === "UNSPENT").reduce((s, n) => s + n.leaf!.value, 0n), 60n);
});

// ---------- bind calls (card wallet-deposit-bind, R2-2) ----------
const U_ID = "ab".repeat(32);
const aCall = (nonce: bigint, mbh: bigint) => ({
  signed_delegate: Buffer.from(`call ${nonce} ${mbh}`).toString("base64"), sender_id: U_ID, receiver_id: "usdc.fakes.testnet",
  nonce, max_block_height: mbh, public_key: "ed25519:" + "1".repeat(32) + "AbCd", balance: 100_000_000n,
});
const HASH = (k: number) => "H".repeat(43) + String(k % 10).replace("0", "a");

test("bind calls: written only on an INCOMING note, a compare-and-set on the count, one put each, kept once the note lands", async () => {
  const t = await tab();
  const planned = await t.ns.planDeposit(scopes++, pc);
  await assert.rejects(t.ns.addCall(planned.id, aCall(5n, 100n), 0), /INCOMING/);
  const n = await t.ns.move(planned.id, "PLANNED", "INCOMING");
  const p0 = t.puts();
  const one = await t.ns.addCall(n.id, aCall(5n, 100n), 0);
  assert.equal(t.puts() - p0, 1);
  assert.equal(one.calls!.length, 1);
  assert.deepEqual(one.calls![0]!.tx_hashes, []);
  // another bind read no call: its call is not written
  const p1 = t.puts();
  const stale = await t.ns.addCall(n.id, aCall(5n, 200n), 0);
  assert.equal(t.puts() - p1, 0);
  assert.equal(stale.calls!.length, 1);
  assert.equal(stale.calls![0]!.max_block_height, 100n);
  const ahead = await t.ns.addCall(n.id, aCall(5n, 200n), 2); // a count the note does not hold: not written either
  assert.equal(ahead.calls!.length, 1);
  assert.equal(t.puts() - p1, 0);
  // a same-nonce re-sign with a new window, then a hash heard for it, once
  await t.ns.addCall(n.id, aCall(5n, 200n), 1);
  await t.ns.addCallTx(n.id, { nonce: 5n, max_block_height: 200n }, HASH(1));
  const p2 = t.puts();
  await t.ns.addCallTx(n.id, { nonce: 5n, max_block_height: 200n }, HASH(1));
  assert.equal(t.puts() - p2, 0);
  await assert.rejects(t.ns.addCallTx(n.id, { nonce: 5n, max_block_height: 300n }, HASH(2)), /no such call/);
  const landed = await t.ns.move(n.id, "INCOMING", "UNSPENT", { leaf: leafOf(n.precommitment) });
  assert.deepEqual(landed.calls!.map((c) => [c.nonce, c.max_block_height, c.tx_hashes]), [[5n, 100n, []], [5n, 200n, [HASH(1)]]]);
  await assert.rejects(t.ns.addCall(n.id, aCall(6n, 300n), 2), /UNSPENT/); // a landed note gets no new call
  // read back by a new tab on the same database
  const t2 = await tab(t.idb);
  assert.deepEqual((await t2.ns.get(n.id))!.calls, landed.calls);
});

test("bind calls: another shape, another sender, a nonce going back or a call written twice is refused with no write", async () => {
  const t = await tab();
  const n = await t.ns.move((await t.ns.planDeposit(scopes++, pc)).id, "PLANNED", "INCOMING");
  await t.ns.addCall(n.id, aCall(5n, 100n), 0);
  const p0 = t.puts();
  const bad: [string, Record<string, unknown>][] = [
    ["an extra field", { ...aCall(6n, 1n), secret: "x" }],
    ["a tx_hashes field", { ...aCall(6n, 1n), tx_hashes: [] }],
    ["not base64", { ...aCall(6n, 1n), signed_delegate: "not base64!" }],
    ["U not an implicit id", { ...aCall(6n, 1n), sender_id: "u.testnet" }],
    ["a number nonce", { ...aCall(6n, 1n), nonce: 6 }],
    ["a zero window", { ...aCall(6n, 1n), max_block_height: 0n }],
    ["a negative balance", { ...aCall(6n, 1n), balance: -1n }],
    ["another key type", { ...aCall(6n, 1n), public_key: "secp256k1:abc" }],
    ["another sender", { ...aCall(6n, 1n), sender_id: "cd".repeat(32) }],
    ["a nonce going back", aCall(4n, 300n)],
    ["the same call twice", aCall(5n, 100n)],
  ];
  for (const [what, c] of bad) await assert.rejects(t.ns.addCall(n.id, c as never, 1), Error, what);
  await assert.rejects(t.ns.addCallTx(n.id, { nonce: 5n, max_block_height: 100n }, "0OIl"), /base58/);
  assert.equal(t.puts() - p0, 0);
  assert.equal((await t.ns.get(n.id))!.calls!.length, 1);
});

test("bind calls: a planted record with calls on a PLANNED note is refused when read", async () => {
  const t = await tab();
  const n = await t.ns.planDeposit(scopes++, pc);
  await t.w.put("notes", n.id, { ...n, calls: [{ ...aCall(5n, 100n), tx_hashes: [] }] });
  await assert.rejects(t.ns.get(n.id), /calls from INCOMING on/);
});
