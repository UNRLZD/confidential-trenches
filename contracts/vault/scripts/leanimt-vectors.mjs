// SPDX-License-Identifier: Apache-2.0
// VT-P01's reference side (vault.md l.1126): seeded random insert sequences, up to 100,000 leaves, through
// @zk-kit/lean-imt 2.2.4 (the TS LeanIMT the kit pins) and the kit's own VaultTree (packages/kit/src/vault/inputs.ts),
// both hashed with poseidon-lite's poseidon2. After every insert the two roots must be equal and the depth must be
// ceil(log2 size); every leaf's path, as the kit builds it for the circuit, must give the root by the circuit's rule
// (vaultRootOfPath, merkleTree.circom l.58-75): for the final tree of each sequence, and at every size up to 64 for the
// shorter ones. The fixture it writes holds, per sequence, a Poseidon chain over the root after every insert
// (chain = poseidon2(chain, root), from 0), the roots at sizes 2^k and 2^k + 1 and the final root and depth.
// tests/tree_prop.rs runs the same sequences through the vault's Rust tree over side nodes in memory, and src/tree.rs's
// unit tests run seed 6 (depth 13) through the on-chain store (Tree over near-sdk's LookupMap); both must reach every
// value. The fixture's `boundary` holds roots no sequence reaches: the last leaf of a full depth-32 tree and the growth
// from 2^31 leaves to depth 32, each from a stated set of side nodes, computed here only by the circuit's rule
// (vaultRootOfPath) from the paths LeanIMT gives those leaves, so every level up to 32 is checked.
//
// Leaves: splitmix64 (Steele, Lea, Flood 2014; the constants of Vigna's splitmix64.c) seeded with the sequence's seed;
// each leaf is four draws as big-endian u64 limbs, the first masked to 62 bits, redrawn while 0 or not below p.
//
//   node contracts/vault/scripts/leanimt-vectors.mjs                  writes tests/fixtures/leanimt-vectors.json
//   node contracts/vault/scripts/leanimt-vectors.mjs --check          recomputes all of it; exit 1 at the first value
//                                                                     that differs from the file
//   node contracts/vault/scripts/leanimt-vectors.mjs --check --fast   CI's run (leanimt-vectors.test.mjs): the
//     boundary roots, seeds 2-9 in full and seed 1's first 5,000 leaves against its checkpoints up to 5,000, without
//     the final trees' path checks
//   --fixture <file> checks that file instead (the test's planted copies)
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

class Mismatch extends Error {}

/** Throws a Mismatch naming `what` unless `got` equals `want`. */
function same(got, want, what) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Mismatch(`${what}: ${JSON.stringify(got)} where the file has ${JSON.stringify(want)}`);
}

/**
 * One sequence. With `want` (check mode), each checkpoint is compared the moment it is reached, so a wrong value fails
 * at once; `count` below want.count (fast mode) stops early, after which only the checkpoints reached are compared.
 */
