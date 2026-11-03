import { safetyCells, toneAt } from "./safety.ts";
import type { Icon, RiskRead } from "./safety.ts";
import type { MarketRow } from "../discover/fields.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./trade.css";

// The safety grid under the trade box (R5 token.js U.riskGrid, RiskGrid.tsx at design-lock-r5): 4 x 3 open cells, label
// over value. Its cells are safety.ts; every label is the owner's list (words.ts).

/** A word, marked when it is still the owner's draft. */
function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}

/** R5 P.vi: a circled check or cross (circle r5.1, stroke 1.1), the dev's chef hat, the sniper crosshair; 14 px, in the value's colour. */
function Mark({ icon }: { icon: Icon }) {
  const g = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
      {icon === "sniper" ? (
        <g {...g} strokeWidth="1.3"><circle cx="6" cy="6" r="3.5" /><path d="M6 1v2.5M6 8.5V11M1 6h2.5M8.5 6H11" /></g>
      ) : icon === "dev" ? (
        <g {...g} strokeWidth="1.3"><path d="M3 11V7.6a2.2 2.2 0 0 1 .9-4.3 2.4 2.4 0 0 1 4.2 0A2.2 2.2 0 0 1 9 7.6V11z" /><path d="M3 9h6" /></g>
      ) : (
        <g {...g} strokeWidth="1.1"><circle cx="6" cy="6" r="5.1" /><path d={icon === "x" ? "M4.3 4.3l3.4 3.4M7.7 4.3L4.3 7.7" : "M3.9 6.2l1.5 1.5 2.8-3"} /></g>
      )}
    </svg>
  );
}

export function SafetyGrid({ row, risk, nowMs }: { row: MarketRow; risk?: RiskRead | null; nowMs: number }) {
  const cells = safetyCells(row, risk, nowMs);
  return (
    <div className="rg-grid" data-testid="safety-grid">
      {cells.map((c, i) => (
        <div key={c.id + i} className="rg-cell" data-tone={toneAt(i, c)} data-cell={c.id}>
          <span className="rg-label"><W id={c.id} /></span>
          <span className="rg-value">
            {c.icon && <Mark icon={c.icon} />}
            {c.word ? <W id={c.word} /> : c.text}
          </span>
        </div>
      ))}
    </div>
  );
}
