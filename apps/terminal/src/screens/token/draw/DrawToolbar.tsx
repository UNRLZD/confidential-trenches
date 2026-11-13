/**
 * The chart's left drawing toolbar, the live UNRLZD terminal's (chart/draw/DrawToolbar.tsx there; owner 12 Nov: chart
 * drawing tools on par; there TradingView / GMGN parity, user request 2026-09-30): cursor (crosshair modes) · line tools · shapes (fib, rectangle, measure)
 * · marks (text note, arrows) · magnet · lock all · hide all · delete all. Groups that don't fit
 * the chart's height fold into one flyout button each (tools.ts foldedGroups). Phones / touch:
 * the column collapses behind one toggle floating over the chart (CSS).
 */
import type { Chart } from "klinecharts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WORDS } from "../words.ts";
import { ToolIcon } from "./icons.tsx";
import type { ToolIconName } from "./icons.tsx";
import { drawStore, useDraw } from "./store.ts";
import { CROSS_MODES, DRAW_TOOLS, foldedGroups, GAP_PX, MAGNET_LABEL, nextMagnet } from "./tools.ts";
import type { CrossMode, DrawTool, FoldGroup } from "./tools.ts";
import { useDrawings } from "./useDrawings.ts";
import type { NoteEditor } from "./useDrawings.ts";
import "./draw.css";

export interface DrawToolbarProps {
  chart: Chart | null;
  tokenId: string;
  /** the chart's price factor for the unit drawn (units.ts factors): drawings are saved in the helper's own unit */
  scale?: number;
  /** phone layout (collapsible, floating) regardless of the media query */
  compact?: boolean;
}

type Flyout = "cross" | FoldGroup;

