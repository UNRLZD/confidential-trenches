import type { Chain, PoolChain, SignpageClientSnapshot } from "@blindfill/kit";
import { createContext, useContext } from "react";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import { balanceOf, heldOf, NO_DATA, portfolio } from "./model.ts";
import type { PortfolioData, Row } from "./model.ts";

// What Portfolio and Activity read and do. The kit gives the signing page's state (cash, wallets, open positions and
// every operation's stage, txs and, kit 1.9, its time, chain, token, units and USD size where the device holds them). It
// has no call yet for the rest of PortfolioData (model.ts: the market reads, the position extras, the closed positions,
// the value series and the fees), so the live source
// answers none of them and the screen draws what the kit gives with dashes for the rest; the card's report names each
// missing call. The screen tests pass fixtures through PortfolioSourceProvider, so the same component draws every
// state with no signing page.

/** What a tap asks of the mount: the trade box's sell, the exit plan, the share sheet, SIGN_HOST's key export and the
 *  other drawers live on other cards' screens, so Portfolio only names the position. */
export type PortfolioAction =
  | { kind: "deposit" }
  | { kind: "withdraw" }
  | { kind: "pool-withdraw"; chain: PoolChain }
  | { kind: "sell"; chain: Chain; token: string; part: "25" | "50" | "100" | "initials" | "box" }
  | { kind: "exit" | "share"; chain: Chain; token: string }
  /** One wallet's key export, by its chain and address (card app-export-every-wallet). */
  | { kind: "export"; chain: Chain; address: string }
  | { kind: "view-key"; id: string };

export interface PortfolioSource {
  snapshot: SignpageClientSnapshot;
  data: PortfolioData;
  /** Unix ms; a fixture sets its own clock. */
  now(): number;
  /** Minutes east of UTC, for Activity's day headers. */
  tzMin: number;
  act(a: PortfolioAction): void;
}

const Fixture = createContext<PortfolioSource | null>(null);
export const PortfolioSourceProvider = Fixture.Provider;

export { NO_DATA };

export function usePortfolioSource(act: (a: PortfolioAction) => void): PortfolioSource {
  const fixture = useContext(Fixture);
  const { snapshot } = useSignpage();
  return fixture ?? { snapshot, data: NO_DATA, now: Date.now, tzMin: -new Date().getTimezoneOffset(), act };
}

/** The one balance for `snapshot` (balanceOf: Portfolio's Cash), from the same data Portfolio reads. */
export function useBalance(snapshot: SignpageClientSnapshot): bigint | null {
  const fixture = useContext(Fixture);
  return balanceOf(snapshot, fixture?.data ?? NO_DATA, fixture?.now() ?? Date.now());
}

/** Cash less the SOL and ETH pools (Totals.offPool, card portfolio-one-balance): what the trade box's Bal draws on a
 *  chain it buys on with no pool, the vault path's money; the pool chains draw their own pool. Null before the first state. */
export function useOffPool(snapshot: SignpageClientSnapshot): bigint | null {
  const fixture = useContext(Fixture);
  return portfolio(snapshot, fixture?.data ?? NO_DATA, fixture?.now() ?? Date.now()).totals?.offPool ?? null;
}

/** The open position on `chain` of `token` in `snapshot` (heldOf), from the same rows Portfolio draws, so the trade box's
 *  Sell side sells the number Portfolio shows; null with no snapshot (signed out) or no such position. */
export function useHeld(snapshot: SignpageClientSnapshot | null, chain: Chain, token: string): Row | null {
  const fixture = useContext(Fixture);
  if (!snapshot) return null;
  return heldOf(portfolio(snapshot, fixture?.data ?? NO_DATA, fixture?.now() ?? Date.now()).rows, chain, token);
}
