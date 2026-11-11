import type { Chain } from "@blindfill/kit";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { busy, outcome, poolSellAsk, progress, READY, tap } from "../trade/model.ts";
import type { Phase } from "../trade/model.ts";
import { useTradeSource } from "../trade/source.tsx";
import type { PartCount } from "../trade/States.tsx";
import { askSellPreview, baseUnits, sellLocked } from "./model.ts";
import type { Tapped } from "./model.ts";

// What the sell side reads and does. The sell is the kit's own `buy` request with `side: "sell"` (messages.ts
// SignpageParams.buy) through the trade box's source (src/screens/trade/source.tsx: the same TradeKit stub, `request`
// and `onProgress`), so the buy and the sell share one kit seam. The sell preview (what the share sells for) is the
// signing page's pool.sell.dry (card app-sell-shows-what-you-receive: the sale's own quote on the device's pool reads),
// asked through the same client for exactly what the tap would ask, in USD at the page's own pool price (model.ts
// askSellPreview). The live source gives it with no provider; a fixture passes its own stub through SellKitProvider.

/** What the sell preview is asked for: `amount` the share's token units (decimal string), `share_bps` the share. */
export interface SellPreviewRequest {
  chain: Chain;
  token: string;
  amount: string;
  share_bps: number;
  slippage_bps: number;
}

/** The sell preview for one share. USD values are decimal strings, as every kit amount. */
export interface SellPreview {
  /** The expected USD out, the venue's fees taken, before slippage. */
  out_usd: string;
  fee_bps: number;
  network_usd: string;
}

export type SellPreviewAnswer = { ok: true; preview: SellPreview } | { ok: false; code: string };

export interface SellKit {
  /** The sell preview for a share. Null while the signing page has no client yet. */
  sellPreview: ((req: SellPreviewRequest) => Promise<SellPreviewAnswer>) | null;
}

const Kit = createContext<SellKit | null>(null);
export const SellKitProvider = Kit.Provider;

/** The fixture's stub, else the live source: pool.sell.dry through the trade box's client (askSellPreview). The call
 *  reads the newest state and price when it runs, and changes only when the client comes or a chain's pool or price
 *  comes or goes, so a state event never asks again (the page's reads are paced; card app-sell-shows-what-you-receive). */
export function useSellKit(): SellKit {
  const fixture = useContext(Kit);
  const { snapshot, kit } = useTradeSource();
  const pools = snapshot.state?.pools;
  const latest = useRef({ pools, kit });
  latest.current = { pools, kit };
  const on = kit.request !== null;
  const key = (pools ?? []).map((p) => `${p.chain}:${p.price ? 1 : 0}`).join(",");
  const live = useMemo<SellKit>(
    () => ({ sellPreview: on ? (req) => askSellPreview(latest.current.kit.request, latest.current.pools, (c) => latest.current.kit.poolPrice(c), req) : null }),
    [on, key],
  );
  return fixture ?? live;
}

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
