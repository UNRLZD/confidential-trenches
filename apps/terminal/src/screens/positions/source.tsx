import type { Chain } from "@blindfill/kit";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { busy, outcome, poolSellAsk, progress, READY, tap } from "../trade/model.ts";
import type { Phase } from "../trade/model.ts";
import { useTradeSource } from "../trade/source.tsx";
import type { PartCount } from "../trade/States.tsx";
import { baseUnits, sellLocked } from "./model.ts";
import type { Tapped } from "./model.ts";

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
  /** The kit can take a sell now: no sell is open on the device and the last one's end has reached the row (sellLocked). */
  ready: boolean;
  /** A sell's lock holds (model.ts sellLocked): the row drawn may be what was held before a sell. */
  locked: boolean;
  /** The sell goes into the chain's pool: its proceeds land back in the pool (pool.sell). */
  pool: boolean;
  /** A part-filled sell's count of slices, when the kit gives it (TradeKit.part, not in the kit yet). */
  part: PartCount | null;
  now(): number;
  /** Sells `amount` (token units) as `bps` of the position; nothing while a sell runs or with no amount. `decimals` is the
   *  token's (the token read's): the vault's sell takes whole base units, so with none it is refused here, never sent. */
  sell(amount: string | null, bps: number, decimals?: number | null): void;
}

/** The holding each sell was tapped on (chain, token, units), by its request id, kept for the page: a box mounted again
 *  reads them (sellLocked). A refused sell leaves it; a reload starts it empty. */
const TAPPED = new Map<string, Tapped>();
let refusedHere = 0;

/** `units` is the row's units now (null with no row): the sell's lock reads it (model.ts sellLocked). */
export function useSell(chain: Chain, token: string, slippageBps = 1000, units: string | null = null): Sell {
  const src = useTradeSource();
  const { kit, moneyOn } = src;
  const [phase, setPhase] = useState<Phase>(READY);
  const ref = useRef<Phase>(READY);
  ref.current = phase;
  const [bps, setBps] = useState<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!kit.onProgress) return;
    // the time is read when the stage arrives, not when React renders it: a late render must not stretch Filled's time
    return kit.onProgress((id, stage) => {
      const at = src.now();
      setPhase((p) => progress(p, id, stage, at));
    });
  }, [kit.onProgress, src.now]);

  // Landing's counter and Slow: a tick every 100 ms while a sell runs, none otherwise
  useEffect(() => {
    if (!busy(phase)) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [phase.k]);

  // a tapped sell the record has shown once is the record's from then on (sellLocked)
  for (const o of src.snapshot.state?.ops ?? []) {
    const t = TAPPED.get(o.id);
    if (t && !t.seen) TAPPED.set(o.id, { ...t, seen: true });
  }
  const locked = sellLocked(phase, src.snapshot, { chain, token, units }, TAPPED);
  const ready = moneyOn && kit.request !== null && !locked;
  return {
    phase,
    bps,
    ready,
    locked,
    pool: poolSellAsk(src.snapshot.state?.pools, chain, token, { share_bps: 10_000 }, slippageBps) !== null,
    part: phase.k === "ended" ? (kit.part?.(phase.id) ?? null) : null,
    now: src.now,
    sell(amount, b, decimals = null) {
      if (!ready || amount === null || busy(ref.current)) return;
      // a chain whose pool the signing page reports sells into it: the proceeds go back into the pool in the same
      // transaction (card trade-box-pool), asked as the share `b` of the whole holding, which the signing page turns
      // into units from its own reads of every wallet that holds the token, never this row's amount (a server's read
      // on mainnet; card pool-sell-share-across-wallets); other chains keep the vault's sell, in whole base units
      // (trade.ts UNITS)
      const ask = poolSellAsk(src.snapshot.state?.pools, chain, token, { share_bps: b }, slippageBps);
      const base = baseUnits(amount, decimals);
      if (!ask && base === null) {
        // no decimals read (or a share finer than the token's): the vault would refuse it, so nothing is sent
        const next: Phase = { k: "ended", id: `refused-here-${++refusedHere}`, at: src.now(), stage: "refused", code: "not_allowed" };
        ref.current = next;
        setPhase(next);
        setBps(b);
        return;
      }
      const h = ask ? kit.request!(ask.kind, ask.params) : kit.request!("buy", { chain, token, side: "sell", amount: base!, slippage_bps: slippageBps });
      TAPPED.set(h.id, { chain, token, units });
      const next = tap(ref.current, h.id, src.now());
      ref.current = next;
      setPhase(next);
      setBps(b);
      void h.outcome.then((o) => {
        // a refusal sold nothing: its holding is not held for it (a client timeout says nothing yet, so it stays)
        if (!o.ok && o.error.code !== "client_timeout") TAPPED.delete(h.id);
        const at = src.now();
        setPhase((p) => outcome(p, h.id, o, at));
      });
    },
  };
}
