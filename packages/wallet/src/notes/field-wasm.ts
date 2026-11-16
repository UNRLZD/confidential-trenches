// BN254's scalar field in WebAssembly for the restore's lane walk (card firefox-restore-fast). The walk derives three
// Poseidon hashes an index, 80,000 indices a pool (8 lanes of RESTORE_GAP), and on BigInt that is the whole restore's
// wait: Firefox's BigInt runs it about 4 to 5 times slower than Chrome's (merge queue run 43663711503: about 20 s a
// pool on 4 cores, so a restore of four pools ended at 90-93 s), while a 254-bit product in 32-bit limbs on 64-bit
// integers runs at the same speed in every engine.
// - The module is written here, byte by byte, as a 32 KB array would be harder to read than the code that makes it:
//   mul (Montgomery's, R = 2^261, on 9 limbs of 29 bits with the carries put off: each step adds its two products to
//   64-bit sums and carries only the low sum, so nine steps of products under 2^58 stay under 2^63 and the limbs are
//   carried once at the end; no subtraction, see mulBody), add (with one conditional subtraction of 2p) and pow5 (three
//   products, two of them squares, sosBody). Every value it holds is under 2p and in Montgomery form; a value goes in
//   through write (reduced mod p, then times R^2) and out through read (times 1, so divided by R, then reduced mod p).
// - Card first-sign-in-fast-from-any-region: the page's pool walks go one at a time (src/pool-restore.ts turn), each
//   all hashing, so on a device of few cores Robinhood's balance came two walks after Solana's: on GitHub's 4-vCPU
//   runner 8.1 and 16.1 s (release 163's live run 43807865869), on the box held to 2 CPUs 5.4 and 10.7 s. Then a
//   product was 8 limbs of 32 bits carried at every step (CIOS) and reduced below p, 42 ns in node on arm64 and 44 on
//   the box's x86, and every field step a call from script. Now a product is 27 and 35 ns, a square (sosBody) and each
//   row of the hash's matrices (one reduction for up to 4 products, dot) cost less, and an index is one call (program,
//   below): an index 106 to 50 us on arm64, 117 to 69 us on the box held to 2 CPUs (node 24).
// - It imports nothing and exports its memory and three functions (mul, add, pow5): no call reaches out of it.
// - A program (FieldWasm.program, card first-sign-in-fast-from-any-region): a fixed list of mul, add, pow5, sqr, dot
//   and copy on slots, compiled into a second module that imports this one's memory alone and exports one function,
//   `run`, which makes the list's calls inside WebAssembly. The walk's index is one such list (./poseidon-walk.ts), so
//   an index is 3 calls from script into WebAssembly (its index written, the list, its answer read) where it was 3,092.
// - It is compiled where the page's CSP lets a script compile WebAssembly ('wasm-unsafe-eval': SIGN_HOST's page and
//   its /walk-worker.js, public/_headers). Where it cannot be, fieldWasm() answers null and the walk hashes on BigInt
//   as before (./poseidon-walk.ts): slower, never different.
// - Its answers are held equal to poseidon-lite's (test/poseidon-walk.test.ts), and fieldWasm() checks one known
//   product before it answers, so a broken module is never used. The walk checks every hit and its last index again
//   with poseidon-lite (./restore.ts checkedWalk), so a drift stops the restore instead of losing a note.

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LIMBS = 9;
const BITS = 29;
const MASK = (1n << BigInt(BITS)) - 1n;
/** Bytes one field element takes in the module's memory: a 32-bit word a limb. */
export const FIELD_BYTES = 4 * LIMBS;
/** Montgomery's R. */
const R = 1n << BigInt(BITS * LIMBS);

const limbsOf = (x: bigint): bigint[] => Array.from({ length: LIMBS }, (_, j) => (x >> BigInt(BITS * j)) & MASK);
// -p^-1 mod 2^29 (Montgomery's n0')
const n0Inv = (): bigint => {
  const m = 1n << BigInt(BITS);
  let inv = 1n;
  // Newton's iteration doubles the bits each step: 5 steps reach 32
  for (let k = 0; k < 5; k++) inv = (((inv * (2n - ((P & MASK) * inv))) % m) + m) % m;
  return (m - inv) % m;
};

