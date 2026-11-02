// SPDX-License-Identifier: Apache-2.0
// Writes tests/fixtures/settle-spends.json: real withdraw proofs for VT-S08 (tests/settle.rs), whose refund notes the
// device can spend. Test notes only (secrets are keccak256("withdraw-spends/<tag>") mod p), never money.
//
// The vault is tests/fixtures/withdraw-spends.json's: its six deposits on vault.test.near with the mainnet build's
// TOKEN, the same secrets, leaves and labels (this script checks them against that file). Then, in the order
// tests/settle.rs runs them:
//   1. fee_bounces: note 5 (7,000,000) whole, relay_fee 100,000, to newcomer.test.near (already registered) with a
//      register_deposit of 0.00125 NEAR, the fee recipient unregistered: the fee part bounces, refund 100,000;
//   2. recipient_bounces: note 1 (2,000,000) whole, relay_fee 500,000, to alice.test.near (unregistered), register 0:
//      the recipient part bounces, refund 1,500,000;
//   3. settle fee_bounces, then settle recipient_bounces: refund notes with labels of nonces 7 and 8;
//   4. refund_note: the device spends fee_bounces' refund note (100,000, label of nonce 7) whole to alice.test.near,
//      against the trees as step 3 leaves them (10 leaves, 8 labels).
// Each withdrawal's refund_precommitment is Poseidon(nullifier, secret) of a refund note the test knows, as the
// device's is (wallet.md 2.3 Secrets: the refund note of change note j of label l takes its secrets from refundMaster).
// Every proof is made by the kit's own input builder (packages/kit/src/vault/inputs.ts, vaultWithdrawInput) and
// snarkjs 0.7.5 groth16.fullProve with the pinned packages/kit/zk/withdraw.wasm and withdraw.zkey, then checked with
// snarkjs groth16.verify against withdraw.vkey.
//
// Run from the repo root after `pnpm install`: node contracts/vault/tests/fixtures/make-settle-spends.mjs
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
const { poseidon2, poseidon3 } = await imp("poseidon-lite");
const snarkjs = await imp("snarkjs");
const { VaultTree, vaultWithdrawInput } = await import(pathToFileURL(join(kit, "src/vault/inputs.ts")).href);
const { VAULT_FIELD_P, vaultLabelOf, vaultScopeOf } = await import(pathToFileURL(join(kit, "src/vault/shapes.ts")).href);

const base = JSON.parse(readFileSync(join(here, "withdraw-spends.json"), "utf8"));
const VAULT = base.vault;
const ASSET = base.asset;
const VALUES = base.values.map(BigInt);
// 2100-01-01T00:00:00Z: the sandbox's block clock is the host's
const DEADLINE = 4_102_444_800_000;
const REGISTER = "1250000000000000000000";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const testField = (tag) => BigInt("0x" + hex(keccak_256(new TextEncoder().encode("withdraw-spends/" + tag)))) % VAULT_FIELD_P;
const salt = (tag) => hex(keccak_256(new TextEncoder().encode("withdraw-spends/salt/settle/" + tag))).slice(0, 32);

// the six deposits, as make-withdraw-spends.mjs makes them
const scope = vaultScopeOf(keccak_256, VAULT, ASSET);
const notes = VALUES.map((value, i) => {
  const label = vaultLabelOf(keccak_256, scope, BigInt(i + 1));
  const nullifier = testField(`${VAULT}/note${i + 1}/nullifier`);
  const secret = testField(`${VAULT}/note${i + 1}/secret`);
  return { value, label, nullifier, secret, commitment: poseidon3([value, label, poseidon2([nullifier, secret])]) };
});
if (String(scope) !== base.scope) throw new Error("scope differs from withdraw-spends.json");
notes.forEach((n, i) => {
  if (String(n.commitment) !== base.leaves[i] || String(n.label) !== base.labels[i]) throw new Error(`deposit ${i + 1} differs from withdraw-spends.json`);
});

const zk = (f) => join(kit, "zk", f);
const vkey = JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8"));

/** The refund note a withdrawal names: its secrets, as the device keeps them. */
const refundOf = (name) => {
  const nullifier = testField(`settle/${name}/refund/nullifier`);
  const secret = testField(`settle/${name}/refund/secret`);
  return { nullifier, secret, precommitment: poseidon2([nullifier, secret]) };
};

