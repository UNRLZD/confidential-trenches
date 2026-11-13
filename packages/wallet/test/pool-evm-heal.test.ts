// The EVM pool's heal of a reorg (card evm-money-shows-and-spends-at-once; src/pool/evm-settle.ts, src/notes/store.ts
// backOut, finalized, landings): a note backs out only when the round reached its block and lacks its leaf, a fact
// stays out of the heal only once a round with its block final held it, a note backed out lands again from the chain
// alone, and a release elsewhere in the tail holds the note until it is final. Synthetic rounds, as settleOn builds
// them in pool-evm-settle.test.ts (the independent review's probes A-F, then one test per kind and the store's guards).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, refKey, type Leaf, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore, type WalletStore } from "../src/store/index.ts";
import { evmPoolScopeOf, type EvmPoolEvent } from "../src/pool/evm.ts";
import { evmClaimTaken, evmRestore, evmTakenNotes } from "../src/pool/evm-restore.ts";
import { evmSettleOpen, evmSettleReserved } from "../src/pool/evm-settle.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const w64 = (x: bigint): string => x.toString(16).padStart(64, "0");
const SCOPE = evmPoolScopeOf("0x00000000000000000000000000000000b1f1f001", 84532n);
const T0 = 1_800_000_000n;
const timeOf = (n: number | bigint): bigint => T0 + 2n * BigInt(n);
const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const P = (ref: NoteRef) => noteSecrets(SEED, ref).precommitment;
const VALUE = 10n ** 16n;
const WITHDRAWN = 4n * 10n ** 15n;
const L0 = vaultLabelOf(keccak_256, SCOPE, 2n);
const C0: NoteRef = { kind: "change", l: L0, j: 0 };
const DEADLINE_MS = timeOf(20) * 1000n;

const closers: (() => void)[] = [];
after(() => closers.splice(0).forEach((f) => f()));
async function fresh(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close(), () => w.close());
  return { w, ns };
}
const row = (block: number) => ({ block: BigInt(block), blockHash: `0x${w64(BigInt(block))}`, logIndex: 0n, bytes: "0x" });
const dep = (block: number, state: bigint, label = L0, pre = 1n) => ({ ...row(block), kind: "deposit" as const, state, label, value: VALUE, precommitment: pre, nullifier: null, recipient: null, token: null });
const rel = (block: number, ref: NoteRef, state: bigint) => ({ ...row(block), kind: "buy" as const, state, label: null, value: WITHDRAWN, precommitment: null, nullifier: noteSecrets(SEED, ref).nullifierHash, recipient: "0x00000000000000000000000000000000000000aa", token: "0x00000000000000000000000000000000000000bb" });
/** One pass on a round of `fin`, `anchor` and `events`; `reads` counts the rounds read. */
const settle = (ns: NoteStore, fin: number, anchor: number, events: unknown[], reads = { n: 0 }) =>
  evmSettleReserved({ seed64: SEED, notes: ns, scope: SCOPE, round: async () => (reads.n++, { fin: { number: BigInt(fin), timestamp: timeOf(fin) }, anchor: { number: BigInt(anchor), timestamp: timeOf(anchor) }, events: events as never }) });
const commit0 = noteCommitment(VALUE, L0, P(D0));
const change0 = noteCommitment(VALUE - WITHDRAWN, L0, P(C0));
const balance = async (ns: NoteStore) => (await ns.list()).filter((n) => ["UNSPENT", "HELD", "RESERVED"].includes(n.state)).reduce((t, n) => t + n.leaf!.value, 0n);
const open = async (ns: NoteStore) => evmSettleOpen(await ns.list(), await ns.landings(), SCOPE);

