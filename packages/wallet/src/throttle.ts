// A provider that throttles is not asked again at once (card signpage-throttled-read-is-not-asked-again-at-once). The
// app's devnet run (card app-a2-e2e run 4, 10 Nov 22:06Z) met 638 answers of 429 to getTokenAccountsByOwner in 300 s,
// about 2 a second: the holdings reads waited a flat 1 s after each throttle and the positions pass ran again 5 s after
// each failed one, so the page's own asks kept the provider's per-method window full and it never cleared; a sell
// tapped then was refused at 23.7 s.
//
// - throttleWaitMs: the one rule for the wait after a throttle. The pause doubles from `firstMs` (the previous pause 0:
//   none yet) up to `maxMs`; a provider's Retry-After is the wait when it is longer, finite and above 0, held to
//   `afterMaxMs`. A Retry-After of 0, a negative or a non-finite one is never the wait: the growing pause still holds,
//   so a throttled provider is never asked in a burst. Pure, so any loop that asks a provider again can use it.
// - ThrottleGate: one provider's state under that rule, shared by every caller of one route (the holdings readers' own
//   queue: buy-wallets.ts), never by a route it does not own. After a throttle, left() is how long until the provider
//   may be asked again. The calls of one round go out together: their throttles count as one, by the epoch each call
//   was sent in, so a round of three 429s grows the pause once. A round that goes through whole, sent after the last
//   counted throttle, sets the pause back to none (answered); one call's answer does not, since a provider that
//   throttles one method (Solana's public RPC limits each method) still answers the others.

/** The first pause after a throttle that names no longer Retry-After. */
export const THROTTLE_PAUSE_FIRST_MS = 1_000;
/** The longest pause the doubling reaches. */
export const THROTTLE_PAUSE_MAX_MS = 10_000;
/** The longest Retry-After honoured: the helper's own window (apps/helper/src/rpc/rpc.ts, up to 10 s). */
export const THROTTLE_RETRY_AFTER_MAX_MS = 10_000;

export type ThrottleBounds = { readonly firstMs: number; readonly maxMs: number; readonly afterMaxMs: number };
export const THROTTLE_BOUNDS: ThrottleBounds = /* @__PURE__ */ Object.freeze({ firstMs: THROTTLE_PAUSE_FIRST_MS, maxMs: THROTTLE_PAUSE_MAX_MS, afterMaxMs: THROTTLE_RETRY_AFTER_MAX_MS });

/** The wait after a throttle, given the pause before it (0: none) and the provider's Retry-After in ms (any value). */
export function throttleWaitMs(prevMs: number, afterMs: unknown, b: ThrottleBounds = THROTTLE_BOUNDS): number {
  const pause = Number.isFinite(prevMs) && prevMs > 0 ? Math.min(prevMs * 2, b.maxMs) : b.firstMs;
  const after = typeof afterMs === "number" && Number.isFinite(afterMs) && afterMs > 0 ? Math.min(afterMs, b.afterMaxMs) : 0;
  return Math.max(pause, after);
}

/** One provider's throttle state on one route (see the header). `now` is the clock (tests replace it). */
export class ThrottleGate {
  #until = 0;
  #pause = 0;
  #epoch = 0;
  readonly #now: () => number;
  readonly #bounds: ThrottleBounds;
  constructor(o: { now?: () => number; bounds?: ThrottleBounds } = {}) {
    this.#now = o.now ?? Date.now;
    this.#bounds = o.bounds ?? THROTTLE_BOUNDS;
  }
  /** How long until the provider may be asked again, ms; 0 now. */
  left(): number {
    return Math.max(0, this.#until - this.#now());
  }
  /** The epoch a call is sent in: read it when the call goes out, and give it back with its outcome. */
  epoch(): number {
    return this.#epoch;
  }
  /** A call sent in `sentIn` drew a throttle, with the provider's Retry-After (ms, any value). */
  throttled(sentIn: number, afterMs: unknown): void {
    if (sentIn === this.#epoch) {
      this.#epoch++;
      this.#pause = throttleWaitMs(this.#pause, afterMs, this.#bounds);
      this.#until = Math.max(this.#until, this.#now() + this.#pause);
      return;
    }
    // a call of a round already counted: only a longer Retry-After of its own moves the time on
    const after = throttleWaitMs(0, afterMs, { ...this.#bounds, firstMs: 0 });
    this.#until = Math.max(this.#until, this.#now() + after);
  }
  /** A round (every call of it) sent in `sentIn` went through: the pause is back to none. */
  answered(sentIn: number): void {
    if (sentIn === this.#epoch) this.#pause = 0;
  }
}
