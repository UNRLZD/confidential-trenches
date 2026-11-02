// SPDX-License-Identifier: Apache-2.0
// Writes test/fixtures/pool-proofs.json: real proofs for the EVM pool's Foundry tests. Test notes only (secrets are
// keccak256("pool-evm/<tag>") mod p), never money.
//
// Three test deposits on the pool the tests place at POOL on chain 31337 (Foundry's default), native ETH. The state tree
// holds their commitments and the label tree their labels, in deposit order. Withdraw proofs come from the kit's own
// trees (packages/kit/src/vault/inputs.ts, VaultTree.path) with the context the pool recomputes:
//   context = keccak256(abi.encode(Withdrawal{processooor: POOL, data: abi.encode(RelayData)}, SCOPE)) mod p
// (Privacy Pools v1.3.0 PrivacyPool.sol:48). Every proof is snarkjs 0.7.5
// groth16.fullProve with the pinned packages/kit/zk files, then checked with snarkjs groth16.verify.
//
// Run from the repo root after `pnpm install`: node contracts/pool-evm/test/fixtures/make-pool-proofs.mjs
// With `buy` it writes buy-proofs.json instead: the buy's proofs, which bind a W whose key is a published test key
// (the Hardhat mnemonic "test test ... junk", index 0), on chain 31337, Base (8453) and Robinhood (4663), and W's EIP-712 signature
// of one buy, made by Foundry's `cast wallet sign --data` (alloy's EIP-712), so the pool's digest is checked against
// an encoder that is not the pool's own.
import { execFileSync } from "node:child_process";
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
let CHAIN_ID = 31337n;
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // Constants.NATIVE_ASSET
const DEPOSITOR = "0x000000000000000000000000000000000000d0d0";
let W = "0x0000000000000000000000000000000000000a11";
// the Hardhat mnemonic's first two accounts: published test keys, never money
const MNEMONIC = "test test test test test test test test test test test junk";
const W_SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
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
let scope;
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
  const data = relayDataHex(r) + (r.trailing ?? "");
  return word(0x40n) + word(scope) + addr(POOL) + word(0x40n) + word(BigInt(data.length / 2)) + data;
}

// The pool's notes on chain `chainId`: the same secrets, its own scope, so its own labels and commitments
let notes;
function onChain(chainId) {
  CHAIN_ID = chainId;
  scope = fieldOf(POOL.slice(2) + word(CHAIN_ID) + NATIVE.slice(2));
  notes = VALUES.map((value, i) => {
  const label = labelOf(i + 1);
  const nullifier = testField(`note${i + 1}/nullifier`);
  const secret = testField(`note${i + 1}/secret`);
  const precommitment = poseidon2([nullifier, secret]);
  return { value, label, nullifier, secret, precommitment, commitment: poseidon3([value, label, precommitment]) };
  });
}
onChain(31337n);

const zk = (f) => join(kit, "zk", f);
const vkeys = { withdraw: JSON.parse(readFileSync(zk("withdraw.vkey"), "utf8")) };

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
async function spend(name, n, withdrawn, size, feeCap, trailing) {
  const state = new VaultTree(notes.slice(0, size).map((x) => x.commitment));
  const labels = new VaultTree(notes.slice(0, size).map((x) => x.label));
  const request = {
    recipient: W,
    feeRecipient: RELAYER,
    feeCap,
    deadlineMs: DEADLINE_MS,
    refundPrecommitment: testField(`${name}/refund`),
    salt: hexOf(keccak_256(new TextEncoder().encode("pool-evm/salt/" + name))).slice(0, 32),
    trailing,
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
      ...(trailing ? { trailing: "0x" + trailing } : {}),
    },
    contextPreimage: "0x" + preimage,
    context: String(context),
    proof,
  };
}

// The set of one chain's deposits, as the tests read it
const deposits = () => ({
  pool: POOL,
  chainId: String(CHAIN_ID),
  depositor: DEPOSITOR,
  scope: String(scope),
  values: VALUES.map(String),
  precommitments: notes.map((x) => String(x.precommitment)),
  labels: notes.map((x) => String(x.label)),
  commitments: notes.map((x) => String(x.commitment)),
});

