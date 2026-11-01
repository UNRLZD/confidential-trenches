// SPDX-License-Identifier: Apache-2.0
// VT-P01's reference side (vault.md l.1126): seeded random insert sequences, up to 100,000 leaves, through
// @zk-kit/lean-imt 2.2.4 (the TS LeanIMT the kit pins) and the kit's own VaultTree (packages/kit/src/vault/inputs.ts),
// both hashed with poseidon-lite's poseidon2. After every insert the two roots must be equal and the depth must be
// ceil(log2 size); every leaf's path, as the kit builds it for the circuit, must give the root by the circuit's rule
// (vaultRootOfPath, merkleTree.circom l.58-75): for the final tree of each sequence, and at every size up to 64 for the
// shorter ones. The fixture it writes holds, per sequence, a Poseidon chain over the root after every insert
// (chain = poseidon2(chain, root), from 0), the roots at sizes 2^k and 2^k + 1 and the final root and depth.
// tests/tree_prop.rs runs the same sequences through the vault's Rust tree and must reach every one of them.
//
// Leaves: splitmix64 (Steele, Lea, Flood 2014; the constants of Vigna's splitmix64.c) seeded with the sequence's seed;
// each leaf is four draws as big-endian u64 limbs, the first masked to 62 bits, redrawn while 0 or not below p.
//
//   node contracts/vault/scripts/leanimt-vectors.mjs           writes tests/fixtures/leanimt-vectors.json
//   node contracts/vault/scripts/leanimt-vectors.mjs --check   recomputes and exits 1 unless equal to that file
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../../", import.meta.url);
const FIXTURE = new URL("../tests/fixtures/leanimt-vectors.json", import.meta.url);
const kit = createRequire(new URL("packages/kit/package.json", ROOT));
const { LeanIMT } = await import(pathToFileURL(kit.resolve("@zk-kit/lean-imt")).href);
const { poseidon2 } = await import(pathToFileURL(kit.resolve("poseidon-lite")).href);
const { VaultTree, vaultRootOfPath } = await import(new URL("packages/kit/src/vault/inputs.ts", ROOT).href);
// the package's own package.json, which its exports do not serve: the folder of its resolved entry, up to the name
const leanEntry = kit.resolve("@zk-kit/lean-imt");
const leanDir = leanEntry.slice(0, leanEntry.lastIndexOf("/@zk-kit/lean-imt/") + "/@zk-kit/lean-imt/".length);
const leanVersion = JSON.parse(readFileSync(`${leanDir}package.json`, "utf8")).version;

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const M64 = (1n << 64n) - 1n;
const hash = (a, b) => poseidon2([a, b]);

/** splitmix64: each call the next 64-bit output. */
export function splitmix64(seed) {
  let s = BigInt(seed) & M64;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & M64;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return z ^ (z >> 31n);
  };
}

/** The next leaf: four draws, most significant first, the first masked to 62 bits; redrawn while 0 or >= p. */
export function nextLeaf(next) {
  for (;;) {
    const a = next() & ((1n << 62n) - 1n);
    const b = next();
    const c = next();
    const d = next();
    const v = (a << 192n) | (b << 128n) | (c << 64n) | d;
    if (v !== 0n && v < P) return v;
  }
}

const ceilLog2 = (n) => (n <= 1 ? 0 : (n - 1).toString(2).length);

function checkPaths(vt, leaves, what) {
  for (const leaf of leaves) {
    const p = vt.path(leaf);
    if (p.root !== vt.root || p.depth !== vt.depth) throw new Error(`${what}: path root or depth`);
    if (vaultRootOfPath(leaf, p.index, p.siblings) !== vt.root) throw new Error(`${what}: a path fails the circuit's rule`);
  }
}

function run(seed, count) {
  const next = splitmix64(seed);
  const lean = new LeanIMT(hash);
  const vt = new VaultTree();
  const leaves = [];
  const checkpoints = {};
  let chain = 0n;
  for (let size = 1; size <= count; size++) {
    const leaf = nextLeaf(next);
    leaves.push(leaf);
    lean.insert(leaf);
    vt.append([leaf]);
    if (lean.root !== vt.root || lean.size !== size || vt.size !== size) throw new Error(`seed ${seed} size ${size}: roots differ`);
    if (lean.depth !== ceilLog2(size) || vt.depth !== lean.depth) throw new Error(`seed ${seed} size ${size}: depth`);
    chain = hash(chain, lean.root);
    if ((size & (size - 1)) === 0 || ((size - 1) & (size - 2)) === 0 || size === count) {
      checkpoints[size] = lean.root.toString();
    }
    if (size <= 64 && count < 100_000) checkPaths(vt, leaves, `seed ${seed} size ${size}`);
  }
  checkPaths(vt, leaves, `seed ${seed} final`);
  return {
    seed,
    count,
    first_leaf: leaves[0].toString(),
    final_root: lean.root.toString(),
    final_depth: lean.depth,
    chain: chain.toString(),
    checkpoints,
  };
}

// The sequences: seed 1 with 100,000 leaves (every size from 1 to 100,000 is checked through the chain), and eight
// more seeds whose counts are drawn below 5,000 by splitmix64 seeded with 20261101.
const counts = splitmix64(20261101);
const plan = [[1, 100_000]];
for (let seed = 2; seed <= 9; seed++) plan.push([seed, 1 + Number(counts() % 5_000n)]);

const sequences = plan.map(([seed, count]) => run(seed, count));
const out = {
  about:
    "VT-P01 vectors (vault.md l.1126): made by contracts/vault/scripts/leanimt-vectors.mjs with @zk-kit/lean-imt and the kit's VaultTree; checked by contracts/vault/tests/tree_prop.rs",
  lean_imt: leanVersion,
  hash: "poseidon-lite 0.3.0 poseidon2",
  sequences,
};
const text = `${JSON.stringify(out, null, 1)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(FIXTURE, "utf8") !== text) {
    console.error("leanimt-vectors: the fixture differs from a fresh run");
    process.exit(1);
  }
  console.log(`leanimt-vectors: equal (${sequences.map((s) => `seed ${s.seed}: ${s.count}`).join(", ")})`);
} else {
  writeFileSync(FIXTURE, text);
  console.log(`leanimt-vectors: wrote ${sequences.map((s) => `seed ${s.seed}: ${s.count}`).join(", ")}`);
}
