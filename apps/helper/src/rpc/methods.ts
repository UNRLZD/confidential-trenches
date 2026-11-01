// POST /v1/rpc/{chain}'s fixed lists (markets paper H7 row and 7.1's LD1 additions, M:3275 and M:3335): the method
// allowlist per chain, the batch size and the body limit. They are the kit's HELPER_RPC_METHODS, HELPER_RPC_BATCH_MAX
// and the /v1/rpc/{chain} row of HELPER_V1_PATHS (packages/kit/src/helper/v1.ts), written again here because the image
// is built from apps/helper alone. rpc.test.ts compares them with the kit's public entry, so the allowlist changes only
// through the kit file: an edit here alone, or there alone, fails that test.
export const RPC_CHAINS = ["solana", "base", "robinhood", "near"] as const;
export type RpcChain = (typeof RPC_CHAINS)[number];

const EVM = [
  "eth_call",
  "eth_simulateV1",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_feeHistory",
  "eth_blockNumber",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_estimateGas",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
] as const;

export const RPC_METHODS: Readonly<Record<RpcChain, readonly string[]>> = {
  solana: [
    "getAccountInfo",
    "getMultipleAccounts",
    "getBalance",
    "getTokenAccountsByOwner",
    "getTokenLargestAccounts",
    "getLatestBlockhash",
    "simulateTransaction",
    "sendTransaction",
    "getSignatureStatuses",
    "getTransaction",
    "getBlockHeight",
    "getMinimumBalanceForRentExemption",
  ],
  base: EVM,
  robinhood: EVM,
  near: ["query", "block", "gas_price", "tx", "send_tx", "EXPERIMENTAL_tx_status", "EXPERIMENTAL_protocol_config"],
};

/** A batch holds 1 to this many requests. */
export const RPC_BATCH_MAX = 10;
/** H7 "body 256 KB". */
export const RPC_BODY_MAX = 262_144;
