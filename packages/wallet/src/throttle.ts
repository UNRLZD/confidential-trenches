// A provider that throttles is not asked again at once (card signpage-throttled-read-is-not-asked-again-at-once). The
// app's devnet run (card app-a2-e2e run 4, 10 Nov 22:06Z) met 638 answers of 429 to getTokenAccountsByOwner in 300 s,
// about 2 a second: the holdings reads waited a flat 1 s after each throttle and the positions pass ran again 5 s after
// each failed one, so the page's own asks kept the provider's per-method window full and it never cleared; a sell
// tapped then was refused at 23.7 s.
//
// - throttleWaitMs: the one rule for the wait after a throttle. The pause doubles from `firstMs` (the previous pause 0:
//   none yet) up to `maxMs`; a provider's Retry-After is the wait when it is longer, finite and above 0, held to
//   `afterMaxMs`. A Retry-After of 0, a negative or a non-finite one is never the wait: the growing pause still holds,
//   so a throttled provider is never asked in a burst. Pure, so any loop that asks a provider again can use it.
// - ThrottleGate: one provider's state under that rule, shared by every caller of one route (the holdings readers' own
//   queue: buy-wallets.ts), never by a route it does not own. After a throttle, left() is how long until the provider
//   may be asked again. The calls of one round go out together: their throttles count as one, by the epoch each call
//   was sent in, so a round of three 429s grows the pause once. A round that goes through whole, sent after the last
//   counted throttle, sets the pause back to none (answered); one call's answer does not, since a provider that
//   throttles one method (Solana's public RPC limits each method) still answers the others.
// - One round at a time (turn): a caller takes the gate's turn before it waits the gate and gives it back once its
//   round's calls settle (an answer, a throw or a stop alike), so two list reads at once on one route ask it no faster
//   than one: each round goes out on an open gate, sent in the epoch it is counted in. The turn is the page's own: two
//   tabs each hold their own gate, so two tabs ask a route that throttles for good at most twice the one tab's rounds
//   (2 x 9 = 18 a minute); no gate spans tabs.
// - The gate's time is performance.now, which a wall clock set back or on cannot move; left() is held to the longest
//   wait the bounds allow, whatever the clock given says.

/** The first pause after a throttle that names no longer Retry-After. */
export const THROTTLE_PAUSE_FIRST_MS = 1_000;
/** The longest pause the doubling reaches. */
export const THROTTLE_PAUSE_MAX_MS = 10_000;
/** The longest Retry-After honoured: the helper's own window (apps/helper/src/rpc/rpc.ts, up to 10 s). */
export const THROTTLE_RETRY_AFTER_MAX_MS = 10_000;

export type ThrottleBounds = { readonly firstMs: number; readonly maxMs: number; readonly afterMaxMs: number };
export const THROTTLE_BOUNDS: ThrottleBounds = /* @__PURE__ */ Object.freeze({ firstMs: THROTTLE_PAUSE_FIRST_MS, maxMs: THROTTLE_PAUSE_MAX_MS, afterMaxMs: THROTTLE_RETRY_AFTER_MAX_MS });

/** The wait after a throttle, given the pause before it (0: none) and the provider's Retry-After in ms (any value). */
export function throttleWaitMs(prevMs: number, afterMs: unknown, b: ThrottleBounds = THROTTLE_BOUNDS): number {
  const pause = Number.isFinite(prevMs) && prevMs > 0 ? Math.min(prevMs * 2, b.maxMs) : b.firstMs;
  const after = typeof afterMs === "number" && Number.isFinite(afterMs) && afterMs > 0 ? Math.min(afterMs, b.afterMaxMs) : 0;
  return Math.max(pause, after);
}

