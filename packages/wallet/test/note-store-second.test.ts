// node --test packages/wallet/test/note-store-second.test.ts: a HELD note's second attempt (card
// buy-spends-several-pieces, src/notes/store.ts "Second attempts"): a note the proof queue keeps ready on its own W
// (tier 1) and as a piece to the primary's W (tier 2) holds two unsent proofs at once. The second attempt's context is
// written before its proof starts; HELD -> RESERVED by either attempt drops the other attempt and its never-sent context
// in the same note write; HELD -> HELD replaces only its own attempt; HELD -> UNSPENT and a dead tab's free release
// both; release() lets one go. The note's row keeps release 116's keys, so a tab still on it reads every note.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { heldBy, openNoteStore, readNotes, type Leaf, type NoteRecord, type NoteStore } from "../src/notes/store.ts";
import * as old116 from "./note-store-116.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const leafOf = (precommitment: bigint, value: bigint, label: bigint, leafIndex = 3n): Leaf => ({ value, label, commitment: noteCommitment(value, label, precommitment), leafIndex });

const opened: WalletStore[] = [];
const stores: NoteStore[] = [];
after(() => (stores.forEach((n) => n.close()), opened.forEach((s) => s.close())));

type Tab = { idb: IDBFactory; w: WalletStore; ns: NoteStore; puts: () => number };
async function tab(idb = new IDBFactory()): Promise<Tab> {
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  let n = 0;
  const counted: WalletStore = { ...w, put: async (s, k, v) => (s === "notes" && n++, w.put(s, k, v)) };
  const ns = await openNoteStore(counted);
  stores.push(ns);
  return { idb, w, ns, puts: () => n };
}
let scopes = 700n;
let ctx = 1_000;
const next = (): string => String(ctx++);
/** A landed note, then HELD by a first attempt and a second, each with its own context and deadline. */
async function twice(ns: NoteStore, d1 = 900_000n, d2 = 960_000n): Promise<{ n: NoteRecord; c1: string; c2: string; a1: string; a2: string }> {
  const p = await ns.planDeposit(scopes++, pc);
  await ns.move(p.id, "PLANNED", "INCOMING");
  await ns.move(p.id, "INCOMING", "UNSPENT", { leaf: leafOf(p.precommitment, 100n, 9_000n + scopes) });
  const c1 = next(), c2 = next();
  const h = await ns.move(p.id, "UNSPENT", "HELD", { deadlineMs: d1, context: c1 });
  const n = await ns.holdSecond(p.id, h.attempt!, { deadlineMs: d2, context: c2 });
  return { n, c1, c2, a1: h.attempt!, a2: n.second!.attempt };
}
const OLD_KEYS = ["id", "ref", "scope", "precommitment", "state", "parent", "leaf", "deadlineMs", "attempt", "tab", "calls", "searchFrom", "sends", "evmSends", "evmSpent", "contexts", "request"];

