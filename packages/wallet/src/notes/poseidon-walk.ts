// poseidon2 and poseidon3 for the restore's lane walk (card firefox-e2e-restore-ends-on-ci): the same permutation as
// poseidon-lite's (circomlib's parameters over BN254: 8 full rounds, 57 and 56 partial rounds), with its partial rounds
// in the standard sparse form (the Poseidon paper, eprint 2019/458, appendix B; circomlib's poseidon_opt). A partial
// round puts only the first word through x^5, so:
// - its other words' round constants are carried forward through the MDS matrix into the next round's, and only the
//   first word's constant stays in the round;
// - the other words are kept in the basis u = Mh^-r v (Mh: the MDS matrix without its first row and column), where one
//   round costs one row and one column of products instead of the whole t x t matrix; v = Mh^nP u once at the end.
// Every value is reduced mod p, so the output equals poseidon-lite's for every input (test/poseidon-walk.test.ts: the
// constants equal the package's files, and the hashes equal its poseidon2 and poseidon3 on random and edge inputs).
// The walk (./restore.ts walkSteps) is the only user, and every index it finds and its last one are checked again with
// poseidon-lite (noteSecrets), so a drift between the two stops the restore instead of losing a note.
import { C2, C3, M2, M3 } from "./poseidon-constants.ts";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FULL_HALF = 4;

const big = (s: string): bigint => {
  const b = atob(s);
  let h = "";
  for (let i = 0; i < b.length; i++) h += b.charCodeAt(i).toString(16).padStart(2, "0");
  return BigInt(`0x${h}`);
};
// x^5 reduced at each product: three reductions of products under p^2 cost less than one of a 1270-bit product, and
// BigInt's own % less than a Barrett reduction (read in Firefox and Chromium on x86 and node on arm64)
const pow5 = (v: bigint): bigint => {
  const v2 = (v * v) % P;
  return (((v2 * v2) % P) * v) % P;
};
function inverse(a: bigint): bigint {
  let r = 1n;
  let b = a % P;
  for (let e = P - 2n; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}
/** A square matrix's inverse mod p (Gauss-Jordan); throws on a singular one. */
function matInverse(a: readonly (readonly bigint[])[]): bigint[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1n : 0n))]);
  for (let c = 0; c < n; c++) {
    const p = m.findIndex((row, i) => i >= c && row[c]! % P !== 0n);
    if (p < 0) throw new Error("poseidon-walk: a singular matrix");
    [m[c], m[p]] = [m[p]!, m[c]!];
    const iv = inverse(m[c]![c]!);
    m[c] = m[c]!.map((x) => (x * iv) % P);
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const f = m[i]![c]!;
      if (f === 0n) continue;
      m[i] = m[i]!.map((x, j) => (((x - f * m[c]![j]!) % P) + P) % P);
    }
  }
  return m.map((row) => row.slice(n));
}
const mulMatVec = (m: readonly (readonly bigint[])[], v: readonly bigint[]): bigint[] => m.map((row) => row.reduce((a, x, j) => a + x * v[j]!, 0n) % P);
const mulVecMat = (v: readonly bigint[], m: readonly (readonly bigint[])[]): bigint[] => m[0]!.map((_, j) => v.reduce((a, x, i) => a + x * m[i]![j]!, 0n) % P);
const mulMat = (a: readonly (readonly bigint[])[], b: readonly (readonly bigint[])[]): bigint[][] => a.map((row) => mulVecMat(row, b));

type Sparse = { t: number; nP: number; C: bigint[]; M: bigint[][]; k: bigint[]; m00: bigint; w: bigint[][]; z: bigint[][]; end: bigint[][]; after: bigint[] };

