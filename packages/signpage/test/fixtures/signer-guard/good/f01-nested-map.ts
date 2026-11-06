// planted (card signer-guard-parser, reviewer variant f01 of 40115c3d), no refusal: the note picked, then each sell
// signed in a .map's callback, as pool-sell.ts:361 signs Solana's wires
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
export const flow = (seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, built: readonly never[]) => {
  const { next } = evmNextNote(seed, scope, [], first, 0n);
  void next;
  return built.map((b) => signEvmSell(k, c, b));
};
