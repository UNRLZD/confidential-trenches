// A NEAR provider's rate limit on the vault's reads, waited out (card restore-waits-out-a-near-throttle). Release 162's
// sign-in on a fresh device (16 Nov 04:32Z, pool-restore-wired live) ended stalled: "near vault: vault sync stopped
// (rpc): https://near.drpc.org: HTTP 429". The pair's pacedNearRpc asks a 429 again up to NEAR_BUSY_TRIES (about 7 s
// of waits on dRPC), then throws, and vaultSync took that throw as the provider down, so one throttle of a few seconds
// more cost the user the whole vault.
//
// - A throttle: HTTP 429 (the kit's nearRpc throws rpcHttpError, status 429 and its Retry-After kept; the exit tool's
//   exitRpc throws "HTTP 429"), or dRPC's rate limit inside a 200 (`error.code` 15, "You reached Public endpoint rate
//   limit", the shape kit send.ts RPC_THROTTLE_CODES takes on Solana). Nothing else: a 5xx, a timeout or any other
//   error is a fault as before.
// - The wait: the one throttle rule (../throttle.ts throttleWaitMs, which the wallet gives on: 1 s, doubling, at most
//   10 s, a longer Retry-After honoured up to 10 s; signpage read-waits.ts takes it for a kind's reads), then the
//   same query asked again of the same provider. The byte-for-byte rule is the caller's and is unchanged: a query
//   waited out still gives its own answer, matched against the other provider's as any other.
// - The bound: one provider's stretch of throttles, from the first with no answer since, ends at
//   VAULT_SYNC_THROTTLE_MS (the page's READ_WAIT_TOTAL_MS): no wait starts that would end past it, and the query then
//   throws VaultThrottled, naming the provider, the refusal, the view and the time it waited, so a provider that never
//   stops refusing ends the read as before, with its reason. An answer ends the stretch; the pause is kept (an answer
//   never sets it back, as ThrottleGate), so a provider that throttles again is not asked in a burst.
// - A healthy read meets none of it: no wait, no extra ask. An abort ends a wait at once.
import { throttleWaitMs } from "../throttle.ts";

/** The longest one provider's stretch of throttles is waited out, ms: the signing page's bound on a kind's reads
 *  (signpage read-waits.ts READ_WAIT_TOTAL_MS). */
export const VAULT_SYNC_THROTTLE_MS = 30_000;

/** One provider's throttle state for one read (a sync, a config read): the last pause and the stretch's start. */
export type VaultThrottle = { pause: number; since: number | null };
export const vaultThrottle = (): VaultThrottle => ({ pause: 0, since: null });

/** A provider still throttling at the bound (see the header). */
export class VaultThrottled extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "VaultThrottled";
  }
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** A throw that is a throttle (HTTP 429): its words and its Retry-After (ms) when it named one; else null. */
function thrownThrottle(e: unknown): { words: string; afterMs: number | null } | null {
  if (!(e instanceof Error)) return null;
  const status = (e as { status?: unknown }).status;
  if (status !== 429 && !(status === undefined && e.message === "HTTP 429")) return null;
  const after = (e as { retryAfterMs?: unknown }).retryAfterMs;
  return { words: "HTTP 429", afterMs: typeof after === "number" ? after : null };
}
/** An answer that is a throttle: dRPC's rate limit in a 200 (code 15); else null. */
function answerThrottle(a: unknown): { words: string; afterMs: null } | null {
  if (!isObj(a) || !isObj(a.error) || a.error.code !== 15 || typeof a.error.message !== "string" || !a.error.message.includes("rate limit")) return null;
  return { words: "a rate limit (code 15)", afterMs: null };
}

/** `ms`, or until `signal` aborts (its reason thrown), the timer cleared either way. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((done, no) => {
    if (signal?.aborted) return no(signal.reason);
    const stop = () => {
      clearTimeout(timer);
      no(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      done();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * `ask()`'s answer from provider `name`, a throttle waited out within the bound (see the header): what `ask` throws
 * that is no throttle is thrown as it is; a throttle past the bound throws VaultThrottled. `what` names the query.
 */
export async function vaultAskWaited(ask: () => Promise<unknown>, name: string, what: string, t: VaultThrottle, signal?: AbortSignal): Promise<unknown> {
  for (;;) {
    let th: { words: string; afterMs: number | null } | null;
    try {
      const a = await ask();
      th = answerThrottle(a);
      if (th === null) {
        t.since = null;
        return a;
      }
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      th = thrownThrottle(e);
      if (th === null) throw e;
    }
    const now = Date.now();
    t.since ??= now;
    const ms = throttleWaitMs(t.pause, th.afterMs);
    if (now - t.since + ms > VAULT_SYNC_THROTTLE_MS)
      throw new VaultThrottled(`${name}: ${th.words} (${what}), still throttling after ${Math.round((now - t.since) / 1000)} s of waits (at most ${VAULT_SYNC_THROTTLE_MS / 1000} s)`);
    t.pause = ms;
    await sleep(ms, signal);
  }
}
