import { heldKey, readHeldHistory, readHeldMarket } from "@blindfill/kit";
import type { Chain, HeldBar, HeldMarket, PoolChain, SignpageClientSnapshot, SignpageState } from "@blindfill/kit";
import { createContext, useContext, useEffect, useState } from "react";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import { useFilled } from "./fills.ts";
import { heldData, heldRefs } from "./held.ts";
import { balanceOf, heldOf, NO_DATA, portfolio } from "./model.ts";
import type { PortfolioData, Row } from "./model.ts";

// What Portfolio and Activity read and do. The kit gives the signing page's state (cash, wallets, open positions and
// every operation's stage, txs and, kit 1.9, its time, chain, token, units and USD size where the device holds them).
// The held tokens' symbol, name and price and the value line come from the kit's held read (held.ts, card
// market-token-reads); whether a token sells now is not read yet (route null). The closed positions and each open
// one's bought, sold, realized and opened time come from the device's own trade ops (model.ts tradeBook, card
// portfolio-shows-pool-trades); the fees have no call yet, so the screen draws a dash for them. The screen tests pass fixtures through PortfolioSourceProvider, so the same component draws every
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

/** HELPER_HOST (the CSP's connect-src names it, public/_headers). */
const HELPER = "https://ct-api.unrealized.trade";
/** How often the held tokens' prices and their history are read again [design: a price moves by the second, but the
 *  helper holds an EVM token's answer 60 s and the screen is not a chart; the history is hourly bars]. */
const MARKET_MS = 15_000;
const HISTORY_MS = 600_000;

/** The held tokens' market reads (card market-token-reads): the kit's held read and each token's history, read again on
 *  their cadence while the screen is open; the helper is sent the token list only. */
function useHeldReads(state: SignpageState | null): { markets: HeldMarket[]; history: ReadonlyMap<string, readonly HeldBar[]> } {
  const refs = heldRefs(state);
  const key = refs.map((r) => heldKey(r.chain, r.token)).join(",");
  const [markets, setMarkets] = useState<HeldMarket[]>([]);
  const [history, setHistory] = useState<ReadonlyMap<string, readonly HeldBar[]>>(new Map());
  useEffect(() => {
    if (refs.length === 0) return;
    let live = true;
    const prices = () => void readHeldMarket(HELPER, refs).then((m) => live && setMarkets(m));
    const bars = () => void Promise.all(refs.map(async (r) => [heldKey(r.chain, r.token), await readHeldHistory(HELPER, r)] as const)).then((h) => live && setHistory(new Map(h)));
    prices();
    bars();
    const a = setInterval(prices, MARKET_MS);
    const b = setInterval(bars, HISTORY_MS);
    return () => {
      live = false;
      clearInterval(a);
      clearInterval(b);
    };
    // the reads follow the token list, not each state the page sends
  }, [key]);
  return { markets, history };
}

export function usePortfolioSource(act: (a: PortfolioAction) => void): PortfolioSource {
  const fixture = useContext(Fixture);
  const { snapshot } = useSignpage();
  // the trades' fills no holdings read shows yet (fills.ts): the same holding the trade box draws
  const filled = useFilled(fixture?.snapshot ?? snapshot, fixture?.now ?? Date.now);
  const { markets, history } = useHeldReads(fixture ? null : filled.state);
  if (fixture) return filled === fixture.snapshot ? fixture : { ...fixture, snapshot: filled };
  return { snapshot: filled, data: heldData(filled, markets, history, Date.now()), now: Date.now, tzMin: -new Date().getTimezoneOffset(), act };
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

/** One chain's part of Cash (Totals.parts, the parts Cash's hover draws): on NEAR the vault's USDC, what a NEAR buy
 *  spends (card app-near-trading). Null before the first state, or while the part has no dollar figure. */
export function useCashPart(snapshot: SignpageClientSnapshot, chain: Chain): bigint | null {
  const fixture = useContext(Fixture);
  const t = portfolio(snapshot, fixture?.data ?? NO_DATA, fixture?.now() ?? Date.now()).totals;
  return t ? (t.parts.find((p) => p.chain === chain)?.cents ?? 0n) : null;
}

/** The open position on `chain` of `token` in `snapshot` (heldOf), from the same rows Portfolio draws, so the trade box's
 *  Sell side sells the number Portfolio shows; null with no snapshot (signed out) or no such position. */
export function useHeld(snapshot: SignpageClientSnapshot | null, chain: Chain, token: string): Row | null {
  const fixture = useContext(Fixture);
  if (!snapshot) return null;
  return heldOf(portfolio(snapshot, fixture?.data ?? NO_DATA, fixture?.now() ?? Date.now()).rows, chain, token);
}
