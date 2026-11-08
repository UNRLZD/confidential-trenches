// The token page's chart drawing (card app-token-chart): KLineChart, the library the live UNRLZD terminal draws its
// chart with (klinecharts 10.0.3, Apache-2.0; its NOTICE below, kept in the built script by vite.config.ts). Candles in the main pane
// with the price axis and the last price's mark, volume bars in their own pane under it, and the crosshair; the legend
// (R5 token.js U.legend) is the page's own text over the plot (TokenPage.tsx), fed by `onBar`. Every number the chart
// draws goes through Discover's formatters (../discover/format.ts): prices as `price`, volume as `usd`. Colours and
// fonts are the page's own tokens, read from the plot's computed style. The library draws on canvas and sets styles only
// through the CSSOM, so APP_HOST's CSP (style-src 'self', trusted types) needs nothing new.
/*! @license KLineChart v10.0.3 Copyright (c) 2019 lihu. Licensed under the Apache License 2.0
 *  https://www.apache.org/licenses/LICENSE-2.0. NOTICE: KLineChart, Copyright (c) 2019 lihu. TradingView Lightweight
 *  Charts, Copyright (c) 2019 TradingView, Inc. https://www.tradingview.com */
import { dispose, init } from "klinecharts";
import type { Chart, Crosshair, DeepPartial, KLineData, PeriodType, Point, Styles } from "klinecharts";
import { sameBar } from "./candles.ts";
import type { Bar, ChartTf } from "./candles.ts";
import { valueText, volumeIn } from "./units.ts";
import type { ChartUnit } from "./units.ts";

const PERIOD: Record<ChartTf, { type: PeriodType; span: number }> = {
  "1s": { type: "second", span: 1 },
  "1m": { type: "minute", span: 1 },
  "5m": { type: "minute", span: 5 },
  "15m": { type: "minute", span: 15 },
  "1H": { type: "hour", span: 1 },
  "4H": { type: "hour", span: 4 },
  "1D": { type: "day", span: 1 },
};

function styles(el: HTMLElement): DeepPartial<Styles> {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const up = v("--acc", "#50e397");
  const down = v("--sell", "#ff5d4d");
  const text = v("--text-3", "#6b6b6b");
  const grid = "#161616";
  const line = v("--border-panel", "#1f1f1f");
  const family = v("--font-num", "monospace");
  const tick = { color: text, family, size: 11, weight: "normal" };
  const crossText = { color: "#e6e6e6", family, size: 11, backgroundColor: "#2a2a2a", borderColor: "#2a2a2a" };
  const crossLine = { color: "#4a4a4a", style: "dashed" as const, dashedValue: [4, 3], size: 1 };
  return {
    grid: { horizontal: { color: grid }, vertical: { show: false } },
    candle: {
      type: "candle_solid",
      bar: { upColor: up, downColor: down, noChangeColor: up, upBorderColor: up, downBorderColor: down, noChangeBorderColor: up, upWickColor: up, downWickColor: down, noChangeWickColor: up },
      priceMark: {
        high: { show: false },
        low: { show: false },
        last: { upColor: up, downColor: down, noChangeColor: up, line: { style: "dashed", dashedValue: [2, 3] }, text: { family, size: 11, color: "#0a0a0a" } },
      },
      tooltip: { showRule: "none" },
    },
    indicator: {
      bars: [{ upColor: `${up}66`, downColor: `${down}66`, noChangeColor: `${up}66` }],
      lastValueMark: { show: false },
      tooltip: { showRule: "none" },
    },
    xAxis: { axisLine: { show: false }, tickLine: { show: false }, tickText: tick },
    yAxis: { axisLine: { show: false }, tickLine: { show: false }, tickText: tick },
    separator: { size: 1, color: line },
    crosshair: { horizontal: { line: crossLine, text: crossText }, vertical: { line: crossLine, text: crossText } },
  };
}

/** The price range starts under the legend (its rows: two on desktop, three on the phone), in px. */
const gapOf = (phone: boolean) => ({ top: phone ? 80 : 44, bottom: 0.1 });

/** The volume pane, under the candles. Its pane is named here: createIndicator answers the indicator's id, not its
 *  pane's, so the pane's height is set by the name it was made with. */
