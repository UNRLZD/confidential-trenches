// BN254's scalar field in WebAssembly for the restore's lane walk (card firefox-restore-fast). The walk derives three
// Poseidon hashes an index, 80,000 indices a pool (8 lanes of RESTORE_GAP), and on BigInt that is the whole restore's
// wait: Firefox's BigInt runs it about 4 to 5 times slower than Chrome's (merge queue run 43663711503: about 20 s a
// pool on 4 cores, so a restore of four pools ended at 90-93 s), while a 254-bit product in 32-bit limbs on 64-bit
// integers runs at the same speed in every engine.
// - The module is written here, byte by byte, as a 32 KB array would be harder to read than the code that makes it:
//   mul (Montgomery's CIOS on 8 limbs of 32 bits, R = 2^256, one conditional subtraction), add (with one conditional
//   subtraction) and pow5 (three muls). Every value it holds is reduced below p and in Montgomery form; a value goes
//   in through writeField (reduced mod p, then times R^2) and out through readField (times 1, so divided by R).
// - It imports nothing and exports its memory and the three functions: no call reaches out of it.
// - It is compiled where the page's CSP lets a script compile WebAssembly ('wasm-unsafe-eval': SIGN_HOST's page and
//   its /walk-worker.js, public/_headers). Where it cannot be, fieldWasm() answers null and the walk hashes on BigInt
//   as before (./poseidon-walk.ts): slower, never different.
// - Its answers are held equal to poseidon-lite's (test/poseidon-walk.test.ts), and fieldWasm() checks one known
//   product before it answers, so a broken module is never used. The walk checks every hit and its last index again
//   with poseidon-lite (./restore.ts checkedWalk), so a drift stops the restore instead of losing a note.

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LIMBS = 8;
const MASK32 = 0xffffffffn;
/** Bytes one field element takes in the module's memory. */
export const FIELD_BYTES = 32;

