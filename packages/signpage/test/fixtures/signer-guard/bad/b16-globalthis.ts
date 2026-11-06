// planted (card signer-guard-parser, reviewer variant b16-globalthis of 1a8a42f0): a file that calls evmNextNote
// somewhere (so it read as guarded) puts the signer on globalThis, and a call through globalThis reaches it unseen
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";

export const pick = (seed: Uint8Array, scope: bigint, first: never) => evmNextNote(seed, scope, [], first, 0n);
(globalThis as unknown as { __s: unknown }).__s = signEvmSell;
export const send = (k: Uint8Array, c: never, b: never) => (globalThis as any).__s(k, c, b);
