#!/usr/bin/env node
// The live numbers hold still (card app-legend-holds-still): the chart's legend and the desktop footer, on fixtures
// (fixtures.tsx) built with vite and served on 127.0.0.1, at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1). Every
// layout shift is read from the page's first paint (app-shell.mjs INIT, hadRecentInput not excluded) while:
//   - in each unit (Price and MCap in USD), the newest bar ticks through prices of every length the chart draws
//     ($0.0₃12 to $1,234.50, $12.30K to $1.23T), then the crosshair crosses every bar and leaves;
//   - a resync replaces the bars with fewer, shorter ones (the slot keeps its width);
//   - on the desktop, the footer's SOL and ETH prices tick through every length under $100,000.
// A run passes with zero shifts after the legend's first paint, and only if the values it fed did change length (the
// close took at least four lengths, SOL at least three), so it cannot pass on values that never moved. A FAIL names
// each shift's element and its rects before and after.
//   node apps/terminal/test/holds-still/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// USD prices of every length `price` draws: $0.0₃123, $0.0₃12, $0.0012, $0.00123, $0.0123, $0.01, $0.1, $1.50, $12.34,
// $1,234.50; times SUPPLY in MCap they run $120.00K to $1.23T
const PRICES = [0.000123, 0.00012, 0.0012, 0.00123, 0.0123, 0.01, 0.1, 1.5, 12.34, 1234.5];
const SUPPLY = 1e9;
const T0 = Date.parse("2026-11-08T00:00:00Z") / 1000;
const bar = (i, p, f = 1) => ({ timestamp: (T0 + i * 900) * 1000, open: p * 1.01 * f, high: p * 1.07 * f, low: p * 0.97 * f, close: p * f, volume: (i % 7) * 1234.5 + 0.5 });
const history = (f) => Array.from({ length: 40 }, (_, i) => bar(i, PRICES[i % PRICES.length], f));
// the newest bar's ticks: every length, up and down, out of order
const TICKS = [3, 9, 0, 6, 1, 8, 2, 7, 4, 5, 9, 1, 0, 6];
const SOL = [151.23, 9.87, 99.87, 1234.5, 23456.78, 0.5, 151.2];
const ETH = [3456.1, 98.76, 0.99, 34567.8, 3456.1];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-holds-still-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/** Two frames: the change is laid out and its shift, if any, reported. */
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 20)))));
const shiftsOf = (log) => log.map((e) => `+${e.at}ms ${e.value.toFixed(5)}: ${e.sources.join(" | ") || "no source"}`).join("; ");

const fails = [];
const dir = await build();
const server = await serve(dir);
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser("chromium");
try {
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(BASE);
    await page.waitForSelector(".ft", { state: "attached" });
    await page.evaluate(() => document.fonts.ready);
    const fx = (p) => page.evaluate((x) => window.__fx(x), p);
    const close = () => page.locator('[data-testid="chart-legend"] [data-k="lgC"] [data-dir]').first().textContent();
    const lengths = new Set();
    const solLengths = new Set();
    for (const unit of [{ mc: false, quote: false }, { mc: true, quote: false }]) {
      const f = unit.mc ? SUPPLY : 1;
      const bars = history(f);
      await fx({ unit, bars, at: null });
      await settle(page);
      // the legend's first paint in this unit is where the count starts: a value of every length follows
      const before = await page.evaluate(() => window.__ct.shiftLog.length);
      for (const t of TICKS) {
        const last = bars.length - 1;
        bars[last] = bar(last, PRICES[t], f);
        await fx({ bars: [...bars] });
        await settle(page);
        lengths.add([...(await close())].length);
      }
      for (let i = 0; i < bars.length; i++) {
        await fx({ at: i });
        await settle(page);
      }
      await fx({ at: null });
      await settle(page);
      // a resync: fewer bars, none of the longest values (the slots hold their width)
      await fx({ bars: bars.slice(-4).map((b, i) => bar(100 + i, PRICES[i + 5], f)) });
      await settle(page);
      await fx({ bars: [...bars] });
      await settle(page);
      const log = await page.evaluate((n) => window.__ct.shiftLog.slice(n), before);
      if (log.length) fails.push(`@${w.name} ${unit.mc ? "MCap" : "Price"}: ${log.length} layout shift(s) while the legend ticked and the crosshair moved [${shiftsOf(log)}]`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${w.name}-legend-${unit.mc ? "mc" : "price"}.png`) });
    }
    if (!w.isMobile) {
      const before = await page.evaluate(() => window.__ct.shiftLog.length);
      for (let i = 0; i < Math.max(SOL.length, ETH.length); i++) {
        await fx({ sol: SOL[i % SOL.length], eth: ETH[i % ETH.length] });
        await settle(page);
        solLengths.add([...((await page.locator('.ft [data-tick="SOL"]').textContent()) ?? "")].length);
      }
      const log = await page.evaluate((n) => window.__ct.shiftLog.slice(n), before);
      if (log.length) fails.push(`@${w.name} footer: ${log.length} layout shift(s) while SOL and ETH ticked [${shiftsOf(log)}]`);
      if (solLengths.size < 3) fails.push(`@${w.name} footer: SOL took ${solLengths.size} length(s), not every length fed`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${w.name}-footer.png`) });
    }
    if (lengths.size < 4) fails.push(`@${w.name} legend: the close took ${lengths.size} length(s), not every length fed`);
    if (errors.length) fails.push(`@${w.name}: ${errors.length} page error(s): ${errors.join("; ")}`);
    console.log(`@${w.name} the close took ${lengths.size} lengths${w.isMobile ? "" : `, SOL ${solLengths.size}`}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} check(s): the legend and the footer did not hold still`);
  process.exit(1);
}
console.log(`PASS the legend (Price and MCap, ticks, crosshair, resync) and the footer held still at 390 and 1440, zero layout shifts${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
