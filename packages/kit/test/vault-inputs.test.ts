// node --test packages/kit/test/vault-inputs.test.ts: a withdrawal's proof inputs built from the leaves on the device
// (src/vault/inputs.ts, card vault-input-builder) are the ones the circuit takes. The pinned withdraw.wasm computes a
// witness from them, with the circuit's own witness calculator (snarkjs 0.7.5's wtns.calculate, circom_runtime), and
// any root the circuit would not reach fails there with "Assert Failed" (withdraw.circom:73 and :82).
// Fixture 1 is the research vector proofs/g1-phone-prover/vectors/ (gen-vectors.mjs, research main aa5bc1e): five test
// deposits, note 2 spent in part; its roots, siblings and the circuit's 8 public signals are pinned below. Test values
// only (keccak256("g1-setup-files/test/<tag>") mod p), never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { vaultMerklePath, vaultRootOfPath, vaultWithdrawInput, type VaultWithdrawInput } from "../src/vault/inputs.ts";
import { VAULT_FIELD_P, vaultLabelOf, vaultScopeOf } from "../src/vault/shapes.ts";

type Wtns = { type: "mem"; data?: Uint8Array };
const snarkjs = createRequire(import.meta.url)("snarkjs") as {
  wtns: { calculate(input: unknown, wasm: Uint8Array, out: Wtns): Promise<void>; exportJson(w: Wtns): Promise<bigint[]> };
};
const WASM = new Uint8Array(readFileSync(new URL("../zk/withdraw.wasm", import.meta.url)));

/** The witness's public part: [1, newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context]. */
async function witness(input: VaultWithdrawInput): Promise<string[]> {
  const out: Wtns = { type: "mem" };
  await snarkjs.wtns.calculate(input, WASM, out);
  return (await snarkjs.wtns.exportJson(out)).slice(0, 9).map(String);
}
const ASSERT = /Assert Failed/;

const vectors = JSON.parse(readFileSync(new URL("./vectors/vault-v1.json", import.meta.url), "utf8")) as {
  label: { scope: string; nonce: string; label: string }[];
};
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const testField = (tag: string): bigint =>
  BigInt("0x" + hex(keccak_256(new TextEncoder().encode("g1-setup-files/test/" + tag)))) % VAULT_FIELD_P;
const commit = (value: bigint, label: bigint, nullifier: bigint, secret: bigint): bigint =>
  poseidon3([value, label, poseidon2([nullifier, secret])]);

// Fixture 1 (gen-vectors.mjs): vault.test.near on token.test.near, deposits with nonces 1-5.
const SCOPE = vaultScopeOf(keccak_256, "vault.test.near", "token.test.near");
const DEPOSITS = [2_000_000n, 5_000_000n, 10_000_000n, 3_000_000n, 7_000_000n];
const NOTES = DEPOSITS.map((value, i) => {
  const label = vaultLabelOf(keccak_256, SCOPE, BigInt(i + 1));
  const nullifier = testField(`note${i + 1}/nullifier`);
  const secret = testField(`note${i + 1}/secret`);
  return { value, label, nullifier, secret, commitment: commit(value, label, nullifier, secret) };
});
const STATE = NOTES.map((n) => n.commitment);
const LABELS = NOTES.map((n) => n.label);
const CHANGE = { nullifier: testField("change/nullifier"), secret: testField("change/secret") };
// the research vector's context (an older withdrawal layout; to the builder it is only a field element)
const CONTEXT_1 = 802377141111801993956095990454547848147819793756653330486998369192452016786n;

const zeros = (n: number): string[] => Array<string>(n).fill("0");
// proofs/g1-phone-prover/vectors/withdraw.input.json and expected.json at research aa5bc1e
const FIXTURE_1: VaultWithdrawInput = {
  withdrawnValue: "2000000",
  stateRoot: "19694040607821770922157628280056958563843956415515542749943686243542539030332",
  stateTreeDepth: "3",
  ASPRoot: "14742355778095561659802612499961325813236213151846608975518831588135420342697",
  ASPTreeDepth: "3",
  context: String(CONTEXT_1),
  label: "21191667877100653879994570629138790103806258137606979449794495332957801757350",
  existingValue: "5000000",
  existingNullifier: "5167432713543849691669372229876238371551184851489376383337680122844515589001",
  existingSecret: "610564222651660383309139864082342321471986686129495337129421798287255001770",
  newNullifier: "435926882517854223419705721032557235689729807900982829830502095855616458144",
  newSecret: "9906398643276167292115241945932626924081447791502658224167153476529016246875",
  stateSiblings: [
    "8499859752932370550671001217394789767391951536670225367033658110958675062099",
    "18460099182874720517321811922424949874871394512135505136538365482650754885951",
    "7197033730596184833926326171655847741624026191254888622075668419707580736041",
    ...zeros(29),
  ],
  stateIndex: "1",
  ASPSiblings: [
    "4658404729088525114212902432163076279164051564274758828674194602518397827952",
    "6579407269730807145615902490936650763414898157842175773544529180591263279341",
    "21849742818759825417587640575331978719810059319426080405927000061567926427032",
    ...zeros(29),
  ],
  ASPIndex: "1",
};
const SIGNALS_1 = [
  "1",
  "17110053328481775770369382357212930435176681876033845347408611641206377530098",
  "13656508390809383486700253218777707324848145126455925481268684662948012579156",
  "2000000",
  FIXTURE_1.stateRoot,
  "3",
  FIXTURE_1.ASPRoot,
  "3",
  FIXTURE_1.context,
];

