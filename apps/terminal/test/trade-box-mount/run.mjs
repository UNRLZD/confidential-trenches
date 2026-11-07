#!/usr/bin/env node
// The token page's trade box and safety grid, signed out (card app-trade-box-mount; S7.2 with S8.1, A2.2 and A2.3), taken
// from the built app at its route, not a test page: apps/terminal built with its own vite config and opened at / (the
// top Trending token, then its token read) inside the stand-in shell with the shell sending a SIGNED-OUT state (app-in-shell
// harnessRoute "tap"), HELPER_HOST answered from the recorded live answers (the recorded token read carries the `risk`
// part the grid draws). At 1440 x 900 (dpr 1) and 390 x 844 (dpr 2, touch), each under a dark and a light colour scheme
// (the terminal is dark only, as designed: the light run proves it does not turn light).
//   1440: the right column holds the box (to the right of the chart, inside the window): `Bal —`, the exit plan block off
//         with its line, the main button `Sign in to trade` (enabled), its state S8.1; the safety grid under the Route & fees
//         line, twelve cells, each label and value the token read's (the recorded answer's numbers, below); the button
//         opens the sign-in sheet (S2.1) and Escape closes it; a preset opens it too; no dialog, no confirm.
//   390:  no box on the page behind; the bar's Buy opens the trade sheet (its name `Buy <symbol>`, the box and the grid in
//         it, inside the window), the button there opens the sign-in sheet over it, whose Escape closes only that, then the
//         scrim and Escape close the sheet (hidden, its box still mounted) and the page scrolls again; the bar's Sell and a
//         quick buy open the sheet too.
// Per state: app-shell's own rules (no text under 11 px, a phone tap box of 44 px, no horizontal scroll, no CSP
// violation), the page's colour is the dark page. Requests to any other host are refused and listed. Draft words drawn
// are listed.
//   node apps/terminal/test/trade-box-mount/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const HELPER = "https://api.confidential.unrealized.trade";
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const SCHEMES = ["dark", "light"];

// The recorded token read the harness answers (test/token-source/helper-token-2026-11-03.json). The grid's values are
// written out here by hand from its numbers, not by the app's own code: top 10 2298 bps, no dev or sniper share, 71,294
// holders, $561,882 of liquidity, no transfer fee, both authorities still held, nothing read for insiders, LP and honeypot.
const READ = JSON.parse(readFileSync(path.join(APP, "test/token-source/helper-token-2026-11-03.json"), "utf8"));
const ROW = Object.fromEntries(READ.fields.map((f, i) => [f, READ.row[i]]));
const RISK = READ.rest.risk;
const KNOWN = ROW.top10_bps === 2298 && ROW.dev_bps === null && ROW.snipers_bps === null && ROW.holders === 71294 && ROW.liq_usd === "561882.088225" && ROW.mint_auth === true && ROW.freeze_auth === true && RISK.tax.v.buy_bps === 0 && RISK.tax.v.sell_bps === 0 && RISK.insiders_bps.v === null && RISK.honeypot.v === null && RISK.lp.v === null;
if (!KNOWN) throw new Error("trade-box-mount: the recorded token read is no longer the one the expected cells were written from");
const SYMBOL = ROW.symbol;
// id, label, value (null: an icon alone), cross (the cell draws the cross), verdict colour
const CELLS = [
  ["top10", "Top 10 %", "23%", false, "good"],
  ["dev", "Dev %", "—", false, "unknown"],
  ["snipers", "Snipers %", "—", false, "unknown"],
  ["holders", "Holders", "71.3K", false, "plain"],
  ["liq", "Liq", "$561.9K", false, "plain"],
  ["age", "Age", /^\d+d$/, false, "plain"],
  ["insiders", "Insiders", "—", false, "unknown"],
  ["tax", "Tax", "0%", false, "plain"],
  ["mintAuth", "Mint auth", "", true, "bad"],
  ["freezeAuth", "Freeze auth", "", true, "bad"],
  ["lp", "LP", "—", false, "unknown"],
  ["honeypot", "Honeypot", "—", false, "unknown"],
];

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-trade-box-mount-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const fails = [];
const drafts = new Map();
const refused = new Set();
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
};

/** The grid inside `root` read as cells. */
const readGrid = (root) =>
  root.evaluate((el) =>
    [...el.querySelectorAll(".rg-cell")].map((c) => ({
      id: c.getAttribute("data-cell"),
      label: c.querySelector(".rg-label")?.textContent ?? null,
      value: c.querySelector(".rg-value")?.textContent ?? null,
      cross: !!c.querySelector('svg path[d^="M4.3 4.3"]'),
      tone: c.getAttribute("data-tone"),
    })),
  );

