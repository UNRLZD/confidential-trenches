import type { SignpageClientSnapshot } from "@blindfill/kit";
import { createContext, useContext, useEffect, useState } from "react";
import { useReturnHop } from "../../shell/ReturnHop.tsx";
import type { ReturnHopView } from "../../shell/ReturnHop.tsx";
import { useSignpage } from "../../shell/signpage-frame.tsx";

// What the withdraw progress reads and does. The kit gives the withdrawal's id, stage and txs in `state.ops`, and the
// open of SIGN_HOST's form (withdraw.open through the shell's hop, which adds the frozen schema's return key). It does
// not give the amount sent, its asset, the short destination or when the withdrawal started, so the live source answers
// none of them and the screen draws the states without them (named in the card's report). The screen tests pass fixtures
// through WithdrawSourceProvider, so the same component draws every state with no signing page.

/** What S12.14 draws beyond the kit's op. Not in the kit yet. */
export interface WithdrawDetail {
  /** USD, decimal string. */
  amount_usd?: string;
  /** What the address gets, in its asset's units (decimal string), with the asset's symbol. */
  amount?: string;
  symbol?: string;
  /** The destination, shortened by SIGN_HOST (for example "5Ftu…k9Wq"); sent only after SIGN_HOST sent the withdrawal. */
  to?: string;
}

export interface WithdrawSource {
  snapshot: SignpageClientSnapshot;
  moneyOn: boolean;
  hop: ReturnHopView["hop"];
  locked: string | null;
  /** The withdrawal's amount and destination by its op id; null on the live source (not in the kit). */
  detail(id: string): WithdrawDetail | null;
  /** Unix ms; a fixture sets its own clock. */
  now(): number;
}

const Fixture = createContext<WithdrawSource | null>(null);
export const WithdrawSourceProvider = Fixture.Provider;

const noDetail = () => null;

export function useWithdrawSource(): WithdrawSource {
  const fixture = useContext(Fixture);
  const { snapshot, moneyOn } = useSignpage();
  const { hop, locked } = useReturnHop();
  return fixture ?? { snapshot, moneyOn, hop, locked, detail: noDetail, now: Date.now };
}

/** The clock for the counter: one tick a second while it draws, none otherwise. */
export function useNow(clock: () => number, ticking: boolean): number {
  const [now, setNow] = useState(() => clock());
  useEffect(() => {
    setNow(clock());
    if (!ticking) return;
    const t = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(t);
  }, [clock, ticking]);
  return now;
}
