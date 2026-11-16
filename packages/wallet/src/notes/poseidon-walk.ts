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
import { fieldWasm, type FieldOp, type FieldWasm } from "./field-wasm.ts";

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

let twoS: Sparse | null = null;
let threeS: Sparse | null = null;
/** poseidon-lite's poseidon2, in the sparse form. */
export function poseidon2Walk(inputs: readonly [bigint, bigint]): bigint {
  return hash((twoS ??= sparse(C2, M2, 57)), inputs);
}
/** poseidon-lite's poseidon3, in the sparse form. */
export function poseidon3Walk(inputs: readonly [bigint, bigint, bigint]): bigint {
  return hash((threeS ??= sparse(C3, M3, 56)), inputs);
}

// The same hashes on BN254's field in WebAssembly (./field-wasm.ts, card firefox-restore-fast): the sparse form above,
// round for round, each value a slot of the module's memory in Montgomery form, every sum and product kept under 2p
// and reduced to its residue only when read (FieldWasm.read). Used by the walk where the module compiles (fieldWasm),
// BigInt above where it does not.
type SparseSlots = { o: Sparse; C: number[]; M: number[][]; k: number[]; m00: number; w: number[][]; z: number[][]; end: number[][]; after: number[]; s: number[]; x: number[]; tmp: number; acc: number };

function slotsOf(f: FieldWasm, o: Sparse): SparseSlots {
  const put = (v: bigint): number => {
    const at = f.slot();
    f.write(at, v);
    return at;
  };
  const many = (vs: readonly bigint[]): number[] => vs.map(put);
  return {
    o,
    C: many(o.C),
    M: o.M.map(many),
    k: many(o.k),
    m00: put(o.m00),
    w: o.w.map(many),
    z: o.z.map(many),
    end: o.end.map(many),
    after: many(o.after),
    s: Array.from({ length: o.t }, () => f.slot()),
    x: Array.from({ length: o.t }, () => f.slot()),
    tmp: f.slot(),
    acc: f.slot(),
  };
}

// one full round on the slots, as `full` above
function fullW(f: FieldWasm, q: SparseSlots, constants: readonly number[]): void {
  const t = q.o.t;
  for (let y = 0; y < t; y++) {
    f.add(q.s[y]!, q.s[y]!, constants[y]!);
    f.pow5(q.s[y]!, q.s[y]!);
  }
  for (let y = 0; y < t; y++) f.copy(q.x[y]!, q.s[y]!);
  // each row of M times x in one reduction (FieldWasm.dot)
  for (let i = 0; i < t; i++) f.dot(q.s[i]!, q.M[i]!.flatMap((m, j) => [m, q.x[j]!]));
}

// `hash` above on the slots: the inputs are slots, the hash goes to slot `out`
function hashW(f: FieldWasm, q: SparseSlots, inputs: readonly number[], out: number): void {
  const o = q.o;
  const t = o.t;
  const n = t - 1;
  f.writeSmall(q.s[0]!, 0);
  for (let j = 0; j < n; j++) f.copy(q.s[j + 1]!, inputs[j]!);
  for (let x = 0; x < FULL_HALF; x++) fullW(f, q, q.C.slice(x * t, x * t + t));
  // a = s[0], u = s[1..]: the partial rounds
  const a = q.s[0]!;
  const na = q.acc;
  for (let r = 0; r < o.nP; r++) {
    f.add(a, a, q.k[r]!);
    f.pow5(a, a);
    const w = q.w[r]!;
    const z = q.z[r]!;
    f.dot(na, [q.m00, a, ...w.flatMap((x, j) => [x, q.s[j + 1]!])]);
    for (let j = 0; j < n; j++) {
      f.mul(q.tmp, a, z[j]!);
      f.add(q.s[j + 1]!, q.s[j + 1]!, q.tmp);
    }
    f.copy(a, na);
  }
  // v = end u
  for (let j = 0; j < n; j++) f.copy(q.x[j]!, q.s[j + 1]!);
  for (let i = 0; i < n; i++) f.dot(q.s[i + 1]!, q.end[i]!.flatMap((m, j) => [m, q.x[j]!]));
  fullW(f, q, q.after);
  for (let x = FULL_HALF + o.nP + 1; x < 2 * FULL_HALF + o.nP; x++) fullW(f, q, q.C.slice(x * t, x * t + t));
  f.copy(out, q.s[0]!);
}

// the slots the hashes take, once a thread: their constants, and the inputs and output of one hash or one index (an
// index's work is synchronous, so walks that take turns on one thread share them)
let slots: { two: SparseSlots; three: SparseSlots; ins: number[]; out: number; nh: number; sh: number } | null = null;
const slotsOnce = (f: FieldWasm): NonNullable<typeof slots> =>
  (slots ??= {
    two: slotsOf(f, (twoS ??= sparse(C2, M2, 57))),
    three: slotsOf(f, (threeS ??= sparse(C3, M3, 56))),
    ins: [f.slot(), f.slot(), f.slot()],
    out: f.slot(),
    nh: f.slot(),
    sh: f.slot(),
  });

/** The field this thread's walk hashes on: "wasm" where the module compiles and passes its check, "bigint" where it
 *  does not (card firefox-restore-holds-on-every-runner: a walk Worker says which in its answer, so a run is never
 *  blind on it). */
export type WalkHash = "wasm" | "bigint";
export const walkHash = (): WalkHash => (fieldWasm() === null ? "bigint" : "wasm");

