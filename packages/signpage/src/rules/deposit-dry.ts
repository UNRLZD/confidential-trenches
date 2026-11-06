// The deposit sheet's two reads before any address exists (card kit-deposit-assets-dry): deposit.assets, the assets the
// device can quote with each one's minimum and the most one deposit takes, and deposit.dry, what an amount would land in
// the vault as. Both sign nothing, need no sign-in and send nothing of the user's: a dry quote names the kit's
// DEPOSIT_DRY_PLACEHOLDER as its recipient and refundTo (6 Nov 10:24Z: the industry pattern for an unsigned price
// read), and the token list is public. Every answer is hostile and checked as a live one is (src/checks/oneclick.ts:
// the signature under the pinned key, every signed field equal to the device's own request, the device's floors).
//
// The minimum. The vault takes no deposit under MIN_DEPOSIT (ONECLICK_VAULT_MIN_OUT, 1 USDC), and the device refuses a
// quote whose min out is under it. So an asset's minimum is the least amount whose floor (oneClickFloors, the device's
// own: amountOut ≥ in − withdrawFee − in × (F + S), min out ≥ that × (1 − slippage)) is at least MIN_DEPOSIT, found on
// that very function. The floor takes 1Click's withdraw fee, which is the registration of the one-time id on the vault's
// USDC (wallet.md D51, D52: 0.00125 N at NEAR's price) and so moves with NEAR's price; deposit.assets reads it from one
// dry quote per asset. Before any request (deposit.quote, deposit.dry) the device refuses below_min under the bound a
// zero fee gives, which no fee lowers; an amount above that bound whose checked answer clears every floor but
// MIN_DEPOSIT is refused below_min too, never quote_check_failed: the device read the reason off a verified answer.
import {
  ONECLICK_FEE_BPS, ONECLICK_USDC_ASSETS, ONECLICK_VAULT_MIN_OUT, OneClickQuoteError, checkOneClickQuote, oneClickFloors,
  type OneClickChecked, type OneClickCheckOptions, type OneClickPath, type OneClickRequest,
} from "../../../kit/src/checks/oneclick.ts";
import { HELPER_BIND_DEPOSIT_CAP, HELPER_FETCH_INIT } from "../../../kit/src/helper/v1.ts";
import { DEPOSIT_DRY_PLACEHOLDER, type DepositAsset, type DepositDry, type DepositRefusal } from "../../../kit/src/signpage/messages.ts";
import type { Chain } from "../../../kit/src/orders/record.ts";
import {
  DEPOSIT_QUOTE_DEADLINE_MS, DEPOSIT_QUOTE_DESTINATION, DEPOSIT_QUOTE_SLIPPAGE_BPS, DEPOSIT_QUOTE_TIMEOUT_MS, DepositAnswerTooLarge,
  askDepositQuote, readCapped,
} from "../../../wallet/src/deposit/quote.ts";

/** USDC's decimals on every chain the release lists it. */
const USDC_DECIMALS = 6;
/** The helper's 1Click proxy for the token list (apps/helper/src/proxy/vendors.ts: oneclick, GET /v0/tokens upstream). The
 *  helper takes every proxy call as a POST (apps/helper/src/server.ts) and asks 1Click with the entry's own method. */
export const DEPOSIT_TOKENS_URL = "https://api.confidential.unrealized.trade/v1/proxy/oneclick/v0/tokens";
/** The largest token list read: 1Click lists about 216 tokens, some 60 KB (read 6 Nov 13:41Z). */
export const DEPOSIT_TOKENS_MAX = 1_048_576;
/** The amount of the dry quote deposit.assets reads each asset's withdraw fee from: 10 USDC, well inside the limits. */
export const DEPOSIT_PROBE_AMOUNT = 10_000_000n;

/**
 * The release's deposit assets, each as 1Click's /v0/tokens names it (read 6 Nov 13:41Z: symbol USDC, 6 decimals,
 * blockchain near, sol and base): ONECLICK_USDC_ASSETS in its order, with the chain the sheet names.
 */
export const DEPOSIT_ASSET_CHAINS: readonly { id: string; chain: Chain; blockchain: string }[] = Object.freeze([
  { id: ONECLICK_USDC_ASSETS[0]!, chain: "near", blockchain: "near" },
  { id: ONECLICK_USDC_ASSETS[1]!, chain: "solana", blockchain: "sol" },
  { id: ONECLICK_USDC_ASSETS[2]!, chain: "base", blockchain: "base" },
]);

