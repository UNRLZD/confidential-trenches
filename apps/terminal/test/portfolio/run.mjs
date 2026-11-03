#!/usr/bin/env node
// Portfolio's and Activity's shots and checks (card app-portfolio; A3.1, app.md:1459; 09-design-brief S10 and S14): the
// fixture page (fixtures.tsx) built with vite and served on 127.0.0.1, one shot per brief state at 390 x 844 (dpr 2,
// touch) and 1440 x 900 (dpr 1). Per shot: the state id on the screen's data-states, app-shell's BAR-10 rules
// (MEASURE: no text under 11 px, no phone tap box under 44 px, no horizontal scroll, no CSP violation) and no external
// request (a tx link opens only when tapped). Then the brief's bars: desktop rows 72 layout px with at least 9 visible
// (S10) and 9 Activity rows' worth of height; phone rows 68 with at least 6 under the sticky segments; and the taps:
// Closed, search and hide small, the Activity tab, a type chip, a row opened to its receipt, the phone action sheet and
// its sell, each tx link on its explorer with target _blank.
// The pool rows (card balances-per-chain): each pool view's data-pools, Ready a dash (never $0.00) when the page sends
// no ready, and the block inside its panel with no clipped text. --scheme light|dark emulates the viewer's scheme.
//   node apps/terminal/test/portfolio/run.mjs [--shots <dir>] [--scheme light|dark]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const schemeAt = args.indexOf("--scheme");
const SCHEME = schemeAt >= 0 ? args[schemeAt + 1] : "dark";
if (SCHEME !== "light" && SCHEME !== "dark") throw new Error("--scheme light|dark");

const NOW = Date.parse("2026-11-02T03:00:00Z");
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// fixture, the brief state it must show, the widths it is drawn at (S10.10 and S10.11 are desktop's toolbar; S10.13 is
// the phone's sheet: R5 draws them only there), and whether the phone shot scrolls to the segments
const STATES = [
  ["loading", "S10.1", ["390", "1440"], false],
  ["empty", "S10.2", ["390", "1440"], false],
  ["rows", "S10.3", ["390", "1440"], false],
  ["partial", "S10.4", ["390", "1440"], true],
  ["offline", "S10.5", ["390", "1440"], false],
  ["noroute", "S10.6", ["390", "1440"], true],
  ["reverted", "S10.7", ["390", "1440"], true],
  ["held", "S10.8", ["390", "1440"], true],
  ["rows", "S10.9", ["390", "1440"], false],
  ["closed", "S10.10", ["1440"], false],
  ["search", "S10.11", ["1440"], false],
  ["selling", "S10.12", ["390", "1440"], true],
  ["sheet", "S10.13", ["390"], false],
  ["notrades", "S10.14", ["390", "1440"], false],
  ["activity-empty", "S14.1", ["390", "1440"], true],
  ["activity", "S14.2", ["390", "1440"], true],
  ["restored", "S14.3", ["390", "1440"], true],
  ["exported", "S14.4", ["390", "1440"], true],
  ["filtered", "S14.5", ["390", "1440"], true],
  ["receipt", "S14.6", ["390", "1440"], true],
  ["pools", "S10.3", ["390", "1440"], false],
  ["pools-noready", "S10.3", ["390", "1440"], false],
  ["pools-empty", "S10.3", ["390", "1440"], false],
];
// each fixture's pool view, and per row [chain, Balance, Ready, Pending] as drawn
const POOLS = {
  loading: ["loading"],
  offline: ["offline"],
  rows: ["unread"],
  pools: ["rows", [["Solana", "$1.25M", "$999,999.99", "$250,000.51"], ["Base", "$320.00", "$300.00", "$20.00"], ["Robinhood", "$0.00", "$0.00", "$0.00"]]],
  "pools-noready": ["rows", [["Solana", "$12,500.50", "—", "—"], ["Base", "$320.00", "—", "—"]]],
  "pools-empty": ["empty"],
};

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-portfolio-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const fails = [];
const drafts = new Map();
const check = (ok, what) => ok || fails.push(what);
const states = (page) => page.locator(".pf").getAttribute("data-states").then((s) => (s ?? "").split(" "));

