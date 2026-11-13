#!/usr/bin/env node
// Live check of card rail-open-pushes-the-middle: on the token page, the slim left rail opened by its » takes its width
// from the middle column (the chart and the orders move right by what the rail grew, and the rail's box never overlaps
// them); « closes it back to the rings and the chart returns. Headless Chromium opens APP_HOST/ (the top Trending
// token's page) at 1440 x 900 and 1280 x 900, where the rail is slim, finds the terminal's frame inside SIGN_HOST's
// shell, and reads the rail's, the chart's and the orders' boxes closed, opened and closed again, and the header's
// identity: its symbol drawn whole and its content clear of the strip (a narrower main column drops the strip's last
// tiles instead). A screenshot of each state is kept.
// After: app
// Bundle: out a browser and the helper
//   node scripts/live-checks/rail-open-pushes-the-middle.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute), the
// helper still answered live; --record writes what the run read (boxes only, no ids), so the check's test can replay it
// through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "rail-open-pushes-the-middle";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The widths the rail is slim at (it is full from 1500 css px, slim from 1180). */
export const WIDTHS = [1440, 1280];
const READ_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the verdict
const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.5;

/** The check on one recorded run: { views: [{ width, state, closed, open, shut }] }, each a box read (BOXES). */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const views = rec.views ?? [];
  say(WIDTHS.every((w) => views.some((v) => v.width === w)), `${views.length} view(s), want one at each of ${WIDTHS.join(" and ")}`);
  for (const v of views) {
    const tag = `/ at ${v.width}`;
    const { closed: c, open: o, shut: s } = v;
    say(v.state === "ready" && !!c && !!o && !!s, `${tag}: the token page is ${v.state ?? "not drawn"}${c && o && s ? "" : ", a state not read"}`);
    if (!c || !o || !s) continue;
    say(c.slim === "true" && near(c.railW, 78), `${tag}: closed, the rail is ${c.railW} wide (slim ${c.slim}), want the 78 rings`);
    say(o.open === "true" && near(o.railW, 340) && near(o.track, 340), `${tag}: opened, the rail is ${o.railW} wide in a ${o.track} column (open ${o.open}), want 340 in its own 340 column`);
    const grew = o.railRight - c.railRight;
    say(grew > 100 && near(o.chartLeft - c.chartLeft, grew) && near(o.lowerLeft - c.lowerLeft, grew), `${tag}: opened, the rail grew ${grew.toFixed(1)} px, the chart moved ${(o.chartLeft - c.chartLeft).toFixed(1)} and the orders ${(o.lowerLeft - c.lowerLeft).toFixed(1)}; want both moved by what the rail grew`);
    say(o.railRight <= o.chartLeft + 0.5 && o.railRight <= o.lowerLeft + 0.5, `${tag}: opened, the rail's right edge ${o.railRight.toFixed(1)} against the chart's ${o.chartLeft.toFixed(1)} and the orders' ${o.lowerLeft.toFixed(1)}; want no overlap`);
    say(o.scroll <= 0, `${tag}: opened, horizontal scroll ${o.scroll} px`);
    for (const [k, b] of [["closed", c], ["opened", o]])
      say(b.symCut === false && typeof b.identInk === "number" && b.identInk <= b.stripLeft + 0.5, `${tag}: ${k}, the identity's content ends at ${b.identInk} against the strip's ${b.stripLeft} (symbol cut ${b.symCut}, tiles ${(b.tiles ?? []).join(" ")}); want the symbol whole and clear of the strip`);
    say(s.open === "false" && near(s.railW, 78) && near(s.chartLeft, c.chartLeft), `${tag}: closed by «, the rail is ${s.railW} wide (open ${s.open}), the chart at ${s.chartLeft} (was ${c.chartLeft}); want the rings and the chart back`);
  }
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
/** The rail's, the chart's and the orders' boxes in the terminal's frame (null before the rail is drawn). */
const BOXES = () => {
  const desk = document.querySelector(".tkp-desk");
  const rail = desk?.querySelector('[data-testid="token-rail"]');
  if (!desk || !rail) return null;
  const R = (e) => e?.getBoundingClientRect() ?? null;
  const rr = R(rail);
  const chart = R(desk.querySelector(".tkp-chart"));
  const lower = R(desk.querySelector(".tkp-main > :last-child"));
  const ident = desk.querySelector(".tkp-ident");
  const sym = desk.querySelector(".tkp-sym");
  return {
    state: document.querySelector("[data-token-page]")?.getAttribute("data-token-page") ?? null,
    rail: rail.getAttribute("data-state"),
    open: rail.getAttribute("data-open"),
    slim: rail.getAttribute("data-slim"),
    railW: rail.offsetWidth,
    track: parseFloat(getComputedStyle(desk).gridTemplateColumns.split(" ")[0]),
    railRight: rr.right,
    chartLeft: chart?.left ?? null,
    lowerLeft: lower?.left ?? null,
    scroll: document.documentElement.scrollWidth - window.innerWidth,
    identInk: ident ? Math.max(...[...ident.querySelectorAll("*")].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect().right)) : null,
    stripLeft: R(desk.querySelector(".tkp-strip"))?.left ?? null,
    symCut: !sym || sym.clientWidth < 1 || sym.scrollWidth > sym.clientWidth + 0.5,
    tiles: [...desk.querySelectorAll(".tkp-strip > [data-k]")].filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-k")),
  };
};

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "tap");
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), views: [] };
  try {
    for (const width of WIDTHS) {
      const view = { width, state: null, closed: null, open: null, shut: null, shots: [] };
      rec.views.push(view);
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
      if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
      const page = await ctx.newPage();
      await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
      let app = null;
      let m = null;
      for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
        for (const f of app ? [app] : page.frames()) {
          const x = await f.evaluate(BOXES).catch(() => null);
          if (x) {
            app = f;
            m = x;
            break;
          }
        }
        if (m && m.rail === "ready" && m.state === "ready") break;
      }
      view.state = m?.state ?? null;
      const shot = async (name) => {
        await page.waitForTimeout(400);
        const b = (await app.evaluate(BOXES).catch(() => null)) ?? null;
        const file = `${width}-${name}.png`;
        await page.screenshot({ path: path.join(shots, file) });
        view.shots.push(file);
        return b;
      };
      if (app && m) {
        view.closed = await shot("closed");
        const ex = await app.click('[data-testid="rail-expand"]', { timeout: 5_000 }).then(() => true, () => false);
        if (ex) view.open = await shot("open");
        const co = ex && (await app.click('[data-testid="rail-collapse"]', { timeout: 5_000 }).then(() => true, () => false));
        if (co) view.shut = await shot("shut");
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
