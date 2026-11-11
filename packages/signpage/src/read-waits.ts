// What a kind does when a provider read still fails past the page client's own retry, before anything is signed (card
// start-reads-wait-out-a-throttle). The app's paid devnet run 6 (11 Nov 02:51Z): a sell tapped 0.6 s after its buy's
// Final met HTTP 429 on getFeeForMessage, then on each attempt's first read, then on the deposit's reads; three flat
// 1 s waits could not outlast the provider's window and the sell answered down at +19.9 s, nothing signed. The public
// devnet provider sends no Retry-After the page can read (no Access-Control-Expose-Headers), so the doubling is the
// only signal there is.
//
// - readWaits: the wait before a kind's next attempt, on the wallet's one rule (../../wallet/src/throttle.ts
//   throttleWaitMs): from 1 s, doubling, at most 10 s, a Retry-After longer than that pause honoured up to 10 s. No
//   flat wait. One total per tap (tapWaits, keyed by the request's KindContext: the sell's decimals read, its plan and
//   every sale share it; a buy and a deposit ask likewise), on the device's clock from the request's arrival, so waits,
//   the host's pauses and slow reads all count: no wait starts that would end past READ_WAIT_TOTAL_MS, and once one is
//   refused (spent) no attempt starts again, not even another wallet's sale, so the tap answers down.
// - Each attempt after a wait reads again from its first read, so its quote, its venue, its blockhash and every account
//   it prices are the attempt's own: nothing signed rests on a read from before a wait.
// - keptReads: the reads that cannot change while a kind waits (the Rent sysvar, a token's mint account: its program
//   and its decimals), kept per provider across the attempts of one kind, so an attempt asks them again only of a
//   provider whose read failed. Every other read goes to the provider each time.
// - Which faults wait: the page client's transport fault (kit send.ts SolanaRpcTransportError: a 429, a 5xx, a JSON-RPC
//   throttle, no answer in time, an answer that is not JSON) and, on EVM, the reads' own unanswered and lag faults.
//   Any other error (a revert, an answer that does not parse, two providers that disagree) answers at once as before.
// - A sign out ends every wait (waitUnless on the session's sign-out signal, aborted at the tap of sign out, before the
//   seed lock is asked), and a kind started before it never runs after it: it answers failed, nothing signed
//   (ReadStopped).
// - While it waits the app's box draws what it draws for any trade still running (Sending, then Slow past 5 s): no
//   stage fits a wait (sent would say something left the device), so none is posted.
import { SOLANA_RENT_SYSVAR } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, solanaWrappedRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { throttleWaitMs, type ThrottleBounds } from "../../wallet/src/throttle.ts";

/** The wait before a kind's next attempt: the wallet's rule in these bounds. */
export const READ_WAIT: ThrottleBounds = /* @__PURE__ */ Object.freeze({ firstMs: 1_000, maxMs: 10_000, afterMaxMs: 10_000 });
/** One tap's bound, on the device's clock from the request's arrival: the tap answers down once the next wait would end
 *  past it, and starts no attempt after that (another wallet's sale included). The worst a throttled tap takes before
 *  down is this plus the one attempt in flight: each of its reads at most 13.5 s with the per-host pause (page-rpc.ts:
 *  the host's pause, at most 10 s, then the call's 3.5 s bound). A sale that never met a fault is never cut by it. */
export const READ_WAIT_TOTAL_MS = 30_000;
/** The device's clock, ms. */
export type ReadClock = () => number;
const deviceClock: ReadClock = () => Date.now();

/** The provider's Retry-After as the page client read it (ms), or null. */
export const afterOf = (e: unknown): number | null => (e instanceof SolanaRpcTransportError ? e.afterMs : null);

