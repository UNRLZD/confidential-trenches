// GeckoTerminal's keyless API: the helper has one address, so every part that reads GeckoTerminal (the Solana token
// page's candles, src/data/solana/token.ts, and the EVM lists, src/data/evm/lists.ts) takes its calls from one budget
// of GT_LIMIT_PER_MIN in any 60 s. The token page goes first: the "lists" lane yields, taking a call only while
// PAGE_RESERVE calls stay free for a page and REFRESH_SLOT for a held chart's refresh, and none while a page has
// called in the last YIELD_MS, unless its read is urgent (never read, or old enough that the floor's queue could carry it past
// STALE_MS: src/data/evm/lists.ts LIST_URGENT_MS): the lists always keep LIST_FLOOR calls of the minute for those, so
// pages opened back to back never leave Discover's lists empty or stale, and pages always keep the other perMin -
// LIST_FLOOR. The floor's calls go to the stalest list of every chain, whichever chain asks first (LIST_TURN_MS), so
// what holds a list under STALE_MS is the floor's rate (LIST_FLOOR calls per WINDOW_MS for all the lists) and that
// order, not a chain's luck of the tick (card app-faults-seen-on-122: Base and Robinhood 243 to 316 s old live, the chain
// whose tick came first taking every freed call). A 429 pauses every lane, since GeckoTerminal answers our address, not
// a lane.
//
// The "refresh" lane is a page's re-read of data it already holds (the newest bars past their 60 s, a top pool past its
// 10 min): it takes a call only while COLD_RESERVE stay free for a read of something nobody holds, so a held token's
// refresh never refuses another token's first read; refused, the holder serves what it has, dated (card
// app-console-429: the live suite's candles 429 at 567a181, a cold mint behind another's refreshes). A refresh of the
// newest data held once it is REFRESH_URGENT_MS old is a page read (refreshLane), and the lists leave REFRESH_SLOT free
// for a refresh: the lists ask for more calls than the budget has (6 lists every LIST_MS), so they kept the window at the
// refresh lane's own room, perMin - COLD_RESERVE, and a refresh refused never made them yield; a chart read only now and
// then was served its held bars for good (card helper-chart-fresh: PUMP's 1h bars from 12:55:51Z at 14:03Z and 14:21Z,
// while a key nobody held read fresh). With the slot a refresh finds its call in normal load and a cold page its two.
//
// The limit is measured, not the published one: GeckoTerminal's FAQ says 10 calls a minute (apiguide.geckoterminal.com/
// faq, read 2026-11-03 11:27Z), but read from one address after 70 s with no call, on 2026-11-03 at 14:58:04Z, 14 calls
// back to back answered 200 five times, then 429 (Retry-After "0") nine times, and still 429 30 s later; the deployed
// helper budgeting 10 met GeckoTerminal's 429 within minutes (market-data-solana-token live, 14:47Z).
//
// The window is WINDOW_MS, longer than the minute: a local helper counting 60 s from each call's take met
// GeckoTerminal's 429 twice in 8 minutes (2026-11-03 15:38:14Z with 3 calls in the 60 s before it and 6 in the 63 s,
// 15:44:35Z with 4 and 7 in the 75 s), since GeckoTerminal counts from each call's arrival and over more than 60 s;
// a 429 pauses every lane for a minute, so the margin costs less than the 429 it avoids.
export const GT_LIMIT_PER_MIN = 5;
/** The span GT_LIMIT_PER_MIN calls are counted over. */
export const WINDOW_MS = 75_000;
/** Calls a page may always find free: a token page's first open reads the token's top pool and one candles range. */
export const PAGE_RESERVE = 2;
/** Calls the lists' reads that are not urgent leave free on top of PAGE_RESERVE: a held chart's refresh, so the lists,
 *  which ask for more calls than the budget has, never keep the window at the refresh lane's room (card
 *  helper-chart-fresh: a chart read now and then was served its held bars for good). Each EVM list is then read about
 *  every 225 s instead of 150 s, under STALE_MS; a list's first read (`first`, never read) may take the slot, so a
 *  helper started fresh still reads a chain's three lists in its first tick, as before. */
