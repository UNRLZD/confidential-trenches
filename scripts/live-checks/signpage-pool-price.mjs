#!/usr/bin/env node
// Live check of card signpage-pool-price: the trade box prices a pool buy from the signing page's own price read, so its
// Buy turns on, and only while that read is fresh. Two parts:
//   1. The page's read: the kit's poolUsdPrice (through the kit's public entry) for Solana on the signing page's own
//      pair for it, SIGN_HOST's provider A and the helper's keyed route (packages/signpage/src/trade.ts SOLANA_PROVIDER_A
//      and TRADE_HELPER, the pair main.ts gives the pool kinds and src/pool-price.ts), as SIGN_HOST's CSP allows both. It
//      passes only with two hosts of two providers agreeing on Pyth's SOL/USD account and a price within the kit's bound
//      (POOL_USD_FEEDS.solana, poolUsdGoodUntilS), and
//      with SIGN_HOST's served connect-src naming both origins, so the page itself can make that read; and SIGN_HOST's
//      served /app.js has the sha384 of this checkout's signing page bundle (packages/signpage/public/app.js, hashed as
//      app-release-sri hashes a served script), so the deployed page carries src/pool-price.ts. On an app deploy
//      (--host app, as signpage-release) that line is not judged: SIGN_HOST may lag, and its own deploy runs this check.
//      The page's own price in state on the real page is proven once pinned pools land on SIGN_HOST (a later card);
//      until then, by the signing page's unit tests (packages/signpage/test/pool-price.test.ts).
//   2. The terminal: APP_HOST's terminal, framed by a stand-in for SIGN_HOST's shell (app-in-shell.mjs) that sends a
//      signed-in state holding the devnet Solana pool with its proof ready (trade-box-pool.mjs POOL.ready) and, as
//      src/pool-price.ts puts it in state.pools[solana].price, the price part 1 read: fresh (as read), stale (the same
//      price published 30 s past the kit's bound) and none (no price). Headless Chromium opens a Solana token's own page,
//      /token/solana/<DJT> (app-sell-mount's PATH; never /, which draws the live Trending column's top, a token of any chain,
//      on the deployed app), and reads the token and chain it drew, at 1440 x 900 and 390 x 844 (dpr 2, the bar's Buy opens
//      the trade sheet), types $0.05 and taps Buy. Part 1 reads on the page's own schedule (pool-usd-price-never-stale.mjs
//      follow, card pool-usd-price-never-stale) for as long as the runs take, and each run sends the price the page
//      holds at its start, so a fresh run ends inside the bound (a price at most 58 s old at a write, the bound 75 s):
//        - fresh: Bal shows USD, Buy is on, and the one tap asks the shell for exactly one pool.buy of $0.05 in SOL at
//          that price, rounded down (5 x 10^15 / price lamports at exponent -8), never the vault's buy;
//        - aged (card pool-usd-price-never-stale, review P2-5): the same price published AGED_S (62) s before the run,
//          past the 60 s bound the app held before that card and inside its 75 s: as fresh. An app on the 60 s bound
//          fails it, so a run proves the deployed app holds 75 s. Deploy order: APP_HOST first, then SIGN_HOST: with
//          youngRead gone a fresh run sends a held price up to about 58 s old, which an app still on 60 s drops mid-run;
//        - stale and none: Bal shows no USD, Buy is off, and the tap asks for nothing.
// Node reads the served / first and records the build's entry script, so a run names the build it judged.
// After: app --host app
// After: sign
//   node scripts/live-checks/signpage-pool-price.mjs [--host sign|app] [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/signpage-pool-price.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POOL_USD_FEEDS, poolUsdPrice, SOLANA_RPC_RETRY, solanaHelperRpc, solanaJsonRpc, solanaSameProvider } from "../../packages/kit/src/index.ts";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute } from "./app-in-shell.mjs";
import { MINT, PATH } from "./app-sell-mount.mjs";
import { POOL } from "./trade-box-pool.mjs";
import { follow } from "./pool-usd-price-never-stale.mjs";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "signpage-pool-price";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const SIGN_HOST = "https://confidential.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The signing page's Solana pair (packages/signpage/src/trade.ts): its provider A and the helper's keyed route. */
export const PAGE_PAIR = ["https://solana-rpc.publicnode.com", `${HELPER_HOST}/v1/rpc/solana`];
export const PRICES = ["fresh", "aged", "stale", "none"];
/** The aged run's price age as it starts (card pool-usd-price-never-stale, review P2-5): past the 60 s bound the app held
 *  before that card and inside the 75 s it holds since, with 13 s for the run, so an app still on 60 s fails it. */
