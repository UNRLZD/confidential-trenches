// The EVM pool buy as the kit's index exports it (card evm-pool-buy-tx; merge notes M366, M370; card
// evm-pool-buy-quote): the builder takes only a device quote (evmPoolBuildQuoted), the signer only its builds, and both
// take only the chain's pinned adapters and pool (evmPoolVenues(); not_deployed until pool-evm-deploy pins
// them, not_pinned for any other). The checks, the encoding and the digest are in buy-unpinned.ts, which the index
// does not export.
import {
  EvmPoolBuyError,
  evmPoolVenues,
  pinnedSignBuy,
  type EvmPoolBuy,
  type EvmPoolChain,
  type EvmPoolProofBinding,
} from "./buy-unpinned.ts";
import { type EvmPoolBuyQuote } from "../../checks/evm/quote.ts";
import { evmIsQuotedBuy, evmQuotedBuy } from "./quoted.ts";

export {
  EVM_POOL_MAX_HOOK_DATA,
  EVM_POOL_MAX_HOPS,
  EvmPoolBuyError,
  evmPoolProvidersOf,
  evmPoolRouteData,
  evmPoolVenues,
  type EvmPoolBuy,
  type EvmPoolBuyErrorCode,
  type EvmPoolChain,
  type EvmPoolProofBinding,
  type EvmPoolVenue,
  type EvmRoute,
  type EvmV3Route,
  type EvmV4Hop,
  type EvmV4Route,
} from "./buy-unpinned.ts";
// who runs an EVM RPC, the one rule every RPC pair is held to (card robinhood-mainnet-rpcs, review L-2)
export { EVM_RPC_OPERATORS, evmRpcOperator } from "./rpc-operator.ts";

// W signs only a buy evmPoolBuildQuoted returned (review of b17d1fc, item 4; quoted.ts holds the record). The kit
// exports no builder that takes a minOut from its caller.

/** W's signature of the pool's Buy for `built` and `proof` on `pool`, the chain's pinned pool: only of a buy
 *  evmPoolBuildQuoted returned (not_built otherwise; see buy-unpinned.ts evmPoolSignBuyUnpinned). */
export function evmPoolSignBuy(secretKey: Uint8Array, chain: EvmPoolChain, pool: string, built: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  if (!evmIsQuotedBuy(built)) throw new EvmPoolBuyError("not_built", "W signs only a buy evmPoolBuildQuoted returned");
  return pinnedSignBuy(evmPoolVenues(), secretKey, chain, pool, built, proof);
}

/** The buy a device quote holds (checks/evm/quote.ts evmPoolBuyQuote): its chain, route, token and minOut, through
 *  `adapter`, the chain's pinned adapter for the route's venue. Only a quote evmPoolBuyQuote returned, whose block is
 *  at most 30 s behind the device's clock, is built, so W signs a buy only at a minOut from the device's own reads
 *  (card evm-pool-buy-quote; see quoted.ts evmQuotedBuy). */
export function evmPoolBuildQuoted(adapter: string, quote: EvmPoolBuyQuote): EvmPoolBuy {
  // no caller sets the clock
  return evmQuotedBuy(evmPoolVenues(), adapter, quote, Date.now());
}