/** A pool whose deposits carry their real labels (the nonce of their place), as the claim checks them. */
function pool() {
  const ev: EvmPoolEvent[] = [];
  let nonce = 0n;
  return {
    ev,
    dep(block: number, pre: bigint, value = VALUE): Leaf {
      const label = vaultLabelOf(keccak_256, SCOPE, ++nonce);
      const state = noteCommitment(value, label, pre);
      ev.push({ ...row(block), kind: "deposit", state, label, value, precommitment: pre, nullifier: null, recipient: null, token: null } as never);
      return { value, label, commitment: state, leafIndex: BigInt(ev.length - 1) };
    },
    rel(block: number, ref: NoteRef, state: bigint): bigint {
      ev.push(rel(block, ref, state) as never);
      return BigInt(ev.length - 1);
    },
  };
}

test("heal A: a round whose newest agreed block is below a note's landing block says nothing about it, so the heal never backs it out", async () => {
  for (const reserve of [false, true]) {
    const { ns } = await fresh();
    // deposit 0 at leaf 1, landed in block 10 while the finalized block was 5 (a stranger's deposit is leaf 0, block 5)
    const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n }, landed: { block: 10n, fin: 5n } });
    if (reserve) {
      const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
      await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt!, nullifier: 7n });
    }
    // the next round: one RPC's head lags at block 9, so the anchor (the lower head) is 9 and the round holds only leaf 0
    const pass = await settle(ns, 5, 9, [dep(5, 11n)]);
    assert.deepEqual(pass.backedOut, [], `${reserve ? "RESERVED" : "UNSPENT"}: a round that never reached block 10 backs nothing out`);
    assert.equal((await ns.get(n.id))!.state, reserve ? "RESERVED" : "UNSPENT");
  }
});

test("heal B: a page killed between the change note's delete and the drop of its landing heals at the next pass, never a phantom change", async () => {
  const { w, ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n } });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  // the release at block 20 (leaf 2), above the finalized block 15: SPENT and its change at once, the change kept at 20
  assert.deepEqual((await settle(ns, 15, 20, [dep(5, 11n), dep(10, commit0), rel(20, D0, change0)])).spent, [n.id]);
  const c = (await ns.list()).find((x) => refKey(x.ref) === refKey(C0))!;
  assert.equal((await ns.landings()).get(c.id), 20n);
  // a reorg drops block 20 (head 21, no release). The page dies at the child's delete (modelled: the wallet store's
  // delete of the change note fails once)
  const del = w.delete.bind(w);
  let killed = false;
  (w as { delete: WalletStore["delete"] }).delete = async (s, k) => {
    if (!killed && s === "notes" && k === c.id) {
      killed = true;
      throw new Error("page killed");
    }
    return del(s, k);
  };
  const dropped = [dep(5, 11n), dep(10, commit0)];
  await settle(ns, 15, 21, dropped);
  assert.ok(killed, "the kill landed between the two writes");
  // the reload: a new note store on the same records (settle() finishes the parent back to SPENT, its child stored)
  ns.close();
  const ns2 = await openNoteStore(w);
  closers.push(() => ns2.close());
  const again = await settle(ns2, 15, 21, dropped);
  assert.deepEqual(again.backedOut, [c.id], "the next pass undoes it again");
  assert.equal(await balance(ns2), VALUE, "the chain holds the whole note, unspent");
});

const L1 = vaultLabelOf(keccak_256, SCOPE, 1n), L2 = L0, L3 = vaultLabelOf(keccak_256, SCOPE, 3n);
const c3 = noteCommitment(VALUE, L3, P(D0));
// the canonical chain after the reorg: block 10 held no deposit of ours; a stranger's at 12 is leaf 1, ours came again
// at 36 (leaf 2, a new label: the pool's next nonce)
const canon = [dep(5, 11n, L1, 101n), dep(12, 12n, L2, 102n), dep(36, c3, L3, P(D0))];

test("heal C: a reorg that dropped a tail deposit, first seen by a pass whose finalized block is already past the note's block, backs it out and lands it at its new leaf", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n }, landed: { block: 10n, fin: 5n } });
  const pass = await settle(ns, 20, 41, canon);
  assert.deepEqual(pass.backedOut, [n.id], "its leaf is not on the chain: backed out");
  const now = (await ns.get(n.id))!;
  assert.equal(now.state, "UNSPENT", "and taken again at once from the same round");
  assert.equal(now.leaf!.leafIndex, 2n);
  assert.equal(now.leaf!.commitment, c3);
});

