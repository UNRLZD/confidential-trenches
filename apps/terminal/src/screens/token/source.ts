// Where the token page's data comes from while it runs on fixtures (card app-token-page). `?fx=<name>` picks a fixture
// token or a state; no `fx` is the curve token. The market data read replaces this file on its own card; the page
// (TokenPage.tsx) takes `TokenData` and does not change.
import type { MarketRow } from "../discover/fields.ts";
import { TOKENS } from "./fixtures.ts";

export type TokenData = { status: "loading" } | { status: "error" } | { status: "empty" } | { status: "ready"; row: MarketRow };

/** The data for a location's search string (`?fx=listed`); an unknown name is the empty state. */
export function tokenData(search: string): TokenData {
  const fx = new URLSearchParams(search).get("fx") ?? "curve";
  if (fx === "loading" || fx === "error" || fx === "empty") return { status: fx };
  return Object.hasOwn(TOKENS, fx) ? { status: "ready", row: TOKENS[fx]! } : { status: "empty" };
}