test("a second attempt: its context written before its proof starts, on this tab's HELD note by one of its attempts, one at a time; the row keeps release 116's keys", async () => {
  const t = await tab();
  const puts = t.puts();
  const { n, c1, c2, a1, a2 } = await twice(t.ns);
  assert.equal(t.puts(), puts + 5, "plan, incoming, unspent, held, then one write for the second");
  assert.equal(n.state, "HELD");
  assert.equal(n.attempt, a1, "the first attempt still holds it");
  assert.match(a2, /^[0-9a-f]{32}$/);
  assert.notEqual(a2, a1);
  assert.deepEqual(n.second, { attempt: a2, deadlineMs: 960_000n, context: c2 });
  // the main attempt's entry stays last (its deadline is the note's): the second's sits before it
  assert.deepEqual(n.contexts, [{ context: c2, deadlineMs: 960_000n }, { context: c1, deadlineMs: 900_000n }]);
  assert.ok(heldBy(n, a1) && heldBy(n, a2) && !heldBy(n, "0".repeat(32)));
  // read back: get, list and the lockless reader all see it
  assert.deepEqual((await t.ns.get(n.id))?.second, n.second);
  assert.deepEqual((await t.ns.list()).find((x) => x.id === n.id)?.second, n.second);
  assert.deepEqual((await readNotes(t.w)).find((x) => x.id === n.id)?.second, n.second);
  // the stored row: no key release 116's reader refuses, and that reader reads it
  const row = (await t.w.get("notes", n.id)) as Record<string, unknown>;
  for (const k of Object.keys(row)) assert.ok(OLD_KEYS.includes(k), `the row holds ${k}`);
  assert.equal((await old116.readNotes(t.w)).find((x) => x.id === n.id)?.state, "HELD");
  // refused, nothing written: a third, another attempt's, a context the note holds, a note not HELD, another tab's
  const at = t.puts();
  await assert.rejects(t.ns.holdSecond(n.id, a1, { deadlineMs: 1n, context: next() }), /second attempt/);
  await assert.rejects(t.ns.holdSecond(n.id, a2, { deadlineMs: 1n, context: next() }), /second attempt/);
  const m = await twice(t.ns);
  await t.ns.release(m.n.id, m.a2);
  await assert.rejects(t.ns.holdSecond(m.n.id, "0".repeat(32), { deadlineMs: 1n, context: next() }), /another attempt/);
  await assert.rejects(t.ns.holdSecond(m.n.id, m.a1, { deadlineMs: 1n, context: m.c1 }), /written twice/);
  await assert.rejects(t.ns.holdSecond(m.n.id, m.a1, { deadlineMs: 0n, context: next() }), /deadlineMs/);
  const b = await tab(t.idb);
  await assert.rejects(b.ns.holdSecond(m.n.id, m.a1, { deadlineMs: 1n, context: next() }), /another attempt/);
  const p = await t.ns.planDeposit(scopes++, pc);
  await assert.rejects(t.ns.holdSecond(p.id, m.a1, { deadlineMs: 1n, context: next() }), /PLANNED/);
  assert.equal(t.puts(), at + 7, "the second note's five writes, its release and the plan only");
});

test("HELD -> RESERVED by the first attempt: the second and its never-sent context go in the same write; the second is never sent", async () => {
  const t = await tab();
  const { n, c1, a1, a2 } = await twice(t.ns);
  const puts = t.puts();
  const r = await t.ns.move(n.id, "HELD", "RESERVED", { attempt: a1, lastHeight: 1_000n });
  assert.equal(t.puts(), puts + 1, "one note write");
  assert.equal(r.attempt, a1);
  assert.equal(r.second, undefined);
  assert.deepEqual(r.contexts, [{ context: c1, deadlineMs: 900_000n }]);
  assert.equal((await t.ns.get(n.id))?.second, undefined);
  await assert.rejects(t.ns.move(n.id, "HELD", "RESERVED", { attempt: a2 }), /is RESERVED, not HELD/);
  await assert.rejects(t.ns.release(n.id, a2), /RESERVED/);
  assert.equal((await t.ns.marks()).get(n.id)?.attempt, a1);
});

test("HELD -> RESERVED by the second attempt: it becomes the note's attempt, its context last at its deadline; the first and its context go in the same write", async () => {
  const t = await tab();
  const { n, c2, a1, a2 } = await twice(t.ns);
  const puts = t.puts();
  const r = await t.ns.move(n.id, "HELD", "RESERVED", { attempt: a2, lastHeight: 2_000n, request: "{}" });
  assert.equal(t.puts(), puts + 1, "one note write");
  assert.equal(r.state, "RESERVED");
  assert.equal(r.attempt, a2);
  assert.equal(r.deadlineMs, 960_000n);
  assert.equal(r.request, "{}");
  assert.equal(r.second, undefined);
  // relay.ts and pool-withdraw.ts read a RESERVED note's attempt as its last context: the second's now
  assert.deepEqual(r.contexts, [{ context: c2, deadlineMs: 960_000n }]);
  assert.deepEqual(await t.ns.get(n.id), r);
  assert.deepEqual((await t.ns.marks()).get(n.id), { attempt: a2, lastHeight: 2_000n });
  await assert.rejects(t.ns.move(n.id, "HELD", "RESERVED", { attempt: a1 }), /is RESERVED, not HELD/, "never two sends of one note");
  // freed by its own mark's height, as any RESERVED note
  assert.equal((await t.ns.move(n.id, "RESERVED", "UNSPENT", { finalHeight: 2_001n })).state, "UNSPENT");
});

