// One pace and one hold per EVM provider for every kit read on this device (card evm-taps-meet-no-429): the quote's
// reads, its scans, the pool index's sync and the head watch all go through evmJsonRpc (quote.ts), which takes its
// turn here before each post. A quote's own gates (quote.ts gated, scanGateOf) bound what one quote sends at once;
// this bounds what the device sends a provider across every quote and reader, at the pace the provider was measured to
// take, and a throttle any reader meets holds the provider for all of them.
// The read run that asked for it (the tap check's quotes, read only from the Mac, 2026-11-15 08:05-08:22Z): every 429
// came from a provider several readers share, each pacing itself alone: rpc.mainnet.chain.robinhood.com (the scan's
// first, the index's first reader and the quote's last) and robinhood.drpc.org, and mainnet.base.org at 28 calls in a
// second (its error names 25 a second).
// A trade's posts first (card evm-warm-tap-ends-inside-two-seconds): a post is a trade's, or a background read's (`later`:
// the page's pool.buy.dry quote, its index sync, its passes), and one lane serves both. A background post never leaves
// while a trade's waits its turn, and leaves the provider's `keep` units in its bucket, so a tap asked while the page's
// own reads run is never queued behind them and finds its turns there. The read that asked for it: SIGN_HOST's walk of a
// fresh account at release 159 (2026-11-16 00:20Z) drew 41 answers of 429 in 235 posts from base-rpc.publicnode.com, all
// of them the page dry's cold scan of a coin no list held (119 posts of two 10,000-block eth_getLogs, 20 at once), the
// provider unpaced on the device.

/** A provider's pace: `perS` units a second, at most `burst` at once; a unit is a post (one HTTP request, a batch or
 *  not) or a call (each request of a batch); `inflight`, the posts it takes at once. The helper's Pace shape, and
 *  `logs`: where the provider's one limit weighs an eth_getLogs above its other calls, the units a post that carries
 *  one takes (else as any other post); `keep`: the units a background post leaves in the bucket for a trade's (below). */
export type EvmPace = { readonly perS: number; readonly burst: number; readonly unit: "post" | "call"; readonly inflight?: number; readonly logs?: number; readonly keep?: number };
/** A post's calls, as the pace reads them: their count, and whether one is an eth_getLogs. */
export type EvmPaceCalls = readonly { readonly method: string }[];
/** The units a post of `calls` takes of `p`'s bucket, never more than its burst. */
const needOf = (p: EvmPace, calls: EvmPaceCalls): number =>
  Math.min(p.burst, p.logs !== undefined && calls.some((c) => c.method === "eth_getLogs") ? p.logs : p.unit === "post" ? 1 : Math.max(1, calls.length));

