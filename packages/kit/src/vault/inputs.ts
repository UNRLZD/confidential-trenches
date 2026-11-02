// A withdrawal's proof inputs, built on the device from the leaves it holds (card vault-input-builder; the vault paper
// V2.6, docs/plan1/vault.md l.1198, withdraw part). The proof is Privacy Pools v1.3.0's Withdraw(32)
// (packages/circuits/circuits/withdraw.circom:17-43 at c312dcd), run by the pinned withdraw.wasm (../zk/setup-files.ts).
//
// - The trees: the vault's state tree (every commitment) and label tree (every deposit's and refund note's label) are
//   LeanIMTs hashed with circomlib's Poseidon(2) (vault.md l.95-96). The device keeps one VaultTree for each, built
//   once with @zk-kit/lean-imt (the TS tree VT-P01 checks against the vault's Rust port, vault.md l.1126) and
//   poseidon-lite's poseidon2, and appends each new page of leaves as it reads them, so a path never rehashes the tree.
// - The roots: the kit proves against the vault's newest roots (vault.md l.145-146), which the caller reads on two
//   RPCs. A tree whose root is not that root is refused: a stale prefix of leaves would prove an old root the vault
//   still accepts and that dates the read, and a forged leaf would make a proof the vault refuses.
// - The path: LeanIMT's proof leaves out every level where the node has no sibling (that level's node equals its child),
//   and its index holds only the kept levels' left/right bits. The circuit's LeanIMTInclusionProof walks maxDepth = 32
//   levels, takes bit i of the index for level i and passes the node up unchanged where siblings[i] is 0
//   (merkleTree.circom l.58-75, the pass-up rule l.74, sha256 5754b7b0). So the kept siblings go first, in order, and 0s
//   fill the rest up to 32; the index is LeanIMT's, never the leaf's position. Any other padding or order gives another
//   root and fails at witness time.
// - The context is computed here from the withdrawal the user made (shapes.ts vaultContextOf), after every check the
//   vault would make of it (vaultWithdrawalProblems), so recipient and fee are bound to what the user typed.
// - Field rule: every value is a field element in [0, p) and is refused otherwise, never reduced (poseidon-lite reduces
//   silently). A leaf is also never 0 (vault.md l.246, 2.5.1 row 10). A repeated leaf blocks only the note it is.
// - No tree holds 2^32 leaves (a JS array's length is below 2^32), so no depth is over 32.
// Nothing here logs: the note's secrets never leave the device.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import {
  VAULT_CONSTANTS,
  VAULT_FIELD_P,
  vaultContextInput,
  vaultContextOf,
  vaultWithdrawalProblems,
  type VaultWithdrawal,
} from "./shapes.ts";

const DEPTH = VAULT_CONSTANTS.MAX_TREE_DEPTH;
const U128 = 1n << 128n;

/** A path as the circuit reads it: the root it proves, the tree's depth, LeanIMT's index and 32 siblings. */
export type VaultMerklePath = { root: bigint; depth: number; index: number; siblings: bigint[] };

function field(x: bigint, what: string): bigint {
  if (typeof x !== "bigint" || x < 0n || x >= VAULT_FIELD_P) throw new Error(`${what}: not a field element in [0, p)`);
  return x;
}

const hash = (a: bigint, b: bigint): bigint => poseidon2([a, b]);

/** One of the vault's two trees on the device: built once, then grown by each page of leaves read from the vault. */
export class VaultTree {
  #tree = new LeanIMT<bigint>(hash);
  #first = new Map<bigint, number>();
  #repeated = new Set<bigint>();

  constructor(leaves: readonly bigint[] = []) {
    if (leaves.length > 0) this.append(leaves);
  }

  get size(): number {
    return this.#tree.size;
  }
  get depth(): number {
    return this.#tree.depth;
  }
  /** The root, or undefined while the tree is empty. */
  get root(): bigint | undefined {
    return this.#tree.size === 0 ? undefined : this.#tree.root;
  }

