// The signing page's one RPC client (card signpage-rpc-throttle-retry): the kit's solanaJsonRpc with the page's bound
// (SOLANA_RPC_RETRY), for every chain's pool reads and sends, testnet and mainnet alike, each on its host's lane (card
// signpage-passes-yield-to-a-trade, ../../wallet/src/throttle.ts HostLane): one budget per provider host for the whole
// page, whatever reader or object asks.
// - A read waits its turn on the host first: a trade's read ("trade", a buy's or sell's own) only the host's pause, and
//   that at most TRADE_TURN_MAX_MS; a background read ("pass": the proof pass, the positions pass, the state reads'
//   settles that hold no trade's lock) also the host's budget (PASS_BUDGET in HOST_WINDOW_MS, less while a trade holds
//   the host, at least one every PASS_FLOOR_MS). Its bound (the retry's deadlineMs) starts once its turn comes.
// - A throttle (HTTP 429, a 5xx, -32029 or -32429 in a 200) pauses the host for every reader by the one rule (from 1 s,
//   doubling to 10 s, a Retry-After when longer; api.devnet.solana.com exposes none to a page), and the read that met it
//   is asked again once, after that pause; an answer that is not JSON, a stall or a dropped connection is asked again
//   once after the retry's backoff. A sign out's tap ends every wait on every host at once (stopHostLaneWaits), and once
//   its store holds the seed lock the page's gate closes (closeHostLanes): no call is asked or asked again after it, and
//   the page reloads. Never a third ask, and never a wait that would end past the call's bound: the call
//   then rejects naming its fault (SolanaRpcTransportError). So a trade's read waits for its turn at most
//   TRADE_TURN_MAX_MS + PROBE_HELD_MAX_MS (15 s) from the turn's start, the host's pause (at most 10 s) and the probes
//   after it (each read parked ahead may be one) together, then its bound (3.5 s; 12 s for a settle's
//   SOLANA_RPC_WINDOW_RETRY), whatever the host answers; a seat (seatRpc) adds its next member's own once a member
//   faults.
import { readSolanaReference, type SolanaReference, type SolanaReferenceRequest } from "../../kit/src/trade/solana/pool.ts";
import { base58 } from "@scure/base";
import { readSolanaDlmmPairs, SOLANA_DLMM_MAX_PAIRS, SOLANA_DLMM_SCAN_MAX } from "../../kit/src/trade/solana/dlmm.ts";
import { readSolanaCpmmPools } from "../../kit/src/trade/solana/cpmm.ts";
import { readSolanaClmmPools } from "../../kit/src/trade/solana/clmm.ts";
import { readSolanaAmmV4Pools } from "../../kit/src/trade/solana/amm-v4.ts";
import { SOLANA_POOL_BUY_VENUES } from "../../kit/src/trade/solana/pool-buy.ts";
import { HELPER_FETCH_INIT } from "../../kit/src/helper/v1.ts";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaHelperRpc, solanaJsonRpc, solanaSameProvider, solanaWrappedRpc, type SolanaFetch, type SolanaRpc, type SolanaRpcRetry } from "../../kit/src/trade/solana/send.ts";
import { HostPaused, gateSignal, hostLane } from "../../wallet/src/throttle.ts";
import { evmPaceTake, evmProviderHold } from "../../kit/src/checks/evm/pace.ts";

/** Whose read it is: a trade's own (first on its host) or a background pass's (on its host's budget). */
export type ReadKind = "trade" | "pass";
/** A fault that counts on the host's pause: the provider's throttle or its 5xx. */
const throttles = (e: SolanaRpcTransportError): boolean => e.fault === "http_429" || e.fault === "rpc_throttled" || e.fault === "http_5xx";
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((ok, stop) => {
    if (signal?.aborted) return stop(signal.reason);
    const off = (): void => (clearTimeout(t), stop(signal!.reason));
    const t = setTimeout(() => (signal?.removeEventListener("abort", off), ok()), ms);
    signal?.addEventListener("abort", off, { once: true });
  });

/** `url` as a page RPC on its host's lane (the header): `kind` its turn, `retry` its bound, `init` and `fetch` the kit
 *  client's own, `signal` ends a wait for the turn or the pause at once. */
