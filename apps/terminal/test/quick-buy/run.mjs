#!/usr/bin/env node
// A quick-buy chip buys in one tap on the phone (card app-quick-buy-one-tap; 09-design-brief F14 step 2 and §6.5: "each
// one tap = a buy at that size, no sheet"). The token page itself (test/trade-box/fixtures.tsx ?page=1: TokenPage on the
// recorded read, the kit stub) built with vite and served on 127.0.0.1, at 360 x 740, 390 x 844 and 430 x 932 (dpr 2,
// touch), the page clock paused by Playwright. Per width:
//   - one tap on `$25` sends one buy, the box's own kit call (`buy`, the token, 25.00 USD, the box's slippage), and no
//     sheet opens; the toast over the page reads Sending, then Landing 0.4s, then the fill toast Filled 1.1s;
//   - a double tap is one buy: two clicks in one task (the guard in the buy itself, before React draws the chip off) and
//     a real double tap; a tap after the buy ended sends the next one;
//   - a buy the kit refused draws its reason in the toast with Retry, and nothing else is asked of the kit: the price
//     check refusal (quote_check_failed, which the signing page answers before any signature: packages/signpage
//     test/trade.test.ts "a price check refusal is quote_check_failed"), Not sent, Failed, Not landed; Retry sends one
//     more buy of the same amount;
//   - a buy the box's own device-side checks refuse (the pool's proof not ready, card trade-box-pool) sends nothing;
//   - app-shell's BAR-10 rules on every drawn state (no text under 11 px, no tap box under 44 px, no horizontal scroll,
//     no CSP violation), no browser dialog and no dialog at all, no external request but the page's own reads.
//   node apps/terminal/test/quick-buy/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../trade-box");
const READ = JSON.parse(readFileSync(path.resolve(HERE, "../token-source/helper-token-2026-11-03.json"), "utf8"));
const ROW = Object.fromEntries(READ.fields.map((k, i) => [k, READ.row[i]]));
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
// the box's own kit call for a $25 buy of the page's token (TradeBox.tsx useTrade buy: the vault path)
const BUY25 = { kind: "buy", params: { chain: ROW.chain, token: ROW.token, side: "buy", amount: "25.00", slippage_bps: 1000 } };
// the ended buys: the fixture's query, the page clock's ms after the tap, the toast's line, Retry drawn
const ENDS = [
  ["refused", "f=refuse", 400, "Price check failed"],
  ["notsent", "f=notsent", 400, "Not sent"],
  ["failed", "f=other", 400, "Failed"],
  ["notlanded", "f=notlanded&route=1", 3_100, "Not landed"],
];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-quick-buy-"));
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

/** Polls (real time, up to 3 s) until the read equals what the row wants, as test/trade-box/run.mjs settle. */
async function settle(read, want) {
  const ok = (g) => (want instanceof RegExp ? want.test(g ?? "") : g === want);
  const end = Date.now() + 3_000;
  let got = await read();
  while (!ok(got) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    got = await read();
  }
  return got;
}

let BASE = "";
async function open(browser, w, query) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  // the page's candle and logo reads go to the helper and the token's hosts: refused here, the chart draws its error
  await ctx.route((u) => !u.href.startsWith(BASE) && !u.href.startsWith("data:"), (r) => r.abort());
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW - 1000 });
  await page.clock.pauseAt(NOW);
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  await page.goto(`${BASE}/?page=1&${query}`);
  await page.waitForSelector('.tkp[data-token-page="ready"]');
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, dialogs };
}

// a chip by its label ("$25"), so a build whose chips carry no data-preset is still tapped and judged by what it does
const chip = (page, usd) => page.locator(".tkp-phone .tkp-chip").filter({ hasText: new RegExp(`^\\$${Number(usd)}$`) });
/** Clicks the chip twice in one task (no frame between them), or once with `twice` false, as a script can. */
const clickInTask = (page, usd, twice) =>
  page.evaluate(([label, twice]) => {
    const b = [...document.querySelectorAll(".tkp-phone .tkp-chip")].find((e) => e.textContent.trim() === label);
    if (!b) return false;
    b.click();
    if (twice) b.click();
    return true;
  }, [`$${Number(usd)}`, twice]);
