// Discover's toolbar parts (card app-discover-toolbar), drawn after design-lock-r5 discover-1440.html (Toolbar.tsx's
// presets, chips, launchpad chip and menu, the Quick buy field; Column.tsx's search) and discover-390.html (the chips row,
// Pause, the Quick buy dock). The rules they run are view.ts's; the words are words.ts's.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { chainOf, padOf } from "../market/pads.ts";
import type { PadEntry, Preset, View } from "./view.ts";
import { qbAmount } from "./view.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";

/** The owner's words only (a draft is drawn by Discover.tsx's W, the one place that marks one, and handed in). */
// the drafts (words.ts DRAFTS, held by discover-screens.test.ts) are left out by name
type FinalId = Exclude<WordId, "updated" | "padMenuTitle">;
export const T = ({ id }: { id: FinalId }) => <>{WORDS[id].text}</>;

/** R5 app.js P.ic (UNRLZD ICON_PATHS) at its 12-unit box. */
const PATHS: Record<string, ReactNode> = {
  all: (
    <>
      <rect x="1.5" y="1.5" width="3.5" height="3.5" rx="0.8" />
      <rect x="7" y="1.5" width="3.5" height="3.5" rx="0.8" />
      <rect x="1.5" y="7" width="3.5" height="3.5" rx="0.8" />
      <rect x="7" y="7" width="3.5" height="3.5" rx="0.8" />
    </>
  ),
  flag: <path d="M2.5 11V1.5M2.5 2h6.5l-1.5 2.2L9 6.5H2.5" />,
  chevDown: <path d="M3 4.5l3 3 3-3" />,
  search: (
    <>
      <circle cx="5.2" cy="5.2" r="3.7" />
      <path d="M8 8l2.8 2.8" />
    </>
  ),
  close: <path d="M3 3l6 6M9 3L3 9" />,
  check: <path d="M2.5 6.2l2.3 2.3 4.7-5" />,
  shield: <path d="M6 1.2l4 1.6v3c0 2.4-1.7 4.2-4 5-2.3-.8-4-2.6-4-5v-3z" />,
  pause: <path d="M4 2.5v7M8 2.5v7" />,
};

export function Ic({ k, size = 12 }: { k: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{PATHS[k]}</g>
    </svg>
  );
}

/** R5 P.bolt: Discover's filled bolt. */
export const Bolt = () => (
  <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
    <path d="M7 0.5L1 8h4l-1 5.5L11 6H7z" fill="currentColor" />
  </svg>
);

const PRESETS: readonly [Preset, FinalId, keyof typeof PATHS][] = [
  ["all", "all", "all"],
  ["fewer_flags", "fewerFlags", "flag"],
];

/** The presets: R5's segmented control on the desktop, its chips on the phone. One at a time. */
export function Presets({ view, onView, phone }: { view: View; onView: (v: View) => void; phone?: boolean }) {
  return (
    <div className={phone ? "dsc-mpresets" : "dsc-seg"} role="group" data-testid={phone ? "m-presets" : "presets"}>
      {PRESETS.map(([p, w, ic]) => (
        <button key={p} type="button" className={phone ? "dsc-mchip" : "dsc-segi"} data-on={view.preset === p} aria-pressed={view.preset === p} data-preset={p} onClick={() => onView({ ...view, preset: p })}>
          {!phone && <Ic k={ic} />}
          <T id={w} />
        </button>
      ))}
    </div>
  );
}

