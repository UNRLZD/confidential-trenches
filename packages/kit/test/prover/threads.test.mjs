// node --test packages/kit/test/prover/threads.test.mjs: the worker's threads (card signpage-prover-threads), run on
// the worker code exactly as build.mjs ships it, in a fake worker global whose Worker and Trusted Types record what
// they are asked, with snarkjs stubbed to ask for its thread workers as snarkjs.min.js does (`new Worker(url)` with a
// blob: or data: URL). Whatever URL snarkjs asks for, only the same-origin prover-thread.js starts, made through the
// worker's own prover-worker policy; threads are min(hardwareConcurrency - 1, 4), single thread below 2; the reply
// counts the threads started; a thread that fails or gives no first reply within 30 s ends the worker (fold 1).
// The real browsers: chromium.e2e.mjs and scripts/live-checks/signpage-prover-threads.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { buildProverWorker, HEADER, SNARKJS_BUILD } from "../../src/prover/build.mjs";

const KIT = new URL("../../", import.meta.url);
const built = readFileSync(buildProverWorker(mkdtempSync(join(tmpdir(), "kit-threads-"))).file);
const SHIPPED = built.subarray(HEADER.map((l) => `// ${l}\n`).join("").length + SNARKJS_BUILD.bytes).toString();
const ORIGIN = "https://sign.example";
const THREAD_URL = `${ORIGIN}/prover-thread.js`;
const bytes = (n) => readFileSync(new URL(`zk/${n}`, KIT));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const good = () => ({ wasm: ab(bytes("withdraw.wasm")), zkey: ab(bytes("withdraw.zkey")) });
// every test runs on fake timers: a thread's 30 s start limit fires only when a test moves the clock
beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

const ASKED = ["blob:https://sign.example/5f0c7a4e-0000-4000-8000-000000000000", "data:application/javascript;base64,KGZ1bmN0aW9uKCl7fSkoKQ=="];

/**
 * The shipped worker code in a fake worker global with `cores` cores. Each native Worker it starts is recorded with
 * its listeners, so a test can make it reply or fail. `snarkjsThreads` overrides how many threads the snarkjs stub
 * starts (by default it reads navigator.hardwareConcurrency, as snarkjs.min.js does).
 */
