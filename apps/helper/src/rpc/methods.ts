// POST /v1/rpc/{chain}'s fixed lists (markets paper H7 row and 7.1's LD1 additions, M:3275 and M:3335): the chains, the
// method allowlist per chain, the batch size and the body limit. Each is the kit's, imported from its public entry:
// CHAINS (packages/kit/src/orders/record.ts), HELPER_RPC_METHODS, HELPER_RPC_BATCH_MAX and the /v1/rpc/{chain} row of
// HELPER_V1_PATHS (packages/kit/src/helper/v1.ts), so the allowlist changes only through the kit.
import { CHAINS, HELPER_RPC_BATCH_MAX, HELPER_RPC_METHODS, HELPER_V1_PATHS, type Chain, type HelperV1Path } from "@blindfill/kit";

export const RPC_CHAINS = CHAINS;
export type RpcChain = Chain;

export const RPC_METHODS: Readonly<Record<RpcChain, readonly string[]>> = HELPER_RPC_METHODS;

/** A batch holds 1 to this many requests. */
export const RPC_BATCH_MAX = HELPER_RPC_BATCH_MAX;

/** H7 "body 256 KB". */
export const RPC_BODY_MAX = HELPER_V1_PATHS.find((r): r is Extract<HelperV1Path, { path: "/v1/rpc/{chain}" }> => r.path === "/v1/rpc/{chain}")!.limitBytes;