/** One provider's throttle state on one route (see the header). `now` is the clock (tests replace it). */
export class ThrottleGate {
  #until = 0;
  #pause = 0;
  #epoch = 0;
  #tail: Promise<void> = Promise.resolve();
  readonly #now: () => number;
  readonly #bounds: ThrottleBounds;
  constructor(o: { now?: () => number; bounds?: ThrottleBounds } = {}) {
    this.#now = o.now ?? (() => performance.now());
    this.#bounds = o.bounds ?? THROTTLE_BOUNDS;
  }
  /** How long until the provider may be asked again, ms; 0 now. Never past the longest wait the bounds allow. */
  left(): number {
    return Math.min(Math.max(0, this.#until - this.#now()), Math.max(this.#bounds.maxMs, this.#bounds.afterMaxMs));
  }
  /** The gate's turn, one caller at a time in the order asked: resolves with the give-back once every caller before has
   *  given theirs back. A stop while waiting gives the turn on at once and rejects with the stop's reason. */
  async turn(signal?: AbortSignal): Promise<() => void> {
    let give!: () => void;
    const mine = new Promise<void>((r) => (give = r));
    const before = this.#tail;
    this.#tail = before.then(() => mine);
    if (signal === undefined) return before.then(() => give);
    try {
      signal.throwIfAborted();
      await new Promise<void>((ok, stop) => {
        const off = (): void => stop(signal.reason);
        signal.addEventListener("abort", off, { once: true });
        void before.then(() => (signal.removeEventListener("abort", off), ok()));
      });
    } catch (e) {
      give();
      throw e;
    }
    return give;
  }
  /** The epoch a call is sent in: read it when the call goes out, and give it back with its outcome. */
  epoch(): number {
    return this.#epoch;
  }
  /** A call sent in `sentIn` drew a throttle, with the provider's Retry-After (ms, any value). */
  throttled(sentIn: number, afterMs: unknown): void {
    if (sentIn === this.#epoch) {
      this.#epoch++;
      this.#pause = throttleWaitMs(this.#pause, afterMs, this.#bounds);
      this.#until = Math.max(this.#until, this.#now() + this.#pause);
      return;
    }
    // a call of a round already counted: only a longer Retry-After of its own moves the time on
    const after = throttleWaitMs(0, afterMs, { ...this.#bounds, firstMs: 0 });
    this.#until = Math.max(this.#until, this.#now() + after);
  }
  /** A round (every call of it) sent in `sentIn` went through: the pause is back to none. */
  answered(sentIn: number): void {
    if (sentIn === this.#epoch) this.#pause = 0;
  }
}

// One budget per provider host for the whole page, the trade's reads first (card signpage-passes-yield-to-a-trade). Two
// paid devnet runs (11 Nov 00:35Z and 02:51Z) showed the page's own background reads (the proof pass, the positions
// pass, the state reads' settles) and the transport's own retry (250/500/1000 ms within 3.5 s, three more asks of a host
// that throttles) keep api.devnet.solana.com's window full: a buy's finality reads met 429 for 8 to 18 s after Filled,
// and a sell tapped then was refused down. The page sent 39 and 38 requests in the 10 s before each first 429 there.
// - HostLane: one provider host's state, shared by every reader of that host on the page, whatever its route or object.
//   Its `gate` is the one rule above (ThrottleGate): a throttle any reader meets pauses the host for every reader, from
//   1 s, doubling to 10 s, the provider's Retry-After when longer (held to 10 s), back to none once a read sent after it
//   goes through.
// - Its budget: every request the page sends the host is counted (sent(); laneFetch for those that go through no laned
//   RPC: the helper's sends and fee route, the holdings and keyed routes, every send path), a trade's with the rest. A background read
//   ("pass") goes only while the page has sent the host fewer than PASS_BUDGET in the last HOST_WINDOW_MS, which leaves
//   a trade tapped next the rest of the host's limit; while a trade holds the host, fewer than PASS_BUDGET_TRADING, its
//   own reads counted in it, so the passes take only what the trade leaves; and at least one every PASS_FLOOR_MS
//   whatever trades hold or send, so no pass ever parks for long (the review of a1a6bad6, P1 and P2: a pass parked to
//   a trade's end while it held what that trade waited for); a pass asleep for room is woken when a trade starts, so the
//   floor holds from its start (the delta review of ed85d367). A trade's read ("trade") never waits on the
//   budget, only on the host's pause, and on that at most TRADE_TURN_MAX_MS: its turn has a deadline.
// - A trade (a buy or a sell, from its host's making to its run's end, at most TRADE_HOLD_MAX_MS) holds the lanes of the
//   hosts it reads (trade()).
// - A reader that holds anything a trade can wait for (a lock a trade takes) reads as a trade, never as a pass: the
//   page's callers name it (src/pool-testnet.ts).
// - A wait for the turn ends at once with a stop's reason (`signal`), and every wait on every lane at a sign out
//   (stopHostLaneWaits).

/** The longest a trade holds its hosts: the buy's read-back bound (pool-buy.ts POOL_BUY_SETTLE_MS, EVM_BUY_SETTLE_MS:
 *  120 s) and 30 s of its reads before the send. */
export const TRADE_HOLD_MAX_MS = 150_000;
/** The window the page's budget per host is counted in: the public Solana providers' own (solana.com's 100 per 10 s). */
export const HOST_WINDOW_MS = 10_000;
/** The page's requests to one host in any HOST_WINDOW_MS under which a background read goes while no trade holds it:
 *  under the 39 and 38 the public devnet host took in 10 s before its first 429s (runs of 11 Nov), so the passes alone
 *  never fill a host's window. */
export const PASS_BUDGET = 30;
/** The same while a trade holds the host, its own reads counted: the passes take only what it leaves of 20. */
export const PASS_BUDGET_TRADING = 20;
/** A background read goes at least this often on a host, whatever trades hold it or send: 2 in any 10 s at most. */
export const PASS_FLOOR_MS = 5_000;
/** The longest a trade's read waits for the host's pause before it is asked anyway (its turn's deadline). */
export const TRADE_TURN_MAX_MS = 10_000;

/** One provider host's budget on this page (see the header). `now` is the clock, `sleep` the wait (tests replace them). */
export class HostLane {
  readonly gate: ThrottleGate;
  #trades = 0;
  #sent: number[] = [];
  #lastPass = -Infinity;
  // the passes waiting now: woken when a trade starts, so the floor holds from its start (a pass asleep for room learns
  // of it at once, not at its wake)
  readonly #wakers = new Set<() => void>();
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(o: { now?: () => number; bounds?: ThrottleBounds; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}) {
    this.gate = new ThrottleGate(o);
    this.#now = o.now ?? (() => performance.now());
    this.#sleep = o.sleep ?? laneSleep;
  }
  /** Whether a trade holds this host now. */
  trading(): boolean {
    return this.#trades > 0;
  }
  /** A trade on this host, held until its give-back (called once; a second call does nothing) or `maxMs`. */
  trade(maxMs: number = TRADE_HOLD_MAX_MS): () => void {
    this.#trades++;
    for (const w of this.#wakers) w();
    let given = false;
    const give = (): void => {
      if (given) return;
      given = true;
      clearTimeout(bound as Parameters<typeof clearTimeout>[0]);
      this.#trades--;
    };
    const bound = setTimeout(give, maxMs) as unknown as { unref?: () => void };
    bound.unref?.();
    return give;
  }
  /** A request sent to this host now, of either kind: counted in its budget. `count` false: a pass's turn whose
   *  requests its own transport counts (laneFetch), so only the floor's clock moves. */
  sent(kind: "trade" | "pass", count = true): void {
    const t = this.#now();
    this.inWindow(); // the window's old requests dropped, so a host only trades read never keeps them all
    if (count) this.#sent.push(t);
    if (kind === "pass") this.#lastPass = t;
  }
  /** Requests sent to this host in the last HOST_WINDOW_MS. */
  inWindow(): number {
    const from = this.#now() - HOST_WINDOW_MS;
    while (this.#sent.length > 0 && this.#sent[0]! <= from) this.#sent.shift();
    return this.#sent.length;
  }
  /** How long until a read of `kind` may go (0: now). */
  #waitMs(kind: "trade" | "pass"): number {
    const pause = this.gate.left();
    if (kind === "trade" || pause > 0) return pause;
    const cap = this.#trades > 0 ? PASS_BUDGET_TRADING : PASS_BUDGET;
    const n = this.inWindow();
    if (n < cap) return 0;
    // the floor holds only while a trade holds the host: with none, the window's own room comes
    const floor = this.#trades > 0 ? this.#lastPass + PASS_FLOOR_MS - this.#now() : Infinity;
    if (floor <= 0) return 0;
    // room once the oldest requests past the cap leave the window
    const room = this.#sent[n - cap]! + HOST_WINDOW_MS - this.#now();
    return Math.max(1, Math.min(floor, room));
  }
  /** Whether a read of `kind` may go now, with no wait (a synchronous call keeps a paced queue's slot its own). */
  open(kind: "trade" | "pass"): boolean {
    return this.#waitMs(kind) <= 0;
  }
  /** A read's turn (see the header); a trade's at most TRADE_TURN_MAX_MS. The read is counted as sent once it ends: the
   *  caller sends it in the same tick. A sign out's stopHostLaneWaits ends it as `signal` does. */
  async turn(kind: "trade" | "pass", given?: AbortSignal, count = true): Promise<void> {
    const signal = laneSignal(given);
    const end = this.#now() + TRADE_TURN_MAX_MS;
    for (;;) {
      signal.throwIfAborted();
      const ms = kind === "trade" ? Math.min(this.#waitMs(kind), end - this.#now()) : this.#waitMs(kind);
      if (ms <= 0) return void this.sent(kind, count);
      // the floor, the window or the pause (at most 10 s), or a trade's start, whichever comes first
      let wake!: () => void;
      const woken = new Promise<void>((r) => (wake = r));
      this.#wakers.add(wake);
      try {
        await Promise.race([this.#sleep(ms, signal), woken]);
      } finally {
        this.#wakers.delete(wake);
      }
    }
  }
}

function laneSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return stoppable(new Promise<void>((r) => setTimeout(r, ms)), signal);
}
function stoppable(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return p;
  return new Promise<void>((ok, stop) => {
    if (signal.aborted) return stop(signal.reason);
    const off = (): void => stop(signal.reason);
    signal.addEventListener("abort", off, { once: true });
    void p.then(() => (signal.removeEventListener("abort", off), ok()));
  });
}

// every lane's waits end at a sign out: this controller aborted, a new one made for the next sign-in
let laneStop = new AbortController();
/** Ends every wait for a turn or a pause on every lane now (a sign out), with `reason`. */
export function stopHostLaneWaits(reason: unknown = new Error("signed out")): void {
  laneStop.abort(reason);
  laneStop = new AbortController();
}
/** `given` with the lanes' sign-out stop: a wait on it ends at either. */
export function laneSignal(given?: AbortSignal): AbortSignal {
  return given === undefined ? laneStop.signal : AbortSignal.any([given, laneStop.signal]);
}

const LANES = new Map<string, HostLane>();
/** The host a URL names, as one key whatever its spelling (the case, a trailing slash, a path): the provider's limit is
 *  per host and caller IP. A string that is no URL is its own key. */
export function laneKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}
function laneOf(k: string): HostLane {
  let l = LANES.get(k);
  if (l === undefined) LANES.set(k, (l = new HostLane()));
  return l;
}
/** The page's one lane for `url`'s host. */
export function hostLane(url: string): HostLane {
  return laneOf(laneKey(url));
}
/** A trade's hold on every host of `urls` (each once), given back together, once. */
export function holdHosts(urls: Iterable<string | undefined>): () => void {
  const keys = new Set<string>();
  for (const u of urls) if (u !== undefined) keys.add(laneKey(u));
  const gives = [...keys].map((k) => laneOf(k).trade());
  return () => {
    for (const g of gives) g();
  };
}
/** `f` (the page's fetch at each call, when none) with every request counted on its host's lane: the page's requests
 *  that go through no laned RPC (the helper's sends, its fee route, the holdings and keyed routes) count in the same
 *  budget as the rest, as the host counts them. */
export function laneFetch(f?: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    hostLane(url instanceof Request ? url.url : String(url)).sent("trade");
    return (f ?? globalThis.fetch)(url as string, init);
  }) as typeof fetch;
}
/** Forgets every host's lane (tests: each test's clock starts at its own zero). */
export function resetHostLanes(): void {
  LANES.clear();
}