function worker({ cores = 12, noCores = false, trusted = true, nativeWorker = true, snarkjsThreads } = {}) {
  const on = {};
  const out = [];
  const started = []; // every native Worker: { url, opts, w }
  const policies = [];
  class NativeWorker {
    constructor(url, opts) {
      this.on = {};
      started.push({ url, opts, w: this });
    }
    addEventListener(t, f) {
      (this.on[t] ??= []).push(f);
    }
    fire(t, e = {}) {
      for (const f of this.on[t] ?? []) f(e);
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
    ...(trusted ? { trustedTypes: tt } : {}),
    ...(nativeWorker ? { Worker: NativeWorker } : {}),
  };
  const proves = [];
  // snarkjs.min.js reads navigator.hardwareConcurrency and makes that many `new Worker(<its blob: URL>)` (threadman),
  // once: it keeps them across proofs
  let made = null;
  const snarkjs = {
    groth16: {
      fullProve: async (_i, _w, _z, _l, _x, opts) => {
        if (!opts.singleThread && made === null) {
          made = [];
          const n = snarkjsThreads ?? self.navigator.hardwareConcurrency;
          for (let i = 0; i < n; i++) made.push(new self.Worker(ASKED[i % 2]));
        }
        proves.push({ opts });
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
  return { self, out, started, policies, proves, load, prove };
}

for (const [cores, threads] of [[12, 4], [8, 4], [5, 4], [4, 3], [3, 2]])
  test(`${cores} cores: proves on ${threads} threads, each the same-origin prover-thread.js, whatever URL snarkjs asks`, async () => {
    const w = worker({ cores });
    assert.equal((await w.load()).ok, true);
    const r = await w.prove();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.threads, threads);
    assert.deepEqual(w.proves[0].opts, { singleThread: false });
    assert.equal(w.started.length, threads);
    for (const { url, opts } of w.started) {
      assert.deepEqual(url, { trusted: THREAD_URL }); // made by the worker's prover-worker policy
      assert.deepEqual(opts, { name: "prover-thread" });
    }
    assert.deepEqual(w.policies.map((p) => p.name), ["prover-worker"]);
    // the policy turns that one URL into a TrustedScriptURL and refuses every other
    for (const other of [...ASKED, `${ORIGIN}/app.js`, "https://evil.example/prover-thread.js", `${ORIGIN}/prover-thread.js?x`])
      assert.throws(() => w.policies[0].createScriptURL(other), /prover-worker refuses/);
    // a second prove reuses snarkjs's threads: no new worker, no second policy
    assert.equal((await w.prove()).value.threads, threads);
    assert.equal(w.started.length, threads);
    assert.equal(w.policies.length, 1);
  });

for (const [name, opts] of [["2 cores", { cores: 2 }], ["1 core", { cores: 1 }], ["no hardwareConcurrency", { noCores: true }], ["0 cores", { cores: 0 }]])
  test(`${name}: single thread, no policy made, no worker started`, async () => {
    const w = worker(opts);
    assert.equal((await w.load()).ok, true);
    const r = await w.prove();
    assert.equal(r.ok, true);
    assert.equal(r.value.threads, 1);
    assert.deepEqual(w.proves[0].opts, { singleThread: true });
    assert.equal(w.started.length, 0);
    assert.equal(w.policies.length, 0);
  });

test("no Worker in this worker: single thread", async () => {
  const w = worker({ nativeWorker: false });
  assert.equal((await w.load()).ok, true);
  const r = await w.prove();
  assert.equal(r.value.threads, 1);
  assert.deepEqual(w.proves[0].opts, { singleThread: true });
});

test("no Trusted Types here: the plain same-origin URL, still only that one file", async () => {
  const w = worker({ trusted: false, cores: 4 });
  assert.equal((await w.load()).ok, true);
  await w.prove();
  assert.deepEqual(w.started.map(({ url }) => url), [THREAD_URL, THREAD_URL, THREAD_URL]);
});

test("the reply counts the threads started, not the planned count (fold 1, item 5)", async () => {
  for (const [n, want] of [[2, 2], [6, 6], [0, 0]]) {
    const w = worker({ cores: 12, snarkjsThreads: n });
    await w.load();
    assert.equal((await w.prove()).value.threads, want, `snarkjs started ${n}`);
  }
});

test("a thread that fails to start ends the worker: its error is thrown outside any promise (fold 1, item 1a)", async () => {
  const w = worker({ cores: 5 });
  await w.load();
  await w.prove();
  for (const s of w.started.slice(0, 3)) s.w.fire("message", { data: [] }); // three threads answer
  w.started[3].w.fire("error", { message: "Failed to load worker script" });
  assert.throws(() => mock.timers.tick(0), /^Error: prover thread: thread 4 failed: Failed to load worker script$/);
});

test("a thread that gives no first reply within 30 s ends the worker (fold 1, item 1b)", async () => {
  const w = worker({ cores: 5 });
  await w.load();
  await w.prove();
  for (const s of w.started.slice(0, 3)) s.w.fire("message", { data: [] });
  mock.timers.tick(29999); // 1 ms before the limit: nothing yet
  assert.throws(() => mock.timers.tick(1), /^Error: prover thread: thread 4 gave no first reply in 30 s$/);
});

test("threads that all answer in time end nothing", async () => {
  const w = worker({ cores: 5 });
  await w.load();
  await w.prove();
  for (const s of w.started) s.w.fire("message", { data: [] });
  mock.timers.tick(60000); // no throw
  assert.equal(w.started.length, 4);
});

test("an error after a thread's first reply still ends the worker", async () => {
  const w = worker({ cores: 3 });
  await w.load();
  await w.prove();
  for (const s of w.started) s.w.fire("message", { data: [] });
  w.started[0].w.fire("error", {});
  assert.throws(() => mock.timers.tick(0), /prover thread: thread 1 failed: it did not start/);
});
