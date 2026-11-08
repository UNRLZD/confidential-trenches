#!/usr/bin/env node
// Live check of card app-legend-holds-still: the token page's live numbers hold still. Headless Chromium opens
// APP_HOST/ (the token page: the helper's top Trending token) at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), finds
// the terminal's frame inside SIGN_HOST's shell and waits for the chart's legend. Then for HOLD_MS it lets the live
// reads tick (the chart's last bar, the footer's prices and block, the header's reads) and moves the mouse over the
// plot every MOVE_MS (on the phone a tap, the touch the chart's crosshair follows there), so the crosshair walks the bars and the legend shows values of many lengths. On the desktop the
// second half runs in Price (the toolbar's MCap / Price toggle, pressed once): MCap's compact values rarely change
// length, a price's trailing zeros do ($0.00123, $0.0012). Every layout shift in the terminal's frame from its first
// paint is read (app-shell.mjs INIT), with its element and its rects before and after.
// Verdict per width: the legend drew; the crosshair moved it (at least two legend texts read, so the run cannot pass on
// a legend that never changed); zero layout shifts while values ticked and the crosshair moved (a FAIL names each
// shift's element); the toggle's own redraw is the one shift not counted, and only while the browser marks it as
// following that press (hadRecentInput, 500 ms); no page error.
// After: app
//   node scripts/live-checks/app-legend-holds-still.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute,
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
const MOVE_MS = 400;
const READY_MS = 30_000;
// a first visit: no account (app-hop-sync-lock.mjs SIGNED_OUT), so no sheet covers the plot
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };

// ------------------------------------------------------------------------------------------------ the verdict
const shiftLine = (e) => `+${e.at}ms ${e.value.toFixed(5)}: ${e.sources.join(" | ") || "no source"}`;

export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(loads.length === WIDTHS.length, `${loads.length} load(s) of ${WIDTHS.length} (both widths)`);
  for (const l of loads) {
    say(l.legend === true, `${l.width}: the chart's legend ${l.legend ? "drew" : "did not draw"}`);
    if (!l.legend) continue;
    say(l.heldMs >= HOLD_MS, `${l.width}: held ${Math.round(l.heldMs / 1000)} s of ticks and ${l.moves} crosshair move(s) (${HOLD_MS / 1000} s asked)`);
    say(l.texts >= 2, `${l.width}: the crosshair moved the legend through ${l.texts} text(s)`);
    if (l.width === "desktop") say(l.toggled === true || l.noSupply === true, `desktop: the toolbar's Price ${l.toggled ? "pressed, its half held" : l.noSupply ? "not there (no supply read: the chart is in Price throughout)" : "not pressed"}`);
    const moved = l.shifts.filter((e) => !(l.toggled && e.input));
    say(moved.length === 0, `${l.width}: ${moved.length} layout shift(s)${moved.length ? ` [${moved.map(shiftLine).join("; ")}]` : ""}`);
    say(l.errors.length === 0, `${l.width}: ${l.errors.length} page error(s)${l.errors.length ? `: ${l.errors.join("; ")}` : ""}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
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

// runs in the frame: the legend shown (the page holds both layouts, one display: none) and its text
const LEGEND = () => {
  const l = [...document.querySelectorAll('[data-testid="chart-legend"]')].find((e) => e.getClientRects().length);
  const plot = l?.closest(".tkp-plot");
  const r = plot?.getBoundingClientRect();
  return l ? { text: l.textContent, plot: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null } : null;
};

async function watch(browser, w, harness, shots) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await ctx.route("**/*", (r) => (originOf(r.request().url()) === HELPER_HOST ? r.continue() : harness(r)));
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const load = { width: w.name, legend: false, toggled: false, heldMs: 0, moves: 0, texts: 0, shifts: [], errors };
  try {
    await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
    const f = await terminalFrame(page);
    const until = Date.now() + READY_MS;
    let lg = null;
    while (Date.now() < until && !(lg = await f.evaluate(LEGEND).catch(() => null))) await page.waitForTimeout(250);
    if (!lg?.plot) return load;
    load.legend = true;
    // the frame's offset in the window, so the mouse lands on the plot
    const fe = await f.frameElement().catch(() => null);
    const off = (fe && (await fe.boundingBox())) ?? { x: 0, y: 0 };
    const texts = new Set([lg.text]);
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < HOLD_MS) {
      // the desktop's second half in Price (a press, so the browser marks its redraw as following input)
      if (!w.isMobile && load.toggled === false && Date.now() - t0 >= HOLD_MS / 2) {
        const mode = f.locator('[data-testid="chart-mode"][data-mc="true"]:not([disabled])');
        if ((await mode.count()) > 0) {
          await mode.first().click();
          load.toggled = true;
          const again = await f.evaluate(LEGEND).catch(() => null);
          if (again?.plot) lg = again;
        } else if ((await f.locator('[data-testid="chart-mode"][data-mc="false"]').count()) > 0) {
          load.noSupply = true;
          load.toggled = null;
        }
      }
      // the crosshair walks across the plot and back, then leaves it now and then, so the newest bar shows again
      const x = off.x + lg.plot.x + lg.plot.w * (0.05 + 0.9 * Math.abs(((i * 0.07) % 2) - 1));
      const y = off.y + lg.plot.y + lg.plot.h * 0.5;
      // the phone's crosshair follows a touch (the chart takes no mouse there): a tap at each point; the desktop's the mouse
      if (w.hasTouch) await page.touchscreen.tap(x, y);
      else if (i % 15 === 14) await page.mouse.move(off.x + lg.plot.x + lg.plot.w / 2, off.y + lg.plot.y + lg.plot.h + 40);
      else await page.mouse.move(x, y, { steps: 4 });
      load.moves++;
      i++;
      await page.waitForTimeout(MOVE_MS);
      const now = await f.evaluate(LEGEND).catch(() => null);
      if (now) texts.add(now.text);
    }
    load.heldMs = Date.now() - t0;
    load.texts = texts.size;
    load.shifts = await f.evaluate(() => window.__ct?.shiftLog ?? []);
    await page.screenshot({ path: path.join(shots, `${w.name}-token.png`) });
    return load;
  } finally {
    await ctx.close();
  }
}

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed", { state: SIGNED_OUT });
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const w of WIDTHS) rec.loads.push(await watch(browser, w, harness, shots));
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
  const { rec, shots } = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
  const record = opt("--record", null);
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`CARD ${KEY} / ${rec.source}: ${r.ok ? "PASS" : "FAIL"} (Chrome ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
