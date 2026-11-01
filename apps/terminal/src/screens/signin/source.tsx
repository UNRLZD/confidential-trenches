import type { SignpageClientSnapshot } from "@blindfill/kit";
import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { useReturnHop } from "../../shell/ReturnHop.tsx";
import type { ReturnHopView } from "../../shell/ReturnHop.tsx";
import { useSignpage } from "../../shell/signpage-frame.tsx";

// What the sign-in screens read and do: the signing page's snapshot, the hop to SIGN_HOST's top-level pages, and the
// `restore` request. In the app it is the shell's client and hop; the screen tests pass fixtures through
// SigninSourceProvider, so the same components draw every state with no signing page.

export interface SigninSource {
  snapshot: SignpageClientSnapshot;
  moneyOn: boolean;
  hop: ReturnHopView["hop"];
  locked: string | null;
  restored: ReturnHopView["restored"];
  /** Starts (or starts again) the rebuild from the chain; its progress comes back in `state.ops`. */
  restore(): void;
}

const Fixture = createContext<SigninSource | null>(null);

export const SigninSourceProvider = Fixture.Provider;

export function useSigninSource(): SigninSource {
  const fixture = useContext(Fixture);
  const { client, snapshot, moneyOn } = useSignpage();
  const { hop, locked, restored } = useReturnHop();
  const restore = useCallback(() => void client?.request("restore", {}), [client]);
  return fixture ?? { snapshot, moneyOn, hop, locked, restored, restore };
}

// The sheet's open state, shared by the header's Sign in (desktop and phone) and the one sheet the shell mounts.
interface SheetView {
  open: boolean;
  setOpen(open: boolean): void;
}

const Sheet = createContext<SheetView>({ open: false, setOpen: () => {} });

export const useSigninSheet = () => useContext(Sheet);

export function SigninSheetProvider({ children, initial = false }: { children: ReactNode; initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return <Sheet.Provider value={{ open, setOpen }}>{children}</Sheet.Provider>;
}
