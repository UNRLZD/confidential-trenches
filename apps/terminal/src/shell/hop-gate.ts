// The one lock every hop() goes through (ReturnHop.tsx), as plain code the tests drive with a fake request and clock.
//
// The lock is a variable checked and set in hop() itself before any await, so a second tap in the same tick, before
// React draws the control disabled, is refused. It holds past an ok: an open kind's ok means the flow is set up and
// its outcome comes back in `state` (the kit's OpenResult), not that its screen is up. SIGN_HOST posts the answer
// first, then reads its store and opens its sheet over this frame (packages/signpage/src/main.ts decide()), so between
// the ok and the sheet this frame still takes taps. The sheet's opening moves the keyboard's focus to it, out of this
// frame (packages/signpage/src/shell.ts open()): this window's blur, and the lock goes (the frame stays in the page under
// the sheet, card signing-views-open-over-the-app; a sheet with a typed field takes it out, and the lock with it). No
// blur once the kit's window for the kind has passed: no screen came, and the control unlocks with the open's line
// ("silent") and its Retry.
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
  /** The kit client's request for an open kind, or null while there is no client (the signing page is down). */
  request: (<K extends OpenKind>(kind: K, params: SignpageParams[K]) => Promise<SignpageOutcome<K>>) | null;
  /** The control locked now, or null. */
  lock(control: string | null): void;
  /** The last open that did not happen, or null at the next open. */
  fail(f: HopFailure | null): void;
  /** Runs `fn` in `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Runs `fn` once, when SIGN_HOST's sheet takes this frame's focus (this window's blur); returns its cancel. */
  taken(fn: () => void): () => void;
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
    let o: SignpageOutcome<typeof kind> | undefined;
    try {
      o = deps.request
        ? await deps.request(kind, { ...params, return_key: RETURN_KEYS[kind] } as SignpageParams[typeof kind])
        : { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } };
      return o;
    } finally {
      if (o?.ok) {
        // set up, not yet drawn: held until the sheet takes this frame's focus, or the kind's window passes with no screen
        const timer = deps.after(SIGNPAGE_TIMEOUT_MS[kind], () => {
          off();
          held = null;
          release();
          deps.fail({ control: view.control, why: "silent", retry });
        });
        const off = deps.taken(() => {
          timer();
          held = null;
          release();
        });
        held = () => (timer(), off());
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
