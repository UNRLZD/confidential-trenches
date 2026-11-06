// SPDX-License-Identifier: Apache-2.0
// Writes tests/fixtures/s19-spends.json: real proofs for VT-S19 (tests/s19.rs, vault.md 5 V:1158), the spend view.
// Test notes only (secrets are keccak256("withdraw-spends/<tag>") mod p), never money.
//
// The vault is tests/fixtures/withdraw-spends.json's: its six deposits on vault.test.near with the mainnet build's
// TOKEN and the same secrets, leaves and labels (this script checks them against that file). Notes 1-5 name
// u.test.near as depositor, note 6 names q.test.near. Every withdraw proof is against the six deposits' trees (a
// root the vault has had is accepted for good, vault.md 2.4):
//   arm_alice: note 2 (5,000,000), withdraw 3,000,000 to alice.test.near, relay_fee 100,000, fee to relayer.test.near;
//   arm_bob:   note 2 again, whole, to bob.test.near, relay_fee 200,000, fee to relayer2.test.near. The two arms are
//              two attempts on one note (one nullifier hash), each with its own salt, so two contexts;
//   bounce:    note 1 (2,000,000) whole to carol.test.near, which the test leaves unregistered on the token, relay_fee
//              50,000: the payout bounces and settle writes its refund note (label of nonce 7);
//   other:     note 4 (3,000,000) whole to bob.test.near, relay_fee 0: a fourth row, and VT_S19_PLANT=arm's second arm
//              (a different note, so it lands);
//   ragequit:  a commitment proof of note 3 (10,000,000), by its depositor u.test.near.
// Each spend's refund_precommitment is Poseidon(nullifier, secret) of a refund note the test knows. Withdraw proofs
// come from the kit's own input builder (packages/kit/src/vault/inputs.ts, vaultWithdrawInput); the commitment proof
// takes {value, label, nullifier, secret} (commitment.circom). Both by snarkjs 0.7.5 groth16.fullProve with the pinned
// packages/kit/zk files, each checked with snarkjs groth16.verify.
//
// Run from the repo root after `pnpm install`: node contracts/vault/tests/fixtures/make-s19-spends.mjs
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
const salt = (tag) => hex(keccak_256(new TextEncoder().encode("withdraw-spends/salt/s19/" + tag))).slice(0, 32);

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
/** The refund note a spend names: its secrets, as the device keeps them. */
const refundOf = (name) => note(0n, 0n, `s19/${name}/refund`);

async function prove(circuit, name, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk(`${circuit}.wasm`), zk(`${circuit}.zkey`));
  if (!(await snarkjs.groth16.verify(vkeys[circuit], publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  console.error(`${name}: ${circuit}, signals ${publicSignals.map((s) => s.slice(0, 8)).join(" ")}`);
  return { proof: affine(proof), public_signals: publicSignals };
}

const deposits = notes.map((x) => x.commitment);
const depositLabels = notes.map((x) => x.label);

/** A withdraw of `withdrawn` from `n` with the request `to`, against the six deposits' trees. */
async function withdraw(name, n, withdrawn, to) {
  const withdrawal = {
    recipient: to.recipient,
    register_deposit: "0",
    fee_recipient: to.feeRecipient,
    relay_fee: to.relayFee,
    refund_precommitment: String(refundOf(name).precommitment),
    deadline_ms: DEADLINE,
    salt: salt(name),
  };
  const change = note(n.value - withdrawn, n.label, `s19/${name}/change`);
  const input = vaultWithdrawInput({
    stateTree: new VaultTree(deposits),
    labelTree: new VaultTree(depositLabels),
    newestStateRoot: new VaultTree(deposits).root,
    newestLabelRoot: new VaultTree(depositLabels).root,
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
  if (p.public_signals[1] !== String(poseidon1([n.nullifier]))) throw new Error(`${name}: the nullifier hash is not the note's`);
  if (p.public_signals[2] !== String(withdrawn)) throw new Error(`${name}: withdrawnValue`);
  return { name, withdrawal, ...p };
}

const armAlice = await withdraw("arm_alice", notes[1], 3_000_000n, { recipient: "alice.test.near", feeRecipient: "relayer.test.near", relayFee: "100000" });
const armBob = await withdraw("arm_bob", notes[1], 5_000_000n, { recipient: "bob.test.near", feeRecipient: "relayer2.test.near", relayFee: "200000" });
if (armAlice.public_signals[1] !== armBob.public_signals[1]) throw new Error("the two arms spend one note, so one nullifier hash");
if (armAlice.public_signals[7] === armBob.public_signals[7]) throw new Error("the two arms' contexts must differ");
const bounce = await withdraw("bounce", notes[0], 2_000_000n, { recipient: "carol.test.near", feeRecipient: "relayer.test.near", relayFee: "50000" });
const other = await withdraw("other", notes[3], 3_000_000n, { recipient: "bob.test.near", feeRecipient: "relayer.test.near", relayFee: "0" });

const n3 = notes[2];
const rq = await prove("commitment", "ragequit", { value: n3.value, label: n3.label, nullifier: n3.nullifier, secret: n3.secret });
if (rq.public_signals[0] !== String(n3.commitment) || rq.public_signals[1] !== String(poseidon1([n3.nullifier]))) throw new Error("ragequit: signals");
const ragequit = { name: "ragequit", depositor: DEPOSITORS[2], register_deposit: "0", refund_precommitment: String(refundOf("ragequit").precommitment), ...rq };

// settle writes bounce's refund note with the next nonce's label (six deposits took nonces 1-6)
const refundLabel = vaultLabelOf(keccak_256, scope, 7n);
const r = refundOf("bounce");
const refund = { spend: "bounce", value: "2000000", label: String(refundLabel), commitment: String(poseidon3([2_000_000n, refundLabel, r.precommitment])), refund_precommitment: String(r.precommitment) };

const out = {
  notes: [
    "Real proofs for VT-S19 (tests/s19.rs): two arms of one note to two recipients, a bounced payout, a fourth withdrawal and a ragequit. Test notes only, never money.",
    "Made by contracts/vault/tests/fixtures/make-s19-spends.mjs on withdraw-spends.json's six deposits (notes 1-5 by u.test.near, note 6 by q.test.near): withdraw proofs by the kit's vaultWithdrawInput against the six deposits' trees, the ragequit's by commitment.circom; snarkjs 0.7.5 groth16.fullProve with packages/kit/zk, and snarkjs groth16.verify passes each.",
    "arms: arm_alice and arm_bob share one nullifier hash (note 2) and differ in recipient, withdrawn, fee, fee recipient, refund precommitment, salt and so context. refund: the note settle writes for bounce (label of nonce 7).",
  ],
  vault: VAULT,
  deposited: base.deposited,
  deposits: notes.map((n, i) => ({ commitment: String(n.commitment), label: String(n.label), precommitment: String(n.precommitment), value: String(n.value), depositor: DEPOSITORS[i] })),
  arms: [armAlice, armBob],
  withdrawals: [bounce, other],
  ragequit,
  refund,
};
writeFileSync(join(here, "s19-spends.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote s19-spends.json");
process.exit(0);
