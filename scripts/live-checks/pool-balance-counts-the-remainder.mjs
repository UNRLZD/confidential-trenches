#!/usr/bin/env node
// Live check of card pool-balance-counts-the-remainder: a pool's one balance on APP_HOST's terminal counts the money
// still at that pool's deposit address U_X (the kit's SignpageState.deposit_wallets), so nothing sent ever looks
// missing; and the deposit sheet holds each pool's one-line send rule. APP_HOST's terminal is framed by a stand-in for
// SIGN_HOST's shell (app-in-shell.mjs) that sends one signed-in account (account()): the Solana, Base and Robinhood
// pools, priced, each with money at its U_X, since no check can sign a real account in. Headless Chromium at 390 x 844
// (phone, dpr 2, touch) and 1440 x 900 (desktop) opens /portfolio and reads:
//   - Portfolio's pool rows: each pool's balance (data-balance, base units) its notes plus its U_X's money, exact, and
//     no row says remainder, proof, ready, pending or notes;
//   - the Cash tile: the vault and each pool at the page's own price, the U_X money counted once (the judge's own sum);
//   - the app's scripts (every script the frame loaded and every script those name, fetched as served): each of the
//     three send rules held as a string ("Send only SOL on Solana." and the two ETH lines).
// And SIGN_HOST's own served scripts: whether the deployed signing page fills deposit_wallets at all. The kit's state
// schema names the key once (`pools:<v>,deposit_wallets:<v>}`); any other use of it is the page filling it. While the
// page names it only there, the app's side is read but cannot reach a user: the verdict is INCONCLUSIVE (exit 3), never
// PASS (the page's side is the wallet lead's, on card deposit-takes-each-pools-own-coin).
// After: app
// Bundle: out a browser, and SIGN_HOST's deployed scripts beside the app's build
//   node scripts/live-checks/pool-balance-counts-the-remainder.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/pool-balance-counts-the-remainder.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
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

const KEY = "pool-balance-counts-the-remainder";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** What no pool row says. */
export const NAMED = /remainder|proo?f|\bready\b|pending|\bnotes?\b/i;
/** The deposit sheet's send rules, as the scripts hold them. */
export const RULES = ["Send only SOL on Solana.", "Send only ETH on Base.", "Send only ETH on Robinhood."];
const DECIMALS = { SOL: 9, ETH: 18, USDC: 6 };
/** The signed-in account the stand-in shell sends: each pool's notes and its U_X's money; prices read at the run's own
 *  time (the kit drops one past its feed's bound). */
export const account = (nowMs = Date.now()) => {
  const px = (price) => ({ price, expo: -8, published_s: Math.floor(nowMs / 1000), read_ms: nowMs });
  return {
    release: "harness-shell",
    api: 1,
    signed_in: true,
    way: "passkey",
    code_saved: true,
    vault_balance: "12.34",
    pools: [
      { chain: "solana", asset: "SOL", balance: "0.5", price: px("15000000000") },
      { chain: "base", asset: "ETH", balance: "0.01", price: px("300000000000") },
      { chain: "robinhood", asset: "ETH", balance: "0", price: px("300000000000") },
    ],
    deposit_wallets: [
      { chain: "solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", asset: "SOL", amount: "0.0125" },
      { chain: "base", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", asset: "ETH", amount: "0.002" },
      { chain: "robinhood", address: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", asset: "ETH", amount: "0.0003" },
    ],
    wallets: [],
    positions: [],
    orders: [],
    held: [],
    ops: [],
  };
};
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READY_MS = 15_000;

// ------------------------------------------------------------------------------------------------ the verdict
const units = (s, d) => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s ?? "");
  return m ? BigInt(m[1] + (m[2] ?? "").padEnd(d, "0").slice(0, d)) : null;
};
const usd = (c) => `$${(c / 100n).toLocaleString("en-US")}.${(c % 100n).toString().padStart(2, "0")}`;

/** Each pool's balance in base units the app must draw (notes plus U_X), and Cash in cents, from the account sent. */
export function expected(acct) {
  const rows = {};
  let cash = units(acct.vault_balance, DECIMALS.USDC) / 10_000n;
  for (const p of acct.pools ?? []) {
    const d = DECIMALS[p.asset];
    let u = units(p.balance, d);
    for (const w of acct.deposit_wallets ?? []) if (w.chain === p.chain && w.asset === p.asset) u += units(w.amount, d);
    rows[p.chain] = u.toString();
    // one asset is price x 10^expo USD: cents = u x price x 100 / 10^(d - expo), rounded down
    cash += (u * BigInt(p.price.price) * 100n) / 10n ** BigInt(d - p.price.expo);
  }
  return { rows, cash: usd(cash) };
}

