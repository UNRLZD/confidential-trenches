// A helper read that rides out a helper that does not answer (card app-token-page-rides-out-a-slow-token-read). Merge
// group 44618685462 drew /token/robinhood/<cbBTC> in the error state after one token read the helper did not answer in
// its 10 s wait, never read again, while the helper answered that token in 0.6-1.1 s on every read before and after
// (19 Nov 21:55Z; 20 Nov 00:31Z on helper 208). The token read (../token/source.ts) and every chain's lists read
// (data.ts readChainLists) both go through readAgain: a read the helper gives no answer to (none in its wait, a network
// failure, a body cut off by the wait, a 5xx or 429; helper 208 answers a fast 503 past 1 s of loop lag) is read again
// after BACKOFF_MS while READY_MS from the first read has room for a read. A refusal (another status, a body that is not
// the answer asked for) ends it at once; so does READY_MS spent, or the caller's signal (the page closed, a search no
// longer wanted).

/** One helper read's own wait for its answer (the pages' TIMEOUT_MS, which the checks' MISS_MS matches). */
export const TIMEOUT_MS = 10_000;
/** How long a read keeps reading a helper that does not answer before the caller's error state. */
export const READY_MS = 20_000;
/** The waits before each read again, the last one repeated. */
export const BACKOFF_MS = [500, 1_000, 2_000, 4_000] as const;
/** No read again starts with less of READY_MS left than this: a cold token read took 2.0-2.2 s (19 Nov 21:58Z). */
export const MIN_READ_MS = 2_500;

/** The helper gave no answer to read: none in the read's wait, a network failure, or a 5xx or 429. */
export class NoAnswer extends Error {}

/** What a read waits on; each is the real one unless a test hands its own in. `signal`: the caller no longer wants the
 *  answer, so no read again starts. */
export interface ReadDeps {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeout?: (ms: number) => AbortSignal;
  signal?: AbortSignal;
}

const sleepReal = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });

const cutShort = (e: unknown): boolean => typeof e === "object" && e !== null && ((e as { name?: unknown }).name === "TimeoutError" || (e as { name?: unknown }).name === "AbortError");

/** `fetchFn(url, init)` on `signal`: a failed fetch is NoAnswer, and so is a 5xx or 429 answer. */
export async function answerOf(fetchFn: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let r: Response;
  try {
    r = await fetchFn(url, { ...init, signal });
  } catch {
    throw new NoAnswer("no answer");
  }
  if (r.status >= 500 || r.status === 429) throw new NoAnswer(`answered ${r.status}`);
  return r;
}

/** The answer's JSON: a body the read's wait cut off is NoAnswer; a body that is not JSON is a refusal (its own error). */
export async function bodyOf(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch (e) {
    throw cutShort(e) ? new NoAnswer("no answer") : e;
  }
}

/** `once` (one read, waiting on the signal it is handed), read again while it throws NoAnswer and READY_MS has room;
 *  throws its last NoAnswer once READY_MS is spent or `deps.signal` is aborted, any other error at once. */
export async function readAgain<T>(once: (signal: AbortSignal) => Promise<T>, deps: ReadDeps = {}): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepReal;
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  const end = now() + READY_MS;
  for (let n = 0; ; n++) {
    try {
      return await once(timeout(Math.min(TIMEOUT_MS, end - now())));
    } catch (e) {
      if (!(e instanceof NoAnswer)) throw e;
      const wait = BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]!;
      if (deps.signal?.aborted || end - now() - wait < MIN_READ_MS) throw e;
      await sleep(wait, deps.signal);
      if (deps.signal?.aborted) throw e;
    }
  }
}
