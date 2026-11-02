import type { Chain, SignpageClientSnapshot } from "@blindfill/kit";
import { createContext, useContext } from "react";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import type { PortfolioData } from "./model.ts";

// What Portfolio and Activity read and do. The kit gives the signing page's state (cash, wallets, open positions and
// every operation's stage and txs). It has no call yet for the rest of PortfolioData (model.ts: the market reads, the
// position extras, the closed positions, the value series, the fees and each operation's facts), so the live source
// answers none of them and the screen draws what the kit gives with dashes for the rest; the card's report names each
// missing call. The screen tests pass fixtures through PortfolioSourceProvider, so the same component draws every
// state with no signing page.

/** What a tap asks of the mount: the trade box's sell, the exit plan, the share sheet, SIGN_HOST's key export and the
 *  other drawers live on other cards' screens, so Portfolio only names the position. */
export type PortfolioAction =
  | { kind: "deposit" }
  | { kind: "withdraw" }
  | { kind: "sell"; chain: Chain; token: string; part: "25" | "50" | "100" | "initials" | "box" }
  | { kind: "exit" | "share" | "export"; chain: Chain; token: string }
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

export const NO_DATA: PortfolioData = { market: () => null, extra: () => null, closed: [], series: [], fees: null, op: () => null, exported: [] };

export function usePortfolioSource(act: (a: PortfolioAction) => void): PortfolioSource {
  const fixture = useContext(Fixture);
  const { snapshot } = useSignpage();
  return fixture ?? { snapshot, data: NO_DATA, now: Date.now, tzMin: -new Date().getTimezoneOffset(), act };
}
