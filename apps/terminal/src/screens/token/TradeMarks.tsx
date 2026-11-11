// The token chart's trade marks (card app-chart-controls): over the candle pane, one round mark per trader x bar x side at
// the average fill, drawn as the token's own logo with a side dot at its bottom-right and a grey ring (design/proto at
// 9bc315d, assets/app.js P.chart). Hover on desktop and tap on a phone open a card of the mark's data. The marks are
// placed from the chart's own pixels (convertToPixel) and placed again on every zoom, scroll and range change, once per
// frame. Positions go through React's style prop only, so APP_HOST's CSP (style-src 'self', trusted types) needs nothing.
// A mark is placed by its transform (left and top stay 0): a mark that moves with the chart's data (a bigger trade
// landing in its bar takes its place) or with a zoom moves no layout box (BAR-10 CLS 0, card
// app-phone-token-taps-and-rows). On a phone each mark is tapped through a 44 px area round it (marks.css).
// The marks take no pointer (card chart-drags-and-tracks-the-pointer): as buttons over the chart they were hit boxes that
// a drag, a wheel or the crosshair begun on a mark never reached the chart through (on a phone a 44 px square per mark).
// The plot's own pointer events find the mark instead, from the marks as last placed (the live UNRLZD terminal
// hit-tests its marks the same way): a hover on a mark's disc on the desktop, a tap inside its 44 px area on a phone,
// the one drawn on top or the nearest centre (pickMark). The chart sees every event; a key still focuses each mark.
import "./marks.css";
import type { Chart } from "klinecharts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { age, compact, price, usd } from "../discover/format.ts";
import { Avatar } from "../market/Avatar.tsx";
import type { Bar, ChartTf } from "./candles.ts";
import { groupMarks, layoutMarks, pickMark, shortTrader } from "./trades.ts";
import type { Mark, Trade, Wish } from "./trades.ts";
import { WORDS } from "./words.ts";

const PANE = "candle_pane";
const ACTIONS = ["onZoom", "onScroll", "onVisibleRangeChange"] as const;
const radius = (phone: boolean): number => (phone ? 6 : 8);
/** Half a phone mark's tap area (marks.css: 44 px). */
const TAP_HALF = 22;
/** A press that moves farther than this is a drag of the chart, not a tap. */
const TAP_SLOP = 8;

