// SPDX-License-Identifier: Apache-2.0
// Writes fixtures/release-spends.json: real withdraw proofs made for the Solana pool's context, for the LiteSVM tests
// (svm-tests/tests/release.rs). Test notes only (every secret is keccak256("pool-sol-core/<tag>") mod p), never money.
//
// Six test deposits into the pool of PROGRAM (a fixed test program id); the state tree holds their commitments and
// the label tree their labels, in deposit order, as the program computes them on chain (label from the pool's scope and
// the nonce, commitment = Poseidon(value, label, precommitment)). Each proof binds the pool's context: this program,
// the pool account, W, the fee payer, the relay-fee cap, the tip cap, the deadline and a salt (program/src/context.rs).
// The test keys W, W2 and FEE_PAYER are ed25519 keys from the seeds sha256("pool-sol-core/test-key/<name>"); the
// tests derive the same seeds. Proofs: snarkjs 0.7.5 groth16.fullProve with the pinned packages/kit/zk/withdraw.wasm and
// withdraw.zkey (the NEAR vault's), each checked with groth16.verify against withdraw.vkey.
//
// Run from the repo root after `pnpm install`: node contracts/pool-solana/fixtures/make-release-spends.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const kit = join(root, "packages/kit");
const req = createRequire(join(kit, "package.json"));
const imp = (m) => import(pathToFileURL(req.resolve(m)).href);
const { keccak_256 } = await imp("@noble/hashes/sha3.js");
const { sha256 } = await imp("@noble/hashes/sha2.js");
const { ed25519 } = await imp("@noble/curves/ed25519.js");
const { base58 } = await imp("@scure/base");
const { poseidon2, poseidon3 } = await imp("poseidon-lite");
const snarkjs = await imp("snarkjs");
const { VaultTree } = await import(pathToFileURL(join(kit, "src/vault/inputs.ts")).href);

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const be32 = (x) => {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
const le = (x, n) => {
  const b = new Uint8Array(n);
  for (let i = 0, v = BigInt(x); i < n; i++, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
// every mark's last byte (src/state.rs MARK_TAG)
const MARK_TAG = Uint8Array.of(1);
const fieldOf = (...parts) => BigInt("0x" + hex(keccak_256(cat(...parts)))) % P;
const testField = (tag) => fieldOf(enc("pool-sol-core/" + tag));

// Solana's find_program_address: sha256(seeds ‖ bump ‖ program ‖ "ProgramDerivedAddress"), the first bump from 255
// down whose hash is not an ed25519 point.
function pda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(cat(...seeds, Uint8Array.of(bump), program, enc("ProgramDerivedAddress")));
    try {
      ed25519.Point.fromBytes(h);
    } catch {
      return { address: h, bump };
    }
  }
  throw new Error("no bump");
}

const PROGRAM = sha256(enc("pool-sol-core/test-program"));
const OTHER_PROGRAM = sha256(enc("pool-sol-core/other-program"));
const NATIVE_MINT = base58.decode("So11111111111111111111111111111111111111112");
const SCOPE_TAG = "blindfill-pool-solana-v1";
const key = (name) => ed25519.getPublicKey(sha256(enc("pool-sol-core/test-key/" + name)));
const W = key("W");
const W2 = key("W2");
const FEE_PAYER = key("FEE_PAYER");
// 2100-01-01T00:00:00Z in ms (the cluster Clock's unix_timestamp * 1000); the tests set the clock around it
const DEADLINE_MS = 4_102_444_800_000n;
const RELAY_FEE_CAP = 2_500_000n;
const TIP_CAP = 1_000_000n;
const VALUES = [20_000_000n, 50_000_000n, 100_000_000n, 30_000_000n, 70_000_000n, 40_000_000n];

function poolOf(program) {
  const pool = pda([enc("pool")], program);
  const scope = fieldOf(le(SCOPE_TAG.length, 4), enc(SCOPE_TAG), program, pool.address, NATIVE_MINT);
  const notes = VALUES.map((value, i) => {
    const label = fieldOf(be32(scope), be32(BigInt(i + 1)));
    const nullifier = testField(`${hex(program).slice(0, 8)}/note${i + 1}/nullifier`);
    const secret = testField(`${hex(program).slice(0, 8)}/note${i + 1}/secret`);
    const precommitment = poseidon2([nullifier, secret]);
    return { value, label, nullifier, secret, precommitment, commitment: poseidon3([value, label, precommitment]) };
  });
  return { program, pool, scope, notes };
}

const main = poolOf(PROGRAM);
const other = poolOf(OTHER_PROGRAM);
const zk = (f) => join(kit, "zk", f);
const vkey = JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8"));

function contextOf(p, recipient, feePayer, salt) {
  return fieldOf(p.program, p.pool.address, recipient, feePayer, le(RELAY_FEE_CAP, 8), le(TIP_CAP, 8), le(DEADLINE_MS, 8), salt, be32(p.scope));
}

/** A proof spending note `n` of pool `p` for `withdrawn`, against the trees of `stateLeaves` and the first `labels`;
 * `number` is the release's number when the tests land it (the count of releases before it in that pool, M376). */
async function spend(name, p, n, withdrawn, stateLeaves, labels, number, recipient = W) {
  const note = p.notes[n];
  const salt = keccak_256(enc("pool-sol-core/salt/" + name)).slice(0, 16);
  const context = contextOf(p, recipient, FEE_PAYER, salt);
  const st = new VaultTree(stateLeaves);
  const lt = new VaultTree(p.notes.slice(0, labels).map((x) => x.label));
  const sp = st.path(note.commitment);
  const lp = lt.path(note.label);
  const newNullifier = testField(`${name}/change/nullifier`);
  const newSecret = testField(`${name}/change/secret`);
  const input = {
    withdrawnValue: String(withdrawn),
    stateRoot: String(sp.root),
    stateTreeDepth: String(sp.depth),
    ASPRoot: String(lp.root),
    ASPTreeDepth: String(lp.depth),
    context: String(context),
    label: String(note.label),
    existingValue: String(note.value),
    existingNullifier: String(note.nullifier),
    existingSecret: String(note.secret),
    newNullifier: String(newNullifier),
    newSecret: String(newSecret),
    stateSiblings: sp.siblings.map(String),
    stateIndex: String(sp.index),
    ASPSiblings: lp.siblings.map(String),
    ASPIndex: String(lp.index),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk("withdraw.wasm"), zk("withdraw.zkey"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  const change = poseidon3([note.value - withdrawn, note.label, poseidon2([newNullifier, newSecret])]);
  if (publicSignals[0] !== String(change)) throw new Error(`${name}: the change commitment is not the circuit's`);
  if (publicSignals[7] !== String(context)) throw new Error(`${name}: the context is not the circuit's`);
  // A, B (imaginary part first), C: 32 bytes big-endian each, the program's order
  const b = (d) => hex(be32(BigInt(d)));
  const proofHex =
    b(proof.pi_a[0]) + b(proof.pi_a[1]) +
    b(proof.pi_b[0][1]) + b(proof.pi_b[0][0]) + b(proof.pi_b[1][1]) + b(proof.pi_b[1][0]) +
    b(proof.pi_c[0]) + b(proof.pi_c[1]);
  console.error(`${name}: note ${n + 1}, withdrawn ${withdrawn}, state root index ${stateLeaves.length - 1}`);
  return {
    name,
    note: n,
    proof: proofHex,
    new_commitment: b(publicSignals[0]),
    nullifier_hash: b(publicSignals[1]),
    withdrawn: String(withdrawn),
    // the spent mark's 13 bytes after this release (M355 (3), M376): withdrawnValue u64 LE ‖ the release's number u32 LE ‖ the tag 1
    spent_mark: hex(cat(le(withdrawn, 8), le(number, 4), MARK_TAG)),
    state_root_index: stateLeaves.length - 1,
    state_depth: sp.depth,
    label_root_index: labels - 1,
    label_depth: lp.depth,
    salt: hex(salt),
    public_signals: publicSignals,
  };
}

const six = main.notes.map((x) => x.commitment);
const release = await spend("release", main, 0, 15_000_000n, six, 6, 0);
// against the roots of the first 4 deposits, while the pool has had 6 deposits and one change note
const oldRoot = await spend("old_root", main, 3, 30_000_000n, six.slice(0, 4), 4, 1);
// a second proof of note 1's nullifier, with another amount
const sameNullifier = await spend("same_nullifier", main, 0, 10_000_000n, six, 6, 0);
// a proof made against the other pool's trees: its roots are roots this pool never had
const otherPool = await spend("other_pool", other, 1, 10_000_000n, other.notes.map((x) => x.commitment), 6, 0);
// note 3, the third release to land after "release" and "old_root" (M376: release numbers 0, 1, 2)
const third = await spend("third", main, 2, 25_000_000n, six, 6, 2);

const out = {
  notes: [
    "Real withdraw proofs for the Solana pool's LiteSVM tests (svm-tests/tests/release.rs). Test notes only, never money.",
    "Made by contracts/pool-solana/fixtures/make-release-spends.mjs: snarkjs 0.7.5 groth16.fullProve with packages/kit/zk/withdraw.wasm and withdraw.zkey; snarkjs groth16.verify passes each.",
    "Addresses are hex. W, W2 and FEE_PAYER are the public keys of the seeds sha256(\"pool-sol-core/test-key/<name>\"). proof: A, B (Fq2 imaginary first), C, 32 bytes big-endian each. Field elements 32 bytes big-endian hex; public_signals in snarkjs order, decimal.",
  ],
  program: hex(PROGRAM),
  pool: hex(main.pool.address),
  pool_bump: main.pool.bump,
  other_program: hex(OTHER_PROGRAM),
  w: hex(W),
  w2: hex(W2),
  fee_payer: hex(FEE_PAYER),
  scope: hex(be32(main.scope)),
  relay_fee_cap: String(RELAY_FEE_CAP),
  tip_cap: String(TIP_CAP),
  deadline_ms: String(DEADLINE_MS),
  deposits: main.notes.map((x, i) => ({
    value: String(x.value),
    precommitment: hex(be32(x.precommitment)),
    label: hex(be32(x.label)),
    commitment: hex(be32(x.commitment)),
    // the precommitment mark's 17 bytes after this deposit (M353): value u64 LE ‖ nonce u64 LE ‖ the tag 1
    mark: hex(cat(le(x.value, 8), le(BigInt(i + 1), 8), MARK_TAG)),
  })),
  // the state tree's root after each deposit, and the label tree's
  state_roots: six.map((_, i) => hex(be32(new VaultTree(six.slice(0, i + 1)).root))),
  label_roots: main.notes.map((_, i) => hex(be32(new VaultTree(main.notes.slice(0, i + 1).map((x) => x.label)).root))),
  other_pool: { pool: hex(other.pool.address), deposits: other.notes.map((x) => ({ value: String(x.value), precommitment: hex(be32(x.precommitment)) })) },
  spends: [release, oldRoot, sameNullifier, otherPool, third],
};
writeFileSync(join(here, "release-spends.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote release-spends.json");
process.exit(0);
