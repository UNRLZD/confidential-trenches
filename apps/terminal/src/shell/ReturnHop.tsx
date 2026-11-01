import { SIGNPAGE_CLIENT_CODES } from "@blindfill/kit";
import type { SignpageOutcome, SignpageParams } from "@blindfill/kit";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { hopWhy, RETURN_KEYS } from "./return-hop.ts";
import type { HopView, HopWhy, OpenKind } from "./return-hop.ts";
import { useSignpage } from "./signpage-frame.tsx";

// Opening one of the five open kinds on SIGN_HOST's shell (return-hop.ts). A screen calls hop(kind, params, view): the
// tapped control is locked at once and a second tap does nothing; the kind is posted to the shell. The shell's ok means
// it has drawn its screen over the app in place: the control unlocks, nothing navigates, and the flow's outcome
// arrives through the state events. A refused or failed kind, or one with no answer within the kit's window for it,
// unlocks the control and keeps the outcome as `failed` (the control, why, and its Retry), which the screen draws in
// place with HopLine (screens/signin/HopLine.tsx), so a tap never ends in nothing.

export type HopStart = HopView;
export type OpenParams<K extends OpenKind> = Omit<SignpageParams[K], "return_key">;

/** The last open that did not happen: its control, why, and a Retry that opens the same kind again. */
export interface HopFailure {
  control: string;
  why: HopWhy;
  retry(): void;
}

export interface ReturnHopView {
  /** Opens `kind` on SIGN_HOST's shell from the screen `view`. Null when an open is already under way (the second tap). */
  hop<K extends OpenKind>(kind: K, params: OpenParams<K>, view: HopStart): Promise<SignpageOutcome<K> | null>;
  /** The control locked now, by its id. */
  locked: string | null;
  /** Nothing to restore: the app never leaves the page (kept for the screens that read it). */
  restored: null;
  /** The last open that did not happen, until the next open, a route change, or its control's dismiss. */
  failed: HopFailure | null;
  /** Clears `failed` when it is `control`'s (its sheet or menu closed). */
  dismiss(control: string): void;
}

const Ctx = createContext<ReturnHopView>({ hop: async () => null, locked: null, restored: null, failed: null, dismiss: () => {} });

export const useReturnHop = () => useContext(Ctx);

export function ReturnHopProvider({ children }: { children: ReactNode }) {
  const { client } = useSignpage();
  const { pathname } = useLocation();
  const [locked, setLocked] = useState<string | null>(null);
  const [failed, setFailed] = useState<HopFailure | null>(null);
  const busy = useRef(false);
  const self = useRef<ReturnHopView["hop"]>(async () => null);

  // a failed open's line belongs to the screen it was tapped on
  useEffect(() => setFailed(null), [pathname]);

  const hop = useCallback(
    async <K extends OpenKind>(kind: K, params: OpenParams<K>, view: HopStart): Promise<SignpageOutcome<K> | null> => {
      if (busy.current) return null;
      busy.current = true;
      setLocked(view.control);
      setFailed(null);
      let o: SignpageOutcome<K> | undefined;
      try {
        o = client
          ? await client.request(kind, { ...params, return_key: RETURN_KEYS[kind] } as SignpageParams[K]).outcome
          : { ok: false, error: { code: SIGNPAGE_CLIENT_CODES.down } };
        return o;
      } finally {
        busy.current = false;
        setLocked(null);
        // every outcome but the shell's screen is shown in place (a throw is a bad request: shown as an error)
        if (!o?.ok) setFailed({ control: view.control, why: o ? hopWhy(o.error.code) : "error", retry: () => void self.current(kind, params, view) });
      }
    },
    [client],
  );
  useEffect(() => {
    self.current = hop;
  }, [hop]);

  const dismiss = useCallback((control: string) => setFailed((f) => (f?.control === control ? null : f)), []);

  return <Ctx.Provider value={{ hop, locked, restored: null, failed, dismiss }}>{children}</Ctx.Provider>;
}
