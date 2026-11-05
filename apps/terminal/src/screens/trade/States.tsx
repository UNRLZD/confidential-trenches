import { buttonTime, endView, isSlow, secs, showsRetry } from "./model.ts";
import type { Phase } from "./model.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";

// What the main button and the line above it draw for a running or ended trade, shared by the buy side (TradeBox)
// and the sell side (src/screens/positions/SellBox.tsx), so both show one set of states: Sending, Landing, Slow past
// 5 s (S8.11), Filled, and for a trade the kit ended one plain line above the button: the reason for the kit's code,
// or Failed (S8.23, S8.32), or Not landed (S8.24, S8.36; CH-050), each with Retry on the button; or the part filled
// (CH-045, S8.35), with the button back to its ready label, since nothing should trade the whole amount again. No
// dialog, ever: the box stays where it is and Retry is one tap.

/** A word, marked when it is still the owner's draft. */
function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
);

/** The state id on the box's root: the brief's where it has one. Null while ready (the box draws its own). */
export function stateId(p: Phase, now: number, side: "buy" | "sell"): string | null {
  if (p.k === "sending" || p.k === "landing") return isSlow(p, now) ? "S8.11" : side === "buy" ? (p.k === "sending" ? "S8.9" : "S8.10") : "S8.30";
  if (p.k === "filled") return side === "buy" ? "S8.12" : "filled";
  const v = endView(p);
  if (!v) return null;
  if (v.k === "failed") return side === "buy" ? "S8.23" : "S8.32";
  if (v.k === "notLanded") return side === "buy" ? "S8.24" : "S8.36";
  return side === "buy" ? "partial" : "S8.35";
}

/** The main button draws RunLabel, not its own ready label: a trade runs, filled, or ended where Retry shows. */
export const hasRunLabel = (p: Phase): boolean => p.k !== "ready" && (p.k !== "ended" || showsRetry(p));

/** The main button's label for a running, filled or ended trade; null where the box draws its ready label. */
export function RunLabel({ phase, now, final = false }: { phase: Phase; now: number; final?: boolean }) {
  if (phase.k === "sending" || phase.k === "landing") {
    if (isSlow(phase, now)) {
      const t = secs(now - phase.at);
      return (
        <>
          <W id="slow" />&nbsp;<span className="trb-live" data-time={t}>{t}</span>
        </>
      );
    }
    if (phase.k === "sending") return <W id="sending" />;
    const t = buttonTime(phase, now);
    return (
      <>
        <W id="landing" />&nbsp;<span className="trb-live" data-time={t}>{t}</span>
      </>
    );
  }
  if (phase.k === "filled") {
    const t = buttonTime(phase, now);
    return (
      <>
        <Check />&nbsp;<W id="filled" />&nbsp;<span data-time={t}>{t}</span>
        {final && (
          <span className="trb-final" data-testid="trade-final">
            <W id="final" />
          </span>
        )}
      </>
    );
  }
  if (phase.k === "ended" && showsRetry(phase)) return <W id="retry" />;
  return null;
}

/** The kit's count of a part fill's slices (not in the kit yet: TradeKit.part), when it gives one. */
export interface PartCount {
  filled: number;
  of: number;
}

/** The one plain line for an ended trade, above the main button; null otherwise. */
export function EndLine({ phase, side, part }: { phase: Phase; side: "buy" | "sell"; part: PartCount | null }) {
  const v = endView(phase);
  if (!v) return null;
  let body;
  if (v.k === "failed") body = <W id={v.reason ?? "failed"} />;
  else if (v.k === "notLanded") body = <W id="notLanded" />;
  else if (part)
    body = (
      <>
        {part.filled}/{part.of} <W id={side === "buy" ? "filledOf" : "soldOf"} />
      </>
    );
  else body = <W id={side === "buy" ? "partFilled" : "partSold"} />;
  return (
    <span className="trb-end" data-end={v.k} data-testid="trade-end">
      {body}
    </span>
  );
}
