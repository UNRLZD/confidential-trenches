#!/usr/bin/env node
// The token page's rail is full wherever the full rail fits uncut (card app-token-rail-r5-fit; research repo
// docs/owner-decisions.md, 8 Nov 19:40Z: "the rail is full wherever the full rail fits uncut, measured on the rail's own
// box (a container rule, not viewport breakpoints), slim only where the full one would be cut"). From the built app at /
// inside the stand-in shell (as run.mjs, its fixtures and its long header symbol), signed out, at every width from 1100
// to 1920 css px in 20 px steps, 1512, 1728 and 1024 to 1080 (the fit zoom's floor), 900 tall:
//   - the rail's mode as drawn (full: 340 layout px with its head; slim: the rings and the expand button; none);
//   - the header's strip whole in the mode drawn: no tile cut, the strip clear of the trade column and the identity, the
//     symbol whole, no horizontal scroll;
//   - where the rail is slim, the full rail opened by its expand button (its own 340 column, as the full mode draws it):
//     if the strip is whole with it, the full rail fits there and slim is a fault;
//   - no rail at a width whose page box is 1180 layout px or more (R5's own floor for the slim rail, token.css at
//     design-lock-r5).
//   node apps/terminal/test/token-rail/sweep.mjs [--shots <dir>] [--widths <w,w,...>]     PASS exit 0, FAIL exit 1
// Each line names the room the header's symbol row has left with the symbol whole, in layout px (negative: cut).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";
import { APP_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { columnRows } from "../../src/screens/discover/model.ts";

const HELPER = "https://ct-api.unrealized.trade";
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const STEPS = Array.from({ length: (1920 - 1100) / 20 + 1 }, (_, i) => 1100 + 20 * i);
// the shots' widths: 1512 and 1728 (a 14 and a 16 inch laptop) are off the 20 px steps, so they are added
const SHOT_AT = [1280, 1440, 1512, 1728, 1920];
// under 1100: the fit zoom's floor (shell/fit.ts: 0.72 from 1024 css px), the narrowest pages the desktop draws zoomed,
// where the full rail's fit is closest
const FLOOR = [1024, 1040, 1060, 1080];
const only = args.indexOf("--widths");
const WIDTHS = only >= 0 ? args[only + 1].split(",").map(Number) : [...new Set([...FLOOR, ...STEPS, ...SHOT_AT])].sort((a, b) => a - b);

// run.mjs's fixtures: the recorded lists, the token read, / on mihao with a symbol as long as the live top token's on
// 13 Nov (Anthropic), so every width's header holds a symbol longer than the tile steps' budget
const recorded = JSON.parse(readFileSync(path.join(APP, "test/discover-data/helper-lists-2026-11-01.json"), "utf8"));
const tokenRest = JSON.parse(readFileSync(path.join(APP, "test/token-source/helper-token-2026-11-03.json"), "utf8")).rest;
const unzip = (v) => Object.fromEntries(recorded.fields.map((k, i) => [k, v[i]]));
const SNAP = { chain: recorded.chain, as_of_ms: recorded.as_of_ms, lists: Object.fromEntries(Object.entries(recorded.lists).map(([k, rows]) => [k, rows.map(unzip)])) };
const ROWS = new Map(Object.values(SNAP.lists).flat().map((r) => [r.token, r]));
const LONG_SYMBOL = "Anthropic";
const TOP = columnRows(SNAP, "trending")[0]?.token;
for (const r of Object.values(SNAP.lists).flat()) if (r.token === TOP) r.symbol = LONG_SYMBOL;
const OPEN = "4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump";
const openRead = JSON.parse(readFileSync(path.join(APP, "test/token-source/helper-token-mihao-2026-11-14.json"), "utf8"));
const OPEN_ROW = { ...Object.fromEntries(openRead.fields.map((k, i) => [k, openRead.row[i]])), symbol: LONG_SYMBOL };
const json = (status, body) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-token-rail-sweep-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

async function open(browser, route, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.addInitScript((app) => {
    if (location.origin === app) localStorage.setItem("ct-signin-hint", "out");
  }, APP_HOST);
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin === HELPER && u.pathname === "/v1/market/lists") return r.fulfill(json(200, { ...SNAP, as_of_ms: Date.now() }));
    if (u.origin === HELPER && u.pathname === "/v1/market/token") {
      const id = u.searchParams.get("token");
      if (u.searchParams.get("chain") === "solana" && id === OPEN) return r.fulfill(json(200, { ...openRead.rest, links: {}, row: { ...OPEN_ROW, as_of_ms: Date.now() } }));
      const row = u.searchParams.get("chain") === "solana" ? ROWS.get(id) : undefined;
      return r.fulfill(row ? json(200, { ...tokenRest, row: { ...row, as_of_ms: Date.now() } }) : json(404, { error: { code: "not_found" } }));
    }
    return route(r);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`@${width}: no APP_HOST frame inside the shell`);
  return { ctx, page, f, errors };
}

