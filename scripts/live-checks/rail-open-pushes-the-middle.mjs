#!/usr/bin/env node
// Live check of card rail-open-pushes-the-middle: on the token page, the slim left rail opened by its » takes its width
// from the middle column (the chart and the orders move right by what the rail grew, and the rail's box never overlaps
// them); « closes it back to the rings and the chart returns. Headless Chromium opens APP_HOST/ (the top Trending
// token's page) at each width in WIDTHS, finds the terminal's frame inside SIGN_HOST's shell, and reads the rail's, the
// chart's and the orders' boxes closed, opened and closed again, and the header's identity: its symbol drawn whole and
// its content clear of the strip (a narrower main column drops the strip's last tiles instead). A screenshot of each
// state is kept.
// The widths (card rail-and-legend-hold-on-r5): the rail's mode is token.css's, on the page's own box in layout px
// (@container tkp-page: none to 1179.98, slim to 1526.98, full above), and the page is the screen drawn at --fit-zoom
// (shell/fit.ts: a screen of vw css px is a page of vw / fitScale(vw)). So the slim widths are read from both files, never
// guessed: SLIM_WIDTHS are the narrowest and the widest screen the rail is slim at (1024 and 1099 at release 178: a page
// of 1422.2 and 1526.4). At FULL_WIDTHS, 1440 and 1280 (pages of 1920 and 1777.8), the full rail is drawn in its own 340
// column with no » to open, as R5 draws it (research repo docs/owner-decisions.md, 8 Nov 19:40Z). Each view also reads
// the page's width, so a frame that is not the screen's width fails by its number.
// After: app
// Bundle: out a browser and the helper
//   node scripts/live-checks/rail-open-pushes-the-middle.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute) and
// reads no public host: the harness answers the helper from its recordings (/ opens its recorded open token; any read it
// holds no answer for is refused) and its browser mocks the push socket (scripts/harness-sockets.mjs); --record writes
// what the run read (boxes only, no ids), so the check's test can replay it through judge().
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitScale } from "../../apps/terminal/src/shell/fit.ts";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { named } from "./record-names.mjs";

