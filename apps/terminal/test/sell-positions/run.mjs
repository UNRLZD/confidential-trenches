#!/usr/bin/env node
// The sell side and Your position, their shots and checks (card app-sell-positions; A2.4, app.md:1449; AE-11's sell
// rows, app.md:1352: a sell (S8.29, S8.30) and a double tap; the trade states of card app-trade-box-states: S8.11
// Slow, S8.32 Failed with its reason and S8.36 Not landed, each with Retry, S8.35 part sold with no Retry; 09-design-brief S8 Sell tab, Sell presets, Your position):
// the fixture page (fixtures.tsx, the trade box's kit stub) built with vite and served on 127.0.0.1, every state at
// 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), the page clock paused by Playwright. Per state: its own state id and
// button, the presets and quick sells on or off as the position allows (dust, no route, Initials when not up), app-shell's
// BAR-10 rules (MEASURE: no text under 11 px, no phone tap box under 44 px, no horizontal scroll), no external request,
// no dialog and no navigation, and the kit requests sent. Then: a double tap is one sell, 100% sends the kit's amount
// string unchanged, Initials sends the share that returns the cost, a typed percent sells its share, Share goes to the
// mount.
//   node apps/terminal/test/sell-positions/run.mjs [--shots <dir>] [--plant tap|clock] [--slow-cpu <rate>] [--slow-commit]
// PASS exit 0, FAIL exit 1. --plant runs the same checks on a planted fault (tap: the quick sells 36 px tall on the
// phone, R5's desktop height; clock: the screen's clock 25% fast) and must FAIL. --slow-cpu slows the page's CPU by the
// rate (Chrome's throttling), --slow-commit lands each React commit 50 ms late (a slow runner); both must still PASS with
// the same labels.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const plantAt = args.indexOf("--plant");
const PLANT = plantAt >= 0 ? args[plantAt + 1] : null;
if (PLANT && !["tap", "clock"].includes(PLANT)) throw new Error(`--plant tap|clock, not ${PLANT}`);
const cpuAt = args.indexOf("--slow-cpu");
const SLOW_CPU = cpuAt >= 0 ? Number(args[cpuAt + 1]) : 0;
const SLOW_COMMIT = args.includes("--slow-commit");
/** --slow-commit: a slow runner, planted. Every MessageChannel message (React's scheduler task, which commits a render)
 * lands 50 ms of real time late, on the real setTimeout saved before the page clock is installed. */
const LATE = () => {
  const later = window.setTimeout.bind(window);
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...a) {
    later(() => post.apply(this, a), 50);
  };
};

const NOW = Date.parse("2026-11-02T06:00:00Z");
// the fixture's mint (fixtures.tsx), kept apart from a `token:` key (gitleaks reads a long id beside that word as a secret)
const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const WHOLE = "1234567.891234";
const sellOf = (amount) => JSON.stringify({ chain: "solana", token: MINT, side: "sell", amount, slippage_bps: 1000 });
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// Exact amounts for the fixture's 1234567.891234 units at $0.00017739 (value 21899 cents, cost $100): 50% is
// 617283.945617 (617283945617 base units, rounded down from .5); 25% is 308641.972808; Initials is ceil(1e8 / 21899)
// = 4567 bps, 563827.155926.
const HALF = "617283.945617";
const QUARTER = "308641.972808";
const INITIALS = "563827.155926";

