// One pace and one hold per EVM provider for every kit read on this device (card evm-taps-meet-no-429): the quote's
// reads, its scans, the pool index's sync and the head watch all go through evmJsonRpc (quote.ts), which takes its
// turn here before each post. A quote's own gates (quote.ts gated, scanGateOf) bound what one quote sends at once;
// this bounds what the device sends a provider across every quote and reader, at the pace the provider was measured to
// take, and a throttle any reader meets holds the provider for all of them.
// The read run that asked for it (the tap check's quotes, read only from the Mac, 2026-11-15 08:05-08:22Z): every 429
// came from a provider several readers share, each pacing itself alone: rpc.mainnet.chain.robinhood.com (the scan's
// first, the index's first reader and the quote's last) and robinhood.drpc.org, and mainnet.base.org at 28 calls in a
// second (its error names 25 a second).

/** A provider's pace: `perS` units a second, at most `burst` at once; a unit is a post (one HTTP request, a batch or
 *  not) or a call (each request of a batch); `inflight`, the posts it takes at once. The helper's Pace shape, and
 *  `logs`: where the provider's one limit weighs an eth_getLogs above its other calls, the units a post that carries
 *  one takes (else as any other post). */
export type EvmPace = { readonly perS: number; readonly burst: number; readonly unit: "post" | "call"; readonly inflight?: number; readonly logs?: number };
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
 *    for both). The helper's 3.8 posts a second then 429 (2026-11-04) were getLogs. 8 calls a second, 24 at once; a
 *    getLogs post takes 8, so getLogs alone go at 1 a second, as they did, and at most 3 at once. One bucket of 1 post a
 *    second, 2 at once, for every post held the recorded USDG quote's 7 eth_call posts it alone settles (publicnode,
 *    blxrbdn and globalstake past their state at the quote's block, dRPC the other answer) 1 s apart behind the scan's
 *    getLogs, 13.4 s of the test clock past its 8 s bound, where 5.6 s unpaced (test/evm-quote-calls.test.ts); and
 *    each real USDG tap's 31 to 59 posts to it, so the taps ran 40 to 67 s and ended stale_quote or rpc_error (card
 *    robinhood-quote-inside-the-bound-under-the-pace, 10:50-10:56Z).
 *  - robinhood.daybreak-rpc.network: 7 posts a second, 3 at once (refuses past about 4 at once).
 *  - robinhood.api.pocket.network: x-ratelimit-limit 1200 a minute; 15 calls a second, 200 at once.
 *  - base.gateway.tenderly.co: 2 calls a second; rpc.sentio.xyz/base: 4 a second, 5 at once.
 *  - mainnet.base.org: 20 calls a second none refused (2026-11-05), its own error "25/second request limit reached",
 *    and 429 at 28 calls in one second (tap runs 2026-11-15 08:13Z and 08:20Z). 12 calls a second, 12 at once: no
 *    second holds more than 24 (the helper's 20 at once and 10 a second holds 30).
 *  Not paced: robinhood.drpc.org, whose hold is its guard. 33 calls a second for 8 s none refused (2026-11-04); posts
 *  of 3 eth_call at 8 a second for 5 s and 6 at once, none refused (sweep from the Mac, 2026-11-15 08:47Z). In the tap
 *  runs (08:05-08:22Z) its 429s ("You reached Public endpoint rate limit", code 15) came at 1 to 5 posts in flight and
 *  3 to 22 calls a second while 50 calls a second passed: no rate of ours sets them, and they come in a run once one
 *  comes (20 in the 30 s after the first with no hold; 1 in a whole run with it, 09:03Z). Paced at 8 posts a second
 *  it held the recorded USDG quote (test/evm-quote-calls.test.ts) to 15.2 s of its clock, past its 8 s bound.
 *  Not paced: base-rpc.publicnode.com. The helper's 3 a second was its single 1,000-block getLogs (2026-11-05); the
 *  quote's and the index's reads from the Mac took 315 calls in 10 s with no 429 (08:05Z). Read again before it is set. */
export const EVM_PACE: Readonly<Record<string, EvmPace>> = Object.freeze({
  "https://rpc.mainnet.chain.robinhood.com": Object.freeze({ perS: 8, burst: 24, unit: "call", logs: 8 }),
  "https://robinhood.daybreak-rpc.network": Object.freeze({ perS: 7, burst: 7, unit: "post", inflight: 3 }),
  "https://robinhood.api.pocket.network": Object.freeze({ perS: 15, burst: 200, unit: "call" }),
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
type Lane = { tokens: number; at: number; out: number; queue: Ask[]; heldUntil: number; timer: ReturnType<typeof setTimeout> | null };
const LANES = new Map<string, Lane>();
const laneOf = (key: string): Lane => {
  let l = LANES.get(key);
  if (l === undefined) LANES.set(key, (l = { tokens: EVM_PACE[key]?.burst ?? 0, at: performance.now(), out: 0, queue: [], heldUntil: 0, timer: null }));
  return l;
};

/** For the tests: forgets every provider's pace and hold (not in the kit's index). */
export const evmPaceReset = (): void => {
  for (const l of LANES.values()) if (l.timer !== null) clearTimeout(l.timer);
  LANES.clear();
};

/** Holds `url`'s provider for every reader until `ms` from now (a later hold is never shortened). */
export function evmProviderHold(url: string, ms = EVM_PROVIDER_HOLD_MS): void {
  const l = laneOf(evmProviderKey(url));
  l.heldUntil = Math.max(l.heldUntil, performance.now() + ms);
}
/** How long `url`'s provider is still held, in ms (0: not held). */
export const evmProviderHeldMs = (url: string, now: number = performance.now()): number => Math.max(0, (LANES.get(evmProviderKey(url))?.heldUntil ?? 0) - now);
/** Whether `url`'s provider is held now. */
export const evmProviderHeld = (url: string, now: number = performance.now()): boolean => evmProviderHeldMs(url, now) > 0;

/** Sends every waiting post its turn has come for, in the order they asked, and sets the wake for the next. */
function pump(l: Lane, p: EvmPace): void {
  const now = performance.now();
  l.tokens = Math.min(p.burst, l.tokens + ((now - l.at) / 1000) * p.perS);
  l.at = now;
  for (;;) {
    const a = l.queue[0];
    if (a === undefined || (p.inflight !== undefined && l.out >= p.inflight) || l.tokens < a.need) break;
    l.queue.shift();
    l.tokens -= a.need;
    l.out++;
    a.go();
  }
  if (l.timer !== null) clearTimeout(l.timer);
  l.timer = null;
  const a = l.queue[0];
  // no place free: the next post given back pumps again; else the time its units take to come in
  if (a === undefined || (p.inflight !== undefined && l.out >= p.inflight)) return;
  // a post waiting its turn is work under way: its wake holds a Node process open as its fetch would (never unref'd)
  l.timer = setTimeout(() => ((l.timer = null), pump(l, p)), Math.max(1, Math.ceil(((a.need - l.tokens) / p.perS) * 1000)));
}

/** Whether a post of `calls` to `url` would leave now, with no wait for its turn (an unpaced provider: always). */
export function evmPaceReady(url: string, calls: EvmPaceCalls, now: number = performance.now()): boolean {
  const key = evmProviderKey(url);
  const p = EVM_PACE[key];
  if (p === undefined) return true;
  const l = LANES.get(key);
  if (l === undefined) return true;
  const tokens = Math.min(p.burst, l.tokens + ((now - l.at) / 1000) * p.perS);
  return l.queue.length === 0 && (p.inflight === undefined || l.out < p.inflight) && tokens >= needOf(p, calls);
}

/** Waits for `url`'s turn for a post of `calls` at its pace (an unpaced provider: at once), first come first
 *  served; the answer gives the post's place back once it settles. A post of more units than the burst waits for a full
 *  bucket and spends it. `signal` ends the wait with its reason. */
export function evmPaceTake(url: string, calls: EvmPaceCalls, signal?: AbortSignal): (() => void) | Promise<() => void> {
  const key = evmProviderKey(url);
  const p = EVM_PACE[key];
  // an unpaced provider is sent at once, in the same turn (no wait at all)
  if (p === undefined) return NONE;
  return paced(key, p, calls, signal);
}
const NONE = (): void => {};
async function paced(key: string, p: EvmPace, calls: EvmPaceCalls, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  const l = laneOf(key);
  const need = needOf(p, calls);
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      const i = l.queue.indexOf(ask);
      if (i >= 0) l.queue.splice(i, 1);
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
    l.queue.push(ask);
    pump(l, p);
  });
  let given = false;
  return () => {
    if (given) return;
    given = true;
    l.out--;
    pump(l, p);
  };
}
