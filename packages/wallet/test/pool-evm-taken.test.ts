// node --test packages/wallet/test/pool-evm-taken.test.ts: a deposit or a sell on the EVM pool whose precommitment
// another deposit took first (card precommit-taken-recover, src/pool/evm-restore.ts evmNextNote and evmClaimTaken).
// The pool's events are planted as evmTreeSync gives them: a stranger's Deposited of exactly MIN_DEPOSIT on the
// precommitment of the note a deposit or a sell was about to sign on. Test seed only: the all-zero entropy of
// vectors/a8.json; never money.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { vaultLabelOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, refKey, type NoteStore } from "../src/notes/store.ts";
import { openWalletStore } from "../src/store/index.ts";
import { evmPoolScopeOf, type EvmPoolEvent } from "../src/pool/evm.ts";
import { EvmNotFinalError, SECOND_GAP, evmClaimTaken, evmNextNote, evmRestore } from "../src/pool/evm-restore.ts";
import { jOf } from "../src/pool/queue.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const SCOPE = evmPoolScopeOf("0x00000000000000000000000000000000b1f1f001", 84532n);
/** The pool's smallest deposit, contracts/pool-evm/src/PrivacyPool.sol:53 (0.0001 ether): below EVM_LADDER's smallest rung. */
const MIN_DEPOSIT = 100_000_000_000_000n;
const RUNG = 10n ** 15n;
/** The round's finalized block: every planted event (blocks 10 on) is final unless a test says otherwise. */
const FINAL = 1_000n;
const P = (ref: NoteRef) => noteSecrets(SEED, ref).precommitment;

/** Deposited events in log order, each a leaf of the state tree and a label, as evmTreeSync's events() gives them. */
function pool(deps: readonly { pre: bigint; value: bigint }[]): EvmPoolEvent[] {
  return deps.map((x, k) => {
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k + 1));
    return { block: BigInt(10 + k), blockHash: `0x${"ab".repeat(32)}`, logIndex: 0n, bytes: "", kind: "deposit", state: noteCommitment(x.value, label, x.pre), label, value: x.value, precommitment: x.pre, nullifier: null, recipient: null, token: null };
  });
}

const U0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const U0n = (n: number): NoteRef => ({ kind: "second", id: { id: "U", s: SCOPE, i: 0 }, n });
const L = 77n;
const RET: NoteRef = { kind: "return", c: "evm", l: L, j: 0 };
const Rn = (n: number): NoteRef => ({ kind: "second", id: { id: "R", c: "evm", l: L, j: 0 }, n });

test("a deposit whose precommitment a stranger took with MIN_DEPOSIT: that deposit is the user's note at MIN_DEPOSIT, and the next deposit signs on U's next note", () => {
  const events = pool([{ pre: 11n, value: RUNG }, { pre: P(U0), value: MIN_DEPOSIT }]);
  const got = evmNextNote(SEED, SCOPE, events, U0, FINAL);
  assert.deepEqual(got.taken.map((t) => [refKey(t.ref), t.leaf.value, t.leaf.leafIndex, t.state]), [[refKey(U0), MIN_DEPOSIT, 1n, "UNSPENT"]]);
  assert.equal(got.taken[0]!.leaf.commitment, noteCommitment(MIN_DEPOSIT, vaultLabelOf(keccak_256, SCOPE, 2n), P(U0)));
  assert.deepEqual(got.next, { ref: U0n(0), precommitment: P(U0n(0)) });
  // the restore from the words finds the same note at the same value
  assert.deepEqual(evmRestore({ seed64: SEED, scope: SCOPE, events, gap: 2 }).notes.map((n) => [refKey(n.ref), n.leaf.value]), [[refKey(U0), MIN_DEPOSIT]]);
});

test("a sell whose return note and its first R were each taken: both are the user's notes, and the sell is signed again on R 1", () => {
  const events = pool([{ pre: P(RET), value: MIN_DEPOSIT }, { pre: 12n, value: RUNG }, { pre: P(Rn(0)), value: 3n * MIN_DEPOSIT }]);
  const got = evmNextNote(SEED, SCOPE, events, RET, FINAL);
  assert.deepEqual(got.taken.map((t) => [refKey(t.ref), t.leaf.value]), [[refKey(RET), MIN_DEPOSIT], [refKey(Rn(0)), 3n * MIN_DEPOSIT]]);
  assert.deepEqual(got.next, { ref: Rn(1), precommitment: P(Rn(1)) });
});

