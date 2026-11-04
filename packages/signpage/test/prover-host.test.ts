// SIGN_HOST's one prover (src/prover-host.ts), card signpage-prover-host.
//   node --test test/prover-host.test.ts      (from packages/signpage)
// The worker starts at the first proof that passes the kit's input checks, never before; one worker serves every proof
// and loads the withdraw setup files once; a worker that died is replaced at the next proof, which loads them again; a
// refused worker answer keeps the worker; stop() ends it; proofs run one at a time. The worker here is a stand-in that
// answers the fixture's signals, behind a fake startProver or behind the kit's real one (client.ts) on a fake Worker
// and fetch: the real worker in Chromium under SIGN_HOST's headers is packages/kit/test/prove-e2e.test.ts's
// (KIT_PROVER_E2E=1) and the live check scripts/live-checks/signpage-prover-host.mjs's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isProverDead, startProver, type Prover, type ProverOptions } from "../../kit/src/prover/client.ts";
import { ZK_SETUP_FILES } from "../../kit/src/zk/setup-files.ts";
import type { VaultSnarkjsProof } from "../../kit/src/vault/shapes.ts";
import { fixtureArgs, fixtureSignals, type ContextVector } from "../../kit/test/fixtures/prove-fixture.ts";
import { proverHost } from "../src/prover-host.ts";