function sparse(cs: readonly string[], ms: readonly (readonly string[])[], nP: number): Sparse {
  const C = cs.map(big);
  const M = ms.map((r) => r.map(big));
  const t = M.length;
  if (C.length !== (2 * FULL_HALF + nP) * t) throw new Error("poseidon-walk: the constants do not fit t and the rounds");
  // the partial rounds' constants: the first word's kept, the rest carried forward through M
  const k: bigint[] = [];
  let carry = new Array<bigint>(t).fill(0n);
  for (let r = 0; r < nP; r++) {
    const at = (FULL_HALF + r) * t;
    const c = C.slice(at, at + t).map((x, j) => (x + carry[j]!) % P);
    k.push(c[0]!);
    carry = mulMatVec(M, [0n, ...c.slice(1)]);
  }
  const at = (FULL_HALF + nP) * t;
  const after = C.slice(at, at + t).map((x, j) => (x + carry[j]!) % P);
  const mh = M.slice(1).map((r) => r.slice(1));
  const mhInv = matInverse(mh);
  const m0 = M[0]!.slice(1);
  const mcol = M.slice(1).map((r) => r[0]!);
  // w[r] = m0 Mh^r, z[r] = Mh^-(r+1) mcol, end = Mh^nP
  const w: bigint[][] = [m0];
  const z: bigint[][] = [mulMatVec(mhInv, mcol)];
  let end = mh.map((r) => [...r]);
  for (let r = 1; r < nP; r++) {
    w.push(mulVecMat(w[r - 1]!, mh));
    z.push(mulMatVec(mhInv, z[r - 1]!));
    end = mulMat(end, mh);
  }
  return { t, nP, C, M, k, m00: M[0]![0]!, w, z, end, after };
}

// one full round in place: every word's constant and x^5, then M (plain loops: the walk runs this 8 times a hash)
function full(s: bigint[], o: Sparse, at: number, constants: readonly bigint[] | null): void {
  const t = o.t;
  for (let y = 0; y < t; y++) s[y] = pow5(s[y]! + (constants ? constants[y]! : o.C[at + y]!));
  const x = s.slice();
  for (let i = 0; i < t; i++) {
    const row = o.M[i]!;
    let acc = 0n;
    for (let j = 0; j < t; j++) acc += row[j]! * x[j]!;
    s[i] = acc % P;
  }
}

function hash(o: Sparse, inputs: readonly bigint[]): bigint {
  const s = [0n, ...inputs];
  for (let x = 0; x < FULL_HALF; x++) full(s, o, x * o.t, null);
  let a = s[0]!;
  const u = s.slice(1);
  const n = u.length;
  for (let r = 0; r < o.nP; r++) {
    a = pow5(a + o.k[r]!);
    const w = o.w[r]!;
    const z = o.z[r]!;
    let na = o.m00 * a;
    for (let j = 0; j < n; j++) na += w[j]! * u[j]!;
    // u is reduced once, after the partial rounds: each round adds one product below p^2 to it, so it stays under
    // p^2 * nP (about 2^515), and the products with w are reduced in na
    for (let j = 0; j < n; j++) u[j] = u[j]! + a * z[j]!;
    a = na % P;
  }
  const v = mulMatVec(o.end, u.map((x) => x % P));
  s[0] = a;
  for (let j = 0; j < n; j++) s[j + 1] = v[j]!;
  full(s, o, 0, o.after);
  for (let x = FULL_HALF + o.nP + 1; x < 2 * FULL_HALF + o.nP; x++) full(s, o, x * o.t, null);
  return s[0]!;
}

let two: Sparse | null = null;
let three: Sparse | null = null;
/** poseidon-lite's poseidon2, in the sparse form. */
export function poseidon2Walk(inputs: readonly [bigint, bigint]): bigint {
  return hash((two ??= sparse(C2, M2, 57)), inputs);
}
/** poseidon-lite's poseidon3, in the sparse form. */
export function poseidon3Walk(inputs: readonly [bigint, bigint, bigint]): bigint {
  return hash((three ??= sparse(C3, M3, 56)), inputs);
}
