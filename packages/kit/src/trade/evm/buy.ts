// The EVM pool buy as the kit's index exports it (card evm-pool-buy-tx; merge notes M366, M370): the builder and the
// signer take only the chain's pinned adapters and pool (evmPoolVenues(); not_deployed until pool-evm-deploy pins
// them, not_pinned for any other). The checks, the encoding and the digest are in buy-unpinned.ts, which the index
// does not export.
import {
  evmPoolVenues,
  pinnedBuild,
  pinnedSignBuy,
  type EvmPoolBuy,
  type EvmPoolChain,
  type EvmPoolProofBinding,
  type EvmRoute,
} from "./buy-unpinned.ts";

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

/** The buy of `token`, the token the user picked, for `route` through `adapter`, the chain's pinned adapter for the
 *  route's venue, with at least `minOut` of it for W (see buy-unpinned.ts evmPoolBuildUnpinned for every check). */
export function evmPoolBuild(chain: EvmPoolChain, adapter: string, route: EvmRoute, minOut: bigint, token: string): EvmPoolBuy {
  return pinnedBuild(evmPoolVenues(), chain, adapter, route, minOut, token);
}

/** W's signature of the pool's Buy for `built` and `proof` on `pool`, the chain's pinned pool (see buy-unpinned.ts
 *  evmPoolSignBuyUnpinned). */
export function evmPoolSignBuy(secretKey: Uint8Array, chain: EvmPoolChain, pool: string, built: EvmPoolBuy, proof: EvmPoolProofBinding): Uint8Array {
  return pinnedSignBuy(evmPoolVenues(), secretKey, chain, pool, built, proof);
}