export const REFRESH_SLOT = 1;
/** A page call this recent makes the lists lane wait (unless its read is urgent). */
export const YIELD_MS = 60_000;
/** Calls a refresh leaves free: one cold token page's candles, its top pool and its bars (token.ts). */
export const COLD_RESERVE = 2;
/** Calls in the minute the lists may always take for an urgent read: all the EVM lists (6) read once each take
 *  6 x WINDOW_MS / LIST_FLOOR = 225 s, which src/data/evm/lists.ts LIST_URGENT_MS leaves inside STALE_MS. */
export const LIST_FLOOR = 2;
/** How long a list's refused call holds the other chains' lists back: the lists ask again every TICK_MS (12 s), so a
 *  chain that was refused is still waiting at the next tick of another, and a chain that stops asking holds nobody for
 *  longer than this. */
export const LIST_TURN_MS = 30_000;
/** The newest data held this old is read in the "pages" lane: four times the bars' 60 s, so a chart is never served more
 *  than this behind its last refresh that could run (its own bound; the lists' LIST_URGENT_MS is derived from their floor). */
export const REFRESH_URGENT_MS = 240_000;
/** The "ahead" lane (card helper-restart-fresh): the helper's own re-read of a chart callers read lately, before its
 *  bars pass AHEAD_MS (solana/token.ts ahead), so a deploy's swap hands the next helper bars inside GT_SERVE_MS and a
 *  crowd's first loads after it are served from them while the window the old helper spent refills (live runs
 *  41899807434 and 41905007564: 0 of 25 candles 200 at 19:44:47Z, PUMP's 1h 429 at 20:16:58Z, both right after a swap).
 *  It takes a call only while COLD_RESERVE stay free, as a held chart's refresh, at most AHEAD_PER_WINDOW in the window,
 *  and its calls never make the lists yield: it is the helper's background read, as theirs. */
export const AHEAD_PER_WINDOW = 1;

/** The newest bars held from GeckoTerminal serve a read it refuses or fails only while this old (their read time is the
 *  answer's X-Fetched-At): the market routes' freshness bound, the live checks' 10 minutes (scripts/live-checks/
 *  market-data-solana-token.mjs, market-data-evm.mjs). Older, the read answers its 429 with the wait, or 503: never a 200
 *  with old bars (card helper-restart-fresh: live run 41871356171 straight after a swap served PUMP's 1h bars 16 min
 *  old, handed over by the old helper). History before a time never changes and is served from what is held at any age. */
export const GT_SERVE_MS = 600_000;

/** Calls a "stale" read leaves free: one read of a chart nobody can be served (card helper-crowd-429). */
export const STALE_RESERVE = 1;
/** The "seed" lane's room (card market-reads-hold-under-load): the EVM history before a book of ours (evm/swaps.ts
 *  geckoBars), an optional read whose chart answers its own bars without it, takes a call only while COLD_RESERVE stay
 *  free, as a refresh, and never makes the lists yield. It drew in the "stale" lane, which leaves one: right after a
 *  start the seeds filled the window to four of five, the lists the fifth, and six cold page reads met a full window
 *  and answered 429 with no call made (the deployed helper's minute lines, 10 Nov 19:43-19:45Z: "stale base bars 4",
 *  "window 5 of 5", then "refused: pages 6"). */
export const SEED_LANE = "optional";
/** The calls of the window one caller's cold page reads may hold while another's wait (card market-reads-hold-under-load):
 *  one caller asking five tokens nobody holds otherwise takes the whole window for 75 s, again and again, and every
 *  other caller's first page meets a full window. [design: two of the five, a token page's cold read (its top pool and
 *  its bars, or its info), so one caller opens one cold page at a time while the rest serve others; keyed by the
 *  server's clientOf, the key the held route's share (held.ts DEX_LIMITS) and every other caller share use.] */