const limbsOf = (x: bigint): bigint[] => Array.from({ length: LIMBS }, (_, j) => (x >> BigInt(32 * j)) & MASK32);
// -p^-1 mod 2^32 (Montgomery's n0')
const n0Inv = (): bigint => {
  const m = 1n << 32n;
  let inv = 1n;
  // Newton's iteration doubles the bits each step: 5 steps reach 32
  for (let k = 0; k < 5; k++) inv = (inv * (2n - ((P & MASK32) * inv))) % m;
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
const A = (j: number): number => 3 + j;
const T = (j: number): number => 11 + j; // t0..t9
const C = 21;
const M = 22;
const BI = 23;
const X = 24;
const D = (j: number): number => 25 + j;
const BR = 33;
const I64_LOCALS = 31;

/** t0..t8 (t8 the top carry) minus p, kept when t >= p, stored at r. */
function reduceStore(c: Code, n: bigint[]): void {
  c.c64(0n).set(BR);
  for (let j = 0; j < LIMBS; j++) {
    c.get(T(j)).c64(n[j]!).op(OP.sub).get(BR).op(OP.sub).set(X);
    c.get(X).c64(MASK32).op(OP.and).set(D(j));
    c.get(X).c64(63n).op(OP.shrU).set(BR);
  }
  // X = t8 - borrow: negative (top bit set) when t < p, so t is kept
  c.get(T(8)).get(BR).op(OP.sub).c64(63n).op(OP.shrU).set(X);
  for (let j = 0; j < LIMBS; j++) c.get(0).get(T(j)).get(D(j)).get(X).op(OP.wrap).op(OP.select).store(4 * j);
}

function mulBody(): number[] {
  const n = limbsOf(P);
  const ninv = n0Inv();
  const c = new Code();
  for (let j = 0; j < LIMBS; j++) c.load(1, 4 * j).set(A(j));
  for (let i = 0; i < LIMBS; i++) {
    c.load(2, 4 * i).set(BI);
    c.c64(0n).set(C);
    for (let j = 0; j < LIMBS; j++) {
      c.get(T(j)).get(A(j)).get(BI).op(OP.mul).op(OP.add).get(C).op(OP.add).set(X);
      c.get(X).c64(MASK32).op(OP.and).set(T(j));
      c.get(X).c64(32n).op(OP.shrU).set(C);
    }
    c.get(T(8)).get(C).op(OP.add).set(X);
    c.get(X).c64(MASK32).op(OP.and).set(T(8));
    c.get(X).c64(32n).op(OP.shrU).set(T(9));
    c.get(T(0)).c64(ninv).op(OP.mul).c64(MASK32).op(OP.and).set(M);
    c.get(T(0)).get(M).c64(n[0]!).op(OP.mul).op(OP.add).c64(32n).op(OP.shrU).set(C);
    for (let j = 1; j < LIMBS; j++) {
      c.get(T(j)).get(M).c64(n[j]!).op(OP.mul).op(OP.add).get(C).op(OP.add).set(X);
      c.get(X).c64(MASK32).op(OP.and).set(T(j - 1));
      c.get(X).c64(32n).op(OP.shrU).set(C);
    }
    c.get(T(8)).get(C).op(OP.add).set(X);
    c.get(X).c64(MASK32).op(OP.and).set(T(7));
    c.get(X).c64(32n).op(OP.shrU).get(T(9)).op(OP.add).set(T(8));
  }
  reduceStore(c, n);
  return c.b;
}

function addBody(): number[] {
  const n = limbsOf(P);
  const c = new Code();
  c.c64(0n).set(C);
  for (let j = 0; j < LIMBS; j++) {
    c.load(1, 4 * j).load(2, 4 * j).op(OP.add).get(C).op(OP.add).set(X);
    c.get(X).c64(MASK32).op(OP.and).set(T(j));
    c.get(X).c64(32n).op(OP.shrU).set(C);
  }
  c.get(C).set(T(8));
  reduceStore(c, n);
  return c.b;
}

/** The scratch slot pow5 uses (bytes 0-31), and the module's other fixed slots. */
const SCRATCH = 0;
const R2_AT = 32;
const ONE_AT = 64;
const OUT_AT = 96;
const FIRST_FREE = 128;

function pow5Body(): number[] {
  const c = new Code();
  // x^2 to SCRATCH, x^4, then x^4 * x to r (r may be a: a is read as mul's b, a limb at a time, before r is written)
  c.c32(SCRATCH).get(1).get(1).call(0);
  c.c32(SCRATCH).c32(SCRATCH).c32(SCRATCH).call(0);
  c.get(0).c32(SCRATCH).get(1).call(0);
  return c.b;
}

const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const name = (s: string): number[] => [...uleb(s.length), ...Array.from(s, (ch) => ch.charCodeAt(0))];
const PAGES = 2;

/** The module's bytes. */
export function fieldWasmBytes(): Uint8Array {
  const I32 = 0x7f;
  const I64 = 0x7e;
  const types = vec([
    [0x60, ...vec([[I32], [I32], [I32]]), 0],
    [0x60, ...vec([[I32], [I32]]), 0],
  ]);
  const funcs = vec([[0], [0], [1]]);
  const memory = vec([[0x00, ...uleb(PAGES)]]);
  const exports = vec([
    [...name("mem"), 0x02, 0],
    [...name("mul"), 0x00, 0],
    [...name("add"), 0x00, 1],
    [...name("pow5"), 0x00, 2],
  ]);
  const body = (locals: number[][], code: number[]): number[] => {
    const b = [...vec(locals), ...code, OP.end];
    return [...uleb(b.length), ...b];
  };
  const code = [...uleb(3), ...body([[...uleb(I64_LOCALS), I64]], mulBody()), ...body([[...uleb(I64_LOCALS), I64]], addBody()), ...body([], pow5Body())];
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...section(1, types), ...section(3, funcs), ...section(5, memory), ...section(7, exports), ...section(10, code)]);
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
    raw(R2_AT, ((1n << 256n) * (1n << 256n)) % P);
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
        mem[at / 4] = n >>> 0;
        ex.mul(at, at, R2_AT);
      },
      read(at) {
        ex.mul(OUT_AT, at, ONE_AT);
        let h = "0x";
        for (let j = LIMBS - 1; j >= 0; j--) h += mem[OUT_AT / 4 + j]!.toString(16).padStart(8, "0");
        return BigInt(h);
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
