#!/usr/bin/env node
// Live check of card deposit-sheet-reads-right-on-phone: a fresh account with $0, at 400 x 860 (phone, touch) and
// 1440 x 900 (desktop), on the live hosts. On a Solana token's page, 5 typed in the buy box makes its main button
// Deposit (card app-money-sheets-read-right); its tap opens the deposit sheet, and then:
//   - one sheet: on the phone the trade sheet the box sat in is closed (data-open false), and one grab bar is drawn, the
//     deposit sheet's (Portfolio's phone row sheet does the same: close, then act); on desktop no trade sheet is open
//     and at most one grab bar is drawn;
//   - Get address is off while the amount is empty (it was drawn on, green, in S4.3 with no amount, and its tap did
//     nothing).
// Headless Chromium (scripts/browsers.mjs, sandbox on) opens SIGN_HOST top-level with a CDP virtual authenticator (PRF),
// signs up with a throwaway passkey (Create passkey), then opens the token page of the first pump.fun coin in the
// helper's Solana lists. It never presses Buy, Get address or a backup: the account is new and holds nothing, and the
// seed stays in the browser's temporary profile, deleted on close. The answer keeps the screens' states only.
//   --app-dir <dir>: APP_HOST's requests answered from a local build (pnpm --filter terminal build's dist): how the good
//   answer is recorded before a deploy. --shots <dir>: a screenshot per step and width.
// After: app
// Bundle: out a browser and a fresh account on the live hosts
//   node scripts/live-checks/deposit-sheet-reads-right-on-phone.mjs [--record <file>] [--answer <file>] [--app-dir <dir>] [--shots <dir>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "deposit-sheet-reads-right-on-phone";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const WIDTHS = Object.freeze(["phone", "desktop"]);
const VIEW = {
  phone: { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

/** The coin read: the first pump.fun mint of the helper's Solana lists (trending, then graduating, then new). */
export function coinOf(answer) {
  const l = answer?.lists ?? {};
  for (const row of [...(l.trending_1h ?? []), ...(l.trending ?? []), ...(l.graduating ?? []), ...(l.new ?? [])]) if (row?.chain === "solana" && typeof row.token === "string" && row.token.endsWith("pump")) return row.token;
  return null;
}

/** The verdict on an answer { widths: { <width>: read } }: { ok, lines }. */
export function judge(a) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  for (const w of WIDTHS) {
    const r = a?.widths?.[w];
    if (!r) {
      say(false, `${w}: not read`);
      continue;
    }
    say(r.cta?.text === "Deposit" && r.cta.disabled === false, `${w}: 5 typed on $0, the main button reads ${JSON.stringify(r.cta?.text ?? null)}${r.cta?.disabled ? ", off" : ""}, want Deposit, on`);
    say(r.depositOpen === true, `${w}: its tap ${r.depositOpen ? "opens" : "does not open"} the deposit sheet`);
    if (!r.depositOpen) continue;
    say(r.tradeOpen !== true, `${w}: the trade sheet ${r.tradeOpen ? "is still open under" : "is closed with"} the deposit sheet (one sheet)`);
    say(typeof r.grabs === "number" && (w === "phone" ? r.grabs === 1 : r.grabs <= 1), `${w}: ${r.grabs ?? "no"} grab bars drawn, want ${w === "phone" ? "1" : "at most 1"}`);
    say(r.get?.amount === "" && r.get.disabled === true, `${w}: with the amount ${JSON.stringify(r.get?.amount ?? null)}, Get address ${r.get ? (r.get.disabled ? "off" : "on") : "not drawn"}, want off until an amount is typed`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

/** `host`'s requests answered from `dir` (a path with no file: its index.html, as the host answers it). */
async function routeDir(ctx, host, dir) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm" };
  await ctx.route(`${host}/**`, (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname);
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

/** The sheets as drawn, in APP_HOST's frame: the trade sheet's open, the grab bars a person sees, Get address. */
const SHEETS = () => {
  const seen = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility === "visible";
  const trade = document.querySelector('[data-sheet="trade"]');
  const get = document.querySelector('[data-sheet="deposit"] [data-control="deposit-get"]');
  return {
    depositOpen: document.querySelector('[data-sheet="deposit"]') !== null,
    tradeOpen: trade ? trade.getAttribute("data-open") === "true" : null,
    grabs: [...document.querySelectorAll(".grab, .tsh-grab")].filter(seen).length,
    get: get ? { amount: document.querySelector('[data-sheet="deposit"] [data-field="amount"]')?.value ?? null, disabled: get.disabled } : null,
  };
};

async function readWidth(browser, w, appDir, coin, shots) {
  const ctx = await browser.newContext({ ...VIEW[w], reducedMotion: "reduce" });
  const out = { width: w };
  const shot = (page, step) => (shots ? page.screenshot({ path: path.join(shots, `${w}-${step}.png`) }).catch(() => {}) : null);
  try {
    if (appDir) await routeDir(ctx, APP, path.resolve(appDir));
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const app = () => page.frames().find((f) => f.url().startsWith(APP));
    const press = (loc) => (VIEW[w].hasTouch ? loc.tap({ timeout: 10_000 }) : loc.click({ timeout: 10_000 }));
    // sign up: the terminal's Sign in, then Use passkey opens SIGN_HOST's layer, whose Create passkey makes the account
    await page.goto(`${SIGN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((a) => [...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(a)), APP, { timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const create = page.locator('[data-action="create"]');
    if (!(await create.isVisible().catch(() => false))) {
      const f = app();
      const skip = f?.getByRole("button", { name: /^skip$/i }).first();
      if (skip && (await skip.isVisible().catch(() => false))) await press(skip).catch(() => {});
      await page.waitForTimeout(1_000);
      await press(f.getByRole("button", { name: /^sign in$/i }).filter({ visible: true }).first());
      await page.waitForTimeout(800);
      await press(f.getByRole("button", { name: /use passkey/i }).filter({ visible: true }).first());
    }
    await create.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800); // past the activation guard (500 ms)
    await press(create);
    await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-in", null, { timeout: 30_000 });

    // the token page: on the phone the bar's Buy opens the box's sheet
    await page.goto(`${SIGN}/token/solana/${coin}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (let i = 0; i < 100 && !app(); i++) await page.waitForTimeout(200);
    const f = app();
    if (w === "phone") {
      const buy = f.locator(".tkp-buy").first();
      await buy.waitFor({ state: "visible", timeout: 30_000 });
      await press(buy);
    }
    const input = f.locator("input.trb-input").filter({ visible: true }).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await f.waitForFunction(() => /\$/.test([...document.querySelectorAll('[data-testid="trade-balance"]')].find((e) => e.offsetParent)?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
    await press(input);
    await page.keyboard.type("5");
    await page.waitForTimeout(3_000);
    const cta = f.locator('[data-testid="trade-cta"]').filter({ visible: true }).first();
    out.cta = await cta.evaluate((c) => ({ text: c.textContent.replace(/\s+/g, " ").trim(), disabled: c.disabled })).catch(() => null);
    await shot(page, "1-typed");
    if (out.cta?.text !== "Deposit" || out.cta.disabled) return out;
    await press(cta).catch(() => {});
    await f.waitForSelector('[data-sheet="deposit"]', { timeout: 5_000 }).catch(() => {});
    // the sheet filled (its asset picker drawn), then read as a person sees it
    await f.waitForSelector('[data-sheet="deposit"] select[data-control="deposit-asset"]', { timeout: 19_000 }).catch(() => {});
    await page.waitForTimeout(500);
    Object.assign(out, await f.evaluate(SHEETS));
    await shot(page, "2-deposit");
    return out;
  } finally {
    await ctx.close();
  }
}

export async function read({ appDir = null, shots = null, fetchFn = fetch } = {}) {
  const res = await fetchFn(`${HELPER_HOST}/v1/market/lists?chain=solana`, { headers: { origin: APP } }).catch(() => null);
  const coin = res?.ok ? coinOf(await res.json().catch(() => null)) : null;
  if (!coin) throw new Error("no pump.fun coin in the helper's Solana lists");
  if (shots) mkdirSync(shots, { recursive: true });
  const { launchBrowser, browserLabel } = await import("../browsers.mjs");
  const browser = await launchBrowser("chromium");
  try {
    const widths = {};
    for (const w of WIDTHS) widths[w] = await readWidth(browser, w, appDir, coin, shots);
    return { at: new Date().toISOString(), browser: browserLabel(browser), app: appDir ? "local build" : "APP_HOST", widths };
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
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read({ appDir: arg("--app-dir") ?? null, shots: arg("--shots") ?? null });
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.ok ? "PASS" : "FAIL"} ${KEY} (${answer.app ?? "?"})`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
