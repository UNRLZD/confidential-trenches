// planted (card signer-guard-parser, review of 40115c3d, L1): the pick runs after the signature, under a short circuit,
// and in a callback of its own: none runs before the sell is signed
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
export const late = (seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never) => {
  const sig = signEvmSell(k, c, b);
  evmNextNote(seed, scope, [], first, 0n);
  return sig;
};
export const short = (ok: boolean, seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never) => {
  void (ok && evmNextNote(seed, scope, [], first, 0n));
  return signEvmSell(k, c, b);
};
export const later = (seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never) => {
  const pick = () => evmNextNote(seed, scope, [], first, 0n);
  void pick;
  return signEvmSell(k, c, b);
};
