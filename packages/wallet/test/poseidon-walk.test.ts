// Card firefox-e2e-restore-ends-on-ci: the restore's lane walk hashes with src/notes/poseidon-walk.ts, poseidon-lite's
// permutation with its partial rounds in the sparse form. It must be poseidon-lite's hash exactly: the constants copied
// into src/notes/poseidon-constants.ts equal the package's own files, and poseidon2Walk and poseidon3Walk equal
// poseidon2 and poseidon3 on edge inputs and on 4,000 seeded random ones. A walk that drifts would find no note; the walk
// also checks every hit and its last index with poseidon-lite (src/notes/restore.ts checkedWalk), held below.
// Card firefox-restore-fast: the walk hashes on BN254's field in WebAssembly (src/notes/field-wasm.ts) where it compiles;
// those hashes equal poseidon-lite's on the same edge and random inputs, the walk's precommitment equals the BigInt
// one, the walk takes it, and a module that cannot compile leaves the walk on BigInt.
//   node --test test/poseidon-walk.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon5 } from "poseidon-lite/poseidon5";
import { C2, C3, C5, M2, M3, M5 } from "../src/notes/poseidon-constants.ts";
import { poseidon2Walk, poseidon3Walk, poseidon5Walk, poseidonWasm, precommitmentWalker, secondWalker } from "../src/notes/poseidon-walk.ts";
import { FIELD_BYTES, fieldProgramBytes, fieldWasm, fieldWasmBytes } from "../src/notes/field-wasm.ts";
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
  const c5 = require(path.join(lite, "constants/5.js")).default as { C: string[]; M: string[][] };
  assert.deepEqual([...C5], c5.C);
  assert.deepEqual(M5.map((r) => [...r]), c5.M);
});

// Card readme-run-fits-an-agent-timeout: the EVM restore reads a note's second arrivals with secondWalker (poseidon5 in
// the sparse form, on the WebAssembly field where it compiles), checking each id's first arrival against poseidon-lite
// (src/pool/evm-restore.ts seconds; its drift is held in test/pool-evm-restore.test.ts)
test("poseidon5Walk equals poseidon-lite's poseidon5 on edge and random inputs", () => {
  const edges = [0n, 1n, P - 1n, P, (1n << 256n) - 1n, 0xffffffffn];
  for (const a of edges) for (const b of edges) for (const c of [0n, 0x13n, P - 1n]) assert.equal(poseidon5Walk([a, c, b, 0xfffffff8n, a]), poseidon5([a, c, b, 0xfffffff8n, a]), `poseidon5(${a}, ${c}, ${b})`);
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
  for (let i = 0; i < 1000; i++) {
    const xs = [next(), BigInt(i % 0x17), next(), BigInt(i), next()] as const;
    assert.equal(poseidon5Walk(xs), poseidon5([...xs]));
  }
});