// the bytes: LEB128 and the few opcodes the three functions use
const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};
const sleb = (v: bigint): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) return (out.push(b), out);
    out.push(b | 0x80);
  }
};
const OP = { get: 0x20, set: 0x21, call: 0x10, select: 0x1b, i32const: 0x41, i64const: 0x42, load32u: 0x35, store32: 0x3e, add: 0x7c, sub: 0x7d, mul: 0x7e, and: 0x83, shrU: 0x88, wrap: 0xa7, end: 0x0b } as const;

/** One function body's code, built op by op. */
class Code {
  readonly b: number[] = [];
  get(i: number): this {
    return (this.b.push(OP.get, ...uleb(i)), this);
  }
  set(i: number): this {
    return (this.b.push(OP.set, ...uleb(i)), this);
  }
  c64(v: bigint): this {
    return (this.b.push(OP.i64const, ...sleb(v)), this);
  }
  c32(v: number): this {
    return (this.b.push(OP.i32const, ...sleb(BigInt(v))), this);
  }
  op(o: number): this {
    return (this.b.push(o), this);
  }
  /** i64.load32_u at the i32 local `ptr` plus `off` bytes */
  load(ptr: number, off: number): this {
    return (this.get(ptr).b.push(OP.load32u, 2, ...uleb(off)), this);
  }
  /** i64.store32 of the value on the stack, after the address was pushed first */
  store(off: number): this {
    return (this.b.push(OP.store32, 2, ...uleb(off)), this);
  }
  call(f: number): this {
    return (this.b.push(OP.call, ...uleb(f)), this);
  }
}

// the locals of mul and add: params r, a, b (i32 0-2), then i64 locals
const A = (j: number): number => 3 + j; // a's limbs
const T = (j: number): number => 3 + LIMBS + j; // the sums t0..t8
const C = 3 + 2 * LIMBS; // a carry
const M = C + 1;
const BI = C + 2;
const X = C + 3;
const D = (j: number): number => C + 4 + j; // t - p's limbs
const BR = C + 4 + LIMBS; // a borrow
const I64_LOCALS = BR - 2;

/** t0..t8 (29-bit limbs, `top` the carry past them) minus p, kept when t >= p, stored at r. */
function reduceStore(c: Code, n: bigint[], top: number): void {
  c.c64(0n).set(BR);
  for (let j = 0; j < LIMBS; j++) {
    c.get(T(j)).c64(n[j]!).op(OP.sub).get(BR).op(OP.sub).set(X);
    c.get(X).c64(MASK).op(OP.and).set(D(j));
    c.get(X).c64(63n).op(OP.shrU).set(BR);
  }
  // X = top - borrow: negative (top bit set) when t < p, so t is kept
  c.get(top).get(BR).op(OP.sub).c64(63n).op(OP.shrU).set(X);
  for (let j = 0; j < LIMBS; j++) c.get(0).get(T(j)).get(D(j)).get(X).op(OP.wrap).op(OP.select).store(4 * j);
}

/** t0..t8 carried into 29-bit limbs, the carry past them left in C. */
function carry(c: Code): void {
  c.c64(0n).set(C);
  for (let j = 0; j < LIMBS; j++) {
    c.get(T(j)).get(C).op(OP.add).set(X);
    c.get(X).c64(MASK).op(OP.and).set(T(j));
    c.get(X).c64(BigInt(BITS)).op(OP.shrU).set(C);
  }
}

