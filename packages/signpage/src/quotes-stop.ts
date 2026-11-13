// The page's stop for its quotes (card helper-says-why-a-vendor-refused, review P3): once the page learns it is signed
// out, deposit.quote, pool.address and the deposit sheet's reads send nothing more, a re-ask's pause included. Each host
// reads `stopped()` once as a request arrives (src/deposit-wire.ts, src/pool-deposit-address.ts); `signedOut()` aborts
// that signal and puts a fresh one in its place, so a quote asked after the next sign in goes out.
export interface QuotesStop {
  /** The signal a quote asked now ends on. */
  stopped(): AbortSignal;
  /** Ends every quote under way, and readies the next sign in's. */
  signedOut(): void;
}

export function quotesStop(): QuotesStop {
  let now = new AbortController();
  return {
    stopped: () => now.signal,
    signedOut: () => {
      now.abort(new DOMException("signed out", "AbortError"));
      now = new AbortController();
    },
  };
}