/** Each paced provider, set under the point where it refuses, from the helper's measured pace (apps/helper/src/limits/
 *  limits.ts PROVIDER_PACE, every read cited there) and this card's reads:
 *  - rpc.mainnet.chain.robinhood.com: one limit in calls, which weighs a getLogs above an eth_call (read-only sweeps
 *    from the Mac, 2026-11-15 10:57-11:07Z, the recorded USDG quote's own eth_calls at "latest"): 10 calls a second
 *    for 20 s none refused, twice, as posts of 1 and of 3; 19 calls a second as posts of 1 for 12 s, none refused;
 *    posts of 3 at 18 to 27 calls a second refused from the 70th to 90th call (2.6 to 4 s in); posts of 3 at 18 a
 *    second beside one 2,000-block getLogs post a second refused from the 47th call, getLogs posts as well (one limit
 *    for both). The helper's 3.8 posts a second then 429 (2026-11-04) were getLogs. At 8 calls a second, 24 at once, real
 *    taps met it 429 4 times in 24 (a warm getLogs, 3 eth_call of a USDG tap's 191 calls, 11:13-11:17Z), at 1 post a
 *    second none in 48: 6 calls a second, 18 at once; a getLogs post takes 8, so getLogs alone go 3 in 4 s, under
 *    the 1 a second they went, 2 at once. One bucket of 1 post a
 *    second, 2 at once, for every post held the recorded USDG quote's 7 eth_call posts it alone settles (publicnode,
 *    blxrbdn and globalstake past their state at the quote's block, dRPC the other answer) 1 s apart behind the scan's
 *    getLogs, 13.4 s of the test clock past its 8 s bound, where 5.6 s unpaced (test/evm-quote-calls.test.ts); and
 *    each real USDG tap's 31 to 59 posts to it, so the taps ran 40 to 67 s and ended stale_quote or rpc_error (card
 *    robinhood-quote-inside-the-bound-under-the-pace, 10:50-10:56Z).
 *  - robinhood.daybreak-rpc.network: 7 posts a second, 3 at once (refuses past about 4 at once).
 *  - robinhood.api.pocket.network and base.api.pocket.network: each answer's own x-ratelimit-limit 5, its remaining
 *    falling by a batch's calls and its reset one to two seconds on (read 2026-11-19 14:2xZ from the Mac, 7 posts of 2
 *    calls 0.7 s apart: remaining 3, 3, 1, 3, 3, 3, 3), so 5 calls a second, 5 at once; the 1,200 a minute and 15 a
 *    second read before (2026-11-14) are gone. A count per window: a bucket of `burst` filled at `perS` sends at most
 *    burst + perS in any second, so 3 at once and 2 a second (5). Unpaced, Base's met the deployed app's live checks
 *    429 on eth_call (run 44482038380, 2026-11-19 07:46Z: a cold tap's 6 of 12, its multihop quote's 7). Each answer's
 *    remaining is the lane's own too (evmPaceAdvised).
 *  - base.gateway.tenderly.co: 2 calls a second; rpc.sentio.xyz/base: 4 a second, 5 at once.
 *  - mainnet.base.org: 20 calls a second none refused (2026-11-05), its own error "25/second request limit reached",
 *    and 429 at 28 calls in one second (tap runs 2026-11-15 08:13Z and 08:20Z). 12 calls a second, 12 at once: no
 *    second holds more than 24 (the helper's 20 at once and 10 a second holds 30).
 *  - robinhood.rpc.blxrbdn.com (bloXroute, card robinhood-taps-meet-no-429): a reduced limit for reads, named in its
 *    refusal, HTTP 429 or a 200 whose calls' error is -32005 "Rate limited. Read-only traffic (eth_call,
 *    eth_getBlockReceipts, etc.) has a reduced rate limit on this endpoint" (no rate header). Read only from the Mac,
 *    2026-11-20 01:53-01:58Z, posts of a real cbBTC tap's own 3 eth_call: 4, 8, 12 and 16 calls a second for 10 s none
 *    refused; 24 a second refused from the 30th call, 20 from the 57th, 18 (posts of 1) from the 153rd: one bucket of
 *    about 9 at once and 17 a second back. Unpaced, it took the reads a dRPC hold moved and met META's taps 429 31
 *    times in 93 posts (live sign run 44441959756, 19 Nov) and twice in 18 (run 44651083107, 20 Nov 01:06Z). 15 calls a
 *    second, 6 at once: inside its 9 and 17 at every instant (test/evm-pace-provider-limits.test.ts); the recorded USDG
 *    quote's 188 posts in 7.07 s of the clock, as unpaced. Base's base.rpc.blxrbdn.com is not under the same limit: 16,
 *    20 and 24 calls a second of the same posts for 10 s none refused (01:59Z), and no live run read a 429 from it.
 *  Not paced: robinhood.drpc.org, whose hold is its guard. 33 calls a second for 8 s none refused (2026-11-04); posts
 *  of 3 eth_call at 8 a second for 5 s and 6 at once, none refused (sweep from the Mac, 2026-11-15 08:47Z). In the tap
 *  runs (08:05-08:22Z) its 429s ("You reached Public endpoint rate limit", code 15) came at 1 to 5 posts in flight and
 *  3 to 22 calls a second while 50 calls a second passed: no rate of ours sets them, and they come in a run once one
 *  comes (20 in the 30 s after the first with no hold; 1 in a whole run with it, 09:03Z). Paced at 8 posts a second
 *  it held the recorded USDG quote (test/evm-quote-calls.test.ts) to 15.2 s of its clock, past its 8 s bound. Read
 *  again 2026-11-20 01:51-02:04Z (Robinhood taps read only from the Mac): unpaced, 3 answers of 429 in 269 posts, at
 *  43 to 49 calls in the second before and 560 in the minute; paced at 12 calls a second, 12 at once (its page's "25
 *  RPS"), 13 in 376 posts, at 12 to 14 in the second and 655 in the minute, the warm taps of the heaviest coin 3.0 to
 *  7.7 s, and the recorded quote 15.5 s (at 20 a second, 4 at once, 12.0 s). Its limit is about 600 calls a minute
 *  that no pace of ours under the bound holds, so it is not paced here (card robinhood-taps-meet-no-429's report).
 *  - base-rpc.publicnode.com: one limit that weighs an eth_getLogs far above an eth_call. Read-only from the Mac,
 *    2026-11-16 00:57-01:04Z, posts of the scan's own shape (two 10,000-block getLogs of the PoolManager's Initialize
 *    logs and the block): 20 at once, 137 answered in 5 s, then 429 (-32005 "Rate limit exceeded"); 3 and 6 a second
 *    for 30 s none refused; 10 a second refused from the 156th post, 15.5 s in (113 of 300). As a bucket: about 128
 *    such posts, about 1.7 a second back (the helper's 3 single getLogs a second none refused, 5 refused, 2026-11-05).
 *    The same burst 16 s and then 34 s after one that met 429 answered 36 and 74 (01:16Z): about 2 a second back.
 *    eth_call alone: 36 calls a second for 25 s, 900 calls, none refused. So 36 calls a second and a getLogs post at
 *    20 (1.8 a second), 2,500 at once (125 scan posts: a cold scan of 1M blocks is 100); a background read leaves 120
 *    (3 s of calls: a tap's first rounds). Unpaced, SIGN_HOST's walk drew its 41 answers of 429 (above). */
