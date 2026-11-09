// A busy helper, waited out (card withdraw-fee-busy-waits). The mainnet money run's withdraw fee ask met the helper's
// 429 rate_limited (its provider's limit, helper log 9 Nov ~04:08Z: "refused /v1/withdraw/fee provider limit 1 in 10 s")
// and the withdrawal stopped on something that clears in seconds.
//
// askWhileBusy makes one device ask of the helper and, while the answer is the helper's own busy answer, waits and asks
// again: HTTP 429 with exactly { error: { code: "rate_limited" } } or HTTP 503 with exactly { error: { code: "upstream" } }
// (the kit's HELPER_CODE_STATUS for each). The wait is the answer's Retry-After (delay-seconds or an HTTP date, RFC 9110
// 10.2.3), else 1 s doubled per ask, never over BUSY_WAIT_MAX_MS; at most BUSY_ASKS asks in all, so the waits together
// are at most (BUSY_ASKS - 1) * BUSY_WAIT_MAX_MS. The last answer, busy or not, is the caller's to read: the caller's own
// refusal names it (rate_limited, upstream). Every other answer is returned at once, unread, and never asked again: a
// refusal is never read as busy. The ask is the caller's own (`ask`), so a body goes again as the same bytes and each
// ask has its own timeout; `signal` ends a wait at once.
import { HELPER_CODE_STATUS } from "@blindfill/kit";

/** How many asks in all, the first included [design: the archival reads' ARCHIVAL_ASKS, deposit/moveout.ts]. */
export const BUSY_ASKS = 4;
/** The longest one wait, a longer Retry-After held to it [design: buy-wallets.ts RETRY_AFTER_MAX_MS, moveout.ts's
 *  ARCHIVAL_WAIT_MAX_MS]. */
export const BUSY_WAIT_MAX_MS = 10_000;
/** The first wait when the answer names none; doubled per ask. */
export const BUSY_WAIT_FIRST_MS = 1_000;
/** A busy answer is { error: { code } }: a longer body is not one. */
const BUSY_BODY_MAX = 1_024;
const BUSY_CODE: Readonly<Record<number, string>> = Object.freeze({
  [HELPER_CODE_STATUS.rate_limited]: "rate_limited",
  [HELPER_CODE_STATUS.upstream]: "upstream",
});
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** The wait before ask `ask + 1`: Retry-After's (seconds or an IMF-fixdate against `nowMs`), else BUSY_WAIT_FIRST_MS
 *  doubled per ask; 0 to BUSY_WAIT_MAX_MS. */
export function busyWaitMs(header: string | null, nowMs: number, ask: number): number {
  const h = header?.trim() ?? "";
  let ms: number;
  if (/^\d+$/.test(h)) ms = Number(h) * 1_000; // a digit string too long for a number is Infinity: the cap
  else if (IMF_FIXDATE.test(h) && Number.isFinite(Date.parse(h))) ms = Math.max(0, Date.parse(h) - nowMs);
  else ms = BUSY_WAIT_FIRST_MS * 2 ** Math.max(0, ask - 1);
  return Math.min(ms, BUSY_WAIT_MAX_MS);
}

export type BusyOpts = {
  /** Ends a wait at once with its reason. */
  signal?: AbortSignal;
  /** The wait; tests replace it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

/** Asks, and asks again after the wait while the answer is the helper's busy one, BUSY_ASKS asks at most. */
export async function askWhileBusy(ask: () => Promise<Response>, o: BusyOpts = {}): Promise<Response> {
  const sleep = o.sleep ?? sleepFor;
  const now = o.now ?? Date.now;
  for (let n = 1; ; n++) {
    const res = await ask();
    if (n >= BUSY_ASKS || !(await isBusy(res))) return res;
    const ms = busyWaitMs(res.headers.get("retry-after"), now(), n);
    await res.body?.cancel().catch(() => undefined);
    o.signal?.throwIfAborted();
    await sleep(ms, o.signal);
    o.signal?.throwIfAborted();
  }
}

/** Whether `res` is the helper's busy answer, read from a clone (capped), so any other answer reaches the caller unread. */
async function isBusy(res: Response): Promise<boolean> {
  const want = BUSY_CODE[res.status];
  if (want === undefined || res.body === null) return false;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > BUSY_BODY_MAX) return false;
  const reader = res.clone().body!.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > BUSY_BODY_MAX) return false;
      parts.push(value);
    }
  } catch {
    return false;
  } finally {
    // never awaited: a tee branch's cancel settles only once the other branch is cancelled or the source ends, so an
    // awaited one held an over-long chunked body until the ask's timeout (review of 407ba3bc, P2)
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) (bytes.set(p, at), (at += p.length));
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return false;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1) return false;
  const e = (body as { error?: unknown }).error;
  if (typeof e !== "object" || e === null || Array.isArray(e) || Object.keys(e).length !== 1) return false;
  return (e as { code?: unknown }).code === want;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, no) => {
    if (signal?.aborted) return no(signal.reason);
    const stop = () => (clearTimeout(t), no(signal!.reason));
    const t = setTimeout(() => (signal?.removeEventListener("abort", stop), ok()), ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