export const AGED_S = 62;
/** The amount typed: $0.05, under the devnet pool's one-tap most (0.00173608 SOL) at any SOL price over $28.80. */
export const TYPED = "0.05";
const CENTS = 5n;
/** The chain of the token the check opens (app-sell-mount's PATH is /token/solana/<MINT>). */
export const CHAIN = "solana";
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READY_MS = 20_000;
const sha384 = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
/** This checkout's signing page bundle, as build-app.mjs writes it. */
/** This tree's bundle, built from its sources at the read (card signpage-generated-merge-free). */
const treeBundlePath = () => path.join(signBuilt(), "public/app.js");
const MAX_AGE_S = POOL_USD_FEEDS.solana.maxAgeS;

/** The pool entry the stand-in sends for `which`, from the page's read `p`, at the run's clock `nowMs`. */
export function poolWith(which, p, nowMs) {
  if (which === "none") return POOL.ready;
  if (which === "aged") return { ...POOL.ready, price: { price: p.price, expo: p.expo, published_s: Math.floor(nowMs / 1000) - AGED_S, read_ms: nowMs } };
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
  const src = (/(?:^|;)\s*connect-src\s+([^;]*)/.exec(rec.signCsp ?? "")?.[1] ?? "").split(/\s+/);
  const reach = PAGE_PAIR.map((u) => new URL(u).origin).filter((o) => !src.includes(o));
  say(src.length > 1 && reach.length === 0, `SIGN_HOST's connect-src names both: ${reach.length ? `not ${reach.join(", ")}` : PAGE_PAIR.map((u) => new URL(u).origin).join(" and ")}`);
  const b = rec.signBundle ?? {};
  if (rec.host === "app") say(true, "SIGN_HOST's /app.js: not judged on an app deploy (SIGN_HOST's own deploy runs this check with it)");
  else say(b.status === 200 && typeof rec.treeBundle === "string" && b.sha384 === rec.treeBundle, `SIGN_HOST's /app.js is this checkout's signing page bundle: ${b.status !== 200 ? `HTTP ${b.status ?? "none"}` : b.sha384 === rec.treeBundle ? b.sha384 : `served ${b.sha384}, the checkout's ${rec.treeBundle}`}`);
  say(typeof rec.entry === "string" && /^\/assets\/[\w.-]+\.js$/.test(rec.entry), `the served / names its entry script ${rec.entry ?? "none"}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => PRICES.map((p) => `${w.name} ${p}`));
  const have = new Set(runs.map((x) => `${x.width} ${x.price}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (desktop and phone; a fresh, an aged ${AGED_S} s, a stale and no price)`);
  for (const x of runs) {
    // the price this run sent: the page's held price at its start (card pool-usd-price-never-stale), or, in a record
    // before it, the one read
    const rp = x.read ?? r;
    const sol = priced && typeof rp.price === "string" && /^[1-9]\d*$/.test(rp.price) ? expectedSol(rp) : null;
    const n = `${x.width} ${x.price}`;
    const bad = [];
    if (x.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (x.route !== "token") bad.push(`drew ${x.route ?? "nothing"}, not the token route`);
    else if (x.mint !== MINT || x.chain !== CHAIN) bad.push(`the token page drew ${x.mint ?? "no token"} on ${x.chain ?? "no chain"}, not the Solana token ${MINT} on ${CHAIN}`);
    if (!x.box) bad.push("no trade box");
    else {
      if (x.box.path !== "pool") bad.push(`the box is on the ${x.box.path ?? "unmarked"} path, not the pool's`);
      const usd = typeof x.box.bal === "string" && /\$\s?\d/.test(x.box.bal);
      const asked = x.asked ?? null;
      if (asked === null) bad.push("the tap was not read");
      if (x.price === "fresh" || x.price === "aged") {
        if (!usd) bad.push(`Bal shows ${x.box.bal ?? "nothing"}, not USD`);
        if (x.box.ctaOn !== true) bad.push(`Buy is off with ${x.price === "aged" ? `a price ${AGED_S} s old (inside the kit's ${MAX_AGE_S} s)` : "a fresh price"}`);
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
    say(bad.length === 0, `${n}: ${bad.length ? bad.join("; ") : x.price === "fresh" || x.price === "aged" ? `Bal ${x.box.bal}, Buy on, one pool.buy of ${sol} SOL` : `Bal ${x.box.bal}, Buy off, nothing asked`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** Part 1, on the page's own schedule (pool-usd-price-never-stale.mjs follow): the feed followed on the page's own pair
 *  until stopped. `first()` waits up to firstMs for its first price (or answers the last read's error); `now()` is the
 *  price it holds, as src/pool-price.ts would put it in state.pools[solana].price. A run sends the price held at its own
 *  start, never one read before the runs began: a single read went stale between the desktop and the phone run (10 Nov,
 *  phone fresh read `Bal —`). */
export function pageFeed({ read = poolUsdPrice, firstMs = 30_000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const rpcs = [solanaJsonRpc(PAGE_PAIR[0], { retry: SOLANA_RPC_RETRY }), solanaHelperRpc(HELPER_HOST, { retry: SOLANA_RPC_RETRY })];
  const base = { rpcs: PAGE_PAIR };
  if (solanaSameProvider(rpcs[0], rpcs[1])) return { first: async () => ({ ...base, error: "one provider twice" }), now: () => null, stop: async () => {} };
  let held = null;
  let done = false;
  let lastError;
  const shape = (p) => ({ ...base, price: p.price, expo: p.expo, published_s: p.publishedS, read_ms: p.readMs });
  const reading = (a) =>
    read(a).catch((e) => {
      lastError = String(e?.message ?? e);
      throw e;
    });
  const run = follow({ read: () => reading({ chain: "solana", rpcs }), now, sleep, untilMs: now() + 15 * 60_000, stop: () => done, onHold: (p) => void (held = p) });
  return {
    async first() {
      for (const until = now() + firstMs; held === null && lastError === undefined && now() < until; ) await sleep(250);
      return held ? shape(held) : { ...base, error: lastError ?? "no price read" };
    },
    now: () => (held ? shape(held) : null),
    async stop() {
      done = true;
      await run;
    },
  };
}

const READ = (sheet) => {
  const main = document.querySelector("main[data-route]");
  const scope = sheet ? document.querySelector('[data-sheet="trade"]') : main?.querySelector(".tkp-desk .tkp-trade");
  const el = scope?.querySelector('[data-testid="trade-box"]');
  const cta = el?.querySelector('[data-testid="trade-cta"]');
  return {
    route: main?.dataset.route ?? null,
    mint: main?.querySelector("section.tkp[data-token]")?.getAttribute("data-token") ?? null,
    chain: main?.querySelector("section.tkp[data-token] .tkp-head .tok-cb[data-chain]")?.getAttribute("data-chain") ?? null,
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
  const run = { width: w.name, price, framed: false, route: null, mint: null, chain: null, box: null, asked: null, shot: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}${PATH}`, { waitUntil: "load" });
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

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), build = null, source, host = "sign" }) {
  mkdirSync(shots, { recursive: true });
  const feed = pageFeed();
  const read = await feed.first();
  const at = new Date().toISOString();
  const entry = await entryOf(build);
  // SIGN_HOST's own policy as served: the page's pair must be in its connect-src
  const signCsp = (await fetch(`${SIGN_HOST}/`, { signal: AbortSignal.timeout(15_000) })).headers.get("content-security-policy");
  // SIGN_HOST's bundle as served (the harness: this checkout's, served as SIGN_HOST's), against this checkout's
  const treeBundle = sha384(readFileSync(treeBundlePath()));
  let signBundle;
  if (build) signBundle = { status: 200, sha384: treeBundle };
  else {
    const res = await fetch(`${SIGN_HOST}/app.js`, { signal: AbortSignal.timeout(15_000) });
    signBundle = { status: res.status, sha384: sha384(new Uint8Array(await res.arrayBuffer())) };
  }
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const price of PRICES) {
      for (const w of WIDTHS) {
        // the price the page holds as this run starts; with none read, the fresh run has none to send: it is judged BAD on
        // the read's own lines
        const p = feed.now() ?? { price: "1", expo: -8, published_s: 0, read_ms: 0 };
        const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: account(poolWith(price, p, Date.now())) });
        const route = build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r));
        const run = await runOne(browser, w, price, shots, route);
        if ((price === "fresh" || price === "aged") && p.price !== "1") run.read = { price: p.price, expo: p.expo, published_s: p.published_s };
        runs.push(run);
      }
    }
    return { check: KEY, at, source, host, browser: browser.version(), read, signCsp, treeBundle, signBundle, entry, shots, runs };
  } finally {
    await feed.stop();
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
    const host = opt("--host", "sign");
    if (host !== "sign" && host !== "app") throw new Error("--host: sign or app");
    const rec = await collect({ shots: opt("--shots", undefined), build, source, host });
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
