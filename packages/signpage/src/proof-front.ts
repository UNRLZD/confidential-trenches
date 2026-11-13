// The device's one proving tab (card robinhood-note-spendable). A ready proof lives in the memory of the tab whose proof
// queue made it, while the note it holds is HELD in the store every tab shares (../../wallet/src/notes/store.ts: only
// the attempt that holds a note sends it or frees it). So a note one tab proved could not be spent from any other tab,
// and a hidden tab (whose passes do nothing, ../../wallet/src/pool/queue.ts) kept it HELD for as long as it stayed
// open: the tab in use read the note in its balance with no Max (the owner's Robinhood return note, 13 Nov 21:26Z).
//
// The rule, on every pool (Solana, Base, Robinhood: the queue is one): the proof queues run only in the tab that holds
// the device's front, and a tab that loses it closes its queues, which frees every note they hold (queue.ts close), so
// the tab that took it proves them at its first pass.
// - Two Web Locks make the front. PROOF_FRONT_LOCK says which tab should prove; PROOF_QUEUES_LOCK is held by the one
//   tab whose queues are open, from its take of the front until its queues are closed. A tab holds the front (held())
//   once it holds both, so it opens its queues only after the tab before it closed its own and every note that tab
//   held is free again.
// - Taken: by a shown tab with focus (its own document or the APP_HOST frame in it: document.hasFocus), stolen from any
//   other holder (steal), so the tab in use always proves; by a shown tab without focus only when no tab holds it
//   (ifAvailable), so two windows side by side never take it from each other at each read; and by a tap (tap(): a buy,
//   sell or withdraw run), stolen whatever the focus, the tap waiting until this tab holds it.
// - Asked at each state read, at show and focus, and once a second while the tab is shown with focus and does not hold
//   it (FRONT_CHECK_MS): focus that moves into the APP_HOST frame of another window fires no event on this window.
// - Given back: when the tab is hidden or left (visibilitychange, pagehide). A tab that closes or dies gives both locks
//   back, and the store frees a dead tab's HELD notes at its next open.
// - A tap under way keeps the queues: a loss (another tab's steal, this tab hidden) closes them only once every tap of
//   this tab has ended (a buy's at its take, src/pool-testnet.ts), so a running pick-to-take is never cut by a window
//   switch: the tab that took the front waits for the queues lock meanwhile. A tab that never gives the queues lock
//   back (frozen before its close ended) loses it after QUEUES_WAIT_MS.
// - With no Web Locks (no navigator.locks), the tab always holds it: one tab proves as it did before.
// Nothing here reads a note or the seed.

/** The front's lock: one per origin, so one per device's wallet store. */
export const PROOF_FRONT_LOCK = "blindfill-proof-front";

/** The open queues' lock: held by the one tab whose proof queues are open, until they are closed. */
export const PROOF_QUEUES_LOCK = "blindfill-proof-queues";

/** How often a shown tab with focus that does not hold the front asks for it. */
export const FRONT_CHECK_MS = 1_000;

/** How long a tab that took the front waits for the tab before it to close its queues before it takes them. */
export const QUEUES_WAIT_MS = 30_000;

export type ProofFront = {
  /** Whether this tab holds the device's proof queues now. */
  held(): boolean;
  /** Takes it when this tab should (shown: with focus, stolen; without, only if free), gives it back when hidden. */
  want(): void;
  /** Gives it back (hidden, left, signed out). Its queues close once no tap of this tab is under way. */
  release(): void;
  /** Called with true when this tab holds it, and with false when its queues must close (given back or stolen, and no
   *  tap under way): the queues lock is given back once every watcher's promise has settled. */
  onChange(f: (held: boolean) => void | Promise<void>): void;
  /** A tap in this tab: takes the front (stolen from any other tab, focus or not) and resolves once this tab holds it,
   *  with the tap's end. Until every tap's end is called, a loss closes nothing. */
  tap(): Promise<() => void>;
};

type FrontDoc = { visibilityState: string; hasFocus?: () => boolean; addEventListener(type: string, f: () => void): void };
type FrontWin = { addEventListener(type: string, f: () => void): void };
type Locks = Pick<LockManager, "request">;
/** A lock this tab was granted: its give back, and its end (given back, or stolen by another tab). */
type Held = { give: () => void; ended: Promise<void> };

/** `name` asked with `opts`; null when not granted (ifAvailable while held, or aborted by its signal). */
function hold(locks: Locks, name: string, opts: LockOptions): Promise<Held | null> {
  return new Promise((got) => {
    let give!: () => void;
    const kept = new Promise<void>((r) => (give = r));
    let granted = false;
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    void locks
      .request(name, opts, (lock) => {
        if (lock === null) return undefined;
        granted = true;
        got({ give, ended });
        return kept;
      })
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        end();
        if (!granted) got(null);
      });
  });
}