/** The rail's mode and the strip as drawn now. */
const READ = () => {
  const rail = document.querySelector('.tkp-desk [data-testid="token-rail"]');
  const R = (e) => e?.getBoundingClientRect() ?? null;
  const vis = (e) => !!e && e.getClientRects().length > 0;
  const page = document.querySelector("section.tkp");
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fit-zoom")) || 1;
  const strip = R(document.querySelector(".tkp-desk .tkp-strip"));
  const identEl = document.querySelector(".tkp-desk .tkp-ident");
  const identInk = identEl ? Math.max(...[...identEl.querySelectorAll("*")].filter(vis).map((e) => e.getBoundingClientRect().right)) : null;
  const sym = document.querySelector(".tkp-desk .tkp-sym");
  const main = R(document.querySelector(".tkp-desk .tkp-main"));
  const trade = R(document.querySelector(".tkp-desk .tkp-trade"));
  const cut = [...document.querySelectorAll(".tkp-desk .tkp-strip > *, .tkp-desk .tkp-strip .tkp-val, .tkp-desk .tkp-strip .tkp-lbl, .tkp-desk .tkp-strip .tkp-mcval")].filter((e) => vis(e) && e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent.trim());
  const slim = rail?.getAttribute("data-slim") === "true";
  return {
    mode: !vis(rail) ? "none" : slim ? "slim" : "full",
    railW: vis(rail) ? rail.offsetWidth : null,
    pageW: page ? page.offsetWidth : null,
    zoom: z,
    cut,
    off: !!strip && !!main && !!trade && (strip.right > trade.left + 0.5 || strip.right > main.right + 0.5 || strip.left < main.left - 0.5),
    under: !sym || sym.clientWidth < 1 || sym.scrollWidth > sym.clientWidth + 0.5 || identInk === null || !strip || identInk > strip.left + 0.5,
    tiles: [...document.querySelectorAll(".tkp-desk .tkp-strip > [data-k]")].filter(vis).map((e) => e.getAttribute("data-k")),
    scroll: document.documentElement.scrollWidth - window.innerWidth,
    // what the symbol's row has left once the symbol is drawn whole: negative, the symbol is cut by that much
    room: (() => {
      const row = document.querySelector(".tkp-desk .tkp-symrow");
      const icons = document.querySelector(".tkp-desk .tkp-icons");
      if (!row || !sym || !icons) return null;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      return Math.round(row.clientWidth - sym.scrollWidth - gap - icons.offsetWidth);
    })(),
  };
};
const whole = (p) => p.cut.length === 0 && !p.off && !p.under && p.scroll <= 0;
const say = (p) => `${p.mode}${p.railW !== null ? ` ${p.railW}` : ""} on a ${p.pageW} page, room ${p.room}, strip ${whole(p) ? "whole" : `cut (tiles cut ${JSON.stringify(p.cut)}, off ${p.off}, identity under ${p.under}, scroll ${p.scroll})`} [${p.tiles.join(" ")}]`;

const fails = [];
const rows = [];
const dir = await build();
const browser = await launchHarnessBrowser("chromium");
try {
  const route = await harnessRoute(dir, "tap");
  for (const w of WIDTHS) {
    const { ctx, page, f, errors } = await open(browser, route, w);
    const ok = await f.waitForSelector(`main[data-route="token"] [data-token-page="ready"][data-token="${OPEN}"]`, { timeout: 10_000 }).then(() => true, () => false);
    await f.waitForSelector('[data-testid="token-rail"][data-state="ready"]', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const p = await f.evaluate(READ);
    let line = `${w}: ${say(p)}`;
    if (!ok) fails.push(`${w}: / did not draw mihao`);
    if (!whole(p)) fails.push(`${w}: the strip is cut with the ${p.mode} rail: ${say(p)}`);
    if (p.mode === "none" && p.pageW >= 1180) fails.push(`${w}: no rail on a ${p.pageW} layout px page (R5 draws the slim rail from 1180)`);
    if (p.mode === "slim") {
      await f.locator('[data-testid="rail-expand"]').click();
      await page.waitForTimeout(300);
      const x = await f.evaluate(READ);
      line += `; opened: ${say(x)}`;
      if (x.railW !== null && Math.abs(x.railW - 340) <= 1 && whole(x)) fails.push(`${w}: slim, yet the full rail fits uncut here (${say(x)})`);
    }
    if (SHOTS && SHOT_AT.includes(w)) await page.screenshot({ path: path.join(SHOTS, `sweep-${w}.png`) });
    if (errors.length) fails.push(`${w}: page errors ${errors.join(" | ")}`);
    rows.push(line);
    await ctx.close();
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
for (const r of rows) console.log(r);
if (fails.length) {
  for (const x of fails) console.log(`FAIL ${x}`);
  console.log(`FAIL ${fails.length} of ${WIDTHS.length} widths (1024-1080, 1100-1920 by 20, 1512, 1728)`);
  process.exit(1);
}
console.log(`PASS ${WIDTHS.length} widths (1024-1080, 1100-1920 by 20, 1512, 1728): the strip whole at each, the full rail wherever it fits${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