export const PAGE_PER_CLIENT = 2;
/** The lane of a read a page asked for and the budget refused (card evm-chart-opens-without-a-vendor-call): the page is
 *  answered at once from our own reads (a chart's own bars, holders with no count), never a 429, and the read waits in
 *  a queue (createWanted) for the next free call. While any waits, the lists' reads that are not urgent and the "ahead"
 *  lane take none, so what a page asked for comes before the helper's own background reads; a cold page read waiting
 *  its turn (takeOrWait) still comes first, and the queue leaves STALE_RESERVE calls of the window to a page with
 *  nothing to serve, as a stale read does (card helper-crowd-429). */
export const WANTED_LANE = "wanted";
/** Reads one queue holds; past it a new key is not queued (its page is answered from our own reads, and asks again).
 *  [design: 64, every token a crowd opens in a few minutes, which the budget's 5 calls in 75 s take 16 minutes to read;
 *  a key past that is no wait worth queueing] */
export const WANTED_MAX = 64;
/** The shortest wait between two tries of a queue refused for a reason no time names (a cold page waiting its turn, a
 *  helper held at its start). */
const WANTED_RETRY_MS = 250;

/** The lane of a read of the newest data, held since `heldAtMs` (null: nothing held): "pages" for a first read and for
 *  data past GT_SERVE_MS (nothing a caller may be served), "stale" for data REFRESH_URGENT_MS old that is still servable,
 *  else "refresh". A "stale" read takes a call while STALE_RESERVE stay free, so a chart its holder can still serve
 *  never takes the call a chart with nothing to serve needs (card helper-crowd-429: live run 41935321432 right after the
 *  23:38Z swap, Trending's 15m chart, held and servable, waited for and took the window's last call at 23:39:03Z and
 *  PUMP's 1h, with nothing servable, answered 429 0.1 s later); refused, its holder serves what it has, dated. History
 *  before a time never changes and stays a refresh, whatever its age. */
export function refreshLane(heldAtMs: number | null, nowMs: number): "pages" | "stale" | "refresh" {
  if (heldAtMs === null || nowMs - heldAtMs >= GT_SERVE_MS) return "pages";
  return nowMs - heldAtMs >= REFRESH_URGENT_MS ? "stale" : "refresh";
}

export type GeckoBudget = {
  /** One call now in `lane`, or false when the minute, a 429 pause or (for "lists") the yield says no. `what` names the
   *  read for the minute's count line (minute()). */
  take(lane: string, urgent?: boolean, first?: boolean, what?: string, by?: { ticket?: number; client?: string; source?: string; since?: number }): boolean;
  /** A place in the queue of cold page reads waiting for a call (takeOrWait): while one waits, no other lane takes a
   *  freed call and a page read takes one only in queue order (`by.ticket` the queue's first that may take), so a cold
   *  read waits its turn (card market-reads-hold-under-load). `client`: the caller's key, for PAGE_PER_CLIENT. */
  queue(client?: string): number;
  /** Leaves the queue (taken, or given up at its bound). */
  leave(ticket: number): void;
  /** A 429: no lane calls until `untilMs`. */
  pause(untilMs: number): void;
  /** When a page call can next be taken (now when it can now): the pause's end or the minute's oldest call leaving
   *  the window; what a refused page names as its wait. */
  retryAt(lane: string, ticket?: number): number;
  /** The reads `source`'s queue holds now (createWanted): while the sum over every source is above 0, the lists' reads
   *  that are not urgent and the "ahead" lane are refused. */
  wanting(source: string, n: number): void;
  /** The calls in the window, oldest first (those of `lane` when it is named): what a restart's next process seeds from
   *  (../data/warm.ts). */
  calls(lane?: string): number[];
  /** Calls another process made from our address (a deploy's old helper, read from its warm file): counted as ours, in
   *  `lane` ("lists" for its lists' calls, so the lists' LIST_FLOOR counts them; "seed" for the rest, which no lane's
   *  yield counts). Each seed of a lane replaces the one before it: the old helper's file is read at the start and again
   *  at the handover, two snapshots of the same calls (card helper-restart-fresh: counted twice, they filled the window
   *  and a page read straight after a swap was refused). */
  seed(times: readonly number[], lane?: "seed" | "lists"): void;
  /** No lane calls until release(): another helper on our address may still be calling (card helper-ready-gate). */
  hold(): void;
  release(): void;
  /** The count line since the last one (card helper-crowd-429): the calls taken per lane and read, the draws refused
   *  per lane, GeckoTerminal's 429s, the calls seeded from another process and the window as it stands; null when
   *  nothing was taken, refused or seeded. The server logs it once a minute, so a refused read is named from the log. */
  minute(): string | null;
};

