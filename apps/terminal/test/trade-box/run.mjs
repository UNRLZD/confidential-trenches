#!/usr/bin/env node
// The trade box's buy side, its shots and checks (card app-trade-box-buy; A2.3, app.md:1448; AE-11's buy rows,
// app.md:1352; S8.3, S8.9, S8.10, S8.12 at 09-design-brief S8): the fixture page (fixtures.tsx, a kit stub) built with
// vite and served on 127.0.0.1, every state at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), the page clock paused
// by Playwright, and the trade box's other states (app-trade-box-states: S8.11 Slow, S8.23 Failed with its reason,
// S8.24 Not landed, each with Retry; part filled, with the ready button back and no Retry). Per state: its own state id, app-shell's BAR-10 rules (MEASURE: no text under 11 px, no phone tap box
// under 44 px, no horizontal scroll), no external request, no dialog and no navigation. Then: the set preview equals
// the kit's set for the amount in the box (a typed amount too), the presets at Bal $73.18 and Max $100 ($100 off), a
// preset buys at its size on one click, and a double tap is one buy.
//   node apps/terminal/test/trade-box/run.mjs [--shots <dir>] [--plant set|tap|clock] [--slow-cpu <rate>] [--slow-commit]
// PASS exit 0, FAIL exit 1. --plant runs the same checks on a planted fault (set: the kit's set one cent off the amount;
// tap: the presets 36 px tall; clock: the screen's clock 25% fast) and must FAIL. --slow-cpu slows the page's CPU by the
// rate (Chrome's throttling), --slow-commit lands each React commit 50 ms late (a slow runner); both must still PASS with
// the same labels.
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
if (PLANT && !["set", "tap", "clock"].includes(PLANT)) throw new Error(`--plant set|tap|clock, not ${PLANT}`);
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
const BUY = JSON.stringify({ chain: "solana", token: MINT, side: "buy", amount: "25.00", slippage_bps: 1000 });
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// the state, the fixture, whether the main button is tapped, the page clock's ms after the tap, the button's time, its
// label, and the one line an ended buy draws above it (app-trade-box-states: S8.11, S8.23, S8.24, part filled)
const STATES = [
  ["S8.3", "ready", false, 0, null, "Buy TORCH", null],
  ["S8.9", "ready", true, 100, null, "Sending", null],
  ["S8.10", "ready", true, 400, "0.4s", "Landing 0.4s", null],
  ["S8.11", "slow", true, 6_200, "6.2s", "Slow 6.2s", null],
  ["S8.12", "ready", true, 1_200, "1.1s", "Filled 1.1s", null],
  ["S8.23", "refuse", true, 400, null, "Retry", "Price check failed"],
  ["S8.23", "notsent", true, 400, null, "Retry", "Not sent"],
  ["S8.23", "other", true, 400, null, "Retry", "Failed"],
  ["S8.24", "notlanded", true, 3_100, null, "Retry", "Not landed"],
  ["partial", "partial", true, 1_200, null, "Buy TORCH", "1/2 filled"],
  ["partial", "partial-nocount", true, 1_200, null, "Buy TORCH", "Part filled"],
];

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
  const url = `${BASE}/?f=${f}${PLANT === "set" || PLANT === "clock" ? `&plant=${PLANT}` : ""}`;
  await page.goto(url);
  page.on("framenavigated", (fr) => fr === page.mainFrame() && navs.push(fr.url()));
  await page.waitForSelector('[data-testid="trade-box"]');
  if (PLANT === "tap") await page.addStyleTag({ content: ".trb .trb-preset { height: 36px !important; }" });
  await page.evaluate(() => document.fonts.ready);
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
    for (const [want, f, tapIt, ms, time, LABEL, end] of STATES) {
      const tag = `${want} @${w.name}`;
      const { ctx, page, external, dialogs, navs } = await open(browser, w, f);
      if (tapIt) {
        await page.locator('[data-testid="trade-cta"]').click();
        await page.clock.runFor(ms);
      }
      const box = page.locator('[data-testid="trade-box"]');
      const label = await settle(async () => norm(await page.locator('[data-testid="trade-cta"]').innerText()), LABEL);
      check(label === LABEL, `${tag}: button "${label}", want "${LABEL}"`);
      const got = await settle(() => box.getAttribute("data-state"), want);
      check(got === want, `${tag}: state ${got}, want ${want}`);
      if (time) check((await page.locator('[data-testid="trade-cta"] [data-time]').getAttribute("data-time")) === time, `${tag}: time, want ${time}`);
      const stage = { refuse: "refused", notsent: "refused", other: "refused", notlanded: "not_landed", partial: "part_filled", "partial-nocount": "part_filled" }[f];
      if (stage) check((await box.getAttribute("data-stage")) === stage, `${tag}: the end's stage ${await box.getAttribute("data-stage")}, want ${stage}`);
      // the set preview equals the kit's set for $25 (20 + 5), and the estimate is drawn from it
      const set = await settle(() => box.getAttribute("data-set"), kitSet(2500));
      check(set === kitSet(2500), `${tag}: set ${set}, want ${kitSet(2500)}`);
      const receive = await settle(async () => norm(await page.locator('[data-testid="trade-receive"]').innerText()), "≈ 1.2M TORCH");
      check(receive === "≈ 1.2M TORCH", `${tag}: You receive "${receive}"`);
      const line = await settle(async () => norm(await page.locator('[data-testid="trade-max"]').innerText()), end ?? "Max $100");
      check(line === (end ?? "Max $100"), `${tag}: the line above the button "${line}", want "${end ?? "Max $100"}"`);
      // presets: $10, $25, $50 on and $100 off at Bal $73.18 while nothing runs; all off while a buy runs
      const off = await page.$$eval("[data-preset]", (bs) => bs.map((b) => `${b.getAttribute("data-preset")}:${b.disabled}`).join(" "));
      const running = want === "S8.9" || want === "S8.10" || want === "S8.11";
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

    // Retry is one new buy of the same amount, at once, with no dialog; a slow buy still fills on the kit's stage
    {
      const { ctx, page, dialogs } = await open(browser, w, "notlanded");
      const cta = page.locator('[data-testid="trade-cta"]');
      await cta.click();
      await page.clock.runFor(3_100);
      await cta.click();
      await page.clock.runFor(100);
      const calls = await page.evaluate(() => window.__calls);
      check(calls.length === 2 && JSON.stringify(calls[1].params) === BUY, `@${w.name}: Retry sent ${JSON.stringify(calls)}`);
      check((await settle(() => page.locator('[data-testid="trade-box"]').getAttribute("data-state"), "S8.9")) === "S8.9", `@${w.name}: Retry not Sending`);
      check(dialogs.length === 0, `@${w.name}: a dialog on Retry`);
      await ctx.close();
    }
    // after a part fill there is no Retry: one tap is one new buy of the amount the box shows, never the rest re-sent
    {
      const { ctx, page, dialogs } = await open(browser, w, "partial");
      const cta = page.locator('[data-testid="trade-cta"]');
      await cta.click();
      await page.clock.runFor(1_200);
      await settle(async () => norm(await cta.innerText()), "Buy TORCH");
      const shown = norm(await page.locator('.trb-input').inputValue());
      await cta.click();
      await page.clock.runFor(100);
      const calls = await page.evaluate(() => window.__calls);
      check(shown === "25" && calls.length === 2 && JSON.stringify(calls[1].params) === BUY, `@${w.name}: after a part fill, shown ${shown}, sent ${JSON.stringify(calls)}`);
      check((await settle(() => page.locator('[data-testid="trade-box"]').getAttribute("data-state"), "S8.9")) === "S8.9", `@${w.name}: the tap after a part fill is not Sending`);
      check(dialogs.length === 0, `@${w.name}: a dialog after a part fill`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, w, "slow");
      await page.locator('[data-testid="trade-cta"]').click();
      await page.clock.runFor(8_100);
      check((await settle(() => page.locator('[data-testid="trade-box"]').getAttribute("data-state"), "S8.12")) === "S8.12", `@${w.name}: the slow buy did not fill`);
      const filled = await settle(async () => norm(await page.locator('[data-testid="trade-cta"]').innerText()), "Filled 8.0s");
      check(filled === "Filled 8.0s", `@${w.name}: the slow buy's fill time "${filled}", want "Filled 8.0s"`);
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
      check((await settle(() => page.locator('[data-testid="trade-box"]').getAttribute("data-state"), "S8.12")) === "S8.12", `@${w.name}: the double tap's buy did not fill`);
      await ctx.close();
    }
    // a preset buys at its size on one click
    {
      const { ctx, page } = await open(browser, w, "ready");
      await page.locator('[data-preset="50.00"]').click();
      await page.clock.runFor(100);
      const calls = await page.evaluate(() => window.__calls);
      check(calls.length === 1 && calls[0].params.amount === "50.00", `@${w.name}: the $50 preset ${JSON.stringify(calls)}`);
      check((await settle(() => page.locator('[data-testid="trade-box"]').getAttribute("data-state"), "S8.9")) === "S8.9", `@${w.name}: the $50 preset not Sending`);
      check((await page.locator(".trb-input").inputValue()) === "50", `@${w.name}: the $50 preset's amount`);
      check((await settle(() => page.locator('[data-testid="trade-box"]').getAttribute("data-set"), kitSet(5000))) === kitSet(5000), `@${w.name}: the $50 set`);
      await ctx.close();
    }
    // a typed amount: the set preview is the kit's for it, to the cent; a third decimal is not taken
    {
      const { ctx, page } = await open(browser, w, "ready");
      const input = page.locator(".trb-input");
      await input.fill("13.37");
      await page.clock.runFor(10);
      const set = await settle(() => page.locator('[data-testid="trade-box"]').getAttribute("data-set"), kitSet(1337));
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
