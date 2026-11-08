#!/usr/bin/env node
// Live check of card app-legend-holds-still: the token page's live numbers hold still. Headless Chromium opens
// APP_HOST/ (the token page: the helper's top Trending token) at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), finds
// the terminal's frame inside SIGN_HOST's shell and waits for the chart's legend. Then for at least HOLD_MS and STEPS
// steps it lets the live reads tick (the chart's last bar, the footer's prices and block, the header's reads) while the
// crosshair walks the bars, so the legend shows values of many lengths. On the desktop the second half runs in Price
// (the toolbar's MCap / Price toggle, pressed once): MCap's compact values rarely change length, a price's trailing
// zeros do ($0.00123, $0.0012). Every layout shift in the terminal's frame from its first paint is read (app-shell.mjs
// INIT), with its element and its rects before and after.
// The walk (card app-legend-crosshair-proof): each step reads the legend at rest, the crosshair on the newest bar (the
// main pane's right edge, past the last bar, which the library clamps to it), then at a point on the walk; a point's
// text is the crosshair's own only when it differs from the rest text read before it and the one read after it, so a
// tick or the Price press that changes the legend is never counted. On the phone the crosshair follows a tap, and the
// library takes a tap only once its 500 ms double-tap window has closed (klinecharts 10.0.3 index.esm.js:1369-1371,
// 1681-1700, 1783-1785; a second tap inside it is a double tap, no crosshair), and a tap 10 px or more from a shown
// crosshair only hides it (index.esm.js:2689-2700, 2805-2820): so each move is two taps TAP_MS apart (hide, then show
// at the point), whatever the crosshair showed before.
// Verdict per width: the legend drew; the walk held HOLD_MS and STEPS steps; the crosshair moved the legend through at
// least MIN_TEXTS texts of its own; zero layout shifts while values ticked and the crosshair moved (a FAIL names each
// shift's element); the toggle's own redraw is the one shift not counted, and only while the browser marks it as
// following that press (hadRecentInput, 500 ms); no page error. Under MIN_TEXTS crosshair texts on a chart of MIN_BARS
// bars or more, every step paced, the crosshair did not move the legend: FAIL; on a chart of fewer bars the walk cannot
// tell: INCONCLUSIVE, never a PASS.
// After: app
//   node scripts/live-checks/app-legend-holds-still.mjs [--build <dir>] [--path <route>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
// --path opens that route instead of / (a token page, /token/<chain>/<id>, to walk another token's chart); --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute,
// signed out as a first visit to APP_HOST is), the helper still answered live; --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, WIDTHS } from "./app-shell.mjs";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-legend-holds-still";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const HOLD_MS = 30_000;
/** The walk's floor in steps, so a slow step cannot end it on too few points (bounded: the walk ends at both). */
export const STEPS = 12;
/** Crosshair texts each width needs; and the bars a chart needs before fewer is a FAIL rather than INCONCLUSIVE. */
export const MIN_TEXTS = 3;
export const MIN_BARS = 24;
/** A tap after the library's 500 ms double-tap window closed (Delay.ResetClick); the desktop's mouse has none. */
const TAP_MS = 650;
const READ_MS = 250;
const READY_MS = 30_000;
// a first visit: no account (app-hop-sync-lock.mjs SIGNED_OUT), so no sheet covers the plot
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };

// ------------------------------------------------------------------------------------------------ the verdict
const shiftLine = (e) => `+${e.at}ms ${e.value.toFixed(5)}: ${e.sources.join(" | ") || "no source"}`;

/** The crosshair's own texts in a walk: a point's text that differs from the rest text read before it and after it. */
export function crosshairTexts(reads) {
  const own = new Set();
  reads.forEach((r, i) => {
    if (r.kind !== "point") return;
    const before = reads.slice(0, i).findLast((x) => x.kind === "rest");
    const after = reads.slice(i + 1).find((x) => x.kind === "rest");
    if (before && after && r.text !== before.text && r.text !== after.text) own.add(r.text);
  });
  return own;
}

