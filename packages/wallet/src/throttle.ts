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
//   was sent in, so a round of three 429s grows the pause once. The pause is remembered until the provider has been
//   open THROTTLE_QUIET_MS with no throttle (its window, 10 s): a throttle inside that doubles the last pause, one
//   after it starts again from `firstMs`. An answer never sets it back (card signpage-throttled-provider-has-a-spare:
//   in run 9 of 11 Nov two 200s from a host that refused 84 of 86 reads put the pause back to 1 s, and the next round
//   met 429 again at once). A round that goes through whole, sent after the last counted throttle, ends the throttle's
//   doubt (answered: suspect() false); one call's answer does not, since a provider that throttles one method
//   (Solana's public RPC limits each method) still answers the others.
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
/** How long a provider is open with no throttle before its last pause is forgotten: the public Solana providers' window
 *  (solana.com's 100 per 10 s; api.devnet's 40 a connection in 10 s, run 9's x-ratelimit-conn-limit). */
export const THROTTLE_QUIET_MS = 10_000;

export type ThrottleBounds = { readonly firstMs: number; readonly maxMs: number; readonly afterMaxMs: number; readonly quietMs?: number };
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
  #suspect = false;
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
    this.#suspect = true;
    if (sentIn === this.#epoch) {
      this.#epoch++;
      const now = this.#now();
      // the last pause, while the provider has been open less than its quiet time since it ended; none after
      const prev = now - this.#until < (this.#bounds.quietMs ?? THROTTLE_QUIET_MS) ? this.#pause : 0;
      this.#pause = throttleWaitMs(prev, afterMs, this.#bounds);
      this.#until = Math.max(this.#until, now + this.#pause);
      return;
    }
    // a call of a round already counted: only a longer Retry-After of its own moves the time on
    const after = throttleWaitMs(0, afterMs, { ...this.#bounds, firstMs: 0 });
    this.#until = Math.max(this.#until, this.#now() + after);
  }
  /** A round (every call of it) sent in `sentIn` went through: a call sent after the last counted throttle answered, so
   *  the provider is no longer in doubt. The pause is kept for the next throttle until the quiet time passes. */
  answered(sentIn: number): void {
    if (sentIn === this.#epoch) this.#suspect = false;
  }
  /** Whether a throttle is the provider's last word: no call sent after the last counted one has gone through yet. */
  suspect(): boolean {
    return this.#suspect;
  }
}

// One budget per provider host for the whole page, the trade's reads first (card signpage-passes-yield-to-a-trade). Two
// paid devnet runs (11 Nov 00:35Z and 02:51Z) showed the page's own background reads (the proof pass, the positions
// pass, the state reads' settles) and the transport's own retry (250/500/1000 ms within 3.5 s, three more asks of a host
// that throttles) keep api.devnet.solana.com's window full: a buy's finality reads met 429 for 8 to 18 s after Filled,
// and a sell tapped then was refused down. The page sent 39 and 38 requests in the 10 s before each first 429 there.
// - HostLane: one provider host's state, shared by every reader of that host on the page, whatever its route or object.
//   Its `gate` is the one rule above (ThrottleGate): a throttle any reader meets pauses the host for every reader, from
//   1 s, doubling to 10 s, the provider's Retry-After when longer (held to 10 s); the doubling is kept until the host
//   has been open THROTTLE_QUIET_MS, and a read sent after the throttle that goes through only clears its doubt.
// - Its budget: every request the page sends the host is counted (sent(); laneFetch for those that go through no laned
//   RPC: the helper's sends and fee route, the holdings and keyed routes, every send path), a trade's with the rest. A background read
//   ("pass") goes only while the page has sent the host fewer than PASS_BUDGET in the last HOST_WINDOW_MS, which leaves
//   a trade tapped next the rest of the host's limit; while a trade holds the host, fewer than PASS_BUDGET_TRADING, its
//   own reads counted in it, so the passes take only what the trade leaves; and at least one every PASS_FLOOR_MS
//   whatever trades hold or send, so no pass ever parks for long (the review of a1a6bad6, P1 and P2: a pass parked to
//   a trade's end while it held what that trade waited for); a pass asleep for room is woken when a trade starts, so the
//   floor holds from its start (the delta review of ed85d367). A trade's read ("trade") never waits on the
//   budget, only on the host's pause, and on that at most TRADE_TURN_MAX_MS from its start (a pause it cannot wait out
//   inside that is refused at once, HostPaused); then on the probe after the pause, at most PROBE_HELD_MAX_MS.
// - A trade (a buy or a sell, from its host's making to its run's end, at most TRADE_HOLD_MAX_MS) holds the lanes of the
//   hosts it reads (trade()).
// - A reader that holds anything a trade can wait for (a lock a trade takes) reads as a trade, never as a pass: the
//   page's callers name it (src/pool-testnet.ts).
// - A wait for the turn ends at once with a stop's reason (`signal`), and every wait on every lane at a sign out
//   (stopHostLaneWaits).
// - One probe after a pause (card signpage-throttled-provider-has-a-spare). In run 9 of 11 Nov api.devnet refused 84 of
//   86 reads in 21 s: every read parked on the pause left within 3 ms of its end, 10 to 15 at a time, and each burst met
//   429 again. Now, once a pause ends on a host whose last word was a throttle (gate.suspect()), one read goes (a
//   trade's when one is parked) and every other waits until it settles: its answer opens the host to all of them, its
//   throttle starts the next pause, any other fault lets the next read probe. Only the page's own reads that report
//   their outcome (lanedRpc: answered, throttled, failed) probe; a turn that reports none never takes the probe. A
//   probe out past PROBE_HELD_MAX_MS (its try's own timeout) is lost, and the next read probes.
// - Trades first: while a trade's read waits its turn on a host, no pass leaves it; the passes go after, on the budget.
// - A wait is held to the reader's bound (`by`, and a trade's TRADE_TURN_MAX_MS): a wait known to pass it (the pause,
//   the window's room) is refused at once (HostPaused), and one held for the probe is refused at the bound, never sent
//   past it or counted, so a read that gives up on a paused host leaves its time to another provider.

/** The longest a trade holds its hosts: the buy's read-back bound (pool-buy.ts POOL_BUY_SETTLE_MS, EVM_BUY_SETTLE_MS:
 *  120 s) and 30 s of its reads before the send. A Solana pool buy gives its hold back at its early "sent", and its
 *  reads past its land are a pass's (card sell-right-after-a-buy): this bounds the hold, not when that buy reaches Final,
 *  which can be past it (pool-buy.ts POOL_BUY_SETTLE_MS). */
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
/** The longest a trade's read waits for the host's pause, from its turn's start: a pause that would end past it is
 *  refused at once (HostPaused), never asked anyway. */
export const TRADE_TURN_MAX_MS = 10_000;

/** A turn refused: the host's wait would pass the reader's bound (see the header). Nothing was sent or counted. */
export class HostPaused extends Error {
  readonly host: string;
  constructor(host = "") {
    super("the host is paused past the read's bound");
    this.name = "HostPaused";
    this.host = host;
  }
}
// a held wait (the probe out, or trades parked ahead of a pass): no time is known, a settle or a trade's end wakes it; it
// re-checks at most this late
const HELD_RECHECK_MS = HOST_WINDOW_MS;
/** The longest one probe is waited for: a page read's one try ends by then (packages/kit/src/trade/solana/send.ts
 *  SOLANA_CALL_TIMEOUT_MS, 5 s, every try's timeout). A probe out longer has stalled past its own timeout's report, so
 *  the next read probes (no host ever waits on a lost probe). */
export const PROBE_HELD_MAX_MS = 5_000;

/** One provider host's budget on this page (see the header). `now` is the clock, `sleep` the wait (tests replace them). */
export class HostLane {
  readonly gate: ThrottleGate;
  #trades = 0;
  #sent: number[] = [];
  #lastPass = -Infinity;
  // a read that reports its outcome is out after a pause on a host in doubt: every other waits for it to settle
  #probeOut = false;
  #probeAt = -Infinity;
  // trades' reads waiting their turn now: no pass leaves while one does
  #parked = 0;
  // the passes waiting now: woken when a trade starts, so the floor holds from its start (a pass asleep for room learns
  // of it at once, not at its wake)
  readonly #wakers = new Set<() => void>();
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The host this lane counts (its key); "" for a lane made apart from the page's map. */
  readonly host: string;
  constructor(o: { now?: () => number; bounds?: ThrottleBounds; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; host?: string } = {}) {
    this.host = o.host ?? "";
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
  #wake(): void {
    for (const w of this.#wakers) w();
  }
  // whether a read sent in `sentIn` is the probe out now (it was sent in the epoch the probe went in, alone)
  #isProbe(sentIn: number): boolean {
    return this.#probeOut && sentIn === this.gate.epoch();
  }
  #settle(probe: boolean): void {
    if (!probe) return;
    this.#probeOut = false;
    this.#wake();
  }
  /** A read sent in `sentIn` (gate.epoch() at its send) answered: the gate's answered, and the probe settled when it was it. */
  answered(sentIn: number): void {
    const probe = this.#isProbe(sentIn);
    this.gate.answered(sentIn);
    this.#settle(probe);
  }
  /** A read sent in `sentIn` drew a throttle (Retry-After `afterMs`): the gate's throttled, and the probe settled. */
  throttled(sentIn: number, afterMs: unknown): void {
    const probe = this.#isProbe(sentIn);
    this.gate.throttled(sentIn, afterMs);
    this.#settle(probe);
  }
  /** A read sent in `sentIn` failed some other way (a stall, a dropped connection, an answer that is no JSON): the
   *  probe settled, the host still in doubt, so the next read probes. */
  failed(sentIn: number): void {
    this.#settle(this.#isProbe(sentIn));
  }
  /** A request sent to this host now that goes through no laned RPC (laneFetch): counted in the budget only. */
  count(): void {
    this.inWindow();
    this.#sent.push(this.#now());
  }
  // a read leaves now: counted (unless its transport counts it), the pass's floor clock moved, and the probe taken by a
  // read that reports its outcome when the host is in doubt
  #go(kind: "trade" | "pass", count: boolean, reports: boolean): void {
    if (reports && this.gate.suspect()) (this.#probeOut = true), (this.#probeAt = this.#now());
    this.sent(kind, count);
  }
  /** A read that reports its outcome leaves now, after open(kind) said it may (lanedRpc's synchronous send). */
  took(kind: "trade" | "pass"): void {
    this.#go(kind, true, true);
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
  /** How long until a read of `kind` may go (ms 0: now). `held`: no time is known (the probe out, or trades parked
   *  ahead of a pass): a settle or a trade's end wakes it, `ms` a re-check. */
  #waitOf(kind: "trade" | "pass"): { ms: number; held: boolean } {
    const pause = this.gate.left();
    if (pause > 0) return { ms: pause, held: false };
    if (this.gate.suspect()) {
      // a probe out past its own try's timeout is lost: the next read probes
      if (this.#probeOut && this.#now() - this.#probeAt >= PROBE_HELD_MAX_MS) this.#probeOut = false;
      // after a pause: one probe, a trade's when one waits; the rest wait for it to settle
      if (this.#probeOut) return { ms: Math.max(1, Math.min(HELD_RECHECK_MS, this.#probeAt + PROBE_HELD_MAX_MS - this.#now())), held: true };
      if (kind === "pass" && this.#parked > 0) return { ms: HELD_RECHECK_MS, held: true };
      return { ms: 0, held: false };
    }
    if (kind === "trade") return { ms: 0, held: false };
    // trades first: no pass leaves while a trade's read waits its turn here
    if (this.#parked > 0) return { ms: HELD_RECHECK_MS, held: true };
    const cap = this.#trades > 0 ? PASS_BUDGET_TRADING : PASS_BUDGET;
    const n = this.inWindow();
    if (n < cap) return { ms: 0, held: false };
    // the floor holds only while a trade holds the host: with none, the window's own room comes
    const floor = this.#trades > 0 ? this.#lastPass + PASS_FLOOR_MS - this.#now() : Infinity;
    if (floor <= 0) return { ms: 0, held: false };
    // room once the oldest requests past the cap leave the window
    const room = this.#sent[n - cap]! + HOST_WINDOW_MS - this.#now();
    return { ms: Math.max(1, Math.min(floor, room)), held: false };
  }
  /** How long a read of `kind` would wait now, ms (0: it may go); a seat picks the member that opens first by it. */
  wait(kind: "trade" | "pass"): number {
    return this.#waitOf(kind).ms;
  }
  /** Whether a read of `kind` may go now, with no wait (a synchronous call keeps a paced queue's slot its own). */
  open(kind: "trade" | "pass"): boolean {
    return this.#waitOf(kind).ms <= 0;
  }
  /** A read's turn (see the header). The read is counted as sent once it ends: the caller sends it in the same tick.
   *  `reports`: the caller reports the read's outcome (answered, throttled, failed), so it may be the probe. `by`: the
   *  reader's bound on this lane's clock, on every wait. A trade's known waits (the host's pause) are also held to
   *  TRADE_TURN_MAX_MS from its start, and its wait for a probe to settle to PROBE_HELD_MAX_MS past that (a read that
   *  waited a 10 s pause out is asked once the probe settles). A known wait past its bound is refused at once
   *  (HostPaused), a held one at its bound; nothing counted. A sign out's stopHostLaneWaits ends it as `signal` does. */
  async turn(kind: "trade" | "pass", given?: AbortSignal, count = true, o: { reports?: boolean; by?: number } = {}): Promise<void> {
    const signal = laneSignal(given);
    const by = o.by ?? Infinity;
    const capped = Math.min(by, kind === "trade" ? this.#now() + TRADE_TURN_MAX_MS : Infinity);
    if (kind === "trade") this.#parked++;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { ms, held } = this.#waitOf(kind);
        if (ms <= 0) return void this.#go(kind, count, o.reports === true);
        // a trade's held wait ends PROBE_HELD_MAX_MS past its known waits' bound: each read parked ahead of it may be one
        // probe that stalls to its try's timeout, so an unbounded held wait grew one try per read ahead
        const left = (held ? Math.min(by, capped + PROBE_HELD_MAX_MS) : capped) - this.#now();
        // a known wait past the bound is refused now: never waited out to be dropped at its end
        if (left <= 0 || (!held && ms > left)) throw new HostPaused(this.host);
        // the floor, the window, the pause (at most 10 s), the probe's settle or a trade's start, whichever comes first
        let wake!: () => void;
        const woken = new Promise<void>((r) => (wake = r));
        this.#wakers.add(wake);
        try {
          await Promise.race([this.#sleep(Math.min(ms, left), signal), woken]);
        } finally {
          this.#wakers.delete(wake);
        }
      }
    } finally {
      if (kind === "trade" && --this.#parked === 0) this.#wake();
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
  if (l === undefined) LANES.set(k, (l = new HostLane({ host: k })));
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
    hostLane(url instanceof Request ? url.url : String(url)).count();
    return (f ?? globalThis.fetch)(url as string, init);
  }) as typeof fetch;
}
/** Forgets every host's lane (tests: each test's clock starts at its own zero). */
export function resetHostLanes(): void {
  LANES.clear();
}