export function lanedRpc(url: string, o: { kind?: ReadKind; retry?: SolanaRpcRetry; init?: RequestInit; fetch?: SolanaFetch; signal?: AbortSignal; spare?: boolean } = {}): SolanaRpc {
  const kind = o.kind ?? "trade";
  const retry = o.retry ?? SOLANA_RPC_RETRY;
  const href = solanaJsonRpc(url).url!;
  const lane = hostLane(href);
  // one attempt within `ms`, its fault named (a retry whose first wait is past its own bound tries once); `stop` in its
  // fetch, so a read the page gave up on (its caller's cut, a sign out) ends at the provider too, never holding the
  // host's slot or its pace token (card signpage-reads-take-the-call-signal)
  const once = (ms: number, method: string, params: readonly unknown[], stop: AbortSignal): Promise<unknown> =>
    solanaJsonRpc(url, { ...(o.init ? { init: o.init } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), retry: { deadlineMs: ms, backoffMs: ms } })(method, params, stop);
  // every outcome reported to the lane: the gate's pause, and the probe's settle when this read was it
  // `stop`: the caller's signal and the page's gate (gateSignal), so an ask after the gate closed during the call is never
  // sent (card sign-out-stops-the-pages-reads); its waits for a turn also end at a sign out's tap (HostLane.turn)
  // and its turn at the provider's pace, the one every EVM read of the device takes (kit pace.ts: the kit's quotes,
  // scans and index readers too), a pass's as a background read's; an unpaced host's is no wait
  const ask = async (end: number, stop: AbortSignal, method: string, params: readonly unknown[]): Promise<unknown> => {
    stop.throwIfAborted();
    const turn = evmPaceTake(href, [{ method }], stop, kind === "pass");
    const give = typeof turn === "function" ? turn : await turn;
    const sentIn = lane.gate.epoch();
    // whether the provider answered (kit pace.ts: a read that ended with no answer, no connection, its time or the gate's
    // abort, gives its units back as sent)
    let answered = true;
    try {
      const r = await once(Math.max(1, Math.floor(end - performance.now())), method, params, stop);
      lane.answered(sentIn);
      return r;
    } catch (e) {
      if (e instanceof SolanaRpcTransportError && throttles(e)) lane.throttled(sentIn, e.afterMs);
      else lane.failed(sentIn);
      // no connection: in a browser any failure with no response, Robinhood's own 429 among them (its allow-origin "*,*",
      // which CORS refuses): the provider held for every EVM reader, as the kit's own transport holds it (quote.ts
      // evmJsonRpc; card robinhood-reads-draw-no-revert), so the kit's quotes ask it after the others meanwhile
      if (e instanceof SolanaRpcTransportError && e.fault === "network" && !stop.aborted) evmProviderHold(href);
      if (stop.aborted || (e instanceof SolanaRpcTransportError && (e.fault === "network" || e.fault === "timeout"))) answered = false;
      throw e;
    } finally {
      give(answered);
    }
  };
  // asked again once: after the host's pause (a throttle) or the retry's backoff (any other fault), a background read
  // on the host's budget too, never past the call's bound
  const again = async (end: number, stop: AbortSignal, e: unknown, method: string, params: readonly unknown[]): Promise<unknown> => {
    if (!(e instanceof SolanaRpcTransportError)) throw e;
    // a sign out during the call: no ask again (its answer, whatever it was, is the call's end)
    if (stop.aborted) throw e;
    if (!throttles(e)) {
      if (performance.now() + retry.backoffMs >= end) throw e;
      await sleep(retry.backoffMs, stop);
    }
    // its turn again, whichever kind, held to the read's bound: the turn waits the host's pause (another reader's 429
    // may move it on meanwhile: a paid devnet run of 11 Nov, a deposit's re-ask sent into it drew a 429 and doubled it)
    // and the probe after it; a wait that would pass `end` is refused at once, nothing counted, and the read ends on
    // its 429 (the review of 321509e2: a 3.5 s read slept a pause moved to 9 s, then threw at 9.4 s, its turn counted)
    try {
      await lane.turn(kind, stop, true, { reports: true, by: end });
    } catch (x) {
      if (x instanceof HostPaused) throw e;
      throw x;
    }
    return ask(end, stop, method, params);
  };
  // its bound from its turn on
  const go = (stop: AbortSignal, method: string, params: readonly unknown[]): Promise<unknown> => {
    const end = performance.now() + retry.deadlineMs;
    // a seat's member with a spare after it (seatRpc) is not asked again after any provider fault (a throttle, a 5xx, no
    // connection, a stall to its bound, an answer that is no JSON): the read goes to the spare
    return ask(end, stop, method, params).catch((e: unknown) => (o.spare === true && e instanceof SolanaRpcTransportError ? Promise.reject(e) : again(end, stop, e, method, params)));
  };
  // a read whose turn is open now goes out in this tick (a paced queue's slot calls it as its own)
  // (a trade's turn refused past its TRADE_TURN_MAX_MS is the host's throttle, never sent: HostPaused)
  const rpc = (method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> => {
    // the reader's signal, this call's own (SolanaRpc's: a walk's cut, a read's bound) and the page's gate: every ask of
    // this call, and its request in flight, ends at any of them
    const stop = gateSignal(signal === undefined ? o.signal : o.signal === undefined ? signal : AbortSignal.any([o.signal, signal]));
    // the gate closed (a sign out; throttle.ts): a call made after it, a paced slot's or a seat's failover included, is
    // refused here, never sent or counted
    if (stop.aborted) return Promise.reject(stop.reason);
    if (!lane.open(kind))
      return lane.turn(kind, stop, true, { reports: true }).then(
        () => go(stop, method, params),
        (x: unknown) => Promise.reject(x instanceof HostPaused ? new SolanaRpcTransportError("http_429", "the host stayed paused past the read's turn", 0, lane.host) : x),
      );
    lane.took(kind);
    return go(stop, method, params);
  };
  return Object.assign(rpc, { url: href });
}

/** The hosts each seat reads (seatRpc), by the seat's url: a trade holds every one of them (src/pool-testnet.ts). */
const SEATS = new Map<string, readonly string[]>();
/** The hosts `r` reads: a seat's every member, any other RPC its own url. */
export const seatHosts = (r: { readonly url?: string } | undefined): readonly string[] => (r?.url === undefined ? [] : (SEATS.get(r.url) ?? [r.url]));

/**
 * The page's public seat as a list of providers the device reaches directly (card signpage-throttled-provider-has-a-spare):
 * one provider to the pair it sits in (its url is the first member's, so solanaSameProvider tells it from the helper's
 * route and a check still needs the same bytes from the helper and one public provider). Each read goes to one member at
 * a time, never two at once, so a read names its wallet to one public provider at a time:
 * - the first member whose host is open now (its turn needs no wait), in the list's order, called in this tick (a paced
 *   queue's slot calls it as its own);
 * - a member that answers a throttle (429, a 5xx, -32029, -32429) is paused by its host's lane and not asked again by this
 *   read: the read goes to the next open member at once; so does one with no connection, one that stalls to the read's
 *   bound, or one whose answer is no JSON (a browser reports a 429 with no CORS header as no connection) (the review of
 *   507431c0, item 4), not paused, the host left in doubt;
 * - with no member open, the one whose host opens first, asked as any page RPC (its turn, one re-ask after its pause).
 * An answer, any answer, is the read's: a member that answers differently from the helper fails the check, and the seat
 * never asks another member for a better one. The helper is never a member.
 */
export function seatRpc(urls: readonly string[], kind: ReadKind = "trade", retry: SolanaRpcRetry = SOLANA_RPC_RETRY): SolanaRpc {
  if (urls.length === 0) throw new Error("a seat needs a provider");
  const members = urls.map((u) => ({ lane: hostLane(u), fast: lanedRpc(u, { kind, retry, spare: true }), last: lanedRpc(u, { kind, retry }) }));
  const href = members[0]!.last.url!;
  SEATS.set(href, members.map((m) => m.last.url!));
  // the call's signal goes to whichever member is asked (an abort is never a member's fault: no failover after it)
  const read = (method: string, params: readonly unknown[], tried: ReadonlySet<number>, signal?: AbortSignal): Promise<unknown> => {
    const left = members.map((_, i) => i).filter((i) => !tried.has(i));
    const open = left.filter((i) => members[i]!.lane.open(kind));
    if (open.length === 0) {
      // none open: the one whose host opens first, as any page RPC
      const next = left.reduce((a, b) => (members[b]!.lane.wait(kind) < members[a]!.lane.wait(kind) ? b : a));
      return members[next]!.last(method, params, signal);
    }
    const i = open[0]!;
    // the last member left is asked as any page RPC; one with members after it fails over on a throttle
    if (left.length === 1) return members[i]!.last(method, params, signal);
    return members[i]!.fast(method, params, signal).catch((e: unknown) => {
      if (!(e instanceof SolanaRpcTransportError) || signal?.aborted) throw e;
      return read(method, params, new Set([...tried, i]), signal);
    });
  };
  return Object.assign((method: string, params: readonly unknown[], signal?: AbortSignal) => read(method, params, new Set(), signal), { url: href });
}

/** A provider the device reaches directly. */
export const pageRpc = (url: string, kind: ReadKind = "trade", spare = false): SolanaRpc => lanedRpc(url, spare ? { kind, spare } : { kind });
/** The helper's POST /v1/rpc/solana, `origin` the helper's origin only; the page's retry unless a read names its own
 *  (a pool settle's and restore's, SOLANA_RPC_WINDOW_RETRY: src/pool-testnet.ts pageSolanaSettleRpcs). */
export const pageHelperRpc = (origin: string, retry: SolanaRpcRetry = SOLANA_RPC_RETRY, kind: ReadKind = "trade"): SolanaRpc => lanedRpc(solanaHelperRpc(origin).url!, { kind, retry, init: HELPER_FETCH_INIT });
/** pageHelperRpc with `signal` in its every fetch: a call the stop came before (one that waited its turn in a queue, or
 *  a try again after a throttle) is never sent, and one in flight is aborted. */
export const pageHelperRpcStopped = (origin: string, signal: AbortSignal, kind: ReadKind = "trade"): SolanaRpc =>
  lanedRpc(solanaHelperRpc(origin).url!, {
    kind,
    signal,
    init: HELPER_FETCH_INIT,
    fetch: (url, init) => {
      signal.throwIfAborted();
      return globalThis.fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    },
  });

/**
 * The kit's readSolanaReference on the page's two providers, where a provider whose read still failed after the page's
 * own retry is that fault, thrown, never "no reference" (card pool-read-down): the kit answers a failed read and a pool
 * that is not there alike, as null, and the pool kinds answer null quote_check_failed. Both providers' reads are still
 * the reference's, and only a null with a failed read is the fault's; the kit's one-provider refusal is held here first,
 * since the watch wraps each provider. A read the kit gave up on while it was still in flight (its 5 s cut,
 * READ_TIMEOUT_MS in kit pool.ts, met while the page's lane held it for a paused host: the review of 507431c0, P2) is a
 * failed read too: a null resting on it is that provider's no answer, a timeout fault, never "no reference pool".
 */
export async function pageReference(rpcs: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest, finders: PoolFinders | null = pageFinders, o: { early?: boolean } = {}): Promise<SolanaReference | null> {
  if (solanaSameProvider(rpcs[0], rpcs[1])) throw new Error("the two providers are the same provider: a reference must never rest on one provider's word");
  // the coin's DLMM pairs and Raydium CPMM and AMM v4 pools (card solana-buy-reaches-raydium-and-meteora), found beside
  // the pump venues' read: a coin with none costs no wait; one with some is read again with them, every venue judged on
  // the same reads' rules. A request that names a kind's pools is read with those, that kind's finder never asked.
  // `early` (a preview, card solana-quote-reads-found-pools-once): each kind's pools as soon as one provider's scan names
  // them (PoolsOf.early), never waiting for the slower provider's half; a tap's own read waits for both (the finder)
  // a buy's markets (MARKET_FINDER_KINDS) are found the same way; a sell reads none, so no market can hold a sell back.
  // A market scan that faulted leaves a tap's buy refused with that fault, never priced as if the coin had no market
  const kinds = [...FINDER_KINDS, ...(req.side === "buy" ? MARKET_FINDER_KINDS : [])].filter((k) => req[k] === undefined && finders?.[k]);
  if (kinds.length > 0) {
    // a scan a provider failed past the page's own retry is that fault, never "no pools" (card
    // pool-buy-waits-out-a-throttle): a reference that then names no pool throws it, as a read's own fault, so a buy of
    // a coin whose pools are all on a scanned venue waits it out instead of answering quote_check_failed
    let scanFault: SolanaRpcTransportError | null = null;
    let marketFault: unknown = null;
    // a market finder's fault is kept apart (beside a transport fault's own keeping below, unchanged)
    const ask = (k: PoolFinderKind | MarketFinderKind): Promise<readonly string[]> => {
      const pools = ((o.early ? finders![k]!.early : undefined) ?? finders![k]!)(req.token);
      return (MARKET_FINDER_KINDS as readonly string[]).includes(k) ? pools.catch((e: unknown) => Promise.reject((marketFault ??= e))) : pools;
    };
    const found = Promise.all(kinds.map((k) => ask(k).catch((e: unknown) => (e instanceof SolanaRpcTransportError && (scanFault ??= e), [] as readonly string[]))));
    const pump = readReference(rpcs, req);
    const unfound = async (read: Promise<SolanaReference | null>): Promise<SolanaReference | null> => {
      const ref = await read;
      if (ref === null && scanFault !== null) throw scanFault;
      return ref;
    };
    // a tap's buy whose market scan faulted is refused with that fault; a preview reads on without the markets
    const marketsRead = async (read: Promise<SolanaReference | null>): Promise<SolanaReference | null> => {
      const ref = await unfound(read);
      if (ref !== null && marketFault !== null && !o.early) throw marketFault;
      return ref;
    };
    const lists = await found;
    if (lists.every((l) => l.length === 0)) return marketsRead(pump);
    pump.catch(() => {});
    const more: { -readonly [K in PoolFinderKind | MarketFinderKind]?: string[] } = {};
    kinds.forEach((k, i) => void (lists[i]!.length > 0 && (more[k] = [...lists[i]!])));
    return marketsRead(readReference(rpcs, { ...req, ...more }));
  }
  return readReference(rpcs, req);
}

/** The best of a reference's priced pools among the venues the kit builds (each of SOLANA_POOL_BUY_VENUES): the most out. */
export const bestVenuePool = (ref: SolanaReference | null | undefined): SolanaReference["pools"][number] | undefined =>
  ref?.pools.filter((p) => SOLANA_POOL_BUY_VENUES.includes(p.venue)).sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];

