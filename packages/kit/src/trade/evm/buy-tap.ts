// A buy tap's quote on Base and Robinhood (card evm-buy-and-sell-on-mainnet), one implementation for the signing page
// and any app or check: the route order a tap asks the kit's evmPoolBuyQuote in, and the device's pool index sync that
// serves the quote (checks/evm/pool-index.ts, on the venue's two index readers, never the helper). The quote it returns
// is the kit's own, checked as every quote is; the order only decides which route the kit is asked first.
import { evmHeldHead, evmJsonRpc, evmPoolBuyQuote, evmPoolCoinUse, evmPoolIndexPools, evmPoolIndexUse, evmProviders, evmRanked, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest, type EvmPoolKey } from "../../checks/evm/quote.ts";
import { evmPoolCoinSync, evmPoolIndexSync, type EvmPoolCoinSync, type EvmPoolIndexConfig, type EvmPoolIndexData, type EvmPoolIndexSync } from "../../checks/evm/pool-index.ts";
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
  /** Whether the chain's v3 factory holds a WETH pool of the token at each of `fees`, in their order, or null where it
   *  is not known: the kit's evmPoolV3Tiers otherwise, unless the host brings its own `quote` (a test's model chain, a
   *  replay, an app's own providers), whose reads it then brings too: with none, every tier is asked as before. */
  readonly v3Tiers?: (chain: EvmPoolChain, token: string, fees: readonly number[]) => Promise<readonly boolean[] | null>;
};

/** UniswapV3Factory.getPool(address,address,uint24): the pool of two tokens at a fee, or the zero address. */
const SEL_GET_POOL = "1698ee82";
/** Multicall3 (github.com/mds1/multicall3), the same address on every chain (checks/evm/quote.ts MULTICALL3, its code
 *  read on the four Base and Robinhood providers), and its aggregate3((address,bool,bytes)[]). */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SEL_AGGREGATE3 = "82ad56cb";
const word = (x: string | number | bigint): string => BigInt(x).toString(16).padStart(64, "0");

/** Each getPool's answer in an aggregate3 result `hex` (no 0x), in order: the pool's address as a bigint, or null where
 *  the call failed or the answer is not one word; null for the whole where the result is not `n` such answers. */
function poolsOf(hex: string, n: number): (bigint | null)[] | null {
  const at = (byte: number): bigint | null => (hex.length >= (byte + 32) * 2 ? BigInt("0x" + hex.slice(byte * 2, (byte + 32) * 2)) : null);
  const head = at(0);
  if (head === null || head !== 32n || at(32) !== BigInt(n)) return null;
  const out: (bigint | null)[] = [];
  for (let i = 0; i < n; i++) {
    const off = at(64 + 32 * i);
    if (off === null || off > BigInt(hex.length)) return null;
    const e = 64 + Number(off);
    const ok = at(e);
    const dataOff = at(e + 32);
    if (ok === null || dataOff === null || dataOff > BigInt(hex.length)) return null;
    const len = at(e + Number(dataOff));
    out.push(ok === 1n && len === 32n ? at(e + Number(dataOff) + 32) : null);
  }
  return out;
}

/** Which of `fees` the chain's pinned v3 factory (the venue's v3Factory) holds a WETH/`token` pool at, in their order
 *  (card robinhood-tap-asks-no-missing-v3-tier): one eth_call, Multicall3's aggregate3 of a getPool a fee, to each of
 *  the chain's two first-ranked quote providers at their newest block (one call, not a batch: robinhood.drpc.org's free
 *  plan refuses a batch of more than 3 requests, code 31, read 2026-11-18 15:43Z). A tier has no pool only where both
 *  answer the zero address; one that names a pool, answers anything else or fails leaves the tier asked, as before, so
 *  no provider can hide a pool alone (and two that agree hide no market: the kit's own search, on every quote the tap
 *  asks, finds and names it). Null where the chain pins no v3 factory or no providers, or the token is not an address.
 *  Reads only. */