/** The box's signed-out state and its grid, read in `scope` (the desktop column or the phone sheet). */
async function judgeBox(tag, f, scope) {
  const box = f.locator(`${scope} [data-testid="trade-box"]`);
  check((await box.count()) === 1, `${tag}: ${await box.count()} trade boxes in ${scope}`);
  if ((await box.count()) !== 1) return null;
  check(await box.isVisible(), `${tag}: the trade box is not visible`);
  const text = async (q) => ((await box.locator(q).first().textContent().catch(() => null)) ?? "").trim();
  check((await box.getAttribute("data-state")) === "S8.1", `${tag}: state ${await box.getAttribute("data-state")}, not S8.1`);
  check((await text('[data-testid="trade-balance"]')) === "Bal —", `${tag}: the balance reads ${JSON.stringify(await text('[data-testid="trade-balance"]'))}, not "Bal —"`);
  check(!/available/i.test(await box.innerText()), `${tag}: the box says "available"`);
  const exit = box.locator('[data-testid="trade-exit"]');
  const exitText = (await exit.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  check(exitText === "Exit plan Sells automatically once this buy fills", `${tag}: the exit plan block reads ${JSON.stringify(exitText)}`);
  const sw = exit.locator("button");
  check((await sw.getAttribute("aria-pressed")) === "false" && (await exit.getAttribute("data-on")) === "false", `${tag}: the exit plan is not off`);
  check((await sw.getAttribute("aria-label")) === "Exit plan", `${tag}: the exit plan switch's name`);
  const cta = box.locator('[data-testid="trade-cta"]');
  check((await cta.innerText()).trim() === "Sign in to trade", `${tag}: the main button reads ${JSON.stringify((await cta.innerText()).trim())}`);
  check(await cta.isEnabled(), `${tag}: the main button is disabled`);
  check((await cta.getAttribute("data-kind")) === "setup", `${tag}: the main button's kind is ${await cta.getAttribute("data-kind")}`);
  check((await box.locator(".trb-input").inputValue()) === "", `${tag}: the amount box is not empty`);
  // the grid is under the Route & fees line, inside the box
  const g = box.locator('[data-testid="safety-grid"]');
  check((await g.count()) === 1, `${tag}: ${await g.count()} safety grids in the box`);
  const gb = await g.boundingBox();
  const lb = await box.locator(".trb-line").boundingBox();
  check(!!gb && !!lb && gb.y >= lb.y + lb.height - 0.5, `${tag}: the grid is not under the Route & fees line`);
  const cells = await readGrid(g);
  check(cells.length === CELLS.length, `${tag}: ${cells.length} cells, not ${CELLS.length}`);
  for (const [i, [id, label, value, cross, tone]] of CELLS.entries()) {
    const c = cells[i];
    const ok = c && c.id === id && c.label === label && (value instanceof RegExp ? value.test(c.value) : c.value === value) && c.cross === cross && c.tone === tone;
    check(!!ok, `${tag}: cell ${i} is ${JSON.stringify(c)}, the read's is ${JSON.stringify([id, label, String(value), cross, tone])}`);
  }
  for (const d of await box.locator("[data-draft-copy]").evaluateAll((els) => els.map((e) => e.getAttribute("data-draft-copy")))) {
    if (!drafts.has(d)) drafts.set(d, new Set());
    drafts.get(d).add(tag);
  }
  return { box, cta };
}

// `page` is the top window (SIGN_HOST's shell, for the shot); `f` is the terminal's frame inside it, where every read is.
async function open(browser, route, w, scheme) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin !== APP_HOST && u.origin !== SIGN_HOST && u.origin !== HELPER) refused.add(u.origin);
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
  await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`${w.name}: no APP_HOST frame inside the shell (top at ${page.url()})`);
  await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: 10_000 }).catch(() => {});
  // the shell's signed-out state has landed when the box's button reads Sign in to trade
  await f.waitForFunction(() => document.querySelector('[data-testid="trade-cta"]')?.textContent?.trim() === "Sign in to trade", null, { timeout: 8_000 }).catch(() => {});
  return { ctx, page, f, errors, dialogs };
}

