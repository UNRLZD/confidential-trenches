#!/usr/bin/env node
// The phone trade sheet, every state (card app-phone-trade-sheet; A2.5, app.md:1450; 09-design-brief §6.5 and F14): the
// trade box's fixture page (test/trade-box/fixtures.tsx ?sheet=1, the kit stub) built with vite and served on 127.0.0.1,
// the box in the app's own TradeSheet with the safety grid under it, at 360 x 740, 390 x 844 and 430 x 932 (dpr 2,
// touch), the page clock paused by Playwright. Per state (the trade box run's own table, plus the pool's two proof
// lines): the open button opens the sheet, the main button in the sheet taps, and the box reads its state id, label,
// time and the line above the button; the sheet is inside the window, holds the box, the route strip and the safety
// grid; app-shell's BAR-10 rules (no text under 11 px, no tap box under 44 px, no horizontal scroll, no CSP violation);
// no browser dialog, no dialog but the sheet itself, no external request. Then the close: a buy still Landing when the
// grab handle closes the sheet keeps running in the hidden box, its fill toast shows over the page, and the reopened
// sheet draws it Filled, one buy sent; the scrim and Escape close it too, the page scrolls again once it is closed, and a
// window grown past the phone width closes it.
//   node apps/terminal/test/trade-sheet/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../trade-box");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = Date.parse("2026-11-02T06:00:00Z");
const WIDTHS = [
  { name: "360", viewport: { width: 360, height: 740 } },
  { name: "390", viewport: { width: 390, height: 844 } },
  { name: "430", viewport: { width: 430, height: 932 } },
].map((w) => ({ ...w, deviceScaleFactor: 2, isMobile: true, hasTouch: true }));
// the state, the fixture query, whether the main button is tapped, the page clock's ms after the tap, the button's time,
// its label, and the line above the button (the trade box run's table; the pool rows are card trade-box-pool's lines)
const STATES = [
  ["S8.3", "f=ready", false, 0, null, "Buy TORCH", "Max $100"],
  ["S8.3", "f=ready&pool=sol-ready", false, 0, null, "Buy TORCH", /^Proof ready Max \$\d/],
  ["S8.3", "f=ready&pool=sol-making", false, 0, null, "Buy TORCH", /^Making proof Max \$\d/],
  ["S8.9", "f=ready&route=1", true, 100, null, "Sending", "Max $100"],
  ["S8.10", "f=ready&route=1", true, 400, "0.4s", "Landing 0.4s", "Max $100"],
  ["S8.11", "f=slow&route=1", true, 6_200, "6.2s", "Slow 6.2s", "Max $100"],
  ["S8.12", "f=ready&route=1", true, 1_200, "1.1s", "Filled 1.1s Final", "Max $100"],
  ["S8.23", "f=refuse", true, 400, null, "Retry", "Price check failed"],
  ["S8.23", "f=notsent", true, 400, null, "Retry", "Not sent"],
  ["S8.23", "f=other", true, 400, null, "Retry", "Failed"],
  ["S8.24", "f=notlanded&route=1", true, 3_100, null, "Retry", "Not landed"],
  ["partial", "f=partial&route=1", true, 1_200, null, "Buy TORCH", "1/2 filled"],
  ["partial", "f=partial-nocount", true, 1_200, null, "Buy TORCH", "Part filled"],
];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-trade-sheet-"));
  await build({ root: FIXTURE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
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
const drafts = new Map();
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
};
const norm = (s) => s.replace(/\s+/g, " ").trim();
const like = (got, want) => (want instanceof RegExp ? want.test(got) : got === want);

/** Polls (real time, up to 3 s) until the read equals what the row wants, as test/trade-box/run.mjs settle. */
async function settle(read, want) {
  const end = Date.now() + 3_000;
  let got = await read();
  while (!like(got ?? "", want) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    got = await read();
  }
  return got;
}

let BASE = "";
async function open(browser, w, query) {
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
  await page.goto(`${BASE}/?sheet=1&${query}`);
  await page.waitForSelector('[data-testid="open-sheet"]');
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external, dialogs };
}

