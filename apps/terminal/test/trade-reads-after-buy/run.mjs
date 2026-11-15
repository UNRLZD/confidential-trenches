#!/usr/bin/env node
// The trade box and the fill toast right after a private buy (card app-trade-box-reads-after-a-buy), from the built app
// at its route inside the stand-in shell (app-in-shell harnessRoute), on mainnet data: the recorded mainnet token read
// the shell answers for /token/solana/<mint> (test/token-source/helper-token-2026-11-03.json), a signed-in state whose
// Solana pool holds the owner's mainnet notes after two round trips as the QA browser read them on 13 Nov 18:23Z
// (packages/signpage/test/pool-buy-dry.test.ts: 0.005547107 + 0.003502518 + 0.012 SOL, three ready chunks
// 0.014049625, Max 0.002734505 at the costliest venue, card max-is-what-you-hold-after-a-trade) and SOL at Pyth's
// mainnet read of 4 Nov 07:40Z ($93.01048308, test/trade-box/fixtures.tsx). The shell answers pool.buy.dry as the
// signing page answers an amount above one tap's own spend (packages/signpage/src/pools.ts poolBuyDryKind: tap_max,
// and with Cash to move, with_cash; no cost, no out) and pool.buy filled. At 1440 x 900 (dpr 1, the right column) and
// 390 x 844 (dpr 2, touch; the trade sheet, and the quick-buy bar with the sheet closed):
//   - the fill toast covers none of the token header's Price, 24h change and Tax: at 1440 the strip's tiles, at 390 the
//     hero's price row (the price and its 24h change) and the Tax tile, each measured against the toast's box;
//   - at 1440 the toast covers no control of the main column either (the chart's control row);
//   - the box after a buy: Bal and Max with no Cash (the pool alone, nothing typed), and with Cash, You receive and the
//     Fee with $2 typed, above one tap's own spend; their lines are printed and shot for the card's report, not judged
//     (not fixed here: the dash's root is the signing page's answer, and Bal beside Max needs new screen copy);
// Per state: app-shell's rules (no text under 11 px, a phone tap box of 44 px, no horizontal scroll, no CSP violation),
// no page error, no dialog.
//   node apps/terminal/test/trade-reads-after-buy/run.mjs [--build <dir>] [--shots <dir>]     PASS exit 0, FAIL exit 1
// --build tests a build made elsewhere (main's, for the red run); by default this tree is built.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const HELPER = "https://ct-api.unrealized.trade";
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? path.resolve(args[args.indexOf(k) + 1]) : null);
const SHOTS = opt("--shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// the recorded mainnet token read the shell answers (app-in-shell TOKEN_ANSWER)
const READ = JSON.parse(readFileSync(path.join(APP, "test/token-source/helper-token-2026-11-03.json"), "utf8"));
const ROW = Object.fromEntries(READ.fields.map((k, i) => [k, READ.row[i]]));
const AT = `/token/solana/${ROW.token}`;
// a Solana signature's form, a stand-in: the toast links it, nothing reads it
const TX = "5".repeat(88);
// the owner's Solana pool, 13 Nov 18:23Z (above), priced at Pyth's 4 Nov read; the price's time is the run's, so the
// box prices it (model.ts statePoolPrice: within the feed's bound on this device's clock)
const POOL = { chain: "solana", asset: "SOL", balance: "0.021049625", ready: "0.014049625", tap_max: "0.002734505" };
const pools = () => [{ ...POOL, price: { price: "9301048308", expo: -8, published_s: Math.floor(Date.now() / 1000), read_ms: Date.now() } }];
const BASE = { release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, wallets: [], positions: [], orders: [], held: [], ops: [] };
const signed = (vault) => ({ ...BASE, vault_balance: vault, pools: pools() });
// with Cash ($40 on NEAR): one tap spends its own 0.002734505 and Cash's largest note moved first, 0.4 SOL at most
// (cash-to-pool.ts withCash's shape); an amount above the tap's own spend is answered with no cost and no out
const DRY_CASH = { tap_max: POOL.tap_max, with_cash: "0.4" };
const DRY = { tap_max: POOL.tap_max };
const FILLED = { stage: "filled", txs: [{ chain: "solana", hash: TX }] };
// name: the shell's state (made when the scene opens), its answers
const SCENES = {
  cash: () => [signed("40.00"), { "pool.buy.dry": DRY_CASH, "pool.buy": FILLED }],
  nocash: () => [signed("0"), { "pool.buy.dry": DRY, "pool.buy": FILLED }],
};

async function build() {
  const out = opt("--build");
  if (out) return { dir: out, own: false };
  const { build } = await import("vite");
  const dir = mkdtempSync(path.join(tmpdir(), "ct-trade-reads-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: dir, emptyOutDir: true } });
  return { dir, own: true };
}

const fails = [];
const lines = [];
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
};

async function open(browser, scene, w) {
  const [state, answers] = SCENES[scene]();
  const route = await harnessRoute(DIR, "signed", { state, answers });
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin !== APP_HOST && u.origin !== SIGN_HOST && u.origin !== HELPER) return r.abort();
    return route(r);
  });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(`${APP_HOST}${AT}`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`${w.name}: no APP_HOST frame inside the shell (top at ${page.url()})`);
  const ready = await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: 10_000 }).then(() => true, () => false);
  check(ready, `${scene} @${w.name}: the token page is not ready`);
  // the signed-in state has landed and the pool is priced when the box's Bal reads a number
  await f.waitForFunction(() => /\$\d/.test(document.querySelector('[data-testid="trade-balance"]')?.textContent ?? ""), null, { timeout: 8_000 }).catch(() => {});
  return { ctx, page, f, errors, dialogs };
}

