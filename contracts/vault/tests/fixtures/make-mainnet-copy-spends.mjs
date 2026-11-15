// SPDX-License-Identifier: Apache-2.0
// Writes tests/fixtures/mainnet-copy-spends.json: three test deposits into the mainnet vault's copy and real withdraw
// proofs spending them, for tests/mainnet_copy_payouts.rs (card near-cash-pays-any-amount). Test notes only (secrets
// are keccak256("near-cash-copy/<tag>") mod p), never money.
//
// The trees are the copied vault's own: its leaves and labels as tests/fixtures/mainnet-vault-copy.json recorded them
// at the copy's block (each tree's root rebuilt here must be the root its view gave there), then the three deposits in
// order, their labels the vault's label rule for nonces past the copied STATE's nonce. So every proof is against a
// mainnet tree grown by three deposits, and the test checks the sandbox's leaves() and labels() equal these.
//
// The spends (relay_fee F = 150,000 = 0.15 USDC each, register_deposit the token's minimum, the helper's relayer
// relayer.test.near as fee_recipient, deadline 2100-01-01):
// - buy_whole and buy_change, the NEAR buy's payout: notes 1 and 2 into the same fresh implicit W (64 hex, never
//   created), neither note alone (less its fee) reaching the buy amount. buy_whole spends note 1 whole (change 0);
//   buy_change spends part of note 2 and keeps a change note above two fees.
// - cash_whole, the Cash withdraw: note 3 whole to the named account cash.test.near.
// Every proof is made by the kit's own input builder (packages/kit/src/vault/inputs.ts, vaultWithdrawInput) and
// snarkjs groth16.fullProve with the pinned packages/kit/zk/withdraw.wasm and withdraw.zkey, then checked with
// snarkjs groth16.verify against withdraw.vkey.
//
// Run from the repo root after `pnpm install`: node contracts/vault/tests/fixtures/make-mainnet-copy-spends.mjs
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

const copy = JSON.parse(readFileSync(join(here, "mainnet-vault-copy.json"), "utf8"));
const release = JSON.parse(readFileSync(join(here, "../../deployments/mainnet-v1.json"), "utf8"));
const VAULT = copy.account_id;
const ASSET = release.asset;
const RELAYER = "relayer.test.near";
const CASH = "cash.test.near";
const DEPOSITOR = "u.test.near";
const FEE = 150_000n;
const REGISTER_MIN = "1250000000000000000000"; // USDC's storage_balance_bounds min (apps/helper/src/withdraw/fee.ts REGISTER_DEPOSIT_MAX)
// note 1, note 2, note 3
const VALUES = [3_000_000n, 2_500_000n, 2_000_000n];
// the buy: what W must hold, the two parts less their fees
const BUY = 4_500_000n;
// 2100-01-01T00:00:00Z: the sandbox's block clock is the host's
const DEADLINE = 4_102_444_800_000;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const k = (tag) => keccak_256(new TextEncoder().encode("near-cash-copy/" + tag));
const testField = (tag) => BigInt("0x" + hex(k(tag))) % VAULT_FIELD_P;
const salt = (tag) => hex(k("salt/" + tag)).slice(0, 32);
// W: a fresh one-use implicit account id (64 lowercase hex) no one holds a key to and no transaction creates
const W = hex(k("W"));

const scope = vaultScopeOf(keccak_256, VAULT, ASSET);
if (String(scope) !== release.scope) throw new Error(`scope ${scope}, the release's is ${release.scope}`);

// the copied trees, checked against the copied views' roots
const stateRec = copy.state.find(([name]) => name === Buffer.from("STATE").toString("base64"));
if (!stateRec) throw new Error("the copy holds no STATE record");
const nonce0 = Buffer.from(stateRec[1], "base64").readBigUInt64LE(0);
const v = copy.views;
const leaves0 = v.leaves.map(BigInt);
const labels0 = v.labels.map(BigInt);
if (BigInt(v.deposits.length) !== nonce0 || BigInt(labels0.length) !== nonce0) throw new Error(`nonce ${nonce0}, ${v.deposits.length} deposits, ${labels0.length} labels`);
if (leaves0.length !== v.state_tree.size || labels0.length !== v.label_tree.size) throw new Error("the copied pages are not whole trees");
if (String(new VaultTree(leaves0).root) !== v.state_tree.root) throw new Error("the copied leaves do not hash to the copied state root");
if (String(new VaultTree(labels0).root) !== v.label_tree.root) throw new Error("the copied labels do not hash to the copied label root");
for (let i = 0; i < labels0.length; i++) {
  if (vaultLabelOf(keccak_256, scope, BigInt(i + 1)) !== labels0[i]) throw new Error(`copied label ${i} is not the label rule's for nonce ${i + 1}`);
}