export async function evmPoolV3Tiers(chain: EvmPoolChain, token: string, fees: readonly number[], fetchFn: typeof fetch = fetch): Promise<readonly boolean[] | null> {
  const v = evmPoolVenues()[chain];
  const factory = v?.v3Factory;
  const p = v?.providers;
  if (v === undefined || factory === undefined || p === undefined || p.length < 2 || typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
  if (!Array.isArray(fees) || fees.length === 0 || fees.some((f) => !Number.isInteger(f) || f < 0 || f >= 1 << 24)) return null;
  // aggregate3's calls: each (target, allowFailure, callData) at its offset after the array's length; a getPool's call
  // data is 100 bytes, padded to 128, so each element is 256 bytes
  const getPool = (fee: number) => SEL_GET_POOL + word(v.weth) + word(token) + word(fee) + "0".repeat(56);
  const data = "0x" + SEL_AGGREGATE3 + word(32) + word(fees.length) + fees.map((_, i) => word(32 * fees.length + 256 * i)).join("") + fees.map((f) => word(factory) + word(1) + word(96) + word(100) + getPool(f)).join("");
  const call = [{ method: "eth_call", params: [{ to: MULTICALL3, data }, "latest"] }];
  const two = evmProviders(evmRanked(p), fetchFn).slice(0, 2);
  const answers = await Promise.all(
    two.map((rpc) =>
      rpc(call).then(
        (a) => {
          const r = (a[0] as { result?: unknown } | null)?.result;
          return typeof r === "string" && /^0x([0-9a-fA-F]{64})+$/.test(r) ? poolsOf(r.slice(2), fees.length) : null;
        },
        () => null,
      ),
    ),
  );
  return fees.map((_, i) => !answers.every((a) => a !== null && a[i] === 0n));
}

/** The route that last quoted per chain and token, this module's life: a tap asks it first (one quote a tap). */
const LAST_ROUTE = new Map<string, EvmRoute>();
/** Each chain and token's v3 tier read (evmPoolV3Tiers) and when it was asked (performance.now()), kept
 *  EVM_BUY_WARM_EVERY_MS: the coin page's warm reads it and the tap typed after it reads none, so the read adds no round
 *  to the tap the KPI times. A pool made inside that time is still found by the kit's own search (its reference). */
const TIERS = new Map<string, { readonly at: number; readonly tiers: Promise<readonly boolean[] | null> }>();
const TIERS_KEPT = 256;
/** Each route's refusal per chain, token, amount and slippage, for the one held block it was read at (card
 *  evm-warm-tap-ends-inside-two-seconds): a route refused at a block is refused again at that block (the same reads of
 *  the same block hash), so a quote of that route at that block (a tap at that held head, or a second try or a follow
 *  asked at that block) takes the refusal again with no kit quote, and one at any other block asks it as before. Held
 *  for the block the kit names in it (EvmQuoteError `at`, the block its reads were taken at), never for a head the tap
 *  ends on (card evm-warm-tap-ends-inside-two-seconds, round 5: the second try is asked at the first try's block, so a
 *  tap reads one block); a refusal that names none is held for the held head only where it was the same block before
 *  and after the quote, so the quote read at it; a provider's fault is never held. HOOKR on Robinhood (mainnet from the
 *  Mac, 2026-11-15 23:50Z): its indexed native pool's partial_fill, then the reference's native_first, about 1.8 s and
 *  0.5 s again each warm tap. */
const REFUSED = new Map<string, { readonly at: string; readonly routes: Map<string, unknown> }>();
const REFUSED_KEPT = 256;
/** Forgets every token's last route and held refusals (tests). */
export const evmBuyTapReset = (): void => (LAST_ROUTE.clear(), REFUSED.clear(), WARMS.clear(), TIERS.clear());
const FAULTS = new Set(["rpc_error", "rpc_disagree", "stale_quote"]);

/** A buy tap's quote, EVM_BUY_TAP_QUOTES kit quotes at most:
 *  - first, the route that last quoted for the token; else, with the chain's pool index served, the first of the token's
 *    own v4 pools in it that a buy may take (paired with the native asset or WETH, hookless or a launchpad hook the
 *    venue lists with its fee and tick spacing: sell-unpinned.ts evmHookListed, the sell builder's rule); with no index,
 *    the first standard hookless shape;
 *  - then the first standard v3 tier the v3 factory holds a pool at (one read of every tier, evmPoolV3Tiers; card
 *    robinhood-tap-asks-no-missing-v3-tier: a tier with no pool is never asked, so no read of its route reverts); where
 *    no other route is there to ask, the first standard tier still is, once, so the kit's whole search runs and names
 *    the token's market; asked at the block the first try's last refusal was read at, as a follow is, whether or not the head moved since;
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
  // the v3 tiers' pools, read once beside the first ask and awaited only where a v3 tier is next to ask
  const reader = h.v3Tiers ?? (h.quote === undefined ? evmPoolV3Tiers : undefined);
  const tiersNow = performance.now();
  let kept = TIERS.get(known);
  if (reader !== undefined && (kept === undefined || !(tiersNow - kept.at >= 0 && tiersNow - kept.at < EVM_BUY_WARM_EVERY_MS))) {
    kept = { at: tiersNow, tiers: Promise.resolve().then(() => reader(chain, t, V3_FIRST)).catch(() => null) };
    TIERS.delete(known);
    TIERS.set(known, kept);
    while (TIERS.size > TIERS_KEPT) TIERS.delete(TIERS.keys().next().value!);
  }
  const tiers = reader === undefined ? null : kept!.tiers;
  // the v3 tiers a tap may ask: those the read did not find empty (all of them where it is not known)
  const v3Held = async (): Promise<EvmRoute[]> => {
    const has = tiers === null ? null : await tiers;
    return Array.isArray(has) && has.length === v3.length ? v3.filter((_, i) => has[i] !== false) : v3;
  };
  const head = last ?? v4[0] ?? (await v3Held())[0] ?? v3[0]!;
  // the second try: the first v3 tier with a pool that is not the first try
  const second = async (): Promise<EvmRoute | null> => (await v3Held()).find((r) => JSON.stringify(r) !== JSON.stringify(head)) ?? null;
  const held = h.held ?? evmHeldHead;
  const refusedKey = `${known}:${amountIn}:${slippageBps}`;
  // `at`: a follow's, the block the refusal it follows was read at (EvmQuoteError `at`): the kit reads the reference
  // there, sending only the reads the refused quote did not agree on (card evm-cold-multihop-quote-inside-the-kpi)
  const ask = async (route: EvmRoute, at: string | null = null) => {
    const k = JSON.stringify(route);
    const pre = held(chain);
    // the block this quote reads at: the one it is asked at, else the held head (a quote with no `at` reads it while
    // fresh); a refusal is served only for the block it was read at
    const reads = at ?? pre;
    const kept = REFUSED.get(refusedKey);
    if (reads !== null && kept !== undefined && kept.at === reads && kept.routes.has(k)) throw kept.routes.get(k);
    try {
      const q = await quote({ chain, token, amountIn, slippageBps, route, ...(at === null ? {} : { at }) });
      LAST_ROUTE.set(known, q.route);
      return q;
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      // held for the block it was read at alone: the one the kit names (its `at`), else the held head where it was the
      // same block before and after the quote
      const named = (e as { at?: unknown })?.at;
      const readAt = typeof named === "string" ? named : pre !== null && held(chain) === pre ? pre : null;
      if (readAt !== null && typeof code === "string" && !FAULTS.has(code)) {
        const was = REFUSED.get(refusedKey);
        const routes = was !== undefined && was.at === readAt ? was.routes : new Map<string, unknown>();
        routes.set(k, e);
        REFUSED.delete(refusedKey);
        REFUSED.set(refusedKey, { at: readAt, routes });
        if (REFUSED.size > REFUSED_KEPT) REFUSED.delete(REFUSED.keys().next().value!);
      }
      throw e;
    }
  };
  const takes = (r: EvmRoute) =>
    r.venue === "uniswap-v3" || ((r.currencyIn === ZERO || lower(r.currencyIn) === weth) && r.hops.every((p) => p.hooks === ZERO || evmHookListed(chain, p.hooks, p.fee, p.tickSpacing)));
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
  // the block the last refusal was read at (the kit's `at`), which its reference and the second try are asked at
  let at: string | null = null;
  for (let k = 0; k < 2; k++) {
    const first = k === 0 ? head : left > 0 ? await second() : null;
    if (first === null) break;
    let route: EvmRoute | null = first;
    // the second try is asked at the first's last refusal's block, as a follow is (card
    // evm-warm-tap-ends-inside-two-seconds): another route at the same block, so the kit reads only what the refused
    // quote did not agree on there, under the follow's own rules (a block the head watch confirmed, at most
    // EVM_FOLLOW_MAX_AGE_MS old, else a block agreed now; one the chain dropped is asked again at a new head). At no
    // block it ran the kit's whole search again at a new one: ANTc on Base, 3.5 s of a 6.9 s warm tap (mainnet from the
    // Mac, 2026-11-20 08:4xZ), every round of its first quote once more. Pinned whether or not the held head moved
    // since (round 5): one tap reads one block, and each refusal is held for the block it was read at (REFUSED), so a
    // tap at a later head asks again
    let followed = false;
    while (route !== null && left > 0 && !asked.has(JSON.stringify(route))) {
      left--;
      asked.add(JSON.stringify(route));
      try {
        return await ask(route, followed || k > 0 ? at : null);
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
        at = typeof (e as { at?: unknown })?.at === "string" ? ((e as { at: string }).at) : null;
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

/** The amount a coin page's warm quotes at, wei: 0.001 ETH, a small tap's. The tap's own amount is read in the tap. */
export const EVM_BUY_WARM_IN = 10n ** 15n;
/** The least time between two warms of one coin, ms: within it the kit still holds the first warm's reads (the token's
 *  plan, EVM_WARM_RANGE_S of block time), so a second warm would only load the providers. */
export const EVM_BUY_WARM_EVERY_MS = 30_000;
const WARMS = new Map<string, { at: number; run: Promise<void> }>();
const WARMS_KEPT = 64;

/** A coin page's warm (card evm-quote-warm-from-the-coin-page): one buy tap quote of the coin at EVM_BUY_WARM_IN, its
 *  answer and any refusal dropped, so the reads that do not depend on the amount (the agreed head, the coin's pools
 *  from the index and its scans, X's markets and every pool's state) are held by the kit when the amount is typed: the
 *  tap's own quote asks them in its first round with its amount-dependent reads (the token's plan, made again at the
 *  tap's amount), and takes one round where nothing changed. Every read is the tap's own, on the same providers, under
 *  every check; nothing here is signed, kept for a buy or shown. One warm a coin at a time, and none within
 *  EVM_BUY_WARM_EVERY_MS of the last (`now`: a clock that never steps back), so a page that asks again while it sits
 *  idle reads nothing more. Resolves once the warm ends, whatever it ends in. */
export function evmPoolBuyWarm(req: { readonly chain: EvmPoolChain; readonly token: string }, h: EvmBuyTapHost = {}, now: () => number = () => performance.now()): Promise<void> {
  const chain = req?.chain;
  const token = req?.token;
  if (typeof chain !== "string" || typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) return Promise.resolve();
  const k = `${chain}:${lower(token)}`;
  const t = now();
  const last = WARMS.get(k);
  if (last !== undefined && t - last.at >= 0 && t - last.at < EVM_BUY_WARM_EVERY_MS) return last.run;
  const run = evmPoolBuyQuoteTap({ chain, token, amountIn: EVM_BUY_WARM_IN, slippageBps: 100 }, h).then(
    () => {},
    () => {},
  );
  WARMS.delete(k);
  WARMS.set(k, { at: t, run });
  while (WARMS.size > WARMS_KEPT) WARMS.delete(WARMS.keys().next().value!);
  return run;
}

/** The wait between a whole sync's end and the next gap sync of a served index, ms (card evm-index-kept-at-the-head): a
 *  quote reads the blocks past the index's N unread before its answer only while they start within the chain's maxLag of
 *  the scan provider's head (checks/evm/quote.ts scanPools), 50 Base blocks and 100 Robinhood ones, about 10 s each; an
 *  index synced once a sign-in fell past it within seconds, and every new coin's first quote then sent 5 getLogs by
 *  currency over the same blocks before its answer (Robinhood 2, 10 and 5, Base 6, 19 Nov). A gap sync from the kept
 *  index reads its margin and the new blocks: one span, a head post and one batch on each reader (Base 0.5-1.7 s,
 *  Robinhood 2.2 s), so 3 s keeps N within about 7 s of the head. */
export const EVM_INDEX_KEEP_MS = 3_000;

/** One sync of the chain's pool index from `prev` (none: cold) on the venue's two index readers through `fetchFn`, and a
 *  whole one served to the kit's quote (evmPoolIndexUse). `served` is false where the sync ended partial or the chain
 *  has no index. Its reads are a background read's (pace.ts `later`): a tap's posts go before them. */
export async function evmPoolIndexRefresh(chain: EvmPoolChain, prev: EvmPoolIndexData | null, fetchFn: typeof fetch = fetch): Promise<{ readonly sync: EvmPoolIndexSync | null; readonly served: boolean }> {
  const v = evmPoolVenues()[chain];
  const ix = v?.index;
  if (v === undefined || ix === undefined || v.poolManager === undefined || v.scan === undefined) return { sync: null, served: false };
  const sync = await evmPoolIndexSync(prev, { chainId: v.chainId, poolManager: v.poolManager, readers: [evmJsonRpc(ix.readers[0], fetchFn, 64 << 20, undefined, true), evmJsonRpc(ix.readers[1], fetchFn, 64 << 20, undefined, true)], depth: v.scan.depth, span: ix.span, margin: ix.margin, cap: ix.cap, perBatch: ix.perBatch, parallel: ix.parallel, ...(ix.parts !== undefined ? { parts: ix.parts } : {}), ...(ix.batchMax !== undefined ? { batchMax: ix.batchMax } : {}) });
  return { sync, served: sync.index !== null && sync.coversThrough !== null && evmPoolIndexUse(chain, sync) };
}

/** A coin's read's own shape on each chain's index readers (card evm-first-quote-reads-its-coin-at-any-age), where it is
 *  not the whole sync's: Base asks base.rpc.blxrbdn.com one piece a span (a coin's filters are cheap where every pool's
 *  are not: the whole sync's five 10,000-block pieces a span made 181 posts of a 48 h coin read against 37, 21 Nov
 *  15:13Z); rpc.mainnet.chain.robinhood.com answers a filter with more than one value a position over at most 100,000
 *  blocks (-32602, 15:27Z), the venue's scan `orSpan`. */
export const EVM_COIN_READ: Readonly<Partial<Record<EvmPoolChain, Partial<Pick<EvmPoolIndexConfig, "parts" | "orSpan">>>>> = Object.freeze({
  base: Object.freeze({ parts: Object.freeze([1, 1] as const) }),
  robinhood: Object.freeze({ orSpan: Object.freeze([100_000, undefined] as const) }),
});

/** One coin's read (pool-index.ts evmPoolCoinSync) from `prev` on the venue's two index readers through `fetchFn`, and a
 *  whole one served to the kit's quote (evmPoolCoinUse). Its reads are a tap's, not a background read's: a quote waits on
 *  them, so the whole sync (evmPoolIndexRefresh, pace.ts `later`) goes after them. */
export async function evmPoolCoinRefresh(chain: EvmPoolChain, prev: EvmPoolIndexData | null, token: string, fetchFn: typeof fetch = fetch): Promise<{ readonly read: EvmPoolCoinSync | null; readonly served: boolean }> {
  const v = evmPoolVenues()[chain];
  const ix = v?.index;
  if (v === undefined || ix === undefined || v.poolManager === undefined || v.scan === undefined) return { read: null, served: false };
  const shape = EVM_COIN_READ[chain] ?? {};
  const read = await evmPoolCoinSync(prev, { token, weth: v.weth }, { chainId: v.chainId, poolManager: v.poolManager, readers: [evmJsonRpc(ix.readers[0], fetchFn, 64 << 20), evmJsonRpc(ix.readers[1], fetchFn, 64 << 20)], depth: v.scan.depth, span: ix.span, margin: ix.margin, cap: ix.cap, perBatch: ix.perBatch, parallel: ix.parallel, ...(ix.parts !== undefined ? { parts: ix.parts } : {}), ...(ix.batchMax !== undefined ? { batchMax: ix.batchMax } : {}), ...shape });
  return { read, served: read.coversThrough !== null && evmPoolCoinUse(chain, read) };
}
