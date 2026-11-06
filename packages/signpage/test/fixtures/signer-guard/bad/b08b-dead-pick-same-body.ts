// planted (card signer-guard-parser, reviewer variant b08b of 40115c3d): the pick sits in the signer's own function but
// never runs (a dead if), so the sell signs on a precommitment no pick named
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
export const send = (seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never) => {
  if (Math.random() < 0) evmNextNote(seed, scope, [], first, 0n);
  return signEvmSell(k, c, b);
};
