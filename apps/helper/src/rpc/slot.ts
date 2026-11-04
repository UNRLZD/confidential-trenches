// A Solana provider slot (card helper-solana-failover): SOLANA_RPC_URL, SOLANA_TRADES_RPC_URL, SOLANA_HOLDERS_RPC_URL and
// SOLANA_STREAM_WS_URL each name a keyed provider, and each falls back to the public endpoint when its provider stops
// serving us: a suspended or revoked key (401, 403), a key out of credits, a 429 that comes again past the reset it
// named, or no answer for SLOT_SILENT_MS. While it is fallen back the key is tried again every SLOT_RETRY_MS: one
// request (or, for the stream, one probe connection) goes to it, and an answer moves the slot back. Each switch is one
// log line naming the slot and why, never the URL or the key. A slot whose variable is unset is the public endpoint
// from the start ("public"). The callers carry the request itself to the public endpoint at once when the keyed one
// fails it, so a slot's switch is never an error to the caller (rpc.ts, data/solana/trades.ts).

/** How long a fallen-back slot waits before it tries its key again. */
export const SLOT_RETRY_MS = 300_000;
/** A keyed provider that has answered nothing for this long (timeouts, refused connections, 5xx) is fallen back. */
export const SLOT_SILENT_MS = 30_000;
export type SlotName = "rpc" | "trades" | "holders" | "stream";
export type SlotState = "keyed" | "fallback" | "public";
/**
 * A JSON-RPC error or body that says the key's plan is spent: a provider's credits or usage cap, not a per-second
 * throttle. [design: the words providers use for a spent plan (credits, max usage, usage limit, quota); Helius's
 * error-codes page names only 401, 429, 500, 503 and 504 (helius.dev/docs/faqs/error-codes.md, read 2026-11-04
 * 10:06Z), so a spent plan answered as a plain 429 is caught as a 429 past its reset instead.]
 */
export const CREDITS = /\bcredits?\b|max(imum)? usage|usage limit|quota/i;

export type Slot = {
  readonly name: SlotName;
  /** Whether this request goes to the key: keyed and up, or fallen back with the retry due. */
  useKeyed(): boolean;
  state(): SlotState;
  /** The key answered. */
  ok(): void;
  /** The key refused us for good (401, 403, credits, a 429 past its reset): fall back now. */
  fail(why: string): void;
  /** The key gave no answer to a request sent at `since` (a timeout, a refused connection, a 5xx): fall back once it has
   *  answered nothing for SLOT_SILENT_MS, or at once while a retry is being tried. */
  unanswered(since?: number): void;
  /** The key answered 429 with a reset `waitS` away: true when it is a 429 past the last reset (the slot falls back). */
  throttled(waitS: number): boolean;
};

export function createSlot(name: SlotName, keyed: boolean, deps: { now?: () => number; log?: (line: string) => void } = {}): Slot {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(`helper: ${line}`));
  let down = false;
  let retryAt = 0;
  let silentSince: number | null = null;
  let resetAt: number | null = null;
  const fail = (why: string) => {
    if (!keyed) return;
    retryAt = now() + SLOT_RETRY_MS;
    silentSince = null;
    resetAt = null;
    if (down) return;
    down = true;
    log(`solana ${name} fallback (${why}), the key tried again in ${SLOT_RETRY_MS / 1000} s`);
  };
  return {
    name,
    useKeyed: () => keyed && (!down || now() >= retryAt),
    state: () => (!keyed ? "public" : down ? "fallback" : "keyed"),
    ok() {
      silentSince = null;
      resetAt = null;
      if (!down) return;
      down = false;
      log(`solana ${name} keyed (the key answered again)`);
    },
    fail,
    unanswered(since = now()) {
      if (!keyed) return;
      if (down) return fail("the retry got no answer");
      silentSince ??= since;
      if (now() - silentSince >= SLOT_SILENT_MS) fail(`no answer for ${SLOT_SILENT_MS / 1000} s`);
    },
    throttled(waitS) {
      if (!keyed) return false;
      if (down || (resetAt !== null && now() >= resetAt)) {
        fail("429 past its reset");
        return true;
      }
      resetAt = now() + waitS * 1000;
      return false;
    },
  };
}
