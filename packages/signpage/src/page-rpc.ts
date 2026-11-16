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
import { readSolanaAmmV4Pools } from "../../kit/src/trade/solana/amm-v4.ts";
import { SOLANA_POOL_BUY_VENUES } from "../../kit/src/trade/solana/pool-buy.ts";
import { HELPER_FETCH_INIT } from "../../kit/src/helper/v1.ts";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaHelperRpc, solanaJsonRpc, solanaSameProvider, solanaWrappedRpc, type SolanaFetch, type SolanaRpc, type SolanaRpcRetry } from "../../kit/src/trade/solana/send.ts";
import { HostPaused, gateSignal, hostLane } from "../../wallet/src/throttle.ts";

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
  // one attempt within `ms`, its fault named (a retry whose first wait is past its own bound tries once)
  const once = (ms: number, method: string, params: readonly unknown[]): Promise<unknown> =>
    solanaJsonRpc(url, { ...(o.init ? { init: o.init } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), retry: { deadlineMs: ms, backoffMs: ms } })(method, params);
  // every outcome reported to the lane: the gate's pause, and the probe's settle when this read was it
  // `stop`: the caller's signal and the page's gate (gateSignal), so an ask after the gate closed during the call is never
  // sent (card sign-out-stops-the-pages-reads); its waits for a turn also end at a sign out's tap (HostLane.turn)
  const ask = async (end: number, stop: AbortSignal, method: string, params: readonly unknown[]): Promise<unknown> => {
    stop.throwIfAborted();
    const sentIn = lane.gate.epoch();
    try {
      const r = await once(Math.max(1, Math.floor(end - performance.now())), method, params);
      lane.answered(sentIn);
      return r;
    } catch (e) {
      if (e instanceof SolanaRpcTransportError && throttles(e)) lane.throttled(sentIn, e.afterMs);
      else lane.failed(sentIn);
      throw e;
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
  const rpc = (method: string, params: readonly unknown[]): Promise<unknown> => {
    // the caller's signal and the page's gate: every ask of this call ends at either
    const stop = gateSignal(o.signal);
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
  const read = (method: string, params: readonly unknown[], tried: ReadonlySet<number>): Promise<unknown> => {
    const left = members.map((_, i) => i).filter((i) => !tried.has(i));
    const open = left.filter((i) => members[i]!.lane.open(kind));
    if (open.length === 0) {
      // none open: the one whose host opens first, as any page RPC
      const next = left.reduce((a, b) => (members[b]!.lane.wait(kind) < members[a]!.lane.wait(kind) ? b : a));
      return members[next]!.last(method, params);
    }
    const i = open[0]!;
    // the last member left is asked as any page RPC; one with members after it fails over on a throttle
    if (left.length === 1) return members[i]!.last(method, params);
    return members[i]!.fast(method, params).catch((e: unknown) => {
      if (!(e instanceof SolanaRpcTransportError)) throw e;
      return read(method, params, new Set([...tried, i]));
    });
  };
  return Object.assign((method: string, params: readonly unknown[]) => read(method, params, new Set()), { url: href });
}

/** A provider the device reaches directly. */
export const pageRpc = (url: string, kind: ReadKind = "trade"): SolanaRpc => lanedRpc(url, { kind });
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
  const kinds = FINDER_KINDS.filter((k) => req[k] === undefined && finders?.[k]);
  if (kinds.length > 0) {
    const found = Promise.all(kinds.map((k) => ((o.early ? finders![k]!.early : undefined) ?? finders![k]!)(req.token).catch(() => [] as readonly string[])));
    const pump = readReference(rpcs, req);
    const lists = await found;
    if (lists.every((l) => l.length === 0)) return pump;
    pump.catch(() => {});
    const more: { -readonly [K in PoolFinderKind]?: string[] } = {};
    kinds.forEach((k, i) => void (lists[i]!.length > 0 && (more[k] = [...lists[i]!])));
    return readReference(rpcs, { ...req, ...more });
  }
  return readReference(rpcs, req);
}

/** The best of a reference's priced pools among the venues the kit builds (each of SOLANA_POOL_BUY_VENUES): the most out. */
export const bestVenuePool = (ref: SolanaReference | null | undefined): SolanaReference["pools"][number] | undefined =>
  ref?.pools.filter((p) => SOLANA_POOL_BUY_VENUES.includes(p.venue)).sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];

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
/** The page's finders, one per scanned venue; a kind with none is read without its pools. */
export type PoolFinders = { readonly [K in PoolFinderKind]?: PoolsOf | null };
/** The page's finders, set once at start on mainnet (main.ts); none: a reference reads the pump venues alone. */
let pageFinders: PoolFinders | null = null;
export const setPagePoolFinders = (f: PoolFinders | null): void => void (pageFinders = f);
/** How many coins' pools a finder keeps, and how long: a pool made since is found on the next read a minute on. */
export const POOLS_KEPT = 256;
export const POOLS_KEEP_MS = 60_000;
type ScanRead = (scan: readonly [SolanaRpc, SolanaRpc], read: readonly [SolanaRpc, SolanaRpc], mint: string) => Promise<string[]>;
const FIND: Readonly<Record<PoolFinderKind, ScanRead>> = Object.freeze({ dlmmPairs: readSolanaDlmmPairs, cpmmPools: readSolanaCpmmPools, ammV4Pools: readSolanaAmmV4Pools });
/**
 * A finder of one venue that keeps each coin's pools POOLS_KEEP_MS: the kit's reader, scanning on `scan` (two providers
 * that answer getProgramAccounts) and ranking past its cap on `read`. A read that fails is kept for nothing, so the next
 * reference asks again; one read at a time per coin.
 */
