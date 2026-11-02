// The deposit.quote kind (card wallet-deposit-quote; docs/plan1/wallet.md at research 3a6b03e: §2.4 steps 1-3,
// W:407-409; the deposit quote row of §2.8, W:888). The app asks for a deposit address with {origin_asset, amount}
// only; SIGN_HOST does the rest on the device, in this order, and answers with an address only when every step holds:
//   1. the backup gate (OD:20): a no-PRF seed whose code_saved is false gets no quote, and no request leaves the device;
//   2. the amount: the app's decimal in the origin asset's units, at the decimals the device holds for that asset (the
//      release's USDC assets, 6; any other only with the device's own price reads, `priced`), never rounded;
//   3. the request (../../../wallet/src/deposit/quote.ts): U, the id §2.3's deposit index rule names, as the recipient
//      and as refundTo, sent through the helper's 1Click proxy;
//   4. the answer through the deposit quote rule (./deposit.ts checkDepositQuote: U as recipient and refundTo, INTENTS,
//      then the kit's 1Click check, src/checks/oneclick.ts: the signature under the pinned key, every signed field equal
//      to the request with a live request taking only a live answer, the signed deadline and timestamp fresh, the
//      device's own floors and MIN_DEPOSIT, W:409);
//   5. the result from the checked quote alone: its signed deposit address, amounts and deadline.
// A refusal carries a code and nothing else: "not_allowed" for a request no rule allows (the gate, an asset the device
// cannot price, a bad amount), "quote_check_failed" for an answer that fails a check (W:888: nothing shown), "busy" and
// "down" for a helper that is rate-limited or not answering, "not_available" for any other helper status.
//
// Not here: the postMessage wiring (src/api.ts answers a refused kind "not_allowed" only, so this kind's codes need it
// to carry them) and the deposit's op record; the price reads for an asset other than USDC (the caller's `priced`).
import { ONECLICK_USDC_ASSETS, type OneClickPricing } from "../../../kit/src/checks/oneclick.ts";
import type { ErrorCode, SignpageResults } from "../../../kit/src/signpage/messages.ts";
import { askDepositQuote, depositQuoteRequest } from "../../../wallet/src/deposit/quote.ts";
import { checkDepositQuote, DepositRuleRefused, type DepositQuoteContext } from "./deposit.ts";

/** USDC's decimals on every chain the release lists it (kit ONECLICK_USDC_ASSETS); the vault's asset is one of them. */
export const USDC_DECIMALS = 6;

/** An origin asset other than USDC: its decimals from the release's asset list and its two price reads (W:888). */
export interface PricedAsset {
  decimals: number;
  pricing: Exclude<OneClickPricing, "usdc">;
}

export interface DepositQuoteKindContext {
  /** The stored seed's public status (src/state.ts statusOf). */
  seed: DepositQuoteContext["seed"];
  /** U, the 64-hex one-time id §2.3's deposit index rule names, derived on the device. */
  depositId: string;
  /** The device's own price reads for an origin asset that is not USDC; none, and only USDC is quoted. */
  priced?: (originAsset: string) => PricedAsset | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export type DepositQuoteKindAnswer =
  | { ok: true; result: SignpageResults["deposit.quote"] }
  | { ok: false; code: ErrorCode };

const DEC = /^[0-9]+(\.[0-9]+)?$/;
const no = (code: ErrorCode): DepositQuoteKindAnswer => ({ ok: false, code });

/** A decimal in base units at `decimals`, exactly; null when it has more fraction digits or is not a decimal. */
function units(v: unknown, decimals: number): bigint | null {
  if (typeof v !== "string" || !DEC.test(v)) return null;
  const [i = "", f = ""] = v.split(".");
  if (f.length > decimals) return null;
  return BigInt(i + f.padEnd(decimals, "0"));
}

/** Base units as a decimal at `decimals`, with no trailing zero in the fraction. */
function decimal(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/** Answers the deposit.quote kind: an address only from a quote that passed every check, else a code. */
export async function depositQuoteKind(params: Record<string, unknown>, ctx: DepositQuoteKindContext): Promise<DepositQuoteKindAnswer> {
  // 1. The backup gate, before anything leaves the device. checkDepositQuote holds the same gate again at step 4.
  if (ctx.seed.source !== "prf" && ctx.seed.code_saved !== true) return no("not_allowed");

  // 2. The asset and the amount, by the device's own list and price reads.
  const origin = params.origin_asset;
  if (typeof origin !== "string") return no("not_allowed");
  const usdc = ONECLICK_USDC_ASSETS.includes(origin);
  const priced = usdc ? null : ctx.priced?.(origin) ?? null;
  if (!usdc && priced === null) return no("not_allowed");
  const decimalsIn = usdc ? USDC_DECIMALS : (priced as PricedAsset).decimals;
  const pricing: OneClickPricing = usdc ? "usdc" : (priced as PricedAsset).pricing;
  if (!Number.isInteger(decimalsIn) || decimalsIn < 0 || decimalsIn > 36) return no("not_allowed");
  const amount = units(params.amount, decimalsIn);
  if (amount === null || amount === 0n) return no("not_allowed");

  // 3. The request to U, through the helper.
  const now = ctx.now ?? Date.now;
  let request;
  try {
    request = depositQuoteRequest(ctx.depositId, origin, amount, now());
  } catch {
    return no("not_allowed");
  }
  let reply;
  try {
    reply = await askDepositQuote(request, ctx.fetch);
  } catch {
    return no("down");
  }
  if (reply.status === 429) return no("busy");
  if (reply.status === 503) return no("down");
  if (reply.status !== 200) return no("not_available");

  // 4. The answer, checked against the device's own request, at the time it came back.
  let checked;
  try {
    checked = checkDepositQuote(request, reply.body, {
      seed: ctx.seed,
      depositId: ctx.depositId,
      check: { path: "partner", pricing, decimalsIn, decimalsOut: USDC_DECIMALS, now: now() },
    });
  } catch (e) {
    // the rule's own refusals are of the request; the kit's (OneClickQuoteError) and anything else are of the answer
    return no(e instanceof DepositRuleRefused ? "not_allowed" : "quote_check_failed");
  }
  // A live answer always carries both (the kit refuses one without); timeEstimate is signed on a live answer.
  const timeEstimate = (reply.body as { quote: Record<string, unknown> }).quote.timeEstimate;
  if (checked.depositAddress === undefined || checked.deadline === undefined) return no("quote_check_failed");
  if (typeof timeEstimate !== "number" || !Number.isSafeInteger(timeEstimate) || timeEstimate < 0) return no("quote_check_failed");

  // 5. The result, from the checked quote only.
  return {
    ok: true,
    result: {
      deposit_address: checked.depositAddress,
      origin_asset: origin,
      amount_in: decimal(checked.amountIn, decimalsIn),
      min_amount_out: decimal(checked.minAmountOut, USDC_DECIMALS),
      deadline: checked.deadline,
      time_estimate_s: timeEstimate,
    },
  };
}
