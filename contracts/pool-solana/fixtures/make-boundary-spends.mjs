// SPDX-License-Identifier: Apache-2.0
// Writes fixtures/boundary-spends.json: the deposits and two real withdraw proofs that carry both trees across a page
// boundary (a page holds 1,024 entries, program/src/state.rs), for the LiteSVM test
// `inserts_cross_the_page_boundary_in_both_trees` (svm-tests/tests/release.rs). Test notes only, never money.
//
// In a fresh pool of the same test program as make-release-spends.mjs:
// 1. 1,024 deposits fill page 0 of both trees (note 0 holds 0.02 SOL, the rest 0.001 SOL each).
// 2. `boundary_change` spends note 0 against the roots at index 1,023 (the last entry of page 0); its change note is
//    state leaf 1,024, the first entry of state page 1.
// 3. Deposit 1,025 (note 1,024, 0.02 SOL) is state leaf 1,025 and label leaf 1,024, the first entry of label page 1.
// 4. `boundary_roots` spends note 1,024 against state root 1,025 and label root 1,024, both read from page 1.
// Same keys, context and proof pipeline as make-release-spends.mjs (snarkjs 0.7.5, packages/kit/zk/withdraw.*).
//
// Run from the repo root after `pnpm install`: node contracts/pool-solana/fixtures/make-boundary-spends.mjs
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

function pda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(cat(...seeds, Uint8Array.of(bump), program, enc("ProgramDerivedAddress")));
    try {
      ed25519.Point.fromBytes(h);
    } catch {
      return h;
    }
  }
  throw new Error("no bump");
}

const PROGRAM = sha256(enc("pool-sol-core/test-program"));
const NATIVE_MINT = base58.decode("So11111111111111111111111111111111111111112");
const SCOPE_TAG = "blindfill-pool-solana-v1";
const W = ed25519.getPublicKey(sha256(enc("pool-sol-core/test-key/W")));
const FEE_PAYER = ed25519.getPublicKey(sha256(enc("pool-sol-core/test-key/FEE_PAYER")));
const DEADLINE_MS = 4_102_444_800_000n;
const RELAY_FEE_CAP = 2_500_000n;
const TIP_CAP = 1_000_000n;
const PAGE = 1024;

const pool = pda([enc("pool")], PROGRAM);
const scope = fieldOf(le(SCOPE_TAG.length, 4), enc(SCOPE_TAG), PROGRAM, pool, NATIVE_MINT);
const notes = Array.from({ length: PAGE + 1 }, (_, i) => {
  const value = i === 0 || i === PAGE ? 20_000_000n : 1_000_000n;
  const label = fieldOf(be32(scope), be32(BigInt(i + 1)));
  const nullifier = testField(`boundary/note${i}/nullifier`);
  const secret = testField(`boundary/note${i}/secret`);
  const precommitment = poseidon2([nullifier, secret]);
  return { value, label, nullifier, secret, precommitment, commitment: poseidon3([value, label, precommitment]) };
});

const zk = (f) => join(kit, "zk", f);
const vkey = JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8"));

/** A proof spending note `n` for `withdrawn`, against the trees of `stateLeaves` and `labelLeaves`, landing as release
 * `number` (M376); and its change. */
async function spend(name, n, withdrawn, stateLeaves, labelLeaves, number) {
  const note = notes[n];
  const salt = keccak_256(enc("pool-sol-core/salt/" + name)).slice(0, 16);
  const context = fieldOf(PROGRAM, pool, W, FEE_PAYER, le(RELAY_FEE_CAP, 8), le(TIP_CAP, 8), le(DEADLINE_MS, 8), salt, be32(scope));
  const sp = new VaultTree(stateLeaves).path(note.commitment);
  const lp = new VaultTree(labelLeaves).path(note.label);
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
  const b = (d) => hex(be32(BigInt(d)));
  const proofHex =
    b(proof.pi_a[0]) + b(proof.pi_a[1]) +
    b(proof.pi_b[0][1]) + b(proof.pi_b[0][0]) + b(proof.pi_b[1][1]) + b(proof.pi_b[1][0]) +
    b(proof.pi_c[0]) + b(proof.pi_c[1]);
  console.error(`${name}: note ${n}, state root index ${stateLeaves.length - 1}, label root index ${labelLeaves.length - 1}`);
  return {
    spend: {
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
      label_root_index: labelLeaves.length - 1,
      label_depth: lp.depth,
      salt: hex(salt),
      public_signals: publicSignals,
    },
    change,
  };
}

const firstPage = notes.slice(0, PAGE);
const state0 = firstPage.map((x) => x.commitment);
const labels0 = firstPage.map((x) => x.label);
const one = await spend("boundary_change", 0, 15_000_000n, state0, labels0, 0);
const state1 = [...state0, one.change, notes[PAGE].commitment];
const labels1 = [...labels0, notes[PAGE].label];
const two = await spend("boundary_roots", PAGE, 12_000_000n, state1, labels1, 1);
const rootOf = (leaves) => hex(be32(new VaultTree(leaves).root));

const out = {
  notes: [
    "Deposits and real withdraw proofs that carry both trees of the Solana pool across a page boundary, for svm-tests/tests/release.rs. Test notes only, never money.",
    "Made by contracts/pool-solana/fixtures/make-boundary-spends.mjs (snarkjs 0.7.5 with packages/kit/zk/withdraw.wasm and withdraw.zkey; snarkjs groth16.verify passes each). Same program, keys and context fields as release-spends.json.",
  ],
  // mark: the precommitment mark's 17 bytes after the deposit (M353), value u64 LE ‖ nonce u64 LE ‖ the tag 1
  deposits: notes.map((x, i) => ({ value: String(x.value), precommitment: hex(be32(x.precommitment)), mark: hex(cat(le(x.value, 8), le(BigInt(i + 1), 8), MARK_TAG)) })),
  // the root at each index around the boundary, from the off-chain trees
  state_roots: { 1023: rootOf(state0), 1024: rootOf(state0.concat(one.change)), 1025: rootOf(state1) },
  label_roots: { 1023: rootOf(labels0), 1024: rootOf(labels1) },
  spends: [one.spend, two.spend],
};
writeFileSync(join(here, "boundary-spends.json"), JSON.stringify(out, null, 1) + "\n");
console.error("wrote boundary-spends.json");
process.exit(0);