test("HELD -> HELD replaces only its own attempt: the first's remake keeps the second, the second's keeps the first", async () => {
  const t = await tab();
  const { n, c1, c2, a1, a2 } = await twice(t.ns);
  // the second's remake: a new second attempt and context, the first untouched and its entry last
  const c3 = next();
  const s = await t.ns.move(n.id, "HELD", "HELD", { attempt: a2, deadlineMs: 1_020_000n, context: c3 });
  assert.equal(s.attempt, a1);
  assert.equal(s.deadlineMs, 900_000n);
  assert.notEqual(s.second!.attempt, a2);
  assert.deepEqual(s.second, { attempt: s.second!.attempt, deadlineMs: 1_020_000n, context: c3 });
  assert.deepEqual(s.contexts!.map((c) => c.context), [c3, c1]);
  await assert.rejects(t.ns.move(n.id, "HELD", "RESERVED", { attempt: a2 }), /another attempt/, "the replaced second is never sent");
  // the first's remake: a new first attempt, the second kept
  const c4 = next();
  const f = await t.ns.move(n.id, "HELD", "HELD", { attempt: a1, deadlineMs: 1_080_000n, context: c4 });
  assert.notEqual(f.attempt, a1);
  assert.equal(f.deadlineMs, 1_080_000n);
  assert.deepEqual(f.second, s.second);
  assert.deepEqual(f.contexts!.map((c) => c.context), [c3, c4]);
  await assert.rejects(t.ns.move(n.id, "HELD", "RESERVED", { attempt: a1 }), /another attempt/);
  assert.ok(!f.contexts!.some((c) => c.context === c2), "the replaced second's context is gone");
  assert.equal((await t.ns.move(n.id, "HELD", "RESERVED", { attempt: s.second!.attempt })).attempt, s.second!.attempt);
});

test("HELD -> UNSPENT by either attempt releases both, both contexts gone; release() lets one go and the other keeps the note HELD", async () => {
  const t = await tab();
  // the holder's free, by the first or by the second
  for (const by of ["a1", "a2"] as const) {
    const x = await twice(t.ns);
    const u = await t.ns.move(x.n.id, "HELD", "UNSPENT", { attempt: x[by] });
    assert.equal(u.state, "UNSPENT");
    assert.equal(u.contexts, undefined, `${by}: neither unsent context stays`);
    assert.equal(u.second, undefined);
  }
  // release the second: the first holds on, its context alone
  const y = await twice(t.ns);
  const r2 = await t.ns.release(y.n.id, y.a2);
  assert.equal(r2.state, "HELD");
  assert.equal(r2.attempt, y.a1);
  assert.equal(r2.second, undefined);
  assert.deepEqual(r2.contexts!.map((c) => c.context), [y.c1]);
  await assert.rejects(t.ns.move(y.n.id, "HELD", "RESERVED", { attempt: y.a2 }), /another attempt/);
  // release the first: the second holds on as the note's attempt, its deadline the note's
  const z = await twice(t.ns);
  const r1 = await t.ns.release(z.n.id, z.a1);
  assert.equal(r1.state, "HELD");
  assert.equal(r1.attempt, z.a2);
  assert.equal(r1.deadlineMs, 960_000n);
  assert.equal(r1.second, undefined);
  assert.deepEqual(r1.contexts, [{ context: z.c2, deadlineMs: 960_000n }]);
  assert.deepEqual(await t.ns.get(z.n.id), r1);
  await assert.rejects(t.ns.move(z.n.id, "HELD", "RESERVED", { attempt: z.a1 }), /another attempt/);
  // the last attempt released: UNSPENT
  assert.equal((await t.ns.release(z.n.id, z.a2)).state, "UNSPENT");
  await assert.rejects(t.ns.release(z.n.id, z.a2), /UNSPENT/);
  // another tab never releases this tab's attempt
  const w = await twice(t.ns);
  const b = await tab(t.idb);
  await assert.rejects(b.ns.release(w.n.id, w.a2), /another attempt/);
});

