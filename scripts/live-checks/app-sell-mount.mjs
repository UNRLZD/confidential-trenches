#!/usr/bin/env node
// Live check of card app-sell-mount: the trade box's Sell side is mounted and a held token sells from it, from the pool.
// APP_HOST's terminal is framed by a stand-in for SIGN_HOST's shell (app-in-shell.mjs) that sends app-portfolio-mount's
// signed-in account with its Solana pool and one more open position: 1000 DJT (the token of the recorded helper read
// the harness answers), as the signing page sends a position (packages/signpage/src/positions.ts: chain, token, amount,
// cost, wallets and the mint's decimals), since no check can sign a real account in. Headless Chromium opens that
// token's own page, /token/solana/<DJT> (never /, which draws the live Trending column's top, another token, on the
// deployed app), at 1440 x 900 (the box in the right column; the switch's Sell) and 390 x 844 (dpr 2; the phone bar's
// Sell opens the trade sheet), double-taps 25%, then taps 100%, and reads:
//   - the page draws the held token (its data-token is DJT's mint);
//   - the switch's Sell is on, and Sell draws the sell side (sell-box), ready (S8.29), `1K DJT held`;
//   - the double tap asks the shell for exactly one pool.sell, on solana, of the token, for a share of 2,500 basis points
//     (25% of the whole holding, which the signing page turns into units from its own reads of every wallet that holds
//     the token; card pool-sell-share-across-wallets), and no other trade kind; the box then draws a state of
//     trade/States.tsx's (the shell refuses the sell: S8.32 with Retry);
//   - a refused sell sold nothing, so 100% then asks one more pool.sell, for all of it (10,000).
// Node reads the served / first and records the build's entry script, so a run names the build it judged.
// After: app
//   node scripts/live-checks/app-sell-mount.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/app-sell-mount.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { ACCOUNT } from "./app-portfolio-mount.mjs";

const KEY = "app-sell-mount";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The held token (a Solana mint) whose page the check opens: the one the stand-in shell's recorded helper read answers for
 *  (apps/terminal/test/token-source/helper-token-2026-11-03.json, app-in-shell.mjs TOKEN_ANSWER). */
const READ = JSON.parse(readFileSync(path.join(REPO, "apps/terminal/test/token-source/helper-token-2026-11-03.json"), "utf8"));
export const MINT = READ.row[READ.fields.indexOf("token")];
export const HELD = "1000";
/** What a 25% tap must ask: 25% of the whole holding as a share (card pool-sell-share-across-wallets: never the row's
 *  amount, a server's read on mainnet), at the box's 10% slippage. A record names the request's `token` as `mint`:
 *  gitleaks' generic-api-key reads a "token" key with a base58 value as a secret. */
export const WANT = { chain: "solana", mint: MINT, share_bps: 2500, slippage_bps: 1000 };
/** What the 100% tap after it must ask: all of it. */
export const WANT_ALL = { ...WANT, share_bps: 10_000 };
/** The page the check opens: the held token's own (routes.ts tokenHref), the same on the harness and the live app. */
export const PATH = `/token/solana/${MINT}`;
/** The account: app-portfolio-mount's (its Solana pool kept) with 1000 DJT held on Solana, in the shape the signing page
 *  sends a position (its decimals the mint's own, as the recorded token read names them). */
