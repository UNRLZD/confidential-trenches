#!/usr/bin/env node
// Live check of card signpage-pool-price: the trade box prices a pool buy from the signing page's own price read, so its
// Buy turns on, and only while that read is fresh. Two parts:
//   1. The page's read: the kit's poolUsdPrice (through the kit's public entry) for Solana on the signing page's own
//      pair for it, SIGN_HOST's provider A and the helper's keyed route (packages/signpage/src/trade.ts SOLANA_PROVIDER_A
//      and TRADE_HELPER, the pair main.ts gives the pool kinds and src/pool-price.ts), as SIGN_HOST's CSP allows both. It
//      passes only with two hosts of two providers agreeing on Pyth's SOL/USD account and a price at most 60 s old.
//   2. The terminal: APP_HOST's terminal, framed by a stand-in for SIGN_HOST's shell (app-in-shell.mjs) that sends a
//      signed-in state holding the devnet Solana pool with its proof ready (trade-box-pool.mjs POOL.ready) and, as
//      src/pool-price.ts puts it in state.pools[solana].price, the price part 1 read: fresh (as read), stale (the same
//      price published past Pyth's 60 s bound) and none (no price). Headless Chromium opens / (the token route, a Solana
//      token) at 1440 x 900 and 390 x 844 (dpr 2, the bar's Buy opens the trade sheet), types $0.05 and taps Buy:
//        - fresh: Bal shows USD, Buy is on, and the one tap asks the shell for exactly one pool.buy of $0.05 in SOL at
//          that price, rounded down (5 x 10^15 / price lamports at exponent -8), never the vault's buy;
//        - stale and none: Bal shows no USD, Buy is off, and the tap asks for nothing.
// Node reads the served / first and records the build's entry script, so a run names the build it judged.
//   node scripts/live-checks/signpage-pool-price.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/signpage-pool-price.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POOL_USD_FEEDS, poolUsdPrice, SOLANA_RPC_RETRY, solanaHelperRpc, solanaJsonRpc, solanaSameProvider } from "../../packages/kit/src/index.ts";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { POOL } from "./trade-box-pool.mjs";

const KEY = "signpage-pool-price";
export const APP_HOST = "https://confidential.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://api.confidential.unrealized.trade";
/** The signing page's Solana pair (packages/signpage/src/trade.ts): its provider A and the helper's keyed route. */
export const PAGE_PAIR = ["https://solana-rpc.publicnode.com", `${HELPER_HOST}/v1/rpc/solana`];
export const PRICES = ["fresh", "stale", "none"];
/** The amount typed: $0.05, under the devnet pool's one-tap most (0.00173608 SOL) at any SOL price over $28.80. */
export const TYPED = "0.05";
const CENTS = 5n;
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READY_MS = 20_000;
const MAX_AGE_S = POOL_USD_FEEDS.solana.maxAgeS;

/** The pool entry the stand-in sends for `which`, from the page's read `p`, at the run's clock `nowMs`. */
export function poolWith(which, p, nowMs) {
  if (which === "none") return POOL.ready;
  const published_s = which === "fresh" ? p.published_s : Math.floor(nowMs / 1000) - MAX_AGE_S - 30;
  return { ...POOL.ready, price: { price: p.price, expo: p.expo, published_s, read_ms: which === "fresh" ? p.read_ms : published_s * 1000 } };
}
export const account = (pool) => ({ release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "73.18", pools: [pool], wallets: [], positions: [], orders: [], held: [], ops: [] });