const notes = VALUES.map((value, i) => {
  const label = vaultLabelOf(keccak_256, scope, nonce0 + BigInt(i + 1));
  const nullifier = testField(`note${i + 1}/nullifier`);
  const secret = testField(`note${i + 1}/secret`);
  const precommitment = poseidon2([nullifier, secret]);
  return { value, label, nullifier, secret, precommitment, commitment: poseidon3([value, label, precommitment]) };
});
const leaves = [...leaves0, ...notes.map((n) => n.commitment)];
const labels = [...labels0, ...notes.map((n) => n.label)];
const stateTree = new VaultTree(leaves);
const labelTree = new VaultTree(labels);

const zk = (f) => join(kit, "zk", f);
const vkey = JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8"));

async function spend(name, n, withdrawn, recipient) {
  const note = notes[n];
  const withdrawal = {
    recipient,
    register_deposit: REGISTER_MIN,
    fee_recipient: RELAYER,
    relay_fee: String(FEE),
    refund_precommitment: String(testField(`${name}/refund`)),
    deadline_ms: DEADLINE,
    salt: salt(name),
  };
  const newNullifier = testField(`${name}/change/nullifier`);
  const newSecret = testField(`${name}/change/secret`);
  const input = vaultWithdrawInput({
    stateTree,
    labelTree,
    newestStateRoot: stateTree.root,
    newestLabelRoot: labelTree.root,
    note: { value: note.value, label: note.label, nullifier: note.nullifier, secret: note.secret },
    newNullifier,
    newSecret,
    withdrawn,
    withdrawal,
    vaultId: VAULT,
    scope,
    nowMs: 1_700_000_000_000,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk("withdraw.wasm"), zk("withdraw.zkey"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  const change = note.value - withdrawn;
  // the change note the proof commits: Poseidon(change, the spent note's label, Poseidon(newNullifier, newSecret))
  const changeCommitment = poseidon3([change, note.label, poseidon2([newNullifier, newSecret])]);
  if (String(changeCommitment) !== publicSignals[0]) throw new Error(`${name}: the change commitment is not public signal 0`);
  console.error(`${name}: note ${n + 1} (${note.value}), withdrawn ${withdrawn}, change ${change}, to ${recipient}`);
  return {
    name,
    note: n,
    withdrawn: String(withdrawn),
    to_recipient: String(withdrawn - FEE),
    change_value: String(change),
    change_label: String(note.label),
    change_precommitment: String(poseidon2([newNullifier, newSecret])),
    withdrawal,
    proof: { a: proof.pi_a.slice(0, 2), b: proof.pi_b.slice(0, 2), c: proof.pi_c.slice(0, 2) },
    public_signals: publicSignals,
  };
}

const spends = [
  await spend("buy_whole", 0, VALUES[0], W),
  await spend("buy_change", 1, 1_800_000n, W),
  await spend("cash_whole", 2, VALUES[2], CASH),
];
const [a, b] = spends;
const parts = BigInt(a.to_recipient) + BigInt(b.to_recipient);
if (parts !== BUY) throw new Error(`the two parts pay ${parts}, the buy is ${BUY}`);
for (const n of notes.slice(0, 2)) if (n.value - FEE >= BUY) throw new Error("a note alone pays the buy");
if (a.change_value !== "0" || BigInt(b.change_value) <= 2n * FEE) throw new Error("want one part whole and one with change above two fees");

const out = {
  notes: [
    "Real withdraw proofs for tests/mainnet_copy_payouts.rs (card near-cash-pays-any-amount), against the mainnet vault's copy (mainnet-vault-copy.json) grown by the three test deposits below. Test notes only, never money.",
    "Made by contracts/vault/tests/fixtures/make-mainnet-copy-spends.mjs: the kit's vaultWithdrawInput, then snarkjs groth16.fullProve with packages/kit/zk/withdraw.wasm and withdraw.zkey; snarkjs groth16.verify passes each.",
    "leaves and labels: the copied vault's trees at the copy's block, then the three deposits in order (their labels for nonces past the copied nonce). precommitments: what each deposit's message names; values: each deposit's amount.",
    "proof: snarkjs's pi_a, pi_b, pi_c without the projective last element. public_signals in snarkjs order: [newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context].",
  ],
  copy_block: copy.block.height,
  vault: VAULT,
  asset: ASSET,
  scope: String(scope),
  nonce: String(nonce0),
  depositor: DEPOSITOR,
  relayer: RELAYER,
  cash: CASH,
  w: W,
  fee: String(FEE),
  register_deposit: REGISTER_MIN,
  buy: String(BUY),
  precommitments: notes.map((x) => String(x.precommitment)),
  values: VALUES.map(String),
  commitments: notes.map((x) => String(x.commitment)),
  leaves: leaves.map(String),
  labels: labels.map(String),
  state_root: String(stateTree.root),
  label_root: String(labelTree.root),
  spends,
};
writeFileSync(join(here, "mainnet-copy-spends.json"), JSON.stringify(out, null, 2) + "\n");
console.error(`wrote mainnet-copy-spends.json: copy block ${copy.block.height}, nonce ${nonce0}, W ${W}`);
process.exit(0);