export const STATE = { ...ACCOUNT, positions: [...ACCOUNT.positions, { chain: "solana", token: MINT, amount: HELD, cost: "4.20", wallets: [ACCOUNT.wallets[0].address], decimals: READ.rest.decimals }] };
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
/** The sell side's states (trade/States.tsx stateId with side "sell"): running, filled, and each end. */
const SELL_STATES = new Set(["S8.30", "S8.11", "filled", "S8.32", "S8.36", "S8.35"]);
const READY_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  say(typeof rec.entry === "string" && /^\/assets\/[\w.-]+\.js$/.test(rec.entry), `the served / names its entry script ${rec.entry ?? "none"}`);
  const runs = rec.runs ?? [];
  const have = new Set(runs.map((r) => r.width));
  say(WIDTHS.every((w) => have.has(w.name)), `${runs.length} run(s) of ${WIDTHS.length} (desktop and phone)`);
  for (const r of runs) {
    const bad = [];
    if (r.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (r.route !== "token") bad.push(`drew ${r.route ?? "nothing"}, not the token route`);
    else if (r.mint !== MINT) bad.push(`the token page drew ${r.mint ?? "no token"}, not the held ${MINT}`);
    if (r.width === "desktop" && r.sellOn !== true) bad.push("the switch's Sell is off with a position held");
    const b = r.before;
    if (!b) bad.push("Sell drew no sell side");
    else {
      if (b.state !== "S8.29") bad.push(`the sell side is ${b.state ?? "unmarked"}, not ready (S8.29)`);
      if (b.held !== "1K DJT held") bad.push(`the held line reads ${JSON.stringify(b.held)}, not "1K DJT held"`);
    }
    const asked = r.asked ?? [];
    const sells = asked.filter((a) => a.type === "pool.sell");
    const other = asked.filter((a) => a.type !== "pool.sell").map((a) => a.type);
    if (other.length) bad.push(`the taps asked ${other.join(", ")}, not pool.sell`);
    if (sells.length !== 2) bad.push(`${sells.length} pool.sell request(s) for a double tap of 25% and a tap of 100%`);
    else {
      if (JSON.stringify(sells[0].params) !== JSON.stringify(WANT)) bad.push(`the 25% pool.sell asked ${JSON.stringify(sells[0].params)}, not ${JSON.stringify(WANT)}`);
      if (JSON.stringify(sells[1].params) !== JSON.stringify(WANT_ALL)) bad.push(`the 100% pool.sell asked ${JSON.stringify(sells[1].params)}, not ${JSON.stringify(WANT_ALL)}`);
    }
    if (b && !SELL_STATES.has(r.after?.state)) bad.push(`after the tap the box is ${r.after?.state ?? "gone"}, not a state of States.tsx's sell side`);
    if (!r.shot) bad.push("no screenshot");
    say(bad.length === 0, `${r.width}: ${bad.length ? bad.join("; ") : `Sell drew the sell side (${b.held}), 25% twice asked one pool.sell of ${sells[0].params.share_bps} bps on ${sells[0].params.chain}, then ${r.after.state}; 100% asked ${sells[1].params.share_bps} bps`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const BOX = (sheet) => {
  const main = document.querySelector("main[data-route]");
  const scope = sheet ? document.querySelector('[data-sheet="trade"]') : main?.querySelector(".tkp-desk .tkp-trade");
  const el = scope?.querySelector('[data-testid="sell-box"]');
  return {
    route: main?.dataset.route ?? null,
    mint: main?.querySelector("section.tkp[data-token]")?.getAttribute("data-token") ?? null,
    box: el ? { state: el.getAttribute("data-state"), held: el.querySelector('[data-testid="sell-held"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null } : null,
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

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, route: null, mint: null, sellOn: null, before: null, asked: null, after: null, shot: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}${PATH}`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: READY_MS }).catch(() => {});
    // the shell's signed-in state has landed when the buy side's button no longer asks to sign in
    const buySel = w.isMobile ? '.tkp-desk [data-testid="trade-cta"]' : '.tkp-desk .tkp-trade [data-testid="trade-cta"]';
    await f.waitForFunction((s) => { const t = document.querySelector(s)?.textContent?.trim(); return !!t && t !== "Sign in to trade"; }, buySel, { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(400);
    if (w.isMobile) {
      await f.locator(".tkp-sell").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    } else {
      const sell = f.locator('.tkp-desk .tkp-trade .trb-sides .trb-side').nth(1);
      run.sellOn = await sell.isEnabled().catch(() => false);
      if (run.sellOn) await sell.click({ timeout: 5_000 }).catch(() => {});
    }
    const scope = w.isMobile ? '[data-sheet="trade"]' : ".tkp-desk .tkp-trade";
    await f.locator(`${scope} [data-testid="sell-box"]`).waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    const before = await f.evaluate(BOX, w.isMobile);
    run.route = before.route;
    run.mint = before.mint;
    run.before = before.box;
    await page.screenshot({ path: path.join(shots, `${w.name}-sell.png`) });
    if (run.before) {
      await f.locator(`${scope} [data-testid="sell-box"] [data-pct="2500"]`).dblclick({ timeout: 5_000 }).catch(() => {});
      await f.waitForFunction((s) => { const st = document.querySelector(`${s} [data-testid="sell-box"]`)?.getAttribute("data-state"); return !!st && st !== "S8.29"; }, scope, { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(300);
      run.after = (await f.evaluate(BOX, w.isMobile)).box;
      // the refused sell sold nothing: 100% asks the whole position
      await f.locator(`${scope} [data-testid="sell-box"] [data-pct="10000"]`).click({ timeout: 5_000 }).catch(() => {});
      await page.waitForFunction(() => (window.__ctShellAsked ?? []).filter((m) => m.type === "pool.sell").length >= 2, null, { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    // what the app asked the shell: every kind that trades or moves money (a buy, a sell, an order, a withdraw), each with
    // its params (an envelope carries them beside its type)
    run.asked = await page.evaluate(() => (window.__ctShellAsked ?? []).filter((m) => /buy|sell|order|withdraw/.test(m.type)).map((m) => ({ type: m.type, params: { chain: m.chain, mint: m.token, amount: m.amount, share_bps: m.share_bps, slippage_bps: m.slippage_bps } })));
    run.shot = `${w.name}-sold.png`;
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
  // the harness's browser (a build) routes every socket too (scripts/harness-sockets.mjs); the deployed run reaches the hosts
  const browser = await (build ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: STATE });
    // the deployed run reads only the shell from the stand-in; APP_HOST and the helper as served
    const route = build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r));
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route));
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
    let source = `live ${APP_HOST}, the stand-in shell signed in with app-portfolio-mount's account and 1000 DJT held`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : "<build>"}, the stand-in shell signed in with app-portfolio-mount's account and 1000 DJT held`;
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
