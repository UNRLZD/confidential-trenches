// Cash to another chain (card cash-withdraws-everything-to-any-chain, Part B; the Blindfill v2 lite paper §3 "Exit: to
// any chain"; docs/plan1/wallet.md:915, the arming quote row for a withdrawal to the user, and §2.5 "A withdrawal across
// several notes", W:716-766). Each part of the form's plan (./checks.ts planCashWithdraw) goes out of the vault to its
// own checked 1Click quote, which delivers USDC on the picked chain to the address the user typed:
// - The request is the device's own: NEAR's USDC in, exactly the part (EXACT_INPUT), ORIGIN_CHAIN (the vault pays the
//   quote's NEAR deposit address straight), the picked chain's USDC out to the typed address (DESTINATION_CHAIN), the
//   refund under V_{l,j} inside intents.near (INTENTS): the refund id of the change note this part's withdrawal makes
//   (../../../wallet/src/derive/keys.ts refundId), derived on the device from the words, which restore reads
//   (../../../wallet/src/restore/arms.ts kind "V"). It names that one id and the typed address: no other wallet, note
//   or key of the user.
// - The answer is hostile: the kit's one 1Click check (signature under the pinned keys, every signed request field equal
//   to the request, live, its signed deadline and timestamp, the floors between two of the release's USDC assets), then
//   its signed amount in exactly the part and its signed deposit address a 64-hex NEAR implicit id (what the vault can
//   pay and 1Click's NEAR deposit addresses are). Only then does the vault pay that address, by the same hand-off as a
//   NEAR withdrawal (./handoff.ts withdrawHandoff).
// - The chains are those whose USDC the kit pins (ONECLICK_USDC_ASSETS: NEAR, Solana and Base; 1Click lists no USDC on
//   Robinhood, kit oneclick.ts:41-42). A chain joins with its USDC's pin there and its address rule here.
// - The typed address, per chain: Solana 32 bytes of base58, never a key the runtime keeps read-only; Base an EIP-55
//   address (checksum right when it mixes cases), never the zero address (./address.ts checkPoolTo, the pool form's
//   one rule, with no pool to refuse).
// Nothing here logs.
import { checkOneClickQuote, ONECLICK_USDC_ASSETS, type OneClickRequest } from "../../../kit/src/checks/oneclick.ts";
import { NEAR_NETWORKS } from "../../../kit/src/near/networks.ts";
import { DEPOSIT_QUOTE_DEADLINE_MS, DEPOSIT_QUOTE_SLIPPAGE_BPS } from "../../../wallet/src/deposit/quote.ts";
import { DEPOSIT_QUOTE_PATH } from "../rules/deposit-dry.ts";
import { checkPoolTo } from "./address.ts";

/** The chains Cash goes out to beside NEAR. */
export type OnwardChain = "solana" | "base";
/** Where the form sends Cash: a NEAR account, or an address on an onward chain. */
export type WithdrawChain = "near" | OnwardChain;
// NEAR only for now: a part 1Click refunds lands under V_{l,j} inside intents.near, and Solana and Base join this list
// with the carry that brings it back to Cash (cards v-binds-into-the-vault, onward-refund-comes-back), never before:
// no send may leave money the app cannot move.
export const WITHDRAW_CHAINS: readonly WithdrawChain[] = Object.freeze(["near"]);

/** NEAR's USDC on 1Click: the vault's token, what every part leaves the vault in. */
export const ONWARD_ORIGIN = `nep141:${NEAR_NETWORKS.mainnet.usdc}`;
/** Each onward chain's USDC on 1Click, as the kit pins it (ONECLICK_USDC_ASSETS). */
export const ONWARD_USDC: Readonly<Record<OnwardChain, string>> = Object.freeze({
  solana: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
});
const USDC_DECIMALS = 6;
const IMPLICIT = /^[0-9a-f]{64}$/;

export const isOnward = (c: unknown): c is OnwardChain => c === "solana" || c === "base";

/** The typed address on `chain`, cleaned of what a paste carries and checked by the pool form's rule; null when it is not one. */
export function onwardTo(chain: OnwardChain, raw: string): string | null {
  const r = checkPoolTo(chain, raw, { pool: "" });
  return r.ok ? r.to : null;
}

/** The device's request for `amount` of NEAR's USDC to `to` on `chain`, its refund under `refundId` (V_{l,j}), at `now` ms. */
export function onwardQuoteRequest(chain: OnwardChain, to: string, refundId: string, amount: bigint, now: number): OneClickRequest {
  if (!isOnward(chain)) throw new Error("onward quote: not an onward chain");
  if (onwardTo(chain, to) !== to) throw new Error("onward quote: not an address on the chain");
  if (typeof refundId !== "string" || !IMPLICIT.test(refundId)) throw new Error("onward quote: the refund id must be a 64-hex implicit account id");
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("onward quote: the amount must be a positive bigint");
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("onward quote: now must be a time in ms");
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: DEPOSIT_QUOTE_SLIPPAGE_BPS,
    originAsset: ONWARD_ORIGIN,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ONWARD_USDC[chain],
    amount: amount.toString(),
    refundTo: refundId,
    refundType: "INTENTS",
    recipient: to,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + DEPOSIT_QUOTE_DEADLINE_MS).toISOString(),
  };
}

/** A checked onward quote: where the vault pays the part, and the least that reaches the typed address. */
export type OnwardQuote = { depositAddress: string; minOut: bigint };

/**
 * The answer to `request` (onwardQuoteRequest's, for this part) checked: the kit's 1Click check between two of the
 * release's USDC assets, then the signed amount in exactly `amount` and a 64-hex NEAR deposit address. Throws on any
 * other: the kit's OneClickQuoteError, or an Error naming the field.
 */
export function checkOnwardQuote(request: OneClickRequest, answer: unknown, ctx: { chain: OnwardChain; to: string; refundId: string; amount: bigint; now?: number }): OnwardQuote {
  const own = onwardQuoteRequest(ctx.chain, ctx.to, ctx.refundId, ctx.amount, Date.parse(request.deadline) - DEPOSIT_QUOTE_DEADLINE_MS);
  if (JSON.stringify(own) !== JSON.stringify(request)) throw new Error("onward quote: the request is not this part's");
  if (!ONECLICK_USDC_ASSETS.includes(request.destinationAsset)) throw new Error("onward quote: not a pinned USDC");
  const c = checkOneClickQuote(request, answer, { path: DEPOSIT_QUOTE_PATH, pricing: "usdc", decimalsIn: USDC_DECIMALS, decimalsOut: USDC_DECIMALS, intoVault: false, ...(ctx.now === undefined ? {} : { now: ctx.now }) });
  if (c.amountIn !== ctx.amount) throw new Error("onward quote: its amount in is not the part");
  if (typeof c.depositAddress !== "string" || !IMPLICIT.test(c.depositAddress)) throw new Error("onward quote: its deposit address is not a NEAR implicit id");
  return { depositAddress: c.depositAddress, minOut: c.minAmountOut };
}
