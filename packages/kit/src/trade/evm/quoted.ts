// The EVM pool builds a device quote makes (card evm-buy-hookdata-fee, review fold 1 M1): the buy and the sell built
// only from a quote checks/evm/quote.ts returned, within 30 s of its block, through a venue list's pins, and the record
// of which builds those are. The kit's index runs these with evmPoolVenues() and the device's clock (buy.ts
// evmPoolBuildQuoted, sell.ts evmPoolBuildSell); the signing page runs them with the pins and the clock it holds, and
// its signers sign no build this module did not return. The index does not export this module: a route, a minOut or
// hook data from anyone but the device's own quote never reaches a build it records.
import { pinnedBuildQuoted, type EvmPoolBuy, type EvmPoolVenueList } from "./buy-unpinned.ts";
import { EvmPoolSellError, pinnedBuildSell, type EvmPoolSell } from "./sell-unpinned.ts";
import { EVM_QUOTE_MAX_AGE_MS, EvmQuoteError, evmIsDeviceQuote, evmIsDeviceSellQuote, type EvmPoolBuyQuote, type EvmPoolSellQuote } from "../../checks/evm/quote.ts";

/** What W adds to a device sell quote: the return note's precommitment, the deadline (unix seconds), W's sell nonce,
 *  and the sender's fee cap: by default the quote's feeMax, the device's own fee rule (card evm-buy-hookdata-fee); a
 *  lower one may be named, a higher one is refused (bad_fee). */
export type EvmPoolSellFields = { precommitment: bigint; feeCap?: bigint; deadline: bigint; nonce: bigint };

// Every buy and sell built here: a copy, a spread or a build made any other way is in neither
const QUOTED_BUILDS = new WeakSet<EvmPoolBuy>();
const QUOTED_SELLS = new WeakSet<EvmPoolSell>();

/** Whether `b` is a buy evmQuotedBuy returned. */
export const evmIsQuotedBuy = (b: unknown): b is EvmPoolBuy => typeof b === "object" && b !== null && QUOTED_BUILDS.has(b as EvmPoolBuy);
/** Whether `s` is a sell evmQuotedSell returned. */
export const evmIsQuotedSell = (s: unknown): s is EvmPoolSell => typeof s === "object" && s !== null && QUOTED_SELLS.has(s as EvmPoolSell);

const fresh = (blockTimestamp: bigint, nowMs: number) => {
  if (!Number.isFinite(nowMs) || nowMs - Number(blockTimestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) {
    throw new EvmQuoteError("stale_quote", "the quote's block is more than 30 s old");
  }
};

/** The buy `quote` holds (its chain, route, token and minOut) through `adapter`, the chain's pinned adapter in `venues`
 *  for the route's venue, at the device's clock `nowMs`. The device quoted this route itself on both providers, so a v4
 *  route may pass through a middle that is not listed, and its hook data is the device's own: empty. */
export function evmQuotedBuy(venues: EvmPoolVenueList, adapter: string, quote: EvmPoolBuyQuote, nowMs: number): EvmPoolBuy {
  if (!evmIsDeviceQuote(quote)) throw new EvmQuoteError("bad_request", "a buy is built only from a quote evmPoolBuyQuote returned");
  fresh(quote.block.timestamp, nowMs);
  const built = pinnedBuildQuoted(venues, quote.chain, adapter, quote.route, quote.minOut, quote.token);
  QUOTED_BUILDS.add(built);
  return built;
}

/** The sell `quote` holds (its chain, W, token, amount, route, target and minOut) into the chain's pinned pool in
 *  `venues`, with `fields`, at the device's clock `nowMs` (see sell-unpinned.ts evmPoolBuildSellUnpinned for every
 *  check). The sender's fee cap is at most the quote's feeMax, the device's own fee rule at the agreed block. */
export function evmQuotedSell(venues: EvmPoolVenueList, quote: EvmPoolSellQuote, fields: EvmPoolSellFields, nowMs: number): EvmPoolSell {
  if (!evmIsDeviceSellQuote(quote)) throw new EvmQuoteError("bad_request", "a sell is built only from a quote evmPoolSellQuote returned");
  fresh(quote.block.timestamp, nowMs);
  if (typeof fields !== "object" || fields === null) throw new EvmPoolSellError("bad_amount", "the sell's fields are an object");
  const { precommitment, feeCap: asked, deadline, nonce } = fields;
  const { chain, w, token, amountIn: amount, target, route, minOut, feeMax } = quote;
  // the sender takes no more than the device's own fee rule allows, never a figure a caller or a server names
  const feeCap = asked === undefined ? feeMax : asked;
  if (feeCap > feeMax) throw new EvmPoolSellError("bad_fee", `the fee cap is above the device's fee rule's ${feeMax}`);
  const built = pinnedBuildSell(venues, chain, { w, token, amount, target, route, minOut, precommitment, feeCap, deadline, nonce });
  QUOTED_SELLS.add(built);
  return built;
}
