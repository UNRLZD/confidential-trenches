import type { Chain, SignpageClient, SignpageClientSnapshot } from "@blindfill/kit";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import { poolPriceEnd, statePoolPrice, type PoolPrice, type Slice } from "./model.ts";
import type { RouteData } from "./route.ts";
import type { PartCount } from "./States.tsx";

// What the trade box's buy side reads and does. From the kit's public entry: the balance (`state.vault_balance`), the
// buy (`request("buy", ...)`, kind `buy` of messages.ts) and its stages (`onProgress`). Not in the kit yet, so typed
// here as the stub the screen is built on, shaped from markets.md T1.3 (M:216-251) and T2.1 (M:289) and the
// solana-buy-flow card: the set preview (the ready set's slices for an amount and the set's expected out and costs)
// and the chain's max buy (`max_buy_cents`, 09-design-brief S8 Max). The live source answers neither, so the box draws
// no estimate and keeps Buy off until the kit has them. The fixture page passes the stub through TradeSourceProvider.

/** Not in the kit: what the set preview is asked for. Amounts are decimal strings, as every kit amount. */
export interface SetPreviewRequest {
  chain: Chain;
  token: string;
  /** USD. */
  amount: string;
  slippage_bps: number;
}

/** Not in the kit: the set preview for one amount, from the device's own quotes and pool reads. */
export interface SetPreview {
  /** The ready wallets and the USD each spends, as the kit split the amount. */
  slices: Slice[];
  /** The set's expected out, in the token's units (decimal string), before slippage. */
  out: string;
  /** The platform fee in basis points and in USD, and the network fee in USD, for the whole set. */
  fee_bps: number;
  fee_usd: string;
  network_usd: string;
  /** The route's name where users see it: on Solana "Metis" (Jupiter's license, 09-design-brief §2.3). */
  route: string;
}

/** Not in the kit: the preview's answer; a refusal carries the kit's code (no route, no ready set). */
export type SetPreviewAnswer = { ok: true; preview: SetPreview } | { ok: false; code: string };

/** The kit stub the box is built on. `request` and `onProgress` are the kit's own; the other two are missing calls. */
export interface TradeKit {
  /** Missing kit call: the set preview for an amount. Null on the live source. */
  setPreview: ((req: SetPreviewRequest) => Promise<SetPreviewAnswer>) | null;
  /** Missing kit call: the chain's max buy in USD (decimal string), from the public max-buy read. Null: not read. */
  maxBuy: (chain: Chain) => string | null;
  request: SignpageClient["request"] | null;
  onProgress: SignpageClient["onProgress"] | null;
  /** Missing kit call: how many of a part-filled trade's slices landed, by the request's id. Absent: not read, so a
   *  part fill draws without a count. */
  part?: (id: string) => PartCount | null;
  /** The pool asset's USD price on the chain, the device's own read (the kit's poolUsdPrice: two RPCs of two providers
   *  that agree, fresh). Null: not read or past its bound, so the pool path draws no USD and keeps Buy off. APP_HOST's
   *  connect-src reaches no Solana, Base or Robinhood RPC, so the signing page reads it and puts it in its state; the
   *  live source reads state.pools[chain].price only, checked against its feed's bound at each call (card
   *  signpage-pool-price, model.ts statePoolPrice). */
  poolPrice: (chain: Chain) => PoolPrice | null;
  /** Missing kit call (card app-buy-route-strip): what the signing page is to tell the app of a running buy besides its
   *  stage, by the request's id: the fresh wallet it assigned, the quote's venue and pool address, the amount filled
   *  read back on chain. The page's `progress` carries a stage and nothing else today, so the live source has none:
   *  the strip's steps check on the stages, their values stay empty, and none is made up. Returns the unsubscribe. */
  route?: ((on: (d: RouteData) => void) => () => void) | null;
}

export interface TradeSource {
  snapshot: SignpageClientSnapshot;
  moneyOn: boolean;
  kit: TradeKit;
  /** Unix ms; a fixture sets its own clock. */
  now(): number;
}

const Fixture = createContext<TradeSource | null>(null);
export const TradeSourceProvider = Fixture.Provider;

const noMax = () => null;

export function useTradeSource(): TradeSource {
  const fixture = useContext(Fixture);
  const { client, snapshot, moneyOn } = useSignpage();
  const pools = snapshot.state?.pools;
  // a price that passes its bound with no new state after it: one more render then, which draws it gone and Buy off
  const [, expire] = useState(0);
  useEffect(() => {
    if (fixture) return;
    const now = Date.now();
    const ends = (pools ?? []).map(poolPriceEnd).filter((e): e is number => e !== null && e >= now);
    if (ends.length === 0) return;
    const t = setTimeout(() => expire((n) => n + 1), Math.min(...ends) - now + 1);
    return () => clearTimeout(t);
  }, [fixture, pools]);
  const kit = useMemo<TradeKit>(
    () => ({
      setPreview: null,
      maxBuy: noMax,
      poolPrice: (chain) => statePoolPrice(pools, chain, Date.now()),
      request: client ? client.request.bind(client) : null,
      onProgress: client ? client.onProgress.bind(client) : null,
    }),
    [client, pools],
  );
  return fixture ?? { snapshot, moneyOn, kit, now: Date.now };
}