const spend = (i: number, withdrawn: bigint, context: bigint, stateLeaves = STATE, labelLeaves = LABELS): VaultWithdrawInput => {
  const n = NOTES[i]!;
  return vaultWithdrawInput({
    stateLeaves,
    labelLeaves,
    note: { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret },
    newNullifier: CHANGE.nullifier,
    newSecret: CHANGE.secret,
    withdrawn,
    context,
  });
};

/** The public signals the circuit must output for these inputs, computed apart from the wasm. */
function expectedSignals(inp: VaultWithdrawInput): string[] {
  const left = BigInt(inp.existingValue) - BigInt(inp.withdrawnValue);
  const newCommitment = commit(left, BigInt(inp.label), BigInt(inp.newNullifier), BigInt(inp.newSecret));
  const nullifierHash = poseidon1([BigInt(inp.existingNullifier)]);
  return ["1", newCommitment, nullifierHash, inp.withdrawnValue, inp.stateRoot, inp.stateTreeDepth, inp.ASPRoot, inp.ASPTreeDepth, inp.context].map(String);
}

test("the fixture's labels are the kit's vectors (vault-v1.json, nonces 1 and 2)", () => {
  for (const v of vectors.label.filter((l) => BigInt(l.scope) === SCOPE)) {
    assert.equal(String(LABELS[Number(v.nonce) - 1]), v.label, `nonce ${v.nonce}`);
  }
  assert.equal(vectors.label.filter((l) => BigInt(l.scope) === SCOPE).length, 2);
});

test("fixture 1: the inputs equal the research vector, value for value and key for key", () => {
  const got = spend(1, 2_000_000n, CONTEXT_1);
  assert.deepEqual(got, FIXTURE_1);
  assert.equal(JSON.stringify(got), JSON.stringify(FIXTURE_1));
});

test("fixture 1: withdraw.wasm computes a witness whose 8 public signals are the research vector's", async () => {
  assert.deepEqual(await witness(spend(1, 2_000_000n, CONTEXT_1)), SIGNALS_1);
  assert.deepEqual(expectedSignals(FIXTURE_1), SIGNALS_1);
});

test("every leaf of fixture trees of 1 to 100 leaves: the circuit's root rule reaches the tree's root", () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 33, 64, 65, 100]) {
    const leaves = Array.from({ length: n }, (_, i) => testField(`tree/${n}/${i}`));
    for (const [i, leaf] of leaves.entries()) {
      const p = vaultMerklePath(leaves, leaf);
      assert.equal(p.siblings.length, 32);
      assert.equal(p.depth, n === 1 ? 0 : Math.ceil(Math.log2(n)), `depth of ${n}`);
      assert.equal(vaultRootOfPath(leaf, p.index, p.siblings), p.root, `${n} leaves, leaf ${i}`);
      const kept = p.siblings.findIndex((s) => s === 0n);
      assert.ok(p.siblings.slice(kept < 0 ? 32 : kept).every((s) => s === 0n), "every 0 is after the last sibling");
    }
  }
});

test("withdraw.wasm accepts sparse paths, a change note at a later state index, a one-leaf tree and a full withdrawal", async () => {
  // note 5 of 5: levels 0 and 1 have no sibling, so LeanIMT's index (1) is not the leaf's position (4)
  const sparse = spend(4, 7_000_000n, 7n);
  assert.equal(sparse.stateIndex, "1");
  assert.deepEqual(sparse.stateSiblings.slice(1), zeros(31));
  assert.deepEqual(await witness(sparse), expectedSignals(sparse));

  // the change note of fixture 1, leaf 6 of the state tree, spent again: its label is still leaf 2 of the label tree
  const n = NOTES[1]!;
  const change = commit(3_000_000n, n.label, CHANGE.nullifier, CHANGE.secret);
  const state6 = [...STATE, change];
  const again = vaultWithdrawInput({
    stateLeaves: state6,
    labelLeaves: LABELS,
    note: { value: 3_000_000n, label: n.label, nullifier: CHANGE.nullifier, secret: CHANGE.secret },
    newNullifier: testField("change2/nullifier"),
    newSecret: testField("change2/secret"),
    withdrawn: 1_000_000n,
    context: 9n,
  });
  assert.equal(again.stateIndex, "3"); // position 5 (0b101) of 6: level 1 has no sibling, so LeanIMT's index is 0b11
  assert.equal(again.ASPIndex, "1");
  assert.deepEqual(await witness(again), expectedSignals(again));

  // a vault of one deposit: depth 0, every sibling 0, the root is the leaf
  const one = spend(0, 2_000_000n, 1n, [STATE[0]!], [LABELS[0]!]);
  assert.equal(one.stateTreeDepth, "0");
  assert.equal(one.stateRoot, String(STATE[0]));
  assert.deepEqual(one.stateSiblings, zeros(32));
  assert.deepEqual(await witness(one), expectedSignals(one));
});

