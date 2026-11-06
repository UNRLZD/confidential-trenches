// planted (card signer-guard-parser, reviewer variant f03 of 40115c3d), no refusal: the note picked, then the sell
// signed inside a lock's callback, as pool-sell.ts:699-700 runs its sell under locks.request
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
export const flow = async (locks: { request: (n: string, f: () => Promise<Uint8Array>) => Promise<Uint8Array> }, seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never) => {
  evmNextNote(seed, scope, [], first, 0n);
  return locks.request("sell", async () => signEvmSell(k, c, b));
};