// name, fixture, what is tapped (cta, a quick sell, or none), ms after it, the box's state, its button, the sent amount,
// the presets on (25 50 75 100), the quick sells on (25 50 All Initials)
const STATES = [
  ["S8.29", "up", null, 0, "S8.29", "Sell 50%", null, "1111", "1111"],
  ["S8.30-sending", "up", "cta", 100, "S8.30", "Sending", HALF, "0000", "0000"],
  ["S8.30-landing", "up", "cta", 400, "S8.30", "Landing 0.4s", HALF, "0000", "0000"],
  ["filled", "up", "cta", 1_200, "filled", "Filled 1.1s", HALF, "1111", "1111"],
  ["S8.11", "slow", "cta", 6_200, "S8.11", "Slow 6.2s", HALF, "0000", "0000"],
  ["S8.32", "refuse", "cta", 400, "S8.32", "Retry", HALF, "1111", "1111"],
  ["S8.32-notsent", "notsent", "cta", 400, "S8.32", "Retry", HALF, "1111", "1111"],
  ["S8.32-other", "other", "cta", 400, "S8.32", "Retry", HALF, "1111", "1111"],
  ["S8.36", "notlanded", "cta", 3_100, "S8.36", "Retry", HALF, "1111", "1111"],
  ["S8.35", "partial", "cta", 1_200, "S8.35", "Sell 50%", HALF, "1111", "1111"],
  ["S8.35-nocount", "partial-nocount", "cta", 1_200, "S8.35", "Sell 50%", HALF, "1111", "1111"],
  ["quick-25", "up", '[data-quick="2500"]', 400, "S8.30", "Landing 0.4s", QUARTER, "0000", "0000"],
  ["S8.33", "noroute", null, 0, "S8.33", "No route", null, "0000", "0000"],
  ["down", "down", null, 0, "S8.29", "Sell 50%", null, "1111", "1110"],
  ["dust", "dust", null, 0, "S8.29", "Sell 50%", null, "0111", "0110"],
];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-sell-positions-"));
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
const norm = (s) => s.replace(/\s+/g, " ").trim();

