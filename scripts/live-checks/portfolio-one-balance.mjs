#!/usr/bin/env node
// Live check of card portfolio-one-balance: Portfolio's Cash is one total of the vault and every pool at the signing
// page's own price, the header draws that same number, and the Cash tile opens each chain's part on a hover (desktop) or
// a tap (phone), with a pool deposit in flight marked on its chain and counted on neither side. APP_HOST's terminal is
// framed by a stand-in for SIGN_HOST's shell (app-in-shell.mjs) that sends one signed-in account (accountAt: the
// vault's $40.50, 0.5 SOL in the Solana pool at $150, 0.01 ETH in the Base pool at $3,000, an empty Robinhood pool with a
// pool deposit in transit), its prices read 2 s before each run so they are inside the feeds' bounds on the browser's
// clock, since no check can sign a real account in. Headless Chromium opens /portfolio at 1440 x 900 and 390 x 844 (dpr
// 2, touch), dark, and reads:
//   - the terminal is inside the shell and draws Portfolio on the portfolio route;
//   - the visible header's balance and the visible Cash tile are both CASH ($145.50: $40.50 + $75.00 + $30.00);
//   - the parts are hidden until the hover or tap, then each chain's row as PARTS names it: NEAR $40.50, Solana $75.00,
//     Base $30.00, Robinhood $0.00 marked moving (Processing), in that order.
// Node reads the served / first and records the build's entry script, so a run names the build it judged.
// After: app
//   node scripts/live-checks/portfolio-one-balance.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/portfolio-one-balance.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { named } from "./record-names.mjs";

const KEY = "portfolio-one-balance";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** A pool price as the signing page sends it (kit PoolStatePrice): `usd` per whole asset, read 2 s before `nowMs`. */
const priceAt = (usd, nowMs) => ({ price: String(usd * 1e8), expo: -8, published_s: Math.floor(nowMs / 1000) - 2, read_ms: nowMs - 1000 });
/** The signed-in account the stand-in shell sends, its prices fresh at `nowMs`. */
export const accountAt = (nowMs) => ({
  release: "harness-shell",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "40.50",
  pools: [
    { chain: "solana", asset: "SOL", balance: "0.5", ready: "0.5", tap_max: "0.4", price: priceAt(150, nowMs) },
    { chain: "base", asset: "ETH", balance: "0.01", ready: "0.01", tap_max: "0.01", price: priceAt(3000, nowMs) },
    { chain: "robinhood", asset: "ETH", balance: "0", price: priceAt(3000, nowMs) },
  ],
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [{ id: "portfolio-one-balance-pd", kind: "pool_deposit", chain: "robinhood", stage: "in_transit", txs: [], since_ms: nowMs - 30_000 }],
});
/** The account's Cash: $40.50 in the vault + 0.5 SOL at $150 + 0.01 ETH at $3,000; the deposit in flight adds nothing. */
export const CASH = "$145.50";
/** Each chain's part as the tile draws it: [chain, cents, moving]. */
export const PARTS = [
  ["near", "4050", false],
  ["solana", "7500", false],
  ["base", "3000", false],
  ["robinhood", "0", true],
];
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READY_MS = 15_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  say(typeof rec.entry === "string" && /^\/assets\/[\w.-]+\.js$/.test(rec.entry), `the served / names its entry script ${rec.entry ?? "none"}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.map((w) => w.name);
  const have = new Set(runs.map((r) => r.width));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (desktop and phone)`);
  for (const r of runs) {
    const bad = [];
    if (r.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (r.route !== "portfolio" || r.screen !== "portfolio") bad.push(`drew ${r.screen ?? "no screen"} on route ${r.route ?? "none"}, not Portfolio`);
    if (r.cash !== CASH) bad.push(`Portfolio's Cash is ${r.cash ?? "none"}, not the vault and every pool's ${CASH}`);
    if (r.header !== CASH) bad.push(`the header's balance is ${r.header ?? "none"}, not ${CASH}`);
    if (r.hiddenBefore !== true) bad.push("the parts show before a hover or tap");
    const parts = JSON.stringify(r.parts ?? null);
    if (parts !== JSON.stringify(PARTS)) bad.push(`the parts are ${parts}, not ${JSON.stringify(PARTS)}`);
    if (!r.shot) bad.push("no screenshot");
    say(bad.length === 0, `${r.width}: ${bad.length ? bad.join("; ") : `Cash ${r.cash} = the header's, parts ${parts}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const READ = () => {
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none";
  const main = document.querySelector("main[data-route]");
  const pf = main?.querySelector("[data-screen='portfolio']");
  const head = [...document.querySelectorAll(".tb [data-balance], .phh [data-balance]")].find(vis);
  const tile = [...(pf?.querySelectorAll("[data-tile='cash']") ?? [])].find(vis);
  const box = tile?.querySelector(".pvparts");
  return {
    route: main?.dataset.route ?? null,
    screen: pf ? "portfolio" : null,
    cash: tile?.querySelector(".pvv")?.textContent ?? null,
    header: head?.textContent ?? null,
    open: vis(box),
    parts: box ? [...box.querySelectorAll("[data-part]")].map((x) => [x.getAttribute("data-part"), x.getAttribute("data-cents"), x.hasAttribute("data-moving")]) : null,
  };
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function terminal(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

async function runOne(browser, w, shots, build) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, route: null, screen: null, cash: null, header: null, hiddenBefore: null, parts: null, shot: null };
  try {
    // the account's prices are read just now, so each run is inside the feeds' bounds on the browser's clock
    const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: accountAt(Date.now()) });
    // the deployed run reads only the shell from the stand-in; APP_HOST and the helper as served
    await ctx.route("**/*", build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r)));
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/portfolio`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector("[data-screen='portfolio']:not([data-state='S10.1'])", { timeout: READY_MS }).catch(() => {});
    await f.waitForSelector(".tb [data-balance]:not([data-balance='loading']), .phh [data-balance]:not([data-balance='loading'])", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const before = await f.evaluate(READ);
    Object.assign(run, { route: before.route, screen: before.screen, cash: before.cash, header: before.header, hiddenBefore: before.open === false });
    const tile = f.locator("[data-screen='portfolio'] [data-tile='cash']").filter({ visible: true }).first();
    await tile.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
    if (w.isMobile) await tile.tap({ timeout: 3_000 }).catch(() => {});
    else await tile.hover({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const after = await f.evaluate(READ);
    run.parts = after.open ? after.parts : null;
    run.shot = `${w.name}.png`;
    await page.screenshot({ path: path.join(shots, run.shot) });
    return run;
  } finally {
    await ctx.close();
  }
}

/** The served / and its entry script: from `build` on the harness, else APP_HOST as served. */
async function entryOf(build) {
  const html = build ? readFileSync(path.join(build, "index.html"), "utf8") : await (await fetch(`${APP_HOST}/`, { signal: AbortSignal.timeout(15_000) })).text();
  return html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? null;
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), build = null, source }) {
  mkdirSync(shots, { recursive: true });
  const entry = await entryOf(build);
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, build));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), entry, shots, runs };
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell signed in with the vault and three pools`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed in with the vault and three pools`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), build, source });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
