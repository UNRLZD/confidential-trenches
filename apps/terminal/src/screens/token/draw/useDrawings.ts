/**
 * The live UNRLZD terminal's chart/draw/useDrawings.ts. Drawings on one chart for one token: restores the saved ones (persist.ts) when the chart or
 * token changes, saves after every draw / drag / removal, starts tools, applies the toolbar's
 * crosshair mode, magnet, lock all and hide all (store.ts), deletes the selected drawing on
 * Delete / Backspace (right-click removal is the library's default), and runs the text-note
 * editor. CT draws its bars scaled into the unit picked (units.ts factors): `scale` is that price factor, so a
 * drawing is saved in the helper's own unit (value / scale) and drawn back in the chart's (value * scale); a unit
 * switch draws every drawing again from what was saved.
 */
import type { Chart, Overlay, OverlayCreate, OverlayEvent } from "klinecharts";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadDrawings, saveDrawings, toSaved } from "./persist.ts";
import type { SavedDrawing } from "./persist.ts";
import { drawStore, useDraw } from "./store.ts";
import { DRAW_GROUP, toolById } from "./tools.ts";
import type { CrossMode } from "./tools.ts";

export interface NoteEditor {
  id: string;
  /** candle-pane layout px (the chart root's top-left) */
  x: number;
  y: number;
  text: string;
}

export interface Drawings {
  /** start drawing tool `id` (tools.ts); the same id again cancels it */
  start(id: string): void;
  deleteAll(): void;
  /** saved drawings on this token */
  count: number;
  editor: NoteEditor | null;
  commitNote(text: string): void;
  cancelNote(): void;
}

const FINISHED = -1;
const CANDLE = "candle_pane";

