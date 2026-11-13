#!/usr/bin/env node
// Live check of card screens-never-say-proof (13 Nov 07:53Z: removed, the app names no proof): no screen of APP_HOST's
// terminal says proof, proving, ready or pending about the user's money, and money the device is still making spendable
// never reads as no money. APP_HOST's terminal is framed by a stand-in for SIGN_HOST's shell (app-in-shell.mjs) that
// sends one signed-in account (ACCOUNT): cash in the vault and a Solana pool of 0.5 SOL, priced, whose proofs are still
// being made (ready "0", making "0.5": the state the page sends the seconds after a load or a fresh deposit), since no
// check can sign a real account in. Headless Chromium at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop) opens
// the token page of a Solana coin (app-sell-mount's PATH; on the phone the bar's Buy opens the trade sheet), then
// /portfolio, then the deposit sheet from the header's Deposit (a fresh stand-in shell per width, so the pool's price stays inside
// the kit's bound), and reads:
//   - the trade box: on the pool path, no proof mark, no word of proof, ready or pending; the pool's balance shown (a
//     dollar amount above $0), no Max line, and Buy with the busy look of a tap in flight (data-kind live, aria-busy);
//   - Portfolio's pool block: one column header, Balance, and no word of proof, ready or pending;
//   - the deposit sheet as it opens: no word of proof, ready or pending;
//   - the app's scripts (every script the frame loaded, and every script those name, fetched as served): none holds a
//     removed word as a string ("Proof ready", "Making proof", "Ready", "Pending").
// After: app
//   node scripts/live-checks/screens-never-say-proof.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/screens-never-say-proof.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
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
import { PATH } from "./app-sell-mount.mjs";
import { named } from "./record-names.mjs";

const KEY = "screens-never-say-proof";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** What no screen says about money. */
export const NAMED = /proo?f|prov(e|ed|es|ing)|\bready\b|pending/i;
/** The removed words as the scripts would hold them: a quoted string of exactly the word. */
export const REMOVED = ["Proof ready", "Making proof", "Ready", "Pending"];
/** The signed-in account the stand-in shell sends; the pool's price is read at the run's own time (the kit drops one
 *  past its feed's bound). */
export const account = (nowMs = Date.now()) => ({
  release: "harness-shell",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "40.50",
  pools: [{ chain: "solana", asset: "SOL", balance: "0.5", ready: "0", making: "0.5", price: { price: "9301048308", expo: -8, published_s: Math.floor(nowMs / 1000), read_ms: nowMs } }],
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
});
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READY_MS = 15_000;

// ------------------------------------------------------------------------------------------------ the verdict
const money = (s) => /^\$\d[\d,]*(\.\d+)?/.test(s ?? "") && !/^\$0(\.0+)?(\s|$)/.test(s ?? "");

export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (phone and desktop)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    const b = r.box;
    if (!b) {
      say(false, `${n}: no trade box drawn`);
    } else {
      say(b.path === "pool", `${n}: the trade box is on the ${b.path ?? "no"} path, want pool`);
      say(b.marks === 0 && !NAMED.test(b.text ?? ""), `${n}: the trade box ${b.marks ? `holds ${b.marks} proof mark(s)` : NAMED.test(b.text ?? "") ? `says ${JSON.stringify(b.text)}` : "names no proof"}`);
      say(money(b.balance), `${n}: the pool's balance shows as ${JSON.stringify(b.balance)}, want a dollar amount above $0`);
      say(!/max/i.test(b.max ?? "") && !NAMED.test(b.max ?? ""), `${n}: the line above Buy ${b.max ? JSON.stringify(b.max) : "is empty"}, want no Max and no word while nothing can be spent yet`);
      say(b.cta?.kind === "live" && b.cta?.busy === "true", `${n}: Buy ${JSON.stringify(b.cta)}, want the busy look of a tap in flight (live, aria-busy)`);
    }
    const p = r.pools;
    say(!!p && JSON.stringify(p.heads) === '["Balance"]' && !NAMED.test(p.text ?? ""), `${n}: Portfolio's pools ${p ? `head ${JSON.stringify(p.heads)}, ${NAMED.test(p.text ?? "") ? `say ${JSON.stringify(p.text)}` : "name no proof"}` : "not drawn"}`);
    const d = r.deposit;
    say(d !== null && d !== undefined && !NAMED.test(d), `${n}: the deposit sheet ${d == null ? "not opened" : NAMED.test(d) ? `says ${JSON.stringify(d)}` : "names no proof"}`);
  }
  const s = rec.scripts ?? { read: 0, found: [] };
  say(s.read > 0 && s.found.length === 0, `the app's scripts: ${s.read} read, ${s.found.length ? `holding ${s.found.join(", ")}` : "none holds a removed word"}`);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the reads