const VOL_PANE = "pane_VOL";
function addVolume(chart: Chart, phone: boolean): void {
  if (chart.createIndicator({ name: "VOL", calcParams: [], paneId: VOL_PANE })) chart.setPaneOptions({ id: VOL_PANE, height: phone ? 88 : 110, dragEnabled: false });
}

/** Draws a chart in `el` (sized by its CSS; the library follows its size). `onBar` gets the bar under the crosshair. */
export function mountChart(el: HTMLElement, phone: boolean, onBar: (b: KLineData) => void): Drawn | null {
  // the axis and the volume pane draw in the chart's unit (units.ts), read at each draw from `drawn.unit`
  let unit: ChartUnit = { mc: false, quote: false };
  const chart = init(el, {
    timezone: "UTC",
    styles: styles(el),
    formatter: { formatBigNumber: (v) => volumeIn(unit, v) },
    thousandsSeparator: { sign: "", format: (v) => String(v) },
    decimalFold: { format: (v) => valueText(unit, v) },
  });
  if (!chart) return null;
  addVolume(chart, phone);
  // the newest bar close to the price axis, as R5 draws it
  chart.setOffsetRightDistance(phone ? 16 : 40);
  // the price range starts under the legend (its rows: two on desktop, three on the phone), in px
  chart.overrideYAxis({ paneId: "candle_pane", gap: gapOf(phone) });
  // the library hands this action the pointer's own coordinates, never the bar under them (klinecharts 10.0.3
  // index.esm.js:14092-14093 passes setCrosshair's argument on): the bar is read from x, clamped to the bars drawn as
  // the crosshair's own is (index.esm.js:14071-14079)
  chart.subscribeAction("onCrosshairChange", (d) => {
    const x = (d as Crosshair | undefined)?.x;
    if (x === undefined) return;
    const [p] = chart.convertFromPixel([{ x }], { paneId: "candle_pane" }) as Partial<Point>[];
    const list = chart.getDataList();
    const k = list[Math.min(Math.max(p?.dataIndex ?? 0, 0), list.length - 1)];
    if (k) onBar(k);
  });
  // one loader for the chart's life: it hands over the bars `drawBars` set, all at once, with no older page to ask for,
  // and keeps the library's live feed (subscribeBar, called after each full load) for liveBars
  const drawn: Drawn = {
    chart,
    bars: [],
    key: null,
    push: null,
    get unit() {
      return unit;
    },
    set unit(u: ChartUnit) {
      unit = u;
    },
  };
  chart.setDataLoader({
    getBars: ({ callback }) => callback(drawn.bars.map((b) => ({ ...b })), false),
    subscribeBar: ({ callback }) => {
      drawn.push = callback;
    },
    unsubscribeBar: () => {
      drawn.push = null;
    },
  });
  return drawn;
}

/** A mounted chart, the bars it draws and what they were drawn for; `push` is the library's live feed while it holds
 *  a full load (a bar of the newest's time replaces it, a newer one is appended). */
export interface Drawn {
  chart: Chart;
  bars: readonly Bar[];
  key: string | null;
  push: ((k: KLineData) => void) | null;
  /** The unit the axis and the volume pane draw in. */
  unit: ChartUnit;
}

/** Replaces the chart's bars with `bars` at `tf`: the period first (a new timeframe reloads), then the symbol, whose
 *  change always reloads, so the chart reads the new bars once more with the right precision. */
export function drawBars(d: Drawn, ticker: string, tf: ChartTf, bars: readonly Bar[], precision: number): void {
  d.bars = bars;
  d.key = `${ticker}|${tf}|${precision}|${unitKey(d.unit)}`;
  d.chart.setPeriod(PERIOD[tf]);
  d.chart.setSymbol({ ticker, pricePrecision: precision, volumePrecision: 0 });
}

/** Draws `bars` (card app-chart-live): when the chart already draws this ticker, timeframe and precision and the bars
 *  differ only from its newest bar on (the fold's usual change: the last bar updated, new bars after it), each of
 *  those goes through the library's live feed, so the last candle and the price mark move and the view keeps its
 *  scroll and zoom; any other change draws them all again (drawBars). Returns whether it drew them all again. */