/** A verdict's exit code: PASS 0, FAIL 1, INCONCLUSIVE 3 (an error exits 2). */
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });

/** The check on one recorded run: { verdict: PASS | FAIL | INCONCLUSIVE, ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(loads.length === WIDTHS.length, `${loads.length} load(s) of ${WIDTHS.length} (both widths)`);
  for (const l of loads) {
    say(l.legend === true, `${l.width}: the chart's legend ${l.legend ? "drew" : "did not draw"}`);
    if (!l.legend) continue;
    const reads = l.reads ?? [];
    const points = reads.filter((r) => r.kind === "point").length;
    say(l.heldMs >= HOLD_MS && points >= STEPS, `${l.width}: held ${Math.round(l.heldMs / 1000)} s of ticks and ${points} crosshair point(s) (${HOLD_MS / 1000} s and ${STEPS} asked)`);
    const own = crosshairTexts(reads).size;
    const all = new Set(reads.map((r) => r.text)).size;
    const what = `the crosshair moved the legend through ${own} text(s) of its own in ${points} point(s) over ${l.bars} bar(s) (${all} text(s) read in all)`;
    if (own >= MIN_TEXTS) say(true, `${l.width}: ${what}`);
    else if (l.bars >= MIN_BARS) say(false, `${l.width}: ${what}, ${MIN_TEXTS} asked`);
    else lines.push(`INCONCLUSIVE ${l.width}: ${what}: ${MIN_BARS} bars or more needed to tell`);
    if (l.width === "desktop") say(l.toggled === true || l.noSupply === true, `desktop: the toolbar's Price ${l.toggled ? "pressed, its half held" : l.noSupply ? "not there (no supply read: the chart is in Price throughout)" : "not pressed"}`);
    const moved = l.shifts.filter((e) => !(l.toggled && e.input));
    say(moved.length === 0, `${l.width}: ${moved.length} layout shift(s)${moved.length ? ` [${moved.map(shiftLine).join("; ")}]` : ""}`);
    say(l.errors.length === 0, `${l.width}: ${l.errors.length} page error(s)${l.errors.length ? `: ${l.errors.join("; ")}` : ""}`);
  }
  const bad = lines.length === 0 || lines.some((l) => l.startsWith("BAD"));
  const verdict = bad ? "FAIL" : lines.some((l) => l.startsWith("INCONCLUSIVE")) ? "INCONCLUSIVE" : "PASS";
  return { verdict, ok: verdict === "PASS", lines };
}

// ------------------------------------------------------------------------------------------------ the live read
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/** The terminal's frame inside SIGN_HOST's shell, waited for up to 8 s; the top window when there is none. */
async function terminalFrame(page) {
  const until = Date.now() + 8_000;
  for (;;) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f || Date.now() > until) return f ?? page.mainFrame();
    await page.waitForTimeout(100);
  }
}

// runs in the frame: the legend shown (the page holds both layouts, one display: none), its text, the bars drawn and
// the candle pane's main canvas (the widest at the chart's top; the price axis is its own, narrower canvas to its right)
const LEGEND = () => {
  const l = [...document.querySelectorAll('[data-testid="chart-legend"]')].find((e) => e.getClientRects().length);
  const plot = l?.closest(".tkp-plot");
  const kc = plot?.querySelector('[data-testid="chart-canvas"]');
  const rects = [...(kc?.querySelectorAll("canvas") ?? [])].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const top = Math.min(...rects.map((r) => r.y));
  const main = rects.filter((r) => r.y === top).sort((a, b) => b.width - a.width)[0];
  return l ? { text: l.textContent, bars: Number(kc?.dataset.bars ?? 0), main: main ? { x: main.x, y: main.y, w: main.width, h: main.height } : null } : null;
};