const GROUP_ICON: Record<FoldGroup, ToolIconName> = {
  lines: "lines",
  shapes: "rect",
  marks: "text",
};
const GROUP_LABEL: Record<FoldGroup, string> = {
  lines: WORDS.dLines.text,
  shapes: WORDS.dShapes.text,
  marks: WORDS.dMarks.text,
};
const CROSS_ICON: Record<CrossMode, ToolIconName> = { cross: "cross", dot: "dot", arrow: "arrow" };

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function DrawToolbar({ chart, tokenId, scale = 1, compact = false }: DrawToolbarProps) {
  const d = useDrawings(chart, tokenId, scale);
  const active = useDraw("active");
  const cross = useDraw("cross");
  const magnet = useDraw("magnet");
  const lockAll = useDraw("lockAll");
  const hideAll = useDraw("hideAll");
  const open = useDraw("open");
  const set = drawStore.set;
  const root = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<Set<FoldGroup>>(() => new Set(["lines"]));
  const [fly, setFly] = useState<{ g: Flyout; top: number } | null>(null);

  // fold groups to the column's height (buttons 28px + 2px gap; 32px on touch)
  useLayoutEffect(() => {
    const el = col.current;
    if (!el) return;
    const refold = () => {
      const step = (coarse() ? 32 : 28) + GAP_PX;
      const next = foldedGroups(el.clientHeight || 400, step);
      setFolded((cur) =>
        cur.size === next.size && [...next].every((g) => cur.has(g)) ? cur : next,
      );
    };
    refold();
    const ro = new ResizeObserver(refold);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // close a flyout on an outside press / Escape
  useEffect(() => {
    if (!fly) return;
    const off = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)
      )
        setFly(null);
    };
    document.addEventListener("pointerdown", off, true);
    document.addEventListener("keydown", off, true);
    return () => {
      document.removeEventListener("pointerdown", off, true);
      document.removeEventListener("keydown", off, true);
    };
  }, [fly]);

  const toggleFly = (g: Flyout, btn: HTMLElement) =>
    setFly((f) => (f?.g === g ? null : { g, top: btn.offsetTop - (col.current?.scrollTop ?? 0) }));

  const toolBtn = (t: DrawTool, inFly = false) => (
    <button
      key={t.id}
      type="button"
      className={inFly ? "ctd-flyitem" : "ctd-btn"}
      data-on={active === t.id}
      data-testid={`draw-tool-${t.id}`}
      title={t.label}
      aria-label={t.label}
      aria-pressed={active === t.id}
      onClick={() => {
        setFly(null);
        d.start(t.id);
      }}
    >
      <ToolIcon name={t.icon} />
      {inFly && <span>{t.label}</span>}
    </button>
  );

  const group = (g: FoldGroup) => {
    const tools = DRAW_TOOLS.filter((t) => t.group === g);
    if (!folded.has(g)) return tools.map((t) => toolBtn(t));
    const cur = tools.find((t) => t.id === active);
    return (
      <button
        key={g}
        type="button"
        className="ctd-btn"
        data-on={!!cur}
        data-testid={`draw-group-${g}`}
        title={GROUP_LABEL[g]}
        aria-label={GROUP_LABEL[g]}
        aria-expanded={fly?.g === g}
        onClick={(e) => toggleFly(g, e.currentTarget)}
      >
        <ToolIcon name={cur ? cur.icon : GROUP_ICON[g]} />
        <span className="ctd-corner" aria-hidden="true" />
      </button>
    );
  };

  return (
    <div
      ref={root}
      className="ctd-bar"
      data-testid="draw-toolbar"
      data-open={open}
      data-compact={compact}
    >
      <button
        type="button"
        className="ctd-btn ctd-toggle"
        data-testid="draw-toggle"
        title={open ? WORDS.dHideTools.text : WORDS.dTools.text}
        aria-label={open ? WORDS.dHideTools.text : WORDS.dTools.text}
        aria-expanded={open}
        onClick={() => {
          setFly(null);
          set({ open: !open });
        }}
      >
        <ToolIcon name="pencil" />
      </button>
      <div ref={col} className="ctd-col">
        <button
          type="button"
          className="ctd-btn"
          data-testid="draw-cursor"
          title={WORDS.dCrosshair.text}
          aria-label={WORDS.dCrosshair.text}
          aria-expanded={fly?.g === "cross"}
          onClick={(e) => toggleFly("cross", e.currentTarget)}
        >
          <ToolIcon name={CROSS_ICON[cross]} />
          <span className="ctd-corner" aria-hidden="true" />
        </button>
        <span className="ctd-sep" />
        {group("lines")}
        <span className="ctd-sep" />
        {group("shapes")}
        <span className="ctd-sep" />
        {group("marks")}
        <span className="ctd-sep" />
        <button
          type="button"
          className="ctd-btn"
          data-on={magnet !== "normal"}
          data-mode={magnet}
          data-testid="draw-magnet"
          title={MAGNET_LABEL[magnet]}
          aria-label={MAGNET_LABEL[magnet]}
          aria-pressed={magnet !== "normal"}
          onClick={() => set({ magnet: nextMagnet(magnet) })}
        >
          <ToolIcon name="magnet" />
          {magnet === "strong_magnet" && <span className="ctd-dot" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="ctd-btn"
          data-on={lockAll}
          data-testid="draw-lock"
          title={lockAll ? WORDS.dUnlock.text : WORDS.dLock.text}
          aria-label={lockAll ? WORDS.dUnlock.text : WORDS.dLock.text}
          aria-pressed={lockAll}
          onClick={() => set({ lockAll: !lockAll })}
        >
          <ToolIcon name={lockAll ? "lock" : "unlock"} />
        </button>
        <button
          type="button"
          className="ctd-btn"
          data-on={hideAll}
          data-testid="draw-hide"
          title={hideAll ? WORDS.dShow.text : WORDS.dHide.text}
          aria-label={hideAll ? WORDS.dShow.text : WORDS.dHide.text}
          aria-pressed={hideAll}
          onClick={() => set({ hideAll: !hideAll })}
        >
          <ToolIcon name={hideAll ? "eyeOff" : "eye"} />
        </button>
        <button
          type="button"
          className="ctd-btn"
          data-testid="draw-delete-all"
          title={WORDS.dDeleteAll.text}
          aria-label={WORDS.dDeleteAll.text}
          disabled={d.count === 0}
          onClick={() => d.deleteAll()}
        >
          <ToolIcon name="trash" />
        </button>
      </div>
      {fly && (
        <div
          className="ctd-fly"
          style={{ top: fly.top + (col.current?.offsetTop ?? 0) }}
          data-testid={fly.g === "cross" ? "draw-cross-flyout" : `draw-${fly.g}-flyout`}
          role="menu"
        >
          {fly.g === "cross"
            ? CROSS_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="ctd-flyitem"
                  data-on={cross === m.id}
                  data-testid={`draw-cross-${m.id}`}
                  aria-pressed={cross === m.id}
                  onClick={() => {
                    setFly(null);
                    set({ cross: m.id });
                  }}
                >
                  <ToolIcon name={CROSS_ICON[m.id]} />
                  <span>{m.label}</span>
                </button>
              ))
            : DRAW_TOOLS.filter((t) => t.group === fly.g).map((t) => toolBtn(t, true))}
        </div>
      )}
      {d.editor && chart && (
        <NoteInput
          key={d.editor.id}
          host={chart.getDom()}
          ed={d.editor}
          onCommit={d.commitNote}
          onCancel={d.cancelNote}
        />
      )}
    </div>
  );
}

/** inline editor for a text note, over the chart at the note's anchor */
function NoteInput({
  host,
  ed,
  onCommit,
  onCancel,
}: {
  host: HTMLElement | null;
  ed: NoteEditor;
  onCommit(text: string): void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // the chart listens natively on its container: keep presses in the input away from it
    const stop = (e: Event) => e.stopPropagation();
    const types = ["mousedown", "mouseup", "click", "dblclick", "touchstart", "wheel"];
    for (const t of types) el.addEventListener(t, stop);
    return () => {
      for (const t of types) el.removeEventListener(t, stop);
    };
  }, []);
  if (!host) return null;
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? "");
    else onCancel();
  };
  return createPortal(
    <input
      ref={ref}
      className="ctd-note"
      style={{ left: ed.x, top: Math.max(0, ed.y - 26) }}
      defaultValue={ed.text}
      maxLength={500}
      placeholder={WORDS.dNote.text}
      aria-label={WORDS.dNoteText.text}
      data-testid="draw-text-input"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />,
    host,
  );
}
