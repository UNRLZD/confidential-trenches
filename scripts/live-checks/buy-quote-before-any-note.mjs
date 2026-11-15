#!/usr/bin/env node
// Live check of card buy-quote-before-any-note: a fresh account (no pool note, no Cash, so no proof queue open) gets a
// buy's price before any deposit. Headless Chromium opens SIGN_HOST top-level, the shell that frames APP_HOST, makes a
// new passkey account on a CDP virtual authenticator with PRF (Create; no words drawn), and from inside the APP_HOST
// frame posts pool.buy.dry with an amount on each chain, as the terminal's kit client does, reading each answer. It never
// presses Buy, Sell, Withdraw or Confirm, and signs nothing: a dry signs, writes and sends nothing
// (packages/signpage/src/pools.ts poolBuyDryKind, pool-buy-evm.ts evmBuyDry, near-buy.ts nearBuyDry).
//   Each chain's coins: the helper's own lists (GET /v1/market/lists?chain=<chain> on HELPER_HOST, trending then new),
//   asked in order until one answers with an out, or a refusal that is no coin's own (a venue the page cannot read,
//   quote_check_failed; a provider down; no quote of that coin: an answer with no out go on to the next coin).
//   PASS per chain only when the answer is ok with tap_max "0" (one tap spends nothing of a pool with no note), with_cash
//   absent or "0" (Max $0: no Cash), and `out` a decimal above 0 (You receive: the typed amount priced as the buy from
//   Cash would run). not_funded (or any refusal not a coin's own), or no out on every coin asked, FAILs: the page
//   priced no buy for a user with no pool note.
//   Every coin of a chain refused quote_check_failed or down: INCONCLUSIVE for that chain.
// Records hold public values only: the chain, the coin, the amount asked and the page's answer. Never a key or the words.
// After: sign
// Bundle: out a browser and a new account on the live SIGN_HOST
//   node scripts/live-checks/buy-quote-before-any-note.mjs [--sign <origin>] [--record <file>]
//   node scripts/live-checks/buy-quote-before-any-note.mjs --site <dir> ...   the same steps with SIGN_HOST's name served
//     from a build folder (packages/signpage/scripts/build-app.mjs --out <dir>; a path with no file its index.html, as
//     the host answers it), APP_HOST and HELPER_HOST live: the run of a commit before its deploy
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserLabel, launchBrowser } from "../browsers.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

const KEY = "buy-quote-before-any-note";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
/** What each chain's dry is asked for: the pool coin's decimal on Solana, Base and Robinhood; USDC on NEAR. */
export const ASKS = Object.freeze({ solana: "0.05", base: "0.002", robinhood: "0.002", near: "5" });
export const CHAINS = Object.freeze(Object.keys(ASKS));
/** The most coins of a chain asked before the chain is INCONCLUSIVE. */
export const COINS_MAX = 8;
const ANSWER_MS = 45_000;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const AGAIN = new Set(["quote_check_failed", "down", "busy", "timeout"]);

/** The coins of `chain` in the helper's lists (trending, then graduating, then new), each once, at most COINS_MAX; on
 *  Solana pump.fun's mints first (their names end in "pump"), whose venue the page reads (src/pools.ts readCoinVenue). */
export function coinsOf(answer, chain) {
  const l = answer?.lists ?? {};
  const all = [];
  for (const row of [...(l.trending_1h ?? []), ...(l.trending ?? []), ...(l.graduating ?? []), ...(l.new ?? [])]) {
    if (row?.chain !== chain || typeof row.token !== "string" || all.includes(row.token)) continue;
    all.push(row.token);
  }
  const first = chain === "solana" ? [...all.filter((t) => t.endsWith("pump")), ...all.filter((t) => !t.endsWith("pump"))] : all;
  return first.slice(0, COINS_MAX);
}

/** In the APP_HOST frame: one request to the shell (the kit's envelope, v 1, its id a fresh UUID as the page's API
 *  takes only: packages/signpage/src/api.ts envelope) and its answer, or { timeout }. */
const ASK_IN_FRAME = async ({ sign, ask, ms }) =>
  new Promise((done) => {
    const msg = { v: 1, id: crypto.randomUUID(), ...ask };
    const t = setTimeout(() => (removeEventListener("message", on), done({ ok: false, code: "timeout" })), ms);
    function on(e) {
      const d = e.data;
      if (e.origin !== sign || !d || d.v !== 1 || d.id !== msg.id || !("ok" in d)) return;
      clearTimeout(t);
      removeEventListener("message", on);
      done(d.ok ? { ok: true, result: d.result } : { ok: false, code: d.error?.code ?? "no code" });
    }
    addEventListener("message", on);
    window.parent.postMessage(msg, sign);
  });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".zkey": "application/octet-stream" };

/** One run on the live hosts: a new account, then each chain's dry over its coins. `site`: a build folder served at
 *  `sign`'s name in place of the host. */