if (process.argv[2] === "buy") {
  W = W_SIGNER;
  const cap = 10n ** 16n;
  const local = {
    ...deposits(),
    buy: await spend("buy", 0, 4n * 10n ** 17n, 3, cap),
    buy2: await spend("buy2", 1, 2n * 10n ** 17n, 3, cap),
    // RelayData then one more word: abi.decode reads it as RelayData, so the pool must refuse it by its length
    trailing: await spend("trailing", 0, 4n * 10n ** 17n, 3, cap, word(1n)),
  };
  // W signs one buy of `buy`'s note on this pool and chain, as the device does (eth_signTypedData_v4)
  const message = {
    adapter: "0x000000000000000000000000000000000000ada1",
    data: "0x" + hexOf(new TextEncoder().encode("route")),
    minOut: "1000",
    token: "0x0000000000000000000000000000000000070c1e",
    nullifier: local.buy.proof.pubSignals[1],
  };
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Buy: [
        { name: "adapter", type: "address" },
        { name: "data", type: "bytes" },
        { name: "minOut", type: "uint256" },
        { name: "token", type: "address" },
        { name: "nullifier", type: "uint256" },
      ],
    },
    primaryType: "Buy",
    domain: { name: "Blindfill", version: "1", chainId: Number(CHAIN_ID), verifyingContract: POOL },
    message,
  };
  const signature = execFileSync("cast", ["wallet", "sign", "--mnemonic", MNEMONIC, "--data", JSON.stringify(typed)], { encoding: "utf8" }).trim();
  local.signed = { message, signature };
  onChain(8453n);
  const base = { ...deposits(), buy: await spend("base_buy", 0, 4n * 10n ** 17n, 3, cap) };
  onChain(4663n);
  const robinhood = { ...deposits(), buy: await spend("robinhood_buy", 0, 4n * 10n ** 17n, 3, cap) };
  writeFileSync(join(here, "buy-proofs.json"), JSON.stringify({
    notes: [
      "Real proofs for contracts/pool-evm's buy tests. Test notes only, never money.",
      "Made by contracts/pool-evm/test/fixtures/make-pool-proofs.mjs buy with snarkjs 0.7.5 groth16.fullProve and packages/kit/zk; snarkjs groth16.verify passes each.",
      "W is the Hardhat mnemonic's account 0, a published test key. local: chain 31337, the same three deposits as pool-proofs.json; buy spends note 1, buy2 note 2, trailing note 1 with one word after RelayData. signed: W's EIP-712 signature (cast wallet sign --data) of one Buy of buy's nullifier on this pool and chain. base: chain 8453, the same secrets under Base's scope; buy spends note 1. robinhood: the same on chain 4663.",
    ],
    local,
    base,
    robinhood,
  }, null, 2) + "\n");
  console.error("wrote buy-proofs.json");
  process.exit(0);
}

const out = {
  notes: [
    "Real proofs for contracts/pool-evm's Foundry tests. Test notes only, never money.",
    "Made by contracts/pool-evm/test/fixtures/make-pool-proofs.mjs with snarkjs 0.7.5 groth16.fullProve and packages/kit/zk; snarkjs groth16.verify passes each.",
    "Three deposits by depositor on pool (chain 31337, native ETH), values in wei, in order. pB is in the Solidity verifier's order (each pair of snarkjs's pi_b swapped).",
    "relayed: note 1 against all three deposits, fee cap 0.01 ETH. old_root: note 2 against the first two deposits' roots. big_cap: note 1, 0.1 ETH with a fee cap of all of it (for the backstop). zero_withdrawal: note 1, withdrawnValue 0.",
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
};
writeFileSync(join(here, "pool-proofs.json"), JSON.stringify(out, null, 2) + "\n");
console.error("wrote pool-proofs.json");
process.exit(0);