export interface DepositReadContext {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The path deposit.quote checks a live quote on (./deposit-quote.ts): the helper's 1Click key. The minimum and a dry
 * quote's lines are worked out at this path's fee, ONECLICK_FEE_BPS[DEPOSIT_QUOTE_PATH], whatever path a dry answer's
 * entry names, so the sheet shows what the live quote is held to.
 */
export const DEPOSIT_QUOTE_PATH: OneClickPath = "partner";

export type DepositReadAnswer<T> = { ok: true; result: T } | { ok: false; code: DepositRefusal };
const no = (code: DepositRefusal): { ok: false; code: DepositRefusal } => ({ ok: false, code });

/** F on a quote from `origin` into the vault's USDC on `path`: none on the same asset, the path's own otherwise. */
const feeBpsFrom = (origin: string, path: OneClickPath): number => (origin === DEPOSIT_QUOTE_DESTINATION ? 0 : ONECLICK_FEE_BPS[path]);
/**
 * The paths a dry quote's fee entry may name, in the order tried: the partner path's (the helper's 1Click key, fee 20 on
 * every live quote of the G1 runs), then the keyless one's (fee 1), which a dry quote through the helper named on 6 Nov
 * 14:06Z. Either is 1Click's own collector, compared exactly, and the floor is held at the fee the entry names. A dry
 * quote moves no money, and an entry that names less than 1Click took only raises the floor (fails closed).
 */
const DRY_PATHS: readonly OneClickPath[] = ["partner", "keyless"];

/** The device's min out floor for `amountIn` USDC base units, before MIN_DEPOSIT raises it; 0 when the fees take it all. */
function floorMinOut(amountIn: bigint, feeBps: number, withdrawFee: bigint): bigint {
  try {
    return oneClickFloors({ amountIn, withdrawFee, slippageBps: DEPOSIT_QUOTE_SLIPPAGE_BPS, feeBps, pricing: "usdc",
      decimalsIn: USDC_DECIMALS, decimalsOut: USDC_DECIMALS, intoVault: false }).minAmountOut;
  } catch (e) {
    if (e instanceof OneClickQuoteError && e.check === "floor") return 0n;
    throw e;
  }
}

/**
 * The least amount of a USDC asset, in base units, whose floor clears MIN_DEPOSIT at `withdrawFee`, or null when no
 * amount up to the beta cap does. Searched on oneClickFloors itself, which rises with the amount.
 */
export function depositMinimum(origin: string, withdrawFee: bigint, path: OneClickPath = DEPOSIT_QUOTE_PATH): bigint | null {
  const feeBps = feeBpsFrom(origin, path);
  if (floorMinOut(HELPER_BIND_DEPOSIT_CAP, feeBps, withdrawFee) < ONECLICK_VAULT_MIN_OUT) return null;
  let lo = 1n, hi = HELPER_BIND_DEPOSIT_CAP;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (floorMinOut(mid, feeBps, withdrawFee) >= ONECLICK_VAULT_MIN_OUT) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** True when `amount` of a USDC asset is under the minimum any withdraw fee and any path's fee leave (the keyless path's
 *  is the least): refused before any request. */
export function belowDepositBound(origin: string, amount: bigint): boolean {
  const bound = depositMinimum(origin, 0n, "keyless");
  return bound === null || amount < bound;
}

/**
 * True when an answer that failed the deposit check on its floor passes every check once MIN_DEPOSIT is left out: a
 * verified answer whose one shortfall is the vault's least deposit, so the amount is below the minimum.
 */
export function shortOnlyOfMinimum(e: unknown, request: OneClickRequest, answer: unknown, check: Omit<OneClickCheckOptions, "intoVault">): boolean {
  if (!(e instanceof OneClickQuoteError) || e.check !== "floor") return false;
  try {
    checkOneClickQuote(request, answer, { ...check, intoVault: false });
    return true;
  } catch {
    return false;
  }
}

/** The dry request for `amount` base units of `origin` into the vault's USDC, to the placeholder, asked at `now` (ms). */
export function depositDryRequest(origin: string, amount: bigint, now: number): OneClickRequest {
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: DEPOSIT_QUOTE_SLIPPAGE_BPS,
    originAsset: origin,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DEPOSIT_QUOTE_DESTINATION,
    amount: amount.toString(),
    refundTo: DEPOSIT_DRY_PLACEHOLDER,
    refundType: "INTENTS",
    recipient: DEPOSIT_DRY_PLACEHOLDER,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + DEPOSIT_QUOTE_DEADLINE_MS).toISOString(),
  };
}

