// The Jito bundle-only send for a mainnet tag 3 (card helper-pool-senders, M362 (4)). A tag 3 W signed can be made to
// fail on chain after its simulation passed (W moving its own lamports first, a race), and the helper's fee payer pays
// for every failure that lands. Sent bundle-only, a failing tag 3 never lands, so it costs nothing:
//   "For cost efficiency, you can enable revert protection by setting the query parameter bundleOnly=true. With this
//   setting, the transaction is sent exclusively as a single transaction bundle." (docs.jito.wtf/lowlatencytxnsend,
//   read 2026-11-03 02:20Z; "Jito enforces a minimum tip of 1000 lamports for bundles", the same page: the kit's
//   SOLANA_JITO_TIP_MIN.) Keyless: no x-jito-auth header.
//
// Capacity (M369 (M1)): the keyless limit is "1 request per second per IP per region" (the same page), so the regions
// are one shared resource of the helper's address. Each region has one pacer, shared by every carry: one request a
// second plus JITO_PACE_MARGIN_MS, counted from when the request was handed to fetch. A carry's first send books the
// region whose next second comes first and waits for it, ahead of every rebroadcast (a rebroadcast goes only into a
// second nobody booked, and never waits); a 429, a 5xx or a transport
// failure goes on to the next region. A rebroadcast goes only to the region that took the carry's first send and never
// walks the regions. So rebroadcasts, however many carries are in flight, never keep a first send out of a region for
// more than the second already started there.
// A throttle (card helper-abuse-limits): a busy send says whether any region throttled it (a 429, rate-limit words, or
// every second booked past the queue limit), which the route answers as 429 with a wait; a 5xx alone is not one. A
// nullifier whose last send expired goes again with a queue limit of 0 (M374 (4)): only into a second free now, so
// re-sends of unlanded notes never queue ahead of fresh sends.

import { SOLANA_KEYLESS_PATH_INTERVAL_MS } from "@blindfill/kit";

/**
 * The mainnet block engines, each bundle-only: the eight regional ones of docs.jito.wtf/lowlatencytxnsend (read
 * 2026-11-03 04:36Z). Not the global mainnet.block-engine.jito.wtf: it is DNS for one of these (it resolved to
 * singapore's 202.8.11.169 and .170 on two resolvers, 2026-11-03 04:36Z), so it shares that region's limit.
 */
export const SOLANA_JITO_BLOCK_ENGINES: readonly string[] = Object.freeze(
  ["amsterdam", "dublin", "frankfurt", "london", "ny", "slc", "singapore", "tokyo"].map(
    (h) => `https://${h}.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true`,
  ),
);
/**
 * The margin over Jito's limit each region is paced at (card helper-jito-pace-margin). Jito counts refused requests too
 * ("1 request per second per IP per region", docs.jito.wtf/lowlatencytxnsend), so one that arrives early is refused
 * and the send moves to the next region. A region is marked once its request is handed to fetch, so the helper's own
 * pauses (2.3 ms measured on a CI runner, run 42627030736; 5 ms in jito.test.ts) never shorten a gap; the margin
 * covers what the helper cannot see, the request's path to the engine on a warm connection and the engine's own clock
 * [design: 50 ms, 5% of one region's capacity, ten times the pause the tests plant].
 */
export const JITO_PACE_MARGIN_MS = 50;
/** One region's pace: Jito's keyless 1 request a second plus JITO_PACE_MARGIN_MS. */
export const JITO_REGION_INTERVAL_MS = SOLANA_KEYLESS_PATH_INTERVAL_MS + JITO_PACE_MARGIN_MS;
/** What a pacer that drives rebroadcast() adds over the region's interval: the kit's (packages/kit send.ts paceArm)
 *  counts whole Date.now() ms from its tick, the gate here performance.now() from the request's hand-off, so at an
 *  equal interval a tick lands a fraction of a ms early and is refused unsent (review of 48c11e3c: 5-10% of ticks, one
 *  gap 2,100.8 ms) [design: 2 ms, two of the kit clock's whole-ms steps]. */
export const JITO_TICK_SLACK_MS = 2;
/** How long one region gets before its try counts as a transport failure [design: a block engine answers in well under 1 s]. */
export const JITO_TIMEOUT_MS = 2_000;
/** The longest a first send waits for a region's second [design: past it every region is booked, so the answer is busy
 * rather than a wait that eats the release's send margin; two region intervals, so a burst of three first sends a
 * region all go (card helper-jito-pace-margin: at 2,000 ms the margin put the third second at 2,100 ms, and a burst of
 * 24 answered 8 busy)]. */
export const JITO_QUEUE_MAX_MS = 2 * JITO_REGION_INTERVAL_MS;
const ANSWER_MAX = 16_384;

/** One whole first send: accepted by a region, every region busy or refusing, or every region failing on transport. */
export type JitoSend = { kind: "ok"; region: string } | { kind: "busy"; detail: string; throttled: boolean } | { kind: "refused"; detail: string } | { kind: "transport"; detail: string };
/** One rebroadcast: sent and accepted, or not sent (its region's second is taken), or the region's answer; `throttled`
 * when a busy region said so (a 429 or rate-limit words, not a 5xx). */
