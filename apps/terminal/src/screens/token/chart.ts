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
import type { Chart, DeepPartial, KLineData, PeriodType, Styles } from "klinecharts";
import { priceText, sameBar, volumeText } from "./candles.ts";
import type { Bar, ChartTf } from "./candles.ts";

const PERIOD: Record<ChartTf, { type: PeriodType; span: number }> = {
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

/** Draws a chart in `el` (sized by its CSS; the library follows its size). `onBar` gets the bar under the crosshair. */
export function mountChart(el: HTMLElement, phone: boolean, onBar: (b: KLineData) => void): Drawn | null {
  const chart = init(el, {
    timezone: "UTC",
    styles: styles(el),
    formatter: { formatBigNumber: volumeText },
    thousandsSeparator: { sign: "", format: (v) => String(v) },
    decimalFold: { format: priceText },
  });
  if (!chart) return null;
  const pane = chart.createIndicator({ name: "VOL", calcParams: [] });
  if (pane) chart.setPaneOptions({ id: pane, height: phone ? 88 : 110, dragEnabled: false });
  // the newest bar close to the price axis, as R5 draws it
  chart.setOffsetRightDistance(phone ? 16 : 40);
  // the price range starts under the legend (its rows: two on desktop, three on the phone), in px
  chart.overrideYAxis({ paneId: "candle_pane", gap: { top: phone ? 80 : 44, bottom: 0.1 } });
  chart.subscribeAction("onCrosshairChange", (d) => {
    const k = (d as { kLineData?: KLineData } | undefined)?.kLineData;
    if (k) onBar(k);
  });
  // one loader for the chart's life: it hands over the bars `drawBars` set, all at once, with no older page to ask for,
  // and keeps the library's live feed (subscribeBar, called after each full load) for liveBars
  const drawn: Drawn = { chart, bars: [], key: null, push: null };
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
}

/** Replaces the chart's bars with `bars` at `tf`: the period first (a new timeframe reloads), then the symbol, whose
 *  change always reloads, so the chart reads the new bars once more with the right precision. */
export function drawBars(d: Drawn, ticker: string, tf: ChartTf, bars: readonly Bar[], precision: number): void {
  d.bars = bars;
  d.key = `${ticker}|${tf}|${precision}`;
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
  const tail = d.key === `${ticker}|${tf}|${precision}` && d.push !== null && k >= 0 && bars.length >= old.length && bars[k]!.timestamp === old[k]!.timestamp && old.slice(0, k).every((b, i) => b === bars[i] || sameBar(b, bars[i]!));
  if (!tail) {
    drawBars(d, ticker, tf, bars, precision);
    return true;
  }
  d.bars = bars;
  for (const b of bars.slice(k)) d.push!({ ...b });
  return false;
}

export const unmountChart = (el: HTMLElement): void => dispose(el);
