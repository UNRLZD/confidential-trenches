// A pool's payout to another chain (card pool-withdraws-to-any-chain; Blindfill v2 lite paper §3 "Exit: to any chain"):
// the pool pays a 1Click quote's deposit address on the pool's own chain, and 1Click delivers the destination chain's
// coin to the address the user typed. The device builds the request itself (oneClickExitRequest) and checks the answer
// before any note moves (checkOneClickExitQuote), through the kit's one 1Click check (./oneclick.ts checkOneClickQuote:
// the signature under the pinned keys, every signed request field equal to the device's own, a live answer for a live
// request, the signed deadline and timestamp, the route's fee entry, and the floors at the device's own price reads),
// then the exit's own rules on top:
// - the request is exactly the one built from the user's ask: the pool's coin in, the destination chain's coin out,
//   amount = the payout, recipient = the typed address, refundTo = the user's own refund wallet on the pool's chain
//   (refundType ORIGIN_CHAIN: a refund lands back on the pool's chain, at a wallet derived from the 12 words);
// - amountIn equals the payout (the checked request's amount, read back from the signed quote);
// - minAmountOut is within the request's slippage of amountOut (and at or over the device's floor, the kit's check);
// - a live answer names a deposit address.
// Every answer is hostile until it passes; a refusal throws the kit's OneClickQuoteError (or ExitRequestError for an ask
// the device itself would never send).
// The chains an exit pays to and the coin it delivers there are pinned here from 1Click's token list (GET /v0/tokens,
// read 2026-11-13T20:08Z: sol SOL nep141:sol.omft.near 9 decimals, base ETH nep141:base.omft.near 18, hood ETH
// nep141:hood.omft.near 18, near USDC nep141:17208628…33a1 6; a dry quote from hood ETH to sol SOL, base ETH and NEAR
// USDC answered 201 the same minute, so Robinhood is served as an origin). The device never takes an asset id from a
// server.
import { checkOneClickQuote, OneClickQuoteError, type OneClickChecked, type OneClickCheckOptions, type OneClickRequest } from "./oneclick.ts";

/** The pool chains an exit leaves from, and each one's coin on 1Click (the pool's own coin). */
export type ExitOrigin = "solana" | "base" | "robinhood";
/** The chains an exit pays to. */
export type ExitChain = ExitOrigin | "near";

/** Each pool chain's coin on 1Click: what the pool pays into the quote's deposit address. */
export const EXIT_ORIGIN_ASSET: Readonly<Record<ExitOrigin, { asset: string; decimals: number }>> = Object.freeze({
  solana: Object.freeze({ asset: "nep141:sol.omft.near", decimals: 9 }),
  base: Object.freeze({ asset: "nep141:base.omft.near", decimals: 18 }),
  robinhood: Object.freeze({ asset: "nep141:hood.omft.near", decimals: 18 }),
});
/** What an exit delivers on each chain: the chain's own coin where 1Click lists one, USDC on NEAR (the cash home). */
export const EXIT_DESTINATION_ASSET: Readonly<Record<ExitChain, { asset: string; decimals: number; symbol: string }>> = Object.freeze({
  solana: Object.freeze({ asset: "nep141:sol.omft.near", decimals: 9, symbol: "SOL" }),
  base: Object.freeze({ asset: "nep141:base.omft.near", decimals: 18, symbol: "ETH" }),
  robinhood: Object.freeze({ asset: "nep141:hood.omft.near", decimals: 18, symbol: "ETH" }),
  near: Object.freeze({ asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, symbol: "USDC" }),
});
/** The exit's slippage: 1Click's own default, the deposit quote's (wallet deposit/quote.ts DEPOSIT_QUOTE_SLIPPAGE_BPS). */
export const EXIT_SLIPPAGE_BPS = 100;
/** The request's deadline from now: the deposit quote's 30 minutes; a withdraw of several parts proves each part
 *  (about 7 s) and reads it back before the next. */
export const EXIT_DEADLINE_MS = 30 * 60_000;

/** What the user asked: from which pool, to which chain and address, how much the pool pays out, and where a refund
 *  lands (the user's own wallet on the pool's chain). */
