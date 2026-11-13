#!/usr/bin/env node
// The token chart drags, zooms and tracks the pointer (card chart-drags-and-tracks-the-pointer), on the built app inside
// SIGN_HOST's shell as the deployed app runs (the harness serves both hosts from local files, app-in-shell.mjs
// --harness), at 1440 x 900 with device pixel ratio 1 and 2 (the shell's design fit draws #root at zoom 0.75 there) and
// at 390 x 844 with touch. The owner, 11 Nov on the deployed app: "the chart is very flaky, dragging does not work and it
// doesn't mapped with the mouse correctly". Per width:
//   - the crosshair as drawn (its lines read off the chart's own canvases, its time and price labels' boxes) sits under
//     the pointer at three points, within 1.5 px;
//   - a drag of a known distance (begun on a trade mark on the desktop) pans the newest bar by that distance, the
//     marks move with their candles, and on the phone the page does not scroll;
//   - a wheel (desktop) or a pinch (phone) zooms about the pointer: the bar under it stays under it;
//   - a dragged chart holds still when a live read changes a bar before the newest (a late trade);
//   - on the desktop a hover on a mark's disc opens its card;
//   - dragged a few px at a time across more than one tick spacing, no time label is cut at the plot's edge (card
//     app-faults-seen-on-126; the read is that card's live check's, scripts/live-checks/app-faults-seen-on-126.mjs).
// The view is read from the chart host's data-view (the newest bar's x in the candle pane and the bar space, the plot's
// own px, chart.ts); the pointer is the window's.
//   node apps/terminal/test/chart-pointer/run.mjs [--shots <dir>] [--app <terminal dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";
import { SPAN, sweep } from "../../../../scripts/live-checks/app-faults-seen-on-126.mjs";
import { FIXTURE_NOW_MS, TOKENS } from "../token-page/fixtures.ts";

const HELPER = "https://ct-api.unrealized.trade";
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const APP = opt("--app") ? path.resolve(opt("--app")) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHOTS = opt("--shots") ? path.resolve(opt("--shots")) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "1440-dpr1", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "1440-dpr2", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const LIVE_MS = 1_000;
const TAP_MS = 650;

// ------------------------------------------------------------------------------------------------ the helper's answers
const STEP = 900;
// the helper's full read (candles.ts CANDLES_LIMIT): more bars than the plot holds, as a busy token's
const COUNT = 500;
const endS = Math.floor(Date.now() / 1000 / STEP) * STEP;
const f12 = (x) => x.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
function bars(base, late) {
  const out = [];
  let c = base;
  for (let i = 0; i < COUNT; i++) {
    const o = c;
    c = base * (1 + 0.25 * Math.sin(i / 9) + 0.08 * Math.sin(i * 1.7));
    out.push([endS - (COUNT - 1 - i) * STEP, f12(o), f12(Math.max(o, c) * 1.02), f12(Math.min(o, c) * 0.98), f12(c), String(200 + ((i * 37) % 23) * 90)]);
  }
  // a late trade in the bar before the newest: its close and high moved
  if (late) {
    const b = out[COUNT - 2];
    b[4] = f12(Number(b[4]) * 1.03);
    b[2] = f12(Math.max(Number(b[2]), Number(b[4])));
  }
  return out;
}
// the token-page run's pool token, its age kept at the run's clock (that run's live())
const row = () => {
  const r = TOKENS.pool;
  const shift = Math.floor((Date.now() - FIXTURE_NOW_MS) / 1000);
  return { ...r, chain: "solana", created_s: typeof r.created_s === "number" ? r.created_s + shift : r.created_s, as_of_ms: Date.now() };
};
function tape(base) {
  const bs = bars(base, false);
  return Array.from({ length: 24 }, (_, i) => {
    const b = bs[bs.length - 1 - i * 3];
    const usd = 20 + ((i * 53) % 400);
    return { t_ms: b[0] * 1000 + 30_000, side: i % 3 === 0 ? "s" : "b", usd: usd.toFixed(2), amt: (usd / Number(b[4])).toFixed(6), trader: `Trader${i % 5}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx${i % 5}`, tx: `tx${i}` };
  });
}
function answer(u, st) {
  const json = (status, body, h = {}) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST, ...h }, body: JSON.stringify(body) });
  const r = row();
  const base = Number(r.price_usd);
  if (u.pathname === "/v1/market/lists") {
    // the top of the Trending column: a row with an hour's volume (discover/model.ts columnRows)
    const top = [{ ...r, vol_1h_usd: r.vol_1h_usd ?? "1000" }];
    return json(200, { chain: "solana", as_of_ms: Date.now(), lists: { new: [], trending: top, trending_5m: [], trending_1h: top, graduating: [] } });
  }
  if (u.pathname === "/v1/market/token") return json(200, { row: r, decimals: 6, pool: null, risk: {}, route: "ok" });
  if (u.pathname === "/v1/market/candles") {
    if (u.searchParams.get("tf") !== "15m") return json(200, { tf: u.searchParams.get("tf"), candles: [], src: "chain", as_of_ms: Date.now() }, { "x-helper-source": "chain", "access-control-expose-headers": "X-Helper-Source" });
    let b = bars(base, st.late);
    const limit = Number(u.searchParams.get("limit"));
    if (limit && limit < COUNT) b = b.slice(-limit);
    return json(200, { tf: "15m", candles: b, src: "chain", own_from_s: b[0][0], as_of_ms: Date.now() }, { "x-helper-source": "chain", "access-control-expose-headers": "X-Helper-Source" });
  }
  if (u.pathname === "/v1/market/trades") return json(200, { trades: tape(base), src: "chain", as_of_ms: Date.now() });
  if (u.pathname === "/v1/market/holders") return json(200, { holders: [], total: r.holders, top_bps: r.top10_bps, src: "jupiter", as_of_ms: Date.now() });
  return null;
}

