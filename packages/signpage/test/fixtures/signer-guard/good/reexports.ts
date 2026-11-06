// planted (card signer-guard-parser), no refusal: re-exports, as the kit's index has, and type reads sign nothing
export * from "../../../../../kit/src/trade/evm/sell.ts";
export { signEvmSell as ruleSignSell, signEvmSellSim } from "../../../../src/rules/pool.ts";
import type { evmPoolSignSell } from "../../../../../kit/src/index.ts";
import { evmIsQuotedSell } from "../../../../../kit/src/trade/evm/quoted.ts";

export type Signer = typeof evmPoolSignSell;
// a predicate builds and signs nothing; a word in a comment, signEvmSell(key, ctx, built), signs nothing either
export const isQuoted = (s: never) => evmIsQuotedSell(s);
