// SPDX-License-Identifier: Apache-2.0
// Writes tests/fixtures/s12-spends.json: real proofs for VT-S12 (tests/s12.rs), the vault's gas at tree index 2^k - 1.
// Test notes only (secrets are keccak256("s12/<tag>") mod p), never money.
//
// The vault is vault.test.near with the mainnet build's TOKEN (withdraw-spends.json's vault and asset). NOTES notes of
// 1,000,000 (MIN_DEPOSIT) each, deposited in order by u.test.near, so note i (1-based) takes the label of nonce i:
//   - ragequits: a commitment proof of every note, register_deposit 0 (s12's direct-deposit vault deposits note i and
//     u ragequits it);
//   - withdrawals: WITHDRAWALS of them (notes 1..WITHDRAWALS) whole, against both trees of the NOTES deposits, relay_fee
//     100,000 to relayer.test.near, to newcomer.test.near with a register_deposit of 0.00125 NEAR (the costliest payout,
//     70 Tgas of statics). s12 seeds the two roots and sends them at seeded tree sizes.
// Proofs by the kit's own input builder (packages/kit/src/vault/inputs.ts, vaultWithdrawInput) and commitment inputs
// {value, label, nullifier, secret}; snarkjs 0.7.5 groth16.fullProve with the pinned packages/kit/zk files, each checked
// with snarkjs groth16.verify.
//
// Run from the repo root after `pnpm install`: node contracts/vault/tests/fixtures/make-s12-spends.mjs
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
const NOTES = 22;
const WITHDRAWALS = 17;
const VALUE = 1_000_000n;
// 2100-01-01T00:00:00Z: the sandbox's block clock is the host's
const DEADLINE = 4_102_444_800_000;
const REGISTER = "1250000000000000000000";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const testField = (tag) => BigInt("0x" + hex(keccak_256(new TextEncoder().encode("s12/" + tag)))) % VAULT_FIELD_P;
const salt = (tag) => hex(keccak_256(new TextEncoder().encode("s12/salt/" + tag))).slice(0, 32);

const scope = vaultScopeOf(keccak_256, VAULT, base.asset);
if (String(scope) !== base.scope) throw new Error("scope differs from withdraw-spends.json");
const note = (value, label, tag) => {
  const nullifier = testField(`${tag}/nullifier`);
  const secret = testField(`${tag}/secret`);
  const precommitment = poseidon2([nullifier, secret]);
  return { value, label, nullifier, secret, precommitment, commitment: poseidon3([value, label, precommitment]) };
};
const notes = Array.from({ length: NOTES }, (_, i) => note(VALUE, vaultLabelOf(keccak_256, scope, BigInt(i + 1)), `note${i + 1}`));

const zk = (f) => join(kit, "zk", f);
const vkeys = { withdraw: JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8")), commitment: JSON.parse(readFileSync(zk("commitment.vkey"), "utf8")) };
const affine = (proof) => ({ a: proof.pi_a.slice(0, 2), b: proof.pi_b.slice(0, 2), c: proof.pi_c.slice(0, 2) });
const refundOf = (name) => note(0n, 0n, `${name}/refund`).precommitment;

async function prove(circuit, name, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk(`${circuit}.wasm`), zk(`${circuit}.zkey`));
  if (!(await snarkjs.groth16.verify(vkeys[circuit], publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  console.error(`${name}: ${circuit}, signals ${publicSignals.map((s) => s.slice(0, 8)).join(" ")}`);
  return { proof: affine(proof), public_signals: publicSignals };
}

const leaves = notes.map((n) => n.commitment);
const labels = notes.map((n) => n.label);
const stateTree = new VaultTree(leaves);
const labelTree = new VaultTree(labels);

const withdrawals = [];
for (let i = 0; i < WITHDRAWALS; i++) {
  const name = `w${i + 1}`;
  const n = notes[i];
  const withdrawal = {
    recipient: "newcomer.test.near",
    register_deposit: REGISTER,
    fee_recipient: "relayer.test.near",
    relay_fee: "100000",
    refund_precommitment: String(refundOf(name)),
    deadline_ms: DEADLINE,
    salt: salt(name),
  };
  const change = note(0n, n.label, `${name}/change`);
  const input = vaultWithdrawInput({
    stateTree,
    labelTree,
    newestStateRoot: stateTree.root,
    newestLabelRoot: labelTree.root,
    note: { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret },
    newNullifier: change.nullifier,
    newSecret: change.secret,
    withdrawn: n.value,
    withdrawal,
    vaultId: VAULT,
    scope,
    nowMs: 1_700_000_000_000,
  });
  const p = await prove("withdraw", name, input);
  if (p.public_signals[0] !== String(change.commitment)) throw new Error(`${name}: the change commitment is not the one derived`);
  withdrawals.push({ name, withdrawal, ...p });
}

const ragequits = [];
for (let i = 0; i < NOTES; i++) {
  const name = `rq${i + 1}`;
  const n = notes[i];
  const p = await prove("commitment", name, { value: n.value, label: n.label, nullifier: n.nullifier, secret: n.secret });
  if (p.public_signals[0] !== String(n.commitment) || p.public_signals[1] !== String(poseidon1([n.nullifier]))) throw new Error(`${name}: signals`);
  ragequits.push({ name, register_deposit: "0", refund_precommitment: String(refundOf(name)), ...p });
}

const out = {
  notes: [
    "Real proofs for VT-S12 (tests/s12.rs). Test notes only, never money.",
    "Made by contracts/vault/tests/fixtures/make-s12-spends.mjs: 22 notes of 1,000,000 on vault.test.near, note i deposited by u.test.near with the label of nonce i; withdraw proofs by the kit's vaultWithdrawInput against both trees of the 22 deposits (state_root, label_root), commitment proofs on {value, label, nullifier, secret}; snarkjs 0.7.5 groth16.fullProve with packages/kit/zk, and groth16.verify passes each.",
    "withdrawals: notes 1-17 whole, relay_fee 100,000 to relayer.test.near, to newcomer.test.near with register_deposit 0.00125 NEAR. ragequits: every note, by its depositor u.test.near.",
  ],
  vault: VAULT,
  value: String(VALUE),
  precommitments: notes.map((n) => String(n.precommitment)),
  leaves: leaves.map(String),
  labels: labels.map(String),
  state_root: String(stateTree.root),
  label_root: String(labelTree.root),
  withdrawals,
  ragequits,
};
writeFileSync(join(here, "s12-spends.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote s12-spends.json");
process.exit(0);
