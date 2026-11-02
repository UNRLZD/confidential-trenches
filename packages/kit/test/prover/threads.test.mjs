// node --test packages/kit/test/prover/threads.test.mjs: the worker's threads (card signpage-prover-threads), run on
// the worker code exactly as build.mjs ships it, in a fake worker global whose Worker, fetch and Trusted Types record
// what they are asked, with snarkjs stubbed to ask for its thread workers as snarkjs.min.js does (`new Worker(url)`
// with a blob: or data: URL). Whatever URL snarkjs asks for, only the pinned same-origin prover-thread.js starts, made
// through the worker's own prover-worker policy, and only after the served file matched its pin; threads are
// min(hardwareConcurrency - 1, 4), single thread below 2. The real browsers: chromium.e2e.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildProverWorker, HEADER, proverThreadSource, SNARKJS_BUILD } from "../../src/prover/build.mjs";

const KIT = new URL("../../", import.meta.url);
const built = readFileSync(buildProverWorker(mkdtempSync(join(tmpdir(), "kit-threads-"))).file);
const SHIPPED = built.subarray(HEADER.map((l) => `// ${l}\n`).join("").length + SNARKJS_BUILD.bytes).toString();
const THREAD = proverThreadSource();
const ORIGIN = "https://sign.example";
const THREAD_URL = `${ORIGIN}/prover-thread.js`;
const bytes = (n) => readFileSync(new URL(`zk/${n}`, KIT));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const good = () => ({ wasm: ab(bytes("withdraw.wasm")), zkey: ab(bytes("withdraw.zkey")) });
const ASKED = ["blob:https://sign.example/5f0c7a4e-0000-4000-8000-000000000000", "data:application/javascript;base64,KGZ1bmN0aW9uKCl7fSkoKQ=="];

/** The shipped worker code in a fake worker global with `cores` cores; `served` is what /prover-thread.js answers. */
function worker({ cores = 12, noCores = false, served = () => new Response(THREAD), trusted = true, nativeWorker = true } = {}) {
  const on = {};
  const out = [];
  const started = []; // every native Worker: [url, options]
  const fetched = [];
  const policies = [];
  class NativeWorker {
    constructor(url, opts) {
      started.push([url, opts]);
    }
  }
  const tt = {
    createPolicy(name, rules) {
      if (policies.some((p) => p.name === name)) throw new TypeError(`a second ${name}`);
      const p = { name, createScriptURL: (s) => ({ trusted: rules.createScriptURL(s) }) };
      policies.push(p);
      return p;
    },
  };
  const self = {
    addEventListener: (t, f) => (on[t] = f),
    postMessage: (m) => out.push(m),
    navigator: noCores ? {} : { hardwareConcurrency: cores },
    location: { origin: ORIGIN },
    fetch: async (url, opts) => (fetched.push([url, opts]), served(url)),
    ...(trusted ? { trustedTypes: tt } : {}),
    ...(nativeWorker ? { Worker: NativeWorker } : {}),
  };
  const proves = [];
  // snarkjs.min.js reads navigator.hardwareConcurrency and makes that many `new Worker(<its blob: URL>)` (threadman)
  const snarkjs = {
    groth16: {
      fullProve: async (_i, _w, _z, _l, _x, opts) => {
        const threads = opts.singleThread ? 0 : self.navigator.hardwareConcurrency;
        const made = [];
        for (let i = 0; i < threads; i++) made.push(new self.Worker(ASKED[i % 2]));
        proves.push({ opts, made });
        return { proof: {}, publicSignals: [] };
      },
    },
  };
  new Function("self", "snarkjs", SHIPPED)(self, snarkjs);
  const send = async (msg, transfer = []) => (await on.message({ data: structuredClone(msg, { transfer }) }), out.at(-1));
  const load = () => {
    const g = good();
    return send({ id: 1, cmd: "load", circuit: "withdraw", ...g }, [g.wasm, g.zkey]);
  };
  const prove = () => send({ id: 2, cmd: "prove", circuit: "withdraw", input: {} });
  return { self, out, started, fetched, policies, proves, load, prove };
}