/** The venues a page's tables pin a buy on: each the kit builds with a non-empty list of table addresses. */
export const pinnedBuyVenues = (tables: Readonly<Partial<Record<string, readonly string[] | undefined>>>): ReadonlySet<SolanaReference["pools"][number]["venue"]> =>
  new Set(SOLANA_POOL_BUY_VENUES.filter((v) => Object.hasOwn(tables, v) && Array.isArray(tables[v]) && tables[v]!.length > 0));

/** A Solana buy's venue, or why there is none (solanaBuyVenue). */
export type SolanaBuyVenue = { readonly pool: SolanaReference["pools"][number] } | { readonly error: "quote_check_failed" | "venue_not_pinned" | "below_reference" };

/**
 * The one venue decision of a Solana buy (card sol-buy-takes-the-best-venue-it-can-trade), which the tap (src/pool-buy.ts)
 * and pool.buy.dry (src/pools.ts) both take on the same reference: among the reference's pools on a venue the kit builds
 * and the page pins a table for (`pinned`, pinnedBuyVenues), the one that gives the most. Its expected out is held to
 * the market M, the kit's E: the best pool of the reference's set on any venue, pinned or not: the EVM rule of card
 * evm-buy-never-below-a-hidden-market (kit checks/evm/quote.ts `near` and `underHooked`), where a market the device
 * can read but not trade through still sets the price a buy must meet, and a buy within the ask's slippage of it is
 * taken at its own min out. So a coin whose larger pool sits on a venue the page cannot trade (a DLMM pair or a Raydium
 * pool beside its pump venue) fills on its pinned venue, and a thin pinned pool seeded beside the coin's real market
 * is refused. Refusals, in this order: quote_check_failed (no reference, no pool on a venue the kit builds, or a
 * slippage outside 0 to 9,999 bps, as the kit's QUOTE check refuses it), venue_not_pinned (no such pool on a pinned
 * venue), below_reference (the best pinned pool's out under M less the slippage: x * 10000 < M * (10000 - bps)).
 */
