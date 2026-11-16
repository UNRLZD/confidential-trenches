// The one rule for the wait after a provider's throttle (card signpage-throttled-read-is-not-asked-again-at-once; the
// rule's reasons are in ../../wallet/src/throttle.ts, whose ThrottleGate holds one provider's state under it). It lives
// here, in the kit, since card restore-waits-out-a-near-throttle, so the kit's own vault reads (vault/throttle.ts) wait on
// it too; the wallet gives it on unchanged, and the signing page's reads (signpage read-waits.ts) take it from there.
// The pause doubles from `firstMs` (the previous pause 0: none yet) up to `maxMs`; a provider's Retry-After is the wait
// when it is longer, finite and above 0, held to `afterMaxMs`. A Retry-After of 0, a negative or a non-finite one is
// never the wait: the growing pause still holds, so a throttled provider is never asked in a burst. Pure, so any loop
// that asks a provider again can use it.

/** The first pause after a throttle that names no longer Retry-After. */
export const THROTTLE_PAUSE_FIRST_MS = 1_000;
/** The longest pause the doubling reaches. */
export const THROTTLE_PAUSE_MAX_MS = 10_000;
/** The longest Retry-After honoured: the helper's own window (apps/helper/src/rpc/rpc.ts, up to 10 s). */
export const THROTTLE_RETRY_AFTER_MAX_MS = 10_000;

export type ThrottleBounds = { readonly firstMs: number; readonly maxMs: number; readonly afterMaxMs: number; readonly quietMs?: number };
export const THROTTLE_BOUNDS: ThrottleBounds = /* @__PURE__ */ Object.freeze({ firstMs: THROTTLE_PAUSE_FIRST_MS, maxMs: THROTTLE_PAUSE_MAX_MS, afterMaxMs: THROTTLE_RETRY_AFTER_MAX_MS });

/** The wait after a throttle, given the pause before it (0: none) and the provider's Retry-After in ms (any value). */
export function throttleWaitMs(prevMs: number, afterMs: unknown, b: ThrottleBounds = THROTTLE_BOUNDS): number {
  const pause = Number.isFinite(prevMs) && prevMs > 0 ? Math.min(prevMs * 2, b.maxMs) : b.firstMs;
  const after = typeof afterMs === "number" && Number.isFinite(afterMs) && afterMs > 0 ? Math.min(afterMs, b.afterMaxMs) : 0;
  return Math.max(pause, after);
}