export function keptPools(kind: PoolFinderKind, scan: () => readonly [SolanaRpc, SolanaRpc], read: () => readonly [SolanaRpc, SolanaRpc], now: () => number = () => performance.now()): PoolsOf {
  type Kept = { at: number; pools: Promise<readonly string[]>; early: Promise<readonly string[]> };
  const kept = new Map<string, Kept>();
  const find = FIND[kind];
  const of = (token: string): Kept => {
    const k = kept.get(token);
    if (k !== undefined && now() - k.at < POOLS_KEEP_MS) return k;
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
    const pair = scan().map((rpc, i) =>
      solanaWrappedRpc(rpc, async (method, params) => {
        const answer = await rpc(method, params);
        if (method === "getProgramAccounts" && scannedList(answer) !== null) {
          answers[i]!.set(JSON.stringify(params), answer);
          if (answers[i]!.size === 2) halfOf(i);
        }
        return answer;
      }),
    ) as unknown as readonly [SolanaRpc, SolanaRpc];
    const pools = find(pair, read(), token);
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
/** Every venue's kept finder on the same providers. */
export const keptPoolFinders = (scan: () => readonly [SolanaRpc, SolanaRpc], read: () => readonly [SolanaRpc, SolanaRpc], now?: () => number): PoolFinders =>
  Object.freeze(Object.fromEntries(FINDER_KINDS.map((k) => [k, keptPools(k, scan, read, now)])) as PoolFinders);
/** The finders of the venues `tables` pins a non-empty table for (a coin of a venue with none stays unbought at the tap:
 *  quote_check_failed, no Cash moved); null when none is left. */
export function pinnedPoolFinders(finders: PoolFinders | null, tables: Readonly<Record<string, readonly string[] | undefined>>): PoolFinders | null {
  if (finders === null) return null;
  const kept = FINDER_KINDS.filter((k) => finders[k] && Object.hasOwn(tables, POOL_FINDER_VENUES[k]) && (tables[POOL_FINDER_VENUES[k]]?.length ?? 0) > 0);
  return kept.length === 0 ? null : Object.freeze(Object.fromEntries(kept.map((k) => [k, finders[k]])) as PoolFinders);
}

async function readReference(rpcs: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<SolanaReference | null> {
  let fault: SolanaRpcTransportError | null = null;
  // the calls still in flight, by the provider's host
  const inFlight = new Map<string, number>();
  const watch = (rpc: SolanaRpc): SolanaRpc => {
    const host = rpc.url === undefined ? "a provider" : new URL(rpc.url).host;
    return solanaWrappedRpc(rpc, async (method, params) => {
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
      try {
        return await rpc(method, params);
      } catch (e) {
        if (e instanceof SolanaRpcTransportError) fault ??= e;
        throw e;
      } finally {
        inFlight.set(host, inFlight.get(host)! - 1);
      }
    });
  };
  const ref = await readSolanaReference([watch(rpcs[0]), watch(rpcs[1])], req);
  if (ref !== null) return ref;
  if (fault !== null) throw fault;
  const waiting = [...inFlight].find(([, n]) => n > 0)?.[0];
  if (waiting !== undefined) throw new SolanaRpcTransportError("timeout", "no answer before the reference's read was given up", 1, waiting);
  return null;
}