test("heal C2: the note a reorg moved is claimed at its new leaf, never refused as held at another", async () => {
  const { ns } = await fresh();
  await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n }, landed: { block: 10n, fin: 5n } });
  await settle(ns, 20, 41, canon);
  const taken = evmTakenNotes(SEED, SCOPE, canon as never, D0, 20n).taken;
  await evmClaimTaken(ns, taken); // threw at 67eba3a4c: "the store holds this note at another leaf"
  assert.equal(await balance(ns), VALUE);
});

test("heal D: a release elsewhere in the tail holds the note until it is final; a reorg that drops it gives the note back", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n } });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  const elsewhere = [dep(5, 11n), dep(10, commit0), rel(20, D0, 77n)];
  assert.deepEqual((await settle(ns, 15, 20, elsewhere)).held, [n.id], "a release not ours above the finalized block: held");
  assert.equal((await ns.get(n.id))!.state, "RESERVED");
  // the reorg drops block 20; the head moves past the deadline with no release: freed
  await settle(ns, 15, 30, [dep(5, 11n), dep(10, commit0)]);
  assert.notEqual((await ns.get(n.id))!.state, "SPENT", "the release is gone: the note is the user's again");
  assert.equal((await ns.get(n.id))!.state, "UNSPENT");
  // the same release final (block 20 at or under the finalized block): SPENT, with no change note of ours
  const { ns: ns2 } = await fresh();
  const m = await ns2.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n } });
  const h2 = await ns2.move(m.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns2.move(m.id, "HELD", "RESERVED", { attempt: h2.attempt! });
  assert.deepEqual((await settle(ns2, 15, 20, elsewhere)).held, [m.id]);
  assert.deepEqual((await settle(ns2, 20, 25, elsewhere)).spent, [m.id]);
  assert.equal((await ns2.list()).length, 1);
});

test("heal D (restore): a release elsewhere above the round's finalized block restores the note UNSPENT with that block kept, SPENT once final", async () => {
  const p = pool();
  p.dep(5, 11n);
  const leaf = p.dep(10, P(D0));
  const nul = noteSecrets(SEED, D0).nullifierHash;
  p.ev.push({ ...rel(20, D0, 77n), nullifier: nul } as never);
  const tail = evmRestore({ seed64: SEED, scope: SCOPE, events: p.ev, fin: 15n, gap: 2 });
  const n = tail.notes.find((x) => refKey(x.ref) === refKey(D0))!;
  assert.equal(n.state, "UNSPENT");
  assert.deepEqual(n.landed, { block: 20n, fin: 15n }, "the release's block kept, so the settle reads it until it is final");
  assert.equal(tail.elsewhere.length, 1);
  assert.deepEqual(n.leaf, leaf);
  const final = evmRestore({ seed64: SEED, scope: SCOPE, events: p.ev, fin: 20n, gap: 2 });
  assert.equal(final.notes.find((x) => refKey(x.ref) === refKey(D0))!.state, "SPENT");
  // written, then settled: the settle reads it while the release is above the finalized block, then SPENT
  const { ns } = await fresh();
  const { writeRestored } = await import("../src/notes/restore.ts");
  await writeRestored(ns, { notes: tail.notes as never });
  const id = (await ns.list())[0]!.id;
  assert.equal(await open(ns), true);
  assert.deepEqual((await settle(ns, 15, 25, p.ev)).held, [id]);
  assert.deepEqual((await settle(ns, 20, 25, p.ev)).spent, [id]);
  assert.equal(await open(ns), false, "final: nothing more to read");
});