export function liveBars(d: Drawn, ticker: string, tf: ChartTf, bars: readonly Bar[], precision: number): boolean {
  const old = d.bars;
  const k = old.length - 1;
  const tail = d.key === `${ticker}|${tf}|${precision}|${unitKey(d.unit)}` && d.push !== null && k >= 0 && bars.length >= old.length && bars[k]!.timestamp === old[k]!.timestamp && old.slice(0, k).every((b, i) => b === bars[i] || sameBar(b, bars[i]!));
  if (!tail) {
    drawBars(d, ticker, tf, bars, precision);
    return true;
  }
  d.bars = bars;
  for (const b of bars.slice(k)) d.push!({ ...b });
  return false;
}

export const unmountChart = (el: HTMLElement): void => dispose(el);

const unitKey = (u: ChartUnit) => `${u.mc ? "mc" : "price"}/${u.quote ? "coin" : "usd"}`;

// ------------------------------------------------------------------------------------------------ the controls
// Card app-chart-controls: what R5's toolbar and bottom bar set (token.js U.chartPanel), each through the library's own
// calls. The page holds the choices (TokenPage.tsx ChartControls) and hands them over after each mount.

const CANDLE = "candle_pane";

/** The price scale (R5's bottom bar %, log): the library's own axes. */
export type Scale = "normal" | "percentage" | "logarithm";
export function setScale(d: Drawn, s: Scale, phone: boolean): void {
  // the gap again with the axis, so a new scale keeps the range under the legend
  d.chart.overrideYAxis({ paneId: CANDLE, name: s, gap: gapOf(phone) });
}

/** The price axis's own fit flag (the library's: a drag on the axis sets a range of its own and clears it). */
type FitFlag = { getAutoCalcTickFlag?: () => boolean; setAutoCalcTickFlag?: (on: boolean) => void };
const priceAxis = (d: Drawn): FitFlag | null => (d.chart.getYAxes({ paneId: CANDLE })[0] as FitFlag | undefined) ?? null;
/** Whether the price scale fits the bars in view (R5's `auto`): off once the axis was dragged. */
export const isAuto = (d: Drawn): boolean => priceAxis(d)?.getAutoCalcTickFlag?.() !== false;
/** Fits the price scale to the bars in view again (R5's `auto`). */
export function fitPrice(d: Drawn): void {
  priceAxis(d)?.setAutoCalcTickFlag?.(true);
  d.chart.resize();
}

/** The indicators R5's Indicators menu holds (the live UNRLZD terminal's list, chart/indicators.ts there): the
 *  library's own. MA, EMA and BOLL are drawn over the candles; RSI and MACD each in a pane of its own. */
export const INDICATORS = [
  { id: "MA", main: true },
  { id: "EMA", main: true },
  { id: "BOLL", main: true },
  { id: "RSI", main: false },
  { id: "MACD", main: false },
] as const;
export type IndicatorId = (typeof INDICATORS)[number]["id"];

/** Draws exactly the indicators in `on`, and the volume pane when `volume`. */
export function setIndicators(d: Drawn, on: ReadonlySet<IndicatorId>, volume: boolean, phone: boolean): void {
  const has = (name: string) => d.chart.getIndicators({ name }).length > 0;
  for (const i of INDICATORS) {
    if (on.has(i.id) && !has(i.id)) d.chart.createIndicator(i.main ? { name: i.id, paneId: CANDLE } : { name: i.id, paneId: `pane_${i.id}` }, i.main);
    if (!on.has(i.id) && has(i.id)) d.chart.removeIndicator({ name: i.id });
  }
  if (volume && !has("VOL")) addVolume(d.chart, phone);
  if (!volume && has("VOL")) d.chart.removeIndicator({ name: "VOL" });
}

/** R5's Display menu: the grid and the last price's line. */
export function setDisplay(d: Drawn, grid: boolean, lastLine: boolean): void {
  d.chart.setStyles({ grid: { show: grid }, candle: { priceMark: { last: { line: { show: lastLine } } } } });
}

/** R5's bottom-bar ranges: the newest `count` bars across the plot (all of them for null), the newest at its right. */
export function fitBars(d: Drawn, count: number | null): void {
  const w = d.chart.getSize(CANDLE, "main")?.width ?? 0;
  const n = Math.max(1, Math.min(count ?? d.bars.length, d.bars.length));
  if (w > 0) d.chart.setBarSpace(w / n);
  d.chart.scrollToRealTime();
}