/** The launchpad menu (R5 PadMenu): each launchpad on the lists now, per chain, its logo, name, chain mark and count. */
export function PadMenu({ entries, view, onView, onClose, title }: { entries: readonly PadEntry[]; view: View; onView: (v: View) => void; onClose: () => void; title: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest("[data-pad-chip]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const toggle = (k: string) => onView({ ...view, pads: view.pads.includes(k) ? view.pads.filter((p) => p !== k) : [...view.pads, k] });
  return (
    <div ref={ref} className="dsc-padmenu" role="menu" aria-label={WORDS.launchpads.text} data-testid="launchpad-menu">
      <div className="dsc-padhead">
        <span className="dsc-padtitle">{title}</span>
        <button type="button" className="dsc-padclear" disabled={!view.pads.length} onClick={() => onView({ ...view, pads: [] })} data-testid="launchpad-clear"><T id="clear" /></button>
      </div>
      <div className="dsc-padlist">
        {entries.map((e) => {
          const p = padOf(e.launchpad)!;
          const c = chainOf(e.chain);
          const on = view.pads.includes(e.key);
          return (
            <button key={e.key} type="button" role="menuitemcheckbox" aria-checked={on} className="dsc-padrow" data-pad={e.key} onClick={() => toggle(e.key)}>
              <span className="dsc-padbox">{on && <Ic k="check" size={10} />}</span>
              <img className="dsc-padicon" src={p.logo} width="16" height="16" alt="" />
              <span className="dsc-padname">{p.name}</span>
              {c && <img className="dsc-padchain" src={c.logo} width="12" height="12" alt={c.name} title={c.name} />}
              <span className="dsc-padcount">{e.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The launchpad chip and its menu; `phone` draws R5's phone chip. */
export function PadChip({ entries, view, onView, phone, title }: { entries: readonly PadEntry[]; view: View; onView: (v: View) => void; phone?: boolean; title: ReactNode }) {
  const [open, setOpen] = useState(false);
  const n = view.pads.length;
  return (
    <div className={phone ? "dsc-mpad" : "dsc-pad"}>
      <button type="button" className={phone ? "dsc-mchip" : "dsc-chip"} data-on={n > 0} aria-pressed={n > 0} aria-expanded={open} aria-haspopup="menu" data-pad-chip="" data-testid={phone ? "m-chip-launchpad" : "chip-launchpad"} onClick={() => setOpen((o) => !o)}>
        {!phone && <Ic k="all" />}
        <T id="launchpad" />
        {n > 0 && <span className="dsc-suffix">{n}</span>}
        {!phone && <Ic k="chevDown" size={10} />}
      </button>
      {open && <PadMenu entries={entries} view={view} onView={onView} onClose={() => setOpen(false)} title={title} />}
    </div>
  );
}

/** R5's Quick buy field: the bolt, the label, the amount in USD; an amount that is not one is flagged and not kept. */
export function QuickBuyField({ amount, onAmount }: { amount: string; onAmount: (a: string) => void }) {
  const [text, setText] = useState(amount);
  useEffect(() => setText(amount), [amount]);
  const bad = qbAmount(text) === null;
  return (
    <label className="dsc-qb" data-bad={bad} data-testid="discover-qb">
      <span className="dsc-qbbolt"><Bolt /></span>
      <span className="dsc-qblabel"><T id="quickBuy" /></span>
      <input
        className="dsc-qbinput"
        value={text}
        inputMode="decimal"
        autoComplete="off"
        aria-label={WORDS.qbAmount.text}
        aria-invalid={bad}
        data-testid="discover-qb-amount"
        onChange={(e) => {
          setText(e.target.value);
          if (qbAmount(e.target.value) !== null) onAmount(e.target.value.trim());
        }}
        onBlur={() => bad && setText(amount)}
      />
      <span className="dsc-qbunit"><T id="usd" /></span>
    </label>
  );
}

/** The phone's Quick buy dock (R5 Dock.tsx): the bar shows the amount; a tap opens the same field above it. */
export function Dock({ amount, onAmount }: { amount: string; onAmount: (a: string) => void }) {
  const [open, setOpen] = useState(false);
  const n = qbAmount(amount);
  return (
    <div className="dsc-dock" data-testid="m-dock">
      {open && (
        <div className="dsc-dockpanel" data-testid="m-dock-panel">
          <QuickBuyField amount={amount} onAmount={onAmount} />
        </div>
      )}
      <button type="button" className="dsc-dockbar" aria-expanded={open} data-testid="m-dock-bar" onClick={() => setOpen((o) => !o)}>
        <span className="dsc-qbbolt"><Bolt /></span>
        <span className="dsc-docktitle"><T id="quickBuy" /></span>
        <span className="dsc-dockamt" data-testid="m-dock-amount">${n === null ? amount : String(n)}</span>
        <span className="dsc-dockpre">
          <svg className="dsc-chev" width="9" height="9" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 5l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
        </span>
      </button>
    </div>
  );
}

/** R5 discover-390.html's Pause and Resume icons. */
export const PauseIcon = ({ on }: { on: boolean }) => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
    {on ? <path d="M3 2l7 4-7 4z" fill="currentColor" /> : (
      <g fill="currentColor">
        <rect x="2.5" y="2" width="2.5" height="8" rx="0.8" />
        <rect x="7" y="2" width="2.5" height="8" rx="0.8" />
      </g>
    )}
  </svg>
);

/** The column's search (R5 S5.14): the field in the column head, cleared and closed by its button or Escape. */
export function ColSearch({ title, q, onQ, onClose }: { title: string; q: string; onQ: (q: string) => void; onClose: () => void }) {
  return (
    <div className="dsc-csearch">
      <Ic k="search" size={14} />
      <input
        className="dsc-csinput"
        autoFocus
        value={q}
        placeholder={WORDS.search.text}
        aria-label={`${WORDS.search.text} ${title}`}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <button type="button" className="dsc-hb" aria-label={WORDS.clearSearch.text} onClick={onClose}>
        <Ic k="close" />
      </button>
    </div>
  );
}