test("heal E: a chain unwinds in one pass: deposit and its release both dropped, the change goes, then the deposit goes back to INCOMING", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n }, landed: { block: 10n, fin: 5n } });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  await settle(ns, 5, 20, [dep(5, 11n), dep(10, commit0), rel(20, D0, change0)]);
  assert.equal((await ns.get(n.id))!.state, "SPENT");
  const pass = await settle(ns, 5, 21, [dep(5, 11n)]);
  assert.equal(pass.backedOut.length, 2);
  assert.equal((await ns.get(n.id))!.state, "INCOMING");
  assert.equal((await ns.list()).length, 1);
});

test("heal F: a release of a note this store never held (another device's), in the tail, then dropped: the note RESERVED until anchor + EVM_LIFE_MS, then freed", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n } });
  // the UNSPENT note's release shows at the head: settled spent (a tail note of ours is the pass's trigger)
  const D1: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  await ns.add({ ref: D1, scope: SCOPE, precommitment: P(D1), state: "UNSPENT", leaf: { value: VALUE, label: L1, commitment: noteCommitment(VALUE, L1, P(D1)), leafIndex: 0n }, landed: { block: 5n, fin: 4n } });
  const evs = [dep(5, noteCommitment(VALUE, L1, P(D1)), L1), dep(10, commit0), rel(20, D0, change0)];
  assert.deepEqual((await settle(ns, 4, 20, evs)).spent, [n.id]);
  const back = await settle(ns, 4, 21, evs.slice(0, 2));
  assert.equal(back.backedOut.length, 1);
  const r = (await ns.get(n.id))!;
  assert.equal(r.state, "RESERVED");
  assert.ok(r.deadlineMs! > timeOf(21) * 1000n);
});

// fix 2: a note backed out lands again from the chain alone, whatever its kind, and the pass stops reading once final
const RET: NoteRef = { kind: "return", c: "evm", l: L0, j: 0 };
const R0: NoteRef = { kind: "second", id: { id: "R", c: "evm", l: L0, j: 0 }, n: 0 };
const U0: NoteRef = { kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n: 0 };
for (const [kind, ref, before] of [["deposit", D0, null], ["return", RET, null], ["R second arrival", R0, RET], ["U second arrival", U0, D0]] as const) {
  test(`heal re-land (${kind}): backed out by a reorg, then held by the round again at a new leaf, the next pass lands it UNSPENT there; the balance right throughout, no read once final`, async () => {
    const { ns } = await fresh();
    // the note before it on its chain, landed and final
    const first = pool();
    first.dep(5, 11n);
    let base = 0n;
    if (before !== null) {
      const bl = first.dep(6, P(before));
      if (before.kind === "deposit") await ns.add({ ref: before, scope: SCOPE, precommitment: P(before), state: "UNSPENT", leaf: bl });
      else {
        const b = await ns.add({ ref: before, scope: SCOPE, precommitment: P(before), state: "PLANNED" });
        await ns.move(b.id, "PLANNED", "INCOMING");
        await ns.move(b.id, "INCOMING", "UNSPENT", { leaf: bl });
      }
      base = VALUE;
    }
    // the note lands in block 10 above the finalized block 5
    const leaf = first.dep(10, P(ref));
    let n;
    if (ref.kind === "deposit") n = await ns.add({ ref, scope: SCOPE, precommitment: P(ref), state: "UNSPENT", leaf, landed: { block: 10n, fin: 5n } });
    else {
      n = await ns.add({ ref, scope: SCOPE, precommitment: P(ref), state: "PLANNED" });
      await ns.move(n.id, "PLANNED", "INCOMING");
      n = await ns.move(n.id, "INCOMING", "UNSPENT", { leaf, landed: { block: 10n, fin: 5n } });
    }
    assert.equal(await balance(ns), base + VALUE);
    // the reorg drops block 10: backed out, out of the balance, and the pass keeps reading for it
    const gone = pool();
    gone.dep(5, 11n);
    if (before !== null) gone.dep(6, P(before));
    assert.deepEqual((await settle(ns, 5, 21, gone.ev)).backedOut, [n.id]);
    assert.equal((await ns.get(n.id))!.state, "INCOMING");
    assert.equal(await balance(ns), base);
    assert.equal(await open(ns), true, "a backed-out note keeps the pass reading");
    assert.equal(await open(ns), true);
    // a round still without it, its old block not final: still INCOMING, still read
    assert.deepEqual((await settle(ns, 5, 22, gone.ev)).backedOut, []);
    assert.equal(await open(ns), true);
    // the sequencer includes it again at block 36, after a stranger's at 12: the next pass lands it at that leaf
    const again = pool();
    again.dep(5, 11n);
    if (before !== null) again.dep(6, P(before));
    again.dep(12, 12n);
    const leaf2 = again.dep(36, P(ref));
    await settle(ns, 5, 40, again.ev);
    const now = (await ns.get(n.id))!;
    assert.equal(now.state, "UNSPENT");
    assert.deepEqual(now.leaf, leaf2);
    assert.equal((await ns.landings()).get(n.id), 36n);
    assert.equal(await balance(ns), base + VALUE);
    // final: its block dropped, and no round is read again
    await settle(ns, 40, 41, again.ev);
    assert.equal(await open(ns), false);
    const reads = { n: 0 };
    await settle(ns, 41, 42, again.ev, reads);
    assert.equal(reads.n, 0, "no round read once every note is final");
  });
}