export const EVM_PACE: Readonly<Record<string, EvmPace>> = Object.freeze({
  "https://base-rpc.publicnode.com": Object.freeze({ perS: 36, burst: 2_500, unit: "call", logs: 20, keep: 120 }),
  "https://rpc.mainnet.chain.robinhood.com": Object.freeze({ perS: 6, burst: 18, unit: "call", logs: 8 }),
  "https://robinhood.rpc.blxrbdn.com": Object.freeze({ perS: 15, burst: 6, unit: "call" }),
  "https://robinhood.daybreak-rpc.network": Object.freeze({ perS: 7, burst: 7, unit: "post", inflight: 3 }),
  "https://robinhood.api.pocket.network": Object.freeze({ perS: 2, burst: 3, unit: "call" }),
  "https://base.api.pocket.network": Object.freeze({ perS: 2, burst: 3, unit: "call" }),
  "https://base.gateway.tenderly.co": Object.freeze({ perS: 2, burst: 3, unit: "call" }),
  "https://rpc.sentio.xyz/base": Object.freeze({ perS: 4, burst: 5, unit: "call" }),
  "https://mainnet.base.org": Object.freeze({ perS: 12, burst: 12, unit: "call" }),
});

/** How long a throttle (an HTTP 429, a call's error naming a rate limit) or a refused connection holds a provider for
 *  every reader: quote.ts EVM_HOLD_MS, the quote providers' hold. */
export const EVM_PROVIDER_HOLD_MS = 30_000;

/** A provider's key: its URL's origin and path, no trailing slash, no query (the helper's PROVIDER_PACE keys). */
export const evmProviderKey = (url: string): string => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
};

type Ask = { readonly need: number; readonly go: () => void };
// `queue` the trades' posts, `later` the background reads'; each first come first served
/** `owed`: the units of the posts out, not yet answered: spent from `tokens` as each is answered. */
type Lane = { tokens: number; at: number; out: number; owed: number; queue: Ask[]; later: Ask[]; heldUntil: number; timer: ReturnType<typeof setTimeout> | null };
const LANES = new Map<string, Lane>();
const laneOf = (key: string): Lane => {
  let l = LANES.get(key);
  if (l === undefined) LANES.set(key, (l = { tokens: EVM_PACE[key]?.burst ?? 0, at: performance.now(), out: 0, owed: 0, queue: [], later: [], heldUntil: 0, timer: null }));
  return l;
};
/** The units in the bucket a background post of `need` waits for: its own and the provider's `keep`, never past the
 *  burst (a post of the whole burst waits for a full bucket, as a trade's does). */
const laterNeed = (p: EvmPace, need: number): number => Math.min(p.burst, need + (p.keep ?? 0));

/** Each provider's most calls a batch, where it refused a batch for its size (card evm-batch-fits-each-reader): kept
 *  for the page's life, so every later batch to it, any reader's, leaves at most this many calls a post. */
const MOST = new Map<string, number>();

