#!/usr/bin/env node
// Live check of card app-portfolio-mount: signed in, /portfolio draws Portfolio and Activity, its taps go where they
// belong, and the header's balance is Portfolio's Cash. APP_HOST's terminal is framed by a stand-in for SIGN_HOST's
// shell (app-in-shell.mjs) that sends one fixed signed-in account (ACCOUNT: cash in the vault, a USDC pool, a READY
// wallet, money on the way, two positions), since no check can sign a real account in. Headless Chromium opens
// /portfolio at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1), dark and light, and reads:
//   - the terminal is inside the shell and draws the portfolio route with Portfolio on it (data-screen="portfolio"), not
//     the loading state and not an empty page;
//   - the visible header's balance equals Portfolio's visible Cash tile, to the cent, and both equal ACCOUNT's cash
//     (CASH; design-lock-r5 S10.3 shows Cash in the header);
//   - in dark: Withdraw asks the shell for withdraw.open; Export (the row's Export key icon on desktop, the position's
//     sheet on the phone) asks for export.open; Deposit (phone) opens the deposit sheet; Sell asks the shell for nothing and opens
//     no sheet (its screen is another card's).
// A screenshot of each width and scheme is kept.
//   node scripts/live-checks/app-portfolio-mount.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/app-portfolio-mount.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";

