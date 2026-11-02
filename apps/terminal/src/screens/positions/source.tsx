import type { Chain } from "@blindfill/kit";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { busy, outcome, progress, READY, tap } from "../trade/model.ts";
import type { Phase } from "../trade/model.ts";
import { useTradeSource } from "../trade/source.tsx";
import type { PartCount } from "../trade/States.tsx";

// What the sell side reads and does. The sell is the kit's own `buy` request with `side: "sell"` (messages.ts
// SignpageParams.buy) through the trade box's source (src/screens/trade/source.tsx: the same TradeKit stub, `request`
// and `onProgress`), so the buy and the sell share one kit seam. Not in the kit yet, so typed here as the stub the screen
// is built on, as the buy side's set preview is: the sell preview (what the share sells for, from the device's own quote
// and pool reads). The live source answers none, so `You receive` draws a dash until the kit has it. The fixture page
// passes the stub through SellKitProvider.

/** Not in the kit: what the sell preview is asked for. `amount` is in the token's units (decimal string). */
export interface SellPreviewRequest {
  chain: Chain;
  token: string;
  amount: string;
  slippage_bps: number;
}

/** Not in the kit: the sell preview for one amount. USD values are decimal strings, as every kit amount. */
export interface SellPreview {
  /** The expected USD out, after the platform fee, before slippage. */
  out_usd: string;
  fee_bps: number;
  network_usd: string;
  route: string;
}

export type SellPreviewAnswer = { ok: true; preview: SellPreview } | { ok: false; code: string };

export interface SellKit {
  /** Missing kit call: the sell preview for a token amount. Null on the live source. */
  sellPreview: ((req: SellPreviewRequest) => Promise<SellPreviewAnswer>) | null;
}

const Kit = createContext<SellKit>({ sellPreview: null });
export const SellKitProvider = Kit.Provider;
export const useSellKit = (): SellKit => useContext(Kit);

/** One position's sell: the buy side's button states, one request for a double tap, shared by the box and the panel. */
export interface Sell {
  phase: Phase;
  /** The share the running or last sell asked for, in basis points. */
  bps: number | null;
  /** The kit can take a sell now. */
  ready: boolean;
  /** A part-filled sell's count of slices, when the kit gives it (TradeKit.part, not in the kit yet). */
  part: PartCount | null;
  now(): number;
  /** Sells `amount` (token units) as `bps` of the position; nothing while a sell runs or with no amount. */
  sell(amount: string | null, bps: number): void;
}

export function useSell(chain: Chain, token: string, slippageBps = 1000): Sell {
  const src = useTradeSource();
  const { kit, moneyOn } = src;
  const [phase, setPhase] = useState<Phase>(READY);
  const ref = useRef<Phase>(READY);
  ref.current = phase;
  const [bps, setBps] = useState<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!kit.onProgress) return;
    return kit.onProgress((id, stage) => setPhase((p) => progress(p, id, stage, src.now())));
  }, [kit.onProgress, src.now]);

  // Landing's counter and Slow: a tick every 100 ms while a sell runs, none otherwise
  useEffect(() => {
    if (!busy(phase)) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [phase.k]);

  const ready = moneyOn && kit.request !== null;
  return {
    phase,
    bps,
    ready,
    part: phase.k === "ended" ? (kit.part?.(phase.id) ?? null) : null,
    now: src.now,
    sell(amount, b) {
      if (!ready || amount === null || busy(ref.current)) return;
      const h = kit.request!("buy", { chain, token, side: "sell", amount, slippage_bps: slippageBps });
      const next = tap(ref.current, h.id, src.now());
      ref.current = next;
      setPhase(next);
      setBps(b);
      void h.outcome.then((o) => setPhase((p) => outcome(p, h.id, o, src.now())));
    },
  };
}
