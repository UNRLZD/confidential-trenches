#!/usr/bin/env node
// Live check of card near-quote-blackdragon: a NEAR buy's dry tells a provider's fault from a coin with no quote. Release
// 165's sign run 43832638554 asked a fresh account's NEAR dry (pool.buy.dry, 5 USDC) of blackdragon.tkn.near and got
// tap_max alone, no out, though the coin quotes from its Rhea pools: the page read any failed read as the coin's "no out"
// (packages/signpage/src/near-buy.ts nearBuyDry), so the box drew You receive as a dash and never asked again. Now a
// read that failed is "down" (asked again: the app's coinTapAgainMs), and no out only for the chain's own refusal.
// Headless Chromium opens SIGN_HOST top-level, makes a new passkey account (CDP virtual authenticator with PRF, as
// buy-quote-before-any-note.mjs does), and from the APP_HOST frame asks the dry of COIN twice: as the providers answer,
// then with the page's own dRPC reads (near.drpc.org, the page's second NEAR provider) answered HTTP 429 by the browser.
// It never presses Buy, Sell, Withdraw or Confirm, and signs nothing.
//   PASS: the first answer ok with `out` a decimal above 0, and the second the refusal "down".
//   FAIL: the second answer ok (a fault read as the coin's answer), or the first ok with no out (a coin that quotes
//   priced at none), or any other refusal.
//   INCONCLUSIVE: the first answer "down" or "busy" (the providers' own moment: the page could not read the coin).
// Records hold public values only: the coin, the amount and the page's answers.
// After: sign
// Bundle: out a browser, a new account and the live NEAR providers on SIGN_HOST
//   node scripts/live-checks/near-quote-blackdragon.mjs [--sign <origin>] [--site <dir>] [--record <file>]
//   --site serves a build folder (packages/signpage/scripts/build-app.mjs --out <dir>) at SIGN_HOST's name, as
//   buy-quote-before-any-note.mjs does: the run of a commit before its deploy.
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserLabel, launchBrowser } from "../browsers.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";
import { SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";

const KEY = "near-quote-blackdragon";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** The coin of the red run: Rhea classic pool 4276 (wNEAR) and others hold it. */
export const COIN = "blackdragon.tkn.near";
export const AMOUNT = "5";
const ANSWER_MS = 45_000;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const HELLO = { v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION };

/** In the APP_HOST frame: one request to the shell (the kit's envelope, v 1, its id a fresh UUID as the page's API
 *  takes only: packages/signpage/src/api.ts envelope) and its answer, or { timeout }. */
const ASK_IN_FRAME = async ({ sign, hello, ask, ms }) =>
  new Promise((done) => {
    window.parent.postMessage(hello, sign);
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

/** One run: a new account, then the dry of COIN as the providers answer and with the page's dRPC answered 429. */
export async function read(sign = SIGN, site = null) {
  const browser = await launchBrowser("chromium");
  const rec = { sign, ...(site ? { source: `build ${path.basename(site)} at SIGN_HOST's name` } : {}), at: new Date().toISOString(), browser: browserLabel(browser), signedIn: false, coin: COIN, amount: AMOUNT, asks: [] };
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
    // the provider fault: the page's own dRPC reads answered 429 while `fault.on` (the coin asked a second time)
    const fault = { on: false };
    await ctx.route(/^https:\/\/near\.drpc\.org/, (route) =>
      fault.on && route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "access-control-allow-origin": "*", "content-type": "text/plain" }, body: "Too Many Requests" }) : route.fallback(),
    );
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
    const ask = { type: "pool.buy.dry", chain: "near", token: COIN, amount: AMOUNT };
    for (const as of ["providers", "drpc 429"]) {
      fault.on = as === "drpc 429";
      const f = appFrame();
      const a = f ? await f.evaluate(ASK_IN_FRAME, { sign, hello: HELLO, ask, ms: ANSWER_MS }).catch((e) => ({ ok: false, code: `evaluate: ${String(e?.message ?? e).slice(0, 80)}` })) : { ok: false, code: "no frame" };
      rec.asks.push({ as, ...a });
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
  const [first, second] = [run?.asks?.find((a) => a.as === "providers"), run?.asks?.find((a) => a.as === "drpc 429")];
  if (first === undefined || second === undefined) say(false, "both dries asked");
  else if (!first.ok && (first.code === "down" || first.code === "busy")) (quiet = true), lines.push(`no-answer ${run.coin} answered ${show(first.code)} as the providers answer: their moment`);
  else {
    const out = first.ok ? first.result?.out : undefined;
    say(typeof out === "string" && DECIMAL.test(out) && /[1-9]/.test(out), `${run.coin} out ${show(out)} for ${run.amount}${first.ok ? "" : ` (refused ${show(first.code)})`}: You receive as the providers answer`);
    say(!second.ok && second.code === "down", `${run.coin} with the page's dRPC answering 429: ${second.ok ? `ok ${show(second.result)}, a fault read as the coin's answer` : `refused ${show(second.code)}`}; a read that failed is "down", asked again`);
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: !bad && !quiet, quiet, verdict: verdictOf(bad, quiet), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--sign", SIGN), opt("--site", null));
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