/** One block of the run: an error inside it is that block's failure, and the run goes on to the next. */
async function block(tag, ctxs, fn) {
  try {
    await fn();
  } catch (e) {
    check(false, `${tag}: ${String(e?.message ?? e).split("\n")[0]}`);
  } finally {
    for (const c of ctxs.splice(0)) await c.close().catch(() => {});
  }
}
const open_ = [];
const toast = (page) => page.locator('.tkp-phone [data-testid="quick-toast"]');
const toastLine = (page) => page.locator('.tkp-phone [data-testid="quick-toast-line"]');
const retry = (page) => page.locator('.tkp-phone [data-testid="quick-retry"]');
const fill = (page) => page.locator('.tkp-phone [data-testid="fill-toast"]');
const calls = (page) => page.evaluate(() => window.__calls);
const sheetOpen = (page) => page.evaluate(() => document.querySelector('[data-sheet="trade"]')?.getAttribute("data-open") === "true");

/** The rules every drawn state holds on the page. */
async function rules(tag, page, w, dialogs) {
  const m = await page.evaluate(MEASURE, { phone: true, vw: w.viewport.width });
  check(!m.hscroll, `${tag}: horizontal scroll`);
  check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
  check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
  check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
  check(dialogs.length === 0 && (await page.locator("dialog").count()) === 0, `${tag}: a browser dialog ${dialogs.join(" ")}`);
  check((await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()) === 0, `${tag}: a dialog is drawn`);
  check(!(await sheetOpen(page)), `${tag}: the trade sheet opened`);
  for (const t of [toast(page), fill(page)]) {
    const b = (await t.count()) ? await t.boundingBox() : null;
    if (b) check(b.x >= -0.5 && b.x + b.width <= w.viewport.width + 0.5 && b.y >= 0, `${tag}: the toast is outside the window (${JSON.stringify(b)})`);
  }
  for (const d of await page.$$eval(".tkp-phone [data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
    if (!drafts.has(d)) drafts.set(d, new Set());
    drafts.get(d).add(tag);
  }
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser("chromium");
const label = browserLabel(browser);
try {
  for (const w of WIDTHS) {
    // one tap = one buy, no sheet: Sending, Landing, Filled
    await block(`one tap @${w.name}`, open_, async () => {
      const tag = `one tap @${w.name}`;
      const { ctx, page, dialogs } = await open(browser, w, "f=ready&route=1");
      open_.push(ctx);
      check(await chip(page, "25.00").isEnabled({ timeout: 5_000 }), `${tag}: the $25 chip is off`);
      check((await toast(page).count()) === 0 && (await fill(page).count()) === 0, `${tag}: a toast before any tap`);
      await chip(page, "25.00").tap({ timeout: 5_000 });
      await page.clock.runFor(100);
      const c = await calls(page);
      check(c.length === 1, `${tag}: ${c.length} buys sent for one tap`);
      check(c.length > 0 && JSON.stringify({ kind: c[0].kind, params: c[0].params }) === JSON.stringify(BUY25), `${tag}: the chip's call ${JSON.stringify(c[0])}, want the box's ${JSON.stringify(BUY25)}`);
      const s = await settle(async () => norm(await toastLine(page).innerText().catch(() => "")), "Sending");
      check(s === "Sending", `${tag}: the toast reads "${s}", want Sending`);
      check(!(await chip(page, "10.00").isEnabled({ timeout: 5_000 })), `${tag}: the chips stay on while the buy runs`);
      await rules(`${tag} Sending`, page, w, dialogs);
      await shot(page, `sending-${w.name}`);
      await page.clock.runFor(300);
      const l = await settle(async () => norm(await toastLine(page).innerText().catch(() => "")), "Landing 0.4s");
      check(l === "Landing 0.4s", `${tag}: the toast reads "${l}", want Landing 0.4s`);
      await rules(`${tag} Landing`, page, w, dialogs);
      await shot(page, `landing-${w.name}`);
      await page.clock.runFor(800);
      const f = await settle(async () => norm(await fill(page).locator('[data-testid="fill-toast-line"]').innerText().catch(() => "")), /^Filled 1\.1s/);
      check(/^Filled 1\.1s/.test(f), `${tag}: the fill toast reads "${f}"`);
      check(await fill(page).isVisible(), `${tag}: the fill toast is not in view`);
      check((await page.locator('[data-testid="fill-toast"]:visible').count()) === 1, `${tag}: not one fill toast in view`);
      check((await toast(page).count()) === 0, `${tag}: the run toast stays beside the fill toast`);
      check((await calls(page)).length === 1, `${tag}: more than one buy`);
      await rules(`${tag} Filled`, page, w, dialogs);
      await shot(page, `filled-${w.name}`);
      // the toast's own timeout closes it; the next tap is not held by it
      await page.clock.runFor(6_000);
      check((await settle(() => fill(page).count(), 0)) === 0, `${tag}: the fill toast stays past its timeout`);
    });

    // a double tap = one buy: two clicks in one task (the buy's own guard), then a real double tap; then the next buy
    await block(`double tap @${w.name}`, open_, async () => {
      const tag = `double tap @${w.name}`;
      const { ctx, page } = await open(browser, w, "f=ready&route=1");
      open_.push(ctx);
      check(await clickInTask(page, "25.00", true), `${tag}: no $25 chip`);
      await page.clock.runFor(100);
      check((await calls(page)).length === 1, `${tag}: ${(await calls(page)).length} buys for two clicks in one task`);
      await page.clock.runFor(1_100);
      check((await settle(async () => norm(await fill(page).innerText().catch(() => "")), /Filled/)).includes("Filled"), `${tag}: the first buy did not fill`);
      await chip(page, "10.00").dblclick({ force: true, timeout: 5_000 });
      await page.clock.runFor(100);
      const c = await calls(page);
      check(c.length === 2, `${tag}: ${c.length - 1} buys for a real double tap after the first filled`);
      check(c[1]?.params?.amount === "10.00", `${tag}: the second buy's amount ${c[1]?.params?.amount}`);
      // a tap on another chip while that buy runs sends nothing
      await chip(page, "50.00").click({ force: true, timeout: 5_000 });
      await page.clock.runFor(100);
      check((await calls(page)).length === 2, `${tag}: a tap while a buy runs sent one`);
    });

    // a buy the kit ended: its line in the toast with Retry; Retry sends the same amount once more
    for (const [name, query, ms, line] of ENDS) await block(`${name} @${w.name}`, open_, async () => {
      const tag = `${name} @${w.name}`;
      const { ctx, page, dialogs } = await open(browser, w, query);
      open_.push(ctx);
      await chip(page, "25.00").tap({ timeout: 5_000 });
      await page.clock.runFor(ms);
      const got = await settle(async () => norm(await toastLine(page).innerText().catch(() => "")), line);
      check(got === line, `${tag}: the toast reads "${got}", want "${line}"`);
      check(await retry(page).isVisible(), `${tag}: no Retry in the toast`);
      check(norm(await retry(page).innerText().catch(() => "")) === "Retry", `${tag}: Retry reads "${await retry(page).innerText().catch(() => "")}"`);
      check((await calls(page)).length === 1, `${tag}: ${(await calls(page)).length} calls to the kit for one tap`);
      check((await fill(page).count()) === 0, `${tag}: a fill toast for a buy that did not fill`);
      await rules(tag, page, w, dialogs);
      await shot(page, `${name}-${w.name}`);
      await retry(page).tap({ timeout: 5_000 });
      await page.clock.runFor(50);
      const c = await calls(page);
      check(c.length === 2 && c[1].params?.amount === "25.00", `${tag}: Retry sent ${c.length - 1} buy(s) of ${c[1]?.params?.amount}`);
      check((await settle(async () => norm(await toastLine(page).innerText().catch(() => "")), "Sending")) === "Sending", `${tag}: Retry's buy is not Sending in the toast`);
    });

    // the box's own device-side check refuses: the pool's proof is not ready, so the chip sends nothing
    await block(`pool not ready @${w.name}`, open_, async () => {
      const tag = `pool not ready @${w.name}`;
      const { ctx, page } = await open(browser, w, "f=ready&pool=sol-making");
      open_.push(ctx);
      check(!(await chip(page, "25.00").isEnabled({ timeout: 5_000 })), `${tag}: the chip is on with no proof ready`);
      check(await clickInTask(page, "25.00", false), `${tag}: no $25 chip`);
      await page.clock.runFor(400);
      check((await calls(page)).length === 0, `${tag}: a buy was sent with no proof ready`);
      check((await toast(page).count()) === 0, `${tag}: a toast for a buy never sent`);
    });
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`quick-buy: ${checks} checks on ${label}`);
if (drafts.size) console.log(`draft words drawn: ${[...drafts.keys()].map((d) => JSON.stringify(d)).join(", ")}`);
if (fails.length) {
  console.log(`FAIL (${fails.length})\n${fails.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("PASS");
