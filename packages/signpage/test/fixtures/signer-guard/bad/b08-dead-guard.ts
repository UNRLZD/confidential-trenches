// planted (card signer-guard-parser, reviewer variant b08-dead-guard of 1a8a42f0)
import { signEvmSell } from "../../../../../../packages/signpage/src/rules/pool.ts";
import { evmNextNote } from "../../../../../../packages/wallet/src/pool/evm-restore.ts";
function never(seed: Uint8Array, scope: bigint, first: never) { return evmNextNote(seed, scope, [], first, 0n); }
void never;
export const send = (k: Uint8Array, c: never, b: never) => signEvmSell(k, c, b);