/**
 * The longest a caller's cold GeckoTerminal read waits for the budget's next free call (card helper-crowd-429). [design:
 * 4 s: a cold chart is two calls (its top pool, then its bars), so 8 s of waits and GeckoTerminal's answers stay inside
 * the app's 10 s request (apps/terminal/src/screens/token/candles.ts TIMEOUT_MS), which then reads a 429 again after its
 * Retry-After (THROTTLE_RETRIES 2); the live checks wait on the answer with no timeout of their own.]
 */
export const GT_PAGE_WAIT_MS = 4_000;
/** Rounds a cold read takes the budget's next free call before it gives up: each round is one wait to the window's
 *  next free call, so another caller taking that call first costs a round, never an unbounded wait. */
const WAIT_ROUNDS = 8;

/**
 * One call in `lane` now; for a caller's cold read (the "pages" lane), the budget's next free call when it comes by
 * `untilMs`, waited for instead of a 429 (card helper-crowd-429; card evm-holders-never-starve for the EVM token's info).
 * A "stale", "refresh" or "ahead" read never waits: what is held is served meanwhile. Returns null once a call is taken,
 * else when a page call can next be taken, the wait a refused read names.
 */
export async function takeOrWait(b: GeckoBudget, lane: string, what: string, untilMs: number, now: () => number, sleep: (ms: number) => Promise<unknown>, client?: string): Promise<number | null> {
  if (b.take(lane, false, false, what, { client })) return null;
  if (lane !== "pages") return b.retryAt("pages");
  // card market-reads-hold-under-load: in the queue, its turn first in, first out; its wait the call its place gets
  const ticket = b.queue(client);
  try {
    for (let round = 0; ; round++) {
      const at = b.retryAt("pages", ticket);
      if (round >= WAIT_ROUNDS || at > untilMs) return at;
      await sleep(Math.max(at - now(), 0) + 5);
      if (b.take(lane, false, false, what, { ticket, client })) return null;
    }
  } finally {
    b.leave(ticket);
  }
}

/** GeckoTerminal answered 429: pause every lane for its Retry-After (at most 300 s), or WINDOW_MS when it names none or
 *  "0" (as it did at 14:58Z, still refusing 30 s later); returns the pause's end, the wait a page names. */
export function throttledUntil(b: GeckoBudget, retryAfter: string | null, nowMs: number): number {
  const ra = Number(retryAfter);
  const until = nowMs + (retryAfter !== null && Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) * 1000 : WINDOW_MS);
  b.pause(until);
  return until;
}

