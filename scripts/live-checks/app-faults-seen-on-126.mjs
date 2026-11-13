#!/usr/bin/env node
// Live check of card app-faults-seen-on-126: the token chart's time labels are drawn whole (the signed-in walk of
// release 126, 13 Nov 00:41Z, at 1440 and 390: the last label on the x axis read "01::", cut by the plot's edge). The
// library centres each tick's text on its bar and clips it to the plot, so whether a label is cut depends on where the
// ticks fall; the check drags the chart across one tick spacing and more, a few px at a time, and at each offset reads
// the time axis as drawn: the axis canvas's own pixels in the tick text's grey (the crosshair's label is another colour),
// its labels as runs of inked columns, and whether any ink touches the canvas's first or last px column (a label cut
// there). Signed out, headless Chromium, at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), the token page of a coin
// with a full history (BONK: the helper's 500 bars). Want, at each width: the chart drawn, every offset read with at
// least one label, no label cut at either edge. Portfolio's faults of the same walk need an account, so they are held
// by the portfolio suite (apps/terminal/test/portfolio/run.mjs), not here.
// After: app
// Bundle: out a browser and the helper's chart bars (its --harness run is in test-browser)
//   node scripts/live-checks/app-faults-seen-on-126.mjs [--shots <dir>] [--record <file>]
//     the deployed SIGN_HOST, APP_HOST and helper as served, as a signed-out visitor
//   node scripts/live-checks/app-faults-seen-on-126.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name inside the stand-in shell signed out,
//     the stand-in helper's token with 500 bars of 15 min
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-faults-seen-on-126";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** BONK on Solana: the helper serves its 500 bars of 15 min (13 Nov 06:30Z). */
export const LIVE_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
/** The stand-in helper's one token (app-in-shell.mjs TOKEN_ANSWER, apps/terminal/test/token-source). */
export const HARNESS_MINT = "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF";
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** The drag, in the window's px: a step, and the span on each width (more than one tick spacing: the library spaces its
 *  ticks by the wider of 'YYYY-MM-DD HH:mm:ss' at 11 px and an eighth of the plot, about 130 px of the plot's own). */
export const STEP = 4;
export const SPAN = { phone: 160, desktop: 200 };
const READY_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (phone and desktop)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true && r.drawn === true, `${n}: ${!r.framed ? "not inside SIGN_HOST's shell" : r.drawn ? "the chart drawn" : "the chart never drawn"}`);
    if (!r.drawn) continue;
    const reads = r.reads ?? [];
    const want = Math.floor((SPAN[n] ?? 0) / STEP) + 1;
    say(reads.length >= want, `${n}: ${reads.length} drag offset(s) read, want ${want} (0 to ${SPAN[n]} px by ${STEP})`);
    const blind = reads.filter((x) => !(x.labels >= 1));
    say(reads.length > 0 && blind.length === 0, blind.length ? `${n}: no time label read at ${blind.length} offset(s) (dx ${blind.map((x) => x.dx).join(", ")})` : `${n}: time labels read at every offset (${Math.min(...reads.map((x) => x.labels))} to ${Math.max(...reads.map((x) => x.labels))})`);
    const cut = reads.filter((x) => x.cut !== null);
    say(cut.length === 0, cut.length ? `${n}: a time label cut at the plot's edge at ${cut.length} of ${reads.length} offsets (${cut.map((x) => `dx ${x.dx} ${x.cut}`).join(", ")})` : `${n}: no time label cut at either edge over ${reads.length} offsets`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** The time axis as drawn, in the terminal's frame: each wide, short canvas of the chart (the axis pane's), its columns
 *  inked in the tick text's grey (--text-3, #6e6e6e; the crosshair's label is #2a2a2a and #e6e6e6, its columns left
 *  out), grouped into labels (inked columns under 5 px apart are one), and whether ink touches its first or last px. */
export const AXIS = (box) => {
  const host = document.querySelector(`${box} [data-testid="chart-canvas"]`);
  if (!host) return null;
  const out = [];
  for (const c of host.querySelectorAll("canvas")) {
    const r = c.getBoundingClientRect();
    if (!c.width || !c.height || r.width < 200 || r.height >= 40) continue;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const ink = new Uint8Array(c.width);
    // the crosshair's label box (#2a2a2a, opaque): its columns are not a tick's, whatever its text blends to
    const box = new Uint8Array(c.width);
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] > 250 && Math.abs(d[i] - 42) <= 3 && Math.abs(d[i + 1] - 42) <= 3 && Math.abs(d[i + 2] - 42) <= 3) box[x] = 1;
        else if (d[i + 3] > 60 && d[i] >= 80 && d[i] <= 150 && Math.abs(d[i] - d[i + 1]) <= 10 && Math.abs(d[i + 1] - d[i + 2]) <= 10) ink[x] = 1;
      }
    for (let x = 0; x < c.width; x++) if (box[x]) ink[x] = 0;
    const px = Math.max(1, Math.round(c.width / r.width));
    const labels = [];
    for (let x = 0; x < c.width; x++) {
      if (!ink[x]) continue;
      const last = labels.at(-1);
      if (last && x - last[1] <= 5 * px) last[1] = x;
      else labels.push([x, x]);
    }
    const edge = (from, to) => ink.slice(from, to).some((v) => v === 1);
    out.push({ w: c.width, labels: labels.length, left: edge(0, px), right: edge(c.width - px, c.width) });
  }
  return out;
};