for (const [cores, threads] of [[12, 4], [8, 4], [5, 4], [4, 3], [3, 2]])
  test(`${cores} cores: proves on ${threads} threads, each the pinned prover-thread.js, whatever URL snarkjs asks`, async () => {
    const w = worker({ cores });
    assert.equal((await w.load()).ok, true);
    assert.deepEqual(w.fetched, [[THREAD_URL, { credentials: "omit", cache: "no-cache" }]]);
    const r = await w.prove();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.threads, threads);
    assert.deepEqual(w.proves[0].opts, { singleThread: false });
    assert.equal(w.started.length, threads);
    for (const [url, opts] of w.started) {
      assert.deepEqual(url, { trusted: THREAD_URL }); // made by the worker's prover-worker policy
      assert.deepEqual(opts, { name: "prover-thread" });
    }
    assert.deepEqual(w.policies.map((p) => p.name), ["prover-worker"]);
    // the policy turns that one URL into a TrustedScriptURL and refuses every other
    for (const other of [...ASKED, `${ORIGIN}/app.js`, "https://evil.example/prover-thread.js", `${ORIGIN}/prover-thread.js?x`])
      assert.throws(() => w.policies[0].createScriptURL(other), /prover-worker refuses/);
    // a second prove reuses the check: no new fetch, no second policy
    assert.equal((await w.prove()).ok, true);
    assert.equal(w.fetched.length, 1);
    assert.equal(w.policies.length, 1);
  });

for (const [name, opts] of [["2 cores", { cores: 2 }], ["1 core", { cores: 1 }], ["no hardwareConcurrency", { noCores: true }], ["0 cores", { cores: 0 }]])
  test(`${name}: single thread, no thread file read, no worker made`, async () => {
    const w = worker(opts);
    assert.equal((await w.load()).ok, true);
    const r = await w.prove();
    assert.equal(r.ok, true);
    assert.equal(r.value.threads, 1);
    assert.deepEqual(w.proves[0].opts, { singleThread: true });
    assert.equal(w.fetched.length, 0);
    assert.equal(w.started.length, 0);
  });

test("no Worker in this worker: single thread", async () => {
  const w = worker({ nativeWorker: false });
  assert.equal((await w.load()).ok, true);
  const r = await w.prove();
  assert.equal(r.value.threads, 1);
  assert.deepEqual(w.proves[0].opts, { singleThread: true });
  assert.equal(w.fetched.length, 0);
});

const flipped = () => {
  const b = Buffer.from(THREAD);
  b[b.length >> 1] ^= 1;
  return b;
};
const BAD = [
  ["one byte changed", () => new Response(flipped()), /prover-thread\.js: sha256 [0-9a-f]{64}, pinned /],
  ["one byte short", () => new Response(THREAD.subarray(1)), /prover-thread\.js: \d+ B, pinned \d+ B/],
  ["a 404", () => new Response("", { status: 404 }), /prover-thread\.js: HTTP 404/],
  ["snarkjs's own thread code without the header", () => new Response(THREAD.subarray(THREAD.indexOf("(function thread"))), /pinned/],
];
for (const [name, served, why] of BAD)
  test(`refused at load when the served thread file is ${name}: no thread starts, no prove`, async () => {
    const w = worker({ served });
    const a = await w.load();
    assert.equal(a.ok, false);
    assert.match(a.error, why);
    const b = await w.prove();
    assert.equal(b.ok, false);
    assert.match(b.error, /not loaded/);
    assert.equal(w.proves.length, 0);
    assert.equal(w.started.length, 0);
    assert.equal(w.policies.length, 0);
    // snarkjs asking for a thread now is refused, never started
    assert.throws(() => new w.self.Worker(ASKED[1]), /the thread file is not checked/);
    assert.equal(w.started.length, 0);
  });

test("a failed check is tried again at the next load, and then threads start", async () => {
  let n = 0;
  const w = worker({ served: () => (n++ === 0 ? new Response(flipped()) : new Response(THREAD)) });
  assert.equal((await w.load()).ok, false);
  assert.equal((await w.load()).ok, true);
  const r = await w.prove();
  assert.equal(r.ok, true);
  assert.equal(r.value.threads, 4);
  assert.equal(w.started.length, 4);
  assert.equal(w.policies.length, 1);
});

test("a Worker asked before any load is refused, never started", () => {
  const w = worker();
  for (const u of ASKED) assert.throws(() => new w.self.Worker(u), /the thread file is not checked/);
  assert.equal(w.started.length, 0);
});

test("no Trusted Types here: the checked plain URL, still only that one file", async () => {
  const w = worker({ trusted: false, cores: 4 });
  assert.equal((await w.load()).ok, true);
  await w.prove();
  assert.deepEqual(w.started.map(([u]) => u), [THREAD_URL, THREAD_URL, THREAD_URL]);
});
