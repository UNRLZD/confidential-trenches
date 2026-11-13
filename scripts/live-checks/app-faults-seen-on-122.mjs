#!/usr/bin/env node
// Live check of card app-faults-seen-on-122: the screen faults of release 122's signed-in walk (research repo
// docs/qa/live-2026-11-12-r122.md rows 4-8), each on the deployed screen. APP_HOST's terminal is framed by the stand-in
// SIGN_HOST shell (app-in-shell.mjs) that sends ACCOUNT below: 73.18 USDC in the vault, the Solana pool priced at
// $82.37, and the 12 Nov open buy whose one-time wallet holds 0.008478835 SOL (asset_held); it answers deposit.assets as
// the real page does. Headless Chromium opens /portfolio at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop,
// dpr 1) and reads, in each:
//   - Private balance's first row is NEAR's vault, in USDC, its balance in base units, with no data-ready or data-pending
//     mark (row 4; 13 Nov 07:53Z: removed, the app names no proof: a pool row is chain, Balance, Withdraw);
//   - the Positions tile opens to two parts, Coins and Reserve: Reserve is the held SOL at the pool's price, exact and
//     rounded down once (69 cents, on Solana), and the two add up to the tile; on the desktop Allocation draws a
//     Reserve tile at the same cents (owner pick 12 Nov 16:17:50Z, option B);
//   - the phone's Positions pane has one Open and one Closed control, and Closed turns on when tapped (row 6);
//   - the page load asks no deposit.assets (card app-faults-seen-on-124 fault 9: the list is asked at a Deposit control's
//     intent, a pointer over it, its focus or press, or as the sheet opens); once Deposit is pressed it is asked, and the
//     sheet's first read after it opens draws the asset (any state but S4.1, the assets' loading skeleton) (row 7).
// Discover's stamp (row 5), the PumpSwap chart (row 4) and Discover's logos (live check discover-matches-the-main-app)
// are held by their own tests and that check. A screenshot of each width is kept.
// After: app
//   node scripts/live-checks/app-faults-seen-on-122.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served), framed by the stand-in shell
//   node scripts/live-checks/app-faults-seen-on-122.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-faults-seen-on-122";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ICM = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump";
const now = Date.now();
/** The pool's price as the signing page sends it (messages.ts PoolStatePrice), read a second ago. */
const PX = { price: String(8237000000), expo: -8, published_s: Math.floor(now / 1000) - 5, read_ms: now - 1000 };
export const ACCOUNT = {
  release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "73.18",
  wallets: [], orders: [], held: [], ops: [],
  pools: [{ chain: "solana", asset: "SOL", balance: "0.030426", ready: "0", tap_max: "0", price: PX }],
  positions: [{ chain: "solana", token: ICM, amount: "4286.1", cost: "0.0099999", wallets: ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p"], decimals: 6, asset_held: "0.008478835" }],
};
/** 0.008478835 SOL x $82.37 = $0.69840... : 69 cents, rounded down once. */
export const RESERVE_CENTS = "69";
export const NEAR_ROW = { chain: "near", asset: "USDC", balance: "73180000", marks: [] };
const NEAR = { origin_asset: "nep141:wrap.near", chain: "near", symbol: "NEAR", decimals: 24, min: "2.1", max_usd: "1000" };
export const ANSWERS = { "deposit.assets": { assets: [NEAR] } };
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READY_MS = 20_000;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** "$0.70" -> 70n; null for anything else. */
const cents = (s) => {
  const m = /^\$(\d[\d,]*)\.(\d\d)$/.exec(String(s ?? "").trim());
  return m ? BigInt(m[1].replaceAll(",", "") + m[2]) : null;
};

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (phone and desktop)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    if (!r.framed) continue;
    const first = r.pools?.[0] ?? null;
    say(first !== null && same({ chain: first.chain, asset: first.asset, balance: first.balance, marks: first.marks }, NEAR_ROW), `${n}: Private balance's first row is ${first ? JSON.stringify({ chain: first.chain, asset: first.asset, balance: first.balance, marks: first.marks }) : "missing"}, want NEAR's vault ${JSON.stringify(NEAR_ROW)}`);
    const p = r.parts ?? {};
    const partNames = (p.parts ?? []).map((x) => x.part);
    say(same(partNames, ["coins", "reserve"]) && p.open === true, `${n}: the Positions tile ${p.open ? "opens" : "does not open"} to ${JSON.stringify(partNames)}, want ["coins","reserve"]`);
    const reserve = (p.parts ?? []).find((x) => x.part === "reserve");
    const coins = (p.parts ?? []).find((x) => x.part === "coins");
    say(reserve?.cents === RESERVE_CENTS && reserve?.chains === "solana", `${n}: Reserve is ${reserve ? `${reserve.cents} cents on ${reserve.chains || "no chain"}` : "missing"}, want ${RESERVE_CENTS} on solana`);
    const tile = cents(p.tile);
    const sum = coins && reserve && /^\d+$/.test(coins.cents) && /^\d+$/.test(reserve.cents) ? BigInt(coins.cents) + BigInt(reserve.cents) : null;
    say(tile !== null && sum === tile, `${n}: Coins ${coins?.cents ?? "?"} + Reserve ${reserve?.cents ?? "?"} = ${sum ?? "?"} cents, the tile reads ${p.tile ?? "nothing"}`);
    say(same(p.words, ["Coins", "Reserve"]), `${n}: the parts read ${JSON.stringify(p.words ?? null)}`);
    if (n === "desktop") say(r.alloc === RESERVE_CENTS, `${n}: Allocation's Reserve tile is ${r.alloc ?? "missing"} cents, want ${RESERVE_CENTS}`);
    if (n === "phone") {
      const c = r.control ?? {};
      say(c.open === 1 && c.closed === 1, `${n}: the Positions pane draws ${c.open ?? 0} Open and ${c.closed ?? 0} Closed control(s), want one each`);
      say(c.tapped === true, `${n}: tapping Closed ${c.tapped ? "turns it on and Open off" : "changes nothing"}`);
    }
    say(r.loadAsks === 0, `${n}: deposit.assets ${r.loadAsks === 0 ? "is not asked by the page load" : `is asked ${r.loadAsks ?? "?"} time(s) by the page load, before any Deposit control is touched`}`);
    say(r.asks >= 1, `${n}: deposit.assets is asked ${r.asks ?? 0} time(s) once Deposit is pressed, want at least one`);
    say(typeof r.firstState === "string" && r.firstState !== "S4.1", `${n}: the deposit sheet's first read after it opens is ${r.firstState ?? "no sheet"}${r.firstState === "S4.1" ? ", the assets' loading skeleton" : ""}, want the asset drawn (any state but S4.1)`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
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

const asked = (page) => page.evaluate(() => (window.__ctShellAsked ?? []).map((m) => m.type));

const POOLS = (phone) => {
  const b = document.querySelector(phone ? ".pfm .pools" : ".pfd .pools");
  return b ? [...b.querySelectorAll("[data-pool]")].filter((x) => x.dataset.pool !== "unread").map((x) => ({ chain: x.dataset.pool, asset: x.dataset.asset, balance: x.dataset.balance, marks: ["data-ready", "data-pending"].filter((a) => x.hasAttribute(a)) })) : null;
};

const PARTS = () => {
  const t = [...document.querySelectorAll("[data-tile='positions']")].find((e) => e.getClientRects().length > 0);
  if (!t) return { open: false, parts: [] };
  const own = [...t.querySelectorAll(".num")].find((e) => !e.closest(".pvparts") && /^\$/.test(e.textContent.trim()));
  const box = t.querySelector(".pvparts");
  const shown = box ? getComputedStyle(box).display !== "none" : false;
  const parts = box ? [...box.querySelectorAll("[data-part]")].map((e) => ({ part: e.dataset.part, cents: e.dataset.cents, chains: e.dataset.chains ?? null })) : [];
  const words = box ? [...box.querySelectorAll("[data-part] .ell")].map((e) => e.textContent.trim()) : [];
  return { open: t.getAttribute("aria-expanded") === "true" && shown, tile: own?.textContent.trim() ?? null, parts, words };
};

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${SIGN_HOST}/portfolio`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null;
    if (!f) return run;
    const sel = w.isMobile ? ".pfm .pools" : ".pfd .pools";
    await f.waitForSelector(`${sel}:not([data-pools='loading'])`, { timeout: READY_MS }).catch(() => {});
    await f.waitForSelector("[data-tile='positions']", { timeout: 5_000 }).catch(() => {});
    run.pools = await f.evaluate(POOLS, w.isMobile);
    // the page load asks no deposit list: nothing is asked before a Deposit control is touched (a page that asks at READY has)
    await page.waitForTimeout(1_500);
    run.loadAsks = (await asked(page)).filter((t) => t === "deposit.assets").length;
    // the Positions tile's parts
    const tile = f.locator("[data-tile='positions']").filter({ visible: true }).first();
    await tile.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    await (w.hasTouch ? tile.tap({ timeout: 3_000 }) : tile.click({ timeout: 3_000 })).catch(() => {});
    await page.waitForTimeout(300);
    run.parts = await f.evaluate(PARTS);
    await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}-parts.png`) });
    if (!w.isMobile) run.alloc = await f.locator("[data-alloc='reserve']").first().getAttribute("data-cents", { timeout: 2_000 }).catch(() => null);
    if (w.isMobile) {
      await (w.hasTouch ? tile.tap({ timeout: 3_000 }) : tile.click({ timeout: 3_000 })).catch(() => {});
      const c = { open: await f.locator("[data-control='open']").filter({ visible: true }).count(), closed: await f.locator("[data-control='closed']").filter({ visible: true }).count() };
      await f.locator("[data-control='closed']").filter({ visible: true }).first().tap({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(200);
      c.tapped = await f.evaluate(() => document.querySelector("[data-control='closed']")?.classList.contains("on") === true && document.querySelector("[data-control='open']")?.classList.contains("on") === false);
      run.control = c;
      await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}-closed.png`) });
    }
    // the deposit sheet's first read after it opens
    await f.locator("[data-action='deposit']").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
    await f.waitForSelector("[data-sheet='deposit']", { timeout: 3_000 }).catch(() => {});
    run.firstState = await f.locator("[data-sheet='deposit']").first().getAttribute("data-state", { timeout: 1_000 }).catch(() => null);
    run.asks = (await asked(page)).filter((t) => t === "deposit.assets").length;
    await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}-deposit.png`) });
  } finally {
    await ctx.close();
  }
  return run;
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source, harness = false }) {
  mkdirSync(shots, { recursive: true });
  const browser = await (harness ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

/** The stand-in shell with ACCOUNT and the deposit list; APP_HOST from `build`, or with no build the deployed APP_HOST and helper as served. */
export async function routeFor(build = null) {
  const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: ACCOUNT, answers: ANSWERS });
  if (build) return shell;
  return (r) => {
    const o = originOf(r.request().url());
    return o === APP_HOST || o === HELPER_HOST ? r.continue() : shell(r);
  };
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell signed in`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed in`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route: await routeFor(build), source, harness: build !== null });
    const file = opt("--record", null);
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