export function solanaBuyVenue(ref: SolanaReference | null | undefined, pinned: ReadonlySet<string>, slippageBps: number): SolanaBuyVenue {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) return { error: "quote_check_failed" };
  // the set's pools and those under its depth cutoff (the kit's `shallow`): a pinned venue's pool may be either
  const built = [...(ref?.pools ?? []), ...(ref?.shallow ?? [])].filter((p) => SOLANA_POOL_BUY_VENUES.includes(p.venue));
  if (built.length === 0) return { error: "quote_check_failed" };
  const most = (xs: readonly SolanaReference["pools"][number][]) => xs.reduce<SolanaReference["pools"][number] | null>((m, p) => (m === null || p.expectedOut > m.expectedOut ? p : m), null);
  const pool = most(built.filter((p) => pinned.has(p.venue)));
  if (pool === null) return { error: "venue_not_pinned" };
  // M: the kit's E, the best pool of the set over every venue read (a pool under the depth cutoff never raises it)
  const market = ref!.expectedOut;
  if (pool.expectedOut * 10_000n < market * BigInt(10_000 - slippageBps)) return { error: "below_reference" };
  return { pool };
}

/** Finds a coin's SOL pools of one venue for a reference (the kit's readSolanaDlmmPairs, readSolanaCpmmPools or
 *  readSolanaAmmV4Pools on the page's providers): both providers' scans, their union (a tap's reference waits for it).
 *  `early` (card solana-quote-reads-found-pools-once), for a preview: the same scan's list as soon as one provider's
 *  half of it is whole (keptPools), so a dry never waits for the slower provider (the page's public scan seat answers
 *  one call each 1.25 s, and a coin's scans are six calls on it: 6.6 s, measured 16 Nov). */
