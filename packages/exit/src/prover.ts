// The exit tool's prover (card exit-with-only-the-words): the withdraw circuit's proof in Node, made by snarkjs on the
// setup files ./setup.ts fetches and checks byte for byte against the kit's pins, with no server of ours. It is a
// VaultProver, so the kit's vaultProveWithdraw and poolProveWithdraw check its answer as they check the browser
// worker's: public signals exactly the input's, the proof in the affine form the vault and the pools parse.
import type { VaultProver } from "@blindfill/kit";

/** The Node prover: snarkjs on the withdraw setup files, each checked against the kit's sha256 pin (./setup.ts), loaded once. */
export async function exitProver(): Promise<VaultProver> {
  const { exitSetupFiles } = await import("./setup.ts");
  // snarkjs ships no types
  const snarkjs = (await import("snarkjs" as string)) as { groth16: { fullProve(i: unknown, w: unknown, z: unknown): Promise<{ proof: unknown; publicSignals: string[] }> } };
  let files: Map<string, Uint8Array> | null = null;
  return {
    async load(circuit) {
      if (circuit !== "withdraw") throw new Error("the exit proves withdrawals only");
      files ??= await exitSetupFiles(["withdraw.wasm", "withdraw.zkey"]);
    },
    async prove(circuit, input) {
      if (circuit !== "withdraw" || files === null) throw new Error("load the withdraw files first");
      const t = performance.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, { type: "mem", data: files.get("withdraw.wasm") }, { type: "mem", data: files.get("withdraw.zkey") });
      return { proof: proof as never, publicSignals, proveMs: Math.round(performance.now() - t) };
    },
  };
}

