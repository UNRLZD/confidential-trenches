// What a kind does when a provider read still fails past the page client's own retry, before anything is signed (card
// start-reads-wait-out-a-throttle). The app's paid devnet run 6 (11 Nov 02:51Z): a sell tapped 0.6 s after its buy's
// Final met HTTP 429 on getFeeForMessage, then on each attempt's first read, then on the deposit's reads; three flat
// 1 s waits could not outlast the provider's window and the sell answered down at +19.9 s, nothing signed. The public
// devnet provider sends no Retry-After the page can read (no Access-Control-Expose-Headers), so the doubling is the
// only signal there is.
//
// - readWaits: the wait before a kind's next attempt, on the wallet's one rule (../../wallet/src/throttle.ts
//   throttleWaitMs): from 1 s, doubling, at most 10 s, a Retry-After longer than that pause honoured up to 10 s. No
//   flat wait. The kind answers down only once the next wait would take its waits past READ_WAIT_TOTAL_MS (1 + 2 + 4 + 8
//   + 10 = 25 s of waits, five attempts after the first).
// - Each attempt after a wait reads again from its first read, so its quote, its venue, its blockhash and every account
//   it prices are the attempt's own: nothing signed rests on a read from before a wait.
// - keptReads: the reads that cannot change while a kind waits (the Rent sysvar, a token's mint account: its program
//   and its decimals), kept per provider across the attempts of one kind, so an attempt asks them again only of a
//   provider whose read failed. Every other read goes to the provider each time.
// - Which faults wait: the page client's transport fault (kit send.ts SolanaRpcTransportError: a 429, a 5xx, a JSON-RPC
//   throttle, no answer in time, an answer that is not JSON) and, on EVM, the reads' own unanswered and lag faults.
//   Any other error (a revert, an answer that does not parse, two providers that disagree) answers at once as before.
// - A sign out ends every wait (waitUnless on the page's sign-out signal), and a kind started before it never runs
//   after it: it answers failed, nothing signed (ReadStopped).
// - While it waits the app's box draws what it draws for any trade still running (Sending, then Slow past 5 s): no
//   stage fits a wait (sent would say something left the device), so none is posted.
import { SOLANA_RENT_SYSVAR } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, solanaWrappedRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { throttleWaitMs, type ThrottleBounds } from "../../wallet/src/throttle.ts";

/** The wait before a kind's next attempt: the wallet's rule in these bounds. */
export const READ_WAIT: ThrottleBounds = /* @__PURE__ */ Object.freeze({ firstMs: 1_000, maxMs: 10_000, afterMaxMs: 10_000 });
/** The most a kind waits in all before it answers down. */
export const READ_WAIT_TOTAL_MS = 30_000;

/** The provider's Retry-After as the page client read it (ms), or null. */
export const afterOf = (e: unknown): number | null => (e instanceof SolanaRpcTransportError ? e.afterMs : null);

export type ReadWaits = {
  /** The next wait after a fault (`e`, for its Retry-After), or null once it would take the waits past the total. */
  next(e: unknown): number | null;
};
/** One kind's waits, from none. */
export function readWaits(): ReadWaits {
  let pause = 0;
  let waited = 0;
  return {
    next(e) {
      const p = throttleWaitMs(pause, afterOf(e), READ_WAIT);
      if (waited + p > READ_WAIT_TOTAL_MS) return null;
      pause = p;
      waited += p;
      return p;
    },
  };
}

/** Whether a fault waits (see the header): the page client's transport fault; any other error answers at once. */
export const waitsOn = (e: unknown): boolean => e instanceof SolanaRpcTransportError;

/** A kind stopped by a sign out while it waited, or before it ran: it answers failed, nothing signed. */
export class ReadStopped extends Error {
  constructor() {
    super("signed out while the reads waited");
    this.name = "ReadStopped";
  }
}

/** `wait(ms)`, ended early when `signal` aborts (a sign out: every wait ends there). */
export function waitUnless(wait: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return wait(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((done) => {
    const off = (): void => done();
    signal.addEventListener("abort", off, { once: true });
    void wait(ms).then(() => {
      signal.removeEventListener("abort", off);
      done();
    });
  });
}

/** A kind's attempts (`run`, which names the fault it answered down on in `at`) with the rule's waits between them:
 *  its answer once it names no fault; "down" once the waits are spent; failed once a sign out ended a wait. */
export async function readsWaited<A>(run: (at: { fault?: unknown }) => Promise<A>, wait: ((ms: number) => Promise<void>) | undefined, signal: AbortSignal | undefined): Promise<A | { error: "failed" }> {
  const pause = wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waits = readWaits();
  for (;;) {
    const at: { fault?: unknown } = {};
    const a = await run(at);
    if (!("fault" in at)) return a;
    if (signal?.aborted) return { error: "failed" };
    const ms = waits.next(at.fault);
    if (ms === null) return a;
    await waitUnless(pause, ms, signal);
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
