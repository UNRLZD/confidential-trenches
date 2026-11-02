// A clock for the device's send to POST /v1/bind, so a test can say "the carry answers at 15 s" with no real wait.
// While `run` runs, AbortSignal.timeout hands out signals that only this clock fires. A request made through
// `late(at, fetchFn)` is carried by fetchFn in full (the helper carries a call whether or not the device still waits),
// then every timeout set since the request before it, for less than that request's answer time, fires as a real
// timer would have, and the request fails as fetch fails on a signal aborted by its timeout. A test that needs a real
// network wait uses a real server instead (deposit-delegate.test.ts, the 19.5 s carry).
export type SendClock = {
  /** fetchFn, with the n-th request (from 0) answering at at[n] ms after it is made, 0 past the list. */
  late(at: readonly number[], fetchFn: typeof fetch): typeof fetch;
  /** Every timeout, in ms, set while `run` runs. */
  timeouts: number[];
};

export async function withSendClock<T>(run: (clock: SendClock) => Promise<T>): Promise<T> {
  const real = AbortSignal.timeout;
  let pending: { ms: number; c: AbortController }[] = [];
  const timeouts: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    const c = new AbortController();
    pending.push({ ms, c });
    timeouts.push(ms);
    return c.signal;
  };
  const late = (at: readonly number[], fetchFn: typeof fetch) => {
    let n = 0;
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const answersAt = at[n++] ?? 0;
      const set = pending;
      pending = [];
      const res = await fetchFn(url, init);
      for (const t of set) if (t.ms < answersAt) t.c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      init?.signal?.throwIfAborted();
      return res;
    }) as typeof fetch;
  };
  try {
    return await run({ late, timeouts });
  } finally {
    AbortSignal.timeout = real;
  }
}
