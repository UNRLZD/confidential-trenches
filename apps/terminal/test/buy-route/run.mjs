#!/usr/bin/env node
// The buy route strip, its shots and checks (card app-buy-route-strip; spec docs/drafts/buy-route-strip-spec.md in the
// research repo; locked design design-lock-r5 P.pvTrade, states S8.9, S8.10, S8.12): the trade box's fixture page
// (test/trade-box/fixtures.tsx, with ?route=1 feeding the page's route data) at 1440 x 900 and 390 x 844, the page clock
// paused by Playwright and moved. Per state: each step's state and value as the events set them (never before its
// event: 1 ms before the kit's `sent` the amount is still not taken), the pool's label from the venue event, the
// button's own measured time, the toast's line, and a failed buy's error step (a refusal at the first step, a buy that
// did not land at the pool) with no check after it. Every state: the box's BAR-10 rules (no text under 11 px, no
// phone tap box under 44 px, no horizontal scroll), no external request, no dialog.
//   node apps/terminal/test/buy-route/run.mjs [--shots <dir>]
// PASS exit 0, FAIL exit 1.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "trade-box");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const NOW = Date.parse("2026-11-04T16:00:00Z");
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// [name, fixture, ms after the tap (null: before the tap), the four steps' states, the four values, the pool label,
// the button, the toast's line]. The kit stub (fixtures.tsx): wallet and venue 100 ms, signed 80, sent 150, the filled
// amount at 1,099 and `filled` at 1,100 ms, a refusal at 300, not_landed at 3,000.
const SIG = "9DJa…Zst6";
const ROWS = [
  ["idle", "ready", null, "off off off off", ["", "", "", ""], "Pool", "Buy TORCH", null],
  ["tap", "ready", 100, "active off off off", ["", "", "", ""], "pump.fun pool", "Sending", null],
  ["before-sent", "ready", 149, "active off off off", ["", "", "", ""], "pump.fun pool", "Sending", null],
  ["sent", "ready", 150, "done done active off", ["$25.00", SIG, "G19c…TQki", ""], "pump.fun pool", "Landing 0.1s", null],
  ["landing", "ready", 400, "done done active off", ["$25.00", SIG, "G19c…TQki", ""], "pump.fun pool", "Landing 0.4s", null],
  ["before-filled", "ready", 1_099, "done done active off", ["$25.00", SIG, "G19c…TQki", ""], "pump.fun pool", "Landing 1.0s", null],
  ["filled", "ready", 1_100, "done done done done", ["$25.00", SIG, "G19c…TQki", "10.6K"], "pump.fun pool", "Filled 1.1s Final", "Filled 1.1s · 10.6K TORCH · $25.00"],
  ["refused", "refuse", 400, "error off off off", ["", "", "", ""], "Pool", "Retry", null],
  ["notlanded", "notlanded", 3_100, "done done error off", ["$25.00", SIG, "G19c…TQki", ""], "pump.fun pool", "Retry", null],
];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-buy-route-"));
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

const fails = [];
const check = (ok, what) => ok || fails.push(what);
const norm = (s) => s.replace(/\s+/g, " ").trim();
async function settle(read, want) {
  const end = Date.now() + 3_000;
  let got = await read();
  while (got !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    got = await read();
  }
  return got;
}

const dir = await build();
const server = await serve(dir);
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser("chromium");
try {
  for (const w of WIDTHS) {
    for (const [name, f, ms, steps, values, pool, button, toast] of ROWS) {
      const tag = `${name} @${w.name}`;
      // reduced motion: every transition lands at once, so a shot shows the state the events set, not a frame of its animation
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
      await ctx.addInitScript(INIT);
      const page = await ctx.newPage();
      await page.clock.install({ time: NOW - 1000 });
      await page.clock.pauseAt(NOW);
      const external = [];
      const dialogs = [];
      page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
      page.on("dialog", (d) => {
        dialogs.push(d.type());
        void d.dismiss();
      });
      await page.goto(`${BASE}/?f=${f}&route=1`);
      await page.waitForSelector('[data-testid="trade-box"]');
      await page.evaluate(() => document.fonts.ready);
      if (ms !== null) {
        await page.locator('[data-testid="trade-cta"]').click();
        await page.clock.runFor(ms);
      }
      const strip = page.locator('[data-testid="route-strip"]');
      const got = await settle(async () => (await strip.getAttribute("data-steps")) + "|" + norm(await page.locator('[data-testid="trade-cta"]').innerText()), `${steps}|${button}`);
      check(got === `${steps}|${button}`, `${tag}: steps and button "${got}", want "${steps}|${button}"`);
      const vals = await page.$$eval('[data-testid$="-value"]', (els) => els.map((e) => (e.textContent ?? "").replace(/ /g, "").trim()));
      check(JSON.stringify(vals) === JSON.stringify(values), `${tag}: values ${JSON.stringify(vals)}, want ${JSON.stringify(values)}`);
      // a value whose step has not happened is not shown: its opacity is 0 and reads empty
      const hidden = await page.$$eval('[data-testid$="-value"]', (els) => els.map((e) => (e.hasAttribute("data-on") ? 1 : 0)));
      check(JSON.stringify(hidden) === JSON.stringify(values.map((v) => (v ? 1 : 0))), `${tag}: value visibility ${JSON.stringify(hidden)}`);
      const label = norm(await page.locator('[data-testid="route-pool"] .rs-k').innerText());
      check(label === pool, `${tag}: pool label "${label}", want "${pool}"`);
      check((await page.locator(".rs-grp").getAttribute("data-in")) === (ms === null ? null : "true"), `${tag}: the wallet step ${ms === null ? "grew in before the tap" : "did not grow in at the tap"}`);
      const links = await page.$$eval(".rs-l", (els) => els.map((e) => (e.hasAttribute("data-full") ? 1 : 0)).join(""));
      const wantLinks = steps.split(" ").slice(0, 3).map((s, i, a) => (s === "done" ? 1 : 0)).join("");
      check(links === wantLinks, `${tag}: links ${links}, want ${wantLinks}`);
      // the button's time is this buy's own measured one
      if (toast) {
        const line = norm(await page.locator('[data-testid="fill-toast-line"]').innerText());
        check(line === toast, `${tag}: toast "${line}", want "${toast}"`);
        check((await page.locator('[data-testid="fill-toast"] a').getAttribute("href")) === `https://solscan.io/tx/${"5".repeat(88)}`, `${tag}: toast link`);
      } else check((await page.locator('[data-testid="fill-toast"]').count()) === 0, `${tag}: a toast before the fill`);
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      check(dialogs.length === 0 && (await page.locator('[role="dialog"], dialog').count()) === 0, `${tag}: a dialog`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(ROWS.findIndex((r) => r[0] === name)).padStart(2, "0")}-${name}-${w.name}.png`) });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (fails.length) {
  console.error(`FAIL: ${fails.length}\n${fails.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`PASS: ${ROWS.length} states x ${WIDTHS.length} widths: each step checks on its own event, values after their step, the failed step is the error, no step after it checks`);
