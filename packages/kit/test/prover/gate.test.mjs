// node --test packages/kit/test/prover/gate.test.mjs: the worker's gate, run in CI on the worker code exactly as
// build.mjs ships it (the bytes after the pinned snarkjs.min.js in prover-worker.js) with snarkjs stubbed to record
// what reaches fullProve. Only the six pinned files, as ArrayBuffers, for the circuit they belong to, ever reach it.
// Ported from the card's independent review harness (review-prover/harness/gate.mjs). The real browser: chromium.e2e.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildProverWorker, HEADER, SNARKJS_BUILD } from "../../src/prover/build.mjs";
import { ZK_SETUP_FILES } from "../../src/zk/setup-files.ts";

const KIT = new URL("../../", import.meta.url);
const built = readFileSync(buildProverWorker(mkdtempSync(join(tmpdir(), "kit-gate-"))).file);
const SHIPPED = built.subarray(HEADER.map((l) => `// ${l}\n`).join("").length + SNARKJS_BUILD.bytes).toString();
const RAW = readFileSync(new URL("src/prover/worker.js", KIT), "utf8"); // PINS null
const bytes = (n) => readFileSync(new URL(`zk/${n}`, KIT));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const sha = (u8) => createHash("sha256").update(u8).digest("hex");
const WITHDRAW = { wasm: ab(bytes("withdraw.wasm")), zkey: ab(bytes("withdraw.zkey")) };
const good = () => ({ wasm: WITHDRAW.wasm.slice(0), zkey: WITHDRAW.zkey.slice(0) });

/** The worker code in a fake worker global: `self` records replies, `snarkjs.groth16.fullProve` records its bytes. */
function worker(src = SHIPPED) {
  const on = {};
  const out = [];
  const calls = [];
  const self = { addEventListener: (t, f) => (on[t] = f), postMessage: (m) => out.push(m) };
  const snarkjs = { groth16: { fullProve: async (_input, w, z) => (calls.push({ w, z }), { proof: {}, publicSignals: [] }) } };
  new Function("self", "snarkjs", src)(self, snarkjs);
  const post = (msg, transfer = []) => on.message({ data: structuredClone(msg, { transfer }) });
  const send = async (msg, transfer) => (await post(msg, transfer), out.at(-1));
  return { out, calls, post, send };
}
const pinned = (c) => {
  assert.equal(sha(c.w), ZK_SETUP_FILES["withdraw.wasm"].sha256);
  assert.equal(sha(c.z), ZK_SETUP_FILES["withdraw.zkey"].sha256);
};

test("a pinned load then a prove: fullProve gets exactly the pinned bytes", async () => {
  const w = worker();
  const g = good();
  assert.equal((await w.send({ id: 1, cmd: "load", circuit: "withdraw", ...g }, [g.wasm, g.zkey])).ok, true);
  assert.equal((await w.send({ id: 2, cmd: "prove", circuit: "withdraw", input: {} })).ok, true);
  assert.equal(w.calls.length, 1);
  pinned(w.calls[0]);
});

const REFUSED = [
  ["one byte flipped in the zkey", (g) => (new Uint8Array(g.zkey)[9] ^= 1, g)],
  ["the zkey one byte short", (g) => ((g.zkey = g.zkey.slice(1)), g)],
  ["a Uint8Array, not an ArrayBuffer", (g) => ((g.zkey = new Uint8Array(g.zkey)), g)],
  ["a DataView", (g) => ((g.zkey = new DataView(g.zkey)), g)],
  ["a SharedArrayBuffer holding the pinned bytes", (g) => {
    const s = new SharedArrayBuffer(g.zkey.byteLength);
    new Uint8Array(s).set(new Uint8Array(g.zkey));
    g.zkey = s;
    return g;
  }],
  ["a Blob", (g) => ((g.zkey = new Blob([g.zkey])), g)],
  ["a URL string", (g) => ((g.zkey = "/assets/zk/x.zkey"), g)],
  ["wasm and zkey swapped", (g) => ({ wasm: g.zkey, zkey: g.wasm })],
  ["the commitment zkey under withdraw", (g) => ((g.zkey = ab(bytes("commitment.zkey"))), g)],
];
for (const [name, change] of REFUSED)
  test(`refused at load, and no prove after it: ${name}`, async () => {
    const w = worker();
    const a = await w.send({ id: 1, cmd: "load", circuit: "withdraw", ...change(good()) });
    assert.equal(a.ok, false, JSON.stringify(a));
    const b = await w.send({ id: 2, cmd: "prove", circuit: "withdraw", input: {} });
    assert.equal(b.ok, false);
    assert.match(b.error, /not loaded/);
    assert.equal(w.calls.length, 0);
  });