// Montgomery's product with the carries put off (see the head): each of the 9 steps adds a_j * b_i and m * p_j to t_j
// (each under 2^58, so after the 9 steps no sum passes 9 * 2^59 < 2^63), m making t0 a multiple of 2^29, then shifts
// t down a limb, carrying t0's high part into the new t0. Values are kept under 2p, never subtracted down to p: with
// a, b < 2p the product (ab + mp) / R is under (4p^2 + Rp) / R = p (1 + 4p / R) < 2p, as R = 2^261 > 2^7 p; only
// readField reduces a value to its residue.
function mulBody(): number[] {
  const n = limbsOf(P);
  const ninv = n0Inv();
  const c = new Code();
  for (let j = 0; j < LIMBS; j++) c.load(1, 4 * j).set(A(j));
  for (let j = 0; j < LIMBS; j++) c.c64(0n).set(T(j));
  for (let i = 0; i < LIMBS; i++) {
    c.load(2, 4 * i).set(BI);
    for (let j = 0; j < LIMBS; j++) c.get(T(j)).get(A(j)).get(BI).op(OP.mul).op(OP.add).set(T(j));
    // m = t0 * n0' mod 2^29 (the product wraps mod 2^64, which keeps its low bits)
    c.get(T(0)).c64(ninv).op(OP.mul).c64(MASK).op(OP.and).set(M);
    for (let j = 0; j < LIMBS; j++) c.get(T(j)).get(M).c64(n[j]!).op(OP.mul).op(OP.add).set(T(j));
    // t0 is now a multiple of 2^29: t = t / 2^29, a limb down
    c.get(T(1)).get(T(0)).c64(BigInt(BITS)).op(OP.shrU).op(OP.add).set(T(0));
    for (let j = 1; j < LIMBS - 1; j++) c.get(T(j + 1)).set(T(j));
    c.c64(0n).set(T(LIMBS - 1));
  }
  carry(c);
  for (let j = 0; j < LIMBS; j++) c.get(0).get(T(j)).store(4 * j);
  return c.b;
}

// a + b, both under 2p: under 4p, so one subtraction of 2p brings it under 2p
function addBody(): number[] {
  const n = limbsOf(2n * P);
  const c = new Code();
  for (let j = 0; j < LIMBS; j++) c.load(1, 4 * j).load(2, 4 * j).op(OP.add).set(T(j));
  carry(c);
  reduceStore(c, n, C);
  return c.b;
}

/** The scratch slot pow5 uses (the first FIELD_BYTES), and the module's other fixed slots. */
const SCRATCH = 0;
const R2_AT = FIELD_BYTES;
const ONE_AT = 2 * FIELD_BYTES;
const OUT_AT = 3 * FIELD_BYTES;
const DOT_AT = 4 * FIELD_BYTES;
const FIRST_FREE = 5 * FIELD_BYTES;

function pow5Body(): number[] {
  const c = new Code();
  // x^2 to SCRATCH, x^4 (sqr), then x^4 * x to r (r may be a: a is read as mul's b, a limb at a time, before r is
  // written)
  c.c32(SCRATCH).get(1).call(FN.sqr);
  c.c32(SCRATCH).c32(SCRATCH).call(FN.sqr);
  c.get(0).c32(SCRATCH).get(1).call(FN.mul);
  return c.b;
}

/** The functions' indices, the same in both modules (the field's has the first four). */
const FN = { mul: 0, add: 1, pow5: 2, sqr: 3, copy: 4, dot2: 5, dot3: 6, dot4: 7 } as const;
/** The most products one dot takes: its sums stay under 2^64 and its answer under 2p (sosBody). */
export const DOT_MAX = 4;

/**
 * sqr(r, a) and dot(r, a1, b1, .., ak, bk), k = 2 to DOT_MAX: a^2, and a1 b1 + .. + ak bk with one reduction, as
 * Montgomery's separated form: the 17 columns of the products first (a square's cross products once, doubled), then
 * the reduction a limb at a time, each limb's m times p added and its high part carried to the next. With limbs under
 * 2^29 and values under 2p, a column holds at most 9 k products and 9 of m p, each under 2^58, plus a carry under 2^35:
 * under 45 * 2^58 < 2^64 for k = 4. The answer, (sum + m p) / R, is under (4 k p^2 + R p) / R = p (1 + 4 k p / R) < 2p
 * for k <= 4, as R > 2^7 p. All inputs are read before r is written, so r may be any of them.
 */
