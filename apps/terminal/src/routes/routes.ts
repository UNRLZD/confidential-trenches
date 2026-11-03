// One route per screen (master v21, App lead lanes). Each is empty until its own card fills it; `id` is what the
// screen's <main data-route> carries, so a check can tell a route that rendered from the fallback.
import type { MarketChain } from "../screens/discover/fields.ts";

export type RouteId = "token" | "discover" | "portfolio" | "orders" | "profile" | "verify" | "privacy" | "terms";

/** A token's own page: /token/<chain>/<id>. Public and permanent (a shared link, the shell's address): the chain is the
 *  helper's own chain id (06b), the id the token's id in that chain's form. "/" draws the top Trending token. */
export const TOKEN_ROUTE = "/token/:chain/:id";

export const ROUTES: readonly { id: RouteId; path: string }[] = [
  { id: "token", path: "/" },
  { id: "token", path: TOKEN_ROUTE },
  { id: "discover", path: "/discover" },
  { id: "portfolio", path: "/portfolio" },
  { id: "orders", path: "/orders" },
  { id: "profile", path: "/profile" },
  { id: "verify", path: "/verify" },
  { id: "privacy", path: "/privacy" },
  { id: "terms", path: "/terms" },
];

/** The chains a token route names: the helper's own spellings (it serves chain=base and chain=robinhood), nothing else. */
export const TOKEN_CHAINS = ["solana", "base", "robinhood", "near"] as const satisfies readonly MarketChain[];

/** A row's link to its token's page. The id is one path segment (encoded); the chain is one of TOKEN_CHAINS. */
export const tokenHref = (chain: MarketChain, id: string): string => `/token/${chain}/${encodeURIComponent(id)}`;

/** The token a route's params name, or null when the chain is not one the terminal draws or the id is missing. */
export function parseTokenRoute(p: { chain?: string; id?: string }): { chain: MarketChain; id: string } | null {
  const chain = TOKEN_CHAINS.find((c) => c === p.chain);
  return chain && p.id ? { chain, id: p.id } : null;
}
