// A buy tap's quote on Base and Robinhood (card evm-buy-and-sell-on-mainnet), one implementation for the signing page
// and any app or check: the route order a tap asks the kit's evmPoolBuyQuote in, and the device's pool index sync that
// serves the quote (checks/evm/pool-index.ts, on the venue's two index readers, never the helper). The quote it returns
// is the kit's own, checked as every quote is; the order only decides which route the kit is asked first.
import { evmJsonRpc, evmPoolBuyQuote, evmPoolIndexPools, evmPoolIndexUse, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey } from "../../checks/evm/quote.ts";
import { evmPoolIndexSync, type EvmPoolIndexData, type EvmPoolIndexSync } from "../../checks/evm/pool-index.ts";
import { evmPoolVenues, type EvmPoolChain, type EvmPoolVenueList, type EvmRoute } from "./buy-unpinned.ts";
import { evmHookListed } from "./sell-unpinned.ts";

/** The standard v4 (fee, tick spacing) pairs and v3 fee tiers (the kit's own standard set, checks/evm/quote.ts V4_KEYS
 *  and V3_FEES), first of each asked where no index is served. */
const V4_FIRST: readonly (readonly [number, number])[] = [[3000, 60], [10000, 200], [500, 10], [100, 1]];
const V3_FIRST: readonly number[] = [3000, 500, 10000, 100];
const ZERO = "0x0000000000000000000000000000000000000000";
/** The refusals that name the kit's own best route, which the tap asks once. */
const REQUOTE = new Set(["below_reference", "native_first", "over_gas_floor", "no_quote", "partial_fill"]);
/** The most kit quotes one tap asks, however many pools a token has (anyone can make pools). */
export const EVM_BUY_TAP_QUOTES = 3;
const lower = (s: string): string => s.toLowerCase();

/** A tap no route takes: `not_allowed` where the token's indexed pools are none a buy may take and nothing else quoted
 *  (a coin bought through another hook could have no route out), `quote_check_failed` where every route asked was
 *  refused; `last` is the kit's last refusal. */
export class EvmBuyTapRefused extends Error {
  readonly code: "not_allowed" | "quote_check_failed";
  readonly last: unknown;
  constructor(code: EvmBuyTapRefused["code"], last: unknown) {
    super(`${code}: ${last instanceof Error ? last.message : "no route the tap may take quotes"}`);
    this.code = code;
    this.last = last;
  }
}

export type EvmBuyTapHost = {
  /** The kit's evmPoolBuyQuote otherwise. */
  readonly quote?: (req: EvmPoolBuyQuoteRequest) => Promise<EvmPoolBuyQuote>;
  /** The kit's evmPoolVenues() otherwise. */
  readonly venues?: EvmPoolVenueList;
  /** The kit's evmPoolIndexPools otherwise (null where no index is served). */
  readonly indexPools?: (chain: EvmPoolChain, token: string) => readonly EvmPoolKey[] | null;
};

/** The route that last quoted per chain and token, this module's life: a tap asks it first (one quote a tap). */
const LAST_ROUTE = new Map<string, EvmRoute>();
/** Forgets every token's last route (tests). */
export const evmBuyTapReset = (): void => LAST_ROUTE.clear();

/** A buy tap's quote, EVM_BUY_TAP_QUOTES kit quotes at most:
 *  - first, the route that last quoted for the token; else, with the chain's pool index served, the first of the token's
 *    own v4 pools in it that a buy may take (paired with the native asset or WETH, hookless or a launchpad hook the
 *    venue lists with its fee and tick spacing: sell-unpinned.ts evmHookListed, the sell builder's rule); with no index,
 *    the first standard hookless shape;
 *  - then the first standard v3 tier;
 *  - a refusal that names the kit's own best route (REQUOTE) asks that route once, where the same hook rule takes it:
 *    the kit's best holds every other shape.
 *  A provider's fault (rpc_error, rpc_disagree, stale_quote) is thrown as the kit's; every route refused throws
 *  EvmBuyTapRefused. */