export type PoolsOf = ((token: string) => Promise<readonly string[]>) & { readonly early?: (token: string) => Promise<readonly string[]> };
/** The reference request's field each finder fills, and the venue whose pools it names. */
export const POOL_FINDER_VENUES = Object.freeze({ dlmmPairs: "dlmm", cpmmPools: "raydium-cpmm", ammV4Pools: "raydium-amm-v4" } as const);
export type PoolFinderKind = keyof typeof POOL_FINDER_VENUES;
const FINDER_KINDS = Object.keys(POOL_FINDER_VENUES) as PoolFinderKind[];
/** The markets a buy's reference reads but no buy ever takes (card solana-buy-never-below-a-hidden-market): a coin's
 *  Raydium CLMM pools in wSOL and USDC (kit clmm.ts readSolanaClmmPools), the request's `clmmPools`. Never a venue of
 *  POOL_FINDER_VENUES, so readCoinVenue and the tap's tables never see one; read for a buy only, where they can only
 *  raise the price the buy must meet (kit pool.ts solanaReferenceSet). */
export const MARKET_FINDER_KINDS = Object.freeze(["clmmPools"] as const);
export type MarketFinderKind = (typeof MARKET_FINDER_KINDS)[number];
/** The page's finders, one per scanned venue and market kind; a kind with none is read without its pools. */
export type PoolFinders = { readonly [K in PoolFinderKind | MarketFinderKind]?: PoolsOf | null };
/** The page's finders, set once at start on mainnet (main.ts); none: a reference reads the pump venues alone. */
let pageFinders: PoolFinders | null = null;
export const setPagePoolFinders = (f: PoolFinders | null): void => void (pageFinders = f);
/** How many coins' pools a finder keeps, and how long: a pool made since is found on the next read a minute on. */
export const POOLS_KEPT = 256;
export const POOLS_KEEP_MS = 60_000;
/** How long a market finder (MARKET_FINDER_KINDS) keeps a coin's markets: a CLMM pool for a mint is made rarely, and
 *  each tap reads each listed pool's state fresh (kit clmm.ts readSolanaClmmMarket), so the list alone is kept, as the
 *  helper keeps its half for every device (apps/helper rpc.ts MARKET_SCAN_HOLD_MS). [design: 10 min, the CO's floor] */