const KEY = "app-portfolio-mount";
export const APP_HOST = "https://confidential.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://api.confidential.unrealized.trade";
/** The signed-in account the stand-in shell sends. */
export const ACCOUNT = {
  release: "harness-shell",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "40.50",
  // the kit refuses a pool whose asset is not its chain's (base and robinhood hold ETH, solana SOL, near USDC): a SOL
  // pool has no dollar value until a price read exists, so only the NEAR USDC one counts
  pools: [{ chain: "near", asset: "USDC", balance: "7.25" }, { chain: "solana", asset: "SOL", balance: "0.5", ready: "0.5" }],
  wallets: [
    { chain: "solana", address: "Fixture1Wa11etSo1ana1111111111111111111111", role: "fresh", size: "20.12", state: "READY" },
    { chain: "base", address: "0x00000000000000000000000000000000000f1fe7", role: "fresh", size: "10.12", state: "ARMING" },
  ],
  positions: [
    { chain: "solana", token: "Fixture1Token1111111111111111111111111111111", amount: "1000", cost: "3.06", wallets: ["Fixture1Wa11etSo1ana1111111111111111111111"] },
    { chain: "solana", token: "Fixture2Token2222222222222222222222222222222", amount: "5", cost: "2.00", wallets: ["Fixture1Wa11etSo1ana1111111111111111111111"] },
  ],
  orders: [],
  held: [],
  ops: [],
};
/** ACCOUNT's cash: 40.50 in the vault + 7.25 NEAR USDC pool + 20.12 READY; never the 10.12 on the way or the 5.06 in positions. */
export const CASH = "$67.87";
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
export const SCHEMES = ["dark", "light"];
const READY_MS = 15_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => SCHEMES.map((s) => `${w.name} ${s}`));
  const have = new Set(runs.map((r) => `${r.width} ${r.scheme}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (every width, dark and light)`);
  for (const r of runs) {
    const n = `${r.width} ${r.scheme}`;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    const drawn = r.route === "portfolio" && r.screen === "portfolio" && (r.state === "S10.2" || r.state === "S10.3");
    say(drawn, `${n}: /portfolio ${drawn ? `draws Portfolio (${r.state})` : `draws ${r.screen ? `Portfolio in ${r.state}` : "no Portfolio"} on route ${r.route ?? "none"}, ${r.text ?? 0} char(s) of text`}`);
    const cash = r.cash ?? null;
    say(cash !== null && cash === r.header && cash === CASH, `${n}: the header's balance ${r.header ?? "none"}, Portfolio's Cash ${cash ?? "none"}, the account's cash ${CASH}`);
    if (r.scheme !== "dark") continue;
    const t = r.taps ?? {};
    say(t.withdraw === "withdraw.open", `${n}: Withdraw asks the shell for ${t.withdraw ?? "nothing"}`);
    say(t.export === "export.open", `${n}: Export asks the shell for ${t.export ?? "nothing"}`);
    if (r.width === "phone") say(t.deposit === "deposit", `${n}: Deposit opens ${t.deposit ?? "nothing"}`);
    say(t.sell === "nothing", `${n}: Sell ${t.sell === "nothing" ? "does nothing visible (its screen is another card's)" : `opens ${t.sell ?? "unread"}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const READ = () => {
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const main = document.querySelector("main[data-route]");
  const pf = main?.querySelector("[data-screen='portfolio']");
  const head = [...document.querySelectorAll(".tb [data-balance], .phh [data-balance]")].find(vis);
  return {
    route: main?.dataset.route ?? null,
    text: (main?.innerText ?? "").trim().length,
    screen: pf ? "portfolio" : null,
    state: pf?.dataset.state ?? null,
    cash: [...(pf?.querySelectorAll("[data-tile='cash'] .pvv") ?? [])].find(vis)?.textContent ?? null,
    header: head?.textContent ?? null,
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

/** The kinds the app sent the shell since `from`, other than its state reads and address moves. */
const asked = async (page, from) => (await page.evaluate(() => window.__ctShellSeen ?? [])).slice(from).filter((k) => k !== "state" && k !== "nav");
const seen = (page) => page.evaluate(() => (window.__ctShellSeen ?? []).length);

/** Taps one visible control, then reads what the app asked the shell for. */
async function tap(page, f, sel) {
  const from = await seen(page);
  await f.locator(sel).filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(800);
  return asked(page, from);
}

async function runOne(browser, w, scheme, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  const run = { width: w.name, scheme, framed: false };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/portfolio`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector("[data-screen='portfolio']:not([data-state='S10.1'])", { timeout: READY_MS }).catch(() => {});
    await f.waitForSelector(".tb [data-balance]:not([data-balance='loading']), .phh [data-balance]:not([data-balance='loading'])", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
    Object.assign(run, await f.evaluate(READ));
    await page.screenshot({ path: path.join(shots, `${w.name}-${scheme}.png`) });
    if (scheme !== "dark" || run.screen !== "portfolio") return run;
    const taps = {};
    taps.withdraw = (await tap(page, f, "[data-screen='portfolio'] [data-control='withdraw']"))[0] ?? null;
    if (w.name === "desktop") {
      // the row's Export key icon (card app-export-every-wallet), in the row's icon row
      taps.export = (await tap(page, f, "[data-screen='portfolio'] tr[data-pos] [data-control='export']"))[0] ?? null;
    } else {
      await f.locator("[data-screen='portfolio'] [data-pos]").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      taps.export = (await tap(page, f, "[data-control='sheet-export']"))[0] ?? null;
      await f.locator(".msheet-scrim").filter({ visible: true }).first().click({ timeout: 2_000 }).catch(() => {});
      await tap(page, f, "[data-screen='portfolio'] [data-control='deposit']");
      taps.deposit = (await f.locator("[data-sheet='deposit']").filter({ visible: true }).count()) > 0 ? "deposit" : null;
      if (shots) await page.screenshot({ path: path.join(shots, `${w.name}-deposit.png`) });
      await f.locator(".dep-x").filter({ visible: true }).first().click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    const sell = await tap(page, f, `[data-screen='portfolio'] [data-control='${w.name === "desktop" ? "sell" : "sell-100"}']`);
    const sheet = (await f.locator("[data-sheet]").filter({ visible: true }).count()) > 0;
    taps.sell = sell.length ? sell.join(", ") : sheet ? "a sheet" : "nothing";
    run.taps = taps;
    return run;
  } finally {
    await ctx.close();
  }
}

/** Every width and scheme in Chromium. `route` answers the hosts' names (see main). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source }) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) for (const s of SCHEMES) runs.push(await runOne(browser, w, s, shots, route));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

/** The stand-in shell with ACCOUNT; APP_HOST from `build`, or with no build the deployed APP_HOST and helper as served. */
export async function routeFor(build = null) {
  // the deployed run reads only the shell from the stand-in; its _headers come from the source tree's (the shell's own)
  const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: ACCOUNT });
  if (build) return shell;
  return (r) => {
    const o = originOf(r.request().url());
    return o === APP_HOST || o === HELPER_HOST ? r.continue() : shell(r);
  };
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
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : build}, the stand-in shell signed in`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route: await routeFor(build), source });
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
