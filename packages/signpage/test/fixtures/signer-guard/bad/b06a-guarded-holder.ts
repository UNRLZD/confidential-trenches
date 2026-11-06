// planted (card signer-guard-parser, reviewer variant b06a-guarded-holder of 1a8a42f0)
// a file that calls evmNextNote somewhere (so it is "guarded") and hands the signer on in an array
import { signEvmSell } from "../../../../../../packages/signpage/src/rules/pool.ts";
import { evmNextNote } from "../../../../../../packages/wallet/src/pool/evm-restore.ts";
export const pick = (seed: Uint8Array, scope: bigint, first: never) => evmNextNote(seed, scope, [], first, 0n);
export const steps = [signEvmSell] as const;
export const getSigner = () => signEvmSell;