export const MARKETS_KEEP_MS = 10 * 60_000;
type ScanRead = (scan: readonly [SolanaRpc, SolanaRpc], read: readonly [SolanaRpc, SolanaRpc], mint: string) => Promise<string[]>;
const FIND: Readonly<Record<PoolFinderKind | MarketFinderKind, ScanRead>> = Object.freeze({ dlmmPairs: readSolanaDlmmPairs, cpmmPools: readSolanaCpmmPools, ammV4Pools: readSolanaAmmV4Pools, clmmPools: readSolanaClmmPools });
/** How many scans each provider answers for one coin: the coin first and second beside wSOL; for the CLMM markets one
 *  beside wSOL and one beside USDC, each in the program's own mint order (kit clmm.ts readSolanaClmmPools). */
const SCANS: Readonly<Record<PoolFinderKind | MarketFinderKind, number>> = Object.freeze({ dlmmPairs: 2, cpmmPools: 2, ammV4Pools: 2, clmmPools: 2 });
/**
 * A finder of one venue that keeps each coin's pools POOLS_KEEP_MS: the kit's reader, scanning on `scan` (two providers
 * that answer getProgramAccounts) and ranking past its cap on `read`. A read that fails is kept for nothing, so the next
 * reference asks again; one read at a time per coin.
 */
