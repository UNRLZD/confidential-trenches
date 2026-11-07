// The device's check of a 1Click quote before any money moves on it (wallet paper §2.4 step 3 and §2.8 deposit quote
// row, docs/plan1/wallet.md:410 and :889 at research ffcba5e; WU-04, :1043). Every answer is hostile until it passes:
// 1. the signature under the pinned key set (D2-D4: ed25519 over the UTF-8 of bs58(sha256(stable-json({...signed
//    request, ...signed quote, timestamp})))), ported from the SDK's verifyQuoteSignature (one-click-sdk-typescript
//    0.1.26 dist/index.mjs:1594-1679);
// 2. the echo: every signed request field equals the device's own request, a live request takes only a live answer;
// 3. the floors, computed on the device and never taken from the quote (M271 (1)).
// A refusal throws OneClickQuoteError; the app shows "quote check failed" and nothing else.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { ONECLICK_SIGNING_KEYS } from "./oneclick-keys.ts";

// Every pin below is frozen, each nested array and object too (card kit-oneclick-pins-frozen): nothing running beside
// the check, on SIGN_HOST or in a test, can add a signing key or a USDC asset or change a fee the device checks against.
// A test trusts its own key only by loading oneclick-keys.ts through a module hook, never by writing into a pin.
export { ONECLICK_SIGNING_KEYS };

// 1Click's own fee entry, unsigned (D4), so it is compared exactly and a changed collector fails closed (D-R7). Its fee
// follows the route, not the key (card oneclick-partner-fee-live). 1Click's fee table (docs.near-intents.org
// resources/fees.md, read 2026-11-06T15:18Z): with an API key, "0.20% (20 bps) normally; 0.01% (1 bp) for stablecoin
// pairs (USDC, USDT, DAI) and same-asset multichain routes"; without one, 25 bps more "on top". Read live 2026-11-06
// 15:19-15:21Z, one dry body each, keyless direct and through the helper (it sends its key as X-API-Key; a made-up key on
// X-API-Key or on Authorization: Bearer answers 401 "Invalid token", so the helper's 201 shows only that it sent no key
// 1Click refuses): Solana and Base USDC
// to NEAR USDC answer [{recipient: 5880ad2b…47dd, fee: 1}] both ways, wNEAR and SOL to NEAR USDC fee 20 both ways (as
// the five live wNEAR quotes of the G1 runs, fixture "live", and D52's 60 keyless USDC answers at fee 1). The keyless 25
// bps shows in neither the entry nor the amount (100 USDC from Solana: amountOut 99,986,032 both ways), so both paths
// pin the same fees. A same-asset quote (origin = destination) answers appFees [] with no fee (D52; fixture "same").
// A stablecoin route is one between two of ONECLICK_USDC_ASSETS; any other pair, a same-asset multichain one included,
// is held to 20, so a 1 bp entry on a route not listed here is refused (fails closed) until the route joins the list.
const ONECLICK_COLLECTOR = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
/** 1Click's fee on a stablecoin route, one between two of ONECLICK_USDC_ASSETS, per path (it was one fee per path before
 *  card oneclick-partner-fee-live); the deposit's routes are all here. A stablecoin or same-asset route outside that list
 *  is held to ONECLICK_PAIR_FEE_BPS, so it must join the list before it ships, or its 1 bp quotes are refused. */
export const ONECLICK_FEE_BPS = Object.freeze({ keyless: 1, partner: 1 } as const);
/** The fee on any other pair, per path. */
export const ONECLICK_PAIR_FEE_BPS = Object.freeze({ keyless: 20, partner: 20 } as const);
export type OneClickPath = keyof typeof ONECLICK_FEE_BPS;

// The release's USDC assets on 1Click (GET /v0/tokens, read 2026-11-01T01:40Z: symbol USDC on near, sol and base, 6
// decimals each; 1Click lists none on hood). Pricing "usdc" is taken only when both assets are in this list.
export const ONECLICK_USDC_ASSETS: readonly string[] = Object.freeze([
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
]);

