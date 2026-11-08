#!/usr/bin/env node
// Live check of card app-hop-sync-lock: a second tap on a control that opens SIGN_HOST's screens, landing after the
// shell's ok but before its screen takes the frame, sends nothing. SIGN_HOST answers an open kind first and then reads
// its store and opens its layer (packages/signpage/src/main.ts decide()), so on a slow device a double tap's second tap
// can land in between; main CI run 41862040096 (FR-P2) sent two signin.open for two taps 40 ms apart. APP_HOST's
// terminal is framed by the stand-in shell (app-in-shell.mjs) signed out, answering signin.open { pending: true } as
// the real shell does and never drawing a screen, which holds that moment open. At 390 x 844 (phone, dpr 2, touch) and
// 1440 x 900 (desktop, dpr 1): Sign in, then the passkey way; once the shell has answered, the same way again. Want one
// signin.open, the way still locked, and no line under it.
// After: app
//   node scripts/live-checks/app-hop-sync-lock.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/app-hop-sync-lock.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
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

const KEY = "app-hop-sync-lock";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
/** The signed-out account the stand-in shell sends: the sign-in sheet offers its ways. */
export const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
export const CONTROL = "signin-passkey";
const READY_MS = 15_000;
/** After the shell's answer, the second tap; after it, the read. Both well inside the kit's 5 s window for the kind. */
const GAP_MS = 300;
const READ_MS = 800;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const have = new Set(runs.map((r) => r.width));
  say(WIDTHS.every((w) => have.has(w.name)), `${runs.length} run(s) of ${WIDTHS.length} (phone and desktop)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true && r.sheet === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}, ${r.sheet ? "the sign-in sheet drawn" : "no sign-in sheet"}`);
    say(r.answered === true, `${n}: ${r.answered ? "the shell answered the first tap before the second" : "no answer before the second tap"}`);
    say(r.opens === 1, `${n}: signin.open sent ${r.opens ?? "?"} time(s) for two taps, want 1`);
    say(r.locked === true && r.line === null, `${n}: the way ${r.locked ? "still locked" : "unlocked"}, ${r.line === null ? "no line" : `line ${r.line}`}, want still locked with no line`);
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

const opens = (page) => page.evaluate(() => (window.__ctShellAsked ?? []).filter((q) => q.type === "signin.open").length);

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, sheet: false, answered: false, opens: null, locked: null, line: null };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    const signIn = f.locator('[data-header="S1.1"] button, button[data-header="S1.1"]').filter({ visible: true }).first();
    await signIn.waitFor({ timeout: READY_MS }).catch(() => {});
    await signIn.click({ timeout: 5_000 }).catch(() => {});
    const way = f.locator(`.sgn[data-state="S2.1"] [data-control="${CONTROL}"]`).filter({ visible: true }).first();
    await way.waitFor({ timeout: 5_000 }).catch(() => {});
    const box = await way.boundingBox().catch(() => null);
    run.sheet = box !== null;
    if (!box) return run;
    // the frame fills the shell's window at 0,0: the way's box in the frame is its box on the page
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    const tapAt = () => (w.hasTouch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
    await tapAt();
    // the stand-in answers at once; the second tap comes once the answer is in, as on a slow device before the screen
    await page.waitForFunction(() => (window.__ctShellAsked ?? []).some((q) => q.type === "signin.open"), null, { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(GAP_MS);
    run.answered = (await opens(page)) >= 1;
    await tapAt();
    await page.waitForTimeout(READ_MS);
    run.opens = await opens(page);
    run.locked = await way.isDisabled().catch(() => null);
    const line = f.locator(`[data-hop-failed="${CONTROL}"]`);
    run.line = (await line.count()) ? await line.getAttribute("data-hop-why") : null;
    await page.screenshot({ path: path.join(shots, `${w.name}.png`) });
    return run;
  } finally {
    await ctx.close();
  }
}

/** Both widths in Chromium. `route` answers the hosts' names (see routeFor). */
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

/** The stand-in shell signed out, opening signin.open; APP_HOST from `build`, or with no build the deployed APP_HOST
 *  and helper as served. */
export async function routeFor(build) {
  // the deployed run reads only the shell from the stand-in; its _headers come from the source tree's (the shell's own)
  const r = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: SIGNED_OUT, opens: ["signin.open"] });
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
    let source = `live ${APP_HOST}, the stand-in shell signed out`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed out`;
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