async function rules(tag, f, w, errors, dialogs) {
  const m = await f.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
  check(!m.hscroll, `${tag}: horizontal scroll`);
  check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(" ")}`);
  check(m.smallTaps.length === 0, `${tag}: tap targets under 44 px: ${m.smallTaps.join(" ")}`);
  check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
  check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
  check(dialogs.length === 0, `${tag}: a dialog opened: ${dialogs.join(" | ")}`);
}

/** The box in view: the desktop column at 1440, the trade sheet opened by the bar's Buy at 390. */
async function boxOf(f, w) {
  if (!w.isMobile) return f.locator('.tkp-desk .tkp-trade [data-testid="trade-box"]');
  await f.locator(".tkp-buy").click({ timeout: 3_000 }).catch(() => {});
  await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  await f.waitForTimeout(400);
  return f.locator('[data-sheet="trade"] [data-testid="trade-box"]');
}

const text = async (box, q) => ((await box.locator(q).first().textContent().catch(() => null)) ?? "").replace(/\s+/g, " ").trim();

/** The header's Price, 24h change and Tax as drawn at this width, each with its box in the frame's px. */
async function tiles(f, w) {
  const sel = w.isMobile ? { price: ".tkp-phone .tkp-price", change: ".tkp-phone .tkp-chg", tax: '.tkp-phone .tkp-mtile[data-k="tax"]' } : { price: '.tkp-desk .tkp-tile[data-k="price"]', change: '.tkp-desk .tkp-tile[data-k="change"]', tax: '.tkp-desk .tkp-tile[data-k="tax"]' };
  const out = {};
  for (const [k, q] of Object.entries(sel)) out[k] = await f.locator(q).first().boundingBox().catch(() => null);
  return out;
}
const meets = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The fill toast after one buy: the desktop box's Buy for $0.20 at 1440, the quick-buy bar's $10 at 390 (sheet closed). */
async function fill(browser, w) {
  const tag = `fill toast @${w.name}`;
  const { ctx, page, f, errors, dialogs } = await open(browser, "cash", w);
  try {
    if (w.isMobile) {
      await f.locator(".tkp-phone .tkp-chip").filter({ hasText: /^\$10$/ }).click({ timeout: 3_000 }).catch(() => {});
    } else {
      const box = await boxOf(f, w);
      await box.locator(".trb-input").fill("0.20");
      await box.locator('[data-testid="trade-cta"]').click({ timeout: 3_000 }).catch(() => {});
    }
    const toast = f.locator('[data-testid="fill-toast"]:visible').first();
    const up = await toast.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
    check(up, `${tag}: no fill toast after the buy`);
    if (up) {
      // the toast's own entry (opacity and a 12 px slide) has ended: reduced motion draws it at once
      await f.waitForTimeout(400);
      const t = await toast.boundingBox();
      const head = await tiles(f, w);
      for (const [k, b] of Object.entries(head)) {
        check(b !== null, `${tag}: no ${k} drawn on the page`);
        if (b && t) check(!meets(t, b), `${tag}: the toast ${JSON.stringify(t)} covers the header's ${k} ${JSON.stringify(b)}`);
      }
      if (t) check(t.x >= -0.5 && t.x + t.width <= w.viewport.width + 0.5 && t.y >= 0 && t.y + t.height <= w.viewport.height, `${tag}: the toast is outside the window ${JSON.stringify(t)}`);
      // at 1440 nor any control of the main column (the chart's timeframes, Indicators, Display, Price / MCap, USD / SOL)
      if (t && !w.isMobile) {
        const hit = await f.$$eval(".tkp-desk .tkp-main button, .tkp-desk .tkp-main a", (els, t) => els.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.x < t.x + t.width && t.x < b.right && b.y < t.y + t.height && t.y < b.bottom; }).map((e) => e.textContent.trim() || e.getAttribute("aria-label")), t);
        check(hit.length === 0, `${tag}: the toast covers the main column's controls ${JSON.stringify(hit)}`);
      }
      lines.push(`${tag}: toast ${JSON.stringify(t)}; header ${JSON.stringify(head)}`);
    }
    await rules(tag, f, w, errors, dialogs);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `fill-${w.name}.png`) });
  } finally {
    await ctx.close();
  }
}

