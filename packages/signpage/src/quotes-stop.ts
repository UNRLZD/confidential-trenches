// The page's stop for its quotes (card helper-says-why-a-vendor-refused, review P3, delta review P2-2): once Sign out is
// tapped, or the page learns another tab signed out, deposit.quote, pool.address and the deposit sheet's reads send
// nothing more, a re-ask's pause included, and nothing asked after it either, until the page is signed in again. Each
// host reads `stopped()` once as a request arrives (src/deposit-wire.ts, src/pool-deposit-address.ts). `signedOut()`
// aborts that signal and leaves it aborted: the store's sign out waits for the seed lock while the records stay
// readable, so a request queued behind the tap must find the stop already pulled. `signedIn()` (a sign in landed, or
// the sign out was refused) puts a fresh one in its place.
export interface QuotesStop {
  /** The signal a quote asked now ends on. */
  stopped(): AbortSignal;
  /** Ends every quote under way and every one asked until signedIn(). */
  signedOut(): void;
  /** A fresh signal for the quotes asked from now, once the page is signed in again. */
  signedIn(): void;
}

export function quotesStop(): QuotesStop {
  let now = new AbortController();
  return {
    stopped: () => now.signal,
    signedOut: () => now.abort(new DOMException("signed out", "AbortError")),
    signedIn: () => {
      if (now.signal.aborted) now = new AbortController();
    },
  };
}