test("nothing taken: the note to sign is the first one", () => {
  assert.deepEqual(evmNextNote(SEED, SCOPE, pool([{ pre: 11n, value: RUNG }]), RET, FINAL), { taken: [], pending: [], next: { ref: RET, precommitment: P(RET) } });
});

test("a Deposited whose commitment is not Poseidon(value, label, precommitment), or whose label is not its nonce's, is refused, never restored", () => {
  const forged = pool([{ pre: P(U0), value: MIN_DEPOSIT }]);
  forged[0] = { ...forged[0]!, value: RUNG }; // the event says more than the pool hashed
  assert.throws(() => evmNextNote(SEED, SCOPE, forged, U0, FINAL), /commitment/);
  const relabeled = pool([{ pre: P(U0), value: MIN_DEPOSIT }]);
  relabeled[0] = { ...relabeled[0]!, label: 5n };
  assert.throws(() => evmNextNote(SEED, SCOPE, relabeled, U0, FINAL), /label/);
  assert.throws(() => evmNextNote(SEED, SCOPE, [], { kind: "change", l: L, j: 0 }, FINAL), /deposit, return or move/);
});

const stores: { close(): void }[] = [];
after(() => {
  for (const x of stores.splice(0)) x.close();
});
async function store(): Promise<NoteStore> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(w);
  stores.push(ns, w);
  return ns;
}

test("evmClaimTaken: a PLANNED note (a sell signed on it, reverted) and an INCOMING one go UNSPENT at the taken value; one the store lacks is added; a landed one is kept", async () => {
  const ns = await store();
  const events = pool([{ pre: P(RET), value: MIN_DEPOSIT }, { pre: P(Rn(0)), value: MIN_DEPOSIT }, { pre: P(Rn(1)), value: RUNG }]);
  const planned = await ns.add({ ref: RET, scope: SCOPE, precommitment: P(RET), state: "PLANNED" });
  const { taken, next } = evmNextNote(SEED, SCOPE, events, RET, FINAL);
  const wrote = await evmClaimTaken(ns, taken);
  assert.deepEqual(wrote.map((n) => [refKey(n.ref), n.state, n.leaf?.value]), [[refKey(RET), "UNSPENT", MIN_DEPOSIT], [refKey(Rn(0)), "UNSPENT", MIN_DEPOSIT], [refKey(Rn(1)), "UNSPENT", RUNG]]);
  assert.equal(wrote[0]!.id, planned.id, "the PLANNED note itself is restored");
  assert.deepEqual(next.ref, Rn(2));
  // run again (a reload, or the next sell): nothing written twice
  assert.deepEqual(await evmClaimTaken(ns, evmNextNote(SEED, SCOPE, events, RET, FINAL).taken), []);
  const all = await ns.list();
  assert.equal(all.length, 3);
  assert.ok(all.every((n) => n.state === "UNSPENT"));
});

test("evmClaimTaken: an INCOMING deposit note whose send reverted goes UNSPENT at the stranger's value; a held note of another precommitment is refused", async () => {
  const ns = await store();
  const n = await ns.add({ ref: RET, scope: SCOPE, precommitment: P(RET), state: "PLANNED" });
  await ns.move(n.id, "PLANNED", "INCOMING");
  const events = pool([{ pre: P(RET), value: MIN_DEPOSIT }]);
  const [one] = await evmClaimTaken(ns, evmNextNote(SEED, SCOPE, events, RET, FINAL).taken);
  assert.deepEqual([one!.id, one!.state, one!.leaf?.value], [n.id, "UNSPENT", MIN_DEPOSIT]);
  const other = await store();
  await other.add({ ref: RET, scope: SCOPE, precommitment: P(Rn(5)), state: "PLANNED" });
  await assert.rejects(evmClaimTaken(other, evmNextNote(SEED, SCOPE, events, RET, FINAL).taken), /another note/);
});

