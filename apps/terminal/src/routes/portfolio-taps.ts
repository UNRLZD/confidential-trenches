// Where each Portfolio tap goes (card app-portfolio-mount), pure, for routes/PortfolioMount.tsx and its tests.
import { POOL_CHAINS } from "@blindfill/kit";
import type { Chain, PoolChain } from "@blindfill/kit";
import type { PortfolioAction } from "../screens/portfolio/source.tsx";
import { TOKEN_CHAINS, tokenHref } from "./routes.ts";

export type Tap =
  | { to: "deposit" }
  | { to: "withdraw"; from?: PoolChain }
  | { to: "export"; chain: Chain; address: string }
  | { to: "token"; href: string }
  | { to: "none" };

/**
 * Deposit opens the deposit sheet; Withdraw opens the app's own Withdraw (card withdraw-address-in-the-app), and a pool
 * row's Withdraw opens it on that pool (`from`, card withdraw-in-app-to-any-chain): the one form, whose To row sends the
 * money to any chain; SIGN_HOST's own pool form is never opened from here; Export opens SIGN_HOST's key
 * export (export.open) for the one wallet its row names, by chain and address, only when `holds` says the kit's list of
 * the signing page's state (moneyWallets) names that wallet; any other address opens nothing (card
 * app-export-every-wallet). A row's Sell opens its token's page, whose sell box sells it (UNRLZD's portfolio row
 * opens the token; owner 12 Nov parity). The one-tap shares, the exit plan, share and a receipt's view key belong to
 * screens other cards mount: until they do, those taps do nothing visible.
 */
export function tapOf(a: PortfolioAction, holds: (chain: Chain, address: string) => boolean): Tap {
  if (a.kind === "deposit") return { to: "deposit" };
  if (a.kind === "withdraw") return { to: "withdraw" };
  if (a.kind === "pool-withdraw") return POOL_CHAINS.includes(a.chain) ? { to: "withdraw", from: a.chain } : { to: "none" };
  if (a.kind === "export") return holds(a.chain, a.address) ? { to: "export", chain: a.chain, address: a.address } : { to: "none" };
  if (a.kind === "sell" && a.part === "box") {
    const chain = TOKEN_CHAINS.find((c) => c === a.chain);
    return chain ? { to: "token", href: tokenHref(chain, a.token) } : { to: "none" };
  }
  return { to: "none" };
}