let BASE = "";
async function open(browser, w, f) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  if (SLOW_COMMIT) await ctx.addInitScript(LATE);
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW - 1000 });
  await page.clock.pauseAt(NOW);
  const external = [];
  const dialogs = [];
  const navs = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  if (SLOW_CPU) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: SLOW_CPU });
  await page.goto(`${BASE}/?f=${f}${PLANT === "clock" ? "&plant=clock" : ""}`);
  page.on("framenavigated", (fr) => fr === page.mainFrame() && navs.push(fr.url()));
  await page.waitForSelector('[data-testid="sell-box"]');
  if (PLANT === "tap") await page.addStyleTag({ content: ".tk-position .tk-quick > button { height: 36px !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(10);
  return { ctx, page, external, dialogs, navs };
}

/**
 * A read that waits for the screen's last render, as Playwright's own web-first assertions do. The page clock is paused,
 * so after runFor the screen ends on one render for that clock, but React commits it in its own task after the timers
 * ran: a read straight after runFor can catch an earlier render ("Landing 0.1s" at 0.4 s on a slow runner). This polls
 * (real time, up to 3 s) until the read equals what the row wants, then returns what it saw; a wrong label never comes.
 */
async function settle(read, want) {
  const end = Date.now() + 3_000;
  let got = await read();
  while (got !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    got = await read();
  }
  return got;
}

const onMap = (page, sel, attr) => page.$$eval(sel, (bs, a) => bs.map((b) => (b.disabled ? "0" : "1")).join(""), attr);
const calls = (page) => page.evaluate(() => window.__calls);

/** MEASURE reads only what is on screen, so it runs at the top and again scrolled to the bottom: a tap or a line below
 * the fold at 390 is held to the same rules. */
async function measure(page, w) {
  const at = { phone: w.isMobile, vw: w.viewport.width };
  const top = await page.evaluate(MEASURE, at);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const end = await page.evaluate(MEASURE, at);
  await page.evaluate(() => window.scrollTo(0, 0));
  return {
    hscroll: top.hscroll || end.hscroll,
    smallText: [...new Set([...top.smallText, ...end.smallText])],
    smallTaps: [...new Set([...top.smallTaps, ...end.smallTaps])],
    violations: end.violations,
  };
}

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser("chromium");
try {
  for (const w of WIDTHS) {
    for (const [name, f, tapIt, ms, want, label, amount, presets, quick] of STATES) {
      const tag = `${name} @${w.name}`;
      const { ctx, page, external, dialogs, navs } = await open(browser, w, f);
      if (tapIt) {
        await page.locator(tapIt === "cta" ? '[data-testid="sell-cta"]' : tapIt).click();
        await page.clock.runFor(ms);
      }
      const box = page.locator('[data-testid="sell-box"]');
      const lab = await settle(async () => norm(await page.locator('[data-testid="sell-cta"]').innerText()), label);
      check(lab === label, `${tag}: button "${lab}", want "${label}"`);
      const got = await settle(() => box.getAttribute("data-state"), want);
      check(got === want, `${tag}: state ${got}, want ${want}`);
      // an ended sell's one line above the button (app-trade-box-states), empty otherwise
      const END = { refuse: "Price check failed", notsent: "Not sent", other: "Failed", notlanded: "Not landed", partial: "1/2 sold", "partial-nocount": "Part sold" };
      const STAGE = { refuse: "refused", notsent: "refused", other: "refused", notlanded: "not_landed", partial: "part_filled", "partial-nocount": "part_filled" };
      const line = await settle(async () => norm(await page.locator('[data-testid="sell-line"]').innerText()), END[f] ?? "");
      check(line === (END[f] ?? ""), `${tag}: the line above the button "${line}", want "${END[f] ?? ""}"`);
      if (STAGE[f]) check((await box.getAttribute("data-stage")) === STAGE[f], `${tag}: the end's stage`);
      const p = await onMap(page, "[data-pct]");
      check(p === presets, `${tag}: presets on ${p}, want ${presets}`);
      const qk = await onMap(page, "[data-quick]");
      check(qk === quick, `${tag}: quick sells on ${qk}, want ${quick}`);
      if (name === "quick-25") {
        check((await page.locator('[data-quick="2500"]').getAttribute("data-live")) === "true", `${tag}: the 25% quick sell not lit`);
        check((await page.locator('[data-testid="sell-box"] .trb-input').inputValue()) === "25", `${tag}: the box does not show the running 25%`);
        check((await page.$$eval("[data-pct][data-on]", (bs) => bs.map((b) => b.getAttribute("data-pct")).join(" "))) === "2500", `${tag}: the box's lit preset is not 25%`);
      }
      if (f === "up" && !tapIt) {
        check(norm(await page.locator('[data-testid="sell-held"]').innerText()) === "1.23M TORCH held", `${tag}: held line`);
        const share = await settle(async () => norm(await page.locator('[data-testid="sell-share"]').innerText()), "≈ $109.49");
        check(share === "≈ $109.49", `${tag}: the share's value "${share}"`);
        const receive = await settle(async () => norm(await page.locator('[data-testid="sell-receive"]').innerText()), "≈ $108.40");
        check(receive === "≈ $108.40", `${tag}: You receive "${receive}"`);
        check(norm(await page.locator('[data-testid="position-pnl"]').innerText()) === "+$118.99", `${tag}: the PnL hero`);
        check(norm(await page.locator('[data-testid="pos-holding"]').innerText()) === "Holding $218.99 1.23M TORCH", `${tag}: the Holding row`);
        check(norm(await page.locator('[data-testid="pos-bought"]').innerText()) === "Bought $100.00", `${tag}: the Bought row`);
        check(norm(await page.locator('[data-testid="pos-total"]').innerText()) === "Total PnL +$118.99 +118.9%", `${tag}: the Total PnL row`);
        check(norm(await page.locator('[data-testid="pos-held"]').innerText()) === "Held for 6d 6h", `${tag}: Held for`);
      }
      const m = await measure(page, w);
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      check(dialogs.length === 0 && (await page.locator('[role="dialog"], dialog').count()) === 0, `${tag}: a dialog ${dialogs.join(" ")}`);
      check(navs.length === 0, `${tag}: navigated ${navs.join(" ")}`);
      const c = await calls(page);
      check(c.length === (tapIt ? 1 : 0), `${tag}: ${c.length} sell requests`);
      if (tapIt) check(c[0]?.kind === "buy" && JSON.stringify(c[0]?.params) === sellOf(amount), `${tag}: the sell ${JSON.stringify(c[0])}`);
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(name);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${w.name}.png`), fullPage: true });
      await ctx.close();
    }

    // Retry is one new sell of the same share, at once, with no dialog
    {
      const { ctx, page, dialogs } = await open(browser, w, "notlanded");
      const cta = page.locator('[data-testid="sell-cta"]');
      await cta.click();
      await page.clock.runFor(3_100);
      await cta.click();
      await page.clock.runFor(100);
      const c = await calls(page);
      check(c.length === 2 && JSON.stringify(c[1].params) === sellOf(HALF), `@${w.name}: Retry sent ${JSON.stringify(c)}`);
      check((await settle(() => page.locator('[data-testid="sell-box"]').getAttribute("data-state"), "S8.30")) === "S8.30", `@${w.name}: Retry not Sending`);
      check(dialogs.length === 0, `@${w.name}: a dialog on Retry`);
      await ctx.close();
    }

    // after a part fill there is no Retry: one tap is one new sell of the share the box shows, never the rest re-sent
    {
      const { ctx, page, dialogs } = await open(browser, w, "partial");
      const cta = page.locator('[data-testid="sell-cta"]');
      await cta.click();
      await page.clock.runFor(1_200);
      const shown = await settle(async () => norm(await cta.innerText()), "Sell 50%");
      await cta.click();
      await page.clock.runFor(100);
      const c = await calls(page);
      check(shown === "Sell 50%" && c.length === 2 && JSON.stringify(c[1].params) === sellOf(HALF), `@${w.name}: after a part fill, shown "${shown}", sent ${JSON.stringify(c)}`);
      check((await settle(() => page.locator('[data-testid="sell-box"]').getAttribute("data-state"), "S8.30")) === "S8.30", `@${w.name}: the tap after a part fill is not Sending`);
      check(dialogs.length === 0, `@${w.name}: a dialog after a part fill`);
      await ctx.close();
    }

    // a double tap is one sell: on the main button and on a quick sell
    for (const sel of ['[data-testid="sell-cta"]', '[data-quick="5000"]']) {
      const { ctx, page } = await open(browser, w, "up");
      await page.locator(sel).click();
      await page.locator(sel).click({ force: true });
      await page.clock.runFor(30);
      await page.locator(sel).click({ force: true });
      await page.clock.runFor(1_200);
      const c = await calls(page);
      check(c.length === 1, `@${w.name}: a double tap on ${sel} sent ${c.length} sells`);
      check((await settle(() => page.locator('[data-testid="sell-box"]').getAttribute("data-state"), "filled")) === "filled", `@${w.name}: the double tap's sell did not fill`);
      await ctx.close();
    }
    // 100% sends the kit's amount string unchanged; All too; Initials sends the share that returns the cost
    for (const [sel, want] of [['[data-pct="10000"]', WHOLE], ['[data-quick="10000"]', WHOLE], ['[data-quick="initials"]', INITIALS]]) {
      const { ctx, page } = await open(browser, w, "up");
      await page.locator(sel).click();
      await page.clock.runFor(100);
      const c = await calls(page);
      check(c.length === 1 && JSON.stringify(c[0].params) === sellOf(want), `@${w.name}: ${sel} sent ${JSON.stringify(c)}, want ${want}`);
      await ctx.close();
    }
    // a typed percent sells its share; a percent over 100 is not taken
    {
      const { ctx, page } = await open(browser, w, "up");
      const input = page.locator('[data-testid="sell-box"] .trb-input');
      await input.fill("25");
      check(norm(await page.locator('[data-testid="sell-cta"]').innerText()) === "Sell 25%", `@${w.name}: typed 25 button`);
      await input.fill("1001");
      check((await input.inputValue()) === "25", `@${w.name}: a fourth digit taken`);
      await input.fill("101");
      check(await page.locator('[data-testid="sell-cta"]').isDisabled(), `@${w.name}: 101% not refused`);
      await input.fill("25");
      await page.locator('[data-testid="sell-cta"]').click();
      await page.clock.runFor(100);
      const c = await calls(page);
      check(c.length === 1 && JSON.stringify(c[0].params) === sellOf(QUARTER), `@${w.name}: typed 25% sent ${JSON.stringify(c)}`);
      await ctx.close();
    }
    // Share goes to the mount
    {
      const { ctx, page } = await open(browser, w, "up");
      await page.locator('[data-testid="position-share"]').click();
      check((await page.evaluate(() => window.__shares)) === 1, `@${w.name}: Share not handed to the mount`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
const n = STATES.length * WIDTHS.length;
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} shots, the double taps, 100%, All, Initials, the typed percent and Share${PLANT ? ` (planted: ${PLANT})` : ""}`);
  process.exit(1);
}
console.log(`PASS ${n} shots, the double taps, 100%, All, Initials, the typed percent and Share at 390 and 1440${PLANT ? ` (planted: ${PLANT}: a planted fault passed)` : ""} on ${browserLabel(browser)}`);
