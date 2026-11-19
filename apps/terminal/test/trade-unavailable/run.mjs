#!/usr/bin/env node
// Card app-unavailable-before-the-tap: a coin the pool cannot buy yet opens with Unavailable and Buy off, before any
// tap; a coin it can buy opens ready. The trade box's fixture page (test/trade-box, a kit stub) with ?venue=, whose
// pool.buy.dry judges the coin's venue on the fixture's own pin list (the curve alone; mainnet pins PumpSwap too, so
// PumpSwap stands for a venue with no table), on two Solana pools: sol-ready (the devnet pool's 0.01 SOL note, Max
// from the state, so Buy is on at $0.16 whatever the dry says) and sol-cash (all Cash, Max from the dry's with_cash,
// so $10 and $25 are on for a coin it can buy). Built with vite and served on 127.0.0.1, at 390 x 844 (dpr 2, touch)
// and 1440 x 900 (dpr 1), the page clock paused. Per coin, with no tap: the line above the button, Buy on or off, the
// four presets, a forced tap of Buy and of a preset sends nothing; app-shell's BAR-10 rules (MEASURE), no external
// request, no dialog; the box's reads are pool.buy.dry only, none names a wallet, and an unavailable coin asks no more
// of them than a coin it can buy on the same pool. And a coin refused below_reference at mount whose next dry answers
// ok opens ready again, on Solana (the Fee's dry) and on Base (the buys dry, base-ready's 0.001 ETH chunks).
//   node apps/terminal/test/trade-unavailable/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "trade-box");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = Date.parse("2026-11-19T15:00:00Z");
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// the pool and amount, the coin's venue, the line above the button, whether Buy is on, and the presets row
// (data-preset:disabled)
const ALL_OFF = "10.00:true 25.00:true 50.00:true 100.00:true";
const READY = "pool=sol-ready&amt=0.16";
const CASH = "pool=sol-cash&amt=5";
const BASE_READY = "pool=base-ready&amt=3.50";
const COINS = [
  [READY, "pump-curve", "Max $0.16", true, ALL_OFF],
  [CASH, "pump-curve", "Max $46.50", true, "10.00:false 25.00:false 50.00:true 100.00:true"],
  [READY, "pumpswap", "Unavailable", false, ALL_OFF],
  [CASH, "pumpswap", "Unavailable", false, ALL_OFF],
  [READY, "nofit", "Unavailable", false, ALL_OFF],
  [READY, "notbuilt", "Unavailable", false, ALL_OFF],
  [READY, "below", "Unavailable", false, ALL_OFF],
  // a market state that passes: refused below_reference at mount, then the next dry for the same coin answers ok, so
  // Buy is on again; on Solana that dry is the Fee's, on Base the tap's own ask's (the buys dry)
  [READY, "recovers", "Max $0.16", true, ALL_OFF],
  [BASE_READY, "recovers", "Max $3.50", true, ALL_OFF],
];
// the keys a pool.buy.dry may carry: the chain, the coin and an amount, never a wallet
const DRY_KEYS = new Set(["chain", "token", "mint", "amount"]);

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-trade-unavailable-"));
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
const check = (ok, what) => ok || fails.push(what);
const norm = (s) => s.replace(/\s+/g, " ").trim();
/** Polls (real time, up to 3 s) until the read equals what the row wants, then returns what it saw. */
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
const browser = await launchHarnessBrowser("chromium");
try {
  for (const w of WIDTHS) {
    const readsOf = {};
    for (const [at, venue, LINE, on, PRESETS] of COINS) {
      const tag = `${venue} ${at} @${w.name}`;
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
      await page.goto(`${BASE}/?f=ready&${at}&venue=${venue}`);
      await page.waitForSelector('[data-testid="trade-box"]');
      await page.evaluate(() => document.fonts.ready);
      // the Fee's ask rests 250 ms on the typed amount: run past it so every read the box makes at mount is made
      await page.clock.runFor(400);
      const cta = page.locator('[data-testid="trade-cta"]');
      const line = await settle(async () => norm(await page.locator('[data-testid="trade-max"]').innerText()), LINE);
      check(line === LINE, `${tag}: the line above the button "${line}", want "${LINE}"`);
      const enabled = await settle(async () => !(await cta.isDisabled()), on);
      check(enabled === on, `${tag}: Buy ${enabled ? "on" : "off"}, want ${on ? "on" : "off"}`);
      const label = norm(await cta.innerText());
      check(label === "Buy TORCH", `${tag}: the button "${label}", want "Buy TORCH"`);
      const presets = await page.$$eval("[data-preset]", (bs) => bs.map((b) => `${b.getAttribute("data-preset")}:${b.disabled}`).join(" "));
      check(presets === PRESETS, `${tag}: presets ${presets}, want ${PRESETS}`);
      check((await page.locator('[data-testid="trade-box"]').getAttribute("data-state")) === "S8.3", `${tag}: not the ready state before any tap`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `unavailable-${venue}-${at.split("&")[0].slice(5)}-${w.name}.png`) });
      if (!on) {
        // a forced tap of Buy and of a preset sends nothing
        await cta.click({ force: true });
        await page.locator('[data-preset="10.00"]').click({ force: true });
        await page.clock.runFor(400);
        const calls = await page.evaluate(() => window.__calls);
        check(calls.length === 0, `${tag}: a tap on an unavailable coin sent ${JSON.stringify(calls)}`);
      }
      const reads = await page.evaluate(() => window.__reads);
      readsOf[`${at}|${venue}`] = reads.length;
      check(reads.length > 0, `${tag}: the box asked no pool.buy.dry`);
      for (const r of reads) {
        check(r?.kind === "pool.buy.dry", `${tag}: a read that is not pool.buy.dry: ${JSON.stringify(r)}`);
        for (const k of Object.keys(r?.params ?? {})) check(DRY_KEYS.has(k), `${tag}: a dry names ${k}: ${JSON.stringify(r.params)}`);
      }
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      check(dialogs.length === 0 && (await page.locator('[role="dialog"], dialog').count()) === 0, `${tag}: a dialog ${dialogs.join(" ")}`);
      await ctx.close();
    }
    for (const [at, venue] of COINS) {
      const n = readsOf[`${at}|${venue}`];
      const base = readsOf[`${at}|pump-curve`];
      if (base !== undefined) check(n <= base, `@${w.name}: ${venue} on ${at} asked ${n} dries, more than a coin it can buy (${base})`);
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

const n = COINS.length * WIDTHS.length;
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} coins`);
  process.exit(1);
}
console.log(`PASS ${n} coins at 390 and 1440: ${COINS.filter((c) => !c[3]).length} open Unavailable with Buy off, the curve coin opens ready, on ${browserLabel(browser)}`);