interface Drawn {
  id: string;
  x: number;
  y: number;
  k: number;
  mark: Mark;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const amountText = (n: number): string => (n >= 1 ? compact(n) : price(n.toFixed(12)).replace(/^\$/, ""));

export function TradeMarks({ chart, bars, tf, factor, symbol, phone, version, trades }: { chart: Chart | null; bars: readonly Bar[]; tf: ChartTf; factor: number; symbol: string; phone: boolean; version: number; trades: readonly Trade[] }) {
  const r = radius(phone);
  const marks = useMemo(() => groupMarks(trades, bars, tf), [trades, bars, tf]);
  const [drawn, setDrawn] = useState<{ rect: Rect; marks: Drawn[] }>({ rect: { left: 0, top: 0, width: 0, height: 0 }, marks: [] });
  const [open, setOpen] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const last = useRef(drawn);
  last.current = drawn;

  const place = useCallback(() => {
    let size: ReturnType<Chart["getSize"]> = null;
    const wishes: Wish[] = [];
    try {
      size = chart ? chart.getSize(PANE, "main") : null;
      if (chart && size) {
        for (const m of marks) {
          const p = chart.convertToPixel({ timestamp: m.barTs, value: m.price * factor }, { paneId: PANE }) as { x?: number; y?: number };
          if (typeof p.x === "number" && typeof p.y === "number") wishes.push({ id: m.id, x: p.x, y: p.y, usd: m.usd });
        }
      }
    } catch {
      size = null; // a chart being disposed: no marks this frame
    }
    if (!size) {
      setDrawn((d) => (d.marks.length === 0 ? d : { rect: d.rect, marks: [] }));
      return;
    }
    const byId = new Map(marks.map((m) => [m.id, m] as const));
    const placed = layoutMarks(wishes, { width: size.width, height: size.height, r });
    const out: Drawn[] = placed.map((p) => ({ ...p, mark: byId.get(p.id)! })).sort((a, b) => a.mark.usd - b.mark.usd);
    setDrawn({ rect: { left: size.left, top: size.top, width: size.width, height: size.height }, marks: out });
  }, [chart, marks, factor, r]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      place();
    });
  }, [place]);

  useEffect(() => {
    schedule();
  }, [schedule, version]);

  useEffect(() => {
    if (!chart) return;
    const on = () => schedule();
    for (const a of ACTIONS) chart.subscribeAction(a, on);
    return () => {
      for (const a of ACTIONS) chart.unsubscribeAction(a, on);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [chart, schedule]);

  // the plot's size: the chart follows it on its own (the shell's fit zoom, a window resize), so the marks are placed
  // again from the chart's new pixels; a placement made before the plot had its size drew none (seen at 1280)
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(el);
    return () => ro.disconnect();
  }, [schedule]);

  // the mark under the pointer, from the plot's own events: the marks take none (marks.css), so the chart takes them all
  useEffect(() => {
    const pane = layer.current?.firstElementChild;
    const plot = layer.current?.parentElement;
    if (!(pane instanceof HTMLElement) || !plot) return;
    /** The pane's own px of a window point (the shell's fit zoom draws the pane smaller than its own size). */
    const at = (e: PointerEvent): { x: number; y: number } | null => {
      const b = pane.getBoundingClientRect();
      const { rect } = last.current;
      if (b.width === 0 || b.height === 0) return null;
      return { x: ((e.clientX - b.left) * rect.width) / b.width, y: ((e.clientY - b.top) * rect.height) / b.height };
    };
    const hit = (p: { x: number; y: number } | null, reach: (m: Drawn) => boolean): string | null => {
      if (p === null) return null;
      const near = last.current.marks.filter(reach);
      return near.length === 0 ? null : pickMark(near, p.x, p.y, r);
    };
    if (!phone) {
      const move = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        const p = at(e);
        const id = hit(p, (m) => p !== null && Math.hypot(m.x - p.x, m.y - p.y) <= r);
        setOpen((o) => (o === id ? o : id));
      };
      const leave = () => setOpen(null);
      plot.addEventListener("pointermove", move);
      plot.addEventListener("pointerleave", leave);
      return () => {
        plot.removeEventListener("pointermove", move);
        plot.removeEventListener("pointerleave", leave);
      };
    }
    // a phone: a press that ends where it began is a tap; on a mark's area it opens that mark's card, or closes it
    // when open; anywhere else in the plot it closes the card
    let down: { id: number; x: number; y: number } | null = null;
    const press = (e: PointerEvent) => {
      down = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const release = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (d === null || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP) return;
      const p = at(e);
      const id = hit(p, (m) => p !== null && Math.abs(m.x - p.x) <= TAP_HALF && Math.abs(m.y - p.y) <= TAP_HALF);
      setOpen((o) => (id === null || o === id ? null : id));
    };
    const cancel = () => {
      down = null;
    };
    // a press outside the plot closes the card
    const outside = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !plot.contains(e.target)) setOpen(null);
    };
    plot.addEventListener("pointerdown", press);
    plot.addEventListener("pointerup", release);
    plot.addEventListener("pointercancel", cancel);
    document.addEventListener("pointerdown", outside);
    return () => {
      plot.removeEventListener("pointerdown", press);
      plot.removeEventListener("pointerup", release);
      plot.removeEventListener("pointercancel", cancel);
      document.removeEventListener("pointerdown", outside);
    };
  }, [phone, r]);

  const card = open === null ? null : drawn.marks.find((d) => d.id === open) ?? null;
  const { rect } = drawn;
  return (
    <div className="tm-layer" ref={layer} data-testid="trade-marks" data-count={drawn.marks.length} data-phone={phone || undefined}>
      <div className="tm-pane" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        {drawn.marks.map((d) => (
          <button
            key={d.id}
            type="button"
            className="tm"
            data-testid="trade-mark"
            data-side={d.mark.side}
            style={{ transform: `translate(${d.x - r}px, ${d.y - r}px)`, width: 2 * r, height: 2 * r }}
            onFocus={phone ? undefined : () => setOpen(d.id)}
            onBlur={phone ? undefined : () => setOpen(null)}
            onClick={phone ? () => setOpen((o) => (o === d.id ? null : d.id)) : undefined}
          >
            <Avatar symbol={symbol} size={2 * r} />
            <i className="tm-dot" />
            {d.k > 0 && !phone && <span className="tm-k">+{d.k}</span>}
          </button>
        ))}
        {card && <Card d={card} symbol={symbol} rect={rect} r={r} />}
      </div>
    </div>
  );
}

/** A mark's card, placed by its transform as the marks are: a live read that moves its mark (a new axis top, a wider
 *  axis label) moves the card with it and no layout box (left and top stay 0). Placed by left and top, the open card
 *  was a layout shift on every such move (live app run 43025383719, phone: div.tm-card 148,272 -> 148,244). */
function Card({ d, symbol, rect, r }: { d: Drawn; symbol: string; rect: Rect; r: number }) {
  const m = d.mark;
  const left = d.x > rect.width - 190;
  const top = Math.max(40, Math.min(rect.height - 40, d.y));
  return (
    <div className="tm-card" data-testid="trade-mark-card" data-side={m.side} data-h={left ? "l" : "r"} style={{ transform: `translate(${left ? d.x - r : d.x + r}px, ${top}px) translate(${left ? "-100%" : "0"}, -50%)` }}>
      <span className="tm-cs">{m.side === "buy" ? WORDS.buy.text : WORDS.sell.text}</span>
      <span className="tm-cn">{usd(m.usd.toFixed(8))}</span>
      <span className="tm-cn tm-cw">
        {amountText(m.amt)} {symbol}
      </span>
      {m.trader !== null && <span className="tm-cn">{shortTrader(m.trader)}</span>}
      <span className="tm-cn">{age(Math.floor(m.t_ms / 1000), Date.now())}</span>
    </div>
  );
}