function run(seed, count, { want, paths = true } = {}) {
  const next = splitmix64(seed);
  const lean = new LeanIMT(hash);
  const vt = new VaultTree();
  const leaves = [];
  const checkpoints = {};
  const full = want ? want.count : count;
  let chain = 0n;
  for (let size = 1; size <= count; size++) {
    const leaf = nextLeaf(next);
    leaves.push(leaf);
    lean.insert(leaf);
    vt.append([leaf]);
    if (lean.root !== vt.root || lean.size !== size || vt.size !== size) throw new Error(`seed ${seed} size ${size}: roots differ`);
    if (lean.depth !== ceilLog2(size) || vt.depth !== lean.depth) throw new Error(`seed ${seed} size ${size}: depth`);
    chain = hash(chain, lean.root);
    if ((size & (size - 1)) === 0 || ((size - 1) & (size - 2)) === 0 || size === full) {
      checkpoints[size] = lean.root.toString();
      if (want) same(checkpoints[size], want.checkpoints[size], `seed ${seed}: the root at size ${size}`);
    }
    if (size <= 64 && full < 100_000) checkPaths(vt, leaves, `seed ${seed} size ${size}`);
  }
  if (paths) checkPaths(vt, leaves, `seed ${seed} final`);
  if (want) same(leaves[0].toString(), want.first_leaf, `seed ${seed}: first leaf`);
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

/** The circuit's 32 siblings from LeanIMT's kept ones: those first, then 0s. */
const pad = (kept) => [...kept, ...Array(32 - kept.length).fill(0n)];
const decs = (xs) => xs.map((x) => x.toString());

/**
 * Roots past any sequence's depth, by the circuit's rule alone. `side` is the store's side nodes 0..31 before the
 * insert (side 32 starts empty); the tree code must give each root from them.
 * - last_leaf: a full tree but one leaf, size 2^32 - 1 at depth 32; the last leaf's index has all 32 bits set, so the
 *   insert hashes at every level, left sibling side[l], and LeanIMT's path keeps all 32 siblings.
 * - growth: a full tree of 2^31 leaves (depth 31, root r = side[31]); the next four leaves go into the right half of a
 *   depth-32 tree. Their LeanIMT paths: leaf 2 keeps [r] (index 1); leaf 3 keeps [2, r] (index 0b11); leaf 4 has no
 *   sibling at level 0 and keeps [H(2,3), r] (index 0b11); leaf 5 keeps [4, H(2,3), r] (index 0b111).
 */
function boundary() {
  const lastSide = Array.from({ length: 32 }, (_, l) => BigInt(l + 100));
  const r = 777n;
  const growSide = [...Array.from({ length: 31 }, (_, l) => BigInt(l + 500)), r];
  const h23 = hash(2n, 3n);
  return {
    last_leaf: {
      size: 2 ** 32 - 1,
      depth: 32,
      side: decs(lastSide),
      leaf: "1",
      root: vaultRootOfPath(1n, 2 ** 32 - 1, pad(lastSide)).toString(),
    },
    growth: {
      size: 2 ** 31,
      depth: 31,
      side: decs(growSide),
      leaves: ["2", "3", "4", "5"],
      roots: decs([
        vaultRootOfPath(2n, 1, pad([r])),
        vaultRootOfPath(3n, 0b11, pad([2n, r])),
        vaultRootOfPath(4n, 0b11, pad([h23, r])),
        vaultRootOfPath(5n, 0b111, pad([4n, h23, r])),
      ]),
    },
  };
}

// The sequences: seed 1 with 100,000 leaves (every size from 1 to 100,000 is checked through the chain), and eight
// more seeds whose counts are drawn below 5,000 by splitmix64 seeded with 20261101.
const counts = splitmix64(20261101);
const plan = [[1, 100_000]];
for (let seed = 2; seed <= 9; seed++) plan.push([seed, 1 + Number(counts() % 5_000n)]);
const FAST_SEED1 = 5_000;

const args = process.argv.slice(2);
const at = args.indexOf("--fixture");
const fixture = at >= 0 ? args[at + 1] : FIXTURE;
const about =
  "VT-P01 vectors (vault.md l.1126): made by contracts/vault/scripts/leanimt-vectors.mjs with @zk-kit/lean-imt and the kit's VaultTree; checked by contracts/vault/tests/tree_prop.rs and src/tree.rs";
const label = (ss) => ss.map((s) => `seed ${s.seed}: ${s.count}`).join(", ");

if (args.includes("--check")) {
  const fast = args.includes("--fast");
  const t0 = Date.now();
  try {
    const file = JSON.parse(readFileSync(fixture, "utf8"));
    same([file.about, file.lean_imt, file.hash], [about, leanVersion, "poseidon-lite 0.3.0 poseidon2"], "header");
    same(boundary(), file.boundary, "boundary");
    same(file.sequences.map((s) => [s.seed, s.count]), plan, "the sequences' seeds and counts");
    const done = plan.map(([seed, count], i) => {
      const want = file.sequences[i];
      if (fast && count > FAST_SEED1) {
        run(seed, FAST_SEED1, { want, paths: false });
        return { seed, count: FAST_SEED1 };
      }
      same(run(seed, count, { want, paths: !fast }), want, `seed ${seed}`);
      return { seed, count };
    });
    console.log(`leanimt-vectors: equal${fast ? " (fast)" : ""}: boundary, ${label(done)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    if (!(e instanceof Mismatch)) throw e;
    console.error(`leanimt-vectors: the fixture differs from a fresh run: ${e.message}`);
    process.exit(1);
  }
} else {
  const sequences = plan.map(([seed, count]) => run(seed, count));
  const out = { about, lean_imt: leanVersion, hash: "poseidon-lite 0.3.0 poseidon2", boundary: boundary(), sequences };
  writeFileSync(fixture, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`leanimt-vectors: wrote boundary, ${label(sequences)}`);
}