test("withdraw.wasm on random trees up to 300 leaves: every input it is given reaches its roots", async () => {
  let seed = 1;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let k = 0; k < 6; k++) {
    const extra = Array.from({ length: rnd(300) }, (_, i) => testField(`random/${k}/${i}`));
    const at = rnd(extra.length + 1);
    const stateLeaves = [...extra.slice(0, at), STATE[2]!, ...extra.slice(at)];
    const labelLeaves = [...extra.slice(0, rnd(extra.length + 1)).map((x) => (x + 1n) % VAULT_FIELD_P), LABELS[2]!];
    const inp = spend(2, 1n, 3n, stateLeaves, labelLeaves);
    assert.deepEqual(await witness(inp), expectedSignals(inp));
  }
});

test("plants: 0s before the siblings, siblings out of order, or the leaf's position for LeanIMT's index fail at witness time", async () => {
  const f1 = spend(1, 1n, 5n); // three siblings in each tree
  assert.deepEqual(await witness(f1), expectedSignals(f1));
  const frontState = { ...f1, stateSiblings: [...zeros(29), ...f1.stateSiblings.slice(0, 3)] };
  await assert.rejects(witness(frontState), ASSERT);
  const frontLabel = { ...f1, ASPSiblings: [...zeros(29), ...f1.ASPSiblings.slice(0, 3)] };
  await assert.rejects(witness(frontLabel), ASSERT);
  const swapped = { ...f1, stateSiblings: [f1.stateSiblings[1]!, f1.stateSiblings[0]!, ...f1.stateSiblings.slice(2)] };
  await assert.rejects(witness(swapped), ASSERT);
  const sparse = spend(4, 1n, 5n); // note 5 of 5: one sibling, LeanIMT's index 1, position 4
  assert.deepEqual(await witness(sparse), expectedSignals(sparse));
  await assert.rejects(witness({ ...sparse, stateIndex: "4" }), ASSERT);
  await assert.rejects(witness({ ...sparse, ASPIndex: "4" }), ASSERT);
  await assert.rejects(witness({ ...sparse, stateSiblings: [...zeros(31), sparse.stateSiblings[0]!] }), ASSERT);
});

test("refusals: what the circuit or the vault would refuse never reaches a proof", () => {
  const n = NOTES[1]!;
  const base = {
    stateLeaves: STATE,
    labelLeaves: LABELS,
    note: { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret },
    newNullifier: CHANGE.nullifier,
    newSecret: CHANGE.secret,
    withdrawn: 1n,
    context: 1n,
  };
  const P = VAULT_FIELD_P;
  const cases: [string, Partial<typeof base>, RegExp][] = [
    ["commitment absent", { stateLeaves: STATE.filter((_, i) => i !== 1) }, /commitment: the leaf is not in the tree/],
    ["label absent", { labelLeaves: LABELS.filter((_, i) => i !== 1) }, /label: the leaf is not in the tree/],
    ["wrong value", { note: { ...base.note, value: n.value + 1n } }, /commitment: the leaf is not in the tree/],
    ["withdrawn 0", { withdrawn: 0n }, /withdrawn: 0/],
    ["withdrawn over value", { withdrawn: n.value + 1n }, /over the note's value/],
    ["value 2^128", { note: { ...base.note, value: 1n << 128n } }, /2\^128/],
    ["nullifier reused", { newNullifier: n.nullifier }, /equals the spent note's nullifier/],
    ["context = p", { context: P }, /context: not a field element/],
    ["secret = p", { note: { ...base.note, secret: P } }, /note.secret: not a field element/],
    ["negative", { newSecret: -1n }, /newSecret: not a field element/],
    ["leaf = p", { stateLeaves: [...STATE, P] }, /stateLeaves\[5\]: not a field element/],
    ["leaf 0", { labelLeaves: [...LABELS, 0n] }, /labelLeaves\[5\]: a leaf is never 0/],
    ["leaf repeats", { stateLeaves: [...STATE, STATE[0]!] }, /stateLeaves\[5\]: a leaf repeats/],
    ["no leaves", { labelLeaves: [] }, /labelLeaves: no leaves/],
  ];
  for (const [name, change, err] of cases) {
    assert.throws(() => vaultWithdrawInput({ ...base, ...change }), err, name);
  }
  assert.throws(() => vaultRootOfPath(1n, 0, [0n]), /not 32/);
  assert.throws(() => vaultRootOfPath(1n, 2 ** 32, Array<bigint>(32).fill(0n)), /index/);
});
