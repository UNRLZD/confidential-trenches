// The EVM sell as the kit's index exports it (card evm-pool-sell-tx; merge notes M363, M366, M370; card
// evm-sell-device-quote): the builder takes only the device's own sell quote (checks/evm/quote.ts evmPoolSellQuote:
// the pool, the route, the target and minOut all from the device's reads, never a route from a server or a caller),
// within 30 s of its block, and the signer only its builds. W's proceeds go only to the chain's pinned pool and W
// delegates only to the chain's pinned sell delegate (evmPoolVenues(); not_deployed until pool-evm-deploy pins them).
// The checks, the encoding and both digests are in sell-unpinned.ts, which the index does not export.
import { evmPoolVenues, type EvmPoolChain } from "./buy-unpinned.ts";
import {
  EvmPoolSellError,
  pinnedSignSell,
  pinnedSignSellAuthorization,
  pinnedSignSimSell,
  type EvmPoolSell,
  type EvmSellSim,
  type EvmPoolSellAuthorization,
} from "./sell-unpinned.ts";
import { type EvmPoolSellQuote } from "../../checks/evm/quote.ts";
import { evmIsQuotedSell, evmQuotedSell, type EvmPoolSellFields } from "./quoted.ts";

export {
  EVM_POOL_SELL_DEADLINE_MAX_S,
  EVM_POOL_SELL_DEADLINE_MIN_S,
  EvmPoolSellError,
  EVM_SELL_SIM,
  type EvmPoolSell,
  type EvmPoolSellAuthorization,
  type EvmPoolSellErrorCode,
  type EvmSellSim,
  type EvmSellRoute,
  type EvmV4SellRoute,
} from "./sell-unpinned.ts";

export type { EvmPoolSellFields } from "./quoted.ts";

// W signs only a sell evmPoolBuildSell returned (quoted.ts holds the record). The kit exports no builder that takes a
// route or a minOut.

/** The sell a device quote holds (its chain, W, token, amount, route, target and minOut), into the chain's pinned pool,
 *  with `fields` (see sell-unpinned.ts evmPoolBuildSellUnpinned for every check). Only a quote evmPoolSellQuote
 *  returned, whose block is at most 30 s behind the device's clock, is built, at a fee cap within the quote's feeMax
 *  (see quoted.ts evmQuotedSell). */
export function evmPoolBuildSell(quote: EvmPoolSellQuote, fields: EvmPoolSellFields): EvmPoolSell {
  // no caller sets the clock
  return evmQuotedSell(evmPoolVenues(), quote, fields, Date.now());
}

/** W's signature of `built`, a sell evmPoolBuildSell returned, into the chain's pinned pool (not_built otherwise; see
 *  sell-unpinned.ts evmPoolSignSellUnpinned). */
export function evmPoolSignSell(secretKey: Uint8Array, chain: EvmPoolChain, built: EvmPoolSell): Uint8Array {
  if (!evmIsQuotedSell(built)) throw new EvmPoolSellError("not_built", "W signs only a sell evmPoolBuildSell returned");
  return pinnedSignSell(evmPoolVenues(), secretKey, chain, built);
}

/** W's EIP-7702 authorization of the chain's pinned sell delegate at W's account nonce `nonce`. */
export function evmPoolSignSellAuthorization(secretKey: Uint8Array, chain: EvmPoolChain, nonce: bigint): EvmPoolSellAuthorization {
  return pinnedSignSellAuthorization(evmPoolVenues(), secretKey, chain, nonce);
}

/** W's signature of a sim sell the device's sell quote built (card evm-quote-exec-sim), only where its pool is
 *  EVM_SELL_SIM and its deadline <= `blockTimestamp` (the quote's agreed block's) <= the device's clock: a signature that
 *  can never land (see sell-unpinned.ts). */
export function evmPoolSignSimSell(secretKey: Uint8Array, chain: EvmPoolChain, sim: EvmSellSim, blockTimestamp: bigint): Uint8Array {
  // no caller sets the clock
  return pinnedSignSimSell(evmPoolVenues(), secretKey, chain, sim, blockTimestamp, Date.now());
}