function sosBody(np: number, k: number | "sqr"): number[] {
  const n = limbsOf(P);
  const ninv = n0Inv();
  const T = (col: number): number => np + col; // the columns, 0..17
  const A = (j: number): number => np + 2 * LIMBS + j;
  const M = np + 3 * LIMBS;
  const X = M + 1;
  const C = M + 2;
  const c = new Code();
  for (let col = 0; col < 2 * LIMBS; col++) c.c64(0n).set(T(col));
  if (k === "sqr") {
    for (let j = 0; j < LIMBS; j++) c.load(1, 4 * j).set(A(j));
    for (let i = 0; i < LIMBS; i++) for (let j = i + 1; j < LIMBS; j++) c.get(T(i + j)).get(A(i)).get(A(j)).op(OP.mul).op(OP.add).set(T(i + j));
    for (let col = 1; col < 2 * LIMBS - 2; col++) c.get(T(col)).get(T(col)).op(OP.add).set(T(col));
    for (let i = 0; i < LIMBS; i++) c.get(T(2 * i)).get(A(i)).get(A(i)).op(OP.mul).op(OP.add).set(T(2 * i));
  } else {
    for (let q = 0; q < k; q++) {
      for (let j = 0; j < LIMBS; j++) c.load(1 + 2 * q, 4 * j).set(A(j));
      for (let i = 0; i < LIMBS; i++) {
        c.load(2 + 2 * q, 4 * i).set(X);
        for (let j = 0; j < LIMBS; j++) c.get(T(i + j)).get(A(j)).get(X).op(OP.mul).op(OP.add).set(T(i + j));
      }
    }
  }
  for (let i = 0; i < LIMBS; i++) {
    // m = t_i * n0' mod 2^29; t += m p 2^(29 i); t_i is then a multiple of 2^29, its high part carried up
    c.get(T(i)).c64(ninv).op(OP.mul).c64(MASK).op(OP.and).set(M);
    for (let j = 0; j < LIMBS; j++) c.get(T(i + j)).get(M).c64(n[j]!).op(OP.mul).op(OP.add).set(T(i + j));
    c.get(T(i + 1)).get(T(i)).c64(BigInt(BITS)).op(OP.shrU).op(OP.add).set(T(i + 1));
  }
  // the answer is t's high half, carried into 29-bit limbs
  c.c64(0n).set(C);
  for (let j = 0; j < LIMBS; j++) {
    c.get(T(LIMBS + j)).get(C).op(OP.add).set(X);
    c.get(0).get(X).c64(MASK).op(OP.and).store(4 * j);
    c.get(X).c64(BigInt(BITS)).op(OP.shrU).set(C);
  }
  return c.b;
}
const SOS_LOCALS = 3 * LIMBS + 3;

const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const name = (s: string): number[] => [...uleb(s.length), ...Array.from(s, (ch) => ch.charCodeAt(0))];
const PAGES = 2;

/** copy(to, from): a slot's words, as they are. */
function copyBody(): number[] {
  const c = new Code();
  for (let j = 0; j < LIMBS; j++) c.get(0).load(1, 4 * j).store(4 * j);
  return c.b;
}

