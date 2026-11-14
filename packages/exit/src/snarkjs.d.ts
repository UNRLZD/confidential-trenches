// snarkjs ships no types: the one call the exit's prover makes (./prover.ts), as the kit's browser worker makes it
// (packages/kit/src/prover/worker.js).
declare module "snarkjs" {
  export const groth16: {
    fullProve(input: unknown, wasm: Uint8Array, zkey: Uint8Array, logger: undefined, wtns: undefined, options: { singleThread: boolean }): Promise<{ proof: unknown; publicSignals: string[] }>;
  };
}