/** $0.05 in lamports at the read's price, rounded down (the terminal's centsToUnits), as a decimal SOL string. */
export function expectedSol(p) {
  const e = 9 - 2 - p.expo;
  const units = e >= 0 ? (CENTS * 10n ** BigInt(e)) / BigInt(p.price) : CENTS / (BigInt(p.price) * 10n ** BigInt(-e));
  const frac = String(units % 10n ** 9n).padStart(9, "0").replace(/0+$/, "");
  return frac ? `${units / 10n ** 9n}.${frac}` : String(units / 10n ** 9n);
}

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const r = rec.read ?? {};
  const two = Array.isArray(r.rpcs) && r.rpcs.length === 2 && new URL(r.rpcs[0]).host !== new URL(r.rpcs[1]).host && r.rpcs.every((u, i) => u === PAGE_PAIR[i]);
  say(two, `the page's Solana pair read: ${(r.rpcs ?? []).join(" and ") || "none"}`);
  const atS = Math.floor(Date.parse(rec.at) / 1000);
  const priced = typeof r.price === "string" && /^[1-9]\d*$/.test(r.price) && r.expo === -8 && Number.isInteger(r.published_s);
  say(priced && r.error === undefined, `the two agree on Pyth's SOL/USD: ${priced ? `${r.price} x 10^${r.expo}` : (r.error ?? "no price")}`);
  say(priced && atS - r.published_s <= MAX_AGE_S && r.published_s - atS <= 60, `the price is fresh: published ${priced ? atS - r.published_s : "?"} s before the run (bound ${MAX_AGE_S} s)`);
  say(typeof rec.entry === "string" && /^\/assets\/[\w.-]+\.js$/.test(rec.entry), `the served / names its entry script ${rec.entry ?? "none"}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => PRICES.map((p) => `${w.name} ${p}`));
  const have = new Set(runs.map((x) => `${x.width} ${x.price}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (desktop and phone; a fresh, a stale and no price)`);
  const sol = priced ? expectedSol(r) : null;
  for (const x of runs) {
    const n = `${x.width} ${x.price}`;
    const bad = [];
    if (x.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (x.route !== "token") bad.push(`drew ${x.route ?? "nothing"}, not the token route`);
    if (!x.box) bad.push("no trade box");
    else {
      if (x.box.path !== "pool") bad.push(`the box is on the ${x.box.path ?? "unmarked"} path, not the pool's`);
      const usd = typeof x.box.bal === "string" && /\$\s?\d/.test(x.box.bal);
      const asked = x.asked ?? null;
      if (asked === null) bad.push("the tap was not read");
      if (x.price === "fresh") {
        if (!usd) bad.push(`Bal shows ${x.box.bal ?? "nothing"}, not USD`);
        if (x.box.ctaOn !== true) bad.push("Buy is off with a fresh price");
        const buys = (asked ?? []).filter((m) => m.type === "pool.buy");
        if (asked && (asked.length !== 1 || buys.length !== 1)) bad.push(`the tap asked for ${asked.map((m) => m.type).join(", ") || "nothing"}, not one pool.buy`);
        else if (buys[0] && (buys[0].params?.chain !== "solana" || buys[0].params?.amount !== sol)) bad.push(`its pool.buy is ${buys[0].params?.amount} SOL on ${buys[0].params?.chain}, not ${sol} SOL on solana`);
      } else {
        if (usd) bad.push(`Bal shows ${x.box.bal} with ${x.price === "stale" ? "a stale" : "no"} price`);
        if (x.box.ctaOn !== false) bad.push(`Buy is on with ${x.price === "stale" ? "a stale" : "no"} price`);
        if (asked && asked.length) bad.push(`the tap asked for ${asked.map((m) => m.type).join(", ")}`);
      }
    }
    if (!x.shot) bad.push("no screenshot");
    say(bad.length === 0, `${n}: ${bad.length ? bad.join("; ") : x.price === "fresh" ? `Bal ${x.box.bal}, Buy on, one pool.buy of ${sol} SOL` : `Bal ${x.box.bal}, Buy off, nothing asked`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** Part 1: the page's own pair, read now. */
export async function pageRead() {
  const rpcs = [solanaJsonRpc(PAGE_PAIR[0], { retry: SOLANA_RPC_RETRY }), solanaHelperRpc(HELPER_HOST, { retry: SOLANA_RPC_RETRY })];
  const out = { rpcs: PAGE_PAIR };
  if (solanaSameProvider(rpcs[0], rpcs[1])) return { ...out, error: "one provider twice" };
  try {
    const p = await poolUsdPrice({ chain: "solana", rpcs });
    return { ...out, price: p.price.toString(), expo: p.expo, published_s: p.publishedS, read_ms: Date.now() };
  } catch (e) {
    return { ...out, error: String(e?.message ?? e) };
  }
}

const READ = (sheet) => {
  const main = document.querySelector("main[data-route]");
  const scope = sheet ? document.querySelector('[data-sheet="trade"]') : main?.querySelector(".tkp-desk .tkp-trade");
  const el = scope?.querySelector('[data-testid="trade-box"]');
  const cta = el?.querySelector('[data-testid="trade-cta"]');
  return {
    route: main?.dataset.route ?? null,
    box: el ? { path: el.getAttribute("data-path"), bal: el.querySelector('[data-testid="trade-balance"]')?.textContent?.trim() ?? null, ctaOn: cta ? !cta.disabled : null, cta: cta?.textContent?.trim() ?? null } : null,
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
// the request's token is kept as `mint`: a public mint address under a "token" key reads as a key to gitleaks' generic rule
const askedSince = async (page, from) =>
  (await page.evaluate(() => window.__ctShellAsked ?? [])).slice(from).filter((m) => m.type !== "state" && m.type !== "nav").map(({ v, id, type, token, ...params }) => ({ type, params: { ...params, ...(token === undefined ? {} : { mint: token }) } }));

async function runOne(browser, w, price, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, price, framed: false, route: null, box: null, asked: null, shot: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: READY_MS }).catch(() => {});
    if (w.isMobile) {
      await f.locator(".tkp-buy").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    }
    const sel = w.isMobile ? '[data-sheet="trade"] [data-testid="trade-box"]' : '.tkp-desk .tkp-trade [data-testid="trade-box"]';
    await f.waitForFunction((s) => { const t = document.querySelector(`${s} [data-testid="trade-cta"]`)?.textContent?.trim(); return !!t && t !== "Sign in to trade"; }, sel, { timeout: 8_000 }).catch(() => {});
    await f.locator(`${sel} .trb-input`).fill(TYPED, { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
    Object.assign(run, await f.evaluate(READ, w.isMobile));
    run.shot = `${w.name}-${price}.png`;
    await page.screenshot({ path: path.join(shots, run.shot) });
    if (!run.box) return run;
    const from = (await page.evaluate(() => window.__ctShellAsked ?? [])).length;
    await f.locator(`${sel} [data-testid="trade-cta"]`).click({ force: true, timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(800);
    run.asked = await askedSince(page, from);
    await page.screenshot({ path: path.join(shots, `${w.name}-${price}-tap.png`) });
    return run;
  } finally {
    await ctx.close();
  }
}

async function entryOf(build) {
  const html = build ? readFileSync(path.join(build, "index.html"), "utf8") : await (await fetch(`${APP_HOST}/`, { signal: AbortSignal.timeout(15_000) })).text();
  return html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1] ?? null;
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), build = null, source }) {
  mkdirSync(shots, { recursive: true });
  const at = new Date().toISOString();
  const read = await pageRead();
  const entry = await entryOf(build);
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    // with no price read, the fresh run has none to send: it is judged BAD on the read's own lines
    const p = read.price ? read : { price: "1", expo: -8, published_s: 0, read_ms: 0 };
    for (const price of PRICES) {
      const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: account(poolWith(price, p, Date.now())) });
      const route = build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r));
      for (const w of WIDTHS) runs.push(await runOne(browser, w, price, shots, route));
    }
    return { check: KEY, at, source, browser: browser.version(), read, entry, shots, runs };
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
    let source = `live ${APP_HOST}, the stand-in shell signed in with the devnet pool and the page's own price read`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : "<build>"}, the stand-in shell signed in with the devnet pool and the page's own price read`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), build, source });
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
