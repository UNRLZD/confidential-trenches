#!/usr/bin/env node
// Live check of card app-export-every-wallet: signed in, every wallet that holds the user's money has an export on
// Portfolio, and each export asks SIGN_HOST for export.open with its own wallet's chain and address. APP_HOST's terminal
// is framed by the stand-in for SIGN_HOST's shell (app-in-shell.mjs) that sends one fixed signed-in account (ACCOUNT:
// positions on Solana and Base, one of them held on two wallets, a ready wallet with no position and a deposit wallet
// with money left), since no check can sign a real account in. The shell refuses export.open, as SIGN_HOST does until
// card signpage-backup-export, so each tap unlocks at once and the next one runs. Headless Chromium opens /portfolio at
// 1440 x 900 (desktop) and 390 x 844 (phone, dpr 2, touch), dark, and:
//   - desktop: taps each position row's Export key icon (a row on two wallets opens a menu of both; each is tapped)
//     and each Wallets row's icon;
//   - phone: opens each position's sheet and taps each of its Export rows, then taps each Wallets row's icon;
//   - after each tap reads what the app asked the shell for (window.__ctShellAsked).
// It passes when, at each width, every tap asked for exactly one export.open naming the control's own chain and address,
// that wallet is one ACCOUNT holds money on, and every such wallet (WALLETS: the kit's moneyWallets of ACCOUNT, pinned
// here; the check's test holds the two equal) was asked for at least once. A screenshot of each width, of its Wallets
// rows in view, of the desktop export menu and of a phone sheet are kept.
// After: app
//   node scripts/live-checks/app-export-every-wallet.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/app-export-every-wallet.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
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
import { named } from "./record-names.mjs";

const KEY = "app-export-every-wallet";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";

