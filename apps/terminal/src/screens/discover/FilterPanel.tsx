// Discover's column filter panel (card app-discover-filter-panel), drawn after design-lock-r5 discover-ui.js
// P.filterPanel: a panel under the column head on the desktop (discover-1440.html S5.12), a sheet over a scrim on the
// phone (discover-390.html S5.12). Head: Filters and the column's name, Close. Body: Launchpad (per chain), Curve
// (Graduating only), Metrics, Audit. Foot: where filters run, the tokens left, Reset. The rules are filters.ts's; the words
// are words.ts's. Changes apply as they are made: there is no confirm and no pop-up.
import { useEffect, useRef, useState } from "react";
import type { MarketSnapshot } from "./fields.ts";
import type { ColumnKey } from "./model.ts";
import { boundText, COL_FILTER0, controlsFor, panelPads, parseBound, servedOn } from "./filters.ts";
import type { ColFilter, Control, Range } from "./filters.ts";
import { chainOf, padOf } from "../market/pads.ts";
import { Ic, T } from "./Toolbar.tsx";
import { WORDS } from "./words.ts";
import { DASH } from "./format.ts";

/** One Min or Max box: the bound as R5 draws it ($10K, 25%, 5m), which is also a text it reads back, so focusing the box
 *  changes nothing on it; the typed text while it is edited; a text that is not an amount is flagged and changes
 *  nothing, and empty unsets the bound. */
function Bound({ v, c, which, onSet }: { v: number | undefined; c: Control; which: "min" | "max"; onSet: (v: number | undefined) => void }) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseBound(text, c.unit) === undefined;
  return (
    <input
      className="dsc-fin"
      data-set={v !== undefined}
      data-bad={bad}
      aria-invalid={bad}
      aria-label={`${WORDS[c.label].text} ${WORDS[which].text}`}
      placeholder={WORDS[which].text}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      data-testid={`filter-${c.k}-${which}`}
      value={text ?? (v === undefined ? "" : boundText(v, c.unit))}
      onChange={(e) => {
        setText(e.target.value);
        const p = parseBound(e.target.value, c.unit);
        if (p !== undefined) onSet(p ?? undefined);
      }}
      onBlur={() => setText(null)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

export function FilterPanel({
  col, title, snapshot, filter, onFilter, count, phone, onClose,
}: {
  col: ColumnKey; title: string; snapshot: MarketSnapshot | null; filter: ColFilter; onFilter: (f: ColFilter) => void;
  count: number | null; phone?: boolean; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest("[data-filter-btn]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const setRange = (c: Control, which: "min" | "max", v: number | undefined) => {
    const r: Range = { ...filter.ranges[c.k] };
    if (v === undefined) delete r[which];
    else r[which] = v;
    const ranges = { ...filter.ranges };
    if (r.min === undefined && r.max === undefined) delete ranges[c.k];
    else ranges[c.k] = r;
    onFilter({ ...filter, ranges });
  };
  const togglePad = (k: string) => onFilter({ ...filter, pads: filter.pads.includes(k) ? filter.pads.filter((p) => p !== k) : [...filter.pads, k] });

  const row = (c: Control) => {
    const s = snapshot ? servedOn(snapshot, c) : null;
    const hover = s && !s.all && s.chains.length ? s.chains.map((x) => chainOf(x)?.name ?? x).join(", ") : undefined;
    const v = filter.ranges[c.k] ?? {};
    return (
      <div key={c.k} className="dsc-fr" data-field={c.fields.join("+")} data-control={c.k} title={hover}>
        <span className="dsc-fk">{WORDS[c.label].text}</span>
        <Bound v={v.min} c={c} which="min" onSet={(x) => setRange(c, "min", x)} />
        <span className="dsc-fdash">–</span>
        <Bound v={v.max} c={c} which="max" onSet={(x) => setRange(c, "max", x)} />
      </div>
    );
  };
  const controls = controlsFor(col);
  const groups = snapshot ? panelPads(snapshot, col, filter.pads) : [];
  return (
    <div ref={ref} className={phone ? "dsc-fpanel ph" : "dsc-fpanel"} role="dialog" aria-label={WORDS.filters.text} data-testid="discover-filters" data-col={col}>
      <div className="dsc-fhd">
        <span className="dsc-ft"><T id="filters" /></span>
        <span className="dsc-fcol">{title}</span>
        <span className="dsc-grow" />
        <button type="button" className="dsc-fx" aria-label={WORDS.close.text} data-testid="filters-close" onClick={onClose}>
          <Ic k="close" />
        </button>
      </div>
      <div className="dsc-fbody">
        {groups.length > 0 && (
          <div className="dsc-fsec" data-sec="launchpad">
            <div className="dsc-fst"><T id="launchpad" /></div>
            {groups.map((g) => {
              const cm = chainOf(g.chain);
              return (
                <div key={g.chain} className="dsc-fpc">
                  <span className="dsc-fpch">
                    {cm && <img className="dsc-fcmark" src={cm.logo} width="12" height="12" alt="" />}
                    {cm?.name ?? g.chain}
                  </span>
                  <div className="dsc-fpadlist">
                    {g.entries.map((e) => {
                      const p = padOf(e.launchpad)!;
                      const on = filter.pads.includes(e.key);
                      return (
                        <button key={e.key} type="button" role="menuitemcheckbox" aria-checked={on} className="dsc-padrow" data-pad={e.key} onClick={() => togglePad(e.key)}>
                          <span className="dsc-padbox">{on && <Ic k="check" size={10} />}</span>
                          <img className="dsc-padicon" src={p.logo} width={phone ? 20 : 16} height={phone ? 20 : 16} alt="" />
                          <span className="dsc-padname">{p.name}</span>
                          <span className="dsc-padcount">{e.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {col === "graduating" && (
          <div className="dsc-fsec" data-sec="curve">
            <div className="dsc-fst"><T id="curve" /></div>
            {controls.filter((c) => c.section === "curve").map(row)}
          </div>
        )}
        <div className="dsc-fsec" data-sec="metrics">
          <div className="dsc-fst"><T id="metrics" /></div>
          {controls.filter((c) => c.section === "metrics").map(row)}
        </div>
        <div className="dsc-fsec" data-sec="audit">
          <div className="dsc-fst"><T id="audit" /></div>
          {controls.filter((c) => c.section === "audit").map(row)}
        </div>
      </div>
      <div className="dsc-ffoot">
        <span className="dsc-fdev"><T id="onDevice" /></span>
        <span className="dsc-grow" />
        <span className="dsc-fn" data-testid="filters-count">
          {count === null ? DASH : count === 0 ? <T id="noResults" /> : <>{count} <T id={count === 1 ? "token" : "tokens"} /></>}
        </span>
        <button type="button" className="dsc-freset" data-testid="filters-reset" onClick={() => onFilter(COL_FILTER0)}>
          <T id="reset" />
        </button>
      </div>
    </div>
  );
}