const sheet = (page) => page.locator('[data-sheet="trade"]');
const box = (page) => page.locator('[data-sheet="trade"] [data-testid="trade-box"]');
const cta = (page) => page.locator('[data-sheet="trade"] [data-testid="trade-cta"]');

async function openSheet(tag, page) {
  await page.locator('[data-testid="open-sheet"]').click();
  const up = await sheet(page).waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
  check(up, `${tag}: the sheet did not open`);
  return up;
}

/** The rules every drawn state holds in the sheet. */
async function rules(tag, page, w, external, dialogs) {
  const sb = await page.locator(".tsh-box").boundingBox();
  check(!!sb && sb.x >= -0.5 && sb.x + sb.width <= w.viewport.width + 0.5 && sb.y >= 0 && sb.y + sb.height <= w.viewport.height + 0.5, `${tag}: the sheet is outside the window (${JSON.stringify(sb)})`);
  check((await page.locator('[data-sheet="trade"] [data-testid="route-strip"]').count()) === 1, `${tag}: no route strip in the sheet`);
  check((await page.locator('[data-sheet="trade"] [data-testid="safety-grid"] .rg-cell').count()) === 12, `${tag}: the safety grid in the sheet is not 12 cells`);
  const m = await page.evaluate(MEASURE, { phone: true, vw: w.viewport.width });
  check(!m.hscroll, `${tag}: horizontal scroll`);
  check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
  check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
  check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
  // the box's own sideways overflow inside the sheet (the window's is above)
  const over = await page.evaluate(() => {
    const b = document.querySelector(".tsh-box");
    return b ? b.scrollWidth - b.clientWidth : -1;
  });
  check(over === 0, `${tag}: the sheet scrolls sideways by ${over} px`);
  check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
  check(dialogs.length === 0 && (await page.locator("dialog").count()) === 0, `${tag}: a browser dialog ${dialogs.join(" ")}`);
  const roles = await page.$$eval('[role="dialog"], [role="alertdialog"]', (els) => els.map((e) => e.closest("[data-sheet]")?.getAttribute("data-sheet") ?? e.tagName));
  check(roles.length === 1 && roles[0] === "trade", `${tag}: dialogs other than the sheet: ${JSON.stringify(roles)}`);
  for (const d of await page.$$eval('[data-sheet="trade"] [data-draft-copy]', (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
    if (!drafts.has(d)) drafts.set(d, new Set());
    drafts.get(d).add(tag);
  }
}

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser("chromium");
const label = browserLabel(browser);
try {
  for (const w of WIDTHS) {
    for (const [want, query, tapIt, ms, time, LABEL, LINE] of STATES) {
      const tag = `${want} ${query} @${w.name}`;
      const { ctx, page, external, dialogs } = await open(browser, w, query);
      if (await openSheet(tag, page)) {
        if (tapIt) {
          await cta(page).click();
          await page.clock.runFor(ms);
        }
        const label = await settle(async () => norm(await cta(page).innerText()), LABEL);
        check(label === LABEL, `${tag}: button "${label}", want "${LABEL}"`);
        const got = await settle(() => box(page).getAttribute("data-state"), want);
        check(got === want, `${tag}: state ${got}, want ${want}`);
        if (time) check((await cta(page).locator("[data-time]").getAttribute("data-time")) === time, `${tag}: time, want ${time}`);
        const line = await settle(async () => norm(await box(page).locator('[data-testid="trade-max"]').innerText()), LINE);
        check(like(line, LINE), `${tag}: the line above the button "${line}", want ${LINE}`);
        const calls = await page.evaluate(() => window.__calls);
        check(calls.length === (tapIt ? 1 : 0), `${tag}: ${calls.length} buy requests`);
        // the main button is in the window without a scroll (the thumb's reach)
        const cb = await cta(page).boundingBox();
        check(!!cb && cb.y + cb.height <= w.viewport.height, `${tag}: the main button is below the window (${JSON.stringify(cb)})`);
        await rules(tag, page, w, external, dialogs);
        const name = `${want}-${query.replace(/[&=]/g, "_")}-${w.name}`;
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
        if (SHOTS && w.name === "390" && (want === "S8.12" || want === "S8.3") && query.startsWith("f=ready")) {
          await page.locator('[data-sheet="trade"] [data-testid="safety-grid"]').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(SHOTS, `${name}-scrolled.png`) });
        }
      }
      await ctx.close();
    }

    // a buy still Landing when the sheet closes keeps running in the hidden box; its toast shows; the reopen draws it Filled
    {
      const tag = `close while Landing @${w.name}`;
      const { ctx, page, external, dialogs } = await open(browser, w, "f=ready&route=1");
      if (await openSheet(tag, page)) {
        await cta(page).click();
        await page.clock.runFor(400);
        check((await settle(() => box(page).getAttribute("data-state"), "S8.10")) === "S8.10", `${tag}: not Landing before the close`);
        await page.locator(".tsh-grab").click();
        const hidden = await sheet(page).waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false);
        check(hidden, `${tag}: the grab handle did not close the sheet`);
        check((await sheet(page).getAttribute("data-open")) === "false", `${tag}: data-open is not false`);
        check((await box(page).count()) === 1, `${tag}: the box was removed on the close`);
        check((await page.evaluate(() => document.body.style.overflow)) === "", `${tag}: the page stays locked after the close`);
        check(!(await cta(page).isVisible()), `${tag}: the closed sheet's button is visible`);
        await page.clock.runFor(800);
        const toast = page.locator('[data-testid="fill-toast"]');
        check(await toast.isVisible(), `${tag}: no fill toast over the page with the sheet closed`);
        const tl = norm((await toast.locator('[data-testid="fill-toast-line"]').innerText().catch(() => "")) ?? "");
        check(/1\.1s/.test(tl), `${tag}: the toast's line "${tl}"`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `closed-filled-toast-${w.name}.png`) });
        await openSheet(`${tag} reopen`, page);
        check((await settle(() => box(page).getAttribute("data-state"), "S8.12")) === "S8.12", `${tag}: the reopened sheet is not Filled`);
        const label = await settle(async () => norm(await cta(page).innerText()), "Filled 1.1s Final");
        check(label === "Filled 1.1s Final", `${tag}: the reopened button "${label}"`);
        check((await page.evaluate(() => window.__calls)).length === 1, `${tag}: more than one buy`);
        check((await page.evaluate(() => document.body.style.overflow)) === "hidden", `${tag}: the page behind scrolls while the sheet is open`);
        await rules(`${tag} reopen`, page, w, external, dialogs);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `reopened-filled-${w.name}.png`) });
        // the scrim closes it too
        await page.locator(".tsh-scrim").click({ position: { x: 20, y: 20 } });
        check(await sheet(page).waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false), `${tag}: the scrim did not close the sheet`);
        // Escape closes an open sheet
        await openSheet(`${tag} Escape`, page);
        await page.keyboard.press("Escape");
        check(await sheet(page).waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false), `${tag}: Escape did not close the sheet`);
        // a window that grows past the phone (a tablet turned sideways) closes the sheet: the page is never left locked
        await openSheet(`${tag} widen`, page);
        await page.setViewportSize({ width: 1024, height: 768 });
        check(await sheet(page).waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false), `${tag}: the sheet stays open past the phone width`);
        check((await page.evaluate(() => document.body.style.overflow)) === "", `${tag}: the page stays locked past the phone width`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`trade-sheet: ${checks} checks on ${label}`);
if (drafts.size) console.log(`draft words drawn: ${[...drafts.keys()].map((d) => JSON.stringify(d)).join(", ")}`);
if (fails.length) {
  console.log(`FAIL (${fails.length})\n${fails.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("PASS");
