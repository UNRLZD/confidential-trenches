// SIGN_HOST's one prover (src/prover-host.ts), card signpage-prover-host.
//   node --test test/prover-host.test.ts      (from packages/signpage)
// The worker starts at the first proof that passes the kit's input checks, never before; one worker serves every proof
// and loads the withdraw setup files once; a worker that died is replaced at the next proof, which loads them again; a
// refused worker answer keeps the worker; stop() ends it. The worker here is a stand-in that answers the fixture's
// signals: the real worker in Chromium under SIGN_HOST's headers is packages/kit/test/prove-e2e.test.ts's
// (KIT_PROVER_E2E=1) and the live check scripts/live-checks/signpage-prover-host.mjs's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Prover, ProverOptions } from "../../kit/src/prover/client.ts";
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