/** The box after a buy: Bal, Max and You receive with `amt` typed, printed and shot. */
async function reads(browser, w, scene, amt) {
  const tag = `${scene} $${amt} @${w.name}`;
  const { ctx, page, f, errors, dialogs } = await open(browser, scene, w);
  try {
    const box = await boxOf(f, w);
    await box.locator(".trb-input").fill(amt);
    // the box's dry reads settle (FEE_ASK_SETTLE_MS 250) and answer
    await f.waitForTimeout(900);
    lines.push(`${tag}: "${await text(box, '[data-testid="trade-balance"]')}" | Max line "${await text(box, '[data-testid="trade-max"]')}" | You receive "${await text(box, '[data-testid="trade-receive"]')}" | Fee "${await text(box, '[data-testid="trade-cost"]')}" | Buy ${(await box.locator('[data-testid="trade-cta"]').isEnabled()) ? "on" : "off"}`);
    await rules(tag, f, w, errors, dialogs);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${scene}${amt ? `-${amt}` : ""}-${w.name}.png`) });
  } finally {
    await ctx.close();
  }
}

const { dir: DIR, own } = await build();
const browser = await launchHarnessBrowser("chromium");
try {
  for (const w of WIDTHS) {
    await fill(browser, w);
    await reads(browser, w, "nocash", "");
    await reads(browser, w, "cash", "2");
  }
} finally {
  await browser.close();
  if (own) rmSync(DIR, { recursive: true, force: true });
}

for (const l of lines) console.log(l);
if (fails.length) {
  for (const x of fails) console.log(`FAIL ${x}`);
  console.log(`FAIL ${fails.length} of ${checks} checks`);
  process.exit(1);
}
console.log(`PASS ${checks} checks: the fill toast clear of the header's Price, 24h change and Tax at 390 and 1440, from the built app inside the stand-in shell${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
