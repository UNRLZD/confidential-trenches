#!/usr/bin/env node
// The trade box's buy side, its shots and checks (card app-trade-box-buy; A2.3, app.md:1448; AE-11's buy rows,
// app.md:1352; S8.3, S8.9, S8.10, S8.12 at 09-design-brief S8): the fixture page (fixtures.tsx, a kit stub) built with
// vite and served on 127.0.0.1, every state at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), the page clock paused
// by Playwright. Per state: its own state id, app-shell's BAR-10 rules (MEASURE: no text under 11 px, no phone tap box
// under 44 px, no horizontal scroll), no external request, no dialog and no navigation. Then: the set preview equals
// the kit's set for the amount in the box (a typed amount too), the presets at Bal $73.18 and Max $100 ($100 off), a
// preset buys at its size on one click, and a double tap is one buy.
//   node apps/terminal/test/trade-box/run.mjs [--shots <dir>] [--plant set|tap]     PASS exit 0, FAIL exit 1
// --plant runs the same checks on a planted fault (set: the kit's set one cent off the amount; tap: the presets 36 px
// tall) and must FAIL.
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
const plantAt = args.indexOf("--plant");
const PLANT = plantAt >= 0 ? args[plantAt + 1] : null;
if (PLANT && !["set", "tap"].includes(PLANT)) throw new Error(`--plant set|tap, not ${PLANT}`);

const NOW = Date.parse("2026-11-02T06:00:00Z");
// the fixture's mint (fixtures.tsx), kept apart from a `token:` key (gitleaks reads a long id beside that word as a secret)
const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const BUY = JSON.stringify({ chain: "solana", token: MINT, side: "buy", amount: "25.00", slippage_bps: 1000 });
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// the state, the fixture, whether the main button is tapped, the page clock's ms after the tap, the button's time
const STATES = [
  ["S8.3", "ready", false, 0, null],
  ["S8.9", "ready", true, 100, null],
  ["S8.10", "ready", true, 400, "0.4s"],
  ["S8.12", "ready", true, 1_200, "1.1s"],
  ["ended", "refuse", true, 400, null],
];
const LABEL = { "S8.3": "Buy TORCH", "S8.9": "Sending", "S8.10": "Landing 0.4s", "S8.12": "Filled 1.1s", ended: "Buy TORCH" };

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-trade-box-"));
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
  const url = `${BASE}/?f=${f}${PLANT === "set" ? "&plant=set" : ""}`;
  await page.goto(url);
  page.on("framenavigated", (fr) => fr === page.mainFrame() && navs.push(fr.url()));
  await page.waitForSelector('[data-testid="trade-box"]');
  if (PLANT === "tap") await page.addStyleTag({ content: ".trb .trb-preset { height: 36px !important; }" });
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external, dialogs, navs };
}