export function keptPools(kind: PoolFinderKind | MarketFinderKind, scan: () => readonly [SolanaRpc, SolanaRpc], read: () => readonly [SolanaRpc, SolanaRpc], now: () => number = () => performance.now()): PoolsOf {
  type Kept = { at: number; pools: Promise<readonly string[]>; early: Promise<readonly string[]> };
  const kept = new Map<string, Kept>();
  const find = FIND[kind];
  const keep = (MARKET_FINDER_KINDS as readonly string[]).includes(kind) ? MARKETS_KEEP_MS : POOLS_KEEP_MS;
  const of = (token: string): Kept => {
    const k = kept.get(token);
    if (k !== undefined && now() - k.at < keep) return k;
    if (kept.size >= POOLS_KEPT) kept.clear();
    // the same scan, each provider's answers seen as they come: the first provider whose two scans (the coin first and
    // second) both answered a list names the early list, as the kit makes the list from both (its union, and past
    // SOLANA_DLMM_MAX_PAIRS each read provider's deepest half): the kit's own finder over that provider's two answers
    // replayed, so its ranking reads the pools' depths on `read` as the union's does; no scan is ever sent twice
    let half: (pools: readonly string[]) => void = () => {};
    const halfIn = new Promise<readonly string[]>((ok) => (half = ok));
    const answers = [new Map<string, unknown>(), new Map<string, unknown>()];
    const halfOf = (i: number) => {
      const all = [...new Set([...answers[i]!.values()].flatMap((a) => scannedList(a) ?? []))].sort();
      if (all.length <= SOLANA_DLMM_MAX_PAIRS) return half(all);
      const replay = (n: number): SolanaRpc =>
        Object.assign(
          async (method: string, params: readonly unknown[]) => {
            const a = method === "getProgramAccounts" ? answers[i]!.get(JSON.stringify(params)) : undefined;
            if (a === undefined) throw new Error("not a scan this provider answered");
            return a;
          },
          { url: `https://replay.invalid/${i}/${n}` },
        );
      find([replay(0), replay(1)], read(), token).then(half, () => {});
    };
    // a scan or ranking call the kit gave up on at its own bound (SCAN_TIMEOUT_MS, a plain error) while the page's lane
    // still holds it is that provider's no answer, a timeout fault, never "no pools" (pageReference throws it); a
    // provider's own fault is thrown as the kit threw it (card pool-buy-waits-out-a-throttle)
    const w = readWatch("the scan");
    const pair = scan().map((rpc, i) =>
      w.watch(rpc, async (method, params, signal) => {
        const answer = await rpc(method, params, signal);
        if (method === "getProgramAccounts" && scannedList(answer) !== null) {
          answers[i]!.set(JSON.stringify(params), answer);
          if (answers[i]!.size === SCANS[kind]) halfOf(i);
        }
        return answer;
      }),
    ) as unknown as readonly [SolanaRpc, SolanaRpc];
    const ranks = read();
    const pools = find(pair, [w.watch(ranks[0]), w.watch(ranks[1])], token).catch((e: unknown) => {
      throw e instanceof SolanaRpcTransportError ? e : (w.fault() ?? e);
    });
    // the union when it comes first; none when it fails before any half (as pageReference reads a failed finder)
    const early = new Promise<readonly string[]>((ok) => {
      halfIn.then(ok);
      pools.then(ok, () => ok([]));
    });
    const k2 = { at: now(), pools, early };
    kept.set(token, k2);
    pools.catch(() => kept.get(token) === k2 && kept.delete(token));
    return k2;
  };
  return Object.assign((token: string) => of(token).pools, { early: (token: string) => of(token).early });
}
/** A scan's answer as the kit's scan reads it (dlmm.ts scanOn): a list of at most SOLANA_DLMM_SCAN_MAX addresses, or
 *  null for any other answer (the kit then refuses it, and the early list waits for the other provider). */