export type JitoTry = { kind: "ok" | "busy" | "transport" | "refused"; detail: string; throttled?: boolean };
export type JitoSender = {
  /** Each region's pace, ms between two requests to it (JITO_REGION_INTERVAL_MS unless given). */
  readonly intervalMs: number;
  /** A carry's first send; `queueMaxMs` (default the sender's) is the longest it waits for a region's second. */
  send(base64Tx: string, signature: string, queueMaxMs?: number): Promise<JitoSend>;
  /** A rebroadcast to `region` (the one that took the first send) only, only in a second nobody booked. */
  rebroadcast(region: string, base64Tx: string, signature: string): Promise<JitoTry>;
};
export type JitoFetch = (url: string, init: RequestInit) => Promise<Response>;

async function bounded(r: Response): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > ANSWER_MAX) {
      void reader.cancel().catch(() => {});
      throw new Error("answer too large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export function jitoSender(opts: { regions?: readonly string[]; fetch?: JitoFetch; timeoutMs?: number; intervalMs?: number; queueMaxMs?: number } = {}): JitoSender {
  const regions = opts.regions ?? SOLANA_JITO_BLOCK_ENGINES;
  if (regions.length === 0) throw new Error("no block engine");
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? JITO_TIMEOUT_MS;
  const interval = opts.intervalMs ?? JITO_REGION_INTERVAL_MS;
  const queueMax = opts.queueMaxMs ?? JITO_QUEUE_MAX_MS;
  const clock = () => performance.now(); // monotonic: a wall clock set back never books a second twice
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Per region: when its next second starts (no request before it); a first send books it ahead. */
  const free = regions.map(() => -Infinity);
  /** Per region: when its last request actually went (M374 (2)): a timer that fires late never brings two inside one
   * interval, as two sends booked a second apart would be after an event loop that stalled past both. */
  const sent = regions.map(() => -Infinity);
  /** Marks region i's request as gone at `now`: called in the same turn, right after the request is handed to fetch,
   * so no pause between the mark and the request can shorten the next gap (card helper-jito-pace-margin). */
  const mark = (i: number, now: number) => {
    sent[i] = now;
    free[i] = Math.max(free[i]!, now + interval);
  };

  // M369 (L1): only a thrown fetch, a timeout or an oversized answer is transport; every HTTP answer is the region's
  // word: 429, 5xx or a rate-limit error is busy (the next region), anything else not the signature is refused.
  // Region i: the request handed to fetch, then marked in the same turn (mark), then its answer read.
  async function one(i: number, b64: string, signature: string): Promise<JitoTry> {
    let r: Response;
    let text: string;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64" }] }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      };
      let going: Promise<Response>;
      try {
        going = doFetch(regions[i]!, init);
      } finally {
        mark(i, clock());
      }
      r = await going;
      text = await bounded(r);
    } catch (e) {
      return { kind: "transport", detail: String((e as Error)?.message ?? e).slice(0, 120) };
    }
    if (r.status === 429 || r.status >= 500) return { kind: "busy", detail: `HTTP ${r.status}`, ...(r.status === 429 ? { throttled: true } : {}) };
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      return { kind: "refused", detail: `HTTP ${r.status}, not JSON` };
    }
    const o = (typeof j === "object" && j !== null && !Array.isArray(j) ? j : {}) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (o.error !== undefined) {
      const msg = `${String(o.error?.code)}: ${String(o.error?.message).slice(0, 120)}`;
      // a throttle is Jito's own answer only: "429 or rate limit error indicating what you hit" (docs.jito.wtf
      // lowlatencytxnsend, Rate Limits); other words ("too many" transactions in a bundle) are a refusal
      return /rate.?limit/i.test(msg) ? { kind: "busy", detail: msg, throttled: true } : { kind: "refused", detail: msg };
    }
    if (!r.ok) return { kind: "refused", detail: `HTTP ${r.status}` };
    if (o.result !== signature) return { kind: "refused", detail: "the answer is not this transaction's signature" };
    return { kind: "ok", detail: "" };
  }

  return {
    intervalMs: interval,
    async send(b64, signature, queueMaxMs = queueMax) {
      const tried = new Set<number>();
      let transportOnly = true;
      let throttled = false;
      let last = "";
      while (tried.size < regions.length) {
        // the untried region whose next second comes first: sends spread over the regions, the least recently used
        // first (a tie, regions never used, goes in list order)
        let at = -1;
        for (let i = 0; i < regions.length; i++) if (!tried.has(i) && (at < 0 || free[i]! < free[at]!)) at = i;
        tried.add(at);
        const now = clock();
        const go = Math.max(now, free[at]!);
        if (go - now > queueMaxMs) {
          transportOnly = false;
          throttled = true;
          last = "every region's next second is booked";
          break;
        }
        free[at] = go + interval; // booked: a rebroadcast cannot take this second
        if (go > now) await sleep(go - now);
        // then what is left of the region's interval since its last actual request (a late timer), and go at once
        for (let wait = sent[at]! + interval - clock(); wait > 0; wait = sent[at]! + interval - clock()) await sleep(wait);
        const t = await one(at, b64, signature);
        if (t.kind === "ok") return { kind: "ok", region: regions[at]! };
        if (t.kind === "refused") return { kind: "refused", detail: t.detail };
        if (t.kind === "busy") transportOnly = false;
        if (t.throttled) throttled = true;
        last = t.detail;
      }
      return transportOnly ? { kind: "transport", detail: last } : { kind: "busy", detail: last, throttled };
    },
    async rebroadcast(region, b64, signature) {
      const i = regions.indexOf(region);
      if (i < 0) return { kind: "refused", detail: "not a block engine" };
      const now = clock();
      // free is never under the last actual request plus the interval (mark), so this holds both
      if (free[i]! > now) return { kind: "busy", detail: "the region's second is taken" };
      return one(i, b64, signature);
    },
  };
}