/** A proof spending `note` whole (change 0) against `leaves` and `labels`, with the request `to`. */
async function spend(name, note, leaves, labels, to) {
  const withdrawal = {
    recipient: to.recipient,
    register_deposit: to.registerDeposit ?? "0",
    fee_recipient: "relayer.test.near",
    relay_fee: to.relayFee ?? "0",
    refund_precommitment: String(refundOf(name).precommitment),
    deadline_ms: DEADLINE,
    salt: salt(name),
  };
  const input = vaultWithdrawInput({
    stateTree: new VaultTree(leaves),
    labelTree: new VaultTree(labels),
    newestStateRoot: new VaultTree(leaves).root,
    newestLabelRoot: new VaultTree(labels).root,
    note: { value: note.value, label: note.label, nullifier: note.nullifier, secret: note.secret },
    newNullifier: testField(`settle/${name}/change/nullifier`),
    newSecret: testField(`settle/${name}/change/secret`),
    withdrawn: note.value,
    withdrawal,
    vaultId: VAULT,
    scope,
    nowMs: 1_700_000_000_000,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk("withdraw.wasm"), zk("withdraw.zkey"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  const p = { a: proof.pi_a.slice(0, 2), b: proof.pi_b.slice(0, 2), c: proof.pi_c.slice(0, 2) };
  console.error(`${name}: withdrawn ${note.value}, nullifier hash ${publicSignals[1].slice(0, 12)}...`);
  return { name, withdrawal, proof: p, public_signals: publicSignals };
}

const leaves = notes.map((x) => x.commitment);
const labels = notes.map((x) => x.label);
const deposits = { leaves: [...leaves], labels: [...labels] };

// 1-2: both against the six deposits' trees; each adds its change leaf
const feeBounces = await spend("fee_bounces", notes[4], deposits.leaves, deposits.labels, {
  recipient: "newcomer.test.near",
  registerDeposit: REGISTER,
  relayFee: "100000",
});
leaves.push(BigInt(feeBounces.public_signals[0]));
const recipientBounces = await spend("recipient_bounces", notes[0], deposits.leaves, deposits.labels, {
  recipient: "alice.test.near",
  relayFee: "500000",
});
leaves.push(BigInt(recipientBounces.public_signals[0]));

// 3: settle writes each refund note with the next nonce's label
const refunds = [
  { of: feeBounces, value: 100_000n, nonce: 7n },
  { of: recipientBounces, value: 1_500_000n, nonce: 8n },
].map(({ of, value, nonce }) => {
  const label = vaultLabelOf(keccak_256, scope, nonce);
  const r = refundOf(of.name);
  const commitment = poseidon3([value, label, r.precommitment]);
  leaves.push(commitment);
  labels.push(label);
  return { spend: of.name, value, label, commitment, ...r };
});

// 4: the device spends fee_bounces' refund note
const fb = refunds[0];
const refundNote = await spend("refund_note", { value: fb.value, label: fb.label, nullifier: fb.nullifier, secret: fb.secret }, leaves, labels, {
  recipient: "alice.test.near",
});

const out = {
  notes: [
    "Real withdraw proofs for VT-S08 (tests/settle.rs): two withdrawals whose payouts bounce, then a spend of the first one's refund note. Test notes only, never money.",
    "Made by contracts/vault/tests/fixtures/make-settle-spends.mjs on withdraw-spends.json's six deposits: the kit's vaultWithdrawInput, then snarkjs 0.7.5 groth16.fullProve with packages/kit/zk/withdraw.wasm and withdraw.zkey; snarkjs groth16.verify passes each.",
    "refunds: the notes settle must write, in order (label of nonce 7, then 8; commitment Poseidon(value, label, refund_precommitment)). leaves and labels: both trees after the two settles, which refund_note is proved against.",
  ],
  vault: VAULT,
  refunds: refunds.map((r) => ({
    spend: r.spend,
    value: String(r.value),
    label: String(r.label),
    commitment: String(r.commitment),
    refund_precommitment: String(r.precommitment),
  })),
  leaves: leaves.map(String),
  labels: labels.map(String),
  spends: [feeBounces, recipientBounces, refundNote],
};
writeFileSync(join(here, "settle-spends.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote settle-spends.json");
process.exit(0);