const CV = (JSON.parse(readFileSync(new URL("../../kit/test/vectors/vault-v1.json", import.meta.url), "utf8")) as { context: ContextVector[] }).context[0]!;
const SIGNALS = fixtureSignals(CV);
// affine snarkjs JSON (the shape vaultProof reads); the stand-in's proofs are never verified
const PROOF: VaultSnarkjsProof = { pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"], protocol: "groth16", curve: "bn128" };

type Plan = { load?: () => Promise<void>; prove?: () => Promise<unknown> };

/** A startProver stand-in: each start makes worker n, logged as "start n", "load n withdraw", "prove n withdraw", "stop n". */
function starter(plan: (n: number) => Plan = () => ({})) {
  const log: string[] = [];
  let n = 0;
  const start = (_o: ProverOptions): Prover => {
    const k = ++n;
    const p = plan(k);
    log.push(`start ${k}`);
    return {
      async load(c) {
        log.push(`load ${k} ${c}`);
        await p.load?.();
      },
      async prove(c) {
        log.push(`prove ${k} ${c}`);
        if (p.prove) return (await p.prove()) as never;
        return { proof: PROOF, publicSignals: [...SIGNALS], proveMs: 1 };
      },
      terminate() {
        log.push(`stop ${k}`);
      },
    };
  };
  return { log, start };
}

test("no worker starts at load, nor for an input the kit refuses", async () => {
  const s = starter();
  const host = proverHost(s.start);
  assert.deepEqual(s.log, []);
  await assert.rejects(host.proveWithdraw(fixtureArgs(CV, "state-leaf")), /stateTree: its root is not the vault's newest/);
  assert.deepEqual(s.log, []);
});

test("one worker serves every proof and loads the withdraw setup files once", async () => {
  const s = starter();
  const host = proverHost(s.start);
  for (let i = 0; i < 3; i++) assert.deepEqual((await host.proveWithdraw(fixtureArgs(CV))).publicSignals, SIGNALS);
  assert.deepEqual(s.log, ["start 1", "load 1 withdraw", "prove 1 withdraw", "prove 1 withdraw", "prove 1 withdraw"]);
});

test("a worker that died is dropped; the next proof starts a new one and loads the files again", async () => {
  for (const msg of ["prover worker: failed to load", "prover worker: a reply could not be read", "prover worker: terminated"]) {
    const s = starter((n) => (n === 1 ? { prove: async () => Promise.reject(new Error(msg)) } : {}));
    const host = proverHost(s.start);
    await assert.rejects(host.proveWithdraw(fixtureArgs(CV)), new RegExp(msg));
    assert.deepEqual((await host.proveWithdraw(fixtureArgs(CV))).publicSignals, SIGNALS);
    assert.deepEqual(s.log, ["start 1", "load 1 withdraw", "prove 1 withdraw", "stop 1", "start 2", "load 2 withdraw", "prove 2 withdraw"], msg);
  }
});

test("a worker that dies while loading is replaced too", async () => {
  const s = starter((n) => (n === 1 ? { load: async () => Promise.reject(new Error("prover worker: failed to load")) } : {}));
  const host = proverHost(s.start);
  await assert.rejects(host.proveWithdraw(fixtureArgs(CV)), /prover worker: failed to load/);
  await host.proveWithdraw(fixtureArgs(CV));
  assert.deepEqual(s.log, ["start 1", "load 1 withdraw", "stop 1", "start 2", "load 2 withdraw", "prove 2 withdraw"]);
});

test("a refusal from a live worker keeps it: a setup file that fails its pin is fetched again, an answer that is not the input's is refused", async () => {
  let loads = 0;
  let proves = 0;
  const s = starter(() => ({
    load: async () => {
      if (++loads === 1) throw new Error("withdraw.zkey: sha256 00, pinned 2a893b42");
    },
    prove: async () => ({ proof: PROOF, publicSignals: ++proves === 1 ? SIGNALS.map((v, k) => (k === 7 ? String(BigInt(v) + 1n) : v)) : [...SIGNALS], proveMs: 1 }),
  }));
  const host = proverHost(s.start);
  await assert.rejects(host.proveWithdraw(fixtureArgs(CV)), /withdraw\.zkey: sha256 00/);
  await assert.rejects(host.proveWithdraw(fixtureArgs(CV)), /worker answer: context is not the input's/);
  assert.deepEqual((await host.proveWithdraw(fixtureArgs(CV))).publicSignals, SIGNALS);
  assert.deepEqual(s.log, ["start 1", "load 1 withdraw", "load 1 withdraw", "prove 1 withdraw", "prove 1 withdraw"]);
});

test("stop() ends the worker; the next proof starts a new one", async () => {
  const s = starter();
  const host = proverHost(s.start);
  host.stop();
  assert.deepEqual(s.log, []);
  await host.proveWithdraw(fixtureArgs(CV));
  host.stop();
  host.stop();
  await host.proveWithdraw(fixtureArgs(CV));
  assert.deepEqual(s.log, ["start 1", "load 1 withdraw", "prove 1 withdraw", "stop 1", "start 2", "load 2 withdraw", "prove 2 withdraw"]);
});

test("stop() refuses the proof in the worker and every proof queued before it, and starts no worker", async () => {
  // a worker whose proof waits until it is ended, as client.ts's does
  const log: string[] = [];
  let n = 0;
  const start = (): Prover => {
    const k = ++n;
    let end: (e: Error) => void = () => {};
    log.push(`start ${k}`);
    return {
      async load(c) {
        log.push(`load ${k} ${c}`);
      },
      prove(c) {
        log.push(`prove ${k} ${c}`);
        return new Promise((_, fail) => (end = fail));
      },
      terminate() {
        log.push(`stop ${k}`);
        end(new Error("prover worker: terminated"));
      },
    };
  };
  const host = proverHost(start);
  const dead = (e: unknown) => isProverDead(e);
  // a proof that is still waiting after 200 ms was not refused: fail, not hang
  const soon = (p: Promise<unknown>) =>
    Promise.race([p, new Promise((_, fail) => setTimeout(() => fail(new Error("still running")), 200))]);
  // three asked, stop() before any starts
  const three = [host.proveWithdraw(fixtureArgs(CV)), host.proveWithdraw(fixtureArgs(CV)), host.proveWithdraw(fixtureArgs(CV))];
  host.stop();
  for (const p of three) await assert.rejects(soon(p), dead);
  assert.equal(log.length, 0, `no worker started: ${log.join(", ")}`);
  // one running in the worker and two queued behind it: all three refused, no second worker
  const more = [host.proveWithdraw(fixtureArgs(CV)), host.proveWithdraw(fixtureArgs(CV)), host.proveWithdraw(fixtureArgs(CV))];
  for (let i = 0; i < 50 && !log.includes("prove 1 withdraw"); i++) await new Promise((ok) => setTimeout(ok, 1));
  assert.deepEqual(log, ["start 1", "load 1 withdraw", "prove 1 withdraw"]);
  host.stop();
  for (const p of more) await assert.rejects(soon(p), dead);
  assert.deepEqual(log, ["start 1", "load 1 withdraw", "prove 1 withdraw", "stop 1"]);
  // a proof asked after stop() runs on a new worker
  const after = host.proveWithdraw(fixtureArgs(CV));
  for (let i = 0; i < 50 && !log.includes("prove 2 withdraw"); i++) await new Promise((ok) => setTimeout(ok, 1));
  assert.deepEqual(log.slice(4), ["start 2", "load 2 withdraw", "prove 2 withdraw"]);
  host.stop();
  await assert.rejects(soon(after), dead);
});

test("proofs run one at a time: a second proof asked while one runs waits for it", async () => {
  let running = 0;
  let most = 0;
  const s = starter(() => ({
    prove: async () => {
      most = Math.max(most, ++running);
      await new Promise((ok) => setTimeout(ok, 20));
      running--;
      return { proof: PROOF, publicSignals: [...SIGNALS], proveMs: 1 };
    },
  }));
  const host = proverHost(s.start);
  const all = await Promise.allSettled([host.proveWithdraw(fixtureArgs(CV)), host.proveWithdraw(fixtureArgs(CV, "state-leaf")), host.proveWithdraw(fixtureArgs(CV))]);
  assert.deepEqual(all.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(most, 1);
  assert.deepEqual(s.log, ["start 1", "load 1 withdraw", "prove 1 withdraw", "prove 1 withdraw"]);
});

test("vault (card signpage-pool-notes-2): the proof queue's prover is the same worker, in the same line: its load starts nothing, a worker loads once, a dead one is replaced and loaded again, stop() refuses", async () => {
  let proves = 0;
  const s = starter((n) => (n === 1 ? { prove: async () => (++proves === 3 ? Promise.reject(new Error("prover worker: terminated")) : { proof: PROOF, publicSignals: [...SIGNALS], proveMs: 1 }) } : {}));
  const host = proverHost(s.start);
  await host.vault.load("withdraw");
  assert.deepEqual(s.log, [], "no worker at load");
  await host.vault.prove("withdraw", {});
  await host.proveWithdraw(fixtureArgs(CV));
  assert.deepEqual(s.log, ["start 1", "load 1 withdraw", "prove 1 withdraw", "prove 1 withdraw"], "one worker, loaded once for both paths");
  await assert.rejects(host.vault.prove("withdraw", {}), (e) => isProverDead(e));
  await host.vault.prove("withdraw", {});
  assert.deepEqual(s.log.slice(4), ["prove 1 withdraw", "stop 1", "start 2", "load 2 withdraw", "prove 2 withdraw"], "the new worker loads the circuit again");
  const late = host.vault.prove("withdraw", {});
  host.stop();
  await assert.rejects(late, (e) => isProverDead(e));
  assert.deepEqual(s.log.slice(9), ["stop 2"], "a prove asked before stop() never reaches a worker");
});

// ---- the kit's real startProver (client.ts) on a fake Worker and fetch ----

const SIGN = "https://sign.confidential.unrealized.trade";
type Posted = { cmd: string; id: number; circuit: string };
/** A Worker stand-in speaking worker.js's protocol; `die()` fires the error event client.ts reads as a dead worker. */
class FakeWorker {
  static made: FakeWorker[] = [];
  readonly url: string;
  posted: Posted[] = [];
  inFlight = 0;
  most = 0;
  ended = false;
  private on: Record<string, ((e: unknown) => void)[]> = {};
  constructor(url: string, _o: unknown) {
    this.url = String(url);
    FakeWorker.made.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.on[type] ??= []).push(fn);
  }
  private emit(type: string, e: unknown) {
    for (const fn of this.on[type] ?? []) fn(e);
  }
  die() {
    this.emit("error", { message: "" });
  }
  postMessage(m: Posted) {
    this.posted.push(m);
    this.most = Math.max(this.most, ++this.inFlight);
    setTimeout(() => {
      this.inFlight--;
      if (this.ended) return;
      const value = m.cmd === "load" ? { circuit: m.circuit } : { proof: PROOF, publicSignals: [...SIGNALS], proveMs: 1 };
      this.emit("message", { data: { id: m.id, ok: true, value } });
    }, 10);
  }
  terminate() {
    this.ended = true;
  }
}

test("on the kit's real startProver: one same-origin worker, setup files fetched uncached, a dead worker replaced, one proof at a time", async (t) => {
  const g = globalThis as Record<string, unknown>;
  const saved = { self: g.self, Worker: g.Worker, fetch: g.fetch };
  const fetched: { url: string; init: RequestInit | undefined }[] = [];
  g.self = { location: { origin: SIGN } };
  g.Worker = FakeWorker;
  g.fetch = async (url: string, init?: RequestInit) => (fetched.push({ url: String(url), init }), new Response(new Uint8Array(4)));
  FakeWorker.made = [];
  t.after(() => Object.assign(g, saved));

  const host = proverHost(startProver);
  const two = await Promise.all([host.proveWithdraw(fixtureArgs(CV)), host.proveWithdraw(fixtureArgs(CV))]);
  for (const r of two) assert.deepEqual(r.publicSignals, SIGNALS);
  assert.equal(FakeWorker.made.length, 1);
  const w1 = FakeWorker.made[0]!;
  assert.equal(w1.url, `${SIGN}/prover-worker.js`);
  assert.deepEqual(w1.posted.map((m) => m.cmd), ["load", "prove", "prove"]);
  assert.equal(w1.most, 1, "two proofs were in the worker at once");
  const zk = (n: keyof typeof ZK_SETUP_FILES) => `${SIGN}/assets/zk/${ZK_SETUP_FILES[n].sha256}.${n.split(".").pop()}`;
  assert.deepEqual(fetched.map((f) => f.url).sort(), [zk("withdraw.wasm"), zk("withdraw.zkey")].sort());
  // a file that once came back wrong is fetched from the server again, never from the browser's cache
  for (const f of fetched) assert.deepEqual(f.init, { credentials: "omit", cache: "no-cache" });

  // the worker dies while a proof waits on it: that proof is refused as a dead worker, the next starts a new one
  const p = host.proveWithdraw(fixtureArgs(CV));
  await new Promise((ok) => setTimeout(ok, 0));
  w1.die();
  await assert.rejects(p, (e: unknown) => isProverDead(e));
  assert.equal(w1.ended, true);
  assert.deepEqual((await host.proveWithdraw(fixtureArgs(CV))).publicSignals, SIGNALS);
  assert.equal(FakeWorker.made.length, 2);
  assert.deepEqual(FakeWorker.made[1]!.posted.map((m) => m.cmd), ["load", "prove"]);
  host.stop();
  assert.equal(FakeWorker.made[1]!.ended, true);
});