/** A budget of at most `perMin` calls in any WINDOW_MS, the "lists" lane yielding to every other. */
export function geckoBudget(now: () => number, perMin = GT_LIMIT_PER_MIN): GeckoBudget {
  const calls: { at: number; lane: string; seeded?: true; client?: string }[] = [];
  /** The cold page reads waiting their turn, in order (queue). */
  const waiting: { ticket: number; client?: string }[] = [];
  let tickets = 0;
  const byClient = (client: string | undefined) => (client === undefined ? 0 : calls.filter((c) => c.client === client).length);
  /** Whether a caller holds more than its PAGE_PER_CLIENT of the window: the last free call is then kept. */
  const heavy = (): boolean => {
    const n = new Map<string, number>();
    for (const c of calls) if (c.client !== undefined) n.set(c.client, (n.get(c.client) ?? 0) + 1);
    return [...n.values()].some((v) => v > PAGE_PER_CLIENT);
  };
  /** A waiter may take the next call: none ahead of it but those whose client holds its PAGE_PER_CLIENT already. */
  const turnOf = (ticket: number | undefined, client: string | undefined): boolean => {
    for (const w of waiting) {
      if (w.ticket === ticket) return true;
      if (byClient(w.client) < PAGE_PER_CLIENT) return false;
    }
    return ticket === undefined;
  };
  let pausedUntil = 0;
  let held = false;
  /** Each queue's reads waiting (wanting), by source. */
  const wants = new Map<string, number>();
  const backlog = (): boolean => [...wants.values()].some((n) => n > 0);
  // the minute's counts (minute()): `lane what` taken, lanes refused, 429s, calls seeded
  const took = new Map<string, number>();
  const refused = new Map<string, number>();
  let throttled = 0;
  let seeded = 0;
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  /** The lists that asked for a call and were refused, by source (a chain): when the list it wants was last read (`since`)
   *  and until when it counts as waiting. A "lists" read goes only while no other source waits with an older read, so the
   *  floor's calls go to the stalest list of every chain (earliest deadline first), never to the chain that asks first. */
  const turns = new Map<string, { since: number; until: number }>();
  const behind = (source: string | undefined, since: number, t: number): boolean => {
    for (const [s, w] of turns) if (s !== source && w.until > t && (w.since < since || (w.since === since && s < (source ?? "")))) return true;
    return false;
  };
  /** The calls of the window the lists' floor still needs, kept free from every other lane while a list that is urgent
   *  (or never read) waits for one: LIST_FLOOR less the lists' calls in the window. Without it the pages' calls fill the
   *  window to perMin and the floor finds no room (card app-faults-seen-on-122: a page every 4 s left the lists one call in
   *  72 s, not LIST_FLOOR in 75 s), so the pages keep perMin - LIST_FLOOR calls of the window, never all of it. */
  const reserved = (lane: string, t: number): number => {
    if (lane === "lists" || ![...turns.values()].some((w) => w.until > t)) return 0;
    return Math.max(0, LIST_FLOOR - calls.filter((c) => c.lane === "lists").length);
  };
  const allowed = (lane: string, urgent: boolean, first: boolean, t: number, by: { ticket?: number; client?: string; source?: string; since?: number }): boolean => {
    if (held || t < pausedUntil || calls.length >= perMin) return false;
    if (calls.length >= perMin - reserved(lane, t)) return false;
    // card market-reads-hold-under-load: a caller past its share of the window waits; while a cold page read waits for
    // a call, no other lane takes one, and a page read takes one only in its turn
    // a caller past its share leaves the window's last free call for someone else, and while it holds more than its
    // share no background lane takes that call either: a second caller's first page always finds it. Alone, a caller
    // takes perMin - 1 at once; with another caller waiting, none past its share
    const past = byClient(by.client) >= PAGE_PER_CLIENT;
    if (lane === "pages" && past && (calls.length >= perMin - 1 || waiting.some((w) => w.client !== by.client))) return false;
    // an urgent list's read within the floor is the lists' own share of the window, taken even as its last call
    const floor = lane === "lists" && urgent && calls.filter((c) => c.lane === "lists").length < LIST_FLOOR;
    if (lane !== "pages" && !floor && calls.length >= perMin - 1 && heavy()) return false;
    if (waiting.length > 0 && (lane !== "pages" || !turnOf(by.ticket, by.client))) return false;
    if (lane === "refresh" && calls.length >= perMin - COLD_RESERVE) return false;
    if (lane === "stale" && calls.length >= perMin - STALE_RESERVE) return false;
    // a queued read leaves the window's last call to a page with nothing to serve, as a stale read does
    if (lane === WANTED_LANE && calls.length >= perMin - STALE_RESERVE) return false;
    if (lane === SEED_LANE && calls.length >= perMin - COLD_RESERVE) return false;
    if (lane === "ahead" && (backlog() || calls.length >= perMin - COLD_RESERVE || calls.filter((c) => c.lane === "ahead").length >= AHEAD_PER_WINDOW)) return false;
    // a read a page asked for comes before the lists' reads that are not urgent (WANTED_LANE)
    if (lane === "lists" && !urgent && backlog()) return false;
    if (lane === "lists" && by.source !== undefined && behind(by.source, by.since ?? t, t)) return false;
    if (lane === "lists") {
      if (!floor && (calls.length >= perMin - PAGE_RESERVE - (first ? 0 : REFRESH_SLOT) || calls.some((c) => c.lane !== "lists" && c.lane !== "seed" && c.lane !== "ahead" && c.lane !== SEED_LANE && t - c.at < YIELD_MS))) return false;
    }
    return true;
  };
  const prune = (t: number) => {
    while (calls.length > 0 && t - calls[0]!.at >= WINDOW_MS) calls.shift();
  };
  return {
    take(lane, urgent = false, first = false, what = "", by = {}) {
      const t = now();
      prune(t);
      if (!allowed(lane, urgent, first, t, by)) {
        bump(refused, lane);
        if (lane === "lists" && by.source !== undefined && (urgent || first)) turns.set(by.source, { since: by.since ?? t, until: t + LIST_TURN_MS });
        return false;
      }
      if (lane === "lists" && by.source !== undefined) turns.delete(by.source);
      // only a cold page read counts in its caller's share: a held chart's refresh serves what it holds when refused
      calls.push({ at: t, lane, ...(by.client === undefined || lane !== "pages" ? {} : { client: by.client }) });
      bump(took, what === "" ? lane : `${lane} ${what}`);
      return true;
    },
    pause(untilMs) {
      if (untilMs > now()) throttled++;
      pausedUntil = Math.max(pausedUntil, untilMs);
    },
    retryAt(lane, ticket) {
      const t = now();
      prune(t);
      let at = Math.max(t, pausedUntil);
      if (held) at = Math.max(at, t + WINDOW_MS);
      // a waiter's place: the calls the waiters before it take come first
      const at_ = ticket === undefined ? -1 : waiting.findIndex((w) => w.ticket === ticket);
      const ahead = Math.max(at_, 0);
      // a caller past its share is left the window's last call by no one: its next is one more call leaving
      // a queued read's next call is the one that leaves it STALE_RESERVE free
      const cap = (lane === WANTED_LANE ? perMin - STALE_RESERVE : at_ !== -1 && byClient(waiting[at_]!.client) >= PAGE_PER_CLIENT ? perMin - 1 : perMin) - reserved(lane, t);
      const need = calls.length + ahead - cap;
      if (need >= calls.length) at = Math.max(at, t + WINDOW_MS);
      else if (need >= 0) at = Math.max(at, calls[need]!.at + WINDOW_MS);
      return at;
    },
    queue(client) {
      const ticket = ++tickets;
      waiting.push({ ticket, ...(client === undefined ? {} : { client }) });
      return ticket;
    },
    leave(ticket) {
      const i = waiting.findIndex((w) => w.ticket === ticket);
      if (i !== -1) waiting.splice(i, 1);
    },
    wanting(source, n) {
      if (n > 0) wants.set(source, n);
      else wants.delete(source);
    },
    calls(lane) {
      prune(now());
      return calls.filter((c) => lane === undefined || c.lane === lane).map((c) => c.at);
    },
    seed(times, lane = "seed") {
      const t = now();
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.seeded === true && calls[i]!.lane === lane) calls.splice(i, 1);
      for (const at of times) if (Number.isFinite(at) && at <= t && t - at < WINDOW_MS) calls.push({ at, lane, seeded: true }), seeded++;
      calls.sort((a, b) => a.at - b.at);
      prune(t);
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
    },
    minute() {
      prune(now());
      if (took.size === 0 && refused.size === 0 && throttled === 0 && seeded === 0) return null;
      const list = (m: Map<string, number>) => (m.size === 0 ? "none" : [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", "));
      const line = `geckoterminal calls: ${list(took)}; refused: ${list(refused)}; 429 ${throttled}; seeded ${seeded}; window ${calls.length} of ${perMin}`;
      took.clear();
      refused.clear();
      throttled = 0;
      seeded = 0;
      return line;
    },
  };
}

