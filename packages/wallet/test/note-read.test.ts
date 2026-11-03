// readNotes: the notes as the note store would list them, read only (card balances-per-chain; src/notes/store.ts). The
// signing page's state read (its balance per chain's pool) runs on every state ask, so it must never write: no freeing
// of a dead tab's HELD note, no finishing of a parent, no Web Lock. It still reads the same truth: a parent whose child
// is written counts as SPENT (in memory), so a page killed between the two writes never counts the money twice.
//   node --test test/note-read.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { NOTES_LOCK, openNoteStore, readNotes, type Leaf, type NoteRecord } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const pc = (ref: NoteRef): bigint => noteSecrets(SEED, ref).precommitment;
const leafOf = (precommitment: bigint, value: bigint, label: bigint, leafIndex: bigint): Leaf => ({ value, label, commitment: noteCommitment(value, label, precommitment), leafIndex });

const opened: WalletStore[] = [];
after(() => opened.forEach((s) => s.close()));

const SCOPE = 4242n;
const L = 77n;
const DEAD_TAB = "d".repeat(32); // no live tab holds "ct-wallet/tab/ddd…"
const hex = (b: ArrayBuffer | ArrayBufferView): string =>
  Buffer.from(ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b)).toString("hex");

/** Every raw value of the "notes" and "meta" stores, as IndexedDB holds them, bytes as hex. */
function rawDump(idb: IDBFactory): Promise<string> {
  return new Promise((ok, no) => {
    const o = idb.open("ct-wallet");
    o.onerror = () => no(o.error);
    o.onsuccess = () => {
      const db = o.result;
      const tx = db.transaction(["notes", "meta"], "readonly");
      const out: Record<string, unknown> = {};
      let left = 2;
      for (const name of ["notes", "meta"]) {
        const s = tx.objectStore(name);
        const keys = s.getAllKeys();
        const vals = s.getAll();
        vals.onsuccess = () => {
          out[name] = (keys.result as IDBValidKey[]).map((k, i) => [String(k), vals.result[i]]);
          if (--left === 0) {
            db.close();
            ok(JSON.stringify(out, (_k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? `0x${hex(v as ArrayBuffer)}` : typeof v === "bigint" ? `${v}n` : v)));
          }
        };
        vals.onerror = () => no(vals.error);
      }
    };
  });
}

// A store a killed page left: parent P (UNSPENT, 100) whose change note C (30) is written but P is not yet SPENT, and
// a note H HELD by a tab that is dead (its tab lock is held by nobody). Planted with the wallet store's own put.
async function leftByAKilledPage(): Promise<{ idb: IDBFactory; w: WalletStore; P: NoteRecord; C: NoteRecord; H: NoteRecord }> {
  const idb = new IDBFactory();
  const w = await openWalletStore({ indexedDB: idb });
  opened.push(w);
  const pRef: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
  const cRef: NoteRef = { kind: "change", l: L, j: 0 };
  const hRef: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  const P: NoteRecord = { id: "a".repeat(32), ref: pRef, scope: SCOPE, precommitment: pc(pRef), state: "UNSPENT", leaf: leafOf(pc(pRef), 100n, L, 0n) };
  const C: NoteRecord = { id: "b".repeat(32), ref: cRef, scope: SCOPE, precommitment: pc(cRef), state: "UNSPENT", parent: P.id, leaf: leafOf(pc(cRef), 30n, L, 2n) };
  const H: NoteRecord = {
    id: "c".repeat(32),
    ref: hRef,
    scope: SCOPE,
    precommitment: pc(hRef),
    state: "HELD",
    leaf: leafOf(pc(hRef), 5n, 78n, 1n),
    deadlineMs: 1_800_000_000_000n,
    attempt: "e".repeat(32),
    tab: DEAD_TAB,
    contexts: [{ context: "12345", deadlineMs: 1_800_000_000_000n }],
  };
  for (const n of [P, C, H]) await w.put("notes", n.id, n);
  return { idb, w, P, C, H };
}

test("readNotes: the parent of a written child reads SPENT, a dead tab's HELD note reads HELD, and nothing is written", async () => {
  const { idb, w, P, C, H } = await leftByAKilledPage();
  const before = await rawDump(idb);
  let writes = 0;
  const watched: WalletStore = {
    ...w,
    put: async (...a) => (writes++, w.put(...a)),
    delete: async (...a) => (writes++, w.delete(...a)),
  };
  const got = await readNotes(watched);
  const byId = new Map(got.map((n) => [n.id, n]));
  assert.equal(got.length, 3);
  assert.equal(byId.get(P.id)?.state, "SPENT", "a parent whose child is written counts as SPENT");
  assert.equal(byId.get(C.id)?.state, "UNSPENT");
  assert.deepEqual(byId.get(H.id), H, "a dead tab's HELD note is read as it is");
  // the money counted once: the change, the HELD note; never the parent too
  assert.equal(got.filter((n) => n.state === "UNSPENT" || n.state === "HELD").reduce((s, n) => s + n.leaf!.value, 0n), 35n);
  assert.equal(writes, 0, "no put, no delete");
  assert.equal(await rawDump(idb), before, "every raw value of notes and meta is byte-equal after the read");
  // the fixture is real: the note store's own open finishes the parent and frees the dead tab's note, so its bytes change
  const ns = await openNoteStore(w);
  const listed = new Map((await ns.list()).map((n) => [n.id, n.state]));
  ns.close();
  assert.equal(listed.get(P.id), "SPENT");
  assert.equal(listed.get(H.id), "UNSPENT", "the note store frees it");
  assert.notEqual(await rawDump(idb), before, "the note store writes; readNotes did not");
});

test("readNotes takes no Web Lock: it answers while another tab holds the notes lock", async () => {
  const { w } = await leftByAKilledPage();
  let release = (): void => {};
  const held = new Promise<void>((ok) => {
    void navigator.locks.request(NOTES_LOCK, { mode: "exclusive" }, () => (ok(), new Promise<void>((r) => (release = r))));
  });
  await held;
  try {
    const got = await Promise.race([readNotes(w), new Promise<"waited">((ok) => setTimeout(() => ok("waited"), 2_000))]);
    assert.notEqual(got, "waited", "readNotes waited for the notes lock");
    assert.equal((got as NoteRecord[]).length, 3);
  } finally {
    release();
  }
});

test("readNotes checks each record as the note store does: a broken record stops the read", async () => {
  const { w, P } = await leftByAKilledPage();
  const { leaf: _leaf, ...noLeaf } = P;
  await w.put("notes", P.id, noLeaf);
  await assert.rejects(readNotes(w), /a leaf from UNSPENT on/);
  await w.put("notes", P.id, { ...P, secret: 1n });
  await assert.rejects(readNotes(w), /secret/);
});