test("a stranger's Deposited above the finalized block is pending: passed over for the next note, never written, and taken once its block is final", async () => {
  const events = pool([{ pre: P(RET), value: MIN_DEPOSIT }, { pre: P(Rn(0)), value: MIN_DEPOSIT }]); // blocks 10 and 11
  const got = evmNextNote(SEED, SCOPE, events, RET, 10n);
  assert.deepEqual(got.taken.map((t) => refKey(t.ref)), [refKey(RET)]);
  assert.deepEqual(got.pending.map(refKey), [refKey(Rn(0))]);
  assert.deepEqual(got.next.ref, Rn(1), "the tail's precommitment is never signed on");
  const ns = await store();
  const planned = await ns.add({ ref: RET, scope: SCOPE, precommitment: P(RET), state: "PLANNED" });
  await ns.add({ ref: Rn(0), scope: SCOPE, precommitment: P(Rn(0)), state: "PLANNED" }).catch(() => undefined);
  await evmClaimTaken(ns, got.taken);
  const byRef = new Map((await ns.list()).map((n) => [refKey(n.ref), n]));
  assert.equal(byRef.get(refKey(RET))!.id, planned.id);
  assert.equal(byRef.get(refKey(RET))!.state, "UNSPENT");
  assert.notEqual(byRef.get(refKey(Rn(0)))?.state, "UNSPENT", "the tail's note is not stored as money");
  // the next round, block 11 final: taken
  assert.deepEqual(evmNextNote(SEED, SCOPE, events, RET, 11n).taken.map((t) => refKey(t.ref)), [refKey(RET), refKey(Rn(0))]);
  assert.throws(() => evmNextNote(SEED, SCOPE, events, RET, -1n), /finalBlock/);
});

/** Deposited events at the given blocks, in log order. */
const poolAt = (deps: readonly { pre: bigint; value: bigint; block: bigint }[]): EvmPoolEvent[] => pool(deps).map((e, k) => ({ ...e, block: deps[k]!.block }));
const restored = (events: EvmPoolEvent[]) => evmRestore({ seed64: SEED, scope: SCOPE, events, gap: 2 }).notes.map((n) => refKey(n.ref));

test("a pending take passed over, then reorged out: a restore from the words still finds the deposit signed on the next note", () => {
  const before = poolAt([{ pre: P(U0), value: RUNG, block: 10n }, { pre: P(U0n(0)), value: MIN_DEPOSIT, block: 20n }]);
  const got = evmNextNote(SEED, SCOPE, before, U0, 15n);
  assert.deepEqual(got.pending.map(refKey), [refKey(U0n(0))]);
  assert.deepEqual(got.next.ref, U0n(1), "signed past the pending take");
  // the stranger's block is dropped; the user's rung on U 1 lands
  const after = poolAt([{ pre: P(U0), value: RUNG, block: 10n }, { pre: P(U0n(1)), value: RUNG, block: 30n }]);
  assert.deepEqual(restored(after), [refKey(U0), refKey(U0n(1))]);
});

test(`the restore's second-arrival walk reads past SECOND_GAP - 1 (${SECOND_GAP - 1}) empty notes and no more; evmNextNote never names a note past SECOND_GAP pending takes in a row`, () => {
  const at = (n: number) => poolAt([{ pre: P(U0), value: RUNG, block: 10n }, { pre: P(U0n(n)), value: RUNG, block: 30n }]);
  assert.deepEqual(restored(at(SECOND_GAP - 1)), [refKey(U0), refKey(U0n(SECOND_GAP - 1))]);
  assert.deepEqual(restored(at(SECOND_GAP)), [refKey(U0)], "a note past the gap is not read");
  const takes = (k: number) => poolAt([{ pre: P(U0), value: RUNG, block: 10n }, ...Array.from({ length: k }, (_, n) => ({ pre: P(U0n(n)), value: MIN_DEPOSIT, block: 20n }))]);
  assert.deepEqual(evmNextNote(SEED, SCOPE, takes(SECOND_GAP - 1), U0, 15n).next.ref, U0n(SECOND_GAP - 1));
  assert.throws(() => evmNextNote(SEED, SCOPE, takes(SECOND_GAP), U0, 15n), /pending takes in a row/);
  // once those blocks are final the same chain is taken whole, and the next note named
  assert.deepEqual(evmNextNote(SEED, SCOPE, takes(SECOND_GAP), U0, 20n).next.ref, U0n(SECOND_GAP));
});

test("a deposit note taken in a block not final yet is never passed over: its chain is found by that note alone", () => {
  const events = poolAt([{ pre: P(U0), value: MIN_DEPOSIT, block: 20n }]);
  assert.throws(() => evmNextNote(SEED, SCOPE, events, U0, 15n), /not final yet/);
  assert.deepEqual(evmNextNote(SEED, SCOPE, events, U0, 20n).next.ref, U0n(0));
  // a return note's chain is walked whatever its first note holds, so a pending take on it is passed over as any other
  const sold = poolAt([{ pre: P(RET), value: MIN_DEPOSIT, block: 20n }]);
  assert.deepEqual(evmNextNote(SEED, SCOPE, sold, RET, 15n).next.ref, Rn(0));
});

