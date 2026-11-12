// A private trade on NEAR (pool.buy, pool.sell with chain "near"): the vault pays a fresh NEAR wallet W, which trades on
// Rhea classic (packages/kit/src/trade/near/swap.ts) and whose sale goes back into the vault. This file is the page's
// own check of the request's params, hostile in value after the kit's schema let them through: the token a NEAR
// account id, the amount a decimal above 0 in USDC's 6 decimals (a buy spends the vault's USDC), the slippage a whole
// number of bps, 1 to the pool kinds' own cap. A sell names no amount: it sells all W holds of the token (share_bps
// 10,000, one full sell per W), so a part or an amount is refused. The kit's quote and swap rules check the rest again (rheaQuote: the
// token is not USDC; nearSwapFloor: the slippage), so this rule only stops what no read should be made for.
import { POOL_MAX_SLIPPAGE_BPS } from "./pool.ts";

/** The vault's asset on NEAR is USDC: 6 decimals (the kit's POOL_ASSET_DECIMALS.USDC). */
export const NEAR_TRADE_USDC_DECIMALS = 6;
/** A NEAR account id (nomicon: 2 to 64 of a-z, 0-9, separators - _ inside a part, parts joined by "."). */
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const DECIMAL = /^(0|[1-9]\d{0,29})(?:\.(\d{1,18}))?$/;
/** An FT amount is a u128 (NEP-141 U128). */
const U128 = 1n << 128n;

export class NearTradeRefused extends Error {
  readonly rule: "kind" | "chain" | "token" | "amount" | "slippage";
  constructor(rule: NearTradeRefused["rule"]) {
    super(`near trade request refused: ${rule}`);
    this.rule = rule;
  }
}

/** A NEAR buy in the device's terms: USDC base units out of the vault. */
export type NearBuyAsk = { token: string; amount: bigint; slippageBps: number };

export function checkNearBuyRequest(p: { kind?: unknown; chain?: unknown; token?: unknown; amount?: unknown; slippage_bps?: unknown; share_bps?: unknown }): NearBuyAsk {
  if (typeof p !== "object" || p === null || p.kind !== "pool.buy") throw new NearTradeRefused("kind");
  if (p.chain !== "near") throw new NearTradeRefused("chain");
  if (typeof p.token !== "string" || !ACCOUNT.test(p.token)) throw new NearTradeRefused("token");
  if (p.share_bps !== undefined) throw new NearTradeRefused("amount");
  const m = typeof p.amount === "string" ? DECIMAL.exec(p.amount) : null;
  if (!m || (m[2] ?? "").length > NEAR_TRADE_USDC_DECIMALS) throw new NearTradeRefused("amount");
  const amount = BigInt(m[1]! + (m[2] ?? "").padEnd(NEAR_TRADE_USDC_DECIMALS, "0"));
  if (amount === 0n || amount >= U128) throw new NearTradeRefused("amount");
  const s = p.slippage_bps;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > POOL_MAX_SLIPPAGE_BPS) throw new NearTradeRefused("slippage");
  return { token: p.token, amount, slippageBps: s };
}

/** The whole of W's token sold once (one full sell per W): the share 10,000 bps, never an amount or a part of it. */
export const NEAR_SELL_SHARE_BPS = 10_000;
/** A NEAR sell in the device's terms: the token W holds, all of it, sold back to USDC. */
export type NearSellAsk = { token: string; slippageBps: number };

export function checkNearSellRequest(p: { kind?: unknown; chain?: unknown; token?: unknown; amount?: unknown; slippage_bps?: unknown; share_bps?: unknown }): NearSellAsk {
  if (typeof p !== "object" || p === null || p.kind !== "pool.sell") throw new NearTradeRefused("kind");
  if (p.chain !== "near") throw new NearTradeRefused("chain");
  if (typeof p.token !== "string" || !ACCOUNT.test(p.token)) throw new NearTradeRefused("token");
  if (p.amount !== undefined || p.share_bps !== NEAR_SELL_SHARE_BPS) throw new NearTradeRefused("amount");
  const s = p.slippage_bps;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > POOL_MAX_SLIPPAGE_BPS) throw new NearTradeRefused("slippage");
  return { token: p.token, slippageBps: s };
}
