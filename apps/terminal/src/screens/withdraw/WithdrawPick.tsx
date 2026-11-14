import { createContext, useCallback, useContext } from "react";
import type { ReactNode } from "react";
import type { HopView } from "../../shell/return-hop.ts";
import { useDepositSheet } from "../deposit/source.tsx";

// Every Withdraw in the app opens through here (card withdraw-address-in-the-app, owner 14 Nov 12:22Z picked A): the
// deposit sheet on its Withdraw segment (WithdrawForm.tsx), where the place, the amount and the address are typed in the
// app; `from` picks a place (a pool row's chain), else the first that holds money. A screen drawn with no provider (the
// screen fixtures) opens its own fallback.

type Opened = Promise<{ ok: boolean } | null>;
type Open = (view: HopView, fallback: () => Opened, from?: string) => Opened;
const Ctx = createContext<Open | null>(null);

/** Opens the app's Withdraw; `fallback` is the screen's own open, used only with no provider. */
export function useWithdrawOpen(): Open {
  const open = useContext(Ctx);
  return useCallback<Open>((view, fallback, from) => (open ? open(view, fallback, from) : fallback()), [open]);
}

export function WithdrawPickProvider({ children }: { children: ReactNode }) {
  const { openWithdraw } = useDepositSheet();
  const open = useCallback<Open>(
    (_view, _fallback, from) => {
      openWithdraw(from ?? null);
      return Promise.resolve({ ok: true });
    },
    [openWithdraw],
  );
  return <Ctx.Provider value={open}>{children}</Ctx.Provider>;
}