export type ReadWaits = {
  /** The next wait after a fault (`e`, for its Retry-After), or null once it would end past the tap's bound. */
  next(e: unknown): number | null;
  /** Whether a wait was refused (`next` gave null): the tap is down, and no attempt starts again. */
  spent(): boolean;
};
/** One tap's waits, its bound counted on `clock` from now. */
export function readWaits(clock: ReadClock = deviceClock): ReadWaits {
  const start = clock();
  let pause = 0;
  // the waits asked so far: the time spent is never less than them (a clock that does not move, a host's fixed `now`)
  let waited = 0;
  let spent = false;
  return {
    next(e) {
      const p = throttleWaitMs(pause, afterOf(e), READ_WAIT);
      if (spent || Math.max(clock() - start, waited) + p > READ_WAIT_TOTAL_MS) return ((spent = true), null);
      pause = p;
      waited += p;
      return p;
    },
    spent: () => spent,
  };
}
// each request's bound by its id (a kind's host passes the request's context on as a copy, so the id names it), dropped
// when its run ends (tapDone), so an id asked again (the page's follow deposits all share one) starts a bound of its
// own; one whose run never ends is dropped a minute past its bound
const taps = new Map<string, { waits: ReadWaits; at: number }>();
const TAP_KEPT_MS = READ_WAIT_TOTAL_MS + 60_000;
/** A request's one bound (`tap`: its KindContext, by its id), started by its first reader; a fresh one with none. */
export function tapWaits(tap: { id?: unknown } | null | undefined, clock?: ReadClock): ReadWaits {
  if (typeof tap?.id !== "string") return readWaits(clock);
  const now = deviceClock();
  for (const [k, v] of taps) if (now - v.at > TAP_KEPT_MS) taps.delete(k);
  let t = taps.get(tap.id);
  if (t === undefined) taps.set(tap.id, (t = { waits: readWaits(clock), at: now }));
  return t.waits;
}
/** A request's run ended: its bound is dropped (only that one: a run of the same id begun since keeps its own). */
export function tapDone(tap: { id?: unknown } | null | undefined, waits: ReadWaits): void {
  if (typeof tap?.id === "string" && taps.get(tap.id)?.waits === waits) taps.delete(tap.id);
}
/** A host's clock (its `now`, a bigint or a number of ms), else the device's. */
export const clockOf = (h: { now?: () => bigint | number }): ReadClock => () => Number(h.now?.() ?? Date.now());

/** Whether a fault waits (see the header): the page client's transport fault; any other error answers at once. */
export const waitsOn = (e: unknown): boolean => e instanceof SolanaRpcTransportError;

/** A kind stopped by a sign out while it waited, or before it ran: it answers failed, nothing signed. */
export class ReadStopped extends Error {
  constructor() {
    super("signed out while the reads waited");
    this.name = "ReadStopped";
  }
}

/** `wait(ms)` (a host's, else a timer of its own), ended early when `signal` aborts (a sign out: every wait ends there,
 *  its own timer cleared); it settles, never throws, when `wait` rejects. */
export function waitUnless(wait: ((ms: number) => Promise<void>) | undefined, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((done) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", end);
      done();
    };
    signal?.addEventListener("abort", end, { once: true });
    if (wait === undefined) timer = setTimeout(end, ms);
    else wait(ms).then(end, end);
  });
}
/** A deposit host's two stops as one: the session's sign out (`stop`) or the page leaving the deposit (`signal`). */
export const stopOf = (h: { signal?: AbortSignal; stop?: AbortSignal }): AbortSignal | undefined =>
  h.signal !== undefined && h.stop !== undefined ? AbortSignal.any([h.signal, h.stop]) : (h.signal ?? h.stop);

/** A kind's attempts (`run`, which names the fault it answered down on in `at`) with the rule's waits between them:
 *  its answer once it names no fault; "down" once the waits are spent; failed once a sign out ended a wait. */
export async function readsWaited<A>(run: (at: { fault?: unknown }) => Promise<A>, wait: ((ms: number) => Promise<void>) | undefined, signal: AbortSignal | undefined, waits: ReadWaits): Promise<A | { error: "failed" }> {
  for (;;) {
    const at: { fault?: unknown } = {};
    const a = await run(at);
    if (!("fault" in at)) return a;
    if (signal?.aborted) return { error: "failed" };
    const ms = waits.next(at.fault);
    if (ms === null) return a;
    await waitUnless(wait, ms, signal);
    if (signal?.aborted) return { error: "failed" };
  }
}

/** The pair of providers with the reads `stable` names kept per provider once answered (see the header). The same
 *  providers to solanaSameProvider and their queues (solanaWrappedRpc). */
export function keptReads(rpcs: readonly [SolanaRpc, SolanaRpc], stable: (method: string, params: readonly unknown[]) => boolean): readonly [SolanaRpc, SolanaRpc] {
  const keep = (rpc: SolanaRpc): SolanaRpc => {
    const kept = new Map<string, unknown>();
    return solanaWrappedRpc(rpc, (method, params) => {
      if (!stable(method, params)) return rpc(method, params);
      const key = `${method} ${JSON.stringify(params)}`;
      if (kept.has(key)) return Promise.resolve(kept.get(key));
      return rpc(method, params).then((v) => (kept.set(key, v), v));
    });
  };
  return [keep(rpcs[0]), keep(rpcs[1])];
}

/** A sell's or a buy's stable reads: the Rent sysvar, and the token's mint account (getAccountInfo of `mint`). */
export const solanaStableReads =
  (mint: string | null) =>
  (method: string, params: readonly unknown[]): boolean =>
    method === "getAccountInfo" && (params[0] === SOLANA_RENT_SYSVAR || (mint !== null && params[0] === mint));