// S, the spread cap on every floor: 15 bps, twice the widest gap read (D52).
export const ONECLICK_SPREAD_CAP_BPS = 15;
// The vault takes no deposit under MIN_DEPOSIT, 1 USDC (vault paper V@93b827c:62), so a quote into it is refused below.
export const ONECLICK_VAULT_MIN_OUT = 1_000_000n;
// A live quote's signed `deadline` replaces the request's in the signed bytes (the SDK spreads the quote over the
// request), so the request's deadline is unsigned on a live answer. 1Click signs deadline = the requested one + 72 h:
// 5 of 5 live quotes of the G1 runs read by status 2026-11-01T01:00Z, and D44's 72 h. Anything else is refused.
export const ONECLICK_LIVE_DEADLINE_MS = 72 * 3_600_000;
// The signed timestamp may be at most this old, or this far ahead of the device clock.
export const ONECLICK_MAX_AGE_MS = 120_000;
export const ONECLICK_MAX_AHEAD_MS = 60_000;

// The request the device sends to POST /v0/quote, exactly. EXACT_INPUT only; no customRecipientMsg (§2.8).
export interface OneClickRequest {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: string;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: string;
  recipient: string;
  recipientType: string;
  deadline: string;
  quoteWaitingTimeMs?: number;
  referral?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
}

// The floor's price input. "usdc": USDC to USDC (§2.8's first floor). Otherwise each asset's two USD price reads as
// decimal strings (1Click's price list and the asset's pool; USDC counts "1" on both).
export type OneClickPricing = "usdc" | { in: readonly [string, string]; out: readonly [string, string] };

export interface OneClickCheckOptions {
  path: OneClickPath;
  pricing: OneClickPricing;
  decimalsIn: number; // origin and destination decimals from the release's asset list
  decimalsOut: number;
  intoVault: boolean; // the output goes into the vault: a deposit, a refund move, V's move, a return
  now?: number; // ms; the device clock by default
}

export interface OneClickChecked {
  depositAddress: string | undefined; // a live answer's signed address; never set for a dry one
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  withdrawFee: bigint | undefined; // signed: a live answer's only
  unsignedDryWithdrawFee: bigint | undefined; // a dry answer's figure, not signed (SDK 0.1.26 dist/index.mjs:1626-1636)
  deadline: string | undefined; // a live answer's signed deadline
  timeEstimate: unknown; // a live answer's signed timeEstimate as it came (seconds), unchecked; never set for a dry one
  unsignedDryTimeEstimate: unknown; // a dry answer's own timeEstimate as it came (seconds), not signed, unchecked
  timestamp: string;
}

export type OneClickCheck =
  | "request"
  | "shape"
  | "signature"
  | "echo"
  | "live"
  | "deadline"
  | "memo"
  | "app-fees"
  | "timestamp"
  | "amount"
  | "price"
  | "floor";

export class OneClickQuoteError extends Error {
  readonly check: OneClickCheck;
  constructor(check: OneClickCheck, message: string) {
    super(`quote check failed (${check}): ${message}`);
    this.name = "OneClickQuoteError";
    this.check = check;
  }
}

const fail = (check: OneClickCheck, message: string): never => {
  throw new OneClickQuoteError(check, message);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown): string => String(typeof v === "string" ? JSON.stringify(v) : v).slice(0, 90);
const orU = (v: unknown): unknown => (v ? v : undefined); // the SDK's `x ? x : void 0` and `x || void 0`

// json-stable-stringify 1.3.0 as the SDK uses it: keys sorted, undefined values dropped from objects.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stable(x))).join(",")}]`;
  if (!isObj(v)) return JSON.stringify(v);
  const keys = Object.keys(v).sort().filter((k) => v[k] !== undefined);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}

const REQ_SIGNED = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount",
  "refundTo", "refundType", "recipient", "recipientType", "deadline"] as const;
const REQ_SIGNED_IF_SET = ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient",
  "customRecipientMsg"] as const;