const frames = (f) => f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * Drags the chart in `box` of the terminal's frame `f` right by `span` window px, `step` at a time (a mouse on the
 * desktop, a touch on the phone), and reads AXIS at each offset: [{ dx, labels, cut: "left" | "right" | null }]. `shot`
 * is called once, at the first offset that reads a cut label.
 */
export async function sweep(page, f, box, { touch, span, step = STEP, shot = null }) {
  const fb = await (await f.frameElement()).boundingBox();
  const H = await f.evaluate((box) => document.querySelector(`${box} [data-testid="chart-canvas"]`).getBoundingClientRect().toJSON(), box);
  const start = { x: fb.x + H.left + H.width * 0.3, y: fb.y + H.top + H.height * 0.45 };
  const reads = [];
  let shotTaken = false;
  const read = async (dx) => {
    await frames(f);
    const a = (await f.evaluate(AXIS, box)) ?? [];
    const cut = a.some((x) => x.left) ? "left" : a.some((x) => x.right) ? "right" : null;
    reads.push({ dx, labels: Math.max(0, ...a.map((x) => x.labels)), cut });
    if (cut && shot && !shotTaken) {
      shotTaken = true;
      await shot();
    }
  };
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const t = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
    await t("touchStart", [start]);
    await read(0);
    for (let dx = step; dx <= span; dx += step) {
      await t("touchMove", [{ x: start.x + dx, y: start.y }]);
      await page.waitForTimeout(30);
      await read(dx);
    }
    await t("touchEnd", []);
    await cdp.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await read(0);
    for (let dx = step; dx <= span; dx += step) {
      await page.mouse.move(start.x + dx, start.y);
      await read(dx);
    }
    await page.mouse.up();
  }
  return reads;
}

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function terminal(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

async function runOne(browser, w, shots, route, token) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, drawn: false, reads: [] };
  try {
    if (route) await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${SIGN_HOST}/token/solana/${token}`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null;
    if (!f) return run;
    const box = w.isMobile ? ".tkp-phone" : ".tkp-desk";
    run.drawn = await f.waitForSelector(`${box} .tkp-plot[data-drawn="true"]`, { timeout: READY_MS }).then(() => true, () => false);
    if (!run.drawn) return run;
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}.png`) });
    run.reads = await sweep(page, f, box, { touch: w.hasTouch, span: SPAN[w.name], shot: () => page.screenshot({ path: path.join(shots, `${KEY}-${w.name}-cut.png`) }) });
  } finally {
    await ctx.close();
  }
  return run;
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source, harness = false }) {
  mkdirSync(shots, { recursive: true });
  const browser = await (harness ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route, harness ? HARNESS_MINT : LIVE_MINT));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

/** 500 bars of 15 min ending now, a walk around the token's price, as the helper answers /v1/market/candles. */
function bars(tf) {
  const step = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[tf] ?? 900;
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const f = (x) => x.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  const base = 0.0000273;
  const out = [];
  let c = base;
  for (let i = 0; i < 500; i++) {
    const o = c;
    c = base * (1 + 0.25 * Math.sin(i / 9) + 0.08 * Math.sin(i * 1.7));
    out.push([end - (499 - i) * step, f(o), f(Math.max(o, c) * 1.02), f(Math.min(o, c) * 0.98), f(c), String(200 + ((i * 37) % 23) * 90)]);
  }
  return out;
}

/** The stand-in shell signed out, its helper answering the chart's bars; APP_HOST from `build`. No build: nothing routed. */
export async function routeFor(build = null) {
  if (!build) return null;
  const shell = await harnessRoute(build, "tap");
  return (r) => {
    const u = new URL(r.request().url());
    if (u.origin === HELPER_HOST && u.pathname === "/v1/market/candles") {
      const tf = u.searchParams.get("tf") ?? "15m";
      const limit = Number(u.searchParams.get("limit") ?? 500);
      const b = bars(tf).slice(-Math.min(500, limit || 500));
      return r.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST, "x-helper-source": "chain", "access-control-expose-headers": "X-Helper-Source" }, body: JSON.stringify({ tf, candles: b, src: "chain", own_from_s: b[0][0], as_of_ms: Date.now() }) });
    }
    return shell(r);
  };
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${SIGN_HOST} and ${APP_HOST}, the helper as served, signed out`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed out`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route: await routeFor(build), source, harness: build !== null });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
