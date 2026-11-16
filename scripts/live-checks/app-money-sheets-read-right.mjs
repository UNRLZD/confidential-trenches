#!/usr/bin/env node
// Live check of card app-money-sheets-read-right (the QA walk of the live app, 16 Nov 18:00Z, items 7, 11, 12 and 13): a
// fresh account with $0, at 390 x 844 (phone, touch) and 1440 x 900 (desktop), on the live hosts:
//   - item 7: on a Solana token's page, 5 typed in the buy box turns its main button into Deposit, on, and its tap opens
//     the deposit sheet;
//   - item 11: the box asked the deposit sheet's asset list as Deposit showed, before its tap (deposit/source.tsx
//     useDepositIntent; the kit's deposit.assets, seen posted to SIGN_HOST's page), so the sheet opens on most of the
//     read; Asset and Chain fill (the asset picker drawn, no skeleton) within FILL_MAX_MS of the tap. The time from tap
//     to fill is kept in the answer (the build before: read on the header's Deposit, cold);
//   - item 13: the deposit's Min draws at most 2 decimals for USDC, and never under the minimum the sheet holds (its
//     data-min);
//   - item 12: the Withdraw segment labels its places row From, draws no deposit risk line, and its Max line's number
//     (Max 0 USDC) is in the line's own tone, not lifted.
// Headless Chromium (scripts/browsers.mjs, sandbox on) opens SIGN_HOST top-level with a CDP virtual authenticator (PRF),
// signs up with a throwaway passkey (Create passkey, as buy-box-quotes-before-funds does), then opens a Solana token
// page SIGN_HOST frames APP_HOST on: the first pump.fun coin in the helper's lists. It never presses Buy, Get address or
// Withdraw: the account is new and holds nothing, and the seed stays in the browser's temporary profile, deleted on
// close. The answer keeps the screens' texts and times (public values) only.
//   --app-dir <dir>: APP_HOST's requests answered from a local build (pnpm --filter terminal build's dist): how the good
//   answer is recorded before a deploy. --shots <dir>: a screenshot per step and width.
// After: app
// Bundle: out a browser and a fresh account on the live hosts
//   node scripts/live-checks/app-money-sheets-read-right.mjs [--record <file>] [--answer <file>] [--app-dir <dir>] [--shots <dir>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "app-money-sheets-read-right";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const WIDTHS = Object.freeze(["phone", "desktop"]);
const VIEW = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
/** The longest the sheet may take to fill after Deposit's tap: the signing page's own deadline for the asset list
 *  (packages/signpage/src/deposit-wire.ts DEPOSIT_READ_DEADLINE_MS, 14 s), so a slow 1Click is the read's own answer,
 *  never this check's. The measured time is kept in the answer. */
export const FILL_MAX_MS = 14_000;

/** The coin read: the first pump.fun mint of the helper's Solana lists (trending, then graduating, then new). */
export function coinOf(answer) {
  const l = answer?.lists ?? {};
  for (const row of [...(l.trending_1h ?? []), ...(l.trending ?? []), ...(l.graduating ?? []), ...(l.new ?? [])]) if (row?.chain === "solana" && typeof row.token === "string" && row.token.endsWith("pump")) return row.token;
  return null;
}