const KEY = "rail-open-pushes-the-middle";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The page widths in layout px each mode ends at, from token.css's @container tkp-page rules that name --tkr-mode. */
export function railModes(css) {
  const ends = {};
  for (const m of css.matchAll(/@container tkp-page \(max-width: ([\d.]+)px\) \{[^@]*?--tkr-mode: (slim|none)/g)) ends[m[2]] = Number(m[1]);
  if (!(ends.none > 0 && ends.slim > ends.none)) throw new Error(`${KEY}: token.css names no none and slim page widths (${JSON.stringify(ends)})`);
  return ends;
}
export const MODES = railModes(readFileSync(path.join(HERE, "../../apps/terminal/src/screens/token/token.css"), "utf8"));
/** The page's width in layout px on a screen `vw` css px wide (shell/fit.ts), and the rail's mode there. */
export const pageAt = (vw) => vw / fitScale(vw);
export const modeAt = (vw, modes = MODES) => (pageAt(vw) <= modes.none ? "none" : pageAt(vw) <= modes.slim ? "slim" : "full");
/** The narrowest and the widest screen (css px, 320 to 3840) the rail is slim at. */
export function slimWidths(modes = MODES) {
  const at = [];
  for (let vw = 320; vw <= 3840; vw++) if (modeAt(vw, modes) === "slim") at.push(vw);
  if (!at.length) throw new Error(`${KEY}: no screen width draws the slim rail (${JSON.stringify(modes)})`);
  return [at[0], at.at(-1)];
}
export const SLIM_WIDTHS = slimWidths();
/** The screens R5 draws the full rail at. */
export const FULL_WIDTHS = [1440, 1280];
export const WIDTHS = [...SLIM_WIDTHS, ...FULL_WIDTHS];
const READ_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the verdict
const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.5;

/** The check on one recorded run: { views: [{ width, want, state, closed, open, shut }] }, each a box read (BOXES); `want`
 *  is the mode token.css and the fit zoom name at that width (a record from before card rail-and-legend-hold-on-r5 has
 *  none: its collector read only the widths it took the rail to be slim at). A full view reads only `closed`. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const views = rec.views ?? [];
  say(WIDTHS.every((w) => views.some((v) => v.width === w)), `${views.length} view(s) at ${views.map((v) => v.width).join(", ") || "none"}, want one at each of ${WIDTHS.join(", ")} (slim at ${SLIM_WIDTHS.join(" and ")}, full at ${FULL_WIDTHS.join(" and ")})`);
  say(SLIM_WIDTHS.every((w) => modeAt(w) === "slim") && FULL_WIDTHS.every((w) => modeAt(w) === "full"), `token.css and the fit zoom: slim at ${SLIM_WIDTHS.map((w) => `${w} (a ${pageAt(w).toFixed(1)} page)`).join(" and ")}, full at ${FULL_WIDTHS.map((w) => `${w} (${pageAt(w).toFixed(1)}: ${modeAt(w)})`).join(" and ")}`);
  for (const v of views) {
    const tag = `/ at ${v.width}`;
    const want = v.want ?? "slim";
    const { closed: c, open: o, shut: s } = v;
    // clientWidth is whole px: within 1 of the page the fit zoom makes
    const page = (b) => v.want === undefined || (typeof b.page === "number" && Math.abs(b.page - pageAt(v.width)) < 1);
    if (want === "full") {
      say(v.state === "ready" && !!c, `${tag}: the token page is ${v.state ?? "not drawn"}${c ? "" : ", the rail not read"}`);
      if (!c) continue;
      say(c.mode === "full" && c.slim === "false" && near(c.railW, 340) && near(c.track, 340) && c.expand === false, `${tag}: the rail is ${c.mode ?? "not named"} (slim ${c.slim}), ${c.railW} wide in a ${c.track} column, » ${c.expand ? "shown" : "not shown"}; want the full rail in its own 340 column`);
      say(page(c), `${tag}: the page is ${c.page} wide, want ${pageAt(v.width).toFixed(1)} (${v.width} / ${fitScale(v.width)})`);
      say(c.scroll <= 0, `${tag}: horizontal scroll ${c.scroll} px`);
      say(c.symCut === false && typeof c.identInk === "number" && c.identInk <= c.stripLeft + 0.5, `${tag}: the identity's content ends at ${c.identInk} against the strip's ${c.stripLeft} (symbol cut ${c.symCut}, tiles ${(c.tiles ?? []).join(" ")}); want the symbol whole and clear of the strip`);
      continue;
    }
    say(v.state === "ready" && !!c && !!o && !!s, `${tag}: the token page is ${v.state ?? "not drawn"}${c && o && s ? "" : ", a state not read"}`);
    if (!c || !o || !s) continue;
    say(c.slim === "true" && near(c.railW, 78) && (v.want === undefined || c.mode === "slim"), `${tag}: closed, the rail is ${c.railW} wide (slim ${c.slim}${v.want === undefined ? "" : `, mode ${c.mode}`}), want the 78 rings`);
    if (v.want !== undefined) say(page(c), `${tag}: the page is ${c.page} wide, want ${pageAt(v.width).toFixed(1)} (${v.width} / ${fitScale(v.width)})`);
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
    mode: rail.getAttribute("data-mode"),
    expand: !!rail.querySelector('[data-testid="rail-expand"]')?.getClientRects().length,
    // the page's own box in layout px (#root's zoom does not scale it), as token.css's container rules read it
    page: document.querySelector(".tkp")?.clientWidth ?? null,
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
  const browser = await (build ? launchHarnessBrowser : launchBrowser)("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, the helper recorded` : "live", at: new Date().toISOString(), browser: browser.version(), views: [] };
  try {
    for (const width of WIDTHS) {
      const view = { width, want: modeAt(width), state: null, closed: null, open: null, shut: null, shots: [] };
      rec.views.push(view);
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
      if (harness) await ctx.route("**/*", harness);
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
      if (app && m) view.closed = await shot("closed");
      // the full rail has no » to open: its closed read is the view
      if (app && m && view.want === "slim") {
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