export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const want = rec.account ? expected(rec.account) : null;
  say(want !== null, `the account sent ${want ? `wants ${JSON.stringify(want.rows)}, Cash ${want.cash}` : "is not recorded"}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (phone and desktop)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    const got = Object.fromEntries((r.pools?.rows ?? []).filter(([c]) => c !== "near").map(([c, b]) => [c, b]));
    const same = want !== null && JSON.stringify(got) === JSON.stringify(want.rows);
    say(same, `${n}: Portfolio's pool balances ${JSON.stringify(got)}${same ? ", each its notes and its U_X's money" : `, want ${JSON.stringify(want?.rows)} (notes and U_X)`}`);
    say(!!r.pools && !NAMED.test(r.pools.text ?? ""), `${n}: the pool rows ${r.pools ? (NAMED.test(r.pools.text) ? `say ${JSON.stringify(r.pools.text)}` : "say no remainder, proof, ready, pending or notes") : "not drawn"}`);
    say(want !== null && r.cash === want.cash, `${n}: Cash ${JSON.stringify(r.cash)}, want ${want?.cash ?? "?"} (the U_X money counted once)`);
  }
  const s = rec.scripts ?? { read: 0, found: [] };
  const missing = RULES.filter((w) => !s.found.includes(w));
  say(s.read > 0 && missing.length === 0, `the app's scripts: ${s.read} read, ${missing.length ? `missing ${missing.map((w) => JSON.stringify(w)).join(", ")}` : "each send rule held"}`);
  const bad = lines.some((l) => l.startsWith("BAD"));
  const pg = rec.page ?? null;
  const fills = pg !== null && pg.read > 0 && pg.uses > 0;
  lines.push(`${fills ? "ok " : "-- "} SIGN_HOST's scripts: ${pg ? `${pg.read} read, deposit_wallets named ${pg.named} time(s), ${pg.uses} outside the kit's schema` : "not read"}${fills ? "" : ": the page sends no U_X money yet"}`);
  return { ok: !bad && fills, verdict: bad ? "FAIL" : fills ? "PASS" : "INCONCLUSIVE", lines };
}

// ------------------------------------------------------------------------------------------------ the reads
const READ = () => {
  const b = [...document.querySelectorAll("[data-screen='portfolio'] .pools[data-pools]")].find((e) => e.getClientRects().length);
  const t = [...document.querySelectorAll("[data-screen='portfolio'] [data-tile='cash'] .pvv")].find((e) => e.getClientRects().length);
  return {
    pools: b ? { rows: [...b.querySelectorAll("[data-pool][data-balance]")].map((x) => [x.getAttribute("data-pool"), x.getAttribute("data-balance")]), text: b.innerText.replace(/\s+/g, " ").trim() } : null,
    cash: t ? t.textContent.trim() : null,
  };
};
/** Every script the frame loaded and every same-origin script they name, fetched as served; the words found. */
const SCRIPTS = async (words) => {
  const seen = new Set();
  const queue = [...document.querySelectorAll("script[src]")].map((s) => s.src).concat(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /\.m?js(\?|$)/.test(u)));
  const found = new Set();
  while (queue.length) {
    const u = new URL(queue.shift(), location.href);
    if (u.origin !== location.origin || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    const text = await fetch(u.href).then((r) => (r.ok ? r.text() : ""), () => "");
    for (const w of words) if (text.includes(`"${w}"`) || text.includes(`'${w}'`) || text.includes(`\`${w}\``)) found.add(w);
    for (const m of text.matchAll(/["'`(/]((?:\.\.?\/|\/)?assets\/[\w.-]+\.js)["'`)]/g)) queue.push(new URL(m[1], u.href).href);
    for (const m of text.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) queue.push(new URL(m[1], u.href).href);
  }
  return { read: seen.size, found: [...found] };
};

/** SIGN_HOST's served scripts: how often they name deposit_wallets, and how often outside the kit's schema entry. */
export async function pageReads(origin = SIGN_HOST) {
  const seen = new Set();
  const html = await fetch(`${origin}/`).then((r) => (r.ok ? r.text() : ""));
  const queue = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => new URL(m[1], `${origin}/`).href);
  let namedN = 0;
  let schema = 0;
  while (queue.length) {
    const u = new URL(queue.shift());
    if (u.origin !== origin || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    const text = await fetch(u.href).then((r) => (r.ok ? r.text() : ""), () => "");
    namedN += (text.match(/deposit_wallets/g) ?? []).length;
    schema += (text.match(/pools:[\w$]+,deposit_wallets:[\w$]+\}/g) ?? []).length;
    for (const m of text.matchAll(/["'`]((?:\.\.?\/|\/)[\w./-]+\.js)["'`]/g)) queue.push(new URL(m[1], u.href).href);
  }
  return { read: seen.size, named: namedN, uses: namedN - schema };
}

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

async function runOne(browser, w, shots, route, scripts) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, pools: null, cash: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/portfolio`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector("[data-screen='portfolio'] .pools[data-pools='rows'] [data-pool='solana']", { timeout: READY_MS }).catch(() => {});
    await page.waitForTimeout(400);
    Object.assign(run, await f.evaluate(READ));
    if (w.isMobile) await f.evaluate(() => [...document.querySelectorAll(".pfm .pools")].find((e) => e.getClientRects().length)?.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(shots, `${w.name}-portfolio.png`) });
    if (scripts.read === null) Object.assign(scripts, await f.evaluate(SCRIPTS, RULES), { from: w.name });
    return run;
  } finally {
    await ctx.close();
  }
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), build = null, source }) {
  mkdirSync(shots, { recursive: true });
  const page = await pageReads().catch(() => null);
  const browser = await (build ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const runs = [];
    const scripts = { read: null, found: [] };
    const acct = account();
    for (const w of WIDTHS) {
      const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: acct });
      // the deployed run reads only the shell from the stand-in; APP_HOST and the helper as served
      const route = build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r));
      runs.push(await runOne(browser, w, shots, route, scripts));
    }
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, account: acct, page, scripts: { read: scripts.read ?? 0, found: scripts.found }, runs };
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
    let source = `live ${APP_HOST}, the stand-in shell signed in`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed in`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), build, source });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { verdict, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${verdict} (${rec.source}, Chrome ${rec.browser})`);
    process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