/** The kit stub's set for an amount in cents: the ladder sizes largest first, the cents in the largest (fixtures.tsx). */
function kitSet(cents) {
  const rungs = [];
  for (let p = 100; p <= cents; p *= 10) for (const m of [1, 2, 5]) if (p * m >= 200 && p * m <= cents) rungs.push(p * m);
  rungs.reverse();
  const sizes = [];
  let rest = cents;
  for (const r of rungs) while (rest >= r) (sizes.push(r), (rest -= r));
  if (!sizes.length) sizes.push(cents);
  else sizes[0] += rest;
  return sizes.map((c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`).join("+");
}

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  for (const w of WIDTHS) {
    for (const [want, f, tapIt, ms, time] of STATES) {
      const tag = `${want} @${w.name}`;
      const { ctx, page, external, dialogs, navs } = await open(browser, w, f);
      if (tapIt) {
        await page.locator('[data-testid="trade-cta"]').click();
        await page.clock.runFor(ms);
      }
      const box = page.locator('[data-testid="trade-box"]');
      const got = await box.getAttribute("data-state");
      check(got === want, `${tag}: state ${got}, want ${want}`);
      const label = norm(await page.locator('[data-testid="trade-cta"]').innerText());
      check(label === LABEL[want], `${tag}: button "${label}", want "${LABEL[want]}"`);
      if (time) check((await page.locator('[data-testid="trade-cta"] [data-time]').getAttribute("data-time")) === time, `${tag}: time, want ${time}`);
      if (want === "ended") check((await box.getAttribute("data-stage")) === "refused", `${tag}: the refusal's stage`);
      // the set preview equals the kit's set for $25 (20 + 5), and the estimate is drawn from it
      check((await box.getAttribute("data-set")) === kitSet(2500), `${tag}: set ${await box.getAttribute("data-set")}, want ${kitSet(2500)}`);
      check(norm(await page.locator('[data-testid="trade-receive"]').innerText()) === "≈ 1.2M TORCH", `${tag}: You receive`);
      check(norm(await page.locator('[data-testid="trade-max"]').innerText()) === "Max $100", `${tag}: the max line`);
      // presets: $10, $25, $50 on and $100 off at Bal $73.18 while nothing runs; all off while a buy runs
      const off = await page.$$eval("[data-preset]", (bs) => bs.map((b) => `${b.getAttribute("data-preset")}:${b.disabled}`).join(" "));
      const running = want === "S8.9" || want === "S8.10";
      const wantOff = running ? "10.00:true 25.00:true 50.00:true 100.00:true" : "10.00:false 25.00:false 50.00:false 100.00:true";
      check(off === wantOff, `${tag}: presets ${off}, want ${wantOff}`);
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      check(dialogs.length === 0 && (await page.locator('[role="dialog"], dialog').count()) === 0, `${tag}: a dialog ${dialogs.join(" ")}`);
      check(navs.length === 0, `${tag}: navigated ${navs.join(" ")}`);
      const calls = await page.evaluate(() => window.__calls);
      check(calls.length === (tapIt ? 1 : 0), `${tag}: ${calls.length} buy requests`);
      if (tapIt) check(JSON.stringify(calls[0]?.params) === BUY && calls[0]?.kind === "buy", `${tag}: the buy ${JSON.stringify(calls[0])}`);
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(want);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${want}-${f}-${w.name}.png`) });
      await ctx.close();
    }

    // a double tap is one buy
    {
      const { ctx, page } = await open(browser, w, "ready");
      const cta = page.locator('[data-testid="trade-cta"]');
      await cta.click();
      await cta.click({ force: true });
      await page.clock.runFor(30);
      await cta.click({ force: true });
      await page.clock.runFor(1_200);
      const calls = await page.evaluate(() => window.__calls);
      check(calls.length === 1, `@${w.name}: a double tap sent ${calls.length} buys`);
      check((await page.locator('[data-testid="trade-box"]').getAttribute("data-state")) === "S8.12", `@${w.name}: the double tap's buy did not fill`);
      await ctx.close();
    }
    // a preset buys at its size on one click
    {
      const { ctx, page } = await open(browser, w, "ready");
      await page.locator('[data-preset="50.00"]').click();
      await page.clock.runFor(100);
      const calls = await page.evaluate(() => window.__calls);
      check(calls.length === 1 && calls[0].params.amount === "50.00", `@${w.name}: the $50 preset ${JSON.stringify(calls)}`);
      check((await page.locator('[data-testid="trade-box"]').getAttribute("data-state")) === "S8.9", `@${w.name}: the $50 preset not Sending`);
      check((await page.locator(".trb-input").inputValue()) === "50", `@${w.name}: the $50 preset's amount`);
      check((await page.locator('[data-testid="trade-box"]').getAttribute("data-set")) === kitSet(5000), `@${w.name}: the $50 set`);
      await ctx.close();
    }
    // a typed amount: the set preview is the kit's for it, to the cent; a third decimal is not taken
    {
      const { ctx, page } = await open(browser, w, "ready");
      const input = page.locator(".trb-input");
      await input.fill("13.37");
      await page.clock.runFor(10);
      const set = await page.locator('[data-testid="trade-box"]').getAttribute("data-set");
      check(set === kitSet(1337), `@${w.name}: typed $13.37 set ${set}, want ${kitSet(1337)}`);
      await input.press("End");
      await input.press("9");
      check((await input.inputValue()) === "13.37", `@${w.name}: a third decimal taken`);
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
  console.log(`FAIL ${fails.length} checks over ${n} shots, the double tap, the preset and the typed amount${PLANT ? ` (planted: ${PLANT})` : ""}`);
  process.exit(1);
}
console.log(`PASS ${n} shots, the double tap, the preset and the typed amount at 390 and 1440${PLANT ? ` (planted: ${PLANT}: a planted fault passed)` : ""}`);