/** One step of a program (FieldWasm.program): its function and its slots (a dot: its answer's, then each pair's). */
export type FieldOp = readonly ["mul" | "add", number, number, number] | readonly ["pow5" | "sqr" | "copy", number, number] | readonly ["dot", number, ...number[]];
const I32 = 0x7f;
const I64 = 0x7e;
const params = (n: number): number[] => [0x60, ...vec(Array.from({ length: n }, () => [I32])), 0];
// (r, a, b), (r, a), (), then dot2, dot3 and dot4's (r and k pairs)
const TYPES = [params(3), params(2), [0x60, 0, 0], params(5), params(7), params(9)];
const i64s = (n: number): number[][] => [[...uleb(n), I64]];
/** The four functions both modules hold, in FN's order: mul, add, pow5, sqr. */
const FIELD_CODE = (): number[] => [...fnBody(i64s(I64_LOCALS), mulBody()), ...fnBody(i64s(I64_LOCALS), addBody()), ...fnBody([], pow5Body()), ...fnBody(i64s(SOS_LOCALS), sosBody(2, "sqr"))];
const fnBody = (locals: number[][], code: number[]): number[] => {
  const b = [...vec(locals), ...code, OP.end];
  return [...uleb(b.length), ...b];
};
const HEAD = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** The module's bytes. */
export function fieldWasmBytes(): Uint8Array {
  const types = vec(TYPES.slice(0, 2));
  const funcs = vec([[0], [0], [1], [1]]);
  const memory = vec([[0x00, ...uleb(PAGES)]]);
  const exports = vec([
    [...name("mem"), 0x02, 0],
    [...name("mul"), 0x00, 0],
    [...name("add"), 0x00, 1],
    [...name("pow5"), 0x00, 2],
  ]);
  const code = [...uleb(4), ...FIELD_CODE()];
  return new Uint8Array([...HEAD, ...section(1, types), ...section(3, funcs), ...section(5, memory), ...section(7, exports), ...section(10, code)]);
}

/** A program's module (FieldWasm.program): it imports the field's memory as env.mem and nothing else, and exports
 *  `run`, which makes `ops`' calls in order. Its own mul, add, pow5 and sqr are the field module's bodies; copy moves a
 *  slot's words; dot2 to dot4 are sosBody's. A slot outside the memory, or a step of no known function, is refused. */
export function fieldProgramBytes(ops: readonly FieldOp[]): Uint8Array {
  const run = new Code();
  for (const op of ops) {
    const args = op.slice(1) as number[];
    const pairs = (args.length - 1) / 2;
    const fn = op[0] === "mul" || op[0] === "add" ? (args.length === 3 ? FN[op[0]] : undefined) : op[0] === "pow5" || op[0] === "sqr" || op[0] === "copy" ? (args.length === 2 ? FN[op[0]] : undefined) : op[0] === "dot" && Number.isInteger(pairs) && pairs >= 2 && pairs <= DOT_MAX ? FN.dot2 + pairs - 2 : undefined;
    if (fn === undefined || !args.every((x) => Number.isInteger(x) && x >= 0 && x % 4 === 0 && x + FIELD_BYTES <= PAGES * 65_536)) throw new Error("field program: a step of no known function or slot");
    for (const x of args) run.c32(x);
    run.call(fn);
  }
  const types = vec(TYPES);
  const imports = vec([[...name("env"), ...name("mem"), 0x02, 0x00, ...uleb(PAGES)]]);
  const funcs = vec([[0], [0], [1], [1], [1], [3], [4], [5], [2]]);
  const exports = vec([[...name("run"), 0x00, 8]]);
  const dots = [2, 3, 4].flatMap((k) => fnBody(i64s(SOS_LOCALS), sosBody(2 * k + 1, k)));
  const code = [...uleb(9), ...FIELD_CODE(), ...fnBody([], copyBody()), ...dots, ...fnBody([], run.b)];
  return new Uint8Array([...HEAD, ...section(1, types), ...section(2, imports), ...section(3, funcs), ...section(7, exports), ...section(10, code)]);
}

/** The field as the walk uses it: slots in the module's memory, each a field element in Montgomery form. */
export type FieldWasm = {
  /** a new slot's address (bytes), zero */
  slot(): number;
  /** x mod p into `at` */
  write(at: number, x: bigint): void;
  /** a small whole number (below 2^32) into `at` */
  writeSmall(at: number, n: number): void;
  /** the value at `at`, reduced, as a bigint */
  read(at: number): bigint;
  copy(to: number, from: number): void;
  /** the slot's words as they are (Montgomery form), to load back later */
  save(at: number): Uint32Array;
  load(at: number, words: Uint32Array): void;
  mul(r: number, a: number, b: number): void;
  add(r: number, a: number, b: number): void;
  pow5(r: number, a: number): void;
  /** r = a1 b1 + .. + ak bk, `pairs` [a1, b1, .., ak, bk] (k at most DOT_MAX), r none of them */
  dot(r: number, pairs: readonly number[]): void;
  /** `ops` compiled once (fieldProgramBytes, on this memory): each call of the answer makes them all, in order */
  program(ops: readonly FieldOp[]): () => void;
};