/** The rules every state is held to. */
async function rules(tag, f, w, errors, dialogs, page) {
  const m = await f.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
  check(!m.hscroll, `${tag}: horizontal scroll`);
  check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(" ")}`);
  check(m.smallTaps.length === 0, `${tag}: tap targets under 44 px: ${m.smallTaps.join(" ")}`);
  check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
  check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
  check(dialogs.length === 0, `${tag}: a dialog opened: ${dialogs.join(" | ")}`);
  const bg = await f.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === "rgb(10, 10, 10)", `${tag}: the page's background is ${bg}`);
  void page;
}

const dir = await build();
const route = await harnessRoute(dir, "tap");
const browser = await launchBrowser("chromium");
let n = 0;
const shot = async (page, name, w, scheme) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${w.name}-${scheme}.png`) });
};
const signin = (f) => f.locator('[data-sheet="signin"]');
const sheetOpens = async (tag, f, then) => {
  await then();
  const ok = await signin(f).waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
  check(ok, `${tag}: the sign-in sheet did not open`);
  if (ok) check((await signin(f).getAttribute("data-state")) === "S2.1", `${tag}: the sign-in sheet's state is ${await signin(f).getAttribute("data-state")}`);
  return ok;
};
const closed = (f, q) => f.locator(q).waitFor({ state: "detached", timeout: 3_000 }).then(() => true, () => false);
// the trade sheet is only hidden when it closes (card app-phone-trade-sheet): its box stays mounted, so a running buy is
// drawn where it is on the next open
const sheetClosed = async (f) =>
  (await f.locator('[data-sheet="trade"]').waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false)) &&
  (await f.locator('[data-sheet="trade"] [data-testid="trade-box"]').count()) === 1;

