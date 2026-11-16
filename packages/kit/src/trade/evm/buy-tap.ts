// A buy tap's quote on Base and Robinhood (card evm-buy-and-sell-on-mainnet), one implementation for the signing page
// and any app or check: the route order a tap asks the kit's evmPoolBuyQuote in, and the device's pool index sync that
// serves the quote (checks/evm/pool-index.ts, on the venue's two index readers, never the helper). The quote it returns
// is the kit's own, checked as every quote is; the order only decides which route the kit is asked first.
import { evmHeldHead, evmJsonRpc, evmPoolBuyQuote, evmPoolIndexPools, evmPoolIndexUse, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey } from "../../checks/evm/quote.ts";
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

/** A tap no route takes, named by its cause (card base-coin-quote-check-names-its-cause: Paper on Base and NOVAAI on
 *  Robinhood read quote_check_failed on mainnet, which names none):
 *  - `not_allowed`: the token's market is one a buy may not take: the kit's best route for it goes through a hook the
 *    venue does not list or pays in another asset than the native one or WETH (NOVAAI's pool behind hook 0xe5e7…f044),
 *    or its indexed pools are none a buy may take and nothing else quoted (a coin bought through another hook could
 *    have no route out);
 *  - `no_reference`: no pool answers: every route asked quoted nothing and the kit's whole search found no route either
 *    (each refusal's reference none: Paper, whose market is an Aerodrome pool, no Uniswap one);
 *  - `quote_check_failed`: a route was refused for another reason (a partial fill, a quote under the kit's own best).
 *  `last` is the kit's last refusal. */
export class EvmBuyTapRefused extends Error {
  readonly code: "not_allowed" | "no_reference" | "quote_check_failed";
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
  /** The kit's evmHeldHead otherwise: the hash of the block a quote reads at now with no read of its own, or null. */
  readonly held?: (chain: EvmPoolChain) => string | null;
};

/** The route that last quoted per chain and token, this module's life: a tap asks it first (one quote a tap). */
const LAST_ROUTE = new Map<string, EvmRoute>();
/** Each route's refusal per chain, token, amount and slippage, for the one held block it was read at (card
 *  evm-warm-tap-ends-inside-two-seconds): a route refused at a block is refused again at that block (the same reads of
 *  the same block hash), so a tap at that same held block takes the refusal again with no kit quote, and one at any
 *  other block asks it as before. Held only where the held head was the same block before and after the quote, so the
 *  quote read at it; a provider's fault is never held. HOOKR on Robinhood (mainnet from the Mac, 2026-11-15 23:50Z):
 *  its indexed native pool's partial_fill, then the reference's native_first, about 1.8 s and 0.5 s again each warm tap. */
const REFUSED = new Map<string, { readonly at: string; readonly routes: Map<string, unknown> }>();
const REFUSED_KEPT = 256;
/** Forgets every token's last route and held refusals (tests). */
export const evmBuyTapReset = (): void => (LAST_ROUTE.clear(), REFUSED.clear());
const FAULTS = new Set(["rpc_error", "rpc_disagree", "stale_quote"]);

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
  const held = h.held ?? evmHeldHead;
  const refusedKey = `${known}:${amountIn}:${slippageBps}`;
  const ask = async (route: EvmRoute) => {
    const k = JSON.stringify(route);
    const pre = held(chain);
    const kept = REFUSED.get(refusedKey);
    if (pre !== null && kept !== undefined && kept.at === pre && kept.routes.has(k)) throw kept.routes.get(k);
    try {
      const q = await quote({ chain, token, amountIn, slippageBps, route });
      LAST_ROUTE.set(known, q.route);
      return q;
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (pre !== null && typeof code === "string" && !FAULTS.has(code) && held(chain) === pre) {
        const at = REFUSED.get(refusedKey);
        const routes = at !== undefined && at.at === pre ? at.routes : new Map<string, unknown>();
        routes.set(k, e);
        REFUSED.delete(refusedKey);
        REFUSED.set(refusedKey, { at: pre, routes });
        if (REFUSED.size > REFUSED_KEPT) REFUSED.delete(REFUSED.keys().next().value!);
      }
      throw e;
    }
  };
  const takes = (r: EvmRoute) =>
    r.venue === "uniswap-v3" || ((r.currencyIn === ZERO || lower(r.currencyIn) === weth) && r.hops.every((p) => p.hooks === ZERO || evmHookListed(chain, p.hooks, p.fee, p.tickSpacing)));
  const tries = [shapes[0]!, ...shapes.slice(1).filter((r) => r.venue === "uniswap-v3").slice(0, 1)];
  let refused = false;
  // a refusal whose reference (the kit's best route) is one this tap may not take
  let untakeable = false;
  // every refusal so far the kit's whole search finding no route (no_quote or no_reference, no reference)
  let none = true;
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
        if (err?.reference && !takes(err.reference.route)) untakeable = true;
        // native_first with no route the tap may take in its place: the coin's only routes start from WETH, which the
        // kit refuses while a native pool exists, and no native route fills: no route a buy may take (HOOKR and TIBBIR
        // on Robinhood, mainnet 2026-11-15 23:50Z: the WETH-USDG-coin route behind a native pool that cannot fill)
        if (err?.code === "native_first" && next === null) {
          untakeable = true;
          if (followed) throw new EvmBuyTapRefused("not_allowed", e);
        }
        if (!((err?.code === "no_quote" || err?.code === "no_reference") && !err.reference)) none = false;
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
  const hookOnly = !refused && indexed !== null && indexed.length > 0 && v4.length === 0;
  throw new EvmBuyTapRefused(untakeable || hookOnly ? "not_allowed" : none ? "no_reference" : "quote_check_failed", lastErr);
}

/** One sync of the chain's pool index from `prev` (none: cold) on the venue's two index readers through `fetchFn`, and a
 *  whole one served to the kit's quote (evmPoolIndexUse). `served` is false where the sync ended partial or the chain
 *  has no index. Its reads are a background read's (pace.ts `later`): a tap's posts go before them. */
export async function evmPoolIndexRefresh(chain: EvmPoolChain, prev: EvmPoolIndexData | null, fetchFn: typeof fetch = fetch): Promise<{ readonly sync: EvmPoolIndexSync | null; readonly served: boolean }> {
  const v = evmPoolVenues()[chain];
  const ix = v?.index;
  if (v === undefined || ix === undefined || v.poolManager === undefined || v.scan === undefined) return { sync: null, served: false };
  const sync = await evmPoolIndexSync(prev, { chainId: v.chainId, poolManager: v.poolManager, readers: [evmJsonRpc(ix.readers[0], fetchFn, 64 << 20, undefined, true), evmJsonRpc(ix.readers[1], fetchFn, 64 << 20, undefined, true)], depth: v.scan.depth, span: ix.span, margin: ix.margin, cap: ix.cap, perBatch: ix.perBatch, parallel: ix.parallel, ...(ix.batchMax !== undefined ? { batchMax: ix.batchMax } : {}) });
  return { sync, served: sync.index !== null && sync.coversThrough !== null && evmPoolIndexUse(chain, sync) };
}