function scannedList(a: unknown): string[] | null {
  const v = Array.isArray(a) ? a : (a as { value?: unknown } | null)?.value;
  if (!Array.isArray(v) || v.length > SOLANA_DLMM_SCAN_MAX) return null;
  const out: string[] = [];
  for (const e of v) {
    const k = (e as { pubkey?: unknown } | null)?.pubkey;
    try {
      if (typeof k !== "string" || k.length > 44 || base58.decode(k).length !== 32) return null;
    } catch {
      return null;
    }
    out.push(k);
  }
  return out;
}
/** Every venue's and market kind's kept finder on the same providers. */
export const keptPoolFinders = (scan: () => readonly [SolanaRpc, SolanaRpc], read: () => readonly [SolanaRpc, SolanaRpc], now?: () => number): PoolFinders =>
  Object.freeze(Object.fromEntries([...FINDER_KINDS, ...MARKET_FINDER_KINDS].map((k) => [k, keptPools(k, scan, read, now)])) as PoolFinders);
/** The finders of the venues `tables` pins a non-empty table for (a coin of a venue with none stays unbought at the tap:
 *  quote_check_failed, no Cash moved), and every market finder, which needs no table since no buy takes a market; null
 *  when none is left. */
export function pinnedPoolFinders(finders: PoolFinders | null, tables: Readonly<Record<string, readonly string[] | undefined>>): PoolFinders | null {
  if (finders === null) return null;
  const kept = [
    ...FINDER_KINDS.filter((k) => finders[k] && Object.hasOwn(tables, POOL_FINDER_VENUES[k]) && (tables[POOL_FINDER_VENUES[k]]?.length ?? 0) > 0),
    ...MARKET_FINDER_KINDS.filter((k) => finders[k]),
  ];
  return kept.length === 0 ? null : Object.freeze(Object.fromEntries(kept.map((k) => [k, finders[k]])) as PoolFinders);
}

/** One read's providers watched (a reference's read, a finder's scan): the first provider fault any call threw, and
 *  each provider's calls still in flight. `fault` is the read's own fault once the kit's reader gave up: that provider
 *  fault, else a timeout naming a provider whose call is still unanswered (the kit gave up on it at its own bound,
 *  with a plain error), else null. */
function readWatch(what: string): { watch: (rpc: SolanaRpc, call?: (method: string, params: readonly unknown[], signal?: AbortSignal) => Promise<unknown>) => SolanaRpc; fault: () => SolanaRpcTransportError | null } {
  let fault: SolanaRpcTransportError | null = null;
  // the calls still in flight, by the provider's host
  const inFlight = new Map<string, number>();
  return {
    watch: (rpc, call = (method, params, signal) => rpc(method, params, signal)) => {
      const host = rpc.url === undefined ? "a provider" : new URL(rpc.url).host;
      return solanaWrappedRpc(rpc, async (method, params, signal) => {
        inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
        try {
          return await call(method, params, signal);
        } catch (e) {
          if (e instanceof SolanaRpcTransportError) fault ??= e;
          throw e;
        } finally {
          inFlight.set(host, inFlight.get(host)! - 1);
        }
      });
    },
    fault: () => {
      if (fault !== null) return fault;
      const waiting = [...inFlight].find(([, n]) => n > 0)?.[0];
      return waiting === undefined ? null : new SolanaRpcTransportError("timeout", `no answer before ${what} was given up`, 1, waiting);
    },
  };
}

async function readReference(rpcs: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<SolanaReference | null> {
  const w = readWatch("the reference's read");
  const ref = await readSolanaReference([w.watch(rpcs[0]), w.watch(rpcs[1])], req);
  if (ref !== null) return ref;
  const fault = w.fault();
  if (fault !== null) throw fault;
  return null;
}
