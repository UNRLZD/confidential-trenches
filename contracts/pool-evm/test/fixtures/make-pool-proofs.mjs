// SPDX-License-Identifier: Apache-2.0
// Writes test/fixtures/pool-proofs.json: real proofs for the EVM pool's Foundry tests. Test notes only (secrets are
// keccak256("pool-evm/<tag>") mod p), never money.
//
// Three test deposits on the pool the tests place at POOL on chain 31337 (Foundry's default), native ETH. The state tree
// holds their commitments and the label tree their labels, in deposit order. Withdraw proofs come from the kit's own
// trees (packages/kit/src/vault/inputs.ts, VaultTree.path) with the context the pool recomputes:
//   context = keccak256(abi.encode(Withdrawal{processooor: POOL, data: abi.encode(RelayData)}, SCOPE)) mod p
// (Privacy Pools v1.3.0 PrivacyPool.sol:48). Ragequit proofs are the commitment circuit's. Every proof is snarkjs 0.7.5
// groth16.fullProve with the pinned packages/kit/zk files, then checked with snarkjs groth16.verify.
//
// Run from the repo root after `pnpm install`: node contracts/pool-evm/test/fixtures/make-pool-proofs.mjs
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
const { VaultTree } = await import(pathToFileURL(join(kit, "src/vault/inputs.ts")).href);

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const POOL = "0x00000000000000000000000000000000b1f1f001";
const CHAIN_ID = 31337n;
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // Constants.NATIVE_ASSET
const DEPOSITOR = "0x000000000000000000000000000000000000d0d0";
const W = "0x0000000000000000000000000000000000000a11";
const RELAYER = "0x000000000000000000000000000000000000fee1";
const VALUES = [10n ** 18n, 5n * 10n ** 17n, 2n * 10n ** 18n];
// 2033-05-18T03:33:20Z in ms; the tests warp below it, then past it
const DEADLINE_MS = 2_000_000_000_000n;

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOf = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map((x) => parseInt(x, 16)));
const word = (n) => n.toString(16).padStart(64, "0");
const addr = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const fieldOf = (hex) => BigInt("0x" + hexOf(keccak_256(bytesOf(hex)))) % P;
const testField = (tag) => BigInt("0x" + hexOf(keccak_256(new TextEncoder().encode("pool-evm/" + tag)))) % P;

// SCOPE = keccak256(abi.encodePacked(address(this), block.chainid, asset)) mod p (State.sol)
const scope = fieldOf(POOL.slice(2) + word(CHAIN_ID) + NATIVE.slice(2));
// label = keccak256(abi.encodePacked(SCOPE, ++nonce)) mod p (PrivacyPool.sol deposit)
const labelOf = (nonce) => fieldOf(word(scope) + word(BigInt(nonce)));

// abi.encode(RelayData): six static words; bytes16 is left-aligned
function relayDataHex(r) {
  return addr(r.recipient) + addr(r.feeRecipient) + word(r.feeCap) + word(r.deadlineMs) + word(r.refundPrecommitment) +
    r.salt.padEnd(64, "0");
}
// abi.encode(Withdrawal{processooor, data}, SCOPE): the tuple's offset, SCOPE, then the tuple (its address, its bytes'
// offset, their length and the bytes)
function contextPreimageHex(r) {
  const data = relayDataHex(r);
  return word(0x40n) + word(scope) + addr(POOL) + word(0x40n) + word(BigInt(data.length / 2)) + data;
}

const notes = VALUES.map((value, i) => {
  const label = labelOf(i + 1);
  const nullifier = testField(`note${i + 1}/nullifier`);
  const secret = testField(`note${i + 1}/secret`);
  const precommitment = poseidon2([nullifier, secret]);
  return { value, label, nullifier, secret, precommitment, commitment: poseidon3([value, label, precommitment]) };
});

const zk = (f) => join(kit, "zk", f);
const vkeys = { withdraw: JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8")), commitment: JSON.parse(readFileSync(zk("commitment.vkey"), "utf8")) };

async function prove(circuit, name, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk(`${circuit}.wasm`), zk(`${circuit}.zkey`));
  if (!(await snarkjs.groth16.verify(vkeys[circuit], publicSignals, proof))) throw new Error(`${name}: snarkjs refuses its own proof`);
  // Solidity's pB is snarkjs's pi_b with each pair swapped (the snarkjs verifier template's calldata order)
  return {
    pA: proof.pi_a.slice(0, 2),
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    pC: proof.pi_c.slice(0, 2),
    pubSignals: publicSignals,
  };
}