/** crosshair styles per mode (merged over the chart's own crosshair colours) */
export function crossStyles(mode: CrossMode) {
  const lines = mode === "cross";
  const dir = { show: true, line: { show: lines }, text: { show: true } };
  return { crosshair: { show: mode !== "arrow", horizontal: dir, vertical: dir } };
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

export function useDrawings(chart: Chart | null, tokenId: string, scale = 1): Drawings {
  const cross = useDraw("cross");
  const magnet = useDraw("magnet");
  const lockAll = useDraw("lockAll");
  const hideAll = useDraw("hideAll");
  const [count, setCount] = useState(0);
  const [editor, setEditor] = useState<NoteEditor | null>(null);
  /** the flags new / restored overlays start with (read inside callbacks) */
  const flags = useRef({ magnet, lockAll, hideAll });
  flags.current = { magnet, lockAll, hideAll };
  const selected = useRef<string | null>(null);
  const drawing = useRef<string | null>(null);
  /** the live (chart, token) session; callbacks of an older one (or during a restore) never save */
  const session = useRef(-1);
  const gen = useRef(0);
  const handlersRef = useRef<Partial<OverlayCreate> | null>(null);
  const saveRef = useRef<(() => void) | null>(null);

  const pixel = useCallback(
    (o: Overlay) => {
      const p = o.points[0];
      if (!chart || !p) return null;
      const c = chart.convertToPixel({ ...p }, { paneId: CANDLE });
      const q = Array.isArray(c) ? c[0] : c;
      return q && typeof q.x === "number" && typeof q.y === "number" ? { x: q.x, y: q.y } : null;
    },
    [chart],
  );

  // (chart, token): restore, and wire every overlay's callbacks to save for this token
  useEffect(() => {
    // the overlays are registered with the chart (KChart init), in the lazy chart chunk
    if (!chart) return;
    const my = ++gen.current;
    const live = () => session.current === my;
    let queued = false;
    const save = () => {
      if (queued || !live()) return;
      queued = true;
      // after the library's own bookkeeping (onRemoved fires before the overlay is dropped)
      queueMicrotask(() => {
        queued = false;
        if (!live()) return;
        const list: SavedDrawing[] = [];
        for (const o of chart.getOverlays({ groupId: DRAW_GROUP })) {
          if (o.currentStep !== FINISHED) continue;
          const s = toSaved({ ...o, points: o.points.map((p) => ({ timestamp: p.timestamp, value: typeof p.value === "number" ? p.value / scale : undefined })), lock: false, visible: true });
          if (s) list.push(s);
        }
        saveDrawings(tokenId, list);
        setCount(list.length);
      });
    };
    const edit = (o: Overlay, text: string) => {
      const at = pixel(o);
      if (at) setEditor({ id: o.id, x: at.x, y: at.y, text });
    };
    const handlers: Partial<OverlayCreate> = {
      onDrawEnd: (e: OverlayEvent<unknown>) => {
        if (!live()) return;
        drawing.current = null;
        drawStore.set({ active: null });
        if (e.overlay.name === "ntText") edit(e.overlay, "");
        save();
      },
      onPressedMoveEnd: () => save(),
      onRemoved: (e: OverlayEvent<unknown>) => {
        if (selected.current === e.overlay.id) selected.current = null;
        save();
      },
      onSelected: (e: OverlayEvent<unknown>) => {
        selected.current = e.overlay.id;
      },
      onDeselected: (e: OverlayEvent<unknown>) => {
        if (selected.current === e.overlay.id) selected.current = null;
      },
      onDoubleClick: (e: OverlayEvent<unknown>) => {
        if (e.overlay.name === "ntText") {
          const t = (e.overlay.extendData as { text?: string } | null)?.text ?? "";
          edit(e.overlay, t);
        }
      },
    };
    handlersRef.current = handlers;
    saveRef.current = save;

    // restore: drop whatever is on the chart (another token's), then this token's drawings
    session.current = -1; // their onRemoved must not save
    chart.removeOverlay({ groupId: DRAW_GROUP });
    session.current = my;
    drawing.current = null;
    selected.current = null;
    setEditor(null);
    drawStore.set({ active: null });
    const saved = loadDrawings(tokenId);
    const f = flags.current;
    for (const d of saved)
      chart.createOverlay({
        name: d.name,
        groupId: DRAW_GROUP,
        points: d.points.map((p) => ({ timestamp: p.timestamp, value: p.value * scale })),
        extendData: d.extendData ?? undefined,
        lock: f.lockAll,
        visible: !f.hideAll,
        mode: f.magnet,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        ...handlers,
      });
    setCount(saved.length);
    return () => {
      session.current = -1;
      handlersRef.current = null;
      saveRef.current = null;
    };
  }, [chart, tokenId, scale, pixel]);

  // toolbar flags → every drawing on the chart
  useEffect(() => {
    chart?.setStyles(crossStyles(cross));
  }, [chart, cross]);
  useEffect(() => {
    chart?.overrideOverlay({ groupId: DRAW_GROUP, mode: magnet });
  }, [chart, magnet]);
  useEffect(() => {
    chart?.overrideOverlay({ groupId: DRAW_GROUP, lock: lockAll });
  }, [chart, lockAll]);
  useEffect(() => {
    chart?.overrideOverlay({ groupId: DRAW_GROUP, visible: !hideAll });
  }, [chart, hideAll]);

  /**
   * KLineChart (10.0.3) counts a mouse-up within 500 ms of the previous one as the second click
   * of a double-click (`Delay.ResetClick`, not configurable) and, when it lands > 5 px away,
   * drops it: neither a click nor a double-click. Placing a drawing's points quickly then
   * "didn't take". While a drawing is in progress, a swallowed last click is completed here: the
   * library already moved the pending point under the pointer, so the overlay is re-created
   * finished with its points (same handlers, saved like any other).
   */
  useEffect(() => {
    if (!chart) return;
    const dom = chart.getDom();
    if (!dom) return;
    let lastUp = 0;
    const up = (e: MouseEvent) => {
      const now = e.timeStamp;
      const quick = now - lastUp < 520;
      lastUp = now;
      const id = drawing.current;
      if (!id || !quick || e.button !== 0) return;
      const before = chart.getOverlays({ id })[0]?.currentStep;
      setTimeout(() => {
        const o = chart.getOverlays({ id })[0];
        if (!o || drawing.current !== id || o.currentStep !== before) return;
        if (o.currentStep !== o.totalStep - 1 || o.points.length < o.totalStep - 1) return;
        const points = o.points.slice(0, o.totalStep - 1);
        drawing.current = null;
        const s = session.current;
        session.current = -1; // the removal must not save a half-drawn overlay
        chart.removeOverlay({ id });
        session.current = s;
        chart.createOverlay({
          name: o.name,
          groupId: DRAW_GROUP,
          points,
          extendData: o.extendData ?? undefined,
          mode: flags.current.magnet,
          lock: false,
          needDefaultXAxisFigure: false,
          needDefaultYAxisFigure: false,
          ...(handlersRef.current ?? {}),
        });
        drawStore.set({ active: null });
        saveRef.current?.();
      }, 0);
    };
    dom.addEventListener("mouseup", up, true);
    return () => dom.removeEventListener("mouseup", up, true);
  }, [chart]);

  // Delete / Backspace removes the selected drawing; Escape cancels the one being drawn
  useEffect(() => {
    if (!chart) return;
    const key = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.key === "Escape" && drawing.current) {
        chart.removeOverlay({ id: drawing.current });
        drawing.current = null;
        drawStore.set({ active: null });
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.current) {
        chart.removeOverlay({ id: selected.current });
        selected.current = null;
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [chart]);

  const start = useCallback(
    (id: string) => {
      if (!chart) return;
      const tool = toolById(id);
      const prev = drawing.current;
      if (prev) {
        chart.removeOverlay({ id: prev });
        drawing.current = null;
      }
      const st = drawStore.get();
      if (!tool || (st.active === id && prev)) {
        drawStore.set({ active: null });
        return;
      }
      if (st.hideAll) drawStore.set({ hideAll: false });
      const made = chart.createOverlay({
        name: tool.overlay,
        groupId: DRAW_GROUP,
        mode: flags.current.magnet,
        lock: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        ...(handlersRef.current ?? {}),
      });
      drawing.current = typeof made === "string" ? made : null;
      drawStore.set({ active: drawing.current ? id : null });
    },
    [chart],
  );

  const deleteAll = useCallback(() => {
    if (!chart) return;
    drawing.current = null;
    selected.current = null;
    setEditor(null);
    chart.removeOverlay({ groupId: DRAW_GROUP });
    drawStore.set({ active: null });
    saveRef.current?.();
  }, [chart]);

  const commitNote = useCallback(
    (text: string) => {
      const ed = editor;
      setEditor(null);
      if (!chart || !ed) return;
      const t = text.trim().slice(0, 500);
      if (!t) chart.removeOverlay({ id: ed.id });
      else {
        chart.overrideOverlay({ id: ed.id, extendData: { text: t } });
        saveRef.current?.();
      }
    },
    [chart, editor],
  );

  const cancelNote = useCallback(() => {
    const ed = editor;
    setEditor(null);
    if (!chart || !ed) return;
    // a new note left empty goes away; an edited one keeps its text
    const o = chart.getOverlays({ id: ed.id })[0];
    const had = (o?.extendData as { text?: string } | null | undefined)?.text;
    if (!had) chart.removeOverlay({ id: ed.id });
  }, [chart, editor]);

  return { start, deleteAll, count, editor, commitNote, cancelNote };
}
