// planted (card signer-guard-parser, reviewer variant k6 of c00a169d): a closure made before the pick and called both
// before and after it
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
export const flow = (seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never) => {
  const later = () => signEvmSell(k, c, b);
  const now = later();
  evmNextNote(seed, scope, [], first, 0n);
  return [now, later()];
};