const BOX = (phone) => {
  const scope = phone ? document.querySelector('[data-sheet="trade"]') : document.querySelector("main[data-route] .tkp-desk .tkp-trade");
  const el = scope?.querySelector('[data-testid="trade-box"]');
  if (!el) return null;
  const cta = el.querySelector('[data-testid="trade-cta"]');
  const t = (s) => el.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  return {
    path: el.getAttribute("data-path"),
    marks: el.querySelectorAll('[data-testid="trade-proof"], [data-proof]').length,
    text: el.innerText.replace(/\s+/g, " ").trim(),
    balance: t('[data-testid="trade-balance"]'),
    max: t('[data-testid="trade-max"]'),
    cta: cta ? { kind: cta.getAttribute("data-kind"), busy: cta.getAttribute("aria-busy"), label: cta.textContent.trim() } : null,
  };
};
const POOLS = () => {
  const b = [...document.querySelectorAll("[data-screen='portfolio'] .pools[data-pools]")].find((e) => e.getClientRects().length);
  return b ? { heads: [...b.querySelectorAll(".plc")].map((h) => h.textContent), text: b.innerText.replace(/\s+/g, " ").trim() } : null;
};
const SHEET = () => {
  const s = [...document.querySelectorAll("[data-sheet='deposit']")].find((e) => e.getClientRects().length);
  return s ? s.innerText.replace(/\s+/g, " ").trim() : null;
};
/** Every script the frame loaded and every same-origin script they name, fetched as served; the removed words found. */
const SCRIPTS = async (removed) => {
  const seen = new Set();
  const queue = [...document.querySelectorAll("script[src]")].map((s) => s.src).concat(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => /\.m?js(\?|$)/.test(u)));
  const found = new Set();
  while (queue.length) {
    const u = new URL(queue.shift(), location.href);
    if (u.origin !== location.origin || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    const text = await fetch(u.href).then((r) => (r.ok ? r.text() : ""), () => "");
    for (const w of removed) if (new RegExp(`(["'\`])${w}\\1`).test(text)) found.add(`"${w}" in ${u.pathname}`);
    for (const m of text.matchAll(/["'`(/]((?:\.\.?\/|\/)?assets\/[\w.-]+\.js)["'`)]/g)) queue.push(new URL(m[1], u.href).href);
    for (const m of text.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) queue.push(new URL(m[1], u.href).href);
  }
  return { read: seen.size, found: [...found] };
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

async function runOne(browser, w, shots, route, scripts) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, box: null, pools: null, deposit: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    // the trade box on a Solana coin's page
    await page.goto(`${APP_HOST}${PATH}`, { waitUntil: "load" });
    let f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: READY_MS }).catch(() => {});
    if (w.isMobile) {
      await f.locator(".tkp-buy").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    }
    const sel = w.isMobile ? '[data-sheet="trade"] [data-testid="trade-box"]' : '.tkp-desk .tkp-trade [data-testid="trade-box"]';
    // the shell's signed-in state has landed when the box shows the pool's balance
    await f.waitForFunction((s) => /^\$\d/.test(document.querySelector(`${s} [data-testid="trade-balance"]`)?.textContent?.trim() ?? ""), sel, { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(400);
    run.box = await f.evaluate(BOX, w.isMobile);
    await page.screenshot({ path: path.join(shots, `${w.name}-trade.png`) });
    if (scripts.read === null) Object.assign(scripts, await f.evaluate(SCRIPTS, REMOVED), { from: w.name });
    // Portfolio's pool block
    await page.goto(`${APP_HOST}/portfolio`, { waitUntil: "load" });
    f = await terminal(page);
    if (!f) return run;
    await f.waitForSelector("[data-screen='portfolio'] .pools[data-pools='rows']", { timeout: READY_MS }).catch(() => {});
    await page.waitForTimeout(400);
    run.pools = await f.evaluate(POOLS);
    await page.screenshot({ path: path.join(shots, `${w.name}-portfolio.png`) });
    // the deposit sheet from the header's Deposit
    await f.locator("[data-action='deposit']").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
    await f.locator("[data-sheet='deposit']").filter({ visible: true }).first().waitFor({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
    run.deposit = await f.evaluate(SHEET);
    await page.screenshot({ path: path.join(shots, `${w.name}-deposit.png`) });
    return run;
  } finally {
    await ctx.close();
  }
}

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), build = null, source }) {
  mkdirSync(shots, { recursive: true });
  const browser = await (build ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const runs = [];
    const scripts = { read: null, found: [] };
    for (const w of WIDTHS) {
      const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: account() });
      // the deployed run reads only the shell from the stand-in; APP_HOST and the helper as served
      const route = build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r));
      runs.push(await runOne(browser, w, shots, route, scripts));
    }
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, scripts: { read: scripts.read ?? 0, found: scripts.found }, runs };
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
