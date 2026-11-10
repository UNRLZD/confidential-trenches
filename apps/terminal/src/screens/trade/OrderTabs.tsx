import type { ReactNode } from "react";

// The ticket's order tabs, Market, Limit and TP/SL (R5 token.js U.ticket; 09-design-brief S8 Order tabs), on the buy and
// the sell side (card app-orders-coming-soon). Orders are out of the plan for now (owner 10 Nov, owner-decisions row
// "Order of the returned feature groups"): Limit and TP/SL open and draw `Coming soon` in the box's place, in the app's
// empty-state style, with no order control; Market draws the box. Nothing here asks for an order. While a trade runs
// the other tabs are off, so the run's own state stays on screen.

export type OrderTab = "market" | "limit" | "tpsl";
type Id = "market" | "limit" | "tpsl" | "soon";
type Word = (p: { id: Id }) => ReactNode;

const TABS = ["market", "limit", "tpsl"] as const;

export function OrderTabs({ tab, setTab, running, W }: { tab: OrderTab; setTab(t: OrderTab): void; running: boolean; W: Word }) {
  return (
    <div className="trb-tabs" role="tablist">
      {TABS.map((k) => (
        <button key={k} type="button" role="tab" className="trb-tab" aria-selected={tab === k} disabled={running && tab !== k} data-tab={k} onClick={() => setTab(k)}>
          <W id={k} />
        </button>
      ))}
    </div>
  );
}

/** A tab whose orders are not built yet: the one label, in the box's place. */
export function OrdersSoon({ place, W }: { place: string; W: Word }) {
  return (
    <div className="trb-soon" role="tabpanel" data-testid="orders-soon" data-place={place}>
      <W id="soon" />
    </div>
  );
}
