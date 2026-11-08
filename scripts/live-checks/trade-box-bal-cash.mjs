#!/usr/bin/env node
// Live check of card trade-box-bal-cash: the trade box's Bal is the header's Cash on a chain with no pool, and the pool's
// balance on a chain with one, never a second sum. APP_HOST's terminal is framed by a stand-in for SIGN_HOST's shell
// (app-in-shell.mjs) that sends app-portfolio-mount's signed-in account (the vault's $40.50, a NEAR USDC pool $7.25 and a
// READY wallet $20.12: Cash $67.87), once without its Solana pool ("cash": the box buys from Cash) and once with it
// ("pool": the box buys from the pool, which the live app cannot price yet, so its Bal reads none), since no check can
// sign a real account in. Headless Chromium opens / (the token route, a Solana token) at 1440 x 900 (the box in the right
// column) and 390 x 844 (dpr 2, the bar's Buy opens the trade sheet) and reads the header's balance and the box's Bal and
// path:
//   - cash: the box is on the vault's path and its Bal equals the header's, which is the account's Cash ($67.87);
//   - pool: the box is on the pool's path and its Bal is not the header's Cash (the pool's, "—" until it is priced).
// Node reads the served / first and records the build's entry script, so a run names the build it judged.
// After: app
//   node scripts/live-checks/trade-box-bal-cash.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/trade-box-bal-cash.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { ACCOUNT, CASH } from "./app-portfolio-mount.mjs";

const KEY = "trade-box-bal-cash";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
export { CASH };
/** The account the stand-in shell sends: app-portfolio-mount's, with its Solana pool ("pool") or without it ("cash"). */
export const account = (kind) => ({ ...ACCOUNT, pools: ACCOUNT.pools.filter((p) => kind === "pool" || p.chain !== "solana") });
export const KINDS = ["cash", "pool"];
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READY_MS = 20_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  say(typeof rec.entry === "string" && /^\/assets\/[\w.-]+\.js$/.test(rec.entry), `the served / names its entry script ${rec.entry ?? "none"}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => KINDS.map((k) => `${w.name} ${k}`));
  const have = new Set(runs.map((r) => `${r.width} ${r.kind}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (desktop and phone, no pool and a pool)`);
  for (const r of runs) {
    const n = `${r.width} ${r.kind}`;
    const bad = [];
    if (r.framed !== true) bad.push("not inside SIGN_HOST's shell");
    if (r.route !== "token") bad.push(`drew ${r.route ?? "nothing"}, not the token route`);
    if (r.header !== CASH) bad.push(`the header's balance is ${r.header ?? "none"}, not the account's Cash ${CASH}`);
    const bal = r.box?.bal ?? null;
    if (!r.box) bad.push("no trade box");
    else if (r.kind === "cash") {
      if (r.box.path === "pool") bad.push("the box is on the pool path with no pool");
      if (bal !== `Bal ${r.header}`) bad.push(`the box's Bal is ${JSON.stringify(bal)}, the header's ${r.header ?? "none"}`);
    } else {
      if (r.box.path !== "pool") bad.push(`the box is on the ${r.box.path ?? "unmarked"} path, not the pool's`);
      if (bal === null) bad.push("the box draws no Bal");
      else if (bal === `Bal ${r.header}`) bad.push(`the box's Bal is the header's Cash (${bal}), not the pool's`);
    }
    if (!r.shot) bad.push("no screenshot");
    say(bad.length === 0, `${n}: ${bad.length ? bad.join("; ") : `the header ${r.header}, the box's ${JSON.stringify(bal)} on the ${r.box.path} path`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const READ = (sheet) => {
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const main = document.querySelector("main[data-route]");
  const scope = sheet ? document.querySelector('[data-sheet="trade"]') : main?.querySelector(".tkp-desk .tkp-trade");
  const el = scope?.querySelector('[data-testid="trade-box"]');
  const heads = [...document.querySelectorAll(".tb [data-balance], .phh [data-balance]")];
  const head = heads.find(vis) ?? heads[0];
  return {
    route: main?.dataset.route ?? null,
    header: head?.textContent?.trim() ?? null,
    box: el ? { path: el.getAttribute("data-path"), bal: el.querySelector('[data-testid="trade-balance"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null } : null,
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

async function runOne(browser, w, kind, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, kind, framed: false, route: null, header: null, box: null, shot: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: READY_MS }).catch(() => {});
    await f.waitForSelector(".tb [data-balance]:not([data-balance='loading']), .phh [data-balance]:not([data-balance='loading'])", { timeout: 8_000 }).catch(() => {});
    if (w.isMobile) {
      await f.locator(".tkp-buy").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    }
    const sel = w.isMobile ? '[data-sheet="trade"] [data-testid="trade-box"]' : '.tkp-desk .tkp-trade [data-testid="trade-box"]';
    // the shell's signed-in state has landed when the box's button no longer asks to sign in
    await f.waitForFunction((s) => { const t = document.querySelector(`${s} [data-testid="trade-cta"]`)?.textContent?.trim(); return !!t && t !== "Sign in to trade"; }, sel, { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(400);
    Object.assign(run, await f.evaluate(READ, w.isMobile));
    run.shot = `${w.name}-${kind}.png`;
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
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const kind of KINDS) {
      const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: account(kind) });
      // the deployed run reads only the shell from the stand-in; APP_HOST and the helper as served
      const route = build ? shell : (r) => (originOf(r.request().url()) === APP_HOST || originOf(r.request().url()) === HELPER_HOST ? r.continue() : shell(r));
      for (const w of WIDTHS) runs.push(await runOne(browser, w, kind, shots, route));
    }
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
    let source = `live ${APP_HOST}, the stand-in shell signed in with app-portfolio-mount's account`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : "<build>"}, the stand-in shell signed in with app-portfolio-mount's account`;
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