test("evmClaimTaken: a landed note held at another leaf than the taken one is refused, never kept quietly", async () => {
  const ns = await store();
  const label = vaultLabelOf(keccak_256, SCOPE, 9n);
  await ns.add({ ref: RET, scope: SCOPE, precommitment: P(RET), state: "UNSPENT", leaf: { value: RUNG, label, commitment: noteCommitment(RUNG, label, P(RET)), leafIndex: 9n } });
  const events = pool([{ pre: P(RET), value: MIN_DEPOSIT }]);
  await assert.rejects(evmClaimTaken(ns, evmNextNote(SEED, SCOPE, events, RET, FINAL).taken), /another leaf/);
});

test("both wait-for-finality refusals of evmNextNote are an EvmNotFinalError (a not now); a forged commitment or label, or a note no deposit or sell signs on, is a plain Error", () => {
  const notFinal = (f: () => unknown): boolean => {
    try {
      f();
    } catch (e) {
      return e instanceof EvmNotFinalError && e.name === "EvmNotFinalError";
    }
    assert.fail("no refusal");
  };
  // the deposit note taken in a block not final yet
  assert.ok(notFinal(() => evmNextNote(SEED, SCOPE, poolAt([{ pre: P(U0), value: MIN_DEPOSIT, block: 20n }]), U0, 15n)));
  // SECOND_GAP pending takes in a row
  const takes = poolAt([{ pre: P(U0), value: RUNG, block: 10n }, ...Array.from({ length: SECOND_GAP }, (_, n) => ({ pre: P(U0n(n)), value: MIN_DEPOSIT, block: 20n }))]);
  assert.ok(notFinal(() => evmNextNote(SEED, SCOPE, takes, U0, 15n)));
  const forged = pool([{ pre: P(U0), value: MIN_DEPOSIT }]);
  forged[0] = { ...forged[0]!, value: RUNG };
  const relabeled = pool([{ pre: P(U0), value: MIN_DEPOSIT }]);
  relabeled[0] = { ...relabeled[0]!, label: 5n };
  for (const f of [() => evmNextNote(SEED, SCOPE, forged, U0, FINAL), () => evmNextNote(SEED, SCOPE, relabeled, U0, FINAL), () => evmNextNote(SEED, SCOPE, [], { kind: "change", l: L, j: 0 }, FINAL), () => evmNextNote(SEED, SCOPE, [], RET, -1n)])
    assert.equal(notFinal(f), false);
});

test("the restore reads past empty notes on U, V and R only (the chains evmNextNote signs on); the A walk stops at its first miss, as the Solana walk does", () => {
  // U 0's deposit, spent whole to its W; then a note of the seed's at n = 1 of A, V and R under (l, j), each n = 0 empty
  const l = vaultLabelOf(keccak_256, SCOPE, 1n);
  const j = jOf(U0);
  const second = (id: "A" | "V" | "R", n: number): NoteRef => ({ kind: "second", id: id === "R" ? { id, c: "evm", l, j } : { id, l, j }, n });
  const dep = (k: number, pre: bigint, block: bigint): EvmPoolEvent => {
    const label = vaultLabelOf(keccak_256, SCOPE, BigInt(k));
    return { block, blockHash: `0x${"ab".repeat(32)}`, logIndex: 0n, bytes: "", kind: "deposit", state: noteCommitment(RUNG, label, pre), label, value: RUNG, precommitment: pre, nullifier: null, recipient: null, token: null };
  };
  const release: EvmPoolEvent = { block: 11n, blockHash: `0x${"ab".repeat(32)}`, logIndex: 0n, bytes: "", kind: "withdraw", state: noteCommitment(0n, l, P({ kind: "change", l, j })), label: null, value: RUNG, precommitment: null, nullifier: noteSecrets(SEED, U0).nullifierHash, recipient: d.freshWallet(SEED, "evm", l, j).address.toLowerCase(), token: null };
  const events = [dep(1, P(U0), 10n), release, dep(2, P(second("A", 1)), 12n), dep(3, P(second("V", 1)), 13n), dep(4, P(second("R", 1)), 14n)];
  const got = restored(events);
  assert.ok(got.includes(refKey(second("V", 1))), "V reads past an empty note");
  assert.ok(got.includes(refKey(second("R", 1))), "R reads past an empty note");
  assert.equal(got.includes(refKey(second("A", 1))), false, "A n = 1 behind an empty A n = 0 is not read");
  // an A note right after the last one found is still found
  const a0 = [dep(1, P(U0), 10n), release, dep(2, P(second("A", 0)), 12n)];
  assert.ok(restored(a0).includes(refKey(second("A", 0))));
});
