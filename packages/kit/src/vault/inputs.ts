// A withdrawal's proof inputs, built on the device from the leaves it holds (card vault-input-builder; the vault paper
// V2.6, docs/plan1/vault.md l.1198, withdraw part). The proof is Privacy Pools v1.3.0's Withdraw(32)
// (packages/circuits/circuits/withdraw.circom:17-43 at c312dcd), run by the pinned withdraw.wasm (../zk/setup-files.ts).
//
// - The trees: the vault's state tree (every commitment) and label tree (every deposit's and refund note's label) are
//   LeanIMTs hashed with circomlib's Poseidon(2) (vault.md l.95-96). Here they are rebuilt with @zk-kit/lean-imt, the TS
//   tree VT-P01 checks against the vault's Rust port (vault.md l.1126), and poseidon-lite's poseidon2.
// - The path: LeanIMT's proof leaves out every level where the node has no sibling (that level's node equals its child),
//   and its index holds only the kept levels' left/right bits. The circuit's LeanIMTInclusionProof
//   (merkleTree.circom:56-73) walks maxDepth = 32 levels, takes bit i of the index for level i and passes the node up
//   unchanged where siblings[i] is 0. So the kept siblings go first, in order, and 0s fill the rest up to 32; the index
//   is LeanIMT's, never the leaf's position. Any other padding or order gives another root and fails at witness time.
// - Field rule: every value is a field element in [0, p) and is refused otherwise, never reduced (poseidon-lite reduces
//   silently). Leaves are the vault's: below p, not 0 and never repeated (vault.md l.246, 2.5.1 row 10).
// Nothing here logs: the note's secrets never leave the device.
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2, poseidon3 } from "poseidon-lite";
import { VAULT_CONSTANTS, VAULT_FIELD_P } from "./shapes.ts";

const DEPTH = VAULT_CONSTANTS.MAX_TREE_DEPTH;
const U128 = 1n << 128n;

/** A path as the circuit reads it: the root it proves, the tree's depth, LeanIMT's index and 32 siblings. */
export type VaultMerklePath = { root: bigint; depth: number; index: number; siblings: bigint[] };

/** Withdraw(32)'s `signal input`s, every value a decimal string, as snarkjs reads them. */
export type VaultWithdrawInput = {
  withdrawnValue: string;
  stateRoot: string;
  stateTreeDepth: string;
  ASPRoot: string;
  ASPTreeDepth: string;
  context: string;
  label: string;
  existingValue: string;
  existingNullifier: string;
  existingSecret: string;
  newNullifier: string;
  newSecret: string;
  stateSiblings: string[];
  stateIndex: string;
  ASPSiblings: string[];
  ASPIndex: string;
};

/** What the device knows when it spends a note. */
export type VaultWithdrawInputArgs = {
  /** Every leaf of the vault's state tree, in insert order. */
  stateLeaves: readonly bigint[];
  /** Every leaf of the vault's label tree, in insert order. */
  labelLeaves: readonly bigint[];
  /** The note spent: its value and label from the vault, its secrets from the 12 words. */
  note: { value: bigint; label: bigint; nullifier: bigint; secret: bigint };
  /** The change note's secrets (value = note.value - withdrawn, same label). */
  newNullifier: bigint;
  newSecret: bigint;
  withdrawn: bigint;
  /** The withdrawal's context (shapes.ts vaultContextOf). */
  context: bigint;
};

function field(x: bigint, what: string): bigint {
  if (typeof x !== "bigint" || x < 0n || x >= VAULT_FIELD_P) throw new Error(`${what}: not a field element in [0, p)`);
  return x;
}

const hash = (a: bigint, b: bigint): bigint => poseidon2([a, b]);

/** A tree of the vault's leaves: each below p, not 0, never repeated, and at most 2^32 of them. */
function tree(leaves: readonly bigint[], what: string): LeanIMT<bigint> {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error(`${what}: no leaves`);
  if (leaves.length > 2 ** DEPTH) throw new Error(`${what}: more than 2^${DEPTH} leaves`);
  const seen = new Set<bigint>();
  for (const [i, leaf] of leaves.entries()) {
    field(leaf, `${what}[${i}]`);
    if (leaf === 0n) throw new Error(`${what}[${i}]: a leaf is never 0`);
    if (seen.has(leaf)) throw new Error(`${what}[${i}]: a leaf repeats`);
    seen.add(leaf);
  }
  return new LeanIMT(hash, [...leaves]);
}