for (const c of ["__proto__", "constructor", "toString", "hasOwnProperty", undefined, null, ["withdraw"]])
  test(`refused: circuit ${JSON.stringify(c)}`, async () => {
    const w = worker();
    const a = await w.send({ id: 1, cmd: "load", circuit: c, ...good() });
    assert.equal(a.ok, false);
    assert.match(a.error, /unknown circuit/);
  });

for (const m of [{ id: 1, circuit: "withdraw" }, { id: 1, cmd: "LOAD", circuit: "withdraw" }, null, "load", 7])
  test(`refused: message ${JSON.stringify(m)}`, async () => {
    const w = worker();
    assert.equal((await w.send(m)).ok, false);
    assert.equal(w.calls.length, 0);
  });

test("refused: a prove before any load, and a prove of a circuit not loaded", async () => {
  const w = worker();
  assert.match((await w.send({ id: 1, cmd: "prove", circuit: "withdraw", input: {} })).error, /not loaded/);
  await w.send({ id: 2, cmd: "load", circuit: "withdraw", ...good() });
  assert.match((await w.send({ id: 3, cmd: "prove", circuit: "commitment", input: {} })).error, /not loaded/);
  assert.equal(w.calls.length, 0);
});

test("race: a bad load after a good one, and a prove posted right behind it, is refused", async () => {
  const w = worker();
  await w.send({ id: 1, cmd: "load", circuit: "withdraw", ...good() });
  const b = good();
  new Uint8Array(b.zkey)[5] ^= 1;
  await Promise.all([w.post({ id: 2, cmd: "load", circuit: "withdraw", ...b }), w.post({ id: 3, cmd: "prove", circuit: "withdraw", input: {} })]);
  const byId = Object.fromEntries(w.out.map((m) => [m.id, m]));
  assert.equal(byId[2].ok, false);
  assert.equal(byId[3].ok, false);
  assert.equal(w.calls.length, 0);
});

test("race: a prove in flight, then a bad load: the prove keeps the pinned bytes", async () => {
  const w = worker();
  await w.send({ id: 1, cmd: "load", circuit: "withdraw", ...good() });
  const b = good();
  new Uint8Array(b.zkey)[5] ^= 1;
  await Promise.all([w.post({ id: 2, cmd: "prove", circuit: "withdraw", input: {} }), w.post({ id: 3, cmd: "load", circuit: "withdraw", ...b })]);
  assert.equal(w.calls.length, 1);
  pinned(w.calls[0]);
});

test("race: a good and a bad load interleaved, both orders: changed bytes never reach fullProve", async () => {
  for (const order of [0, 1]) {
    const w = worker();
    const b = good();
    new Uint8Array(b.wasm)[5] ^= 1;
    const msgs = [{ id: 1, cmd: "load", circuit: "withdraw", ...good() }, { id: 2, cmd: "load", circuit: "withdraw", ...b }];
    if (order) msgs.reverse();
    await Promise.all(msgs.map((m) => w.post(m)));
    await w.send({ id: 9, cmd: "prove", circuit: "withdraw", input: {} });
    for (const c of w.calls) pinned(c);
  }
});

test("PINS null (worker.js not built) refuses even the pinned files", async () => {
  const w = worker(RAW);
  const a = await w.send({ id: 1, cmd: "load", circuit: "withdraw", ...good() });
  assert.equal(a.ok, false);
  assert.match(a.error, /not a pinned setup file/);
});