test("heal re-land (change): a release dropped then landed again at a new leaf writes the change there; the balance right throughout", async () => {
  const { ns } = await fresh();
  const p = pool();
  p.dep(5, 11n);
  const leaf = p.dep(8, P(D0));
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: timeOf(100) * 1000n, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  const change = noteCommitment(VALUE - WITHDRAWN, leaf.label, P({ kind: "change", l: leaf.label, j: 0 }));
  const tail = pool();
  tail.dep(5, 11n);
  tail.dep(8, P(D0));
  tail.rel(20, D0, change);
  assert.deepEqual((await settle(ns, 15, 20, tail.ev)).spent, [n.id]);
  assert.equal(await balance(ns), VALUE - WITHDRAWN);
  const gone = pool();
  gone.dep(5, 11n);
  gone.dep(8, P(D0));
  const back = await settle(ns, 15, 21, gone.ev);
  assert.equal(back.backedOut.length, 1);
  assert.equal((await ns.get(n.id))!.state, "RESERVED");
  assert.equal(await balance(ns), VALUE);
  // landed again at block 23, after a stranger's deposit at 22: the change at leaf 3
  const again = pool();
  again.dep(5, 11n);
  again.dep(8, P(D0));
  again.dep(22, 12n);
  const at = again.rel(23, D0, change);
  assert.deepEqual((await settle(ns, 15, 25, again.ev)).spent, [n.id]);
  const c = (await ns.list()).find((x) => x.parent === n.id)!;
  assert.equal(c.leaf!.leafIndex, at);
  assert.equal(await balance(ns), VALUE - WITHDRAWN);
  await settle(ns, 25, 26, again.ev);
  assert.equal(await open(ns), false);
});

test("heal: a back out that fails keeps the note's block past a finalized round, so the next pass backs it out", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n }, landed: { block: 10n, fin: 5n } });
  let fail = true;
  const flaky: NoteStore = { ...ns, backOut: (id, fin, dl) => (fail ? ((fail = false), Promise.reject(new Error("write failed"))) : ns.backOut(id, fin, dl)) };
  const evs = [dep(5, 11n, L1, 101n)];
  const p1 = await evmSettleReserved({ seed64: SEED, notes: flaky, scope: SCOPE, round: async () => ({ fin: { number: 20n, timestamp: timeOf(20) }, anchor: { number: 30n, timestamp: timeOf(30) }, events: evs as never }) });
  assert.deepEqual(p1.held, [n.id]);
  assert.equal((await ns.landings()).get(n.id), 10n, "a round that does not hold it never finalizes its block");
  assert.deepEqual((await settle(ns, 20, 30, evs)).backedOut, [n.id]);
});