/** One read a page asked for (createWanted): `done()` true once what it reads is held (another read got it first), so
 *  it takes no call; `run()` makes the one GeckoTerminal call, its call already taken, and returns "again" when
 *  GeckoTerminal answered 429 (the read stays first in the queue and the pause is the wait). */
export type WantedRead = { done(): boolean; run(): Promise<"again" | void> };
/** Runs `fn` after `ms` (a timer that keeps no process alive; tests plant their own). */
export type Later = (fn: () => void, ms: number) => void;
const laterReal: Later = (fn, ms) => void setTimeout(fn, ms).unref();

/**
 * A queue of reads pages asked for and the budget refused (card evm-chart-opens-without-a-vendor-call), first in, first
 * out, one call at a time in WANTED_LANE, each as soon as the budget gives one: a cold page waiting its turn first, then
 * these, then the lists' reads that are not urgent and "ahead" (which the budget refuses while this queue holds any).
 * `source` names it to the budget (one per data path: a chain's bars, a chain's info). A key already queued is not queued
 * again; `first` puts it at the front (a read that follows from one just run, such as a pool's bars after its pool).
 * Refused, the queue tries again when the budget names its next call (retryAt), at least WANTED_RETRY_MS later: one
 * timer, never a loop.
 */
export function createWanted(b: GeckoBudget, source: string, now: () => number, later: Later = laterReal) {
  let queue = new Map<string, WantedRead>();
  let running: Promise<void> | null = null;
  let waiting = false;
  let stopped = false;
  const tell = () => b.wanting(source, queue.size);
  function pump(): void {
    if (stopped || running !== null || waiting) return;
    for (const [k, r] of queue) {
      if (!r.done()) break;
      queue.delete(k);
    }
    tell();
    const head = queue.entries().next().value;
    if (head === undefined) return;
    if (!b.take(WANTED_LANE, false, false, source)) {
      waiting = true;
      later(() => {
        waiting = false;
        pump();
      }, Math.max(b.retryAt("pages") - now(), WANTED_RETRY_MS));
      return;
    }
    const [k, r] = head;
    running = r
      .run()
      .catch(() => undefined)
      .then((again) => {
        if (again !== "again" && queue.get(k) === r) queue.delete(k);
        running = null;
        tell();
        pump();
      });
  }
  return {
    want(key: string, read: WantedRead, first = false): void {
      if (stopped || queue.has(key) || queue.size >= WANTED_MAX || read.done()) return;
      queue = first ? new Map([[key, read], ...queue]) : queue.set(key, read);
      tell();
      pump();
    },
    has: (key: string): boolean => queue.has(key),
    size: (): number => queue.size,
    /** The read out now, settled (tests). */
    settled: (): Promise<void> => running ?? Promise.resolve(),
    stop(): void {
      stopped = true;
      queue.clear();
      tell();
    },
  };
}
export type Wanted = ReturnType<typeof createWanted>;
