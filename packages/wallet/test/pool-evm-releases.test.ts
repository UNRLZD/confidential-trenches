// node --test packages/wallet/test/pool-evm-releases.test.ts: the releases the device sent to W at a sell (card
// evm-sell-no-release-in-flight, audit E-01; src/pool/evm-releases.ts), the kit sell quote's `sent`. The store's notes
// are planted as its list() gives them. Test seed only: the all-zero entropy of vectors/a8.json; never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as d from "../src/derive/index.ts";
import { noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { refKey, type NoteRecord, type NoteState } from "../src/notes/store.ts";
import { evmPoolScopeOf, type EvmPoolEvent } from "../src/pool/evm.ts";
import { evmSellSent } from "../src/pool/evm-releases.ts";
import { jOf } from "../src/pool/queue.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const SCOPE = evmPoolScopeOf("0x00000000000000000000000000000000b1f1f001", 84532n);
const L = 77n;
const NOTE: NoteRef = { kind: "change", l: L, j: 2 };
const J = jOf(NOTE);
const note = (ref: NoteRef, state: NoteState, o: { deadlineMs?: bigint; scope?: bigint; label?: bigint } = {}): NoteRecord =>
  ({ id: refKey(ref), ref, scope: o.scope ?? SCOPE, precommitment: 1n, state, leaf: { value: 10n ** 15n, label: o.label ?? L, commitment: 3n, leafIndex: 0n }, deadlineMs: o.deadlineMs ?? 2_000_000n }) as NoteRecord;
const NUL = noteSecrets(SEED, NOTE).nullifierHash;
// the pool's round: finalized anchor block 100
const release = (block: bigint, nullifier = NUL): EvmPoolEvent => ({ block, blockHash: `0x${"ab".repeat(32)}`, logIndex: 0n, bytes: "", kind: "withdraw", state: 5n, label: null, value: 10n ** 15n, precommitment: null, nullifier, recipient: "0x" + "11".repeat(20), token: null });
const of = (notes: NoteRecord[], events: EvmPoolEvent[] = []) => evmSellSent(SEED, SCOPE, L, J, notes, { fin: { number: 100n }, events });

test("a note of this pool whose proof left the device and that pays this W is sent: its ref, nullifier hash and deadline", () => {
  assert.deepEqual(of([note(NOTE, "RESERVED", { deadlineMs: 1_000_000n })]), [{ note: refKey(NOTE), nullifier: noteSecrets(SEED, NOTE).nullifierHash, deadlineMs: 1_000_000n }]);
});

test("the W a note pays is its (label, j): the same W as freshWallet derives, so no key is derived to match it", () => {
  // two refs with the same (l, j) pay one W; a ref with another j, or a note with another label, pays another
  const same: NoteRef = { kind: "change", l: L, j: 2 };
  const other: NoteRef = { kind: "change", l: L, j: 5 };
  const w = (label: bigint, ref: NoteRef) => {
    const k = d.freshWallet(SEED, "evm", label, jOf(ref));
    k.secretKey.fill(0);
    return k.address;
  };
  assert.equal(w(L, same), w(L, NOTE));
  assert.notEqual(w(L, other), w(L, NOTE));
  assert.notEqual(w(L + 1n, NOTE), w(L, NOTE));
  assert.deepEqual(of([note(other, "RESERVED"), note(NOTE, "RESERVED", { label: L + 1n })]), []);
});

test("only this pool's notes on their way count: HELD, UNSPENT and another pool's are not", () => {
  for (const n of [note(NOTE, "HELD"), note(NOTE, "UNSPENT"), note(NOTE, "RESERVED", { scope: SCOPE + 1n }), note(NOTE, "SPENT", { scope: SCOPE + 1n })]) assert.deepEqual(of([n]), [], `${n.state} ${n.scope}`);
});

test("a SPENT note is listed, with no deadline, while the pool's round shows its release above the finalized anchor or not at all (review of 181fd050, info)", () => {
  const spent = { note: refKey(NOTE), nullifier: NUL };
  // the store saw it land on a fresher round than this one: not in the round
  assert.deepEqual(of([note(NOTE, "SPENT")]), [spent]);
  assert.deepEqual(of([note(NOTE, "SPENT")], [release(150n, NUL + 1n)]), [spent]);
  // in the round above the anchor: not final
  assert.deepEqual(of([note(NOTE, "SPENT")], [release(101n)]), [spent]);
  // at or below it: final
  assert.deepEqual(of([note(NOTE, "SPENT")], [release(100n)]), []);
  assert.deepEqual(of([note(NOTE, "SPENT")], [release(7n)]), []);
  // another W's spent note is not this W's
  assert.deepEqual(of([note({ kind: "change", l: L, j: 5 }, "SPENT")]), []);
});

test("a RESERVED note without its leaf or deadline is refused, never passed over", () => {
  const n = note(NOTE, "RESERVED");
  delete (n as { deadlineMs?: bigint }).deadlineMs;
  assert.throws(() => of([n]), /a RESERVED note holds its leaf and its deadline/);
  const m = note(NOTE, "RESERVED");
  delete (m as { leaf?: unknown }).leaf;
  assert.throws(() => of([m]), /a RESERVED note holds its leaf and its deadline/);
});
