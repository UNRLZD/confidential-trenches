#!/usr/bin/env node
// Live check of card buy-box-quotes-before-funds: a fresh account with $0 opens a token's page, types an amount in the
// buy box, and the box says why Buy is off: its Max line reads Max $0 (the box's model.ts poolMax: Bal $0 is a Max of $0,
// as the page lists a fresh account's pools with no ready and no tap_max), the amount is marked over it, and Buy is off.
// Headless Chromium (scripts/browsers.mjs, sandbox on) opens SIGN_HOST top-level with a CDP virtual authenticator (PRF),
// signs up with a throwaway passkey (Create passkey, as wallet-passkey-prf does), then opens the Solana and Base token
// pages SIGN_HOST frames APP_HOST on, types 5 in the amount and reads the box for 15 s. It never presses Buy, Sell,
// Withdraw or Confirm: the account is new and holds nothing, and the seed stays in the browser's temporary profile,
// deleted on close. The answer keeps the box's texts only.
//   --app-dir <dir>: APP_HOST's requests answered from a local build (pnpm --filter terminal build's dist), SIGN_HOST
//   live: how the good answer was recorded before the deploy. Its CSP is not the host's (the build serves no headers).
// After: app
// Bundle: out a browser and a fresh account on the live hosts
//   node scripts/live-checks/buy-box-quotes-before-funds.mjs [--record <file>] [--answer <file>] [--app-dir <dir>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "buy-box-quotes-before-funds";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** A coin of each pool chain whose page the box draws on: mihao (routes.ts OPEN_TOKEN) and xdp (the helper's Base list, 15 Nov). */
export const TOKENS = Object.freeze({ solana: "4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump", base: "0x07b3d902783c3c12b077508c3b5c00113d1291d0" });
const WATCH_MS = 15_000;

/** The verdict on an answer { chains: { <chain>: { balance, max, bad, ctaOff, maxMs, receive } } }. */
export function judge(a) {
  const lines = [];
  for (const chain of Object.keys(TOKENS)) {
    const c = a?.chains?.[chain];
    if (!c) {
      lines.push(`BAD ${chain}: the box was not read`);
      continue;
    }
    if (c.balance !== "$0 available") lines.push(`BAD ${chain}: Bal reads ${JSON.stringify(c.balance)}, not a fresh account's "$0 available"`);
    if (c.max !== "Max $0") lines.push(`BAD ${chain}: the line above Buy reads ${JSON.stringify(c.max)}, want "Max $0"`);
    if (c.bad !== "true") lines.push(`BAD ${chain}: the amount 5 is not marked over Max`);
    if (c.ctaOff !== true) lines.push(`BAD ${chain}: Buy is not off`);
  }
  return { ok: lines.length === 0, lines };
}

/** The box's texts as the page draws them. */
const BOX = () => {
  const t = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  const cta = document.querySelector('[data-testid="trade-cta"]');
  return { balance: t("trade-balance"), max: t("trade-max"), receive: t("trade-receive"), bad: document.querySelector(".trb-amount")?.getAttribute("data-bad") ?? null, ctaOff: cta ? cta.disabled : null };
};

/** APP_HOST answered from `dir` (a path with no file: its index.html, as the host serves the app). */
async function routeApp(ctx, dir) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm" };
  await ctx.route(`${APP}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    let file = path.join(dir, p);
    if (!file.startsWith(dir)) return route.abort();
    let body;
    try {
      body = readFileSync(file);
    } catch {
      file = path.join(dir, "index.html");
      body = readFileSync(file);
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body });
  });
}

export async function read({ appDir = null } = {}) {
  const { launchBrowser, browserLabel } = await import("../browsers.mjs");
  const browser = await launchBrowser("chromium");
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (appDir) await routeApp(ctx, path.resolve(appDir));
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const app = () => page.frames().find((f) => f.url().startsWith(APP));
    // sign up: the terminal's Sign in, then Use passkey opens SIGN_HOST's layer, whose Create passkey makes the account
    await page.goto(`${SIGN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((a) => [...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(a)), APP, { timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const create = page.locator('[data-action="create"]');
    if (!(await create.isVisible().catch(() => false))) {
      const f = app();
      const skip = f?.getByRole("button", { name: /^skip$/i }).first();
      if (skip && (await skip.isVisible().catch(() => false))) await skip.click({ timeout: 5_000 }).catch(() => {});
      await f.getByRole("button", { name: /^sign in$/i }).first().click({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await f.getByRole("button", { name: /use passkey/i }).first().click({ timeout: 10_000 });
    }
    await create.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800); // past the activation guard (500 ms)
    await create.click();
    await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-in", null, { timeout: 30_000 });
    const chains = {};
    for (const [chain, token] of Object.entries(TOKENS)) {
      await page.goto(`${SIGN}/token/${chain}/${token}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const f = await (async () => {
        for (let i = 0; i < 100 && !app(); i++) await page.waitForTimeout(200);
        return app();
      })();
      const input = f.locator("input.trb-input").first();
      await input.waitFor({ state: "visible", timeout: 30_000 });
      // the box's Bal is read (the state's first answer) before the amount goes in
      await f.waitForFunction(() => /\$/.test(document.querySelector('[data-testid="trade-balance"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
      await input.click();
      await page.keyboard.type("5");
      const at = Date.now();
      let box = await f.evaluate(BOX);
      let maxMs = null;
      while (Date.now() - at < WATCH_MS) {
        box = await f.evaluate(BOX);
        if (maxMs === null && box.max) maxMs = Date.now() - at;
        if (maxMs !== null && Date.now() - at > 3_000) break;
        await page.waitForTimeout(100);
      }
      chains[chain] = { ...box, maxMs };
    }
    return { at: new Date().toISOString(), browser: browserLabel(browser), appDir: appDir ? "local build" : null, chains };
  } finally {
    await browser.close();
  }
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read({ appDir: arg("--app-dir") ?? null });
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
