// SPDX-License-Identifier: Apache-2.0
// Writes tests/fixtures/ragequit-spends.json: real proofs for VT-S09 (tests/ragequit.rs) and the lib tests of
// src/ragequit.rs. Test notes only (secrets are keccak256("withdraw-spends/<tag>") mod p), never money.
//
// The vault is tests/fixtures/withdraw-spends.json's: its six deposits on vault.test.near with the mainnet build's
// TOKEN and the same secrets (checked against that file). Notes 1-5 name u.test.near as depositor, note 6 names
// q.test.near. Then, in the order tests/ragequit.rs runs them:
//   1. change_w: note 2 (5,000,000), withdraw 1,000,000 to alice.test.near: change note 4,000,000 (leaf 6);
//   2. zero_w: note 1 (2,000,000) whole to alice.test.near: change note 0 (leaf 7);
//   3. ragequits (commitment proofs): deposit (note 3, by u), change (change_w's change, by u), zero (zero_w's change,
//      by u), unregistered (note 6, by q, register_deposit 0), unlanded (a note on note 3's label never inserted),
//      withdrawn (note 2, by u, which change_w already spent: refused); after_rq, a withdraw of 1,000,000 of note 3
//      against the trees as step 2 leaves them (8 leaves, 6 labels), sent after u's ragequit of note 3: refused;
//   4. settle writes unregistered's refund note (4,000,000, label of nonce 7, leaf 8, label 6): refund_note is its
//      commitment proof (refused: no deposit has its label) and refund_w the private withdraw that spends it whole to
//      alice.test.near, against the trees as step 4 leaves them (9 leaves, 7 labels).
//   5. one_block_a_change (for VT-P02, tests/p02.rs): withdraw-spends.json's one_block_a takes 4,000,000 of note 3,
//      so its change note is 6,000,000 on note 3's label, with that file's change secrets
//      (keccak256("withdraw-spends/one_block_a/change/{nullifier,secret}") mod p); its ragequit by u lands once
//      one_block_a's change leaf is in the tree. Appended last, so every entry before it keeps its place.
// Every ragequit's refund_precommitment is Poseidon(nullifier, secret) of a refund note the test knows. Withdraw proofs
// come from the kit's vaultWithdrawInput; commitment proofs take {value, label, nullifier, secret}
// (commitment.circom). Both by snarkjs 0.7.5 groth16.fullProve with the pinned packages/kit/zk files, each checked
// with snarkjs groth16.verify.
//
// Run from the repo root after `pnpm install`: node contracts/vault/tests/fixtures/make-ragequit-spends.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const kit = join(root, "packages/kit");
const req = createRequire(join(kit, "package.json"));
const imp = (m) => import(pathToFileURL(req.resolve(m)).href);
const { keccak_256 } = await imp("@noble/hashes/sha3.js");
const { poseidon1, poseidon2, poseidon3 } = await imp("poseidon-lite");
const snarkjs = await imp("snarkjs");
const { VaultTree, vaultWithdrawInput } = await import(pathToFileURL(join(kit, "src/vault/inputs.ts")).href);
const { VAULT_FIELD_P, vaultLabelOf, vaultScopeOf } = await import(pathToFileURL(join(kit, "src/vault/shapes.ts")).href);

const base = JSON.parse(readFileSync(join(here, "withdraw-spends.json"), "utf8"));
const VAULT = base.vault;
const VALUES = base.values.map(BigInt);
const DEPOSITORS = ["u.test.near", "u.test.near", "u.test.near", "u.test.near", "u.test.near", "q.test.near"];
// 2100-01-01T00:00:00Z: the sandbox's block clock is the host's
const DEADLINE = 4_102_444_800_000;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const testField = (tag) => BigInt("0x" + hex(keccak_256(new TextEncoder().encode("withdraw-spends/" + tag)))) % VAULT_FIELD_P;
const salt = (tag) => hex(keccak_256(new TextEncoder().encode("withdraw-spends/salt/ragequit/" + tag))).slice(0, 32);

const scope = vaultScopeOf(keccak_256, VAULT, base.asset);
const note = (value, label, tag) => {
  const nullifier = testField(`${tag}/nullifier`);
  const secret = testField(`${tag}/secret`);
  const precommitment = poseidon2([nullifier, secret]);
  return { value, label, nullifier, secret, precommitment, commitment: poseidon3([value, label, precommitment]) };
};
const notes = VALUES.map((value, i) => note(value, vaultLabelOf(keccak_256, scope, BigInt(i + 1)), `${VAULT}/note${i + 1}`));
if (String(scope) !== base.scope) throw new Error("scope differs from withdraw-spends.json");
notes.forEach((n, i) => {
  if (String(n.commitment) !== base.leaves[i] || String(n.label) !== base.labels[i] || String(n.precommitment) !== base.precommitments[i])
    throw new Error(`deposit ${i + 1} differs from withdraw-spends.json`);
});