export async function evmPoolBuyQuoteTap(req: { readonly chain: EvmPoolChain; readonly token: string; readonly amountIn: bigint; readonly slippageBps: number }, h: EvmBuyTapHost = {}): Promise<EvmPoolBuyQuote> {
  const { chain, token, amountIn, slippageBps } = req;
  const quote = h.quote ?? evmPoolBuyQuote;
  const v = (h.venues ?? evmPoolVenues())[chain];
  if (v === undefined) throw new EvmBuyTapRefused("not_allowed", null);
  const t = lower(token);
  const weth = lower(v.weth);
  const known = `${chain}:${t}`;
  const v4Of = (k: EvmPoolKey): EvmRoute | null => {
    const other = k.currency0 === t ? k.currency1 : k.currency1 === t ? k.currency0 : null;
    if (other === null || (other !== ZERO && other !== weth)) return null;
    if (k.hooks !== ZERO && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing)) return null;
    return { venue: "uniswap-v4", currencyIn: other, hops: [{ currency: t, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" }] };
  };
  const indexed = (h.indexPools ?? evmPoolIndexPools)(chain, t);
  const v4: EvmRoute[] =
    indexed !== null ? indexed.flatMap((k) => v4Of(k) ?? [])
    : [
        ...V4_FIRST.map(([fee, tickSpacing]): EvmRoute => ({ venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: t, fee, tickSpacing, hooks: ZERO, hookData: "0x" }] })),
        ...(v.hookedPools ?? []).map((p): EvmRoute => ({ venue: "uniswap-v4", currencyIn: p.from === "native" ? ZERO : weth, hops: [{ currency: t, fee: p.fee, tickSpacing: p.tickSpacing, hooks: lower(p.hooks), hookData: "0x" }] })),
      ];
  const v3 = V3_FIRST.map((fee): EvmRoute => ({ venue: "uniswap-v3", tokens: [v.weth, t], fees: [fee] }));
  const last = LAST_ROUTE.get(known);
  const seen = new Set<string>();
  const shapes = [...(last === undefined ? [] : [last]), ...v4, ...v3].filter((r) => {
    const k = JSON.stringify(r);
    return !seen.has(k) && (seen.add(k), true);
  });
  const ask = async (route: EvmRoute) => {
    const q = await quote({ chain, token, amountIn, slippageBps, route });
    LAST_ROUTE.set(known, q.route);
    return q;
  };
  const takes = (r: EvmRoute) =>
    r.venue === "uniswap-v3" || ((r.currencyIn === ZERO || lower(r.currencyIn) === weth) && r.hops.every((p) => p.hooks === ZERO || evmHookListed(chain, p.hooks, p.fee, p.tickSpacing)));
  const tries = [shapes[0]!, ...shapes.slice(1).filter((r) => r.venue === "uniswap-v3").slice(0, 1)];
  let refused = false;
  let lastErr: unknown = null;
  // every kit quote of the tap counts, a followed reference's too: a reference quoted again can itself be refused for
  // a better one (the pools moved between the two quotes: AERO and GOOGLc below_reference, CRCL native_first on real
  // mainnet, 2026-11-13), which is followed while the bound lasts, each route once
  let left = EVM_BUY_TAP_QUOTES;
  const asked = new Set<string>();
  for (const first of tries) {
    let route: EvmRoute | null = first;
    let followed = false;
    while (route !== null && left > 0 && !asked.has(JSON.stringify(route))) {
      left--;
      asked.add(JSON.stringify(route));
      try {
        return await ask(route);
      } catch (e) {
        const err = e as { code?: unknown; reference?: { route: EvmRoute } | null };
        if (err?.code === "rpc_error" || err?.code === "rpc_disagree" || err?.code === "stale_quote") throw e;
        const next = typeof err?.code === "string" && REQUOTE.has(err.code) && err.reference && takes(err.reference.route) ? err.reference.route : null;
        // the kit's own best route refused for another reason than a better one: its name is the tap's
        if (next === null && followed) throw e;
        if (next === null && err?.code !== "no_quote") refused = true;
        lastErr = e;
        route = next;
        followed = next !== null;
      }
    }
    // a reference still left when the bound ran out: the kit's last refusal names it
    if (route !== null && left === 0 && lastErr !== null) throw lastErr;
  }
  // a kept route that quotes no more is asked first no more
  LAST_ROUTE.delete(known);
  throw new EvmBuyTapRefused(!refused && indexed !== null && indexed.length > 0 && v4.length === 0 ? "not_allowed" : "quote_check_failed", lastErr);
}

/** One sync of the chain's pool index from `prev` (none: cold) on the venue's two index readers through `fetchFn`, and a
 *  whole one served to the kit's quote (evmPoolIndexUse). `served` is false where the sync ended partial or the chain
 *  has no index. */
export async function evmPoolIndexRefresh(chain: EvmPoolChain, prev: EvmPoolIndexData | null, fetchFn: typeof fetch = fetch): Promise<{ readonly sync: EvmPoolIndexSync | null; readonly served: boolean }> {
  const v = evmPoolVenues()[chain];
  const ix = v?.index;
  if (v === undefined || ix === undefined || v.poolManager === undefined || v.scan === undefined) return { sync: null, served: false };
  const sync = await evmPoolIndexSync(prev, { chainId: v.chainId, poolManager: v.poolManager, readers: [evmJsonRpc(ix.readers[0], fetchFn, 64 << 20), evmJsonRpc(ix.readers[1], fetchFn, 64 << 20)], depth: v.scan.depth, span: ix.span, margin: ix.margin, cap: ix.cap, perBatch: ix.perBatch, parallel: ix.parallel, ...(ix.batchMax !== undefined ? { batchMax: ix.batchMax } : {}) });
  return { sync, served: sync.index !== null && sync.coversThrough !== null && evmPoolIndexUse(chain, sync) };
}
