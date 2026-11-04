// Where each Portfolio tap goes (card app-portfolio-mount), pure, for routes/PortfolioMount.tsx and its tests.
import { POOL_CHAINS } from "@blindfill/kit";
import type { Chain, PoolChain } from "@blindfill/kit";
import type { PortfolioAction } from "../screens/portfolio/source.tsx";

export type Tap =
  | { to: "deposit" }
  | { to: "withdraw" }
  | { to: "pool.withdraw"; params: { chain: PoolChain } }
  | { to: "export"; chain: Chain; address: string }
  | { to: "none" };

/**
 * Deposit opens the deposit sheet; Withdraw opens SIGN_HOST's withdraw (withdraw.open); a pool row's Withdraw opens
 * SIGN_HOST's pool withdraw for that chain (pool.withdraw, card app-pool-withdraw) with the chain only: the amount and
 * the address are typed on SIGN_HOST's screen, never taken or sent by the app (kit messages.ts); Export opens SIGN_HOST's key
 * export (export.open) for the wallet that holds the position, by chain and address (`wallets` gives the position's
 * wallets from the signing page's state; none known, nothing opens). Sell, the exit plan, share and a receipt's view key
 * belong to screens other cards mount: until they do, those taps do nothing visible.
 */
export function tapOf(a: PortfolioAction, wallets: (chain: Chain, token: string) => readonly string[]): Tap {
  if (a.kind === "deposit") return { to: "deposit" };
  if (a.kind === "withdraw") return { to: "withdraw" };
  if (a.kind === "pool-withdraw") return POOL_CHAINS.includes(a.chain) ? { to: "pool.withdraw", params: { chain: a.chain } } : { to: "none" };
  if (a.kind === "export") {
    const address = wallets(a.chain, a.token)[0];
    return address ? { to: "export", chain: a.chain, address } : { to: "none" };
  }
  return { to: "none" };
}