async function watch(browser, w, harness, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await ctx.route("**/*", (r) => (originOf(r.request().url()) === HELPER_HOST ? r.continue() : harness(r)));
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const load = { width: w.name, legend: false, toggled: false, heldMs: 0, bars: 0, reads: [], shifts: [], errors };
  try {
    await page.goto(`${APP_HOST}${route}`, { waitUntil: "load" });
    const f = await terminalFrame(page);
    const until = Date.now() + READY_MS;
    let lg = null;
    while (Date.now() < until && !(lg = await f.evaluate(LEGEND).catch(() => null))?.main) await page.waitForTimeout(250);
    if (!lg?.main) return load;
    load.legend = true;
    // the frame's offset in the window, so the pointer lands on the plot
    const fe = await f.frameElement().catch(() => null);
    const off = (fe && (await fe.boundingBox())) ?? { x: 0, y: 0 };
    let tapped = 0;
    // the crosshair to (x, y) in the main canvas's own px: the desktop's mouse; the phone's two taps, each after the
    // library's double-tap window, the first hiding a crosshair shown elsewhere, the second showing it here
    const to = async (x, y) => {
      const at = { x: off.x + lg.main.x + x, y: off.y + lg.main.y + y };
      if (!w.hasTouch) return page.mouse.move(at.x, at.y, { steps: 4 });
      for (let n = 0; n < 2; n++) {
        await page.waitForTimeout(Math.max(0, tapped + TAP_MS - Date.now()));
        tapped = Date.now();
        await page.touchscreen.tap(at.x, at.y);
      }
    };
    const read = async (kind) => {
      await page.waitForTimeout(READ_MS);
      const now = await f.evaluate(LEGEND).catch(() => null);
      if (now?.main) lg = now;
      if (now) load.reads.push({ kind, at: Date.now() - t0, text: now.text });
    };
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < HOLD_MS || i < STEPS) {
      // the desktop's second half in Price (a press, so the browser marks its redraw as following input)
      if (!w.isMobile && load.toggled === false && Date.now() - t0 >= HOLD_MS / 2) {
        const mode = f.locator('[data-testid="chart-mode"][data-mc="true"]:not([disabled])');
        if ((await mode.count()) > 0) {
          await mode.first().click();
          load.toggled = true;
        } else if ((await f.locator('[data-testid="chart-mode"][data-mc="false"]').count()) > 0) {
          load.noSupply = true;
          load.toggled = null;
        }
      }
      // at rest: the crosshair past the newest bar (the library holds it on the newest), then a point on the walk,
      // spread over the plot's left 85 % so that each lands on another bar
      await to(lg.main.w - 3, lg.main.h * 0.5);
      await read("rest");
      await to(lg.main.w * (0.05 + 0.8 * ((i * 0.618) % 1)), lg.main.h * 0.5);
      await read("point");
      i++;
    }
    await to(lg.main.w - 3, lg.main.h * 0.5);
    await read("rest");
    load.heldMs = Date.now() - t0;
    load.bars = lg.bars;
    load.shifts = await f.evaluate(() => window.__ct?.shiftLog ?? []);
    await page.screenshot({ path: path.join(shots, `${w.name}-token.png`) });
    return load;
  } finally {
    await ctx.close();
  }
}

export async function collect({ build = null, route = "/", shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed", { state: SIGNED_OUT });
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", route, at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const w of WIDTHS) rec.loads.push(await watch(browser, w, harness, shots, route));
  } finally {
    await browser.close();
  }
  return { rec, shots };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : d;
  };
  const { rec, shots } = await collect({ build: opt("--build", null), route: opt("--path", "/"), shots: opt("--shots", undefined) });
  const record = opt("--record", null);
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`CARD ${KEY} / ${rec.source} ${rec.route}: ${r.verdict} (Chrome ${rec.browser}, shots ${shots})`);
  process.exit(EXIT[r.verdict]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
