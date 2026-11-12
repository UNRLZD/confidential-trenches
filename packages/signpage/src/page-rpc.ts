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
//   once after the retry's backoff. A sign out ends every wait on every host at once (stopHostLaneWaits). Never a third ask, and never a wait that would end past the call's bound: the call
//   then rejects naming its fault (SolanaRpcTransportError). So a trade's read waits for its turn at most
//   TRADE_TURN_MAX_MS + PROBE_HELD_MAX_MS (15 s) from the turn's start, the host's pause (at most 10 s) and the probes
//   after it (each read parked ahead may be one) together, then its bound (3.5 s; 12 s for a settle's
//   SOLANA_RPC_WINDOW_RETRY), whatever the host answers; a seat (seatRpc) adds its next member's own once a member
//   faults.
import { readSolanaReference, type SolanaReference, type SolanaReferenceRequest } from "../../kit/src/trade/solana/pool.ts";
import { HELPER_FETCH_INIT } from "../../kit/src/helper/v1.ts";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaHelperRpc, solanaJsonRpc, solanaSameProvider, solanaWrappedRpc, type SolanaFetch, type SolanaRpc, type SolanaRpcRetry } from "../../kit/src/trade/solana/send.ts";
import { HostPaused, hostLane, laneSignal } from "../../wallet/src/throttle.ts";

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

/** A read a trade can do without (card round-trip-costs-less, review P2-1 of 4f9217972: a sale's fee read), on a page
 *  RPC's host: sent only when the host is open now, counted in its budget (HostLane count), asked once with no retry
 *  within the page's bound, and its outcome never reported to the lane, so its throttle pauses no reader and nothing
 *  waits on it; `signal` aborts it (the sale stops waiting for it once its first simulation answers). A host not open
 *  now: refused at once, nothing sent. */
export type OptionalRead = (method: string, params: readonly unknown[], signal: AbortSignal) => Promise<unknown>;
/** A page RPC, with its optional read. */
export type PageRpc = SolanaRpc & { readonly optional?: OptionalRead };
/** Each page RPC's optional read by its url (a paced or wrapped provider carries the url, as SEATS reads it): a trade's
 *  RPC first, a seat over its first member's. */
const OPTIONAL = new Map<string, OptionalRead>();
/** `rpc`'s optional read (OptionalRead), or none (the read is not made). A provider with no url (a test's) is asked as
 *  itself. */
export function optionalRead(rpc: SolanaRpc): OptionalRead | undefined {
  if (rpc.url === undefined) return (method, params) => rpc(method, params);
  return OPTIONAL.get(rpc.url);
}

/** `url` as a page RPC on its host's lane (the header): `kind` its turn, `retry` its bound, `init` and `fetch` the kit
 *  client's own, `signal` ends a wait for the turn or the pause at once. */
export function lanedRpc(url: string, o: { kind?: ReadKind; retry?: SolanaRpcRetry; init?: RequestInit; fetch?: SolanaFetch; signal?: AbortSignal; spare?: boolean } = {}): PageRpc {
  const kind = o.kind ?? "trade";
  const retry = o.retry ?? SOLANA_RPC_RETRY;
  const href = solanaJsonRpc(url).url!;
  const lane = hostLane(href);
  // one attempt within `ms`, its fault named (a retry whose first wait is past its own bound tries once)
  const once = (ms: number, method: string, params: readonly unknown[]): Promise<unknown> =>
    solanaJsonRpc(url, { ...(o.init ? { init: o.init } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), retry: { deadlineMs: ms, backoffMs: ms } })(method, params);
  // every outcome reported to the lane: the gate's pause, and the probe's settle when this read was it
  const ask = async (end: number, method: string, params: readonly unknown[]): Promise<unknown> => {
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
  const again = async (end: number, e: unknown, method: string, params: readonly unknown[]): Promise<unknown> => {
    if (!(e instanceof SolanaRpcTransportError)) throw e;
    if (!throttles(e)) {
      if (performance.now() + retry.backoffMs >= end) throw e;
      await sleep(retry.backoffMs, laneSignal(o.signal));
    }
    // its turn again, whichever kind, held to the read's bound: the turn waits the host's pause (another reader's 429
    // may move it on meanwhile: a paid devnet run of 11 Nov, a deposit's re-ask sent into it drew a 429 and doubled it)
    // and the probe after it; a wait that would pass `end` is refused at once, nothing counted, and the read ends on
    // its 429 (the review of 321509e2: a 3.5 s read slept a pause moved to 9 s, then threw at 9.4 s, its turn counted)
    try {
      await lane.turn(kind, o.signal, true, { reports: true, by: end });
    } catch (x) {
      if (x instanceof HostPaused) throw e;
      throw x;
    }
    return ask(end, method, params);
  };
  // its bound from its turn on
  const go = (method: string, params: readonly unknown[]): Promise<unknown> => {
    const end = performance.now() + retry.deadlineMs;
    // a seat's member with a spare after it (seatRpc) is not asked again after any provider fault (a throttle, a 5xx, no
    // connection, a stall to its bound, an answer that is no JSON): the read goes to the spare
    return ask(end, method, params).catch((e: unknown) => (o.spare === true && e instanceof SolanaRpcTransportError ? Promise.reject(e) : again(end, e, method, params)));
  };
  // a read whose turn is open now goes out in this tick (a paced queue's slot calls it as its own)
  // (a trade's turn refused past its TRADE_TURN_MAX_MS is the host's throttle, never sent: HostPaused)
  const rpc = (method: string, params: readonly unknown[]): Promise<unknown> => {
    if (!lane.open(kind))
      return lane.turn(kind, o.signal, true, { reports: true }).then(
        () => go(method, params),
        (x: unknown) => Promise.reject(x instanceof HostPaused ? new SolanaRpcTransportError("http_429", "the host stayed paused past the read's turn", 0, lane.host) : x),
      );
    lane.took(kind);
    return go(method, params);
  };
  const optional: OptionalRead = (method, params, signal) => {
    if (signal.aborted || !lane.open(kind)) return Promise.reject(new SolanaRpcTransportError("http_429", "an optional read is sent only while its host is open", 0, lane.host));
    lane.count();
    const doFetch = o.fetch ?? globalThis.fetch;
    const fetch: SolanaFetch = (u, init) => doFetch(u, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    return solanaJsonRpc(url, { ...(o.init ? { init: o.init } : {}), fetch, retry: { deadlineMs: retry.deadlineMs, backoffMs: retry.deadlineMs } })(method, params);
  };
  if (kind === "trade" && !OPTIONAL.has(href)) OPTIONAL.set(href, optional);
  return Object.assign(rpc, { url: href, optional });
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
export function seatRpc(urls: readonly string[], kind: ReadKind = "trade", retry: SolanaRpcRetry = SOLANA_RPC_RETRY): PageRpc {
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
  // an optional read (OptionalRead): the first member whose host is open now, one member only, never failed over
  const optional: OptionalRead = (method, params, signal) => {
    const m = members.find((x) => x.lane.open(kind));
    return m === undefined ? Promise.reject(new SolanaRpcTransportError("http_429", "an optional read is sent only while its host is open", 0, members[0]!.lane.host)) : m.last.optional!(method, params, signal);
  };
  if (kind === "trade") OPTIONAL.set(href, optional);
  return Object.assign((method: string, params: readonly unknown[]) => read(method, params, new Set()), { url: href, optional });
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
export async function pageReference(rpcs: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<SolanaReference | null> {
  if (solanaSameProvider(rpcs[0], rpcs[1])) throw new Error("the two providers are the same provider: a reference must never rest on one provider's word");
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
