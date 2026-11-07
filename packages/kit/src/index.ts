// The kit's public entry: the only file of Blindfill an app imports (CLAUDE.md, Rules for changes).
export * from "./signpage/messages.ts";
export * from "./orders/record.ts";
export * from "./helper/v1.ts";
export * from "./zk/setup-files.ts";
export * from "./checks/solana/index.ts";
export * from "./vault/shapes.ts";
export * from "./checks/oneclick.ts";
// the device's EVM quote on its pinned providers; evmPoolBuyQuoteWith (any providers, any clock) stays inside the kit
export {
  EVM_NOOP_HOOK_CODE,
  EVM_QUOTE_MAX_AGE_MS,
  EVM_QUOTE_MAX_HINTS,
  EVM_SELL_PROBE_CODE,
  evmBuyRevertedPools,
  evmIsDeviceQuote,
  evmIsDeviceSellQuote,
  evmPoolBuyQuote,
  evmPoolSellQuote,
  evmSellRevertedPools,
  EvmQuoteError,
  type EvmHookTake,
  type EvmPoolBuyQuote,
  type EvmPoolBuyQuoteRequest,
  type EvmPoolSellQuote,
  type EvmPoolSellQuoteRequest,
  type EvmPoolKey,
  type EvmQuoteErrorCode,
} from "./checks/evm/quote.ts";
export * from "./signpage/client.ts";
export * from "./signpage/wallets.ts";
export * from "./vault/messages.ts";
export * from "./prover/prove.ts";
export { isProverDead, PROVER_DEAD_PREFIX } from "./prover/client.ts";
export * from "./vault/inputs.ts";
export * from "./vault/sync.ts";
export * from "./trade/solana/send.ts";
export * from "./trade/solana/build.ts";
export * from "./trade/solana/flow.ts";
export * from "./trade/solana/pool.ts";
export * from "./trade/solana/pool-buy.ts";
// the same-chain pool deposit of one note of the ladder plan (card pool-deposits)
export * from "./trade/solana/pool-deposit.ts";
export * from "./trade/evm/pool-fee.ts";
export * from "./trade/evm/buy.ts";
export * from "./trade/evm/sell.ts";
// the pins the helper's EVM pool sender sends a sale with (card helper-evm-sender), which the device's sim copies: the
// sale's gas, its tip per chain and the authorization's intrinsic gas (no digest: the helper writes its own); and the
// one reading of a signed sale's target and data as a route the builder makes, which the helper sends only on
export { EVM_7702_AUTH_GAS, EVM_POOL_SELL_GAS, evmPoolSellTip, evmSellRouteOf, type EvmSignedSellCall } from "./trade/evm/sell-unpinned.ts";
export { nearPairNetwork, nearPairRule, type NearNetwork } from "./near/networks.ts";
export * from "./price/pool-usd.ts";
