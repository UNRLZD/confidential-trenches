import { SIGNPAGE_CLIENT_CODES } from "@blindfill/kit";
import type { SignpageOutcome, SignpageParams } from "@blindfill/kit";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { HOP_RECORD, hopWhy, land, makeRecord, pathOf, RETURN_KEYS, takeRecord, writeRecord } from "./return-hop.ts";
import type { HopView, HopWhy, Landing, OpenKind } from "./return-hop.ts";
import { SIGN_HOST_URL, useSignpage } from "./signpage-frame.tsx";

// The same-tab hop to SIGN_HOST and back (return-hop.ts has the record and the rules). A screen opens one of the five
// open kinds with hop(kind, params, view): the tapped control is locked at once and a second tap does nothing; the
// record is written; the kind is posted with its return key; on the page's answer the tab moves to SIGN_HOST with
// nothing in the URL. A refused or failed kind, or one with no answer within the kit's window for it, removes the
// record, unlocks the control and keeps the outcome as `failed` (the control, why, and its Retry), which the screen
// draws in place with HopLine (screens/signin/HopLine.tsx), so a tap never ends in nothing. On the way back, landOnLoad() (main.tsx, before the first render) puts the URL on the
// route the user left, and the screen reads `restored` for its sheet and fields; the scroll is set here, and the
// control stays locked until the signing page answers again.
//
// No precheck fetch of SIGN_HOST before the move (app.md §2.1 item 5 step 3): the open kind's answer just came from
// SIGN_HOST's own page in the iframe, which is the same check, and a no-cors fetch from APP_HOST is refused by SIGN_HOST's
// Cross-Origin-Resource-Policy: same-origin anyway (packages/signpage/public/_headers; the browser run reads it).

const session = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

let first: Landing = { to: null, view: null };

/** Reads and deletes the record and moves the URL to where the load lands, before the router reads it. Once per load. */
export function landOnLoad(): void {
  const s = session();
  first = land(window.location, s ? takeRecord(s, Date.now()) : null);
  if (first.to !== null) window.history.replaceState(null, "", first.to);
}

export type HopStart = Omit<HopView, "scroll">;
export type OpenParams<K extends OpenKind> = Omit<SignpageParams[K], "return_key">;

/** The last hop that did not leave: its control, why, and a Retry that opens the same kind again. */
export interface HopFailure {
  control: string;
  why: HopWhy;
  retry(): void;
}

export interface ReturnHopView {
  /** Opens `kind` on SIGN_HOST from the screen `view`. Null when a hop is already under way (the second tap). */
  hop<K extends OpenKind>(kind: K, params: OpenParams<K>, view: HopStart): Promise<SignpageOutcome<K> | null>;
  /** The control locked now, by its id. */
  locked: string | null;
  /** The screen this load restores, or null. */
  restored: HopView | null;
  /** The last hop that did not leave, until the next hop, a route change, or its control's dismiss. */
  failed: HopFailure | null;
  /** Clears `failed` when it is `control`'s (its sheet or menu closed). */
  dismiss(control: string): void;
}

const Ctx = createContext<ReturnHopView>({ hop: async () => null, locked: null, restored: null, failed: null, dismiss: () => {} });

export const useReturnHop = () => useContext(Ctx);

export function ReturnHopProvider({ children }: { children: ReactNode }) {
  const { client, snapshot } = useSignpage();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [restored, setRestored] = useState(first.view);
  const [locked, setLocked] = useState(first.view?.control ?? null);
  const [failed, setFailed] = useState<HopFailure | null>(null);
  const restoring = useRef(first.view !== null);
  const busy = useRef(false);
  const self = useRef<ReturnHopView["hop"]>(async () => null);

  // the restored control stays locked until the signing page has answered again (ready, down or update)
  useEffect(() => {
    if (restoring.current && snapshot.status !== "connecting") {
      restoring.current = false;
      setLocked(null);
    }
  }, [snapshot.status]);

  // restored once: leaving its route drops it, so a later visit draws the screen fresh
  useEffect(() => {
    if (restored && pathname !== pathOf(restored.route)) setRestored(null);
  }, [pathname, restored]);

  // a failed hop's line belongs to the screen it was tapped on
  useEffect(() => setFailed(null), [pathname]);

  // after the screen has drawn its restored sheet
  useLayoutEffect(() => {
    if (restored) window.scrollTo(0, restored.scroll);
  }, [restored]);

  // Back from SIGN_HOST into a page kept in the back-forward cache: it is as it was left, locked; take the record
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      const s = session();
      const l = land(window.location, s ? takeRecord(s, Date.now()) : null);
      busy.current = false;
      restoring.current = false;
      setLocked(null);
      setFailed(null);
      if (l.to !== null) navigate(l.to, { replace: true });
      setRestored(l.view);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [navigate]);

  const hop = useCallback(
    async <K extends OpenKind>(kind: K, params: OpenParams<K>, view: HopStart): Promise<SignpageOutcome<K> | null> => {
      if (busy.current) return null;
      busy.current = true;
      restoring.current = false;
      setLocked(view.control);
      setFailed(null);
      const s = session();
      let o: SignpageOutcome<K> | undefined;
      try {
        try {
          if (s) writeRecord(s, makeRecord(kind, { ...view, scroll: Math.max(0, Math.round(window.scrollY)) }, Date.now()));
        } catch {
          // no storage: the flow still runs, and its return lands on the default route
        }
        o = client
          ? await client.request(kind, { ...params, return_key: RETURN_KEYS[kind] } as SignpageParams[K]).outcome
          : { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } };
        if (o.ok) window.location.assign(SIGN_HOST_URL);
        return o;
      } finally {
        if (!o?.ok) {
          try {
            s?.removeItem(HOP_RECORD);
          } catch {
            // nothing to remove
          }
          busy.current = false;
          setLocked(null);
          // every outcome but the move to SIGN_HOST is shown in place (a throw is a bad request: shown as an error)
          setFailed({ control: view.control, why: o ? hopWhy(o.error.code) : "error", retry: () => void self.current(kind, params, view) });
        }
      }
    },
    [client],
  );
  useEffect(() => {
    self.current = hop;
  }, [hop]);

  const dismiss = useCallback((control: string) => setFailed((f) => (f?.control === control ? null : f)), []);

  return <Ctx.Provider value={{ hop, locked, restored, failed, dismiss }}>{children}</Ctx.Provider>;
}