export async function read(sign = SIGN, fetchFn = fetch, site = null) {
  const lists = {};
  for (const chain of CHAINS) {
    const res = await fetchFn(`${HELPER_HOST}/v1/market/lists?chain=${chain}`, { headers: { origin: APP } }).catch(() => null);
    lists[chain] = { status: res?.status ?? null, coins: res?.ok ? coinsOf(await res.json().catch(() => null), chain) : [] };
  }
  const browser = await launchBrowser("chromium");
  const rec = { sign, ...(site ? { source: `build ${path.basename(site)} at SIGN_HOST's name` } : {}), at: new Date().toISOString(), browser: browserLabel(browser), signedIn: false, lists, asks: [] };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (site) {
      await ctx.route(`${sign}/**`, (route) => {
        let file = path.join(site, decodeURIComponent(new URL(route.request().url()).pathname));
        let body;
        try {
          body = readFileSync(file);
        } catch {
          file = path.join(site, "index.html");
          body = readFileSync(file);
        }
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body });
      });
    }
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const appFrame = () => page.frames().find((f) => f.url().startsWith(APP));
    await page.goto(`${sign}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((a) => [...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(a)), APP, { timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const create = page.locator('[data-action="create"]');
    if (!(await create.isVisible().catch(() => false))) {
      const f = appFrame();
      const skip = f?.getByRole("button", { name: /^skip$/i }).first();
      if (skip && (await skip.isVisible().catch(() => false))) await skip.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      await f?.getByRole("button", { name: /^sign in$/i }).first().click({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await f?.getByRole("button", { name: /use passkey/i }).first().click({ timeout: 10_000 });
    }
    await create.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800); // past the page's 500 ms activation guard
    await create.click();
    await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-in", null, { timeout: 30_000 });
    rec.signedIn = true;
    await page.waitForTimeout(3_000);
    for (const chain of CHAINS) {
      for (const token of lists[chain].coins) {
        const ask = { type: "pool.buy.dry", chain, token, amount: ASKS[chain] };
        let a = { ok: false, code: "no frame" };
        // a busy or down answer is asked again once, as the box asks again (the app's coinTapAgainMs)
        for (let i = 0; i < 2; i++) {
          const f = appFrame();
          a = f ? await f.evaluate(ASK_IN_FRAME, { sign, ask, ms: ANSWER_MS }).catch((e) => ({ ok: false, code: `evaluate: ${String(e?.message ?? e).slice(0, 80)}` })) : a;
          if (a.ok || (a.code !== "busy" && a.code !== "down")) break;
          await page.waitForTimeout(3_000);
        }
        // `coin`, not `token`: a record field named token holding a mint reads to a secret scan as a key
        rec.asks.push({ chain, coin: token, amount: ASKS[chain], ...a });
        // the next coin only for this coin's own reads: its venue not read, a provider down, or no quote of it (no out)
        if (a.ok ? typeof a.result?.out === "string" : !AGAIN.has(a.code)) break;
      }
    }
  } finally {
    await browser.close();
  }
  return rec;
}

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** The verdict on one run (read's record): { ok, quiet, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  say(run?.signedIn === true, `a new account signed in on ${show(run?.sign)}`);
  for (const chain of CHAINS) {
    const tag = `[${chain}]`;
    const asks = (run?.asks ?? []).filter((a) => a.chain === chain);
    if ((run?.lists?.[chain]?.coins ?? []).length === 0) {
      quiet = true;
      lines.push(`no-answer ${tag} the helper's lists gave no coin (status ${show(run?.lists?.[chain]?.status)})`);
      continue;
    }
    if (asks.length === 0) {
      say(false, `${tag} no dry asked`);
      continue;
    }
    // a refusal that is no coin's own read (not_funded, failed, not_allowed) FAILs at once
    const refused = asks.find((a) => !a.ok && !AGAIN.has(a.code));
    if (refused) {
      say(false, `${tag} ${refused.coin} answered ${show(refused.code)}: no price for a buy with no pool note`);
      continue;
    }
    // the coin judged: the first whose answer gives an out, else the last answer (no out on any coin FAILs below)
    const last = asks.find((a) => a.ok && typeof a.result?.out === "string") ?? asks.filter((a) => a.ok).at(-1);
    if (last === undefined) {
      quiet = true;
      lines.push(`no-answer ${tag} every coin asked answered ${asks.map((a) => a.code).join(", ")}`);
      continue;
    }
    const r = last.result ?? {};
    say(r.tap_max === "0", `${tag} ${last.coin} tap_max ${show(r.tap_max)}, "0" with no pool note`);
    say(r.with_cash === undefined || r.with_cash === "0", `${tag} with_cash ${show(r.with_cash)}: Max $0 with no Cash`);
    say(typeof r.out === "string" && DECIMAL.test(r.out) && /[1-9]/.test(r.out), `${tag} out ${show(r.out)} for ${last.amount}: You receive priced as the buy from Cash`);
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: !bad && !quiet, quiet, verdict: verdictOf(bad, quiet), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--sign", SIGN), fetch, opt("--site", null));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.sign})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(EXIT.ERROR);
  }
}