let BASE = "";
async function open(browser, w, f) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce", timezoneId: "UTC", colorScheme: SCHEME });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW - 1000 });
  await page.clock.pauseAt(NOW);
  const external = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}`);
  await page.waitForSelector(".pf");
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external };
}
const toSegments = (page) => page.evaluate(() => { const s = document.querySelector(".pfm .sticky"); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 56); });

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import("playwright");
const browser = await chromium.launch();
let n = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.isMobile;
    for (const [f, want, at, scroll] of STATES) {
      if (!at.includes(w.name)) continue;
      const tag = `${f} ${want} @${w.name}`;
      const { ctx, page, external } = await open(browser, w, f);
      if (phone && scroll) await toSegments(page);
      const got = await states(page);
      check(got.includes(want), `${tag}: data-states ${got.join(" ")}`);
      const m = await page.evaluate(MEASURE, { phone, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      // every tx link: a known explorer, a new tab, no referrer
      for (const a of await page.$$eval(".pf a[data-tx]", (as) => as.filter((x) => x.getClientRects().length).map((x) => ({ href: x.href, target: x.target, rel: x.rel })))) check(/^https:\/\/(solscan\.io|basescan\.org|robinhoodchain\.blockscout\.com|nearblocks\.io)\//.test(a.href) && a.target === "_blank" && a.rel.includes("noreferrer"), `${tag}: tx link ${JSON.stringify(a)}`);
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(want);
      }
      if (POOLS[f] && (f !== "rows" || want === "S10.3")) {
        // the pool block of the form on screen: its view, its rows as drawn, inside its panel, no clipped text
        const r = await page.evaluate((sel) => {
          const b = document.querySelector(sel);
          if (!b) return null;
          const panel = b.closest(".panel, .mwhere").getBoundingClientRect();
          const box = b.getBoundingClientRect();
          const clipped = [...b.querySelectorAll("span")].filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).display !== "inline").map((e) => e.textContent);
          const rows = [...b.querySelectorAll("[data-pool]")].filter((x) => x.getAttribute("data-pool") !== "unread").map((x) => [...x.children].map((c) => c.textContent));
          return { view: b.getAttribute("data-pools"), rows, inside: box.bottom <= panel.bottom + 0.5 && box.right <= panel.right + 0.5, clipped };
        }, phone ? ".pfm .pools" : ".pfd .pools");
        const [view, rows] = POOLS[f];
        check(r?.view === view, `${tag}: pools view ${r?.view}, want ${view}`);
        if (rows) check(JSON.stringify(r.rows) === JSON.stringify(rows), `${tag}: pool rows ${JSON.stringify(r?.rows)}`);
        check(r?.inside && r.clipped.length === 0, `${tag}: pool block outside its panel or clipped ${JSON.stringify(r)}`);
      }
      if (want === "S10.3" && !phone) {
        // the brief's S10 bar at 1440: rows 72 layout px (54 CSS px), at least 9 visible, at least 9 fields a row
        const r = await page.evaluate(() => {
          const box = document.querySelector(".ptw").getBoundingClientRect();
          const rows = [...document.querySelectorAll(".pt tbody tr")].map((x) => x.getBoundingClientRect());
          return { h: rows[0]?.height ?? 0, visible: rows.filter((x) => x.bottom <= box.bottom + 0.5).length, fields: document.querySelectorAll(".pt thead th").length - 1 };
        });
        check(Math.abs(r.h - 54) < 1 && r.visible >= 9 && r.fields >= 9, `${tag}: S10 bar rows ${r.h}px, ${r.visible} visible, ${r.fields} fields`);
        console.log(`@1440 positions: row ${r.h.toFixed(1)} css px, ${r.visible} visible, ${r.fields} fields`);
      }
      if (want === "S10.3" && phone) {
        await toSegments(page);
        const r = await page.evaluate(() => {
          const tb = document.querySelector(".tabbar").getBoundingClientRect().top;
          const sg = document.querySelector(".pfm .sticky").getBoundingClientRect().bottom;
          const rs = [...document.querySelectorAll(".pfm .mpr")].map((x) => x.getBoundingClientRect());
          return { h: rs[0]?.height ?? 0, under: rs.filter((x) => x.top >= sg - 0.5 && x.bottom <= tb + 0.5).length };
        });
        check(Math.abs(r.h - 68) < 0.5 && r.under >= 6, `${tag}: phone rows ${r.h}px, ${r.under} under the segments`);
        console.log(`@390 positions: row ${r.h.toFixed(1)} px, ${r.under} under the sticky segments`);
      }
      if (want === "S14.2" && !phone) {
        const r = await page.evaluate(() => { const rs = [...document.querySelectorAll(".pfd .ai")].map((x) => x.getBoundingClientRect()); const box = document.querySelector(".pfd .alist").getBoundingClientRect(); return { h: rs[0]?.height ?? 0, visible: rs.filter((x) => x.bottom <= box.bottom + 0.5).length }; });
        check(Math.abs(r.h - 54) < 1, `${tag}: Activity rows ${r.h}px`);
        console.log(`@1440 activity: row ${r.h.toFixed(1)} css px, ${r.visible} visible (brief: 9)`);
      }
      // a pool fixture's phone shot shows the pool rows (the S10.3 bar above scrolled to the segments)
      if (phone && f.startsWith("pools")) await page.evaluate(() => document.querySelector(".pfm .pools").scrollIntoView({ block: "center" }));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${want}-${f}-${w.name}${SCHEME === "dark" ? "" : `-${SCHEME}`}.png`) });
      n++;
      await ctx.close();
    }

    // the taps
    if (!phone) {
      const { ctx, page } = await open(browser, w, "rows");
      await page.locator('.pfd [data-control="closed"]').click();
      check((await states(page)).includes("S10.10") && (await page.locator(".pfd tr[data-closed]").count()) === 4, `@${w.name}: Closed`);
      await page.locator('.pfd [data-control="open"]').click();
      await page.locator('.pfd [data-field="search"]').fill("hoo");
      const syms = await page.$$eval(".pfd tr[data-pos]", (rs) => rs.map((r) => r.getAttribute("data-pos")));
      check((await states(page)).includes("S10.11") && syms.join() === "near:WTH,near:HOODL,near:HOOT", `@${w.name}: search ${syms}`);
      await page.locator('.pfd [data-field="search"]').fill("");
      await page.locator('.pfd [data-control="hide-small"]').click();
      check((await page.locator(".pfd tr[data-pos]").count()) === 10, `@${w.name}: hide small hid a row worth over $1`);
      await page.locator('.pfd tr[data-pos="near:WTH"] [data-control="more"]').click();
      await page.locator('.pfd [data-control="export"]').click();
      await page.locator('.pfd tr[data-pos="near:WTH"]').hover();
      await page.locator('.pfd tr[data-pos="near:WTH"] [data-control="sell-50"]').click();
      const calls = await page.evaluate(() => window.__calls);
      check(JSON.stringify(calls) === JSON.stringify([{ kind: "export", chain: "near", token: "WTH" }, { kind: "sell", chain: "near", token: "WTH", part: "50" }]), `@${w.name}: row taps ${JSON.stringify(calls)}`);
      await page.locator('.pfd [data-control="pane-activity"]').click();
      check((await states(page)).includes("S14.2"), `@${w.name}: Activity tab`);
      await page.locator('.pfd [data-chip="sell"]').click();
      const kinds = await page.$$eval(".pfd [data-row]", (rs) => [...new Set(rs.map((r) => r.getAttribute("data-kind")))]);
      check((await states(page)).includes("S14.5") && kinds.join() === "sell", `@${w.name}: Sell chip ${kinds}`);
      await page.locator(".pfd [data-row] .ai").first().click();
      check((await states(page)).includes("S14.6") && (await page.locator(".pfd [data-receipt]").count()) === 1, `@${w.name}: receipt`);
      await ctx.close();
    } else {
      const { ctx, page } = await open(browser, w, "rows");
      await toSegments(page);
      await page.locator('.pfm .mpr[data-pos="near:WTH"]').click();
      check((await states(page)).includes("S10.13") && (await page.locator('.pfm [data-sheet="position"]').count()) === 1, `@${w.name}: row opens the sheet`);
      await page.locator('.pfm [data-control="sheet-sell-50"]').click();
      const calls = await page.evaluate(() => window.__calls);
      check(JSON.stringify(calls) === JSON.stringify([{ kind: "sell", chain: "near", token: "WTH", part: "50" }]) && (await page.locator('.pfm [data-sheet="position"]').count()) === 0, `@${w.name}: sheet 50% ${JSON.stringify(calls)}`);
      await page.locator('.pfm [data-control="seg-activity"]').click();
      check((await states(page)).includes("S14.2"), `@${w.name}: Activity segment`);
      await page.locator('.pfm [data-control="seg-stats"]').click();
      check((await page.locator('.pfm [data-pane="stats"]').count()) === 1, `@${w.name}: Stats segment`);
      await page.locator('.pfm [data-control="deposit"]').click();
      check((await page.evaluate(() => window.__calls)).at(-1)?.kind === "deposit", `@${w.name}: Deposit`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} shots, the bars and the taps`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${STATES.length} states over 390/1440), BAR-10 per shot, the S10 and S14 row bars and the taps${SHOTS ? `; shots in ${SHOTS}` : ""}`);