const QUOTE_SIGNED = ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted",
  "amountOutUsd", "minAmountOut"] as const;
const QUOTE_SIGNED_LIVE = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee",
  "withdrawFee"] as const;

// The bytes 1Click signs: the UTF-8 of bs58(sha256(stable-json)). A dry answer's quote part leaves out every live
// field, the deposit address included (D4).
function signedMessage(qr: Record<string, unknown>, q: Record<string, unknown>, timestamp: unknown): Uint8Array {
  const req: Record<string, unknown> = {};
  for (const k of REQ_SIGNED) req[k] = qr[k];
  for (const k of REQ_SIGNED_IF_SET) req[k] = orU(qr[k]);
  const quote: Record<string, unknown> = {};
  for (const k of QUOTE_SIGNED) quote[k] = q[k];
  if (!qr.dry) for (const k of QUOTE_SIGNED_LIVE) quote[k] = orU(q[k]);
  const json = stable({ ...req, ...quote, timestamp });
  return new TextEncoder().encode(base58.encode(sha256(new TextEncoder().encode(json))));
}

// A key is taken only as "ed25519:" and its base58, the one form the pinned set and SIGN_HOST's deploy gate name (review
// low 1): a bare base58 key, wherever it came from, verifies nothing.
function keyBytes(k: string): Uint8Array {
  if (typeof k !== "string" || !k.startsWith("ed25519:")) throw new Error("a 1Click key is ed25519:<base58>");
  return base58.decode(k.slice(8));
}