try {
  for (const w of WIDTHS) {
    const phone = w.isMobile;
    for (const scheme of SCHEMES) {
      n++;
      const tag = `${w.name} ${scheme}`;
      const { ctx, page, f, errors, dialogs } = await open(browser, route, w, scheme);
      check(await f.locator(`.tkp ${phone ? ".tkp-phone" : ".tkp-desk"}`).isVisible(), `${tag}: the ${phone ? "phone" : "desktop"} page is not drawn`);
      check((await f.locator("h1.tkp-sym:visible").first().textContent().catch(() => null)) === SYMBOL, `${tag}: the page's token is not ${SYMBOL}`);
      await rules(`${tag} page`, f, w, errors, dialogs, page);
      await shot(page, "token-signed-out", w, scheme);
      if (!phone) {
        // 1440: the right column
        const got = await judgeBox(tag, f, ".tkp-desk .tkp-trade");
        const col = await f.locator(".tkp-desk .tkp-trade").boundingBox();
        const chart = await f.locator(".tkp-desk .tkp-chart").boundingBox();
        const bb = got ? await got.box.boundingBox() : null;
        check(!!bb && !!chart && !!col && bb.x >= chart.x + chart.width - 0.5, `${tag}: the box is not to the right of the chart (${JSON.stringify(bb)} vs ${JSON.stringify(chart)})`);
        check(!!bb && bb.x + bb.width <= w.viewport.width + 0.5 && bb.x >= 0, `${tag}: the box is outside the window`);
        check(!!bb && !!col && bb.x >= col.x - 0.5 && bb.x + bb.width <= col.x + col.width + 0.5, `${tag}: the box is outside its column`);
        check((await f.locator(".tkp-phone [data-testid=\"trade-box\"]").count()) === 0, `${tag}: the phone's box is mounted behind the desktop page`);
        if (got) {
          // the button opens the sign-in sheet; Escape closes it; a preset opens it too
          if (await sheetOpens(tag, f, () => got.cta.click())) {
            await shot(page, "signin-sheet", w, scheme);
            await page.keyboard.press("Escape");
            check(await closed(f, '[data-sheet="signin"]'), `${tag}: Escape did not close the sign-in sheet`);
          }
          const preset = got.box.locator('[data-testid="trade-presets"] button').first();
          check(await preset.isEnabled(), `${tag}: a preset is disabled signed out`);
          if (await sheetOpens(`${tag} preset`, f, () => preset.click())) {
            await page.keyboard.press("Escape");
            check(await closed(f, '[data-sheet="signin"]'), `${tag}: Escape did not close the sign-in sheet after a preset`);
          }
        }
        await rules(`${tag} after sign-in`, f, w, errors, dialogs, page);
      } else {
        // 390: no box on the page; the bar's Buy opens the trade sheet
        check((await f.locator(".tkp-desk").isVisible()) === false, `${tag}: the desktop page is drawn on the phone`);
        check((await f.locator(".tkp-phone [data-testid=\"trade-box\"]").count()) === 0, `${tag}: the phone page draws the box before the sheet is open`);
        check(await f.locator(".tkp-bottom").isVisible(), `${tag}: no bottom bar`);
        await f.locator(".tkp-buy").click();
        const sheet = f.locator('[data-sheet="trade"]');
        const up = await sheet.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
        check(up, `${tag}: the Buy button did not open the trade sheet`);
        if (up) {
          const name = await sheet.locator('[role="dialog"]').getAttribute("aria-label");
          check(name === `Buy ${SYMBOL}`, `${tag}: the sheet's name is ${name}`);
          check((await sheet.locator(".tkp-ssym").textContent()) === SYMBOL, `${tag}: the sheet's symbol`);
          await f.waitForTimeout(150);
          const got = await judgeBox(`${tag} sheet`, f, '[data-sheet="trade"]');
          await rules(`${tag} sheet`, f, w, errors, dialogs, page);
          await shot(page, "trade-sheet", w, scheme);
          const sb = await sheet.locator(".tsh-box").boundingBox();
          check(!!sb && sb.x >= 0 && sb.x + sb.width <= w.viewport.width + 0.5 && sb.y + sb.height <= w.viewport.height + 0.5 && sb.y >= 0, `${tag}: the sheet is outside the window (${JSON.stringify(sb)})`);
          const gb = await sheet.locator('[data-testid="safety-grid"]').boundingBox();
          check(!!gb && gb.x >= 0 && gb.x + gb.width <= w.viewport.width + 0.5, `${tag}: the grid is outside the window`);
          check((await f.evaluate(() => document.body.style.overflow)) === "hidden", `${tag}: the page behind scrolls while the sheet is open`);
          await sheet.locator('[data-testid="safety-grid"]').scrollIntoViewIfNeeded();
          await shot(page, "trade-sheet-grid", w, scheme);
          if (got && (await sheetOpens(tag, f, () => got.cta.click()))) {
            // over the trade sheet, not under it
            const top = await f.evaluate(() => {
              const b = document.querySelector(".sgn-box")?.getBoundingClientRect();
              return b ? document.elementFromPoint(b.x + b.width / 2, b.y + 40)?.closest(".sgn") !== null : null;
            });
            check(top === true, `${tag}: the sign-in sheet is not above the trade sheet`);
            await shot(page, "signin-over-sheet", w, scheme);
            await page.keyboard.press("Escape");
            check(await closed(f, '[data-sheet="signin"]'), `${tag}: Escape did not close the sign-in sheet`);
            check(await sheet.isVisible(), `${tag}: Escape on the sign-in sheet closed the trade sheet too`);
          }
          await f.locator(".tsh-scrim").click({ position: { x: 20, y: 20 } });
          check(await sheetClosed(f), `${tag}: the scrim did not close the trade sheet`);
          check((await f.evaluate(() => document.body.style.overflow)) === "", `${tag}: the page stays locked after the sheet closed`);
        }
        // Sell, a quick buy and Escape
        for (const [what, q] of [["Sell", ".tkp-sell"], ["a quick buy", ".tkp-chip"]]) {
          await f.locator(q).first().click();
          const o = await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
          check(o, `${tag}: ${what} did not open the trade sheet`);
          await page.keyboard.press("Escape");
          check(await sheetClosed(f), `${tag}: Escape did not close the sheet opened by ${what}`);
        }
        // the grab handle closes it too
        await f.locator(".tkp-buy").click();
        await f.locator(".tsh-grab").click();
        check(await sheetClosed(f), `${tag}: the grab handle did not close the sheet`);
        await rules(`${tag} closed`, f, w, errors, dialogs, page);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy: ${d} (${[...ids].join(", ")})`);
const off = [...refused].filter((o) => o !== APP_HOST && o !== SIGN_HOST && o !== HELPER);
if (off.length) console.log(`refused off-host requests (the shell's): ${off.join(" ")}`);
if (fails.length) {
  for (const x of fails) console.log(`FAIL ${x}`);
  console.log(`FAIL ${fails.length} of ${checks} checks over ${n} states`);
  process.exit(1);
}
console.log(`PASS ${checks} checks over ${n} states (390 and 1440, dark and light) from the built app at the token route inside the stand-in shell, signed out${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
