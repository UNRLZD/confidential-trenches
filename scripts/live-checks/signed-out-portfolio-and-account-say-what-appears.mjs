#!/usr/bin/env node
// Live check of card signed-out-portfolio-and-account-say-what-appears: signed out, Portfolio and Account each say in
// one line what appears there after sign-in, above their Sign in. Signed out (a fresh browser, as every first visit
// is), headless Chromium opens APP_HOST's /portfolio and /profile (the phone's Account tab) at 390 x 844 (phone, dpr 2,
// touch) and 1440 x 900 (desktop, dpr 1), finds the terminal's frame inside SIGN_HOST's shell and reads, for each:
//   - the visible header is signed out (S1.1), so the read is of the signed-out app;
//   - the main draws the signed-out block: its line is the page's exact words (LINES), visible, and above its Sign in;
//   - the block holds no other word: its text is the line and "Sign in", nothing more.
// A screenshot of each page at each width is kept.
// After: app
//   node scripts/live-checks/signed-out-portfolio-and-account-say-what-appears.mjs [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST as it is served, signed out
//   node scripts/live-checks/signed-out-portfolio-and-account-say-what-appears.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at the hosts' real names, answered by Playwright's route
//     from local files with app-in-shell's stand-in shell, signed out
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { named } from "./record-names.mjs";

const KEY = "signed-out-portfolio-and-account-say-what-appears";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://ct-app.unrealized.trade";
export const SIGN_HOST = "https://confidential.unrealized.trade";
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** Each page's line, signed out (owner 13 Nov 06:44Z; Account on the same pattern, 06:45Z). */
export const LINES = {
  "/portfolio": "Your equity, positions and trades appear here after you sign in.",
  "/profile": "Your account appears here after you sign in.",
};
/** The pages read at each width (Account is the phone's tab; its address draws the same at 1440). */
export const PAGES = { phone: ["/portfolio", "/profile"], desktop: ["/portfolio", "/profile"] };
const SIGN_IN = "Sign in";
const READY_MS = 15_000;
const CONTENT_MS = 10_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (every width)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : `not inside SIGN_HOST's shell (${r.top ?? "no frame"})`}`);
    for (const p of PAGES[n] ?? []) {
      const m = (r.pages ?? []).find((x) => x.path === p);
      if (!m) {
        say(false, `${n} ${p}: not read`);
        continue;
      }
      const want = LINES[p];
      const bad = [];
      if (m.header !== "S1.1") bad.push(`the header is ${m.header ?? "not drawn"}, not signed out (S1.1)`);
      if (!m.block) bad.push("no signed-out block");
      else {
        if (m.line === null) bad.push("no line");
        else if (m.line !== want) bad.push(`the line is "${m.line}", not "${want}"`);
        else if (!m.lineVisible) bad.push("the line is not on screen");
        if (m.button !== SIGN_IN) bad.push(`its button says ${m.button === null ? "nothing" : `"${m.button}"`}, not "${SIGN_IN}"`);
        if (m.line !== null && m.lineAbove !== true) bad.push(`the line is not above ${SIGN_IN}`);
        const whole = `${want}${SIGN_IN}`;
        if (m.line === want && m.text !== whole) bad.push(`the block says "${m.text}", more than the line and ${SIGN_IN}`);
      }
      say(bad.length === 0, `${n} ${p}: ${bad.length ? bad.join("; ") : `"${m.line}" above ${SIGN_IN}`}`);
    }
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
// in the terminal's frame: the visible header's state and the main's signed-out block
const READ = () => {
  const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const header = [...document.querySelectorAll(".tb [data-header], .phh [data-header]")].find(vis)?.dataset.header ?? null;
  const main = document.querySelector("main[data-route]");
  const block = main?.querySelector("[data-signed-out]") ?? null;
  const out = { path: location.pathname, route: main?.dataset.route ?? null, header, block: !!block, line: null, lineVisible: false, lineAbove: null, button: null, text: null };
  if (!block) return out;
  const flat = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const line = block.querySelector("[data-signed-out-line]");
  const button = block.querySelector("button");
  out.text = [...block.children].map((c) => flat(c.innerText)).join("");
  out.button = button ? flat(button.innerText) : null;
  if (line) {
    out.line = flat(line.innerText);
    const r = line.getBoundingClientRect();
    out.lineVisible = vis(line) && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    out.lineAbove = button ? r.bottom <= button.getBoundingClientRect().top : null;
  }
  return out;
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/** The terminal's frame inside the shell, once READY and its header is drawn; null when there is none. */
async function terminal(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f) {
      await f.waitForSelector("html[data-signpage]:not([data-signpage='connecting'])", { timeout: Math.max(1, until - Date.now()) }).catch(() => {});
      await f.waitForSelector(".tb [data-header], .phh [data-header]", { timeout: Math.max(1, until - Date.now()) }).catch(() => {});
      return f;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  const run = { width: w.name, framed: false, top: null, pages: [] };
  try {
    if (route) await ctx.route("**/*", route);
    for (const p of PAGES[w.name]) {
      const page = await ctx.newPage();
      await page.goto(`${APP_HOST}${p}`, { waitUntil: "load" });
      const f = await terminal(page);
      run.top = page.url();
      run.framed = f !== null && originOf(run.top) === SIGN_HOST;
      if (f) {
        // the signed-out block, once drawn (or the wait ends)
        await f.waitForSelector("main[data-route] [data-signed-out] button", { timeout: CONTENT_MS }).catch(() => {});
        run.pages.push(await f.evaluate(READ));
      }
      await page.screenshot({ path: path.join(shots, `${w.name}${p.replaceAll("/", "-")}-signed-out.png`) });
      await page.close();
    }
    return run;
  } finally {
    await ctx.close();
  }
}

/** Every width in Chromium. `route`: the harness's answers for the hosts' real names, or null for the deployed hosts. */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route = null, source = "live" } = {}) {
  mkdirSync(shots, { recursive: true });
  // a run with `route` is the harness's: its browser routes every socket too (scripts/harness-sockets.mjs)
  const browser = await (route ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let route = null;
    let source = `live ${APP_HOST}`;
    if (a.includes("--harness")) {
      const build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const { harnessRoute } = await import("./app-in-shell.mjs");
      // the stand-in shell's signed-out state ("tap"), as a first visit is
      route = await harnessRoute(build, "tap");
      source = `harness, terminal build ${named(build)}, signed out`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route, source });
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
