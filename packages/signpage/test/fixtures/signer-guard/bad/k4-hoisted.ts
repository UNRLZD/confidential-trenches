// planted (card signer-guard-parser, reviewer variant k4 of c00a169d): a hoisted function signs before the pick above
// its declaration runs
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
export const flow = (seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never) => {
  const early = s();
  evmNextNote(seed, scope, [], first, 0n);
  function s() { return signEvmSell(k, c, b); }
  return early;
};