// ------------------------------------------------------------------------------------------------ reads in the frame
/** The chart as drawn, in the frame's visual px: the host's box and zoom, the crosshair's lines and its labels' boxes. */
const DRAWN = (box) => {
  const host = document.querySelector(`${box} [data-testid="chart-canvas"]`);
  const hb = host.getBoundingClientRect();
  const zoom = hb.width / host.offsetWidth;
  const grey = (d, i) => d[i + 3] > 40 && Math.abs(d[i] - d[i + 1]) < 4 && Math.abs(d[i + 1] - d[i + 2]) < 4 && d[i] >= 40 && d[i] <= 110;
  const label = (d, i) => d[i + 3] > 250 && Math.abs(d[i] - 42) <= 2 && Math.abs(d[i + 1] - 42) <= 2 && Math.abs(d[i + 2] - 42) <= 2;
  let vx = null, hy = null, best = 0, bestH = 0, tx = null, py = null;
  for (const c of host.querySelectorAll("canvas")) {
    const r = c.getBoundingClientRect();
    if (!c.width || !c.height) continue;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const sx = r.width / c.width, sy = r.height / c.height;
    const col = new Float64Array(c.width), rw = new Float64Array(c.height);
    let lx0 = Infinity, lx1 = -Infinity, ly0 = Infinity, ly1 = -Infinity, ln = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (grey(d, i)) { col[x] += d[i + 3] / 255; rw[y] += d[i + 3] / 255; }
        if (label(d, i)) { ln++; lx0 = Math.min(lx0, x); lx1 = Math.max(lx1, x); ly0 = Math.min(ly0, y); ly1 = Math.max(ly1, y); }
      }
    // the pane canvases: the crosshair's dashed lines, the column and the row with the most grey (weighted)
    if (r.width > 200 && r.height > 80) {
      for (let x = 0; x < c.width; x++) if (col[x] > best && col[x] > c.height * 0.15) { best = col[x]; vx = r.left + (x + 0.5) * sx; }
      for (let y = 0; y < c.height; y++) if (rw[y] > bestH && rw[y] > c.width * 0.15) { bestH = rw[y]; hy = r.top + (y + 0.5) * sy; }
    }
    if (ln > 20) {
      const cx = r.left + ((lx0 + lx1 + 1) / 2) * sx, cy = r.top + ((ly0 + ly1 + 1) / 2) * sy;
      // the x axis: a wide short canvas (the time label); the y axis: a narrow tall one (the price label)
      if (r.width > r.height) tx = cx;
      else py = cy;
    }
  }
  return { host: { left: hb.left, top: hb.top, width: hb.width, height: hb.height }, zoom, vx, hy, tx, py };
};
const VIEW = (box) => {
  const v = document.querySelector(`${box} [data-testid="chart-canvas"]`)?.getAttribute("data-view") ?? "";
  const [x, s] = v.split("|").map(Number);
  return Number.isFinite(x) && Number.isFinite(s) ? { x, space: s } : null;
};
const MARKS = (box) => [...document.querySelectorAll(`${box} [data-testid="trade-mark"]`)].map((e) => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(e.style.transform); return m ? { x: Number(m[1]), y: Number(m[2]) } : null; }).filter(Boolean);