/** A withdraw proof spending note `n` (0-based) for `withdrawn`, against the trees of the first `size` deposits. */
async function spend(name, n, withdrawn, size, feeCap) {
  const state = new VaultTree(notes.slice(0, size).map((x) => x.commitment));
  const labels = new VaultTree(notes.slice(0, size).map((x) => x.label));
  const request = {
    recipient: W,
    feeRecipient: RELAYER,
    feeCap,
    deadlineMs: DEADLINE_MS,
    refundPrecommitment: testField(`${name}/refund`),
    salt: hexOf(keccak_256(new TextEncoder().encode("pool-evm/salt/" + name))).slice(0, 32),
  };
  const preimage = contextPreimageHex(request);
  const context = fieldOf(preimage);
  const note = notes[n];
  const s = state.path(note.commitment);
  const l = labels.path(note.label);
  const input = {
    withdrawnValue: String(withdrawn),
    stateRoot: String(s.root),
    stateTreeDepth: String(s.depth),
    ASPRoot: String(l.root),
    ASPTreeDepth: String(l.depth),
    context: String(context),
    label: String(note.label),
    existingValue: String(note.value),
    existingNullifier: String(note.nullifier),
    existingSecret: String(note.secret),
    newNullifier: String(testField(`${name}/change/nullifier`)),
    newSecret: String(testField(`${name}/change/secret`)),
    stateSiblings: s.siblings.map(String),
    stateIndex: String(s.index),
    ASPSiblings: l.siblings.map(String),
    ASPIndex: String(l.index),
  };
  const proof = await prove("withdraw", name, input);
  if (proof.pubSignals[7] !== String(context)) throw new Error(`${name}: the proof's context is not the request's`);
  console.error(`${name}: note ${n + 1}, withdrawn ${withdrawn}, against ${size} deposits`);
  return {
    name,
    request: {
      recipient: request.recipient,
      feeRecipient: request.feeRecipient,
      feeCap: String(request.feeCap),
      deadlineMs: String(request.deadlineMs),
      refundPrecommitment: String(request.refundPrecommitment),
      salt: "0x" + request.salt,
    },
    contextPreimage: "0x" + preimage,
    context: String(context),
    proof,
  };
}

async function ragequit(name, n, other = null) {
  const note = other ?? notes[n];
  const proof = await prove("commitment", name, { value: note.value, label: note.label, nullifier: note.nullifier, secret: note.secret });
  if (proof.pubSignals[0] !== String(poseidon3([note.value, note.label, poseidon2([note.nullifier, note.secret])]))) throw new Error(`${name}: not the note's commitment`);
  console.error(`${name}: note ${n + 1}`);
  return { name, proof };
}

const out = {
  notes: [
    "Real proofs for contracts/pool-evm's Foundry tests. Test notes only, never money.",
    "Made by contracts/pool-evm/test/fixtures/make-pool-proofs.mjs with snarkjs 0.7.5 groth16.fullProve and packages/kit/zk; snarkjs groth16.verify passes each.",
    "Three deposits by depositor on pool (chain 31337, native ETH), values in wei, in order. pB is in the Solidity verifier's order (each pair of snarkjs's pi_b swapped).",
    "relayed: note 1 against all three deposits, fee cap 0.01 ETH. old_root: note 2 against the first two deposits' roots. big_cap: note 1, 0.1 ETH with a fee cap of all of it (for the backstop). zero_withdrawal: note 1, withdrawnValue 0. ragequit_note3 and ragequit_note1: the commitment proofs of notes 3 and 1. ragequit_unknown: a commitment proof under note 3's label for a note never deposited.",
  ],
  pool: POOL,
  chainId: String(CHAIN_ID),
  depositor: DEPOSITOR,
  scope: String(scope),
  values: VALUES.map(String),
  precommitments: notes.map((x) => String(x.precommitment)),
  labels: notes.map((x) => String(x.label)),
  commitments: notes.map((x) => String(x.commitment)),
  relayed: await spend("relayed", 0, 4n * 10n ** 17n, 3, 10n ** 16n),
  old_root: await spend("old_root", 1, 5n * 10n ** 17n, 2, 0n),
  big_cap: await spend("big_cap", 0, 10n ** 17n, 3, 10n ** 17n),
  zero_withdrawal: await spend("zero_withdrawal", 0, 0n, 3, 0n),
  ragequit_note3: await ragequit("ragequit_note3", 2),
  ragequit_note1: await ragequit("ragequit_note1", 0),
  ragequit_unknown: await ragequit("ragequit_unknown", 2, {
    value: VALUES[2],
    label: notes[2].label,
    nullifier: testField("unknown/nullifier"),
    secret: testField("unknown/secret"),
  }),
};
writeFileSync(join(here, "pool-proofs.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote pool-proofs.json");
process.exit(0);
