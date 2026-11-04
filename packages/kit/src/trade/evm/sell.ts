// The EVM sell as the kit's index exports it (card evm-pool-sell-tx; merge notes M363, M366, M370; card
// evm-sell-device-quote): the builder takes only the device's own sell quote (checks/evm/quote.ts evmPoolSellQuote:
// the pool, the route, the target and minOut all from the device's reads, never a route from a server or a caller),
// within 30 s of its block, and the signer only its builds. W's proceeds go only to the chain's pinned pool and W
// delegates only to the chain's pinned sell delegate (evmPoolVenues(); not_deployed until pool-evm-deploy pins them).
// The checks, the encoding and both digests are in sell-unpinned.ts, which the index does not export.
import { evmPoolVenues, type EvmPoolChain } from "./buy-unpinned.ts";
import {
  EvmPoolSellError,
  pinnedBuildSell,
  pinnedSignSell,
  pinnedSignSellAuthorization,
  pinnedSignSimSell,
  type EvmPoolSell,
  type EvmSellSim,
  type EvmPoolSellAuthorization,
} from "./sell-unpinned.ts";
import { EVM_QUOTE_MAX_AGE_MS, EvmQuoteError, evmIsDeviceSellQuote, type EvmPoolSellQuote } from "../../checks/evm/quote.ts";

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

/** What W adds to a device sell quote: the return note's precommitment, the sender's fee cap, the deadline (unix
 *  seconds) and W's sell nonce. */
export type EvmPoolSellFields = { precommitment: bigint; feeCap: bigint; deadline: bigint; nonce: bigint };

// Every sell evmPoolBuildSell returned: W signs no other. The kit exports no builder that takes a route or a minOut.
const QUOTED_SELLS = new WeakSet<EvmPoolSell>();

/** The sell a device quote holds (its chain, W, token, amount, route, target and minOut), into the chain's pinned pool,
 *  with `fields` (see sell-unpinned.ts evmPoolBuildSellUnpinned for every check). Only a quote evmPoolSellQuote
 *  returned, whose block is at most 30 s behind the device's clock, is built. */
export function evmPoolBuildSell(quote: EvmPoolSellQuote, fields: EvmPoolSellFields): EvmPoolSell {
  if (!evmIsDeviceSellQuote(quote)) throw new EvmQuoteError("bad_request", "a sell is built only from a quote evmPoolSellQuote returned");
  // no caller sets the clock
  const nowMs = Date.now();
  if (!Number.isFinite(nowMs) || nowMs - Number(quote.block.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) {
    throw new EvmQuoteError("stale_quote", "the quote's block is more than 30 s old");
  }
  if (typeof fields !== "object" || fields === null) throw new EvmPoolSellError("bad_amount", "the sell's fields are an object");
  const { precommitment, feeCap, deadline, nonce } = fields;
  const { chain, w, token, amountIn: amount, target, route, minOut } = quote;
  const built = pinnedBuildSell(evmPoolVenues(), chain, { w, token, amount, target, route, minOut, precommitment, feeCap, deadline, nonce });
  QUOTED_SELLS.add(built);
  return built;
}

/** W's signature of `built`, a sell evmPoolBuildSell returned, into the chain's pinned pool (not_built otherwise; see
 *  sell-unpinned.ts evmPoolSignSellUnpinned). */
export function evmPoolSignSell(secretKey: Uint8Array, chain: EvmPoolChain, built: EvmPoolSell): Uint8Array {
  if (!QUOTED_SELLS.has(built)) throw new EvmPoolSellError("not_built", "W signs only a sell evmPoolBuildSell returned");
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