/** For the tests: forgets every provider's pace, hold and most calls a batch (not in the kit's index). */
export const evmPaceReset = (): void => {
  for (const l of LANES.values()) if (l.timer !== null) clearTimeout(l.timer);
  LANES.clear();
  MOST.clear();
};

/** The most calls `url`'s provider takes in one batch: Infinity until it refused one for its size. */
export const evmBatchMost = (url: string): number => MOST.get(evmProviderKey(url)) ?? Infinity;
/** `url`'s provider refused a batch of `n` calls (n > 1) for its size: from now its batches are at most half of n, or
 *  the maximum its refusal named (`said`) where that is smaller and at least 1, never more than an earlier refusal set.
 *  A refusal's number is the provider's word, so it may only lower a batch: a lie costs only its own posts. */
export function evmBatchRefused(url: string, n: number, said: number | null): void {
  const k = evmProviderKey(url);
  MOST.set(k, Math.min(MOST.get(k) ?? Infinity, evmBatchFit(n, said)));
}
/** The most calls a batch after a refusal of `n` calls for its size: half of n, or the maximum the refusal named
 *  (`said`) where that is smaller and at least 1. The helper's /v1/rpc keeps its upstreams' by this one rule (the kit's
 *  entry; card helper-rpc-batch-learns-reader-size). */
export function evmBatchFit(n: number, said: number | null): number {
  const half = Math.max(1, Math.floor(n / 2));
  return said !== null && Number.isSafeInteger(said) && said >= 1 ? Math.min(half, said) : half;
}

/** A provider's own count of what it has left for this address (an answer's x-ratelimit-remaining, or the IETF draft's
 *  RateLimit-Remaining), in its pace's units: where it is under what the lane holds, the lane holds that much (card
 *  evm-warm-quote-inside-the-kpi-with-room). The provider counts every post of this address, another page's or a
 *  reload's too, which the lane, made full when the page loads, cannot see: so a lane is never fuller than the provider
 *  says it is. Posts sent after the answer are counted twice at most, a turn later, never a 429. A count is only ever
 *  taken lower, and the lane fills again at its pace, so a provider that lies costs only its own turns. */
export function evmPaceAdvised(url: string, remaining: number, now: number = performance.now()): void {
  const key = evmProviderKey(url);
  const p = EVM_PACE[key];
  if (p === undefined || !Number.isFinite(remaining) || remaining < 0) return;
  const l = laneOf(key);
  l.tokens = Math.min(p.burst, l.tokens + ((now - l.at) / 1000) * p.perS);
  l.at = now;
  if (remaining < l.tokens) l.tokens = remaining;
}

/** Holds `url`'s provider for every reader until `ms` from now (a later hold is never shortened). */
export function evmProviderHold(url: string, ms = EVM_PROVIDER_HOLD_MS): void {
  const l = laneOf(evmProviderKey(url));
  l.heldUntil = Math.max(l.heldUntil, performance.now() + ms);
}
/** How long `url`'s provider is still held, in ms (0: not held). */
export const evmProviderHeldMs = (url: string, now: number = performance.now()): number => Math.max(0, (LANES.get(evmProviderKey(url))?.heldUntil ?? 0) - now);
/** Whether `url`'s provider is held now. */
export const evmProviderHeld = (url: string, now: number = performance.now()): boolean => evmProviderHeldMs(url, now) > 0;

/** Sends every waiting post its turn has come for, the trades' first, each kind in the order they asked, and sets the
 *  wake for the next. */
function pump(l: Lane, p: EvmPace): void {
  const now = performance.now();
  l.tokens = Math.min(p.burst, l.tokens + ((now - l.at) / 1000) * p.perS);
  l.at = now;
  const room = () => p.inflight === undefined || l.out < p.inflight;
  for (;;) {
    const a = l.queue[0];
    // a trade's post waiting its turn: nothing leaves before it
    const b = a === undefined ? l.later[0] : undefined;
    const free = l.tokens - l.owed;
    if (!room() || (a !== undefined && free < a.need) || (a === undefined && (b === undefined || free < laterNeed(p, b.need)))) break;
    const go = a !== undefined ? l.queue.shift()! : l.later.shift()!;
    l.owed += go.need;
    l.out++;
    go.go();
  }
  if (l.timer !== null) clearTimeout(l.timer);
  l.timer = null;
  const a = l.queue[0];
  const want = a !== undefined ? a.need : l.later[0] !== undefined ? laterNeed(p, l.later[0].need) : undefined;
  // no place free: the next post given back pumps again; else the time its units take to come in
  if (want === undefined || !room()) return;
  // a post waiting its turn is work under way: its wake holds a Node process open as its fetch would (never unref'd)
  l.timer = setTimeout(() => ((l.timer = null), pump(l, p)), Math.max(1, Math.ceil(((want - (l.tokens - l.owed)) / p.perS) * 1000)));
}

