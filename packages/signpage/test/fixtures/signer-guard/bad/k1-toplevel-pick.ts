// planted (card signer-guard-parser, reviewer variant k1 of c00a169d, L1): one pick at module load, then a function
// that signs every time it is called: the pick ran once, not before each sell
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
declare const seed: Uint8Array, scope: bigint, first: never;
evmNextNote(seed, scope, [], first, 0n);
export const send = (k: Uint8Array, c: never, b: never) => signEvmSell(k, c, b);