let field: FieldWasm | null | undefined;

/** The module compiled and checked once a thread, or null where WebAssembly is missing or refused (a CSP without
 *  'wasm-unsafe-eval'), or where its check fails: the walk then hashes on BigInt. */
export function fieldWasm(): FieldWasm | null {
  if (field !== undefined) return field;
  field = null;
  try {
    const W = (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly;
    if (!W) return null;
    const inst = new W.Instance(new W.Module(fieldWasmBytes() as BufferSource), {});
    const ex = inst.exports as { mem: WebAssembly.Memory; mul: (r: number, a: number, b: number) => void; add: (r: number, a: number, b: number) => void; pow5: (r: number, a: number) => void };
    const mem = new Uint32Array(ex.mem.buffer);
    const cap = ex.mem.buffer.byteLength;
    let next = FIRST_FREE;
    const raw = (at: number, x: bigint): void => {
      const l = limbsOf(x);
      for (let j = 0; j < LIMBS; j++) mem[at / 4 + j] = Number(l[j]!);
    };
    raw(R2_AT, (R * R) % P);
    raw(ONE_AT, 1n);
    const f: FieldWasm = {
      slot() {
        if (next + FIELD_BYTES > cap) throw new Error("field-wasm: out of slots");
        const at = next;
        next += FIELD_BYTES;
        return at;
      },
      write(at, x) {
        raw(at, ((x % P) + P) % P);
        ex.mul(at, at, R2_AT);
      },
      writeSmall(at, n) {
        mem.fill(0, at / 4, at / 4 + LIMBS);
        mem[at / 4] = (n >>> 0) & Number(MASK);
        mem[at / 4 + 1] = (n >>> 0) >>> BITS;
        ex.mul(at, at, R2_AT);
      },
      read(at) {
        ex.mul(OUT_AT, at, ONE_AT);
        let v = 0n;
        for (let j = LIMBS - 1; j >= 0; j--) v = (v << BigInt(BITS)) | BigInt(mem[OUT_AT / 4 + j]!);
        // under 2p in the module (mulBody): its residue
        return v % P;
      },
      copy(to, from) {
        mem.copyWithin(to / 4, from / 4, from / 4 + LIMBS);
      },
      save(at) {
        return mem.slice(at / 4, at / 4 + LIMBS);
      },
      load(at, words) {
        mem.set(words, at / 4);
      },
      mul: ex.mul,
      add: ex.add,
      pow5: ex.pow5,
      dot(r, pairs) {
        if (pairs.length < 2 || pairs.length % 2 !== 0 || pairs.length > 2 * DOT_MAX || pairs.includes(r)) throw new Error("field-wasm: a dot of 1 to 4 pairs, its answer none of them");
        ex.mul(r, pairs[0]!, pairs[1]!);
        for (let j = 2; j < pairs.length; j += 2) {
          ex.mul(DOT_AT, pairs[j]!, pairs[j + 1]!);
          ex.add(r, r, DOT_AT);
        }
      },
      program(ops) {
        const p = new W.Instance(new W.Module(fieldProgramBytes(ops) as BufferSource), { env: { mem: ex.mem } });
        return (p.exports as { run: () => void }).run;
      },
    };
    // one known answer before any use: (p-1)^5 = -1, and (p-1) + 2 = 1
    const a = f.slot();
    const b = f.slot();
    f.write(a, P - 1n);
    f.pow5(b, a);
    if (f.read(b) !== P - 1n) return null;
    f.writeSmall(b, 2);
    f.add(b, a, b);
    if (f.read(b) !== 1n) return null;
    field = f;
  } catch {
    field = null;
  }
  return field;
}
