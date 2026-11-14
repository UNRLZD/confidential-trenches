// Card firefox-e2e-restore-ends-on-ci: the restore's lane walk hashes with src/notes/poseidon-walk.ts, poseidon-lite's
// permutation with its partial rounds in the sparse form. It must be poseidon-lite's hash exactly: the constants copied
// into src/notes/poseidon-constants.ts equal the package's own files, and poseidon2Walk and poseidon3Walk equal
// poseidon2 and poseidon3 on edge inputs and on 4,000 seeded random ones. A walk that drifts would find no note; the walk
// also checks every hit and its last index with poseidon-lite (src/notes/restore.ts checkedWalk), held below.
//   node --test test/poseidon-walk.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { C2, C3, M2, M3 } from "../src/notes/poseidon-constants.ts";
import { poseidon2Walk, poseidon3Walk } from "../src/notes/poseidon-walk.ts";
import { checkedWalk, walkLaneOf } from "../src/notes/restore.ts";
import { noteSecrets } from "../src/notes/secrets.ts";
import { masters } from "../src/derive/index.ts";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const require = createRequire(import.meta.url);
const lite = path.dirname(require.resolve("poseidon-lite/poseidon3"));

test("the copied constants are poseidon-lite's own, string for string", () => {
  const c2 = require(path.join(lite, "constants/2.js")).default as { C: string[]; M: string[][] };
  const c3 = require(path.join(lite, "constants/3.js")).default as { C: string[]; M: string[][] };
  assert.deepEqual([...C2], c2.C);
  assert.deepEqual(M2.map((r) => [...r]), c2.M);
  assert.deepEqual([...C3], c3.C);
  assert.deepEqual(M3.map((r) => [...r]), c3.M);
});

test("poseidon2Walk and poseidon3Walk equal poseidon-lite's poseidon2 and poseidon3 on edge and random inputs", () => {
  const edges = [0n, 1n, 2n, P - 1n, P, P + 1n, (1n << 254n) - 1n, (1n << 256n) - 1n, 0xffffffffn];
  for (const a of edges) for (const b of edges) {
    assert.equal(poseidon2Walk([a, b]), poseidon2([a, b]), `poseidon2(${a}, ${b})`);
    for (const c of [0n, 7n, 0xfffffff8n, P - 1n]) assert.equal(poseidon3Walk([a, b, c]), poseidon3([a, b, c]), `poseidon3(${a}, ${b}, ${c})`);
  }
  // xorshift64*, seeded: the same 4,000 inputs every run
  let x = 0x9e3779b97f4a7c15n;
  const next = (): bigint => {
    let v = 0n;
    for (let k = 0; k < 4; k++) {
      x ^= x >> 12n;
      x ^= (x << 25n) & 0xffffffffffffffffn;
      x ^= x >> 27n;
      v = (v << 64n) | ((x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn);
    }
    return v % P;
  };
  for (let i = 0; i < 4000; i++) {
    const a = next();
    const b = next();
    assert.equal(poseidon2Walk([a, b]), poseidon2([a, b]));
    assert.equal(poseidon3Walk([a, b, BigInt(i)]), poseidon3([a, b, BigInt(i)]));
  }
});

test("a lane walked with the sparse hash finds the seed's notes and passes poseidon-lite's check of its end", () => {
  // an all-zero seed64: a test value, no wallet's
  const seed64 = new Uint8Array(64);
  const scope = 12345n;
  const m = masters(seed64, "deposit");
  const lane = 3;
  const mine = new Set([3, 27, 3 + 8 * 40].map((i) => noteSecrets(seed64, { kind: "deposit", s: scope, i }).precommitment));
  const w = walkLaneOf(m, scope, lane, (p) => mine.has(p), 50);
  assert.deepEqual(w.found, [3, 27, 323]);
  assert.deepEqual(checkedWalk(w, lane, seed64, scope, 50, null), { found: [3, 27, 323], end: 323 + 8 * 50 });
});
