// The one lock every hop() goes through (ReturnHop.tsx), as plain code the tests drive with a fake request and clock.
//
// The lock is a variable checked and set in hop() itself before any await, so a second tap in the same tick, before
// React draws the control disabled, is refused. It holds past an ok: an open kind's ok means the flow is set up and
// its outcome comes back in `state` (the kit's OpenResult), not that its screen is up. SIGN_HOST posts the answer
// first, then reads its store and opens its sheet over this frame (packages/signpage/src/main.ts decide()), so between
// the ok and the sheet this frame still takes taps. Nor is this window's blur the end of that: SIGN_HOST moves the
// keyboard's focus to its sheet in the task it opens it (packages/signpage/src/shell.ts open()), and the frame stops
// taking taps only at SIGN_HOST's next rendering, so a tap in between still reaches this frame and sent a second open
// (merge-queue run 43344446268, two signin.open 40 ms apart).
// An ok with `closes` (kit 1.13, the kit's onClosed): the lock holds until SIGN_HOST's closed notice for that open's id,
// which it posts once on every ending of the open, in the task its frame takes taps again (the layer closed, or no
// layer shown). Its bound: no screen within the kind's window (no blur, no notice), the silent line and its Retry, as
// below; a screen came (the blur), the frame inert under it takes no tap, so the lock holds as long as the layer, and
// from the kind's window after the blur it also lifts once this frame has the focus again, which only a live frame
// takes (SIGN_HOST gives it back in the task it posts the notice), so a notice that never comes (a page that crashed)
// cannot hold the control for good. A reload of the page, or a frame taken out under a typed screen, takes the lock with
// this frame's document.
// An ok with no `closes` (a page before kit 1.13): the lock goes at this window's blur (the frame stays in the page
// under the sheet, card signing-views-open-over-the-app; a sheet with a typed field takes it out, and the lock with
// it). No blur once the kit's window for the kind has passed: no screen came, and the control unlocks with the open's
// line ("silent") and its Retry.
import { SIGNPAGE_CLIENT_CODES, SIGNPAGE_TIMEOUT_MS } from "@blindfill/kit";
import type { SignpageOutcome, SignpageParams } from "@blindfill/kit";
import { hopWhy, RETURN_KEYS } from "./return-hop.ts";
import type { HopView, HopWhy, OpenKind } from "./return-hop.ts";

export type OpenParams<K extends OpenKind> = Omit<SignpageParams[K], "return_key">;

/** The last open that did not happen: its control, why, and a Retry that opens the same kind again. */
export interface HopFailure {
  control: string;
  why: HopWhy;
  retry(): void;
}

export interface HopGateDeps {
  /** The kit client's request for an open kind (its id and outcome), or null while there is no client (the signing page
   *  is down). */
  request: (<K extends OpenKind>(kind: K, params: SignpageParams[K]) => { id: string; outcome: Promise<SignpageOutcome<K>> }) | null;
  /** The control locked now, or null. */
  lock(control: string | null): void;
  /** The last open that did not happen, or null at the next open. */
  fail(f: HopFailure | null): void;
  /** Runs `fn` in `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Runs `fn` once, when SIGN_HOST's sheet takes this frame's focus (this window's blur); returns its cancel. */
  taken(fn: () => void): () => void;
  /** Runs `fn` once, at SIGN_HOST's closed notice for the open `id` (the kit client's onClosed); returns its cancel.
   *  Null when that open's ok carried no `closes` (a page before kit 1.13, which sends none). */
  closed(id: string, fn: () => void): (() => void) | null;
  /** Runs `fn` once, when this frame's window has the focus (in a microtask if it has it now); returns its cancel. */
  returned(fn: () => void): () => void;
}

export type Hop = <K extends OpenKind>(kind: K, params: OpenParams<K>, view: HopView) => Promise<SignpageOutcome<K> | null>;

export function hopGate(deps: HopGateDeps): { hop: Hop; stop(): void } {
  let busy = false;
  let held: (() => void) | null = null;
  const release = () => {
    busy = false;
    deps.lock(null);
  };
  const hop: Hop = async (kind, params, view) => {
    if (busy) return null;
    busy = true;
    deps.lock(view.control);
    deps.fail(null);
    const retry = () => void hop(kind, params, view);
    let id = "";
    let o: SignpageOutcome<typeof kind> | undefined;
    try {
      if (deps.request) {
        const h = deps.request(kind, { ...params, return_key: RETURN_KEYS[kind] } as SignpageParams[typeof kind]);
        id = h.id;
        o = await h.outcome;
      } else o = { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } };
      return o;
    } finally {
      if (o?.ok) {
        // set up, not yet drawn: held until the page's closed notice (with `closes`) or the sheet's blur (without), or
        // the kind's window passes with no screen
        const win = SIGNPAGE_TIMEOUT_MS[kind];
        const offs: (() => void)[] = [];
        let dropped = false;
        const on = (off: () => void) => (dropped ? off() : void offs.push(off));
        const drop = () => {
          dropped = true;
          for (const off of offs.splice(0)) off();
          held = null;
        };
        const end = (why: HopWhy | null) => {
          if (dropped) return;
          drop();
          release();
          if (why) deps.fail({ control: view.control, why, retry });
        };
        held = drop;
        const notice = deps.closed(id, () => end(null));
        if (notice) on(notice);
        const silent = deps.after(win, () => end("silent"));
        on(silent);
        on(
          deps.taken(() => {
            silent();
            if (!notice) return end(null);
            // a screen came, the frame inert under it: past the kind's window from now, also the frame's next focus
            on(deps.after(win, () => on(deps.returned(() => end(null)))));
          }),
        );
      } else {
        release();
        // every outcome but the shell's screen is shown in place (a throw is a bad request: shown as an error)
        deps.fail({ control: view.control, why: o ? hopWhy(o.error.code) : "error", retry });
      }
    }
  };
  return {
    hop,
    stop: () => {
      held?.();
      held = null;
    },
  };
}