test("a dead tab's HELD note is freed with both its attempts; another tab frees a live one only past the later deadline less the margin", async () => {
  const idb = new IDBFactory();
  const a = await tab(idb);
  const x = await twice(a.ns, 900_000n, 960_000n);
  const b = await tab(idb);
  // past the first's deadline less the margin, not the second's: refused
  await assert.rejects(b.ns.move(x.n.id, "HELD", "UNSPENT", { blockTimeMs: 960_000n - 30_000n }), /another attempt/);
  const y = await twice(a.ns);
  assert.equal((await b.ns.move(y.n.id, "HELD", "UNSPENT", { blockTimeMs: 960_000n - 29_999n })).contexts, undefined);
  a.ns.close(); // the tab dies
  const back = await b.ns.get(x.n.id);
  assert.equal(back?.state, "UNSPENT");
  assert.equal(back?.contexts, undefined, "neither attempt was sent");
  assert.equal(back?.second, undefined);
});

test("a second left behind by release 116's free (its context kept on the note) is never live again: the next hold of the note starts clean", async () => {
  const idb = new IDBFactory();
  const a = await tab(idb);
  const x = await twice(a.ns);
  // a tab still on release 116 frees the note past its deadline less the margin: it drops the last context only
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  const o = await old116.openNoteStore(w);
  await o.move(x.n.id, "HELD", "UNSPENT", { blockTimeMs: 960_000n });
  (o as { close?: () => void }).close?.();
  const u = (await a.ns.get(x.n.id))!;
  assert.equal(u.state, "UNSPENT");
  assert.deepEqual(u.contexts!.map((c) => c.context), [x.c2], "release 116 keeps the second's context, which was never sent");
  // this tab holds it again: the old second is gone, never sent
  const h = await a.ns.move(x.n.id, "UNSPENT", "HELD", { deadlineMs: 900_000n, context: next() });
  assert.equal(h.second, undefined);
  await assert.rejects(a.ns.move(x.n.id, "HELD", "RESERVED", { attempt: x.a2 }), /another attempt/);
  assert.equal((await a.ns.holdSecond(x.n.id, h.attempt!, { deadlineMs: 960_000n, context: next() })).second!.deadlineMs, 960_000n);
});

test("a crash between the second's two writes leaves no live second: the note as before, nothing that could be sent", async () => {
  const idb = new IDBFactory();
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  let fail = false;
  const ns = await openNoteStore({ ...w, put: async (s, k, v) => (s === "notes" && fail ? Promise.reject(new Error("crash")) : w.put(s, k, v)) });
  stores.push(ns);
  const p = await ns.planDeposit(scopes++, pc);
  await ns.move(p.id, "PLANNED", "INCOMING");
  await ns.move(p.id, "INCOMING", "UNSPENT", { leaf: leafOf(p.precommitment, 100n, 99n) });
  const h = await ns.move(p.id, "UNSPENT", "HELD", { deadlineMs: 900_000n, context: next() });
  fail = true;
  await assert.rejects(ns.holdSecond(p.id, h.attempt!, { deadlineMs: 960_000n, context: next() }), /crash/);
  fail = false;
  assert.deepEqual(await ns.get(p.id), h, "the note as it was, no second");
  assert.equal((await ns.holdSecond(p.id, h.attempt!, { deadlineMs: 960_000n, context: next() })).state, "HELD", "made again");
});