function verifiesUnder(keys: readonly string[], answer: Record<string, unknown>): boolean {
  const { quoteRequest: qr, quote: q, signature, timestamp } = answer;
  if (!isObj(qr) || !isObj(q) || typeof signature !== "string" || !signature.startsWith("ed25519:")) return false;
  let sig: Uint8Array;
  try {
    sig = base58.decode(signature.slice(8));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const msg = signedMessage(qr, q, timestamp);
  return keys.some((k) => {
    try {
      return ed25519.verify(sig, msg, keyBytes(k), { zip215: false });
    } catch {
      return false;
    }
  });
}

const UINT = /^(0|[1-9][0-9]*)$/;
function uint(v: unknown, name: string): bigint {
  if (typeof v !== "string" || !UINT.test(v)) fail("shape", `${name}=${show(v)} is not a base-unit amount`);
  return BigInt(v as string);
}
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

// A decimal price string as an exact fraction n / d.
const PRICE = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
function price(v: string): { n: bigint; d: bigint } {
  if (!PRICE.test(v)) fail("price", `price ${show(v)} is not a decimal`);
  const [i = "", f = ""] = v.split(".");
  const r = { n: BigInt(`${i}${f}`), d: pow10(f.length) };
  if (r.n === 0n) fail("price", `price ${show(v)} is not positive`);
  return r;
}
const lt = (a: { n: bigint; d: bigint }, b: { n: bigint; d: bigint }): boolean => a.n * b.d < b.n * a.d;
// Two reads of one asset, in their order lower then higher; they must agree within the slippage (§2.8).
function reads(pair: readonly [string, string], slippageBps: number, side: string): [{ n: bigint; d: bigint }, { n: bigint; d: bigint }] {
  const a = price(pair[0]), b = price(pair[1]);
  const [lo, hi] = lt(a, b) ? [a, b] : [b, a];
  if ((hi.n * lo.d - lo.n * hi.d) * 10_000n > BigInt(slippageBps) * lo.n * hi.d)
    fail("price", `the two ${side} price reads ${show(pair[0])} and ${show(pair[1])} differ by more than the slippage`);
  return [lo, hi];
}

export interface OneClickFloorInput {
  amountIn: bigint;
  withdrawFee: bigint; // destination base units, 1Click's figure (D51, D52)
  slippageBps: number;
  feeBps: number; // F: the route's pinned fee (oneClickFeeBps), 0 on a same-asset quote
  pricing: OneClickPricing;
  decimalsIn: number;
  decimalsOut: number;
  intoVault: boolean;
}

// The device's own floors in destination base units (§2.8 deposit quote row at research faacb62); every rounding
// raises the floor (scaled amounts up, cuts down). USDC to USDC:
//   amountOut ≥ amountIn − withdrawFee − ⌊amountIn × (F + S) / 10,000⌋, minAmountOut ≥ that × (1 − slippage).
// Any other pair: minAmountOut ≥ ⌈amountIn × p_in / p_out × (1 − (F + S) / 10,000)⌉ × (1 − slippage) − withdrawFee,
// with p_in the lower of the origin's two reads and p_out the higher of the destination's (amountOut ≥ the same).
// A floor at or under zero is refused (the fees take the whole amount) before the vault's MIN_DEPOSIT raises it.
// `refundFee` is never taken off: a filled quote never charges it (D52).
export function oneClickFloors(x: OneClickFloorInput): { amountOut: bigint; minAmountOut: bigint } {
  if (!Number.isInteger(x.slippageBps) || x.slippageBps < 0 || x.slippageBps >= 10_000)
    fail("request", `slippageTolerance ${show(x.slippageBps)} is not in 0..9999 bps`);
  if (!Number.isInteger(x.feeBps) || x.feeBps < 0 || x.feeBps + ONECLICK_SPREAD_CAP_BPS >= 10_000) fail("request", `fee ${show(x.feeBps)}`);
  for (const d of [x.decimalsIn, x.decimalsOut]) if (!Number.isInteger(d) || d < 0 || d > 36) fail("request", `decimals ${show(d)}`);
  const keep = BigInt(10_000 - x.slippageBps);
  const fs = BigInt(x.feeBps + ONECLICK_SPREAD_CAP_BPS);
  let amountOut: bigint, minAmountOut: bigint;
  if (x.pricing === "usdc") {
    const inOut = ceilDiv(x.amountIn * pow10(x.decimalsOut), pow10(x.decimalsIn));
    amountOut = inOut - x.withdrawFee - (inOut * fs) / 10_000n;
    minAmountOut = ceilDiv(amountOut * keep, 10_000n);
  } else {
    const [pIn] = reads(x.pricing.in, x.slippageBps, "origin");
    const [, pOut] = reads(x.pricing.out, x.slippageBps, "destination");
    const value = ceilDiv(x.amountIn * pIn.n * pOut.d * pow10(x.decimalsOut) * (10_000n - fs), pIn.d * pOut.n * pow10(x.decimalsIn) * 10_000n);
    minAmountOut = ceilDiv(value * keep, 10_000n) - x.withdrawFee;
    amountOut = minAmountOut;
  }
  if (amountOut <= 0n || minAmountOut <= 0n) fail("floor", "the fees take the whole amount: nothing would arrive");
  if (x.intoVault && minAmountOut < ONECLICK_VAULT_MIN_OUT) minAmountOut = ONECLICK_VAULT_MIN_OUT;
  return { amountOut, minAmountOut };
}

/** F, 1Click's fee in bps on a quote from `originAsset` to `destinationAsset` on `path`, from the device's own request:
 *  0 on the same asset, ONECLICK_FEE_BPS between two of the release's USDC assets, ONECLICK_PAIR_FEE_BPS otherwise.
 *  A path is read only as an own key of both tables (card oneclick-fee-path-own-key): freezing a table does not stop
 *  `table[path]` from reading Object.prototype, so a path outside keyless and partner is refused by name, on every
 *  route, same-asset included, even when a polluted page's prototype names a fee for it. */
export function oneClickFeeBps(path: OneClickPath, originAsset: string, destinationAsset: string): number {
  if (typeof path !== "string" || !Object.hasOwn(ONECLICK_FEE_BPS, path) || !Object.hasOwn(ONECLICK_PAIR_FEE_BPS, path))
    fail("request", `no such 1Click path ${show(path)}`);
  if (originAsset === destinationAsset) return 0;
  const stable = ONECLICK_USDC_ASSETS.includes(originAsset) && ONECLICK_USDC_ASSETS.includes(destinationAsset);
  return stable ? ONECLICK_FEE_BPS[path] : ONECLICK_PAIR_FEE_BPS[path];
}

// The pinned fee entry: [] on a same-asset quote, else exactly one entry, the collector and the route's fee as read,
// nothing else set. Returns F.
function checkAppFees(v: unknown, path: OneClickPath, originAsset: string, destinationAsset: string): number {
  const fee = oneClickFeeBps(path, originAsset, destinationAsset);
  if (originAsset === destinationAsset) {
    if (!(Array.isArray(v) && v.length === 0)) fail("app-fees", `appFees ${show(JSON.stringify(v))} on a same-asset quote is not []`);
    return 0;
  }
  const e = Array.isArray(v) && v.length === 1 ? v[0] : undefined;
  const ok = isObj(e) && e.recipient === ONECLICK_COLLECTOR && e.fee === fee &&
    Object.keys(e).every((k) => k === "recipient" || k === "fee" || e[k] === null || e[k] === undefined);
  if (!ok) fail("app-fees", `appFees ${show(JSON.stringify(v))} is not 1Click's own ${path} entry (fee ${fee} on this route)`);
  return fee;
}

// A signed `...Formatted` amount must be the base-unit amount at the decimals the caller passed, truncated to its shown
// digits (how every signed answer read formats it): 0 ≤ amount − shown × 10^(decimals − digits) < 10^(decimals − digits).
// A tolerance both ways would let a larger decimals value through a one-digit amount ("0.1" at 7 for 100,000).
const FORMATTED = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
export function checkOneClickFormatted(formatted: unknown, amount: bigint, decimals: number, name: string): void {
  if (typeof formatted !== "string" || !FORMATTED.test(formatted)) fail("shape", `${name}=${show(formatted)} is not a decimal`);
  const [i = "", f = ""] = (formatted as string).split(".");
  const digits = BigInt(`${i}${f}`);
  const ok = f.length <= decimals
    ? (() => { const tol = pow10(decimals - f.length), d = amount - digits * tol; return d >= 0n && d < tol; })()
    : amount * pow10(f.length - decimals) === digits;
  if (!ok) fail("request", `${name} ${show(formatted)} is not ${amount} at ${decimals} decimals`);
}

// An ISO time with its zone, as the kit writes it; a deadline without one would be read in the device's zone.
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
function checkRequest(r: OneClickRequest, now: number): void {
  if (!isObj(r) || typeof r.dry !== "boolean") fail("request", "the request must say dry: true or false");
  if (r.swapType !== "EXACT_INPUT") fail("request", `swapType ${show(r.swapType)}: the kit asks EXACT_INPUT only`);
  if ("customRecipientMsg" in r) fail("request", "the kit never asks with a customRecipientMsg");
  uint(r.amount, "request amount");
  if (typeof r.deadline !== "string" || !ISO_ZONED.test(r.deadline) || Number.isNaN(Date.parse(r.deadline)))
    fail("request", `deadline ${show(r.deadline)} is not an ISO time with its zone`);
  if (!(Date.parse(r.deadline) > now)) fail("request", `deadline ${show(r.deadline)} has passed`);
}

// The whole check, in order: request, shape, signature, echo, live rules, fees, timestamp, amounts, floors.
export function checkOneClickQuote(request: OneClickRequest, answer: unknown, opts: OneClickCheckOptions): OneClickChecked {
  const now = opts.now ?? Date.now();
  checkRequest(request, now);
  if (opts.pricing === "usdc" && !(ONECLICK_USDC_ASSETS.includes(request.originAsset) && ONECLICK_USDC_ASSETS.includes(request.destinationAsset)))
    fail("request", "pricing \"usdc\" is only for the release's USDC assets");
  if (!isObj(answer) || !isObj(answer.quoteRequest) || !isObj(answer.quote)) fail("shape", "no quote in the answer");
  const a = answer as Record<string, unknown>;
  const qr = a.quoteRequest as Record<string, unknown>, q = a.quote as Record<string, unknown>;
  if (!verifiesUnder(ONECLICK_SIGNING_KEYS, a)) fail("signature", "the signature does not verify under the pinned 1Click keys");

  const req = request as unknown as Record<string, unknown>;
  for (const k of REQ_SIGNED) if (qr[k] !== req[k]) fail("echo", `${k}=${show(qr[k])} is not the requested ${show(req[k])}`);
  for (const k of REQ_SIGNED_IF_SET)
    if (orU(qr[k]) !== orU(req[k])) fail("echo", `${k}=${show(qr[k])} is not the requested ${show(req[k])}`);

  let depositAddress: string | undefined, deadline: string | undefined;
  if (!request.dry) {
    // qr.dry === false is already bound by the echo; a signed dry answer leaves the deposit address unsigned (D4).
    if (typeof q.depositAddress !== "string" || q.depositAddress === "") fail("live", "a live answer names no depositAddress");
    if (orU(q.depositMemo) !== undefined) fail("memo", `depositMemo=${show(q.depositMemo)}: the kit's deposits carry no memo`);
    if (typeof q.deadline !== "string" || Date.parse(q.deadline) !== Date.parse(request.deadline) + ONECLICK_LIVE_DEADLINE_MS)
      fail("deadline", `signed deadline ${show(q.deadline)} is not the requested ${show(request.deadline)} + 72 h`);
    depositAddress = q.depositAddress as string;
    deadline = q.deadline as string;
  }
  const feeBps = checkAppFees(qr.appFees, opts.path, request.originAsset, request.destinationAsset);

  const t = typeof a.timestamp === "string" ? Date.parse(a.timestamp) : Number.NaN;
  if (!(now - t <= ONECLICK_MAX_AGE_MS && t - now <= ONECLICK_MAX_AHEAD_MS))
    fail("timestamp", `signed timestamp ${show(a.timestamp)} is not fresh`);

  const amountIn = uint(q.amountIn, "amountIn"), amountOut = uint(q.amountOut, "amountOut");
  const minAmountOut = uint(q.minAmountOut, "minAmountOut");
  // Signed on a live answer only. A dry answer moves no money and shows an estimate under its unsigned figure; its live
  // re-quote is checked again with the signed one.
  const fee = uint(q.withdrawFee ?? "0", "withdrawFee");
  checkOneClickFormatted(q.amountInFormatted, amountIn, opts.decimalsIn, "amountInFormatted");
  checkOneClickFormatted(q.amountOutFormatted, amountOut, opts.decimalsOut, "amountOutFormatted");
  if (amountIn !== BigInt(request.amount) || uint(q.minAmountIn, "minAmountIn") !== amountIn)
    fail("amount", `amountIn ${show(q.amountIn)} is not the requested ${show(request.amount)}`);
  if (minAmountOut > amountOut) fail("amount", "minAmountOut is above amountOut");

  const floor = oneClickFloors({ amountIn, withdrawFee: fee, slippageBps: request.slippageTolerance, feeBps,
    pricing: opts.pricing, decimalsIn: opts.decimalsIn, decimalsOut: opts.decimalsOut, intoVault: opts.intoVault });
  if (amountOut < floor.amountOut) fail("floor", `amountOut ${amountOut} is below the device's floor ${floor.amountOut}`);
  if (minAmountOut < floor.minAmountOut) fail("floor", `minAmountOut ${minAmountOut} is below the device's floor ${floor.minAmountOut}`);
  return { depositAddress, amountIn, amountOut, minAmountOut, withdrawFee: request.dry ? undefined : fee,
    unsignedDryWithdrawFee: request.dry ? fee : undefined, deadline, timeEstimate: request.dry ? undefined : q.timeEstimate,
    unsignedDryTimeEstimate: request.dry ? q.timeEstimate : undefined, timestamp: a.timestamp as string };
}
