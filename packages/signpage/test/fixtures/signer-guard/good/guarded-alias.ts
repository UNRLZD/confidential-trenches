// planted (card signer-guard-parser), no refusal: the rule's signer by an alias, its note picked by the wallet's
// evmNextNote under an alias too
import { signEvmSell as sign } from "../../../../src/rules/pool.ts";
import { evmNextNote as pickNote } from "../../../../../wallet/src/pool/evm-restore.ts";

export const send = (seed: Uint8Array, scope: bigint, first: never, key: Uint8Array, ctx: never, built: never) => {
  const { next } = pickNote(seed, scope, [], first, 0n);
  void next;
  return sign(key, ctx, built);
};
