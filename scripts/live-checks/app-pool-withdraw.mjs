#!/usr/bin/env node
// Live check of card app-pool-withdraw (brought to release 146's hand-off by card app-pool-withdraw-reads-146): on
// /portfolio, each pool row's Withdraw opens the app's own Withdraw on its chain (routes/portfolio-taps.ts, card
// withdraw-in-app-to-any-chain, release 145: the deposit sheet's Withdraw segment, apps/terminal/src/screens/withdraw/
// WithdrawForm.tsx), which hands SIGN_HOST nothing at that tap; the amount and the address are typed in that form, and
// its Withdraw (withdraw-go) asks SIGN_HOST's shell for the pool's withdraw (kit messages.ts "pool.withdraw": chain, to,
// amount), and either answer is drawn. APP_HOST's terminal is framed by the stand-in shell (app-in-shell.mjs) signed in
// with POOLS (NEAR's USDC row, a Solana and a Base pool with a balance, an empty Robinhood one), in two shells per
// width, 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1):
//   - refused: the shell refuses pool.withdraw (not_allowed): the form stays up with its HopLine "refused" under it and
//     its Withdraw free again, so the tap never ends in nothing;
//   - opened: the shell answers { pending: true }, as SIGN_HOST does before it draws its Confirm sheet: no line, the
//     app's sheet closed, the controls still locked (the row's Withdraw off), since the screen that would take this
//     frame is coming (the stand-in never draws one; card app-hop-sync-lock: a tap between the answer and that screen
//     sends nothing).
// In each run: Withdraw is on for Solana and Base and off for the empty Robinhood pool; Base's row tap opens the form on
// Base and asks the shell for no open and nothing that carries an address or an amount (the sheet's own reads,
// deposit.assets and pool.address with the chain only, are no open); the form's Withdraw, with AMOUNT and TO typed,
// asks for exactly one request, of type pool.withdraw with the keys v, id, type, chain, to, amount and return_key, chain
// "base", to TO, amount AMOUNT and return_key "withdraw" (the kit's RETURN_KEYS), no dest (Base's money arrives on
// Base, the form's default), no other field. After the answer every pool row is still inside its panel (the desktop
// panel clips: a line that pushed a row out would hide it). A screenshot of each run is kept.
// After: app
// Bundle: out a browser
//   node scripts/live-checks/app-pool-withdraw.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/app-pool-withdraw.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
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

const KEY = "app-pool-withdraw";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The signed-in account the stand-in shell sends: four pool rows, as a real account can hold (the NEAR USDC row has no
 *  Withdraw: NEAR is no pool chain), a balance on Solana and Base, an empty Robinhood pool. */
export const POOLS = {
  release: "harness-shell",
  api: 1,
  signed_in: true,
  way: "passkey",
  code_saved: true,
  vault_balance: "0",
  pools: [
    { chain: "near", asset: "USDC", balance: "7.25" },
    { chain: "solana", asset: "SOL", balance: "0.5", ready: "0.5" },
    { chain: "base", asset: "ETH", balance: "0.01", ready: "0.01" },
    { chain: "robinhood", asset: "ETH", balance: "0", ready: "0" },
  ],
  wallets: [],
  positions: [],
  orders: [],
  held: [],
  ops: [],
};
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
export const SHELLS = ["refused", "opened"];
/** The one request the form's Withdraw may send: the kit's envelope (v, id, type) and pool.withdraw's params. */
export const KEYS = ["amount", "chain", "id", "return_key", "to", "type", "v"];
/** What the check types in the form: half of POOLS' Base balance, to an EVM address no one holds the key of. */
export const AMOUNT = "0.005";
export const TO = "0x000000000000000000000000000000000000dEaD";
/** The kit's open kinds (messages.ts OPEN_KINDS): a row's tap may ask none of them. */
const OPENS = ["withdraw.open", "signin.open", "backup.open", "export.open", "signout", "pool.withdraw"];
/** The fields that carry what the user typed or holds: a row's tap may send none of them. */
const GIVEN = ["to", "amount", "max", "dest", "origin_asset", "address"];
const READY_MS = 15_000;