function pathOf(t: LeanIMT<bigint>, leaf: bigint, what: string): VaultMerklePath {
  const at = t.indexOf(leaf);
  if (at < 0) throw new Error(`${what}: the leaf is not in the tree`);
  if (t.depth > DEPTH) throw new Error(`${what}: depth ${t.depth} over ${DEPTH}`);
  const p = t.generateProof(at);
  if (p.siblings.length > DEPTH) throw new Error(`${what}: more than ${DEPTH} siblings`);
  const siblings = [...p.siblings, ...Array<bigint>(DEPTH - p.siblings.length).fill(0n)];
  return { root: t.root, depth: t.depth, index: p.index, siblings };
}

/** The circuit's path for `leaf` in the tree of `leaves` (LeanIMT, Poseidon(2)), siblings padded with 0 to depth 32. */
export function vaultMerklePath(leaves: readonly bigint[], leaf: bigint): VaultMerklePath {
  return pathOf(tree(leaves, "leaves"), field(leaf, "leaf"), "leaf");
}

/** The root the circuit computes from a path (merkleTree.circom:56-73), for checking a path on the device. */
export function vaultRootOfPath(leaf: bigint, index: number, siblings: readonly bigint[]): bigint {
  if (siblings.length !== DEPTH) throw new Error(`siblings: not ${DEPTH} of them`);
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** DEPTH) throw new Error("index: not below 2^32");
  let node = field(leaf, "leaf");
  for (let i = 0; i < DEPTH; i++) {
    const s = field(siblings[i]!, `siblings[${i}]`);
    if (s === 0n) continue;
    node = Math.floor(index / 2 ** i) % 2 === 1 ? hash(s, node) : hash(node, s);
  }
  return node;
}

/**
 * Withdraw(32)'s inputs to spend `note`, withdrawing `withdrawn` and leaving the rest as a change note under the same
 * label. Refuses what the circuit or the vault would refuse, before the device spends a proof on it: a note whose
 * commitment is not in the state tree or whose label is not in the label tree, withdrawn 0 or over the note's value,
 * a value or withdrawn of 2^128 or more, the change nullifier equal to the spent one, and any value not below p.
 */
export function vaultWithdrawInput(a: VaultWithdrawInputArgs): VaultWithdrawInput {
  const value = field(a.note.value, "note.value");
  const label = field(a.note.label, "note.label");
  const nullifier = field(a.note.nullifier, "note.nullifier");
  const secret = field(a.note.secret, "note.secret");
  const newNullifier = field(a.newNullifier, "newNullifier");
  const newSecret = field(a.newSecret, "newSecret");
  const withdrawn = field(a.withdrawn, "withdrawn");
  const context = field(a.context, "context");
  if (value >= U128) throw new Error("note.value: 2^128 or more");
  if (withdrawn === 0n) throw new Error("withdrawn: 0");
  if (withdrawn > value) throw new Error("withdrawn: over the note's value");
  if (newNullifier === nullifier) throw new Error("newNullifier: equals the spent note's nullifier");

  // commitment.circom:24-36: commitment = Poseidon(value, label, Poseidon(nullifier, secret))
  const commitment = poseidon3([value, label, poseidon2([nullifier, secret])]);
  const s = pathOf(tree(a.stateLeaves, "stateLeaves"), commitment, "the note's commitment");
  const l = pathOf(tree(a.labelLeaves, "labelLeaves"), label, "the note's label");

  return {
    withdrawnValue: String(withdrawn),
    stateRoot: String(s.root),
    stateTreeDepth: String(s.depth),
    ASPRoot: String(l.root),
    ASPTreeDepth: String(l.depth),
    context: String(context),
    label: String(label),
    existingValue: String(value),
    existingNullifier: String(nullifier),
    existingSecret: String(secret),
    newNullifier: String(newNullifier),
    newSecret: String(newSecret),
    stateSiblings: s.siblings.map(String),
    stateIndex: String(s.index),
    ASPSiblings: l.siblings.map(String),
    ASPIndex: String(l.index),
  };
}