const TWO_DECIMALS = /^[0-9]+(\.[0-9]{1,2})?$/;
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
/** a < b for two non-negative decimal strings, exactly. */
function under(a, b) {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  const n = Math.max(af.length, bf.length);
  return BigInt(ai + af.padEnd(n, "0")) < BigInt(bi + bf.padEnd(n, "0"));
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
    const c = r.cta ?? {};
    say(r.balance === "$0 available", `${w}: the box's balance reads ${JSON.stringify(r.balance ?? null)}, a fresh account's "$0 available"`);
    say(c.text === "Deposit" && c.disabled === false, `${w}: 5 typed, the main button reads ${JSON.stringify(c.text ?? null)}${c.disabled ? ", off" : ""}, want Deposit, on (item 7)`);
    say(r.opened === true, `${w}: its tap ${r.opened ? "opens" : "does not open"} the deposit sheet`);
    say(typeof r.askedBeforeTap === "number" && r.askedBeforeTap > 0, `${w}: the box asked the deposit sheet's asset list ${typeof r.askedBeforeTap === "number" && r.askedBeforeTap > 0 ? `${r.askedBeforeTap} ms before Deposit's tap` : "only at the tap or not at all"} (item 11)`);
    if (!r.opened && !r.headerOpened) continue;
    say(typeof r.fillMs === "number" && r.fillMs <= FILL_MAX_MS, `${w}: Asset and Chain fill ${typeof r.fillMs === "number" ? `${r.fillMs} ms` : "never"} after the tap (item 11, at most ${FILL_MAX_MS} ms)`);
    const m = r.min ?? {};
    const minOk = m.symbol === "USDC" && TWO_DECIMALS.test(m.shown ?? "") && DECIMAL.test(m.real ?? "") && !under(m.shown, m.real);
    say(minOk, `${w}: the deposit's Min reads ${JSON.stringify(m.shown ?? null)} ${m.symbol ?? ""} for a minimum of ${JSON.stringify(m.real ?? null)}, want at most 2 decimals and never under it (item 13)`);
    const d = r.withdraw ?? {};
    say(d.fromLabel === "From", `${w}: Withdraw's places row is labelled ${JSON.stringify(d.fromLabel ?? null)}, want From (item 12)`);
    say(d.notice === false, `${w}: Withdraw ${d.notice === false ? "draws no" : "draws the"} deposit risk line (item 12)`);
    say(d.max?.text === "Max 0 USDC" && d.max.lifted === false, `${w}: Withdraw's Max line ${JSON.stringify(d.max ?? null)}, want Max 0 USDC with the 0 in the line's own tone (item 12)`);
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

/** On SIGN_HOST's top page: when APP_HOST asked deposit.assets (the kit's request, posted to it). */
const WATCH = ({ app, sign }) => {
  window.__assets = [];
  addEventListener(
    "message",
    (e) => {
      if (location.origin === sign && e.origin === app && e.data?.v === 1 && e.data?.type === "deposit.assets") window.__assets.push(Date.now());
    },
    true,
  );
};

/** The Withdraw segment as drawn. */
const WITHDRAW = () => {
  const f = document.querySelector('[data-sheet="deposit"] [data-form="withdraw"]');
  const b = document.querySelector('[data-control="withdraw-max"]');
  const n = b?.querySelector(".num");
  return {
    fromLabel: f ? (document.getElementById(f.querySelector("[data-places]")?.getAttribute("aria-labelledby") ?? "")?.textContent ?? null) : null,
    notice: document.querySelector('[data-sheet="deposit"] [data-control="deposit-notice"]') !== null,
    max: b && n ? { text: b.textContent.replace(/\s+/g, " ").trim(), lifted: getComputedStyle(n).color !== getComputedStyle(b).color } : null,
  };
};

async function readWidth(browser, w, appDir, coin, shots) {
  const ctx = await browser.newContext({ ...VIEW[w], reducedMotion: "reduce" });
  const out = { width: w };
  const shot = (page, step) => (shots ? page.screenshot({ path: path.join(shots, `${w}-${step}.png`) }).catch(() => {}) : null);
  try {
    if (appDir) await routeDir(ctx, APP, path.resolve(appDir));
    await ctx.addInitScript(WATCH, { app: APP, sign: SIGN });
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
    // the box settles on its answer for the amount: a quote, or none, in the few seconds a person reads it
    await page.waitForTimeout(3_000);
    const cta = f.locator('[data-testid="trade-cta"]').filter({ visible: true }).first();
    Object.assign(out, await f.evaluate(() => {
      const box = [...document.querySelectorAll('[data-testid="trade-box"]')].find((e) => e.offsetParent);
      const c = box?.querySelector('[data-testid="trade-cta"]');
      return { balance: box?.querySelector('[data-testid="trade-balance"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null, cta: c ? { text: c.textContent.replace(/\s+/g, " ").trim(), disabled: c.disabled } : null };
    }));
    await shot(page, "1-typed");
    let t0 = Date.now();
    let sheetFrame = f;
    if (out.cta?.text === "Deposit" && out.cta.disabled === false) {
      // how long before the tap the list was asked: the page's clock against this one, both this machine's
      const tap = await page.evaluate(() => Date.now());
      const asked = await page.evaluate(() => window.__assets ?? []);
      if (asked.length) out.askedBeforeTap = tap - asked[0];
      t0 = Date.now();
      await press(cta).catch(() => {});
      out.opened = await f.waitForSelector('[data-sheet="deposit"]', { timeout: 5_000 }).then(() => true, () => false);
    } else {
      // no Deposit in the box (the build before this card): the header's Deposit on a fresh Discover, its asset list
      // asked by nothing before, so the sheet's fill time is still read; the verdict stays BAD on item 7
      out.via = "header";
      await page.goto(`${SIGN}/discover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      for (let i = 0; i < 100 && !app(); i++) await page.waitForTimeout(200);
      sheetFrame = app();
      const dep = sheetFrame.locator("[data-action='deposit']:not([disabled])").filter({ visible: true }).first();
      await dep.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      t0 = Date.now();
      await press(dep).catch(() => {});
      out.headerOpened = await sheetFrame.waitForSelector('[data-sheet="deposit"]', { timeout: 5_000 }).then(() => true, () => false);
      if (!out.headerOpened) return out;
    }
    const g = sheetFrame;
    if (!out.opened && !out.headerOpened) return out;
    await shot(page, "2-opened");
    out.fillMs = await g.waitForSelector('[data-sheet="deposit"] select[data-control="deposit-asset"]', { timeout: FILL_MAX_MS + 5_000 }).then(() => Date.now() - t0, () => null);
    await page.waitForTimeout(300);
    out.min = await g.evaluate(() => {
      const n = document.querySelector('[data-sheet="deposit"] .lim > span:first-child .num');
      return { shown: n?.textContent?.trim() ?? null, real: n?.getAttribute("data-min") ?? null, symbol: document.querySelector('[data-sheet="deposit"] .damt .u')?.textContent?.trim() ?? null };
    });
    await shot(page, "3-filled");
    await press(g.locator('[data-control="deposit-withdraw"]').filter({ visible: true }).first()).catch(() => {});
    await g.waitForSelector('[data-sheet="deposit"][data-mode="withdraw"] [data-form="withdraw"]', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    out.withdraw = await g.evaluate(WITHDRAW);
    await shot(page, "4-withdraw");
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