const zk = (f) => join(kit, "zk", f);
const vkeys = { withdraw: JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8")), commitment: JSON.parse(readFileSync(zk("commitment.vkey"), "utf8")) };
const affine = (proof) => ({ a: proof.pi_a.slice(0, 2), b: proof.pi_b.slice(0, 2), c: proof.pi_c.slice(0, 2) });
const refundOf = (name) => note(0n, 0n, `ragequit/${name}/refund`).precommitment;

async function prove(circuit, name, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk(`${circuit}.wasm`), zk(`${circuit}.zkey`));
  if (!(await snarkjs.groth16.verify(vkeys[circuit], publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  console.error(`${name}: ${circuit}, signals ${publicSignals.map((s) => s.slice(0, 8)).join(" ")}`);
  return { proof: affine(proof), public_signals: publicSignals };
}

/** A withdraw of `withdrawn` from `n` to alice.test.near, fee 0, against `leaves` and `labels`; its change note. */
async function withdraw(name, n, withdrawn, leaves, labels) {
  const withdrawal = {
    recipient: "alice.test.near",
    register_deposit: "0",
    fee_recipient: "relayer.test.near",
    relay_fee: "0",
    refund_precommitment: String(refundOf(name)),
    deadline_ms: DEADLINE,
    salt: salt(name),
  };
  const change = note(n.value - withdrawn, n.label, `ragequit/${name}/change`);
  const input = vaultWithdrawInput({
    stateTree: new VaultTree(leaves),
    labelTree: new VaultTree(labels),
    newestStateRoot: new VaultTree(leaves).root,
    newestLabelRoot: new VaultTree(labels).root,
    note: { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret },
    newNullifier: change.nullifier,
    newSecret: change.secret,
    withdrawn,
    withdrawal,
    vaultId: VAULT,
    scope,
    nowMs: 1_700_000_000_000,
  });
  const p = await prove("withdraw", name, input);
  if (p.public_signals[0] !== String(change.commitment)) throw new Error(`${name}: the change commitment is not the one derived`);
  return { spend: { name, withdrawal, ...p }, change };
}

/** A ragequit of `n` by `depositor`. */
async function ragequit(name, n, depositor, registerDeposit = "0") {
  const p = await prove("commitment", name, { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret });
  if (p.public_signals[0] !== String(n.commitment) || p.public_signals[1] !== String(poseidon1([n.nullifier]))) throw new Error(`${name}: signals`);
  return { name, depositor, register_deposit: registerDeposit, refund_precommitment: String(refundOf(name)), ...p };
}

const leaves = notes.map((x) => x.commitment);
const labels = notes.map((x) => x.label);
const deposits = [...leaves];
const depositLabels = [...labels];

const changeW = await withdraw("change_w", notes[1], 1_000_000n, deposits, depositLabels);
const zeroW = await withdraw("zero_w", notes[0], 2_000_000n, deposits, depositLabels);
leaves.push(changeW.change.commitment, zeroW.change.commitment);
const afterRq = await withdraw("after_rq", notes[2], 1_000_000n, [...leaves], depositLabels);

const unregistered = await ragequit("unregistered", notes[5], DEPOSITORS[5]);
const ragequits = [
  await ragequit("deposit", notes[2], DEPOSITORS[2]),
  await ragequit("change", changeW.change, DEPOSITORS[1]),
  await ragequit("zero", zeroW.change, DEPOSITORS[0]),
  unregistered,
  await ragequit("unlanded", note(1n, notes[2].label, "ragequit/unlanded"), DEPOSITORS[2]),
];

// settle writes unregistered's refund note with the next nonce's label
const refundLabel = vaultLabelOf(keccak_256, scope, 7n);
const refund = { ...note(notes[5].value, refundLabel, "ragequit/unregistered/refund") };
if (refund.precommitment !== BigInt(unregistered.refund_precommitment)) throw new Error("the refund note's precommitment");
leaves.push(refund.commitment);
labels.push(refundLabel);
ragequits.push(await ragequit("refund_note", refund, DEPOSITORS[5]));
ragequits.push(await ragequit("withdrawn", notes[1], DEPOSITORS[1]));
// one_block_a's change note, derived as make-withdraw-spends.mjs derives it, and checked against that proof's
// newCommitmentHash
const oneBlockA = base.spends.find((s) => s.name === "one_block_a");
const oneBlockAChange = note(VALUES[2] - BigInt(oneBlockA.public_signals[2]), notes[2].label, "one_block_a/change");
if (oneBlockA.note !== 2 || String(oneBlockAChange.commitment) !== oneBlockA.public_signals[0]) throw new Error("one_block_a's change note");
ragequits.push(await ragequit("one_block_a_change", oneBlockAChange, DEPOSITORS[2]));
const refundW = await withdraw("refund_w", refund, refund.value, leaves, labels);

const out = {
  notes: [
    "Real proofs for VT-S09 (tests/ragequit.rs) and src/ragequit.rs's lib tests. Test notes only, never money.",
    "Made by contracts/vault/tests/fixtures/make-ragequit-spends.mjs on withdraw-spends.json's six deposits (notes 1-5 by u.test.near, note 6 by q.test.near): withdraw proofs by the kit's vaultWithdrawInput, commitment proofs on {value, label, nullifier, secret}; snarkjs 0.7.5 groth16.fullProve with packages/kit/zk, and groth16.verify passes each.",
    "withdrawn: a ragequit of note 2, which change_w spends; after_rq: a withdraw of note 3, which the deposit ragequit spends. Both must be refused NullifierAlreadySpent.",
    "changes: the change leaves of change_w and zero_w, in order (leaves 6 and 7). refund: the note settle writes for the unregistered ragequit (label of nonce 7, leaf 8, label 6). leaves and labels: both trees after that settle, which refund_w is proved against.",
  ],
  vault: VAULT,
  deposited: base.deposited,
  deposits: notes.map((n, i) => ({
    commitment: String(n.commitment),
    label: String(n.label),
    precommitment: String(n.precommitment),
    value: String(n.value),
    depositor: DEPOSITORS[i],
  })),
  withdrawals: [changeW.spend, zeroW.spend, refundW.spend, afterRq.spend],
  changes: [String(changeW.change.commitment), String(zeroW.change.commitment)],
  ragequits,
  refund: { commitment: String(refund.commitment), label: String(refundLabel), value: String(refund.value), refund_precommitment: unregistered.refund_precommitment },
  leaves: leaves.map(String),
  labels: labels.map(String),
};
writeFileSync(join(here, "ragequit-spends.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote ragequit-spends.json");
process.exit(0);