/** poseidon2Walk and poseidon3Walk on the WebAssembly field, or null where it does not compile (tests). */
export function poseidonWasm(): { poseidon2(inputs: readonly [bigint, bigint]): bigint; poseidon3(inputs: readonly [bigint, bigint, bigint]): bigint } | null {
  const f = fieldWasm();
  if (f === null) return null;
  const q = slotsOnce(f);
  const run = (h: SparseSlots, xs: readonly bigint[]): bigint => {
    xs.forEach((x, j) => f.write(q.ins[j]!, x));
    hashW(f, h, q.ins.slice(0, xs.length), q.out);
    return f.read(q.out);
  };
  return { poseidon2: (xs) => run(q.two, xs), poseidon3: (xs) => run(q.three, xs) };
}

/** hashW's steps as a program (FieldWasm.program) rather than made: `hash` on `rec` records each one. A zero written is
 *  a copy of `zero`, a slot never written (all zero words: 0 in Montgomery form). */
function recorder(zero: number): { rec: FieldWasm; ops: FieldOp[] } {
  const ops: FieldOp[] = [];
  const no = (): never => {
    throw new Error("poseidon-walk: a step a program does not make");
  };
  const rec: FieldWasm = {
    slot: no,
    write: no,
    writeSmall: (at, n) => (n === 0 ? void ops.push(["copy", at, zero]) : no()),
    read: no,
    copy: (to, from) => void ops.push(["copy", to, from]),
    save: no,
    load: no,
    mul: (r, a, b) => void ops.push(["mul", r, a, b]),
    add: (r, a, b) => void ops.push(["add", r, a, b]),
    pow5: (r, a) => void ops.push(["pow5", r, a]),
    dot: (r, pairs) => void ops.push(pairs.length === 2 ? ["mul", r, pairs[0]!, pairs[1]!] : ["dot", r, ...pairs]),
    program: no,
  };
  return { rec, ops };
}

// the index's three hashes as one program, compiled once a thread (card first-sign-in-fast-from-any-region): from the
// slots `mn`, `ms`, `sc` and `at` (the masters, the scope, the index) to `out`; null where it does not compile, and
// the walk makes the same steps one call at a time. Card walk-program-checked-before-use: as fieldWasm checks its
// known answers, the program makes one known index (KNOWN) before its first use and is null when its answer is not
// poseidon2Walk's and poseidon3Walk's, so an engine that runs it wrong costs the walk speed, never its restore (one
// index on BigInt a thread, at its start).
const KNOWN = { nullifier: P - 1n, secret: (P - 1n) / 2n, scope: P - 2n, i: 0xffffffff } as const;
let indexRun: { run: () => void; mn: number; ms: number; sc: number; at: number } | null | undefined;
const indexRunOnce = (f: FieldWasm, q: NonNullable<typeof slots>): typeof indexRun => {
  if (indexRun !== undefined) return indexRun;
  indexRun = null;
  try {
    const [mn, sc, at] = q.ins as [number, number, number];
    const ms = f.slot();
    const { rec, ops } = recorder(f.slot());
    hashW(rec, q.three, [mn, sc, at], q.nh);
    hashW(rec, q.three, [ms, sc, at], q.sh);
    hashW(rec, q.two, [q.nh, q.sh], q.out);
    const run = f.program(ops);
    f.write(mn, KNOWN.nullifier);
    f.write(ms, KNOWN.secret);
    f.write(sc, KNOWN.scope);
    f.writeSmall(at, KNOWN.i);
    run();
    const i = BigInt(KNOWN.i);
    if (f.read(q.out) === poseidon2Walk([poseidon3Walk([KNOWN.nullifier, KNOWN.scope, i]), poseidon3Walk([KNOWN.secret, KNOWN.scope, i])])) indexRun = { run, mn, ms, sc, at };
  } catch {
    indexRun = null;
  }
  return indexRun;
};

/**
 * The walk's precommitment of deposit index i under the masters and scope: poseidon2(poseidon3(nullifier, scope, i),
 * poseidon3(secret, scope, i)), as ../derive/notes.ts derives a deposit note's. On the WebAssembly field where it
 * compiles, on BigInt otherwise; equal either way. The masters and scope are put in the module once a walk and into
 * the shared input slots each index, so walks taking turns on one thread never read each other's. On the field, an
 * index is one call into WebAssembly (indexRunOnce), its three hashes made inside it, once the program answers its
 * known index right; one call a step otherwise.
 */
export function precommitmentWalker(m: { nullifier: bigint; secret: bigint }, scope: bigint): (i: number) => bigint {
  const f = fieldWasm();
  if (f === null) return (i) => poseidon2Walk([poseidon3Walk([m.nullifier, scope, BigInt(i)]), poseidon3Walk([m.secret, scope, BigInt(i)])]);
  const q = slotsOnce(f);
  const [mn, ms, sc] = [m.nullifier, m.secret, scope].map((x) => (f.write(q.out, x), f.save(q.out))) as [Uint32Array, Uint32Array, Uint32Array];
  const p = indexRunOnce(f, q);
  if (p) {
    return (i) => {
      if (!Number.isInteger(i) || i < 0 || i > 0xffffffff) throw new Error("an index is a u32");
      f.writeSmall(p.at, i);
      f.load(p.mn, mn);
      f.load(p.ms, ms);
      f.load(p.sc, sc);
      p.run();
      return f.read(q.out);
    };
  }
  const [a, b, at] = q.ins as [number, number, number];
  return (i) => {
    if (!Number.isInteger(i) || i < 0 || i > 0xffffffff) throw new Error("an index is a u32");
    f.writeSmall(at, i);
    f.load(a, mn);
    f.load(b, sc);
    hashW(f, q.three, [a, b, at], q.nh);
    f.load(a, ms);
    hashW(f, q.three, [a, b, at], q.sh);
    hashW(f, q.two, [q.nh, q.sh], q.out);
    return f.read(q.out);
  };
}
