// SPDX-License-Identifier: Apache-2.0
// Writes tests/fixtures/withdraw-spends.json: real withdraw proofs for the vault's spend tests (VT-S05, VT-S06, the
// unit tests of withdraw.rs rows 4-14, and the payouts' VT-S04 in tests/payouts.rs). Test notes only (secrets are keccak256("withdraw-spends/<tag>") mod p), never
// money.
//
// Six test deposits on vault.test.near (the sandbox harness's vault) with the mainnet build's TOKEN, the asset; the
// state tree holds their commitments and the label tree their labels, in deposit order. Every proof is made by the
// kit's own input builder (packages/kit/src/vault/inputs.ts, vaultWithdrawInput) and snarkjs 0.7.5 groth16.fullProve
// with the pinned
// packages/kit/zk/withdraw.wasm and withdraw.zkey, then checked with snarkjs groth16.verify against withdraw.vkey.
// `other_vault` is the newest state and label root of the same six notes made on another vault (another scope), so
// its roots are real roots this vault never had.
//
// Run from the repo root after `pnpm install`: node contracts/vault/tests/fixtures/make-withdraw-spends.mjs
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

const VAULT = "vault.test.near";
const OTHER_VAULT = "other-vault.test.near";
// contracts/vault/src/constants.rs TOKEN, the mainnet build (the harness builds it): the vault's asset
const ASSET = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const VALUES = [2_000_000n, 5_000_000n, 10_000_000n, 3_000_000n, 7_000_000n, 4_000_000n];
// 2100-01-01T00:00:00Z: the sandbox's block clock is the host's
const DEADLINE = 4_102_444_800_000;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const testField = (tag) => BigInt("0x" + hex(keccak_256(new TextEncoder().encode("withdraw-spends/" + tag)))) % VAULT_FIELD_P;
const salt = (tag) => hex(keccak_256(new TextEncoder().encode("withdraw-spends/salt/" + tag))).slice(0, 32);

function notesOf(vault) {
  const scope = vaultScopeOf(keccak_256, vault, ASSET);
  const notes = VALUES.map((value, i) => {
    const label = vaultLabelOf(keccak_256, scope, BigInt(i + 1));
    const nullifier = testField(`${vault}/note${i + 1}/nullifier`);
    const secret = testField(`${vault}/note${i + 1}/secret`);
    return { value, label, nullifier, secret, commitment: poseidon3([value, label, poseidon2([nullifier, secret])]) };
  });
  return { scope, notes };
}

const { scope, notes } = notesOf(VAULT);
const other = notesOf(OTHER_VAULT).notes;

const zk = (f) => join(kit, "zk", f);
const vkey = JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8"));

/** A proof spending note `n` (0-based) for `withdrawn`, against the trees of the first `size` deposits. */
async function spend(name, n, withdrawn, tag, size = notes.length, relayFee = "0", to = {}) {
  const state = notes.slice(0, size).map((x) => x.commitment);
  const labels = notes.slice(0, size).map((x) => x.label);
  const withdrawal = {
    recipient: to.recipient ?? "alice.test.near",
    register_deposit: to.registerDeposit ?? "0",
    fee_recipient: "relayer.test.near",
    relay_fee: relayFee,
    refund_precommitment: String(testField(`${name}/refund`)),
    deadline_ms: DEADLINE,
    salt: salt(tag),
  };
  const note = notes[n];
  const input = vaultWithdrawInput({
    stateTree: new VaultTree(state),
    labelTree: new VaultTree(labels),
    newestStateRoot: new VaultTree(state).root,
    newestLabelRoot: new VaultTree(labels).root,
    note: { value: note.value, label: note.label, nullifier: note.nullifier, secret: note.secret },
    newNullifier: testField(`${name}/change/nullifier`),
    newSecret: testField(`${name}/change/secret`),
    withdrawn,
    withdrawal,
    vaultId: VAULT,
    scope,
    nowMs: 1_700_000_000_000,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk("withdraw.wasm"), zk("withdraw.zkey"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  const p = { a: proof.pi_a.slice(0, 2), b: proof.pi_b.slice(0, 2), c: proof.pi_c.slice(0, 2) };
  console.error(`${name}: note ${n + 1}, withdrawn ${withdrawn}, nullifier hash ${publicSignals[1].slice(0, 12)}...`);
  return { name, note: n, withdrawal, proof: p, public_signals: publicSignals };
}

const spends = [
  await spend("same_call", 0, 2_000_000n, "same_call", notes.length, "500000"),
  await spend("same_nullifier_a", 1, 1_000_000n, "same_nullifier_a"),
  await spend("same_nullifier_b", 1, 2_500_000n, "same_nullifier_b"),
  await spend("one_block_a", 2, 4_000_000n, "one_block_a"),
  await spend("one_block_b", 2, 6_000_000n, "one_block_b"),
  // against the roots of the first 4 deposits, while the vault has had 6
  await spend("old_root", 3, 3_000_000n, "old_root", 4),
  // relayed to an account the token has never seen, with its registration (VT-S04): USDC's 0.00125 NEAR
  await spend("new_account", 4, 7_000_000n, "new_account", notes.length, "100000", {
    recipient: "newcomer.test.near",
    registerDeposit: "1250000000000000000000",
  }),
  // a registration of 1 yocto, below the token's minimum: part 0 [storage_deposit, ft_transfer] fails whole
  await spend("short_registration", 5, 4_000_000n, "short_registration", notes.length, "0", {
    recipient: "fresh.test.near",
    registerDeposit: "1",
  }),
];
for (const s of spends.slice(1)) if (s.public_signals[1] === spends[0].public_signals[1]) throw new Error("note 1's nullifier repeats");
if (spends[1].public_signals[1] !== spends[2].public_signals[1]) throw new Error("same_nullifier: two nullifier hashes");
if (spends[3].public_signals[1] !== spends[4].public_signals[1]) throw new Error("one_block: two nullifier hashes");

const out = {
  notes: [
    "Real withdraw proofs for the vault's spend tests (VT-S05, VT-S06, withdraw.rs rows 4-12). Test notes only, never money.",
    "Made by contracts/vault/tests/fixtures/make-withdraw-spends.mjs: the kit's vaultWithdrawInput, then snarkjs 0.7.5 groth16.fullProve with packages/kit/zk/withdraw.wasm and withdraw.zkey; snarkjs groth16.verify passes each.",
    "leaves and labels: six deposits on vault.test.near with the mainnet TOKEN, in order (precommitments: what each deposit's message names); deposited is their sum. other_vault: the newest roots of the same six notes on other-vault.test.near.",
    "proof: snarkjs's pi_a, pi_b, pi_c without the projective last element. public_signals in snarkjs order: [newCommitmentHash, existingNullifierHash, withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context].",
  ],
  vault: VAULT,
  asset: ASSET,
  scope: String(scope),
  leaves: notes.map((x) => String(x.commitment)),
  labels: notes.map((x) => String(x.label)),
  // Poseidon(nullifier, secret) of each note: the precommitment its deposit message names (tests/payouts.rs deposits
  // the six through ft_on_transfer, which makes the same leaves and labels)
  precommitments: notes.map((x) => String(poseidon2([x.nullifier, x.secret]))),
  values: VALUES.map(String),
  deposited: String(VALUES.reduce((a, b) => a + b, 0n)),
  other_vault: {
    vault: OTHER_VAULT,
    state_root: String(new VaultTree(other.map((x) => x.commitment)).root),
    label_root: String(new VaultTree(other.map((x) => x.label)).root),
  },
  spends,
};
writeFileSync(join(here, "withdraw-spends.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote withdraw-spends.json");
process.exit(0);
