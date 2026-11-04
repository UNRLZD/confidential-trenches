import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { hopGate } from "./hop-gate.ts";
import type { Hop, HopFailure } from "./hop-gate.ts";
import { useSignpage } from "./signpage-frame.tsx";

// Opening one of the five open kinds on SIGN_HOST's shell (return-hop.ts). A screen calls hop(kind, params, view): the
// tapped control is locked at once, in hop() itself (hop-gate.ts), and a second tap does nothing; the kind is posted to
// the shell. The shell's ok means the flow is set up and its screen is coming over the app in place: the lock holds
// until that screen takes this frame, nothing navigates, and the flow's outcome arrives through the state events. A
// refused or failed kind, or one with no answer within the kit's window for it, unlocks the control and keeps the
// outcome as `failed` (the control, why, and its Retry), which the screen draws in place with HopLine
// (screens/signin/HopLine.tsx), so a tap never ends in nothing.

export interface ReturnHopView {
  /** Opens `kind` on SIGN_HOST's shell from the screen `view`. Null when an open is already under way (the second tap). */
  hop: Hop;
  /** The control locked now, by its id. */
  locked: string | null;
  /** The last open that did not happen, until the next open, a route change, or its control's dismiss. */
  failed: HopFailure | null;
  /** Clears `failed` when it is `control`'s (its sheet or menu closed). */
  dismiss(control: string): void;
}

const Ctx = createContext<ReturnHopView>({ hop: async () => null, locked: null, failed: null, dismiss: () => {} });

export const useReturnHop = () => useContext(Ctx);

export function ReturnHopProvider({ children }: { children: ReactNode }) {
  const { client } = useSignpage();
  const { pathname } = useLocation();
  const [locked, setLocked] = useState<string | null>(null);
  const [failed, setFailed] = useState<HopFailure | null>(null);

  // a failed open's line belongs to the screen it was tapped on
  useEffect(() => setFailed(null), [pathname]);

  const gate = useMemo(
    () =>
      hopGate({
        request: client ? (kind, params) => client.request(kind, params).outcome : null,
        lock: setLocked,
        fail: setFailed,
        after: (ms, fn) => {
          const t = setTimeout(fn, ms);
          return () => clearTimeout(t);
        },
      }),
    [client],
  );
  useEffect(() => gate.stop, [gate]);
  const hop = gate.hop;

  const dismiss = useCallback((control: string) => setFailed((f) => (f?.control === control ? null : f)), []);

  return <Ctx.Provider value={{ hop, locked, failed, dismiss }}>{children}</Ctx.Provider>;
}