const DEC = /^[0-9]+(\.[0-9]+)?$/;
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

/** 1Click's answered statuses: 200, and 201, which its quote answers with (wallet.md D52; the helper's proxy, 6 Nov 14:02Z). */
export const DEPOSIT_ANSWERED: ReadonlySet<number> = new Set([200, 201]);
/** The helper's HTTP status as a refusal, or null on an answer. */
const statusCode = (status: number): DepositRefusal | null =>
  DEPOSIT_ANSWERED.has(status) ? null : status === 429 ? "busy" : status === 503 ? "down" : "not_available";

/**
 * The withdraw fee a checked dry answer may stand for, bounded by its signed amounts: a dry answer's withdrawFee is not
 * signed (src/checks/oneclick.ts), so a helper could rewrite it after 1Click signed. 1Click's amountOut is at most
 * amountIn less its fee and its withdraw fee, so amountIn − amountOut − ⌊amountIn × F / 10,000⌋ (F the entry's own
 * fee) is at least the withdraw fee 1Click took: the figure counts up to that and no more, never below 0.
 */
export function signedWithdrawFee(q: Pick<OneClickChecked, "amountIn" | "amountOut" | "unsignedDryWithdrawFee">, feeBps: number): bigint {
  const room = q.amountIn - q.amountOut - (q.amountIn * BigInt(feeBps)) / 10_000n;
  const w = q.unsignedDryWithdrawFee ?? 0n;
  return room <= 0n ? 0n : w < room ? w : room;
}

/** One dry quote of `amount` from `origin`, asked and checked: the checked quote, the path its fee entry named and that
 *  path's fee, or the refusal. */
async function dryQuote(origin: string, amount: bigint, ctx: DepositReadContext): Promise<DepositReadAnswer<OneClickChecked & { path: OneClickPath; feeBps: number }>> {
  const now = ctx.now ?? Date.now;
  const request = depositDryRequest(origin, amount, now());
  let reply;
  try {
    reply = await askDepositQuote(request, ctx.fetch);
  } catch {
    return no("down");
  }
  const code = statusCode(reply.status);
  if (code) return no(code);
  const at = now();
  for (const path of DRY_PATHS) {
    const check = { path, pricing: "usdc", decimalsIn: USDC_DECIMALS, decimalsOut: USDC_DECIMALS, now: at } as const;
    try {
      return { ok: true, result: { ...checkOneClickQuote(request, reply.body, { ...check, intoVault: true }), path, feeBps: feeBpsFrom(origin, path) } };
    } catch (e) {
      // another path's fee entry: try the next path; any other failure is the answer's
      if (e instanceof OneClickQuoteError && e.check === "app-fees" && path !== DRY_PATHS.at(-1)) continue;
      return no(shortOnlyOfMinimum(e, request, reply.body, check) ? "below_min" : "quote_check_failed");
    }
  }
  return no("quote_check_failed");
}

