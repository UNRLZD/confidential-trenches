#!/usr/bin/env node
// Live check of card app-chart-controls: the token chart works as design-lock-r5 draws it beyond candles: R5's toolbar
// (S8.1: the timeframes with 1s where it is served, Indicators, Display, Price / MCap, USD / the chain's coin), its
// bottom bar (1D 7D 30D 180D All, CoinGecko's label, the UTC clock, %, log, auto) and the trade marks drawn as the
// token's logo with a card on hover. It reads what APP_HOST serves: the page, then every script and stylesheet the page
// names, and checks the deployed bundle holds them:
//   - the scripts hold the toolbar and its controls (chart-toolbar, chart-tf-, chart-indicators, chart-display,
//     chart-mode, chart-denom), the bottom bar and its controls (chart-bottom, chart-range-, chart-clock,
//     chart-scale-pct, chart-scale-log, chart-scale-auto), the marks and their card (trade-mark, trade-mark-card) and the
//     marks' read of the helper's tape (/v1/market/trades);
//   - the stylesheets hold the bottom bar (.tkp-bottombar), the menus (.tkp-menu) and the marks (.tm-layer, .tm-dot).
// The behaviour itself (each control used once and read back, the marks inside the plot, the hover card) is the
// terminal's own browser run, apps/terminal/test/token-page/run.mjs (state chart-controls at 390, 1440 and 1280), and
// the marks' read and layout apps/terminal/test/token-marks.test.ts.
//   node scripts/live-checks/app-chart-controls.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-chart-controls.mjs --root <dir> [--record <file>]   the same read on a local build
//     (apps/terminal/dist, built first) read from disk
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (the markers each file holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-chart-controls";
export const APP_URL = "https://confidential.unrealized.trade/";
export const JS_MARKERS = ["chart-toolbar", "chart-tf-", "chart-indicators", "chart-display", "chart-mode", "chart-denom", "chart-bottom", "chart-range-", "chart-clock", "chart-scale-pct", "chart-scale-log", "chart-scale-auto", "trade-mark", "trade-mark-card", "/v1/market/trades"];
export const CSS_MARKERS = [".tkp-bottombar", ".tkp-menu", ".tm-layer", ".tm-dot"];

/** The page's scripts and stylesheets: the `src` of each script tag and the `href` of each stylesheet link. */
export function assetsOf(html) {
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const css = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]);
  return { js, css };
}

const holds = (text, markers) => markers.filter((m) => text.includes(m));

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { source, pageStatus, js: [{ url, status, found }], css: [{ url, status, found }] }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(rec.pageStatus === 200, `the page answers ${rec.pageStatus ?? "nothing"}`);
  const js = rec.js ?? [];
  const css = rec.css ?? [];
  say(js.length > 0 && js.every((f) => f.status === 200), `${js.length} script(s) named by the page, each answering 200`);
  say(css.every((f) => f.status === 200), `${css.length} stylesheet(s) named by the page, each answering 200`);
  const jsHeld = new Set(js.flatMap((f) => f.found ?? []));
  const missJs = JS_MARKERS.filter((m) => !jsHeld.has(m));
  say(missJs.length === 0, missJs.length ? `the scripts lack the chart's controls: ${missJs.join(", ")}` : `the scripts hold the chart's toolbar, bottom bar and trade marks: ${JS_MARKERS.join(", ")}`);
  const cssHeld = new Set(css.flatMap((f) => f.found ?? []));
  const missCss = CSS_MARKERS.filter((m) => !cssHeld.has(m));
  say(missCss.length === 0, missCss.length ? `the stylesheets lack the chart's rules: ${missCss.join(", ")}` : `the stylesheets hold the chart's rules: ${CSS_MARKERS.join(", ")}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

export async function collect({ url = APP_URL, root = null } = {}) {
  const read = async (ref, base) => {
    if (root) {
      const file = path.join(root, new URL(ref, "http://x/").pathname);
      try {
        return { status: 200, text: readFileSync(file, "utf8") };
      } catch {
        return { status: 404, text: "" };
      }
    }
    return http(new URL(ref, base).href);
  };
  const page = root ? { status: 200, text: readFileSync(path.join(root, "index.html"), "utf8") } : await http(url);
  const { js, css } = assetsOf(page.text);
  const rec = { source: root ? `a local build read from ${path.basename(root)}` : url, at: new Date().toISOString(), pageStatus: page.status, js: [], css: [] };
  for (const ref of js) {
    const f = await read(ref, url);
    rec.js.push({ url: ref, status: f.status, found: holds(f.text, JS_MARKERS) });
  }
  for (const ref of css) {
    const f = await read(ref, url);
    rec.css.push({ url: ref, status: f.status, found: holds(f.text, CSS_MARKERS) });
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", APP_URL), root: opt("--root", null) ? path.resolve(opt("--root", null)) : null });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
