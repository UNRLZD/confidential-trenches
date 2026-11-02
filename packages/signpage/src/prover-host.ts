// SIGN_HOST's one prover (card signpage-prover-host; vault.md 2.14, M304 D-8, wallet.md W:880-882). The prover runs
// here and nowhere else: SIGN_HOST's policy is the only one with 'wasm-unsafe-eval', worker-src 'self' and the Trusted
// Types policy prover-worker (public/_headers), and APP_HOST's never has the first. Its worker, /prover-worker.js (the
// kit's build.mjs, written into public/ by scripts/build-app.mjs), and the six setup files at
// /assets/zk/<sha256>.<ext> (copied by the deploy build) are served from SIGN_HOST's own origin, never another.
// - The worker starts at the first proof whose input the kit accepts, never at page load, so the Trusted Types policy
//   prover-worker is made only then, once per page (the kit's client.ts; the CSP allows no duplicate).
// - One worker serves every proof on the page and loads the withdraw setup files once (the kit's prove.ts), each
//   checked by size and sha256 in the worker before snarkjs sees it.
// - A worker that died (client.ts then rejects every call with "prover worker: ...") is ended and dropped; the next
//   proof starts a new one, which loads the files again. Any other refusal keeps the worker.
// - Every proof is the kit's vaultProveWithdraw: it refuses an input the vault would refuse before the worker sees it,
//   and a worker answer that is not that input's.
// Nothing here logs: the input holds the note's secrets.
import { startProver, type Prover, type ProverOptions } from "../../kit/src/prover/client.ts";
import { vaultProveWithdraw, type VaultProver, type VaultWithdrawProof } from "../../kit/src/prover/prove.ts";
import type { VaultWithdrawInputArgs } from "../../kit/src/vault/inputs.ts";

export interface ProverHost {
  /** A withdraw proof from the device's leaves, made in this page's prover worker. */
  proveWithdraw(args: VaultWithdrawInputArgs): Promise<VaultWithdrawProof>;
  /** Ends the worker, if one runs, and frees its setup files; the next proof starts a new one. */
  stop(): void;
}

// one worker's life: started at its first call, so an input refused before any load or prove starts nothing
type Generation = VaultProver & { stop(): void };
function generation(start: (o: ProverOptions) => Prover): Generation {
  let worker: Prover | null = null;
  const get = () => (worker ??= start({}));
  return {
    load: (c) => get().load(c),
    prove: (c, i) => get().prove(c, i),
    stop: () => worker?.terminate(),
  };
}

const DEAD = "prover worker: "; // client.ts's failAll: failed to load, a reply could not be read, terminated

/** The page's prover; `start` is the kit's startProver but in tests. */
export function proverHost(start: (o: ProverOptions) => Prover = startProver): ProverHost {
  let gen: Generation | null = null;
  const drop = (g: Generation) => {
    if (gen !== g) return;
    gen = null;
    g.stop();
  };
  return {
    async proveWithdraw(args) {
      const g = (gen ??= generation(start));
      try {
        return await vaultProveWithdraw(g, args);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith(DEAD)) drop(g);
        throw e;
      }
    },
    stop() {
      if (gen) drop(gen);
    },
  };
}