export type ExitAsk = { from: ExitOrigin; to: ExitChain; recipient: string; payout: bigint; refundTo: string };

export class ExitRequestError extends Error {
  constructor(why: string) {
    super(`exit request refused: ${why}`);
    this.name = "ExitRequestError";
  }
}

const own = <T extends object>(o: T, k: unknown): k is keyof T => typeof k === "string" && Object.hasOwn(o, k);

/** The device's own 1Click request for `ask`, at `now` (ms). Refuses a same-chain exit (the pool pays the address
 *  itself), an unknown chain, a payout that is not a positive bigint, or an empty address. */
export function oneClickExitRequest(ask: ExitAsk, now: number): OneClickRequest {
  if (!own(EXIT_ORIGIN_ASSET, ask.from) || !own(EXIT_DESTINATION_ASSET, ask.to)) throw new ExitRequestError("chain");
  if (ask.from === ask.to) throw new ExitRequestError("same chain");
  if (typeof ask.payout !== "bigint" || ask.payout <= 0n) throw new ExitRequestError("payout");
  if (typeof ask.recipient !== "string" || ask.recipient === "" || typeof ask.refundTo !== "string" || ask.refundTo === "") throw new ExitRequestError("address");
  if (!Number.isSafeInteger(now) || now <= 0) throw new ExitRequestError("now");
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: EXIT_SLIPPAGE_BPS,
    originAsset: EXIT_ORIGIN_ASSET[ask.from].asset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: EXIT_DESTINATION_ASSET[ask.to].asset,
    amount: ask.payout.toString(),
    refundTo: ask.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: ask.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + EXIT_DEADLINE_MS).toISOString(),
  };
}

/** The request keys an exit may carry, no more (no referral, no virtual chain fields, no message). */
const EXIT_KEYS = new Set(["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo",
  "refundType", "recipient", "recipientType", "deadline"]);

/** The exit's check: `request` must be oneClickExitRequest(ask) field for field (its deadline the device's own, in the
 *  future), and `answer` must pass the kit's 1Click check and the exit's rules. Returns the checked quote, its signed
 *  deposit address set. `opts` are the kit check's: the path and the device's own price reads of both coins. */
export function checkOneClickExitQuote(ask: ExitAsk, request: OneClickRequest, answer: unknown, opts: Omit<OneClickCheckOptions, "decimalsIn" | "decimalsOut" | "intoVault">): OneClickChecked & { depositAddress: string } {
  const want = oneClickExitRequest(ask, Date.parse(request.deadline) - EXIT_DEADLINE_MS);
  const req = { ...request } as Record<string, unknown>;
  if (Object.keys(req).some((k) => !EXIT_KEYS.has(k))) throw new ExitRequestError("request keys");
  for (const k of EXIT_KEYS) if (req[k] !== (want as unknown as Record<string, unknown>)[k]) throw new ExitRequestError(`request ${k}`);
  const checked = checkOneClickQuote(want, answer, {
    ...opts,
    decimalsIn: EXIT_ORIGIN_ASSET[ask.from].decimals,
    decimalsOut: EXIT_DESTINATION_ASSET[ask.to].decimals,
    intoVault: false,
  });
  if (checked.amountIn !== ask.payout) throw new OneClickQuoteError("amount", `amountIn ${checked.amountIn} is not the payout ${ask.payout}`);
  // within the slippage asked: minAmountOut ≥ ⌊amountOut × (10,000 − slippage) / 10,000⌋, 1Click's own rounding (live
  // answers read 2026-11-13T20:47Z: amountOut 7,994,156 with minAmountOut 7,914,214 = ⌊7,914,214.44⌋)
  const least = (checked.amountOut * BigInt(10_000 - EXIT_SLIPPAGE_BPS)) / 10_000n;
  if (checked.minAmountOut < least) throw new OneClickQuoteError("floor", `minAmountOut ${checked.minAmountOut} is more than ${EXIT_SLIPPAGE_BPS} bps under amountOut ${checked.amountOut}`);
  if (checked.depositAddress === undefined) throw new OneClickQuoteError("live", "an exit takes a live answer only");
  return checked as OneClickChecked & { depositAddress: string };
}