test("heal: a back out that fails under a chain keeps its parent's block too (only a leaf the round holds is final), so the next pass unwinds both", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n }, landed: { block: 10n, fin: 5n } });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  await settle(ns, 5, 20, [dep(5, 11n), dep(10, commit0), rel(20, D0, change0)]);
  const c = (await ns.list()).find((x) => x.parent === n.id)!;
  // the reorg dropped both, first seen by a pass whose finalized block (25) is past both; the child's back out fails
  let fail = true;
  const flaky: NoteStore = { ...ns, backOut: (id, fin, dl) => (fail && id === c.id ? ((fail = false), Promise.reject(new Error("write failed"))) : ns.backOut(id, fin, dl)) };
  const evs = [dep(5, 11n)];
  await evmSettleReserved({ seed64: SEED, notes: flaky, scope: SCOPE, round: async () => ({ fin: { number: 25n, timestamp: timeOf(25) }, anchor: { number: 30n, timestamp: timeOf(30) }, events: evs as never }) });
  assert.equal((await ns.landings()).get(n.id), 10n, "the parent's leaf is not in the round: its block stays");
  await settle(ns, 25, 30, evs);
  assert.equal((await ns.get(n.id))!.state, "INCOMING");
  assert.equal((await ns.list()).length, 1);
});

test("heal: a backed-out note no Deposited names once its old block is final is dropped from the reads; it stays INCOMING for its own follow", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: VALUE, label: L0, commitment: commit0, leafIndex: 1n }, landed: { block: 10n, fin: 5n } });
  const evs = [dep(5, 11n, L1, 101n)];
  await settle(ns, 5, 21, evs);
  assert.equal((await ns.landings()).get(n.id), 10n, "backed out at block 10");
  await settle(ns, 10, 21, evs);
  assert.equal(await open(ns), false);
  assert.equal((await ns.get(n.id))!.state, "INCOMING");
});

// fix 6: the store's guards
const leafAt = (ref: NoteRef, i: bigint, label = vaultLabelOf(keccak_256, SCOPE, i + 1n)): Leaf => ({ value: VALUE, label, commitment: noteCommitment(VALUE, label, P(ref)), leafIndex: i });

test("store: backOut refuses a note with no kept block, a parent, and a note not unspent, held or reserved; a change with no parent in the store just goes", async () => {
  const { ns } = await fresh();
  const final = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: leafAt(D0, 0n) });
  await assert.rejects(ns.backOut(final.id, 0n), /it never backs out/);
  await assert.rejects(ns.backOut("nope", 0n), /no note nope/);
  // a parent (SPENT with its change stored)
  const D1: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  const l1 = leafAt(D1, 1n);
  const p = await ns.add({ ref: D1, scope: SCOPE, precommitment: P(D1), state: "UNSPENT", leaf: l1, landed: { block: 10n, fin: 5n } });
  const cref: NoteRef = { kind: "change", l: l1.label, j: 0 };
  await ns.add({ ref: cref, scope: SCOPE, precommitment: P(cref), state: "UNSPENT", parent: p.id, leaf: { ...leafAt(cref, 2n, l1.label), value: VALUE } });
  await assert.rejects(ns.backOut(p.id, 5n), /is a parent: its child backs out first/);
  // a SPENT note with no child (another device's release) and a kept block: refused by its state
  const D2: NoteRef = { kind: "deposit", s: SCOPE, i: 2 };
  const s = await ns.add({ ref: D2, scope: SCOPE, precommitment: P(D2), state: "UNSPENT", leaf: leafAt(D2, 3n), landed: { block: 12n, fin: 5n } });
  await ns.move(s.id, "UNSPENT", "SPENT");
  await assert.rejects(ns.backOut(s.id, 5n), /is SPENT: only an unspent, held or reserved note backs out/);
  // a change note restored with no parent in the store: its release dropped, it goes, nothing else written
  const lx = vaultLabelOf(keccak_256, SCOPE, 9n);
  const orphan: NoteRef = { kind: "change", l: lx, j: 3 };
  const o = await ns.add({ ref: orphan, scope: SCOPE, precommitment: P(orphan), state: "UNSPENT", leaf: leafAt(orphan, 4n, lx), landed: { block: 14n, fin: 5n } });
  const count = (await ns.list()).length;
  await ns.backOut(o.id, 5n);
  assert.equal(await ns.get(o.id), undefined);
  assert.equal((await ns.list()).length, count - 1);
  assert.equal((await ns.landings()).get(o.id), undefined);
});

