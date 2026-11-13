#!/usr/bin/env node
// Live check of card app-lock-holds-until-the-layer-closes: with a signing page that says when its layer closes (an ok
// with `closes`, kit 1.13), a second tap after the sheet has taken this frame's focus, before SIGN_HOST's next rendering,
// sends nothing, and the control unlocks at that open's closed notice, not before and with no wait after it. SIGN_HOST
// moves the focus to its sheet in the task it opens it, and the frame takes taps until its next rendering: merge-queue
// run 43344446268 sent two signin.open for two taps 40 ms apart. APP_HOST's terminal is framed by the stand-in shell
// (app-in-shell.mjs) signed out, answering signin.open { pending: true, closes: true } as the real shell does and never
// drawing a screen; the check moves the top window's focus off the frame as the real sheet does, and posts the closed
// notices itself. At 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1): Sign in, the passkey way, the
// shell's answer, the focus taken, the same way again; then a notice for another id, then the one for the open. Want one
// signin.open, the way still locked with no line through the other id's notice, and unlocked with no line within
// UNLOCK_MS of its own.
// After: app
//   node scripts/live-checks/app-lock-holds-until-the-layer-closes.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live), framed by the stand-in shell
//   node scripts/live-checks/app-lock-holds-until-the-layer-closes.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { APP_HOST, CONTROL, SIGNED_OUT, WIDTHS } from "./app-hop-sync-lock.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-lock-holds-until-the-layer-closes";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://ct-api.unrealized.trade";
const READY_MS = 15_000;
/** The focus taken, then the second tap; after it, the reads. All well inside the kit's 5 s window for the kind. */
const GAP_MS = 100;
const READ_MS = 800;
/** The most the unlock may take after the open's own notice: a rendering or two, no timer. */
export const UNLOCK_MS = 1_000;

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
    say(r.answered === true && r.closes === true, `${n}: ${r.answered ? `the shell answered the first tap${r.closes ? " with closes" : " with no closes"}` : "no answer"} before the second tap`);
    say(r.blurred === true, `${n}: ${r.blurred ? "the frame's focus taken" : "the frame kept the focus"} before the second tap`);
    say(r.opens === 1, `${n}: signin.open sent ${r.opens ?? "?"} time(s) for two taps, want 1`);
    say(r.locked === true && r.line === null, `${n}: after the second tap the way ${r.locked ? "still locked" : "unlocked"}, ${r.line === null ? "no line" : `line ${r.line}`}, want still locked with no line`);
    say(r.otherHeld === true, `${n}: another id's notice ${r.otherHeld ? "left the way locked" : "unlocked the way"}, want locked`);
    const fast = typeof r.unlockMs === "number" && r.unlockMs <= UNLOCK_MS;
    say(r.unlocked === true && fast && r.lineAfter === null, `${n}: at the open's own notice the way ${r.unlocked ? `unlocked in ${r.unlockMs} ms` : "stayed locked"}, ${r.lineAfter === null ? "no line" : `line ${r.lineAfter}`}, want unlocked within ${UNLOCK_MS} ms with no line`);
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

const asked = (page) => page.evaluate(() => (window.__ctShellAsked ?? []).filter((q) => q.type === "signin.open").map((q) => q.id));
// as the real shell posts it to the frame (packages/signpage/src/api.ts closed)
const notice = (page, id) =>
  page.evaluate(([id, app]) => document.querySelector("iframe").contentWindow.postMessage({ v: 1, type: "closed", id }, app), [id, APP_HOST]);

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, sheet: false, answered: false, closes: null, blurred: null, opens: null, locked: null, line: null, otherHeld: null, unlocked: null, unlockMs: null, lineAfter: null };
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
    await page.waitForFunction(() => (window.__ctShellAsked ?? []).some((q) => q.type === "signin.open"), null, { timeout: 5_000 }).catch(() => {});
    const [id] = await asked(page);
    run.answered = id !== undefined;
    run.closes = await page.evaluate(() => window.__ctShellCloses === true);
    // the sheet takes the keyboard's focus in the task it opens, out of this frame (packages/signpage/src/shell.ts open())
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0";
      document.body.appendChild(b);
      b.focus();
    });
    run.blurred = (await f.evaluate(() => document.hasFocus()).catch(() => null)) === false;
    await page.waitForTimeout(GAP_MS);
    // the frame still takes a tap until SIGN_HOST's next rendering
    await tapAt();
    await page.waitForTimeout(READ_MS);
    run.opens = (await asked(page)).length;
    run.locked = await way.isDisabled().catch(() => null);
    const line = f.locator(`[data-hop-failed="${CONTROL}"]`);
    run.line = (await line.count()) ? await line.getAttribute("data-hop-why") : null;
    await page.screenshot({ path: path.join(shots, `${w.name}-held.png`) });
    if (!run.answered) return run;
    await notice(page, `${id}-other`);
    await page.waitForTimeout(300);
    run.otherHeld = await way.isDisabled().catch(() => null);
    const t0 = Date.now();
    await notice(page, id);
    run.unlocked = await way
      .evaluate((el, ms) => new Promise((ok) => {
        const until = performance.now() + ms;
        const look = () => (!el.disabled ? ok(true) : performance.now() > until ? ok(false) : requestAnimationFrame(look));
        look();
      }), UNLOCK_MS * 2)
      .catch(() => null);
    run.unlockMs = run.unlocked ? Date.now() - t0 : null;
    run.lineAfter = (await line.count()) ? await line.getAttribute("data-hop-why") : null;
    await page.screenshot({ path: path.join(shots, `${w.name}-closed.png`) });
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

/** The stand-in shell signed out, opening signin.open with closes; APP_HOST from `build`, or with no build the deployed
 *  APP_HOST and helper as served. */
export async function routeFor(build) {
  const r = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: SIGNED_OUT, opens: ["signin.open"], closes: true });
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
    let source = `live ${APP_HOST}, the stand-in shell signed out, its open answered with closes`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed out, its open answered with closes`;
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
