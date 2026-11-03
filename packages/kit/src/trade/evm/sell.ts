// The EVM sell as the kit's index exports it (card evm-pool-sell-tx; merge notes M363, M366, M370): W's proceeds go
// only to the chain's pinned pool and W delegates only to the chain's pinned sell delegate (evmPoolVenues();
// not_deployed until pool-evm-deploy pins them). The checks, the encoding and both digests are in sell-unpinned.ts,
// which the index does not export.
import { evmPoolVenues, type EvmPoolChain } from "./buy-unpinned.ts";
import {
  pinnedBuildSell,
  pinnedSignSell,
  pinnedSignSellAuthorization,
  type EvmPoolSell,
  type EvmPoolSellAuthorization,
  type EvmPoolSellRequest,
} from "./sell-unpinned.ts";

export {
  EVM_POOL_SELL_DEADLINE_MAX_S,
  EVM_POOL_SELL_DEADLINE_MIN_S,
  EvmPoolSellError,
  type EvmPoolSell,
  type EvmPoolSellAuthorization,
  type EvmPoolSellErrorCode,
  type EvmPoolSellRequest,
} from "./sell-unpinned.ts";

/** The sell W asked for on `chain`, into the chain's pinned pool (see sell-unpinned.ts evmPoolBuildSellUnpinned). */
export function evmPoolBuildSell(chain: EvmPoolChain, req: EvmPoolSellRequest): EvmPoolSell {
  return pinnedBuildSell(evmPoolVenues(), chain, req);
}

/** W's signature of `built`, a sell into the chain's pinned pool (see sell-unpinned.ts evmPoolSignSellUnpinned). */
export function evmPoolSignSell(secretKey: Uint8Array, chain: EvmPoolChain, built: EvmPoolSell): Uint8Array {
  return pinnedSignSell(evmPoolVenues(), secretKey, chain, built);
}

/** W's EIP-7702 authorization of the chain's pinned sell delegate at W's account nonce `nonce`. */
export function evmPoolSignSellAuthorization(secretKey: Uint8Array, chain: EvmPoolChain, nonce: bigint): EvmPoolSellAuthorization {
  return pinnedSignSellAuthorization(evmPoolVenues(), secretKey, chain, nonce);
}