test("store: a landing is written only with INCOMING -> UNSPENT or an UNSPENT add, in its own shape", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: leafAt(D0, 0n) });
  await assert.rejects(ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: DEADLINE_MS, context: "5", landed: { block: 10n, fin: 5n } }), /a landing is written with the move INCOMING -> UNSPENT only/);
  await assert.rejects(ns.add({ ref: RET, scope: SCOPE, precommitment: P(RET), state: "PLANNED", landed: { block: 10n, fin: 5n } }), /a landing is written with an UNSPENT note only/);
  const D1: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  const base = { ref: D1, scope: SCOPE, precommitment: P(D1), state: "UNSPENT" as const, leaf: leafAt(D1, 1n) };
  await assert.rejects(ns.add({ ...base, landed: null as never }), /landed is \{ block, fin \}/);
  await assert.rejects(ns.add({ ...base, landed: { block: 10n, fin: 5n, extra: 1 } as never }), /a landing/);
  await assert.rejects(ns.add({ ...base, landed: { block: -1n, fin: 5n } }), /landed.block is a block number/);
  await assert.rejects(ns.add({ ...base, landed: { block: 10n, fin: "5" } as never }), /fin is a block number/);
  assert.equal((await ns.list()).length, 1, "nothing written by a refused landing");
});

test("store: a note landed again at or below the finalized block clears the block kept for it", async () => {
  const { ns } = await fresh();
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: leafAt(D0, 1n), landed: { block: 10n, fin: 5n } });
  await ns.backOut(n.id, 5n);
  assert.equal((await ns.landings()).get(n.id), 10n, "backed out: its block kept as the mark");
  await ns.move(n.id, "INCOMING", "UNSPENT", { leaf: leafAt(D0, 2n) });
  assert.equal((await ns.landings()).get(n.id), undefined);
});

test("store: finalized() drops only the blocks of its scope's notes the round held, at or below its finalized block", async () => {
  const { ns } = await fresh();
  const S2 = SCOPE + 1n;
  const A: NoteRef = { kind: "deposit", s: SCOPE, i: 0 }, B: NoteRef = { kind: "deposit", s: S2, i: 0 }, C: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  const a = await ns.add({ ref: A, scope: SCOPE, precommitment: P(A), state: "UNSPENT", leaf: leafAt(A, 0n), landed: { block: 10n, fin: 5n } });
  const b = await ns.add({ ref: B, scope: S2, precommitment: P(B), state: "UNSPENT", leaf: leafAt(B, 0n), landed: { block: 10n, fin: 5n } });
  const c = await ns.add({ ref: C, scope: SCOPE, precommitment: P(C), state: "UNSPENT", leaf: leafAt(C, 1n), landed: { block: 30n, fin: 5n } });
  await ns.finalized(SCOPE, 20n, [a.id, b.id, c.id]);
  const l = await ns.landings();
  assert.equal(l.get(a.id), undefined, "its scope, at or below 20, held");
  assert.equal(l.get(b.id), 10n, "another scope's: kept");
  assert.equal(l.get(c.id), 30n, "above 20: kept");
  await ns.finalized(S2, 20n, []);
  assert.equal((await ns.landings()).get(b.id), 10n, "a round that did not hold it: kept");
  await ns.finalized(S2, 20n, [b.id]);
  assert.equal((await ns.landings()).get(b.id), undefined);
});