/** Answers deposit.dry: the quote lines of a dry quote that passed every check, else a code. */
export async function depositDryKind(params: Record<string, unknown>, ctx: DepositReadContext = {}): Promise<DepositReadAnswer<DepositDry>> {
  const origin = params.origin_asset;
  if (typeof origin !== "string" || !ONECLICK_USDC_ASSETS.includes(origin)) return no("not_allowed");
  const amount = units(params.amount, USDC_DECIMALS);
  if (amount === null || amount === 0n) return no("not_allowed");
  if (amount > HELPER_BIND_DEPOSIT_CAP) return no("above_max");
  if (belowDepositBound(origin, amount)) return no("below_min");
  const got = await dryQuote(origin, amount, ctx);
  if (!got.ok) return got;
  const q = got.result;
  // the lines at the live quote's fee: an entry naming less (the keyless path's) is taken down by the difference
  const live = feeBpsFrom(origin, DEPOSIT_QUOTE_PATH);
  const less = live > q.feeBps ? (q.amountIn * BigInt(live - q.feeBps)) / 10_000n : 0n;
  const out = q.amountOut > less ? q.amountOut - less : 0n;
  const minOut = q.minAmountOut > less ? q.minAmountOut - less : 0n;
  if (out > HELPER_BIND_DEPOSIT_CAP) return no("above_max");
  // what the live quote would be refused for: under the vault's least deposit at its fee
  if (minOut < ONECLICK_VAULT_MIN_OUT) return no("below_min");
  const t = q.unsignedDryTimeEstimate;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) return no("quote_check_failed");
  const fee = q.amountIn > out ? q.amountIn - out : 0n;
  return {
    ok: true,
    result: {
      amount_out_usd: decimal(out, USDC_DECIMALS),
      min_amount_out_usd: decimal(minOut, USDC_DECIMALS),
      fee_usd: decimal(fee, USDC_DECIMALS),
      time_estimate_s: t,
    },
  };
}

/** Asks the token list through the helper: the parsed JSON, or the refusal (one over DEPOSIT_TOKENS_MAX, declared or
 *  streamed, is not_available, read no further; one that is not JSON not_available too). */
async function readTokens(fetchFn: typeof fetch = fetch): Promise<DepositReadAnswer<unknown>> {
  let bytes: Uint8Array;
  try {
    const res = await fetchFn(DEPOSIT_TOKENS_URL, { ...HELPER_FETCH_INIT, redirect: "error", method: "POST", signal: AbortSignal.timeout(DEPOSIT_QUOTE_TIMEOUT_MS) });
    const code = statusCode(res.status);
    if (code) return no(code);
    bytes = await readCapped(res, DEPOSIT_TOKENS_MAX);
  } catch (e) {
    return no(e instanceof DepositAnswerTooLarge ? "not_available" : "down");
  }
  try {
    return { ok: true, result: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) };
  } catch {
    return no("not_available");
  }
}

/** True when 1Click's list names `a` as the release has it: USDC, 6 decimals, on its own blockchain. */
function listed(list: unknown, a: (typeof DEPOSIT_ASSET_CHAINS)[number]): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((t) => typeof t === "object" && t !== null && (t as Record<string, unknown>).assetId === a.id &&
    (t as Record<string, unknown>).symbol === "USDC" && (t as Record<string, unknown>).decimals === USDC_DECIMALS &&
    (t as Record<string, unknown>).blockchain === a.blockchain);
}

/**
 * Answers deposit.assets: each release asset 1Click's own list names as the release has it, whose dry quote passed
 * every check, with its minimum at that quote's withdraw fee. An asset that fails is left out; a helper that is busy or
 * down answers that code (not kept, so the same request again runs again); none left is not_available.
 */
export async function depositAssetsKind(ctx: DepositReadContext = {}): Promise<DepositReadAnswer<{ assets: DepositAsset[] }>> {
  const tokens = await readTokens(ctx.fetch);
  if (!tokens.ok) return tokens;
  const kept = DEPOSIT_ASSET_CHAINS.filter((a) => listed(tokens.result, a));
  const probes = await Promise.all(kept.map((a) => dryQuote(a.id, DEPOSIT_PROBE_AMOUNT, ctx)));
  const notNow = probes.find((p): p is { ok: false; code: DepositRefusal } => !p.ok && (p.code === "busy" || p.code === "down"));
  if (notNow) return notNow;
  const assets: DepositAsset[] = [];
  kept.forEach((a, i) => {
    const p = probes[i]!;
    if (!p.ok) return;
    // the withdraw fee no higher than the signed amounts allow, the minimum at the live quote's fee
    const min = depositMinimum(a.id, signedWithdrawFee(p.result, p.result.feeBps), DEPOSIT_QUOTE_PATH);
    if (min === null) return;
    assets.push({ origin_asset: a.id, chain: a.chain, symbol: "USDC", decimals: USDC_DECIMALS, min: decimal(min, USDC_DECIMALS),
      max_usd: decimal(HELPER_BIND_DEPOSIT_CAP, USDC_DECIMALS) });
  });
  return assets.length > 0 ? { ok: true, result: { assets } } : no("not_available");
}
