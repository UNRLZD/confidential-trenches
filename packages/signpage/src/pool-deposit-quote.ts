// The pool deposit quote rule (card pool-deposit-address): money from another chain into chain X's pool goes by 1Click
// to U_X, the chain's one-time deposit wallet the note store plans, which pool.deposit then moves into X's pool. The
// vault's deposit quote rule (./rules/deposit.ts checkDepositQuote) but for the ends, and nothing else loosened:
// - the backup gate first (OD:20): a no-PRF seed whose code_saved is false gets no quote;
// - the device's own request must be ../../wallet/src/deposit/quote.ts poolDepositQuoteRequest's for X and U_X: X's
//   native coin as the destination (POOL_DEPOSIT_DESTINATION), U_X as `recipient` with DESTINATION_CHAIN (1Click sends
//   the coin to U_X's own address on X), and as `refundTo` with INTENTS the scope's own ed25519 one-time id U_{s,i}
//   (checkPoolDepositWallet: on Solana U_X's own key, on Base and Robinhood the id beside U^evm_{s,i}), the one key the
//   refund move signs with on every chain; ORIGIN_CHAIN, EXACT_INPUT, and no key the vault's request may not carry;
// - then the answer through the kit's one 1Click check (signature under the pinned keys, every signed field equal to
//   the request, a live request taking only a live answer, the signed deadline and timestamp fresh, the device's own
//   floors at its own two price reads per asset), with the output into a pool, never the vault: no MIN_DEPOSIT floor
//   (the pool's own least deposit is pool.deposit's to hold).
// So a helper or 1Click that answers with another recipient or refund fails the echo, and a request built for another
// wallet fails here before the answer is read. A refusal is DepositRuleRefused ("not_allowed") for the request, the
// kit's OneClickQuoteError for the answer.
import { checkOneClickQuote, type OneClickChecked, type OneClickRequest } from "../../kit/src/checks/oneclick.ts";
import { backupFirst } from "../../wallet/src/store/index.ts";
import { POOL_DEPOSIT_DESTINATION, checkPoolDepositWallet, type PoolDepositChain } from "../../wallet/src/deposit/quote.ts";
import { DepositRuleRefused, type DepositQuoteContext } from "./rules/deposit.ts";

/** The request keys a pool deposit quote may carry: the vault's (rules/deposit.ts QUOTE_KEYS), no more. */
const QUOTE_KEYS = new Set([
  "dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo",
  "refundType", "recipient", "recipientType", "deadline", "quoteWaitingTimeMs", "referral",
]);

export interface PoolDepositQuoteContext {
  /** The stored seed's public status: its source and whether its backup is saved. */
  seed: DepositQuoteContext["seed"];
  /** X: the chain whose pool the money goes into. */
  chain: PoolDepositChain;
  /** U_X: the chain's one-time deposit wallet the note store plans, derived on the device (base58 on Solana, EIP-55 on EVM). */
  wallet: string;
  /** U_{s,i}: the 64-hex ed25519 one-time id of the same scope and index, where a refund lands (derived on the device). */
  refundId: string;
  /** The kit's 1Click check options but the output's place: a pool deposit's output never goes into the vault. */
  check: DepositQuoteContext["check"];
}

const refuse = (rule: string): never => {
  throw new DepositRuleRefused(rule);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks the device's own 1Click request for money into chain X's pool and the answer to it. Returns the kit's checked
 * quote (its signed deposit address on a live answer) when every rule holds; throws DepositRuleRefused for the request,
 * or the kit's OneClickQuoteError for the signature, echo and floors.
 */
export function checkPoolDepositQuote(request: OneClickRequest, answer: unknown, ctx: PoolDepositQuoteContext): OneClickChecked {
  if (!ctx.seed || backupFirst(ctx.seed)) refuse("backup");
  if (!Object.hasOwn(POOL_DEPOSIT_DESTINATION, ctx.chain)) refuse("chain");
  try {
    checkPoolDepositWallet(ctx.chain, ctx.wallet, ctx.refundId);
  } catch {
    refuse("deposit_wallet");
  }
  if (!isObj(request)) refuse("request");
  // One read of each field: the rule and the kit's echo see the same request, whatever getters `request` has.
  const req = { ...request } as OneClickRequest;
  if (Object.keys(req).some((k) => !QUOTE_KEYS.has(k))) refuse("request");
  if (req.dry !== false) refuse("dry");
  if (req.swapType !== "EXACT_INPUT") refuse("swapType");
  if (req.depositType !== "ORIGIN_CHAIN") refuse("depositType");
  if (req.destinationAsset !== POOL_DEPOSIT_DESTINATION[ctx.chain]) refuse("destinationAsset");
  if (req.originAsset === req.destinationAsset) refuse("originAsset");
  if (req.recipient !== ctx.wallet) refuse("recipient");
  if (req.recipientType !== "DESTINATION_CHAIN") refuse("recipientType");
  if (req.refundTo !== ctx.refundId) refuse("refundTo");
  if (req.refundType !== "INTENTS") refuse("refundType");
  return checkOneClickQuote(req, answer, { ...ctx.check, intoVault: false });
}
