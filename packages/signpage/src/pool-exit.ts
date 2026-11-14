// A pool payout to another chain on SIGN_HOST (card pool-withdraws-to-any-chain; Blindfill v2 lite paper §3 "Exit: to
// any chain"). The pool withdraw form (./withdraw/pool-form.ts) hands over the chain the money arrives on and the
// address typed for it; the withdraw run (./pool-withdraw.ts, ./pool-withdraw-evm.ts) plans its parts as for any To and,
// before any note moves, asks `exit` here with its first W as the refund address. `exit`:
// - builds the device's own 1Click request from the ask (the kit's oneClickExitRequest: the pool's coin in, the chain's
//   coin out, amount = the payout, recipient = the typed address, refund ORIGIN_CHAIN to the first W, which already
//   sends to this quote's address in the same withdraw, so the quote's public refund field links nothing new; a W is
//   derived from the 12 words and its note, so a restore finds it);
// - asks it through the helper's 1Click proxy (the deposit quote's ask, ../../wallet/src/deposit/quote.ts
//   askDepositQuoteAgain), stopped by a sign out;
// - checks the answer with the kit's exit check (../../kit/src/checks/oneclick-exit.ts: the kit's 1Click check at the
//   device's own price reads of both coins, then amountIn = the payout and minAmountOut within the slippage), and
//   answers its signed deposit address, which must be an address of the pool's chain. The run then checks it as any
//   To (never the pool's own keys, never one of the run's Ws, never executable or the pool program's).
// Any refusal throws: the run stops before its first part, nothing bound, nothing sent.
// Exits run on mainnet only (POOL_DEPOSIT_NETWORK: 1Click pays out on mainnet); the testnet build offers no other chain.
// Nothing here logs.
import { base58 } from "@scure/base";
import { checkOneClickExitQuote, oneClickExitRequest, type ExitAsk, type ExitChain } from "../../kit/src/checks/oneclick-exit.ts";
import type { PoolChain, PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import { POOL_DEPOSIT_NETWORK, askDepositQuoteAgain } from "../../wallet/src/deposit/quote.ts";
import { usdOf } from "./pool-deposit-address.ts";
import { DEPOSIT_ANSWERED, DEPOSIT_QUOTE_PATH } from "./rules/deposit-dry.ts";
import { EVM_ADDRESS } from "./rules/pool.ts";
import { EXIT_CHAINS, type PoolReady } from "./withdraw/pool-form.ts";

export type PoolExitDeps = {
  /** The page's network (src/pools.ts PAGE_NETWORK): exits only on POOL_DEPOSIT_NETWORK. */
  network: string;
  /** The device's own price of each pool chain's coin (src/pool-price.ts get), null past its bound. */
  price(chain: PoolChain): Pick<PoolStatePrice, "price" | "expo"> | null;
  fetch?: typeof fetch;
  /** The page's stop for quote asks (src/quotes-stop.ts): a sign out stops the ask. */
  stop?: () => AbortSignal;
  now?: () => number;
};

export class PoolExitRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`exit refused: ${code}`);
    this.name = "PoolExitRefused";
    this.code = code;
  }
}

/** The other chains a pool on `chain` pays out to on this page: every one of EXIT_CHAINS on mainnet (1Click's token
 *  list and a dry quote from each pool coin, read 2026-11-13T20:08Z), none on testnet. */
export const exitsOf = (deps: Pick<PoolExitDeps, "network">, chain: PoolChain): readonly ExitChain[] | undefined =>
  deps.network === POOL_DEPOSIT_NETWORK ? EXIT_CHAINS.filter((c) => c !== chain) : undefined;

/** An address of the pool's chain, as a deposit address must be. */
const onChain = (chain: PoolChain, a: string): boolean => {
  if (chain !== "solana") return EVM_ADDRESS.test(a);
  try {
    return base58.decode(a).length === 32 && base58.encode(base58.decode(a)) === a;
  } catch {
    return false;
  }
};

/** The run's exit for `ready`, or none when it pays To on the pool's own chain. */
export function poolExit(deps: PoolExitDeps, ready: PoolReady): ((refundTo: string) => Promise<string>) | undefined {
  const dest = ready.dest;
  if (dest === undefined) return undefined;
  return async (refundTo) => {
    if (exitsOf(deps, ready.chain)?.includes(dest) !== true) throw new PoolExitRefused("chain");
    const now = deps.now ?? Date.now;
    const ask: ExitAsk = { from: ready.chain, to: dest, recipient: ready.to, payout: ready.amount, refundTo };
    const request = oneClickExitRequest(ask, now());
    const reply = await askDepositQuoteAgain(request, deps.fetch, undefined, undefined, deps.stop?.());
    if (!DEPOSIT_ANSWERED.includes(reply.status)) throw new PoolExitRefused(`status ${reply.status}`);
    // the prices as they are at the check, both coins' (USDC on NEAR at 1)
    const pin = deps.price(ready.chain);
    const pout = dest === "near" ? null : deps.price(dest);
    if (pin === null || (dest !== "near" && pout === null)) throw new PoolExitRefused("price");
    const pIn = usdOf(pin), pOut = pout === null ? "1" : usdOf(pout);
    const checked = checkOneClickExitQuote(ask, request, reply.body, { path: DEPOSIT_QUOTE_PATH, pricing: { in: [pIn, pIn], out: [pOut, pOut] }, now: now() });
    if (!onChain(ready.chain, checked.depositAddress)) throw new PoolExitRefused("deposit address");
    return checked.depositAddress;
  };
}
