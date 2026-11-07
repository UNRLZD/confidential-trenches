// node --test packages/wallet/test/pool-evm-releases.test.ts: the releases the device sent to W at a sell (card
// evm-sell-no-release-in-flight, audit E-01; src/pool/evm-releases.ts), the kit sell quote's `sent`. The store's notes
// are planted as its list() gives them. Test seed only: the all-zero entropy of vectors/a8.json; never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as d from "../src/derive/index.ts";
import { noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { refKey, type NoteRecord, type NoteState } from "../src/notes/store.ts";
import { evmPoolScopeOf } from "../src/pool/evm.ts";
import { evmSellSent } from "../src/pool/evm-releases.ts";
import { jOf } from "../src/pool/queue.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const SCOPE = evmPoolScopeOf("0x00000000000000000000000000000000b1f1f001", 84532n);
const L = 77n;
const NOTE: NoteRef = { kind: "change", l: L, j: 2 };
const J = jOf(NOTE);
const note = (ref: NoteRef, state: NoteState, o: { deadlineMs?: bigint; scope?: bigint; label?: bigint } = {}): NoteRecord =>
  ({ id: refKey(ref), ref, scope: o.scope ?? SCOPE, precommitment: 1n, state, leaf: { value: 10n ** 15n, label: o.label ?? L, commitment: 3n, leafIndex: 0n }, deadlineMs: o.deadlineMs ?? 2_000_000n }) as NoteRecord;
const of = (notes: NoteRecord[]) => evmSellSent(SEED, SCOPE, L, J, notes);

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

test("only RESERVED notes of this pool count: HELD, SPENT, UNSPENT and another pool's are not on their way", () => {
  for (const n of [note(NOTE, "HELD"), note(NOTE, "SPENT"), note(NOTE, "UNSPENT"), note(NOTE, "RESERVED", { scope: SCOPE + 1n })]) assert.deepEqual(of([n]), [], `${n.state} ${n.scope}`);
});

test("a RESERVED note without its leaf or deadline is refused, never passed over", () => {
  const n = note(NOTE, "RESERVED");
  delete (n as { deadlineMs?: bigint }).deadlineMs;
  assert.throws(() => of([n]), /a RESERVED note holds its leaf and its deadline/);
  const m = note(NOTE, "RESERVED");
  delete (m as { leaf?: unknown }).leaf;
  assert.throws(() => of([m]), /a RESERVED note holds its leaf and its deadline/);
});