const SO_A = "Fixture1Wa11etSo1ana1111111111111111111111";
const SO_B = "Fixture2Wa11etSo1ana2222222222222222222222";
const SO_READY = "Fixture3Wa11etSo1ana3333333333333333333333";
const SO_U = "Fixture4Dep0sitSo1ana444444444444444444444";
const BASE_W = "0x00000000000000000000000000000000000ba5e1";
/** The signed-in account the stand-in shell sends. */
export const ACCOUNT = {
  release: "harness-shell",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "40.50",
  pools: [{ chain: "solana", asset: "SOL", balance: "0.5", ready: "0.5" }],
  wallets: [
    { chain: "solana", address: SO_A, role: "fresh", size: "10", state: "IN_POSITION" },
    { chain: "solana", address: SO_B, role: "fresh", size: "10", state: "IN_POSITION" },
    { chain: "solana", address: SO_READY, role: "fresh", size: "20.12", state: "READY" },
    { chain: "base", address: BASE_W, role: "fresh", size: "10", state: "IN_POSITION" },
  ],
  positions: [
    { chain: "solana", token: "Fixture1Token1111111111111111111111111111111", amount: "1000", cost: "3.06", wallets: [SO_A, SO_B] },
    { chain: "base", token: "0x0000000000000000000000000000000000007e57", amount: "5", cost: "2.00", wallets: [BASE_W] },
  ],
  deposit_wallets: [{ chain: "solana", asset: "SOL", address: SO_U, amount: "0.0125" }],
  orders: [],
  held: [],
  ops: [],
};
/** Every wallet of ACCOUNT that holds money: the kit's moneyWallets(ACCOUNT), as chain:address (the test holds them equal). */
export const WALLETS = [`solana:${SO_A}`, `solana:${SO_B}`, `solana:${SO_READY}`, `solana:${SO_U}`, `base:${BASE_W}`];
export const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READY_MS = 15_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const have = new Set(runs.map((r) => r.width));
  say(WIDTHS.every((w) => have.has(w.name)), `${runs.length} run(s) of ${WIDTHS.length} (desktop and phone)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    const drawn = r.screen === "portfolio" && r.state === "S10.3";
    say(drawn, `${n}: /portfolio ${drawn ? "draws Portfolio with its positions (S10.3)" : `draws ${r.screen ? `Portfolio in ${r.state}` : "no Portfolio"}`}`);
    const taps = r.taps ?? [];
    const opened = new Set();
    for (const t of taps) {
      const own = `${t.chain}:${t.address}`;
      const asked = t.asked ?? [];
      const ex = asked.filter((a) => a.type === "export.open");
      const right = asked.length === 1 && ex.length === 1 && ex[0].chain === t.chain && ex[0].address === t.address && ex[0].return_key === "export";
      say(right, `${n}: ${t.from}'s export (${own}) asks for ${asked.length ? asked.map((a) => `${a.type}${a.type === "export.open" ? ` ${a.chain}:${a.address}` : ""}`).join(", ") : "nothing"}`);
      say(WALLETS.includes(own), `${n}: ${t.from}'s export names ${own}, ${WALLETS.includes(own) ? "a wallet that holds money" : "no wallet that holds money"}`);
      if (right) opened.add(own);
    }
    const missing = WALLETS.filter((w) => !opened.has(w));
    say(missing.length === 0, `${n}: ${missing.length ? `no export opens ${missing.join(", ")}` : `every wallet that holds money (${WALLETS.length}) has an export that opens it`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const READ = () => {
  const pf = document.querySelector("main[data-route] [data-screen='portfolio']");
  return { screen: pf ? "portfolio" : null, state: pf?.dataset.state ?? null };
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

/** What the app asked the shell for since `from`, other than its state reads and address moves: each kind and, for an
 *  export.open, its chain, address and return key. */
const askedSince = async (page, from) =>
  (await page.evaluate(() => window.__ctShellAsked ?? []))
    .slice(from)
    .filter((a) => a.type !== "state" && a.type !== "nav")
    .map((a) => (a.type === "export.open" ? { type: a.type, chain: a.chain, address: a.address, return_key: a.return_key } : { type: a.type }));
const count = (page) => page.evaluate(() => (window.__ctShellAsked ?? []).length);

/** Taps one export control, then reads what the app asked for and the control's own chain and address. */
async function tapExport(page, loc, from) {
  const chain = await loc.getAttribute("data-export-chain");
  const address = await loc.getAttribute("data-export-address");
  const n = await count(page);
  await loc.click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { from, chain, address, asked: await askedSince(page, n) };
}

const visible = (l) => l.filter({ visible: true });

async function desktopTaps(page, f, shots) {
  const taps = [];
  const rows = visible(f.locator("[data-screen='portfolio'] .pfd tr[data-pos]"));
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const key = await row.getAttribute("data-pos");
    await row.hover().catch(() => {});
    const direct = row.locator("[data-control='export']");
    if (await direct.count()) {
      taps.push(await tapExport(page, direct.first(), `position ${key}`));
      continue;
    }
    const menu = row.locator("[data-control='export-menu']");
    if (!(await menu.count())) continue;
    const n = Number(await menu.getAttribute("data-export-count")) || 0;
    for (let j = 0; j < n; j++) {
      await row.hover().catch(() => {});
      await menu.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(200);
      if (j === 0) await page.screenshot({ path: path.join(shots, "desktop-export-menu.png") });
      taps.push(await tapExport(page, row.locator("[data-menu='export'] [data-control='export']").nth(j), `position ${key} (menu ${j + 1} of ${n})`));
    }
  }
  return taps;
}

async function phoneTaps(page, f, shots) {
  const taps = [];
  const rows = visible(f.locator("[data-screen='portfolio'] .pfm .mpr[data-pos]"));
  for (let i = 0; i < (await rows.count()); i++) {
    const key = await rows.nth(i).getAttribute("data-pos");
    await rows.nth(i).click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const n = await f.locator("[data-sheet='position'] [data-control='sheet-export']").count();
    if (i === 0) await page.screenshot({ path: path.join(shots, "phone-sheet.png") });
    for (let j = 0; j < n; j++) {
      if (j > 0) {
        await rows.nth(i).click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
      taps.push(await tapExport(page, f.locator("[data-sheet='position'] [data-control='sheet-export']").nth(j), `position ${key} (sheet ${j + 1} of ${n})`));
    }
    await visible(f.locator(".msheet-scrim")).first().click({ timeout: 1_000 }).catch(() => {});
  }
  return taps;
}

async function walletTaps(page, f, side) {
  const taps = [];
  const rows = visible(f.locator(`[data-screen='portfolio'] ${side} [data-wallet]`));
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    taps.push(await tapExport(page, row.locator("[data-control='export']").first(), `Wallets ${await row.getAttribute("data-wallet")}`));
  }
  return taps;
}

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/portfolio`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector("[data-screen='portfolio']:not([data-state='S10.1'])", { timeout: READY_MS }).catch(() => {});
    await page.waitForTimeout(500);
    Object.assign(run, await f.evaluate(READ));
    await page.screenshot({ path: path.join(shots, `${w.name}.png`) });
    if (run.screen !== "portfolio") return run;
    const side = w.name === "desktop" ? ".pfd" : ".pfm";
    // the Wallets rows in view (below the fold on the phone), then back to the top
    const wl = visible(f.locator(`[data-screen='portfolio'] ${side} [data-wallets]`)).first();
    if (await wl.count()) {
      await wl.evaluate((e) => e.scrollIntoView({ block: "center" })).catch(() => {});
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(shots, `${w.name}-wallets.png`) });
    }
    run.taps = [...(w.name === "desktop" ? await desktopTaps(page, f, shots) : await phoneTaps(page, f, shots)), ...(await walletTaps(page, f, side))];
    return run;
  } finally {
    await ctx.close();
  }
}

/** Both widths in Chromium. `route` answers the hosts' names (see main). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source }) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route));
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
      source = `harness, terminal build ${named(build)}, the stand-in shell signed in`;
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
