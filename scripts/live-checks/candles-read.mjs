// The one way a live check reads the helper's GET /v1/market/candles: as the token page reads it (card
// evm-chart-opens-without-a-vendor-call). With nothing of its own held and the GeckoTerminal budget spent (5 calls in
// 75 s for the whole server, which a live run spends too), the helper answers 429 with the wait to its next call; the
// page keeps loading and reads again at each Retry-After until one budget window is waited (apps/terminal/src/screens/
// token/candles.ts loadCandles, THROTTLE_SPAN_S, throttleWaitMs), and so does a check, through this reader. Its answer
// is then judged as before: a 429 still standing is BAD with its waits named (waitsText), a 200 with no bars for a
// listed token is BAD, any other status is BAD.
// The span is the check's, not each read's: it starts at the check's first 429 and every read of the run waits only
// until it ends, so a check adds at most one window (75 s) to its run however many tokens it reads, side by side or one
// after another; by then every call of a spent window has left it.
// A cold Base or Robinhood chart past the helper's open bound answers 200 with no bars and `filling` true (card
// token-page-data-complete-and-fast, apps/helper/src/data/evm/swaps.ts candles); the page stays loading and reads again
// FILL_WAIT_MS on, within the same span (loadCandles), and so does this reader.
// Not a check of its own; scripts/live-checks/candles-read.test.mjs holds it.
// Runs: once, no check of its own: the candles reader the checks share (candles-read.test.mjs holds it)
import { FILL_WAIT_MS, THROTTLE_SPAN_S, throttleWaitMs } from "../../apps/terminal/src/screens/token/candles.ts";

export { THROTTLE_SPAN_S };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** A read's Retry-After, from a fetch Response (Headers) or a check's record (lower-case header object). */
const retryAfterOf = (r) => (typeof r?.headers?.get === "function" ? r.headers.get("retry-after") : (r?.headers?.["retry-after"] ?? r?.retryAfter ?? null));

/** Whether a 200 is a chart still filling: no bars and `filling` true (a Response is read through a clone). */
async function filling(r) {
  let body;
  try {
    body = JSON.parse(typeof r?.clone === "function" ? await r.clone().text() : (r?.body ?? ""));
  } catch {
    return false;
  }
  return body?.filling === true && Array.isArray(body.candles) && body.candles.length === 0;
}

/** One check run's reader: `read(get)` calls `get()` (one candles read, the check's own, answering a Response or a
 *  record with `status` and its headers) and, while it answers 429, reads again at its Retry-After until THROTTLE_SPAN_S
 *  has passed since the run's first 429. The last answer is returned with `waits`, the ms waited before each read
 *  again, when there were any (a record copied with it, a Response given it). `now` and `wait` are the clock and the sleep (tests plant them). */
export function candlesReader({ now = Date.now, wait = sleep } = {}) {
  let start = null;
  return {
    async read(get) {
      let r = await get();
      const waits = [];
      for (;;) {
        const fill = r?.status === 200 && (await filling(r));
        if (r?.status !== 429 && !fill) break;
        start ??= now();
        const left = THROTTLE_SPAN_S * 1000 - (now() - start);
        const w = fill ? (left > 0 ? Math.min(FILL_WAIT_MS, left) : null) : throttleWaitMs(retryAfterOf(r), now() - start);
        if (w === null) break;
        await wait(w);
        waits.push(w);
        r = await get();
      }
      if (waits.length === 0) return r;
      // a Response is kept as one (its body unread), its waits on it
      return typeof r?.headers?.get === "function" ? Object.assign(r, { waits }) : { ...r, waits };
    },
  };
}

/** The waits a record names, for its line: "" with none, else " after 30 s of reads at each Retry-After (30, ...)". */
export function waitsText(r) {
  const w = Array.isArray(r?.waits) ? r.waits : [];
  if (w.length === 0) return "";
  return ` after ${Math.round(w.reduce((a, b) => a + b, 0) / 1000)} s of reads at each Retry-After (${w.map((x) => Math.round(x / 1000)).join(", ")} s)`;
}
