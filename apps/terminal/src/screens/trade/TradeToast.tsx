import { showsRetry } from "./model.ts";
import { EndLine, RunLabel, stateId } from "./States.tsx";
import { TradeFillToast } from "./TradeBox.tsx";
import type { Trade } from "./TradeBox.tsx";
import { toastView } from "./toast.ts";
import "./trade.css";

// The phone token page's toast (card app-quick-buy-one-tap; 09-design-brief F14 step 2): a quick-buy chip's buy runs with
// the sheet closed, so this toast over the page draws it, in the box's own words and states (States.tsx): Sending,
// Landing with its time, Slow, then the fill toast (S8.12); or the end the kit gave (Price check failed, Not sent,
// Failed, Not landed, part filled), with Retry where the box draws it, one tap, the same amount through the same buy. A
// tap on an ended toast closes it. No dialog, no confirm.
export function TradeToast({ t, symbol, sheetOpen }: { t: Trade; symbol: string; sheetOpen: boolean }) {
  const { phase, dismissed, setDismissed, amount, buy, src } = t;
  const view = toastView(phase, dismissed, sheetOpen);
  if (view === null || phase.k === "ready") return null;
  if (view === "fill") return <TradeFillToast t={t} symbol={symbol} />;
  const now = src.now();
  const ended = view === "end";
  return (
    <div className="rs-toast qt" role="status" data-shown data-state={stateId(phase, now, "buy") ?? undefined} data-testid="quick-toast" onClick={() => ended && setDismissed(phase.id)}>
      <div className="rs-toastBody">
        <span className="rs-toastTitle">{symbol}</span>
        <span className="rs-toastLine" data-testid="quick-toast-line">
          {ended ? <EndLine phase={phase} side="buy" part={src.kit.part?.(phase.id) ?? null} /> : <RunLabel phase={phase} now={now} />}
        </span>
      </div>
      {ended && showsRetry(phase) && (
        <button
          type="button"
          className="qt-retry"
          data-testid="quick-retry"
          onClick={(e) => {
            e.stopPropagation();
            if (amount !== null) buy(amount);
          }}
        >
          <RunLabel phase={phase} now={now} />
        </button>
      )}
    </div>
  );
}