test("secondWalker gives every second-arrival id's precommitment as noteSecrets does, on the field and on BigInt, two walkers taking turns included", () => {
  const seed64 = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff);
  const m = masters(seed64, "second");
  const ids = [
    { id: "U", s: 12345n, i: 3 },
    { id: "U", s: P - 1n, i: 0xffffffff },
    { id: "V", l: P - 1n, j: 0 },
    { id: "A", l: 99n, j: 7 },
    { id: "R", c: "evm", l: 7n, j: 2 },
    { id: "R", c: "sol", l: 7n, j: 2 },
    { id: "R", c: "near", l: 1n, j: 0 },
    { id: "R", c: "hop-near", l: 7n, j: 2 },
  ] as const;
  const tags = { sol: 1, evm: 2, near: 3, "hop-sol": 4, "hop-evm": 5, "hop-near": 6 } as const;
  const walkers = ids.map((id) => secondWalker(m, id));
  for (const n of [0, 1, 19, 20, 0xffffffff])
    for (const [k, id] of ids.entries()) {
      const want = noteSecrets(seed64, { kind: "second", id, n }).precommitment;
      assert.equal(walkers[k]!(n), want, `${id.id} ${k}, arrival ${n}`);
      const xs = id.id === "U" ? ([1n, id.s, BigInt(id.i), BigInt(n)] as const) : ([BigInt(id.id === "V" ? 2 : id.id === "A" ? 3 : 0x10 + tags[id.c]), id.l, BigInt(id.j), BigInt(n)] as const);
      assert.equal(poseidon2Walk([poseidon5Walk([m.nullifier, ...xs]), poseidon5Walk([m.secret, ...xs])]), want, `BigInt, ${id.id} ${k}, arrival ${n}`);
    }
  assert.throws(() => walkers[0]!(-1), /u32/);
  assert.throws(() => walkers[0]!(2 ** 32), /u32/);
  // where WebAssembly is refused (a CSP without 'wasm-unsafe-eval'), the walker hashes on BigInt and gives the same
  const here = path.dirname(new URL(import.meta.url).pathname);
  const code = `
    const f = await import(${JSON.stringify(path.join(here, "../src/notes/field-wasm.ts"))});
    const w = await import(${JSON.stringify(path.join(here, "../src/notes/poseidon-walk.ts"))});
    WebAssembly.Module = function () { throw new EvalError("WebAssembly.Module(): Refused to compile or instantiate WebAssembly module"); };
    const p = w.secondWalker({ nullifier: ${m.nullifier}n, secret: ${m.secret}n }, { id: "V", l: ${P - 1n}n, j: 0 })(19);
    console.log(JSON.stringify({ field: f.fieldWasm(), p: String(p) }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").pop()!), { field: null, p: String(noteSecrets(seed64, { kind: "second", id: { id: "V", l: P - 1n, j: 0 }, n: 19 }).precommitment) });
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

test("card firefox-restore-fast: the WebAssembly field compiles here, and its poseidon2 and poseidon3 equal poseidon-lite's on edge and random inputs", () => {
  const w = poseidonWasm();
  assert.ok(w, "the module compiles in node");
  const edges = [0n, 1n, 2n, P - 1n, P, P + 1n, (1n << 254n) - 1n, (1n << 256n) - 1n, 0xffffffffn];
  for (const a of edges) for (const b of edges) {
    assert.equal(w.poseidon2([a, b]), poseidon2([a, b]), `poseidon2(${a}, ${b})`);
    for (const c of [0n, 7n, 0xfffffff8n, P - 1n]) assert.equal(w.poseidon3([a, b, c]), poseidon3([a, b, c]), `poseidon3(${a}, ${b}, ${c})`);
  }
  let x = 0x2545f4914f6cdd1dn;
  const next = (): bigint => {
    let v = 0n;
    for (let k = 0; k < 4; k++) {
      x ^= x >> 12n;
      x ^= (x << 25n) & 0xffffffffffffffffn;
      x ^= x >> 27n;
      v = (v << 64n) | ((x * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn);
    }
    return v;
  };
  // unreduced inputs too (up to 2^256): the module reduces them as poseidon-lite does
  for (let i = 0; i < 1000; i++) {
    const a = next();
    const b = next() % P;
    assert.equal(w.poseidon2([a, b]), poseidon2([a, b]));
    assert.equal(w.poseidon3([a, b, BigInt(i)]), poseidon3([a, b, BigInt(i)]));
  }
});

test("card firefox-restore-fast: the walk's precommitment on the field equals the BigInt one, two walkers taking turns included", () => {
  const seed64 = new Uint8Array(64);
  const m = masters(seed64, "deposit");
  const a = precommitmentWalker(m, 12345n);
  const b = precommitmentWalker({ nullifier: m.secret, secret: m.nullifier }, P - 1n);
  for (const i of [0, 3, 8, 27, 323, 79_999, 0xfffffff8, 0xffffffff]) {
    assert.equal(a(i), noteSecrets(seed64, { kind: "deposit", s: 12345n, i }).precommitment, `index ${i}`);
    assert.equal(b(i), poseidon2Walk([poseidon3Walk([m.secret, P - 1n, BigInt(i)]), poseidon3Walk([m.nullifier, P - 1n, BigInt(i)])]), `walker b, index ${i}`);
  }
  assert.throws(() => a(-1), /u32/);
  assert.throws(() => a(2 ** 32), /u32/);
});

test("card firefox-restore-fast: the module is the field's own (it imports nothing, exports its memory and three functions) and a corrupted copy does not compile", () => {
  const bytes = fieldWasmBytes();
  const mod = new WebAssembly.Module(bytes as BufferSource);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  assert.deepEqual(WebAssembly.Module.exports(mod).map((e) => `${e.kind} ${e.name}`).sort(), ["function add", "function mul", "function pow5", "memory mem"]);
  const broken = bytes.slice(0, bytes.length - 3);
  assert.throws(() => new WebAssembly.Module(broken as BufferSource));
  assert.ok(fieldWasm(), "fieldWasm checks its known answers and answers the field");
});

test("card firefox-restore-fast: where the page's policy refuses WebAssembly (a CSP without 'wasm-unsafe-eval'), the walk hashes on BigInt and finds the same notes", () => {
  // a fresh process whose WebAssembly.Module throws as a refusing CSP makes it throw (EvalError), before the first use
  const here = path.dirname(new URL(import.meta.url).pathname);
  const code = `
    const f = await import(${JSON.stringify(path.join(here, "../src/notes/field-wasm.ts"))});
    const w = await import(${JSON.stringify(path.join(here, "../src/notes/poseidon-walk.ts"))});
    const r = await import(${JSON.stringify(path.join(here, "../src/notes/restore.ts"))});
    WebAssembly.Module = function () { throw new EvalError("WebAssembly.Module(): Refused to compile or instantiate WebAssembly module"); };
    const m = { nullifier: 11n, secret: 22n };
    const want = w.poseidon2Walk([w.poseidon3Walk([11n, 33n, 19n]), w.poseidon3Walk([22n, 33n, 19n])]);
    const lane = r.walkLaneOf(m, 33n, 3, (p) => p === want, 4);
    console.log(JSON.stringify({ field: f.fieldWasm(), same: w.precommitmentWalker(m, 33n)(19) === want, found: lane.found }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").pop()!), { field: null, same: true, found: [19] });
});

// Card first-sign-in-fast-from-any-region: the page's pool walks go one at a time, all hashing (src/pool-restore.ts turn),
// so on a device of few cores Robinhood's balance came two walks after Solana's (GitHub's 4-vCPU runner: 8.1 and 16.1 s,
// release 163's live run 43807865869). The walk's cost is held here by counting, never by a clock: the instructions a
// product runs in the module (its code is straight-line, so what it holds is what it runs) and the calls an index makes
// from script into WebAssembly.
/** Each function's instructions as run (straight-line code: the function's own, and its callees' at each call). */
function wasmRunCosts(bytes: Uint8Array): number[] {
  const p = { i: 8 };
  const leb = (): number => {
    let r = 0;
    for (let s = 0; ; s += 7) {
      const x = bytes[p.i++]!;
      r += (x & 0x7f) * 2 ** s;
      if (!(x & 0x80)) return r;
    }
  };
  while (p.i < bytes.length) {
    const id = bytes[p.i++]!;
    const end = leb() + p.i;
    if (id !== 10) {
      p.i = end;
      continue;
    }
    const fns = Array.from({ length: leb() }, () => {
      const fe = leb() + p.i;
      for (let l = leb(); l > 0; l--) (leb(), p.i++);
      let own = 0;
      const calls: number[] = [];
      while (p.i < fe) {
        const op = bytes[p.i++]!;
        if (op === 0x0b && p.i === fe) break;
        own++;
        if ([0x20, 0x21, 0x41, 0x42].includes(op)) leb();
        else if (op === 0x35 || op === 0x3e) (leb(), leb());
        else if (op === 0x10) calls.push(leb());
        else assert.ok([0x1b, 0x7c, 0x7d, 0x7e, 0x83, 0x88, 0xa7].includes(op), `an opcode the field does not use: ${op}`);
      }
      return { own, calls };
    });
    const cost = (f: number): number => fns[f]!.own + fns[f]!.calls.reduce((a, g) => a + cost(g), 0);
    return fns.map((_, f) => cost(f));
  }
  throw new Error("no code section");
}

test("card first-sign-in-fast-from-any-region: a walk's index is at most 4 calls from script into WebAssembly, and a product runs at most 1,500 of its instructions", () => {
  // a fresh process whose WebAssembly.Instance counts every call into an instance's exported functions
  const here = path.dirname(new URL(import.meta.url).pathname);
  const code = `
    const Real = WebAssembly.Instance;
    let calls = 0;
    WebAssembly.Instance = function (m, i) {
      const inst = new Real(m, i);
      const exports = {};
      for (const [k, v] of Object.entries(inst.exports)) exports[k] = typeof v === "function" ? (...a) => (calls++, v(...a)) : v;
      return { exports };
    };
    const w = await import(${JSON.stringify(path.join(here, "../src/notes/poseidon-walk.ts"))});
    const walk = w.precommitmentWalker({ nullifier: 11n, secret: 22n }, 33n);
    walk(0);
    calls = 0;
    for (let i = 1; i <= 100; i++) walk(i);
    const want = w.poseidon2Walk([w.poseidon3Walk([11n, 33n, 100n]), w.poseidon3Walk([22n, 33n, 100n])]);
    console.log(JSON.stringify({ perIndex: calls / 100, same: walk(100) === want }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const r = JSON.parse(run.stdout.trim().split("\n").pop()!) as { perIndex: number; same: boolean };
  assert.equal(r.same, true, "the counted walk's precommitment is poseidon-lite's");
  assert.ok(r.perIndex <= 4, `an index made ${r.perIndex} calls into WebAssembly`);
  const [mul, add, pow5] = wasmRunCosts(fieldWasmBytes());
  assert.ok(mul! <= 1_500, `a product runs ${mul} instructions`);
  assert.ok(add! <= 400 && pow5! <= 3 * mul! + 20, `a sum runs ${add} and a fifth power ${pow5}`);
});

test("card first-sign-in-fast-from-any-region: the field's product, sum, fifth power, square and dots are the residues' on every input it holds, a value up to 2p - 1 included", () => {
  const f = fieldWasm();
  assert.ok(f, "the module compiles in node");
  // a value the module holds: x in Montgomery form (x * 2^261 mod p), plus p when `high` (both under 2p), in 29-bit limbs
  const R = (1n << 261n) % P;
  const held = (x: bigint, high: boolean): Uint32Array => {
    const v = (((x % P) * R) % P) + (high ? P : 0n);
    return Uint32Array.from({ length: 9 }, (_, j) => Number((v >> BigInt(29 * j)) & ((1n << 29n) - 1n)));
  };
  const [a, b, r] = [f.slot(), f.slot(), f.slot()];
  const pow = (x: bigint, e: bigint): bigint => (e === 0n ? 1n : (pow((x * x) % P, e >> 1n) * (e & 1n ? x : 1n)) % P);
  let s = 0x853c49e6748fea9bn;
  const next = (): bigint => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 256n) - 1n);
    return s % P;
  };
  // -R^-1: held at its highest it is 2p - 1, the largest value the module holds (card walk-program-checked-before-use)
  const top = P - pow(R, P - 2n);
  assert.equal([...held(top, true)].reduce((v, w, j) => v + (BigInt(w) << BigInt(29 * j)), 0n), 2n * P - 1n);
  const values = [0n, 1n, 2n, P - 1n, P - 2n, (P - 1n) / 2n, top, ...Array.from({ length: 300 }, next)];
  for (const [k, x] of values.entries()) {
    const y = values[(k * 7 + 3) % values.length]!;
    for (const hx of [false, true]) for (const hy of [false, true]) {
      f.load(a, held(x, hx));
      f.load(b, held(y, hy));
      f.mul(r, a, b);
      assert.equal(f.read(r), (x * y) % P, `${x} * ${y}`);
      f.add(r, a, b);
      assert.equal(f.read(r), (x + y) % P, `${x} + ${y}`);
      f.pow5(r, a);
      assert.equal(f.read(r), pow(x, 5n), `${x}^5`);
      // what the module stores stays under 2p, in limbs under 2^29
      const out = f.save(r);
      assert.ok(out.every((w) => w < 2 ** 29) && [...out].reduce((v, w, j) => v + (BigInt(w) << BigInt(29 * j)), 0n) < 2n * P);
    }
  }
  // a program's dot of 2, 3 and 4 pairs (sosBody), every input at its highest form (plus p), and its square (pow5's)
  const ins = Array.from({ length: 8 }, () => f.slot());
  const run = f.program([["dot", r, ins[0]!, ins[1]!, ins[2]!, ins[3]!], ["copy", a, r], ["dot", r, ins[0]!, ins[1]!, ins[2]!, ins[3]!, ins[4]!, ins[5]!], ["copy", b, r], ["dot", r, ...ins], ["sqr", ins[0]!, ins[0]!]]);
  for (let k = 0; k + 8 <= values.length; k += 8) {
    const x = values.slice(k, k + 8);
    x.forEach((v, j) => f.load(ins[j]!, held(v, k % 16 === 0 || j % 2 === 1)));
    run();
    const sum = (m: number): bigint => x.slice(0, 2 * m).reduce((acc, v, j) => (j % 2 ? acc : acc + v * x[j + 1]!), 0n) % P;
    assert.equal(f.read(a), sum(2), "dot of 2");
    assert.equal(f.read(b), sum(3), "dot of 3");
    assert.equal(f.read(r), sum(4), "dot of 4");
    assert.equal(f.read(ins[0]!), (x[0]! * x[0]!) % P, "square");
    for (const at of [a, b, r, ins[0]!]) assert.ok([...f.save(at)].reduce((v, w, j) => v + (BigInt(w) << BigInt(29 * j)), 0n) < 2n * P);
  }
  assert.throws(() => f.program([["dot", r, a, b]]), /no known function/);
  assert.throws(() => f.dot(a, [a, b]), /none of them/);
});

// Card walk-program-checked-before-use: an independent review of the field (06:27Z) planted a cut of the dots' column
// sums at 2^62, and every test above passed it: their inputs are random or x R mod p + p, so a column stays near 2^61,
// while on the heaviest inputs under 2p a dot of 4 reaches 2^63.1 (src/notes/field-wasm.ts sosBody). Here the inputs
// are those heaviest ones, and each answer is held to Montgomery's exact words, (S + ((-S p^-1) mod R) p) / R, not
// only to its residue.
test("card walk-program-checked-before-use: at the top of the 64-bit headroom (8 limbs of 2^29 - 1 and the top limb at its largest under 2p, 2p - 1, p) the product, square, sum, fifth power and dots of 2 to 4 are Montgomery's exact words", () => {
  const f = fieldWasm();
  assert.ok(f, "the module compiles in node");
  const R = 1n << 261n;
  const TWO_P = 2n * P;
  const MASK = (1n << 29n) - 1n;
  const LOW = (1n << 232n) - 1n;
  const TOP = (TWO_P - 1n) >> 232n;
  // p^-1 mod 2^261 (Newton's iteration doubles the bits each step: 9 steps reach 512)
  let pInv = 1n;
  for (let k = 0; k < 9; k++) pInv = (pInv * (2n - P * pInv)) & (R - 1n);
  assert.equal((P * pInv) & (R - 1n), 1n);
  const mont = (S: bigint): bigint => {
    const t = S + (((-S * pInv) % R) + R) % R * P;
    assert.equal(t % R, 0n);
    return t / R;
  };
  const words = (v: bigint): Uint32Array => Uint32Array.from({ length: 9 }, (_, j) => Number((v >> BigInt(29 * j)) & MASK));
  const value = (w: Uint32Array): bigint => [...w].reduce((v, x, j) => v + (BigInt(x) << BigInt(29 * j)), 0n);
  // the heaviest: every lower limb at 2^29 - 1 under the top's largest with them (TOP - 1, as TOP << 232 | LOW > 2p - 1),
  // 2p - 1 (the top limb at TOP), p; then seeded ones of lower limbs mostly 2^29 - 1
  const heavy = ((TOP - 1n) << 232n) | LOW;
  const edges = [heavy, TWO_P - 1n, P, TWO_P - 2n, heavy - 1n];
  for (const e of edges) assert.ok(e < TWO_P);
  let s = 0x243f6a8885a308d3n;
  const r64 = (): bigint => {
    s ^= (s << 13n) & 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= (s << 17n) & 0xffffffffffffffffn;
    return s;
  };
  const seeded = (): bigint => {
    for (;;) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v |= (r64() % 10n < 8n ? MASK : r64() & MASK) << BigInt(29 * j);
      v |= (r64() % 2n ? TOP : TOP - 1n) << 232n;
      if (v < TWO_P) return v;
    }
  };
  const ins = Array.from({ length: 8 }, () => f.slot());
  const out = Array.from({ length: 6 }, () => f.slot());
  const run = f.program([
    ["mul", out[0]!, ins[0]!, ins[1]!],
    ["sqr", out[1]!, ins[0]!],
    ["dot", out[2]!, ...ins.slice(0, 4)],
    ["dot", out[3]!, ...ins.slice(0, 6)],
    ["dot", out[4]!, ...ins],
    ["pow5", out[5]!, ins[0]!],
  ]);
  const at = f.slot();
  const exact = (what: string, slot: number, want: bigint, x: readonly bigint[]): void => {
    const got = f.save(slot);
    assert.ok(got.every((w) => w < 2 ** 29), `${what}: a limb past 29 bits on ${x}`);
    assert.equal(value(got), want, `${what} on ${x}`);
  };
  const dot = (x: readonly bigint[], k: number): bigint => mont(x.slice(0, 2 * k).reduce((acc, v, j) => (j % 2 ? acc : acc + v * x[j + 1]!), 0n));
  const pow5 = (a: bigint): bigint => mont(mont(mont(a * a) ** 2n) * a);
  const tuples: bigint[][] = [];
  // every pair of edges, as each of the four pairs of a dot (the heaviest columns), and every edge on its own
  for (const a of edges) for (const b of edges) tuples.push([a, b, a, b, a, b, a, b]);
  for (let k = 0; k < 400; k++) tuples.push(k % 4 === 0 ? new Array<bigint>(8).fill(seeded()) : Array.from({ length: 8 }, seeded));
  for (const x of tuples) {
    x.forEach((v, j) => f.load(ins[j]!, words(v)));
    run();
    exact("program mul", out[0]!, mont(x[0]! * x[1]!), x);
    exact("program sqr", out[1]!, mont(x[0]! * x[0]!), x);
    exact("program dot of 2", out[2]!, dot(x, 2), x);
    exact("program dot of 3", out[3]!, dot(x, 3), x);
    exact("program dot of 4", out[4]!, dot(x, 4), x);
    exact("program pow5", out[5]!, pow5(x[0]!), x);
    f.mul(at, ins[0]!, ins[1]!);
    exact("field mul", at, mont(x[0]! * x[1]!), x);
    f.add(at, ins[0]!, ins[1]!);
    exact("field add", at, x[0]! + x[1]! >= TWO_P ? x[0]! + x[1]! - TWO_P : x[0]! + x[1]!, x);
    f.pow5(at, ins[0]!);
    exact("field pow5", at, pow5(x[0]!), x);
  }
});

test("card walk-program-checked-before-use: a program is refused a slot among the module's fixed ones (pow5's scratch, R^2, 1, read's and dot's)", () => {
  const first = 5 * FIELD_BYTES;
  for (const fixed of [0, 1, 2, 3, 4].map((k) => k * FIELD_BYTES)) {
    assert.throws(() => fieldProgramBytes([["copy", first, fixed]]), /no known function or slot/, `copy from ${fixed}`);
    assert.throws(() => fieldProgramBytes([["mul", fixed, first, first]]), /no known function or slot/, `mul to ${fixed}`);
    assert.throws(() => fieldProgramBytes([["dot", first, first, first, fixed, first]]), /no known function or slot/, `dot of ${fixed}`);
  }
  assert.ok(new WebAssembly.Module(fieldProgramBytes([["copy", first, first + FIELD_BYTES]]) as BufferSource), "the first free slot is a program's");
});

// A fresh process whose WebAssembly is patched before the walk's first use (after its imports): `mode` "refused" refuses to compile any
// module that imports (only a program does: the field compiles), "noop" makes a program's run do nothing, "flip" runs
// it and then flips the low bit of every word it wrote (an engine that runs it wrong). The walk must then answer
// poseidon-lite's precommitments one call a step (more than 4 calls an index), find the lane's note and pass
// checkedWalk; `programRuns` counts the program's runs (at most its one known index).
function walkWithProgram(mode: "refused" | "noop" | "flip"): { walkHash: string; same: boolean[]; found: number[]; checked: unknown; perIndex: number; programRuns: number } {
  const here = path.dirname(new URL(import.meta.url).pathname);
  // the imports first: node's own TypeScript loader runs on WebAssembly too, and the patches are for the walk's alone
  const code = `
    const w = await import(${JSON.stringify(path.join(here, "../src/notes/poseidon-walk.ts"))});
    const r = await import(${JSON.stringify(path.join(here, "../src/notes/restore.ts"))});
    const { noteSecrets } = await import(${JSON.stringify(path.join(here, "../src/notes/secrets.ts"))});
    const { masters } = await import(${JSON.stringify(path.join(here, "../src/derive/index.ts"))});
    const mode = ${JSON.stringify(mode)};
    const RealModule = WebAssembly.Module;
    const RealInstance = WebAssembly.Instance;
    const imports = RealModule.imports;
    if (mode === "refused") {
      WebAssembly.Module = function (b) {
        const m = new RealModule(b);
        if (imports(m).length) throw new EvalError("refused (test)");
        return m;
      };
      WebAssembly.Module.imports = imports;
    }
    let calls = 0;
    let programRuns = 0;
    WebAssembly.Instance = function (m, i) {
      const inst = new RealInstance(m, i);
      const exports = {};
      for (const [k, v] of Object.entries(inst.exports)) exports[k] = typeof v === "function" ? (...a) => (calls++, v(...a)) : v;
      if (imports(m).length && mode !== "refused") {
        const mem = new Uint32Array(i.env.mem.buffer);
        const real = inst.exports.run;
        exports.run = () => {
          calls++;
          programRuns++;
          if (mode === "noop") return;
          const before = mem.slice();
          real();
          for (let w = 0; w < mem.length; w++) if (mem[w] !== before[w]) mem[w] ^= 1;
        };
      }
      return { exports };
    };
    const P = ${P}n;
    const ref = (n, s, sc, i) => w.poseidon2Walk([w.poseidon3Walk([n, sc, BigInt(i)]), w.poseidon3Walk([s, sc, BigInt(i)])]);
    const walk = w.precommitmentWalker({ nullifier: 11n, secret: 22n }, 33n);
    walk(0);
    calls = 0;
    walk(1);
    const perIndex = calls;
    // the program's own known index (src/notes/poseidon-walk.ts KNOWN) and others, two walkers taking turns
    const other = w.precommitmentWalker({ nullifier: P - 1n, secret: (P - 1n) / 2n }, P - 2n);
    const same = [0, 7, 19, 323, 0xffffffff].flatMap((i) => [walk(i) === ref(11n, 22n, 33n, i), other(i) === ref(P - 1n, (P - 1n) / 2n, P - 2n, i)]);
    // an all-zero seed64: a test value, no wallet's
    const seed64 = new Uint8Array(64);
    const mine = noteSecrets(seed64, { kind: "deposit", s: 12345n, i: 27 }).precommitment;
    const lane = r.walkLaneOf(masters(seed64, "deposit"), 12345n, 3, (p) => p === mine, 6);
    console.log(JSON.stringify({ walkHash: w.walkHash(), same, found: lane.found, checked: r.checkedWalk(lane, 3, seed64, 12345n, 6, null), perIndex, programRuns }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").pop()!);
}

for (const mode of ["refused", "noop", "flip"] as const) {
  test(`card walk-program-checked-before-use: a program that ${mode === "refused" ? "does not compile (the field does)" : mode === "noop" ? "does nothing" : "answers wrong (each word it writes off by one bit)"} leaves the walk on the field's own calls, and the walk finishes with poseidon-lite's answers`, () => {
    const r = walkWithProgram(mode);
    assert.equal(r.walkHash, "wasm", "the field itself is still used");
    assert.deepEqual(r.same, new Array(10).fill(true), "every precommitment is poseidon-lite's");
    assert.deepEqual(r.found, [27]);
    assert.deepEqual(r.checked, { found: [27], end: 27 + 8 * 6 });
    assert.ok(r.perIndex > 4, `an index made ${r.perIndex} calls: the program was used`);
    assert.equal(r.programRuns, mode === "refused" ? 0 : 1, "the program ran its known index only");
  });
}