  /** Appends the vault's next leaves, in insert order. A page with a leaf not in [1, p) changes nothing. */
  append(page: readonly bigint[]): void {
    if (!Array.isArray(page) || page.length === 0) throw new Error("page: no leaves");
    for (const [i, leaf] of page.entries()) {
      field(leaf, `page[${i}]`);
      if (leaf === 0n) throw new Error(`page[${i}]: a leaf is never 0`);
    }
    const start = this.#tree.size;
    this.#tree.insertMany([...page]);
    for (const [i, leaf] of page.entries()) {
      if (this.#first.has(leaf)) this.#repeated.add(leaf);
      else this.#first.set(leaf, start + i);
    }
  }

  /** The circuit's path for `leaf`: LeanIMT's siblings then 0s up to 32, and LeanIMT's index. */
  path(leaf: bigint): VaultMerklePath {
    const at = this.#first.get(field(leaf, "leaf"));
    if (at === undefined) throw new Error("leaf: not in the tree");
    if (this.#repeated.has(leaf)) throw new Error("leaf: repeats in the tree");
    const p = this.#tree.generateProof(at);
    const siblings = [...p.siblings, ...Array<bigint>(DEPTH - p.siblings.length).fill(0n)];
    return { root: this.#tree.root, depth: this.#tree.depth, index: p.index, siblings };
  }
}

/** The root the circuit computes from a path (merkleTree.circom l.58-75), for checking a path on the device. */
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
  /** The device's state tree and label tree, holding every leaf the vault has. */
  stateTree: VaultTree;
  labelTree: VaultTree;
  /** The vault's newest state root and label root, read on two RPCs. */
  newestStateRoot: bigint;
  newestLabelRoot: bigint;
  /** The note spent: its value and label from the vault, its secrets from the 12 words. */
  note: { value: bigint; label: bigint; nullifier: bigint; secret: bigint };
  /** The change note's secrets (value = note.value - withdrawn, same label). */
  newNullifier: bigint;
  newSecret: bigint;
  withdrawn: bigint;
  /** The withdrawal the user made, the vault's account id, its scope, and the time now in ms. */
  withdrawal: VaultWithdrawal;
  vaultId: string;
  scope: bigint;
  nowMs: number;
};

/**
 * Withdraw(32)'s inputs to spend `note`, withdrawing `withdrawn` and leaving the rest as a change note under the same
 * label. Refuses what the circuit or the vault would refuse, before the device spends a proof on it: a withdrawal
 * vaultWithdrawalProblems names, a tree whose root is not the vault's newest, a note whose commitment is not in the
 * state tree or whose label is not in the label tree (or repeats there), withdrawn over the note's value, a value of
 * 2^128 or more, the change nullifier equal to the spent one, and any value not below p.
 */
export function vaultWithdrawInput(a: VaultWithdrawInputArgs): VaultWithdrawInput {
  const scope = field(a.scope, "scope");
  const { withdrawal, vaultId, nowMs, scope: _scope, ...rest } = a;
  const problems = vaultWithdrawalProblems(withdrawal, field(a.withdrawn, "withdrawn"), vaultId, nowMs);
  if (problems.length > 0) throw new Error(`withdrawal: ${problems.join("; ")}`);
  return poolWithdrawInput({ ...rest, context: vaultContextOf(keccak_256, vaultContextInput(vaultId, withdrawal), scope) });
}

/**
 * What the device knows when it spends a note in any pool on this circuit (the NEAR vault, the Solana and EVM pools):
 * the same as VaultWithdrawInputArgs, with the context the pool's own context function computed in place of the
 * vault's withdrawal, account id, scope and time. The pool checks its own request fields before it gives the context.
 */
export type PoolWithdrawInputArgs = Omit<VaultWithdrawInputArgs, "withdrawal" | "vaultId" | "scope" | "nowMs"> & { context: bigint };

/**
 * Withdraw(32)'s inputs for a spend in any pool, against the pool's newest roots, with the pool's context as the 8th
 * public signal. Refuses what vaultWithdrawInput refuses, the vault's withdrawal checks aside, and a context not below p.
 */
export function poolWithdrawInput(a: PoolWithdrawInputArgs): VaultWithdrawInput {
  const value = field(a.note.value, "note.value");
  const label = field(a.note.label, "note.label");
  const nullifier = field(a.note.nullifier, "note.nullifier");
  const secret = field(a.note.secret, "note.secret");
  const newNullifier = field(a.newNullifier, "newNullifier");
  const newSecret = field(a.newSecret, "newSecret");
  const withdrawn = field(a.withdrawn, "withdrawn");
  const context = field(a.context, "context");
  if (value >= U128) throw new Error("note.value: 2^128 or more");
  if (withdrawn > value) throw new Error("withdrawn: over the note's value");
  if (newNullifier === nullifier) throw new Error("newNullifier: equals the spent note's nullifier");

  if (a.stateTree.root !== field(a.newestStateRoot, "newestStateRoot")) throw new Error("stateTree: its root is not the vault's newest");
  if (a.labelTree.root !== field(a.newestLabelRoot, "newestLabelRoot")) throw new Error("labelTree: its root is not the vault's newest");
  // commitment.circom:24-36: commitment = Poseidon(value, label, Poseidon(nullifier, secret))
  const commitment = poseidon3([value, label, poseidon2([nullifier, secret])]);
  const s = pathOf(a.stateTree, commitment, "the note's commitment");
  const l = pathOf(a.labelTree, label, "the note's label");

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

function pathOf(t: VaultTree, leaf: bigint, what: string): VaultMerklePath {
  try {
    return t.path(leaf);
  } catch (e) {
    throw new Error(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
