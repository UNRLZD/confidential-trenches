/**
 * Custom KLineChart overlays for the drawing toolbar (tools.ts), the live UNRLZD terminal's
 * (chart/draw/overlays.ts there): rectangle, measure (price range + bars + time), text note, arrow marks and a
 * unit-free fib retracement, plus the overlay styles in the page's palette (drawStyles, merged into the chart styles by
 * chart.ts). The colours are the token page's own (token.css, shell.css), spelled once here for the canvas.
 */
import { registerOverlay } from "klinecharts";
import type { DeepPartial, OverlayFigure, OverlayStyle } from "klinecharts";
import { WORDS } from "../words.ts";
import { FIB_LEVELS, measureLabel, measureUp } from "./tools.ts";

const TOKENS = {
  "font-num": '"Chivo Mono", ui-monospace, monospace',
  "font-ui": '"Schibsted Grotesk", system-ui, sans-serif',
  "paper-rgb": "244,244,242",
  paper: "#f4f4f2",
  blue: "#5b8cff",
  "blue-rgb": "91,140,255",
  acc: "#50e397",
  "acc-rgb": "80,227,151",
  sell: "#ff5d4d",
  "sell-rgb": "255,93,77",
  "bg-page": "#0a0a0a",
  "bg-floating": "#151515",
  "border-strong": "#2a2a2a",
  "text-1": "#f4f4f2",
  "text-2": "#a3a3a3",
} as const;

const MONO = TOKENS["font-num"];
const UI = TOKENS["font-ui"];
const rgba = (rgb: string, a: number) => `rgba(${rgb},${a})`;
const PAPER = TOKENS["paper-rgb"];

/** Overlay defaults in our palette: paper lines, live-blue handles, 11px mono text. */
export function drawStyles(): DeepPartial<OverlayStyle> {
  return {
    point: {
      color: TOKENS.blue,
      borderColor: rgba(TOKENS["blue-rgb"], 0.35),
      borderSize: 1,
      radius: 4,
      activeColor: TOKENS.blue,
      activeBorderColor: rgba(TOKENS["blue-rgb"], 0.35),
      activeBorderSize: 3,
      activeRadius: 5,
    },
    line: { style: "solid", smooth: false, color: rgba(PAPER, 0.9), size: 1, dashedValue: [4, 4] },
    rect: {
      style: "stroke_fill",
      color: rgba(PAPER, 0.06),
      borderColor: rgba(PAPER, 0.9),
      borderSize: 1,
      borderRadius: 0,
      borderStyle: "solid",
      borderDashedValue: [4, 4],
    },
    polygon: {
      style: "stroke_fill",
      color: rgba(PAPER, 0.06),
      borderColor: rgba(PAPER, 0.9),
      borderSize: 1,
      borderStyle: "solid",
      borderDashedValue: [4, 4],
    },
    circle: {
      style: "stroke_fill",
      color: rgba(PAPER, 0.06),
      borderColor: rgba(PAPER, 0.9),
      borderSize: 1,
      borderStyle: "solid",
      borderDashedValue: [4, 4],
    },
    arc: { style: "solid", color: rgba(PAPER, 0.9), size: 1, dashedValue: [4, 4] },
    text: {
      style: "fill",
      color: TOKENS["bg-page"],
      size: 11,
      family: MONO,
      weight: "normal",
      borderStyle: "solid",
      borderDashedValue: [2, 2],
      borderSize: 0,
      borderRadius: 4,
      borderColor: TOKENS.paper,
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 3,
      paddingBottom: 3,
      backgroundColor: TOKENS.paper,
    },
  };
}

const box = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});

/** the note's text (placeholder while it is being typed) */
export function noteText(extendData: unknown): string {
  const t = (extendData as { text?: unknown } | null | undefined)?.text;
  return typeof t === "string" && t.trim() ? t : WORDS.dNotePlaceholder.text;
}

let done = false;

