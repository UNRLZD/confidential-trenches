// The signing page's one RPC client (card signpage-rpc-throttle-retry): the kit's solanaJsonRpc with the page's bound
// (SOLANA_RPC_RETRY), for every chain's pool reads and sends, testnet and mainnet alike, each on its host's lane (card
// signpage-passes-yield-to-a-trade, ../../wallet/src/throttle.ts HostLane): one budget per provider host for the whole
// page, whatever reader or object asks.
// - A read waits its turn on the host first: a trade's read ("trade", a buy's or sell's own) only the host's pause; a
//   background read ("pass": the proof pass, the positions pass, the state reads' settles) also every trade that holds
//   the host. Its bound (the retry's deadlineMs) starts once its turn comes.
// - A throttle (HTTP 429, a 5xx, -32029 or -32429 in a 200) pauses the host for every reader by the one rule (from 1 s,
//   doubling to 10 s, a Retry-After when longer; api.devnet.solana.com exposes none to a page), and the read that met it
//   is asked again once, after that pause; an answer that is not JSON, a stall or a dropped connection is asked again
//   once after the retry's backoff. Never a third ask, and never a wait that would end past the call's bound: the call
//   then rejects naming its fault (SolanaRpcTransportError). So a trade's read waits at most the host's pause
//   (THROTTLE_PAUSE_MAX_MS or THROTTLE_RETRY_AFTER_MAX_MS, 10 s) and then its bound (3.5 s; 12 s for a settle's
//   SOLANA_RPC_WINDOW_RETRY): 13.5 s at most, 22 s on a settle's seat.
import { readSolanaReference, type SolanaReference, type SolanaReferenceRequest } from "../../kit/src/trade/solana/pool.ts";
import { HELPER_FETCH_INIT } from "../../kit/src/helper/v1.ts";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaHelperRpc, solanaJsonRpc, solanaSameProvider, solanaWrappedRpc, type SolanaFetch, type SolanaRpc, type SolanaRpcRetry } from "../../kit/src/trade/solana/send.ts";
import { hostLane } from "../../wallet/src/throttle.ts";

/** Whose read it is: a trade's own (first on its host) or a background pass's (after every trade on its host). */
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
export function lanedRpc(url: string, o: { kind?: ReadKind; retry?: SolanaRpcRetry; init?: RequestInit; fetch?: SolanaFetch; signal?: AbortSignal } = {}): SolanaRpc {
  const kind = o.kind ?? "trade";
  const retry = o.retry ?? SOLANA_RPC_RETRY;
  const href = solanaJsonRpc(url).url!;
  const lane = hostLane(href);
  // one attempt within `ms`, its fault named (a retry whose first wait is past its own bound tries once)
  const once = (ms: number, method: string, params: readonly unknown[]): Promise<unknown> =>
    solanaJsonRpc(url, { ...(o.init ? { init: o.init } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), retry: { deadlineMs: ms, backoffMs: ms } })(method, params);
  const ask = async (end: number, method: string, params: readonly unknown[]): Promise<unknown> => {
    const sentIn = lane.gate.epoch();
    try {
      const r = await once(Math.max(1, Math.floor(end - performance.now())), method, params);
      lane.gate.answered(sentIn);
      return r;
    } catch (e) {
      if (e instanceof SolanaRpcTransportError && throttles(e)) lane.gate.throttled(sentIn, e.afterMs);
      throw e;
    }
  };
  // asked again once: after the host's pause (a throttle) or the retry's backoff (any other fault), a background read
  // after every trade on the host too, never past the call's bound
  const again = async (end: number, e: unknown, method: string, params: readonly unknown[]): Promise<unknown> => {
    if (!(e instanceof SolanaRpcTransportError)) throw e;
    const wait = throttles(e) ? lane.gate.left() : retry.backoffMs;
    if (performance.now() + wait >= end) throw e;
    await sleep(wait, o.signal);
    await lane.turn(kind, o.signal);
    if (performance.now() >= end) throw e;
    return ask(end, method, params);
  };
  // its bound from its turn on
  const go = (method: string, params: readonly unknown[]): Promise<unknown> => {
    const end = performance.now() + retry.deadlineMs;
    return ask(end, method, params).catch((e: unknown) => again(end, e, method, params));
  };
  // a read whose turn is open now goes out in this tick (a paced queue's slot calls it as its own)
  const rpc = (method: string, params: readonly unknown[]): Promise<unknown> => (lane.open(kind) ? go(method, params) : lane.turn(kind, o.signal).then(() => go(method, params)));
  return Object.assign(rpc, { url: href });
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
 * since the watch wraps each provider.
 */
export async function pageReference(rpcs: readonly [SolanaRpc, SolanaRpc], req: SolanaReferenceRequest): Promise<SolanaReference | null> {
  if (solanaSameProvider(rpcs[0], rpcs[1])) throw new Error("the two providers are the same provider: a reference must never rest on one provider's word");
  let fault: SolanaRpcTransportError | null = null;
  const watch = (rpc: SolanaRpc): SolanaRpc =>
    solanaWrappedRpc(rpc, async (method, params) => {
      try {
        return await rpc(method, params);
      } catch (e) {
        if (e instanceof SolanaRpcTransportError) fault ??= e;
        throw e;
      }
    });
  const ref = await readSolanaReference([watch(rpcs[0]), watch(rpcs[1])], req);
  if (ref === null && fault !== null) throw fault;
  return ref;
}