export function proofFront(locks: Locks | null, doc: FrontDoc | null, win: FrontWin | null = null, every: (f: () => void, ms: number) => void = unrefInterval, later: (f: () => void, ms: number) => void = unrefTimeout): ProofFront {
  const watchers = new Set<(held: boolean) => void | Promise<void>>();
  if (!locks || !doc) return { held: () => true, want: () => {}, release: () => {}, onChange: (f) => void watchers.add(f), tap: async () => () => {} };
  let held = false;
  // what the watchers were last told: a loss followed by a take again before the queues closed tells them nothing
  let told = false;
  let front: Held | null = null;
  let queues: Held | null = null;
  let asking = false;
  let taps = 0;
  // this tab's own close after a loss: a take again waits for it before it asks for the queues lock
  let closing: Promise<void> = Promise.resolve();
  const pokes = new Set<() => void>();
  const poke = (): void => {
    for (const f of [...pokes]) f();
    pokes.clear();
  };
  const until = async (done: () => boolean): Promise<void> => {
    while (!done()) await new Promise<void>((r) => pokes.add(r));
  };
  const tell = async (v: boolean): Promise<void> => {
    if (told === v) return;
    told = v;
    const runs = [...watchers].map((f) => {
      try {
        return Promise.resolve(f(v));
      } catch (e) {
        return Promise.reject(e);
      }
    });
    await Promise.all(runs.map((p) => p.catch(() => {})));
  };
  const shown = (): boolean => doc.visibilityState !== "hidden";
  // the front lost: no tab's queues open here until every tap of this tab ends, then closed and the queues lock given back
  const lose = (): void => {
    held = false;
    poke();
    closing = closing.then(async () => {
      await until(() => taps === 0 || front !== null);
      if (front !== null) return; // taken again meanwhile: its queues stay open
      await tell(false);
      const q = queues;
      queues = null;
      q?.give();
    });
  };
  // the queues lock, once the tab before closed its own; taken from a tab that keeps it past QUEUES_WAIT_MS
  const queuesFor = async (f: Held): Promise<Held | null> => {
    const stop = new AbortController();
    void f.ended.then(() => stop.abort());
    let late = false;
    later(() => {
      late = true;
      stop.abort();
    }, QUEUES_WAIT_MS);
    let q = await hold(locks, PROOF_QUEUES_LOCK, { signal: stop.signal });
    if (q === null && late && front === f) q = await hold(locks, PROOF_QUEUES_LOCK, { steal: true });
    if (q !== null && front !== f) {
      q.give();
      return null;
    }
    return q;
  };
  const ask = (steal: boolean): void => {
    if (front !== null || asking) return;
    asking = true;
    void (async () => {
      const f = await hold(locks, PROOF_FRONT_LOCK, steal ? { steal: true } : { ifAvailable: true });
      asking = false;
      if (f === null) return poke(); // another tab holds it: asked again at the next read
      // hidden while it was asked, with no tap waiting: given back at once
      if (!shown() && taps === 0) {
        f.give();
        return poke();
      }
      front = f;
      poke();
      // the front's end: given back, or stolen by another tab (its request rejects with an AbortError)
      void f.ended.then(() => {
        if (front !== f) return;
        front = null;
        lose();
      });
      await closing;
      if (front !== f) return;
      if (queues === null) {
        const q = await queuesFor(f);
        if (q === null) return;
        queues = q;
        // the queues taken from this tab (it kept them past QUEUES_WAIT_MS): closed now, taps or not
        void q.ended.then(() => {
          if (queues !== q) return;
          queues = null;
          held = false;
          poke();
          void tell(false);
        });
      }
      if (front !== f) return;
      held = true;
      poke();
      void tell(true);
    })();
  };
  const release = (): void => {
    const f = front;
    front = null;
    f?.give();
    if (f !== null) lose();
  };
  const want = (): void => {
    if (!shown()) {
      if (taps === 0) release();
      return;
    }
    ask(doc.hasFocus?.() ?? true);
  };
  const tap = async (): Promise<() => void> => {
    taps++;
    let over = false;
    const end = (): void => {
      if (over) return;
      over = true;
      taps--;
      poke();
      if (taps === 0 && !shown()) release();
    };
    while (!held) {
      ask(true);
      await new Promise<void>((r) => pokes.add(r));
    }
    return end;
  };
  doc.addEventListener("visibilitychange", () => (shown() ? want() : taps === 0 ? release() : undefined));
  win?.addEventListener("pagehide", () => release());
  win?.addEventListener("pageshow", () => want());
  win?.addEventListener("focus", () => want());
  every(() => {
    if (front === null && !asking && shown() && (doc.hasFocus?.() ?? false)) want();
  }, FRONT_CHECK_MS);
  want();
  return { held: () => held, want, release, onChange: (f) => void watchers.add(f), tap };
}

/** setInterval whose timer never holds a process open (Node's unref; a browser's has none). */
function unrefInterval(f: () => void, ms: number): void {
  const t = setInterval(f, ms) as unknown as { unref?: () => void };
  t.unref?.();
}

/** setTimeout whose timer never holds a process open. */
function unrefTimeout(f: () => void, ms: number): void {
  const t = setTimeout(f, ms) as unknown as { unref?: () => void };
  t.unref?.();
}
