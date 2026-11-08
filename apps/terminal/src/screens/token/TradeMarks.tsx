// The token chart's trade marks (card app-chart-controls): over the candle pane, one round mark per trader x bar x side at
// the average fill, drawn as the token's own logo with a side dot at its bottom-right and a grey ring (design/proto at
// 9bc315d, assets/app.js P.chart). Hover on desktop and tap on a phone open a card of the mark's data. The marks are
// placed from the chart's own pixels (convertToPixel) and placed again on every zoom, scroll and range change, once per
// frame. Positions go through React's style prop only, so APP_HOST's CSP (style-src 'self', trusted types) needs nothing.
import "./marks.css";
import type { Chart } from "klinecharts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { age, compact, price, usd } from "../discover/format.ts";
import { Avatar } from "../market/Avatar.tsx";
import type { Bar, ChartTf } from "./candles.ts";
import { groupMarks, layoutMarks, shortTrader } from "./trades.ts";
import type { Mark, Trade, Wish } from "./trades.ts";
import { WORDS } from "./words.ts";

const PANE = "candle_pane";
const ACTIONS = ["onZoom", "onScroll", "onVisibleRangeChange"] as const;
const radius = (phone: boolean): number => (phone ? 6 : 8);

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

  // a tap outside the marks closes a phone's card
  useEffect(() => {
    if (!phone || open === null) return;
    const close = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".tm")) setOpen(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [phone, open]);

  const card = open === null ? null : drawn.marks.find((d) => d.id === open) ?? null;
  const { rect } = drawn;
  return (
    <div className="tm-layer" ref={layer} data-testid="trade-marks" data-count={drawn.marks.length}>
      <div className="tm-pane" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        {drawn.marks.map((d) => (
          <button
            key={d.id}
            type="button"
            className="tm"
            data-testid="trade-mark"
            data-side={d.mark.side}
            style={{ left: d.x - r, top: d.y - r, width: 2 * r, height: 2 * r }}
            onPointerEnter={phone ? undefined : () => setOpen(d.id)}
            onPointerLeave={phone ? undefined : () => setOpen(null)}
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

function Card({ d, symbol, rect, r }: { d: Drawn; symbol: string; rect: Rect; r: number }) {
  const m = d.mark;
  const left = d.x > rect.width - 190;
  const top = Math.max(40, Math.min(rect.height - 40, d.y));
  return (
    <div className="tm-card" data-testid="trade-mark-card" data-side={m.side} data-h={left ? "l" : "r"} style={{ left: left ? d.x - r : d.x + r, top }}>
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
