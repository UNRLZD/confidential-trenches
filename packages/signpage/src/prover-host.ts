// SIGN_HOST's one prover (card signpage-prover-host; vault.md 2.14, M304 D-8, wallet.md W:880-882). The prover runs
// here and nowhere else: SIGN_HOST's policy is the only one with 'wasm-unsafe-eval', worker-src 'self' and the Trusted
// Types policy prover-worker (public/_headers), and APP_HOST's never has the first. Its worker, /prover-worker.js (the
// kit's build.mjs, written into public/ by scripts/build-app.mjs), and the six setup files at
// /assets/zk/<sha256>.<ext> (copied by the deploy build) are served from SIGN_HOST's own origin, never another.
// - The worker starts at the first proof whose input the kit accepts, never at page load, so the Trusted Types policy
//   prover-worker is made only then, once per page (the kit's client.ts; the CSP allows no duplicate).
// - One worker serves every proof on the page and loads the withdraw setup files once (the kit's prove.ts), each
//   checked by size and sha256 in the worker before snarkjs sees it.
// - A worker that died (the kit's isProverDead reads it from the refusal) is ended and dropped; the next proof starts a
//   new one, which loads the files again. Any other refusal keeps the worker.
// - Proofs run one at a time, in the order asked: two at once in one worker only raise a phone's peak memory.
// - stop() refuses the proof in the worker and every proof asked before it, so none of them starts a worker after it;
//   a proof asked after stop() runs on a new worker.
// - Every proof is the kit's vaultProveWithdraw: it refuses an input the vault would refuse before the worker sees it,
//   and a worker answer that is not that input's. The proof queue's (card signpage-pool-notes-2) are the kit's
//   poolProveWithdraw through `vault`, the same worker as a VaultProver: its load starts nothing, each prove runs in the
//   same one-at-a-time line, loads the circuit on the worker that runs it (once per worker), and is refused by stop().
// Nothing here logs: the input holds the note's secrets.
import { isProverDead, PROVER_DEAD_PREFIX, startProver, type Prover, type ProverCircuit, type ProverOptions } from "../../kit/src/prover/client.ts";
import { vaultProveWithdraw, type VaultProver, type VaultWithdrawProof } from "../../kit/src/prover/prove.ts";
import type { VaultWithdrawInputArgs } from "../../kit/src/vault/inputs.ts";

export interface ProverHost {
  /** A withdraw proof from the device's leaves, made in this page's prover worker. */
  proveWithdraw(args: VaultWithdrawInputArgs): Promise<VaultWithdrawProof>;
  /** The same worker as a VaultProver, for the proof queue (the kit's poolProveWithdraw). */
  vault: VaultProver;
  /** Ends the worker, if one runs, and frees its setup files; the next proof starts a new one. */
  stop(): void;
}

// one worker's life: started at its first call, so an input refused before any load or prove starts nothing
type Generation = VaultProver & { stop(): void };
function generation(start: (o: ProverOptions) => Prover): Generation {
  let worker: Prover | null = null;
  const get = () => (worker ??= start({}));
  // one load per circuit per worker, whichever path asks first; a failed load is dropped, so the next asks again
  const loads = new Map<ProverCircuit, Promise<void>>();
  return {
    load: (c) => {
      let p = loads.get(c);
      if (p === undefined) {
        const q = get().load(c);
        loads.set(c, q);
        q.catch(() => loads.get(c) === q && loads.delete(c));
        p = q;
      }
      return p;
    },
    prove: (c, i) => get().prove(c, i),
    stop: () => worker?.terminate(),
  };
}

// the refusal a proof asked before stop() gets: the kit's isProverDead reads it as a worker that was ended
const stopped = () => new Error(`${PROVER_DEAD_PREFIX}terminated`);

/** The page's prover; `start` is the kit's startProver but in tests. */
export function proverHost(start: (o: ProverOptions) => Prover = startProver): ProverHost {
  let gen: Generation | null = null;
  let queue: Promise<unknown> = Promise.resolve(); // the proof before this one, settled either way
  let epoch = 0; // stop() moves it on: a proof asked in an earlier epoch is refused before it starts
  const drop = (g: Generation) => {
    if (gen !== g) return;
    gen = null;
    g.stop();
  };
  // one step on the worker, after every step asked before it; refused when stop() came after it was asked
  const step = <T>(f: (g: Generation) => Promise<T>): Promise<T> => {
    const asked = epoch;
    const run = async () => {
      if (asked !== epoch) throw stopped();
      const g = (gen ??= generation(start));
      try {
        return await f(g);
      } catch (e) {
        if (isProverDead(e)) drop(g);
        throw e;
      }
    };
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  };
  return {
    proveWithdraw: (args) => step((g) => vaultProveWithdraw(g, args)),
    vault: {
      // the kit loads once per VaultProver; the worker that runs the prove loads it (a replaced worker again)
      load: async () => {},
      prove: (c, input) =>
        step(async (g) => {
          await g.load(c);
          return g.prove(c, input);
        }),
    },
    stop() {
      epoch++;
      if (gen) drop(gen);
    },
  };
}
