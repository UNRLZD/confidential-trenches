// The chart under the shell's design fit (card chart-drags-and-tracks-the-pointer). From 1024 css px up #root is drawn
// at `zoom: var(--fit-zoom)` (shell/shell.css, shell/fit.ts: 0.75 at 1440). KLineChart (klinecharts 10.0.3) places the
// pointer at `clientX - container.getBoundingClientRect().left` (index.esm.js:1982-1985) and measures drags by
// pageX/pageY (:2008-2011): both are the window's px, a zoomed box's visual size, while the library lays its panes out in
// the box's own css px. At 0.75 the crosshair drew 25% short of the pointer (206 px at 80% across a 1026 px plot) and a
// 200 px drag panned 150 px (deployed app, release 116). The live UNRLZD terminal rescales the events its chart reads the
// same way (its chart/zoomEvents.ts). Here: in the capture phase on the document, before the library's own listeners on
// its container (and on the document while a press is held), each mouse, wheel and touch event aimed at the chart, or
// moving while a press that began on it is held, has its client and page coordinates mapped to the box's own px about
// the box's origin. Taken from the box itself each time, so a zoom change (a resize) needs nothing. The canvases' backing
// size needs nothing: the library sizes it from device-pixel-content-box (:9086-9105), which counts the zoom and the
// device pixel ratio. Display only: nothing here feeds a signature.

const TYPES = ["mousedown", "mousemove", "mouseup", "mouseenter", "mouseleave", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchmove", "touchend", "touchcancel"] as const;

/** The box's visual px per css px of its own (1: no zoom). */
export function zoomOf(el: HTMLElement): number {
  const w = el.offsetWidth;
  if (!w) return 1;
  const z = el.getBoundingClientRect().width / w;
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** A window point mapped to the box's own px about the box's origin (`left`, `top`: its visual origin). */
export function unzoom(p: { clientX: number; clientY: number; pageX: number; pageY: number }, left: number, top: number, z: number): { clientX: number; clientY: number; pageX: number; pageY: number } {
  const clientX = left + (p.clientX - left) / z;
  const clientY = top + (p.clientY - top) / z;
  return { clientX, clientY, pageX: p.pageX - p.clientX + clientX, pageY: p.pageY - p.clientY + clientY };
}

function rescale(o: object, left: number, top: number, z: number): void {
  const q = unzoom(o as { clientX: number; clientY: number; pageX: number; pageY: number }, left, top, z);
  try {
    Object.defineProperties(o, {
      clientX: { value: q.clientX, configurable: true },
      clientY: { value: q.clientY, configurable: true },
      pageX: { value: q.pageX, configurable: true },
      pageY: { value: q.pageY, configurable: true },
    });
  } catch {
    // an object that takes no own property: left as it is
  }
}

/** Rescales the events `host`'s chart reads while the page is zoomed; returns the removal. */
export function zoomEvents(host: HTMLElement): () => void {
  const doc = host.ownerDocument;
  const done = new WeakSet<object>();
  let held = false;
  const on = (e: Event) => {
    const t = e.target;
    const inside = t instanceof Node && host.contains(t);
    if (e.type === "mousedown" || e.type === "touchstart") held = inside || (held && e.type === "touchstart");
    if (!inside && !held) return;
    if (e.type === "mouseup" || e.type === "touchcancel" || (e.type === "touchend" && (e as TouchEvent).touches.length === 0)) queueMicrotask(() => (held = false));
    if (done.has(e)) return;
    done.add(e);
    const z = zoomOf(host);
    if (Math.abs(z - 1) < 1e-3) return;
    const r = host.getBoundingClientRect();
    if ("changedTouches" in e) {
      const te = e as TouchEvent;
      for (const list of [te.touches, te.changedTouches, te.targetTouches])
        for (const touch of Array.from(list))
          if (!done.has(touch)) {
            done.add(touch);
            rescale(touch, r.left, r.top, z);
          }
    } else rescale(e, r.left, r.top, z);
  };
  for (const t of TYPES) doc.addEventListener(t, on, { capture: true, passive: true });
  return () => {
    for (const t of TYPES) doc.removeEventListener(t, on, { capture: true });
  };
}
