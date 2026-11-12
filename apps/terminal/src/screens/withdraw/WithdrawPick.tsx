import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { useReturnHop } from "../../shell/ReturnHop.tsx";
import type { HopView } from "../../shell/return-hop.ts";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import { HopLine } from "../signin/HopLine.tsx";
import { Icon } from "../signin/Icon.tsx";
import { chainOf } from "../market/pads.ts";
import { withdrawOpen } from "./target.ts";
import type { WithdrawPlace } from "./target.ts";
import { WORDS } from "./words.ts";
import "../deposit/deposit.css";
import "./withdraw.css";
import "../../shell/search.css";

// Every Withdraw in the app opens through here (card withdraw-form-shows-what-you-can-send, ./target.ts): the form of the
// place that holds the money, or, with money in several, a pick of them over the app (the deposit sheet's box), each a
// row of its chain's mark and its balance with its symbol, no words. A row opens that place's form, locked and failed as
// the tapped Withdraw (its control). A screen drawn with no provider (the screen fixtures) opens its own fallback.

type Opened = Promise<{ ok: boolean } | null>;
type Open = (view: HopView, fallback: () => Opened) => Opened;
const Ctx = createContext<Open | null>(null);

/** Opens the withdraw form for the money's place; `fallback` is the screen's own open, used only with no provider. */
export function useWithdrawOpen(): Open {
  const open = useContext(Ctx);
  return useCallback<Open>((view, fallback) => (open ? open(view, fallback) : fallback()), [open]);
}

const opener = (hop: ReturnType<typeof useReturnHop>["hop"], place: WithdrawPlace | null, view: HopView): Opened =>
  place?.kind === "pool.withdraw" ? hop("pool.withdraw", { chain: place.chain }, view) : hop("withdraw.open", {}, view);

export function WithdrawPickProvider({ children }: { children: ReactNode }) {
  const { snapshot } = useSignpage();
  const { hop, locked } = useReturnHop();
  const [pick, setPick] = useState<{ view: HopView; places: WithdrawPlace[] } | null>(null);
  const open = useCallback<Open>(
    (view) => {
      const o = withdrawOpen(snapshot.state);
      if (o.to !== "pick") return opener(hop, o.place, view);
      setPick({ view, places: o.places });
      return Promise.resolve({ ok: true });
    },
    [snapshot.state, hop],
  );
  const close = () => setPick(null);
  return (
    <Ctx.Provider value={open}>
      {children}
      {pick && <WithdrawPickSheet places={pick.places} locked={locked} control={pick.view.control} onPick={(p) => (void opener(hop, p, pick.view), close())} onClose={close} />}
    </Ctx.Provider>
  );
}

/** The pick over the app: one row per place, its chain's mark, name and balance with its symbol; the x and the scrim close it. */
export function WithdrawPickSheet({ places, locked, control, onPick, onClose }: { places: readonly WithdrawPlace[]; locked: string | null; control: string; onPick(p: WithdrawPlace): void; onClose(): void }) {
  return (
    <div className="dep wpk" data-sheet="withdraw-pick">
      <div className="dep-scrim" onClick={onClose} />
      <aside className="dep-box" aria-label={WORDS.withdraw.text}>
        <div className="grab"><i /></div>
        <div className="dhd">
          <span />
          <button type="button" className="dep-x" aria-label={WORDS.close.text} onClick={onClose}>
            <Icon name="x" size={14} stroke={1.4} />
          </button>
        </div>
        <div className="dbody">
          {places.map((p) => {
            const m = chainOf(p.chain);
            return (
              <button type="button" key={p.chain} className="wpk-row" data-place={p.chain} data-kind={p.kind} disabled={locked !== null} onClick={() => onPick(p)}>
                {m && (
                  <span className="srch-cm" style={{ width: 24, height: 24, padding: Math.round(24 * m.inset) }}>
                    <img src={m.logo} alt="" />
                  </span>
                )}
                <span className="ell">{m?.name ?? p.chain}</span>
                <span className="num">{p.balance} <span className="t3">{p.symbol}</span></span>
              </button>
            );
          })}
          <HopLine control={control} />
        </div>
      </aside>
    </div>
  );
}