export function registerDrawOverlays(): void {
  if (done) return;
  done = true;

  registerOverlay({
    name: "ntRect",
    totalStep: 3,
    needDefaultPointFigure: true,
    createPointFigures: ({ coordinates }) => {
      const [a, b] = coordinates;
      if (!a || !b) return [];
      return [{ type: "rect", attrs: box(a, b) }];
    },
  });

  registerOverlay({
    name: "ntMeasure",
    totalStep: 3,
    needDefaultPointFigure: true,
    createPointFigures: ({ coordinates, overlay }) => {
      const [a, b] = coordinates;
      const [pa, pb] = overlay.points;
      if (!a || !b || !pa || !pb) return [];
      const up = measureUp(pa, pb);
      const rgb = up ? TOKENS["acc-rgb"] : TOKENS["sell-rgb"];
      const col = up ? TOKENS.acc : TOKENS.sell;
      const r = box(a, b);
      const cx = r.x + r.width / 2;
      // arrow along the move, from the first point's price to the second's
      const head = up ? -5 : 5;
      const figs: OverlayFigure[] = [
        {
          type: "rect",
          attrs: r,
          styles: { style: "stroke_fill", color: rgba(rgb, 0.12), borderColor: rgba(rgb, 0.6) },
        },
        {
          type: "line",
          attrs: {
            coordinates: [
              { x: cx, y: a.y },
              { x: cx, y: b.y },
            ],
          },
          styles: { color: col },
          ignoreEvent: true,
        },
        {
          type: "polygon",
          attrs: {
            coordinates: [
              { x: cx, y: b.y },
              { x: cx - 4, y: b.y - head },
              { x: cx + 4, y: b.y - head },
            ],
          },
          styles: { style: "fill", color: col },
          ignoreEvent: true,
        },
      ];
      const label = measureLabel(pa, pb);
      if (label)
        figs.push({
          type: "text",
          attrs: {
            x: cx,
            y: up ? r.y - 4 : r.y + r.height + 4,
            text: label,
            align: "center",
            baseline: up ? "bottom" : "top",
          },
          styles: { color: TOKENS["bg-page"], backgroundColor: col },
          ignoreEvent: true,
        });
      return figs;
    },
  });

  registerOverlay({
    name: "ntText",
    totalStep: 2,
    needDefaultPointFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const [a] = coordinates;
      if (!a) return [];
      return [
        {
          type: "text",
          attrs: { x: a.x, y: a.y, text: noteText(overlay.extendData), baseline: "bottom" },
          styles: {
            style: "stroke_fill",
            color: TOKENS["text-1"],
            backgroundColor: TOKENS["bg-floating"],
            borderColor: TOKENS["border-strong"],
            borderSize: 1,
            size: 12,
            family: UI,
            paddingLeft: 6,
            paddingRight: 6,
            paddingTop: 4,
            paddingBottom: 4,
          },
        },
      ];
    },
  });

  for (const [name, up] of [
    ["ntArrowUp", true],
    ["ntArrowDown", false],
  ] as const)
    registerOverlay({
      name,
      totalStep: 2,
      needDefaultPointFigure: false,
      createPointFigures: ({ coordinates }) => {
        const [a] = coordinates;
        if (!a) return [];
        // up: under the point pointing at it (TV arrow mark up); down: above it
        const d = up ? 1 : -1;
        const tip = a.y + d * 2;
        const col = up ? TOKENS.acc : TOKENS.sell;
        return [
          {
            type: "polygon",
            attrs: {
              coordinates: [
                { x: a.x, y: tip },
                { x: a.x + 7, y: tip + d * 8 },
                { x: a.x + 3, y: tip + d * 8 },
                { x: a.x + 3, y: tip + d * 16 },
                { x: a.x - 3, y: tip + d * 16 },
                { x: a.x - 3, y: tip + d * 8 },
                { x: a.x - 7, y: tip + d * 8 },
              ],
            },
            styles: { style: "fill", color: col },
          },
        ];
      },
    });

  registerOverlay({
    name: "ntFib",
    totalStep: 3,
    needDefaultPointFigure: true,
    createPointFigures: ({ coordinates, bounding }) => {
      const [a, b] = coordinates;
      if (!a) return [];
      if (!b) return [];
      const x0 = Math.min(a.x, b.x);
      const lines: { coordinates: { x: number; y: number }[] }[] = [];
      const texts: { x: number; y: number; text: string; baseline: CanvasTextBaseline }[] = [];
      for (const lv of FIB_LEVELS) {
        // level 0 at the second point, 1 at the first (TV: the move being retraced)
        const y = b.y + (a.y - b.y) * lv;
        lines.push({
          coordinates: [
            { x: x0, y },
            { x: bounding.width, y },
          ],
        });
        texts.push({
          x: x0,
          y,
          text: lv.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""),
          baseline: "bottom",
        });
      }
      return [
        { type: "line", attrs: lines, styles: { color: rgba(PAPER, 0.7) } },
        {
          type: "rect",
          attrs: box({ x: x0, y: a.y }, { x: bounding.width, y: b.y }),
          styles: { style: "fill", color: rgba(PAPER, 0.04) },
          ignoreEvent: true,
        },
        {
          type: "text",
          attrs: texts,
          styles: { color: TOKENS["text-2"], backgroundColor: "transparent", paddingLeft: 2 },
          ignoreEvent: true,
        },
      ];
    },
  });
}
