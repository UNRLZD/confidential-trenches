// The EVM pool buy as the kit's index exports it (card evm-pool-buy-tx; merge notes M366, M370; card
// evm-pool-buy-quote): the builder takes only a device quote (evmPoolBuildQuoted), the signer only its builds, and both
// take only the chain's pinned adapters and pool (evmPoolVenues(); not_deployed until pool-evm-deploy pins
// them, not_pinned for any other). The checks, the encoding and the digest are in buy-unpinned.ts, which the index
// does not export.
import {
  EvmPoolBuyError,
  evmPoolVenues,
  pinnedBuild,
  pinnedSignBuy,
  type EvmPoolBuy,
  type EvmPoolChain,
  type EvmPoolProofBinding,
} from "./buy-unpinned.ts";
import { EVM_QUOTE_MAX_AGE_MS, EvmQuoteError, evmIsDeviceQuote, type EvmPoolBuyQuote } from "../../checks/evm/quote.ts";

export {
  EVM_POOL_MAX_HOOK_DATA,
  EVM_POOL_MAX_HOPS,
  EvmPoolBuyError,
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

// Every buy evmPoolBuildQuoted returned: W signs no other (review of b17d1fc, item 4). The kit exports no builder that
// takes a minOut from its caller.
const QUOTED_BUILDS = new WeakSet<EvmPoolBuy>();

/** W's signature of the pool's Buy for `built` and `proof` on `pool`, the chain's pinned pool: only of a buy
 *  evmPoolBuildQuoted returned (not_built otherwise; see buy-unpinned.ts evmPoolSignBuyUnpinned). */
export function evmPoolSignBuy(secretKey: Uint8Array, chain: EvmPoolChain, pool: string, built: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  if (!QUOTED_BUILDS.has(built)) throw new EvmPoolBuyError("not_built", "W signs only a buy evmPoolBuildQuoted returned");
  return pinnedSignBuy(evmPoolVenues(), secretKey, chain, pool, built, proof);
}

/** The buy a device quote holds (checks/evm/quote.ts evmPoolBuyQuote): its chain, route, token and minOut, through
 *  `adapter`, the chain's pinned adapter for the route's venue. Only a quote evmPoolBuyQuote returned is built, so W
 *  signs a buy only at a minOut from the device's own reads (card evm-pool-buy-quote). */
export function evmPoolBuildQuoted(adapter: string, quote: EvmPoolBuyQuote): EvmPoolBuy {
  if (!evmIsDeviceQuote(quote)) throw new EvmQuoteError("bad_request", "a buy is built only from a quote evmPoolBuyQuote returned");
  // a quote whose block is more than 30 s behind the device's clock builds nothing; no caller sets the clock
  const nowMs = Date.now();
  if (!Number.isFinite(nowMs) || nowMs - Number(quote.block.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) {
    throw new EvmQuoteError("stale_quote", "the quote's block is more than 30 s old");
  }
  const built = pinnedBuild(evmPoolVenues(), quote.chain, adapter, quote.route, quote.minOut, quote.token);
  QUOTED_BUILDS.add(built);
  return built;
}
