// The device's one proving tab (card robinhood-note-spendable). A ready proof lives in the memory of the tab whose proof
// queue made it, while the note it holds is HELD in the store every tab shares (../../wallet/src/notes/store.ts: only
// the attempt that holds a note sends it or frees it). So a note one tab proved could not be spent from any other tab,
// and a hidden tab (whose passes do nothing, ../../wallet/src/pool/queue.ts) kept it HELD for as long as it stayed
// open: the tab in use read the note in its balance with no Max (the owner's Robinhood return note, 13 Nov 21:26Z).
//
// The rule, on every pool (Solana, Base, Robinhood: the queue is one): the proof queues run only in the tab that holds
// the device's PROOF_FRONT_LOCK (Web Locks, held while the tab is shown), and a tab that loses it closes its queues,
// which frees every note they hold (queue.ts close), so the tab that took it proves them at its next pass.
// - Taken: by a shown tab with focus (its own document or the APP_HOST frame in it: document.hasFocus), stolen from any
//   other holder (steal), so the tab in use always proves; by a shown tab without focus only when no tab holds it
//   (ifAvailable), so two windows side by side never take it from each other at each read.
// - Asked at each state read, at show and focus, and once a second while the tab is shown with focus and does not hold
//   it (FRONT_CHECK_MS): focus that moves into the APP_HOST frame of another window fires no event on this window.
// - Given back: when the tab is hidden or left (visibilitychange, pagehide). A tab that closes or dies gives it back
//   with its lock, and the store frees a dead tab's HELD notes at its next open.
// - With no Web Locks (no navigator.locks), the tab always holds it: one tab proves as it did before.
// Nothing here reads a note or the seed.

/** The lock's name: one per origin, so one per device's wallet store. */
export const PROOF_FRONT_LOCK = "blindfill-proof-front";

/** How often a shown tab with focus that does not hold the front asks for it. */
export const FRONT_CHECK_MS = 1_000;

export type ProofFront = {
  /** Whether this tab holds the device's proof queues now. */
  held(): boolean;
  /** Takes it when this tab should (shown: with focus, stolen; without, only if free), gives it back when hidden. */
  want(): void;
  /** Gives it back (hidden, left, signed out). */
  release(): void;
  /** Called with true when this tab took it and false when it lost it (given back or stolen). */
  onChange(f: (held: boolean) => void): void;
};

type FrontDoc = { visibilityState: string; hasFocus?: () => boolean; addEventListener(type: string, f: () => void): void };
type FrontWin = { addEventListener(type: string, f: () => void): void };

export function proofFront(locks: Pick<LockManager, "request"> | null, doc: FrontDoc | null, win: FrontWin | null = null, every: (f: () => void, ms: number) => void = unrefInterval): ProofFront {
  const watchers = new Set<(held: boolean) => void>();
  if (!locks || !doc) return { held: () => true, want: () => {}, release: () => {}, onChange: (f) => void watchers.add(f) };
  let held = false;
  // the hold now: its release, and its own token, so a late end of an older hold changes nothing
  let hold: { give: () => void } | null = null;
  let asking = false;
  const set = (v: boolean): void => {
    if (held === v) return;
    held = v;
    for (const f of watchers) f(v);
  };
  const shown = (): boolean => doc.visibilityState !== "hidden";
  const release = (): void => {
    const h = hold;
    hold = null;
    h?.give();
    set(false);
  };
  const want = (): void => {
    if (!shown()) return release();
    if (held || asking) return;
    const focused = doc.hasFocus?.() ?? true;
    asking = true;
    const me: { give: () => void } = { give: () => {} };
    const kept = new Promise<void>((r) => (me.give = r));
    const opts: LockOptions = focused ? { steal: true } : { ifAvailable: true };
    locks
      .request(PROOF_FRONT_LOCK, opts, (lock) => {
        asking = false;
        if (lock === null) return undefined; // another tab holds it: asked again at the next read
        // hidden while it was asked: given back at once
        if (!shown()) return undefined;
        hold = me;
        set(true);
        return kept;
      })
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        asking = false;
        // the hold ended: given back, or stolen by another tab (its request rejects with an AbortError)
        if (hold === me) {
          hold = null;
          set(false);
        }
      });
  };
  doc.addEventListener("visibilitychange", () => (shown() ? want() : release()));
  win?.addEventListener("pagehide", () => release());
  win?.addEventListener("pageshow", () => want());
  win?.addEventListener("focus", () => want());
  every(() => {
    if (!held && !asking && shown() && (doc.hasFocus?.() ?? false)) want();
  }, FRONT_CHECK_MS);
  want();
  return { held: () => held, want, release, onChange: (f) => void watchers.add(f) };
}

/** setInterval whose timer never holds a process open (Node's unref; a browser's has none). */
function unrefInterval(f: () => void, ms: number): void {
  const t = setInterval(f, ms) as unknown as { unref?: () => void };
  t.unref?.();
}