const show = (asked) => asked.map((a) => `${a.type ?? "?"} {${Object.keys(a).sort().join(", ")}}${a.chain ? ` chain ${a.chain}` : ""}`).join("; ");

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => SHELLS.map((s) => `${w.name} ${s}`));
  const have = new Set(runs.map((r) => `${r.width} ${r.shell}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (phone and desktop, refused and opened)`);
  for (const r of runs) {
    const n = `${r.width} ${r.shell}`;
    say(r.framed === true && r.screen === "portfolio", `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}, ${r.screen === "portfolio" ? "Portfolio drawn" : "no Portfolio"}`);
    const on = r.on ?? {};
    say(on.solana === true && on.base === true && on.robinhood === false, `${n}: pool Withdraw on ${JSON.stringify(on)}, want Solana and Base on, the empty Robinhood off`);
    // the row's tap: the app's form on Base, nothing handed to SIGN_HOST
    const row = Array.isArray(r.row) ? r.row : null;
    const handed = (row ?? []).filter((a) => OPENS.includes(a.type) || GIVEN.some((k) => Object.hasOwn(a, k)));
    const form = r.form === "base" && row !== null && handed.length === 0;
    say(form, `${n}: Base's row Withdraw ${r.form ? `opens the app's Withdraw on ${r.form}` : "opens no app Withdraw"}, ${row === null ? "its requests unread" : handed.length ? `hands the shell ${show(handed)}` : "hands the shell no open"}${form ? "" : ", want the form on base and no open"}`);
    // the form's Withdraw: one pool.withdraw with the chain, the address and the amount typed (the sheet's reads aside)
    const asked = (r.asked ?? []).filter((a) => OPENS.includes(a.type) || GIVEN.some((k) => Object.hasOwn(a, k)) || (a.type !== "deposit.assets" && a.type !== "pool.address"));
    const q = asked[0] ?? {};
    const keys = Object.keys(q).sort();
    const one = asked.length === 1 && q.type === "pool.withdraw" && q.chain === "base" && q.to === TO && q.amount === AMOUNT && q.return_key === "withdraw" && JSON.stringify(keys) === JSON.stringify(KEYS);
    say(one, `${n}: the form's Withdraw asks the shell ${asked.length === 0 ? "nothing" : show(asked)}${one ? "" : `, want one pool.withdraw {${KEYS.join(", ")}} chain base, to ${TO}, amount ${AMOUNT}`}`);
    say(r.inside === true, `${n}: ${r.inside === true ? "every pool row inside its panel after the answer" : r.inside === false ? "a pool row outside its panel after the answer" : "no pool rows read"}`);
    // refused: the form stays up with its line and its Withdraw free at once; opened: the sheet closes for SIGN_HOST's
    // Confirm, no line, the controls held until the shell's screen takes the frame
    const refused = r.shell === "refused";
    const drawn = refused ? r.line === "refused" && r.sheet === true : r.line === null && r.sheet === false;
    say(drawn && r.unlocked === refused, `${n}: the answer drawn ${r.line === null || r.line === undefined ? "no line" : `line ${r.line}`}, the form ${r.sheet ? "up" : "closed"}, control ${r.unlocked ? "unlocked" : "still locked"}${drawn && r.unlocked === refused ? "" : `, want ${refused ? "the refused line under the form, still up, unlocked" : "no line, the form closed, still locked"}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
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

/** The requests the app sent the shell, other than its state reads and address moves. */
const asked = (page) => page.evaluate(() => (window.__ctShellAsked ?? []).filter((q) => q.type !== "state" && q.type !== "nav"));
/** The deposit sheet on its Withdraw segment, as drawn. */
const SHEET = "[data-sheet='deposit'][data-mode='withdraw']";

async function runOne(browser, w, shell, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, shell, framed: false, screen: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/portfolio`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector("[data-screen='portfolio'] [data-pools='rows']", { timeout: READY_MS }).catch(() => {});
    run.screen = (await f.locator("[data-screen='portfolio']").count()) > 0 ? "portfolio" : null;
    const form = w.name === "phone" ? ".pfm" : ".pfd";
    const btn = (c) => f.locator(`[data-screen='portfolio'] ${form} [data-control='pool-withdraw-${c}']`);
    run.on = {};
    for (const c of ["solana", "base", "robinhood"]) run.on[c] = (await btn(c).count()) ? !(await btn(c).isDisabled()) : null;
    // the row's tap: the app's Withdraw on Base
    let before = (await asked(page)).length;
    await btn("base").scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    await btn("base").click({ timeout: 5_000 }).catch(() => {});
    await f.waitForSelector(`${SHEET} [data-form='withdraw']`, { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(800);
    run.row = (await asked(page)).slice(before);
    const wf = f.locator(`${SHEET} [data-form='withdraw']`).filter({ visible: true }).first();
    run.form = (await wf.count()) ? await wf.getAttribute("data-place") : null;
    // the form's Withdraw with an amount and a Base address typed
    if (run.form) {
      await wf.locator("[data-field='withdraw-amount']").fill(AMOUNT, { timeout: 2_000 }).catch(() => {});
      await wf.locator("[data-field='withdraw-address']").fill(TO, { timeout: 2_000 }).catch(() => {});
      before = (await asked(page)).length;
      await f.locator(`${SHEET} [data-control='withdraw-go']`).filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    run.asked = run.form ? (await asked(page)).slice(before) : [];
    const sheet = f.locator(`${SHEET} [data-form='withdraw']`).filter({ visible: true });
    run.sheet = (await sheet.count()) > 0;
    const line = f.locator(`${SHEET} [data-hop-failed='withdraw-go']`).filter({ visible: true });
    run.line = (await line.count()) ? await line.first().getAttribute("data-hop-why") : null;
    // refused: the form's Withdraw free again; opened: the form is gone, so the row's Withdraw shows the held lock
    const go = f.locator(`${SHEET} [data-control='withdraw-go']`).filter({ visible: true });
    run.unlocked = run.sheet ? (await go.count()) > 0 && !(await go.first().isDisabled()) : (await btn("base").count()) > 0 && !(await btn("base").isDisabled());
    await page.screenshot({ path: path.join(shots, `${w.name}-${shell}-form.png`) });
    run.inside = await f.evaluate((sel) => {
      const b = document.querySelector(sel);
      // what is drawn: each cell, and for Withdraw its icon (the phone's 44 px tap box may overhang the panel's padding)
      const rows = b ? [...b.querySelectorAll("[data-pool] > *")].map((e) => (e.matches("button") ? e.querySelector("svg") ?? e : e)).filter((e) => e.getClientRects().length) : [];
      if (!rows.length) return null;
      const panel = b.closest(".panel, .mwhere").getBoundingClientRect();
      return rows.every((e) => e.getBoundingClientRect().bottom <= panel.bottom + 0.5);
    }, `[data-screen='portfolio'] ${form} .pools`);
    await page.screenshot({ path: path.join(shots, `${w.name}-${shell}.png`) });
    return run;
  } finally {
    await ctx.close();
  }
}

/** Both widths and shells in Chromium. `routes` answers the hosts' names per shell (see routeFor). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), routes, source }) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) for (const s of SHELLS) runs.push(await runOne(browser, w, s, shots, routes[s]));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

/** The stand-in shell with POOLS, refusing or opening pool.withdraw; APP_HOST from `build`, or with no build the
 *  deployed APP_HOST and helper as served. */
export async function routeFor(build, shell) {
  // the deployed run reads only the shell from the stand-in; its _headers come from the source tree's (the shell's own)
  const r = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: POOLS, opens: shell === "opened" ? ["pool.withdraw"] : [] });
  if (build) return r;
  return (x) => {
    const o = originOf(x.request().url());
    return o === APP_HOST || o === HELPER_HOST ? x.continue() : r(x);
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
    const routes = Object.fromEntries(await Promise.all(SHELLS.map(async (s) => [s, await routeFor(build, s)])));
    const rec = await collect({ shots: opt("--shots", undefined), routes, source });
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