// ------------------------------------------------------------------------------------------------ the run
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
  console.log(`${ok ? "ok " : "BAD"} ${what}`);
};
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-chart-pointer-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const dir = await build();
const route = await harnessRoute(dir, "signed");
const browser = await launchHarnessBrowser("chromium");
console.log(`browser: ${browserLabel(browser)}; app built from ${APP}`);
try {
  for (const w of WIDTHS) {
    const phone = w.hasTouch;
    const box = phone ? ".tkp-phone" : ".tkp-desk";
    const st = { late: false, reads: [] };
    const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
    await ctx.route("**/*", (r) => {
      const u = new URL(r.request().url());
      if (u.origin === HELPER) {
        if (st.reads.length < 12) st.reads.push(`${u.pathname}${u.search}`);
        const a = answer(u, st);
        if (a) return r.fulfill(a);
      }
      if (u.origin !== APP_HOST && u.origin !== SIGN_HOST) return r.abort();
      return route(r);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
    let f = null;
    for (const until = Date.now() + 10_000; !f && Date.now() < until; ) {
      f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
      if (!f) await page.waitForTimeout(100);
    }
    if (!f) throw new Error(`${w.name}: no APP_HOST frame inside the shell`);
    if (w.isMobile) {
      // the phone's / is the Trenches list (owner 12 Nov, "Phone home: Trenches list"): the chart is a row's tap away
      const row = f.locator('[data-testid="phone-trenches-row"]').first();
      await row.waitFor({ timeout: 10_000 }).catch(() => {});
      await row.tap().catch(() => {});
    }
    const ok = await f.waitForSelector(`${box} .tkp-plot[data-drawn="true"]`, { timeout: 15_000 }).then(() => true, () => false);
    if (!ok) {
      const state = await f.evaluate(() => ({ url: location.href, page: document.querySelector("[data-token-page]")?.getAttribute("data-token-page") ?? null, chart: [...document.querySelectorAll("[data-chart]")].map((e) => e.getAttribute("data-chart")), text: document.body.innerText.slice(0, 300) }));
      throw new Error(`${w.name}: the chart was not drawn: ${JSON.stringify(state)}; helper reads ${JSON.stringify(st.reads)}; errors ${errors.join(" | ")}`);
    }
    await f.waitForSelector(`${box} [data-testid="trade-mark"]`, { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const fb = await (await f.frameElement()).boundingBox();
    const d0 = await f.evaluate(DRAWN, box);
    const H = d0.host;
    // a point at (fx, fy) of the chart host, in the window's px
    const at = (fx, fy) => ({ x: fb.x + H.left + fx * H.width, y: fb.y + H.top + fy * H.height });
    const tag = `${w.name} (zoom ${d0.zoom.toFixed(3)}, dpr ${w.deviceScaleFactor})`;
    const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${w.name}-${name}.png`) });
    const cdp = phone ? await ctx.newCDPSession(page) : null;
    const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
    let tapped = 0;
    const tap = async (p) => {
      await page.waitForTimeout(Math.max(0, tapped + TAP_MS - Date.now()));
      tapped = Date.now();
      await page.touchscreen.tap(p.x, p.y);
    };

    // 1. the crosshair and its labels under the pointer at three points (points clear of the legend's rows)
    // the vertical line and the time label snap to the centre of the bar under the pointer (the library's rule, as
    // TradingView's): the want across is that centre, from the chart's own view; the want down is the pointer
    for (const [fx, fy] of [[0.25, 0.45], [0.5, 0.55], [0.62, 0.4]]) {
      const p = at(fx, fy);
      if (phone) {
        // the library's tap: the first hides a crosshair shown elsewhere, the second shows it here
        await tap(p);
        await tap(p);
      } else await page.mouse.move(p.x, p.y, { steps: 3 });
      await f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const d = await f.evaluate(DRAWN, box);
      const v = await f.evaluate(VIEW, box);
      const py = p.y - fb.y;
      const plotX = (p.x - fb.x - H.left) / d0.zoom;
      const px = v === null ? null : H.left + (v.x + Math.round((plotX - v.x) / v.space) * v.space) * d0.zoom;
      const xs = [d.vx, d.tx].map((q) => (q === null || px === null ? "none" : (q - px).toFixed(1)));
      const ys = [d.hy, d.py].map((q) => (q === null ? "none" : (q - py).toFixed(1)));
      check(near(d.vx, px, 1.5) && near(d.tx, px, 1.5) && near(d.hy, py, 1.5) && near(d.py, py, 1.5), `${tag}: pointer at ${(fx * 100).toFixed(0)}%,${(fy * 100).toFixed(0)}%: the crosshair's line and time label off by ${xs.join(", ")} px across from the centre of the bar under the pointer (${px === null ? "?" : (p.x - fb.x - px).toFixed(1)} px from the pointer), its line and price label ${ys.join(", ")} px down (want within 1.5)`);
      if (fx === 0.62) await shot("crosshair");
    }

    // 2. a drag pans by its distance; the marks move with their candles; the phone's page does not scroll
    if (phone) await tap(at(0.05, 0.9)); // the crosshair off
    else await page.mouse.move(at(0.5, 0.95).x, at(0.5, 0.95).y);
    await page.waitForTimeout(phone ? TAP_MS : 100);
    const v0 = await f.evaluate(VIEW, box);
    const m0 = await f.evaluate(MARKS, box);
    const scroll0 = await f.evaluate(() => [scrollX, scrollY, document.querySelector(".tkp-phone")?.scrollTop ?? 0]);
    const top0 = await page.evaluate(() => [scrollX, scrollY]);
    const D = phone ? 120 : 200;
    // the desktop's drag begins on a mark's disc, where a mark used to take the press
    // (one whose drag stays over the candles, clear of the price axis, ~80 px at the plot's right)
    const room = H.width / d0.zoom - 140 - D / d0.zoom;
    const mk = !phone ? (m0.filter((m) => m.x < room).sort((a, b) => b.x - a.x)[0] ?? null) : null;
    const r = phone ? 6 : 8;
    const start = mk ? { x: fb.x + H.left + (mk.x + r) * d0.zoom, y: fb.y + H.top + (mk.y + r) * d0.zoom + 0 } : at(0.4, 0.5);
    if (phone) {
      await touch("touchStart", [start]);
      for (let i = 1; i <= 12; i++) {
        await touch("touchMove", [{ x: start.x + (D * i) / 12, y: start.y + (30 * i) / 12 }]);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(250);
      await touch("touchEnd", []);
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(start.x + (D * i) / 10, start.y, { steps: 2 });
      await page.mouse.up();
    }
    await f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(100);
    const v1 = await f.evaluate(VIEW, box);
    const m1 = await f.evaluate(MARKS, box);
    const want = D / d0.zoom;
    const moved = v0 && v1 ? v1.x - v0.x : null;
    check(v0 !== null && near(moved, want, 1), `${tag}: a ${D} px drag${mk ? " begun on a trade mark" : ""} panned the newest bar ${moved?.toFixed(1)} of the plot's px, want ${want.toFixed(1)} (${D} px on screen)`);
    // the marks that were in the plot before the drag (a drag to the right brings older ones in from its left edge)
    const kept = m1.filter((b) => b.x + r - (moved ?? 0) >= 0);
    const followed = kept.filter((b) => m0.some((a) => Math.abs(a.x + (moved ?? 0) - b.x) <= 1));
    check(kept.length > 0 && followed.length === kept.length, `${tag}: ${followed.length} of ${kept.length} marks moved with their candles (${m0.length} before the drag)`);
    if (phone) {
      const scroll1 = await f.evaluate(() => [scrollX, scrollY, document.querySelector(".tkp-phone")?.scrollTop ?? 0]);
      const top1 = await page.evaluate(() => [scrollX, scrollY]);
      check(JSON.stringify(scroll1) === JSON.stringify(scroll0) && JSON.stringify(top1) === JSON.stringify(top0), `${tag}: the page scrolled while the chart was dragged (frame ${scroll0} -> ${scroll1}, top ${top0} -> ${top1})`);
    }
    await shot("dragged");

    // 3. a wheel (desktop) or a pinch (phone) zooms about the pointer: the bar under it stays under it
    {
      const p = at(0.7, 0.5);
      const plotX = (p.x - fb.x - H.left) / d0.zoom;
      const a = await f.evaluate(VIEW, box);
      if (phone) {
        const half = 40;
        await touch("touchStart", [{ x: p.x - half, y: p.y }, { x: p.x + half, y: p.y }]);
        for (let i = 1; i <= 8; i++) {
          await touch("touchMove", [{ x: p.x - half - 5 * i, y: p.y }, { x: p.x + half + 5 * i, y: p.y }]);
          await page.waitForTimeout(30);
        }
        await touch("touchEnd", []);
      } else {
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel(0, -240);
      }
      await f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(150);
      const b = await f.evaluate(VIEW, box);
      // the bar index (from the newest) under the pointer, before and after
      const ia = a ? (plotX - a.x) / a.space : null;
      const ib = b ? (plotX - b.x) / b.space : null;
      check(a !== null && b !== null && Math.abs(b.space - a.space) > 0.05 && near(ia, ib, 0.5), `${tag}: a ${phone ? "pinch" : "wheel"} at 70% across zoomed the bars ${a?.space.toFixed(2)} -> ${b?.space.toFixed(2)} px and the bar under the pointer moved ${ia !== null && ib !== null ? (ib - ia).toFixed(2) : "?"} bars (want within 0.5)`);
    }

    // 4. a late trade in the bar before the newest: the dragged chart holds still
    {
      const a = await f.evaluate(VIEW, box);
      st.late = true;
      await page.waitForTimeout(3 * LIVE_MS);
      const b = await f.evaluate(VIEW, box);
      check(a !== null && b !== null && near(a.x, b.x, 0.5) && near(a.space, b.space, 0.001), `${tag}: a late trade in the bar before the newest moved the dragged chart: newest bar x ${a?.x} -> ${b?.x}, bar space ${a?.space} -> ${b?.space}`);
    }

    // 5. the desktop: a hover on a mark's disc opens its card, and the crosshair follows the pointer over it
    if (!phone) {
      const ms = await f.evaluate(MARKS, box);
      const m = ms.find((q) => q.x > 20 && q.x < H.width / d0.zoom - 40);
      if (m) {
        const p = { x: fb.x + H.left + (m.x + r) * d0.zoom, y: fb.y + H.top + (m.y + r) * d0.zoom };
        await page.mouse.move(p.x, p.y, { steps: 3 });
        await f.waitForSelector(`${box} [data-testid="trade-mark-card"]`, { timeout: 2_000 }).catch(() => {});
        const card = await f.locator(`${box} [data-testid="trade-mark-card"]`).isVisible().catch(() => false);
        await f.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const d = await f.evaluate(DRAWN, box);
        check(card && near(d.vx, p.x - fb.x, 1.5), `${tag}: a hover on a mark: card ${card ? "open" : "not open"}, the crosshair's line ${d.vx === null ? "not drawn" : `${(d.vx - (p.x - fb.x)).toFixed(1)} px off`} the pointer`);
        await shot("mark-hover");
      } else check(false, `${tag}: no trade mark inside the plot to hover`);
    }

    // 6. card app-faults-seen-on-126 (the walk of release 126 at 1440 and 390: the last time label read "01::"): dragged
    // across more than one tick spacing a few px at a time, the time axis as drawn holds no label cut at either edge
    {
      if (!phone) await page.mouse.move(at(0.5, 0.95).x, at(0.5, 0.95).y);
      const reads = await sweep(page, f, box, { touch: phone, span: phone ? SPAN.phone : SPAN.desktop, shot: () => shot("axis-cut") });
      const cut = reads.filter((x) => x.cut !== null);
      check(reads.length > 0 && reads.every((x) => x.labels >= 1) && cut.length === 0, `${tag}: the time axis over ${reads.length} drag offsets: ${cut.length} with a label cut at the plot's edge${cut.length ? ` (${cut.map((x) => `dx ${x.dx} ${x.cut}`).join(", ")})` : ""}, labels ${Math.min(...reads.map((x) => x.labels))} to ${Math.max(...reads.map((x) => x.labels))} (want none cut, at least one at each)`);
    }
    check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`CARD chart-drags-and-tracks-the-pointer / chart-pointer: ${fails.length ? `FAIL (${fails.length})` : "PASS"}`);
process.exit(fails.length ? 1 : 0);