/** Whether a post of `calls` to `url` would leave now, with no wait for its turn (an unpaced provider: always); `later`:
 *  as a background read's. */
export function evmPaceReady(url: string, calls: EvmPaceCalls, now: number = performance.now(), later = false): boolean {
  const key = evmProviderKey(url);
  const p = EVM_PACE[key];
  if (p === undefined) return true;
  const l = LANES.get(key);
  if (l === undefined) return true;
  const tokens = Math.min(p.burst, l.tokens + ((now - l.at) / 1000) * p.perS);
  const need = needOf(p, calls);
  return l.queue.length === 0 && (!later || l.later.length === 0) && (p.inflight === undefined || l.out < p.inflight) && tokens - l.owed >= (later ? laterNeed(p, need) : need);
}

/** How long a trade's post of `calls` to `url` would wait for its turn, in ms, if sent now after the trade's posts
 *  already waiting and the posts `before` it that its caller sends first (0: an unpaced provider, or one with its units
 *  free); a provider's in-flight cap (`inflight`) is not counted. The quote's read round asks each batch's two
 *  providers by it (quote.ts pairOrders, card evm-warm-quote-inside-the-kpi-with-room). */
export function evmPaceWaitMs(url: string, calls: EvmPaceCalls, before: readonly EvmPaceCalls[] = [], now: number = performance.now()): number {
  const key = evmProviderKey(url);
  const p = EVM_PACE[key];
  if (p === undefined) return 0;
  const l = LANES.get(key);
  const tokens = l === undefined ? p.burst : Math.min(p.burst, l.tokens + ((now - l.at) / 1000) * p.perS) - l.owed;
  const queued = (l?.queue ?? []).reduce((n, a) => n + a.need, 0);
  const short = queued + before.reduce((n, c) => n + needOf(p, c), 0) + needOf(p, calls) - tokens;
  return short <= 0 ? 0 : (short / p.perS) * 1000;
}

/** Waits for `url`'s turn for a post of `calls` at its pace (an unpaced provider: at once), first come first
 *  served among its kind, a trade's before any background read's (`later`); the answer gives the post's place back
 *  once it settles. A post of more units than the burst waits for a full bucket and spends it. `signal` ends the wait
 *  with its reason. */
export function evmPaceTake(url: string, calls: EvmPaceCalls, signal?: AbortSignal, later = false): (() => void) | Promise<() => void> {
  const key = evmProviderKey(url);
  const p = EVM_PACE[key];
  // an unpaced provider is sent at once, in the same turn (no wait at all)
  if (p === undefined) return NONE;
  return paced(key, p, calls, signal, later);
}
const NONE = (): void => {};
async function paced(key: string, p: EvmPace, calls: EvmPaceCalls, signal: AbortSignal | undefined, later: boolean): Promise<() => void> {
  signal?.throwIfAborted();
  const l = laneOf(key);
  const need = needOf(p, calls);
  const queue = later ? l.later : l.queue;
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      const i = queue.indexOf(ask);
      if (i >= 0) queue.splice(i, 1);
      reject(signal!.reason);
      pump(l, p);
    };
    const ask: Ask = {
      need,
      go: () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      },
    };
    signal?.addEventListener("abort", stop, { once: true });
    queue.push(ask);
    pump(l, p);
  });
  let given = false;
  return () => {
    if (given) return;
    given = true;
    l.out--;
    // the post's units are spent as it is answered, the latest it can have reached the provider: until then they are
    // held, so no post leaves on units the provider may not have counted yet (card evm-warm-tap-ends-inside-two-seconds,
    // round F: posts held on a connection arrive together, test/evm-pace-provider-limits.test.ts)
    const now = performance.now();
    l.tokens = Math.min(p.burst, l.tokens + ((now - l.at) / 1000) * p.perS) - need;
    l.at = now;
    l.owed -= need;
    pump(l, p);
  };
}
