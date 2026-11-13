// The rule that refused a trade, kept on the page's own refusal (card evm-buy-and-sell-on-mainnet): a copy run's tap
// answered quote_check_failed and nothing named why, so each guess at the cause cost a run. The name is one fixed word
// from the lists below, never a value: a rule's own text, an address, an amount or a provider's message never rides in
// it, whatever the error carries. A word that is on no list is "other". The wire to the app is unchanged (api.ts give
// posts the refusal's code alone).
import type { EvmQuoteErrorCode } from "../../kit/src/checks/evm/quote.ts";
import { EvmBuyTapRefused } from "../../kit/src/trade/evm/buy-tap.ts";
import type { EvmPoolBuyErrorCode } from "../../kit/src/trade/evm/buy-unpinned.ts";
import type { EvmPoolSellErrorCode } from "../../kit/src/trade/evm/sell-unpinned.ts";

/** Every rule word the device's rules refuse with (rules/pool.ts refuse, PoolRuleRefused): the test reads them from the
 *  source, so a rule added there is added here. */
export const POOL_RULE_WORDS: ReadonlySet<string> = new Set([
  "access_list", "adapter", "amount", "balance", "blockhash", "call", "carry_whole", "chain", "chain_id", "compute_budget",
  "context", "cu_limit", "cu_price", "data", "deadline_past", "decimals", "decode", "delegate_not_pinned",
  "deposit_accounts", "deposit_amount", "deposit_data", "deposit_floor", "deposit_reads", "depositor", "depth",
  "evm_not_pinned", "fee_cap", "fee_cap_over_device_cap", "fee_over_cap", "fee_payer", "fee_recipient", "floor",
  "gas_estimate", "gas_limit", "gas_over_cap", "instructions", "kind", "l1_fee", "label_page", "max_fee", "min_out",
  "nonce", "not_quoted", "pieces", "pool", "precommitment", "precommitment_mark", "priority_fee", "program", "reads",
  "recipient", "relay", "release_accounts", "release_data", "release_not_devices", "reserve", "sell", "sell_accounts",
  "signature_slots", "signers", "sim_block_after_clock", "sim_deadline", "sim_pool", "simulation", "slippage",
  "solana_not_pinned", "state_page", "sweep_amount", "sweep_reads", "system", "table", "tag", "teardown", "to", "token",
  "transfer", "transfer_amount", "transfer_to", "tx_fields", "type", "unchecked", "value", "wallet", "wire",
]);

const QUOTE_CODES = [
  "bad_request", "token_mismatch", "no_quoter", "rpc_error", "rpc_disagree", "no_quote", "partial_fill", "below_reference",
  "native_first", "no_reference", "stale_quote", "too_many_pools", "fee_on_transfer", "not_landed", "below_minimum",
  "no_exit", "out_of_gas", "over_gas_floor",
] as const satisfies readonly EvmQuoteErrorCode[];
const BUILD_CODES = [
  "weth_after_first", "middle_not_listed", "token_mismatch", "not_built", "bad_route", "bad_amount", "bad_key",
  "not_deployed", "not_pinned",
] as const satisfies readonly EvmPoolBuyErrorCode[];
const SELL_CODES = [
  "bad_target", "token_mismatch", "middle_not_listed", "bad_route", "bad_amount", "bad_fee", "bad_deadline", "not_built",
  "bad_key", "not_deployed", "not_pinned", "release_in_flight",
] as const satisfies readonly EvmPoolSellErrorCode[];
// each kit code is on its list: a code the kit adds fails the page's typecheck here until it is listed
const whole = <T extends string, L extends readonly T[]>(_: L & ([Exclude<T, L[number]>] extends [never] ? unknown : never)): true => true;
whole<EvmQuoteErrorCode, typeof QUOTE_CODES>(QUOTE_CODES);
whole<EvmPoolBuyErrorCode, typeof BUILD_CODES>(BUILD_CODES);
whole<EvmPoolSellErrorCode, typeof SELL_CODES>(SELL_CODES);

/** The kit's quote, buy and sell codes (EvmQuoteError, EvmPoolBuyError, EvmPoolSellError), each a fixed word. */
export const KIT_CODE_WORDS: ReadonlySet<string> = new Set<string>([...QUOTE_CODES, ...BUILD_CODES, ...SELL_CODES]);

/** The fixed word naming why `e` refused: a device rule's (PoolRuleRefused.rule), else the kit's code (EvmQuoteError,
 *  EvmPoolBuyError, EvmPoolSellError; through an EvmBuyTapRefused, its last refusal's), else "other". */
export function refusalRule(e: unknown, depth = 0): string {
  const o = e as { name?: unknown; rule?: unknown; code?: unknown; last?: unknown } | null;
  if (o === null || typeof o !== "object") return "other";
  if (o.name === "PoolRuleRefused") return typeof o.rule === "string" && POOL_RULE_WORDS.has(o.rule) ? o.rule : "other";
  if (o.name === "EvmQuoteError" || o.name === "EvmPoolBuyError" || o.name === "EvmPoolSellError") return typeof o.code === "string" && KIT_CODE_WORDS.has(o.code) ? o.code : "other";
  if (e instanceof EvmBuyTapRefused && depth === 0 && e.last !== null && e.last !== undefined) return refusalRule(e.last, 1);
  return "other";
}
