#!/usr/bin/env node
// Live check of card app-pages-open-right: every page opens at its top, a path with nothing to draw has a way back, and
// no Account row is drawn filled. APP_HOST's terminal is framed by the stand-in for SIGN_HOST's shell that sends
// app-portfolio-mount's fixed signed-in account (no check can sign a real account in).
// Headless Chromium at 400 x 844 (phone, dpr 2, touch; 400 x 520 in the harness, HARNESS_PHONE_H) and 1440 x 900
// (desktop, dpr 1) reads:
//   - phone: Trenches ("/") scrolled down, a tap on a row opens its token page at the top (scrollY 0), and Back puts the
//     list back where it was (scrollY > 0); Discover scrolled down, the Portfolio tab opens Portfolio at the top;
//   - both: an unknown path (/nope/not-a-route) stays at its address and draws the not-found state with a link to
//     Trenches ("/"), and a bad token (/token/eth/abc, /token/solana/notarealmint) draws the token page's empty state
//     with the same link; each link tapped lands on "/";
//   - phone: the Account tab's rows, with the pointer left over Sign out (a tap point keeps :hover on a touch screen),
//     each drawn with no fill.
// QA walk 16 Nov 18:00Z, items 4, 8 and 18. Item 17 (Deposit on the desktop Portfolio) is no fault: R5's lock
// (design/proto/portfolio-1440.html at design-lock-r5) puts Deposit in the header, and it is there. Item 16 (a token's
// Trades with no rows) is not read here: its skeleton is the helper's cold read still going (`filling`), which ends
// with rows or the empty state (measured 16 Nov 18:3xZ on the deployed app: 20.2 s to No data, 3.1 s and 22.2 s to
// rows), a time this app's deploy does not set.
// A screenshot of each step is kept.
// After: app
// Bundle: out a browser
//   node scripts/live-checks/app-pages-open-right.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST and helper as served, framed by the stand-in shell signed in
//   node scripts/live-checks/app-pages-open-right.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { SIGN_HOST } from "./app-in-shell.mjs";
import { routeFor } from "./app-portfolio-mount.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-pages-open-right";
export const APP_HOST = "https://ct-app.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WIDTHS = [
  { name: "phone", viewport: { width: 400, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** The paths with nothing to draw: one no route names, and two bad tokens (a chain the terminal does not draw, an id
 *  the helper does not hold). */
export const NOWHERE = ["/nope/not-a-route", "/token/eth/abc", "/token/solana/notarealmint"];
const READY_MS = 15_000;
const SETTLE_MS = 600;
/** The least scroll a run must have made before a move for its top to mean anything. */
export const SCROLLED_MIN = 100;
/** The harness's phone height: its recorded lists hold 5 rows each, a page that fits 844 px with no scroll, so the
 *  harness draws the phone 520 px tall (a small phone's window with the browser's bars) to have a page to scroll. */
export const HARNESS_PHONE_H = 520;
const NONE_FILL = "rgba(0, 0, 0, 0)";

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (every width)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    for (const p of NOWHERE) {
      const x = (r.nowhere ?? []).find((v) => v.path === p);
      const bad = [];
      if (!x) bad.push("not read");
      else {
        if (x.at !== p) bad.push(`the address moved to ${x.at ?? "none"}`);
        if (!x.state) bad.push(`drew ${x.route ?? "nothing"} with no not-found state`);
        if (x.home !== "/") bad.push(`no way back (${x.home ?? "no link"})`);
        else if (x.landed !== "/" || x.landedRoute !== "token") bad.push(`its link landed on ${x.landed ?? "nothing"} (${x.landedRoute ?? "no route"}), not Trenches`);
      }
      say(bad.length === 0, `${n} ${p}: ${bad.length ? bad.join("; ") : `${x.state} "${x.text}", its link to Trenches lands on /`}`);
    }
    if (n === "phone") {
      const t = r.toToken;
      const tBad = !t ? ["not read"] : [];
      if (t) {
        if (!(t.before >= SCROLLED_MIN)) tBad.push(`Trenches scrolled only ${t.before ?? "?"} px before the tap`);
        if (t.route !== "token" || !["loading", "ready"].includes(t.page)) tBad.push(`the tap drew ${t.route ?? "nothing"} (${t.page ?? "no token page"}), not its token page`);
        if (t.after !== 0) tBad.push(`the token page opened ${t.after ?? "?"} px down, not at its top`);
        if (!(t.back >= SCROLLED_MIN)) tBad.push(`Back put Trenches at ${t.back ?? "?"} px, not where the list was (${t.before})`);
      }
      say(tBad.length === 0, `${n} Trenches row to its token page: ${tBad.length ? tBad.join("; ") : `scrolled ${t.before} px, the token page opens at 0, Back puts the list at ${t.back}`}`);
      const p = r.toPortfolio;
      const pBad = !p ? ["not read"] : [];
      if (p) {
        if (!(p.before >= SCROLLED_MIN)) pBad.push(`Discover scrolled only ${p.before ?? "?"} px before the tap`);
        if (p.route !== "portfolio") pBad.push(`the tab drew ${p.route ?? "nothing"}`);
        if (p.after !== 0) pBad.push(`Portfolio opened ${p.after ?? "?"} px down, not at its top`);
      }
      say(pBad.length === 0, `${n} Discover to the Portfolio tab: ${pBad.length ? pBad.join("; ") : `scrolled ${p.before} px, Portfolio opens at 0`}`);
      const a = r.account;
      const filled = (a?.rows ?? []).filter((x) => x.fill !== NONE_FILL);
      const aBad = [];
      if (!a || !(a.rows?.length > 0)) aBad.push("no Account rows drawn");
      else if (!a.rows.some((x) => x.control === "acct-signout")) aBad.push("no Sign out row");
      if (filled.length) aBad.push(`${filled.map((x) => `${x.control} filled ${x.fill}`).join(", ")} with no tap`);
      say(aBad.length === 0, `${n} Account rows, the pointer left over Sign out (hover ${a?.hover ?? "?"}): ${aBad.length ? aBad.join("; ") : `${a.rows.length} rows, none filled`}`);
    }
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
    if (f) {
      await f.waitForSelector("main[data-route]", { timeout: Math.max(1, until - Date.now()) }).catch(() => {});
      return f;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

const vis = (f, sel) => f.locator(sel).filter({ visible: true }).first();
const routeOf = (f) => f.evaluate(() => ({ at: location.pathname, route: document.querySelector("main[data-route]")?.dataset.route ?? null }));
const scrollY = (f) => f.evaluate(() => Math.round(window.scrollY));
/** Scrolls the frame's window as far down as it goes; returns where it landed. */
async function scrollDown(f) {
  await f.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await f.waitForTimeout(300);
  return scrollY(f);
}

async function open(ctx, at) {
  const page = await ctx.newPage();
  await page.goto(`${APP_HOST}${at}`, { waitUntil: "load" });
  return { page, f: await terminal(page) };
}

/** A path with nothing to draw: where the frame stays, the state it draws, and where its link back lands. */
async function readNowhere(ctx, at, shots, w) {
  const { page, f } = await open(ctx, at);
  const out = { path: at, at: null, route: null, state: null, text: null, home: null, landed: null, landedRoute: null };
  try {
    if (!f) return out;
    await f.waitForSelector("[data-not-found], [data-token-page='empty'], [data-token-page='error']", { timeout: 8_000 }).catch(() => {});
    await f.waitForTimeout(SETTLE_MS);
    Object.assign(
      out,
      await f.evaluate(() => {
        const main = document.querySelector("main[data-route]");
        const s = main?.querySelector("[data-not-found], [data-token-page='empty'], [data-token-page='error']");
        const home = s?.querySelector("a[data-testid='not-found-home']");
        const own = s ? [...s.childNodes].filter((c) => c !== home).map((c) => c.textContent).join("").trim() : null;
        return { at: location.pathname, route: main?.dataset.route ?? null, state: s ? (s.hasAttribute("data-not-found") ? "not found" : `token ${s.getAttribute("data-token-page")}`) : null, text: own, home: home?.getAttribute("href") ?? null };
      }),
    );
    await page.screenshot({ path: path.join(shots, `${w.name}${at.replaceAll("/", "-")}.png`) });
    if (out.home) {
      await vis(f, "main a[data-testid='not-found-home']").click({ timeout: 3_000 }).catch(() => {});
      // the address moves first and the route draws after it (a router transition): wait for both, as a person sees it
      await f.waitForFunction(() => location.pathname === "/" && document.querySelector("main[data-route]")?.dataset.route === "token", null, { timeout: 5_000 }).catch(() => {});
      const l = await routeOf(f);
      out.landed = l.at;
      out.landedRoute = l.route;
    }
    return out;
  } finally {
    await page.close();
  }
}

async function runOne(browser, w, shots, route, harness) {
  const viewport = harness && w.name === "phone" ? { ...w.viewport, height: HARNESS_PHONE_H } : w.viewport;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, viewport, framed: false, nowhere: [] };
  try {
    await ctx.route("**/*", route);
    if (w.name === "phone") {
      // Trenches scrolled down, a row tapped, then Back
      const { page, f } = await open(ctx, "/");
      run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
      if (f) {
        await f.waitForSelector("[data-testid='phone-trenches-row']", { timeout: READY_MS }).catch(() => {});
        await f.waitForTimeout(SETTLE_MS);
        const before = await scrollDown(f);
        // the row nearest the window's middle, so the tap is a tap on screen
        const row = await f.evaluate(() => {
          const rows = [...document.querySelectorAll("[data-testid='phone-trenches-row']")].filter((r) => r.getClientRects().length);
          const mid = window.innerHeight / 2;
          const at = rows.map((r) => [Math.abs(r.getBoundingClientRect().top - mid), r.dataset.key]).sort((a, b) => a[0] - b[0])[0];
          return at?.[1] ?? null;
        });
        const toToken = { before, row, route: null, page: null, after: null, back: null };
        if (row) {
          await f.locator(`[data-testid='phone-trenches-row'][data-key="${row}"]`).first().click({ timeout: 5_000 }).catch(() => {});
          await f.waitForSelector("[data-token-page]", { timeout: READY_MS }).catch(() => {});
          await f.waitForTimeout(SETTLE_MS);
          const r = await routeOf(f);
          toToken.route = r.route;
          toToken.page = await f.evaluate(() => document.querySelector("[data-token-page]")?.getAttribute("data-token-page") ?? null);
          toToken.after = await scrollY(f);
          await page.screenshot({ path: path.join(shots, `${w.name}-token-from-trenches.png`) });
          await f.evaluate(() => history.back());
          await f.waitForSelector("[data-testid='phone-trenches-row']", { timeout: READY_MS }).catch(() => {});
          await f.waitForTimeout(SETTLE_MS);
          toToken.back = await scrollY(f);
          await page.screenshot({ path: path.join(shots, `${w.name}-trenches-after-back.png`) });
        }
        run.toToken = toToken;
      }
      await page.close();
      // Discover scrolled down, then the Portfolio tab
      {
        const { page, f } = await open(ctx, "/discover");
        if (f) {
          await f.waitForSelector("main[data-route='discover'] a[href^='/token/']", { timeout: READY_MS }).catch(() => {});
          await f.waitForTimeout(SETTLE_MS);
          const before = await scrollDown(f);
          await vis(f, ".tabbar a[href='/portfolio']").click({ timeout: 5_000 }).catch(() => {});
          await f.waitForSelector("[data-screen='portfolio']:not([data-state='S10.1'])", { timeout: READY_MS }).catch(() => {});
          await f.waitForTimeout(SETTLE_MS);
          const r = await routeOf(f);
          run.toPortfolio = { before, route: r.route, after: await scrollY(f) };
          await page.screenshot({ path: path.join(shots, `${w.name}-portfolio-from-discover.png`) });
        }
        await page.close();
      }
      // the Account tab, the pointer left where Sign out is drawn
      {
        const { page, f } = await open(ctx, "/profile");
        if (f) {
          await f.waitForSelector(".amenu.ph .mrow", { timeout: READY_MS }).catch(() => {});
          await f.waitForTimeout(SETTLE_MS);
          await vis(f, ".amenu.ph [data-control='acct-signout']").hover({ timeout: 3_000 }).catch(() => {});
          await f.waitForTimeout(300);
          run.account = await f.evaluate(() => ({
            hover: matchMedia("(hover: hover) and (pointer: fine)").matches ? "on" : "off",
            rows: [...document.querySelectorAll(".amenu.ph .mrow")].filter((e) => e.getClientRects().length).map((e) => ({ control: e.getAttribute("data-control") ?? e.getAttribute("href"), fill: getComputedStyle(e).backgroundColor })),
          }));
          await page.screenshot({ path: path.join(shots, `${w.name}-account.png`) });
        }
        await page.close();
      }
    } else {
      const { page, f } = await open(ctx, "/");
      run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
      await page.close();
    }
    for (const at of NOWHERE) run.nowhere.push(await readNowhere(ctx, at, shots, w));
    return run;
  } finally {
    await ctx.close();
  }
}

/** Every width in Chromium. `route` answers the hosts' names (app-portfolio-mount's routeFor). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source, harness = false }) {
  mkdirSync(shots, { recursive: true });
  // the harness's browser routes every socket too (scripts/harness-sockets.mjs); the deployed run reaches the hosts
  const browser = await (harness ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route, harness));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

/** The harness's helper answers a token read for every row of the recorded lists it serves (as test/token-route does),
 *  so the row a run taps opens a whole token page; any other token goes to `route` (app-in-shell's: 404). */
export function withListedTokens(route) {
  const rec = (f) => JSON.parse(readFileSync(path.join(REPO, "apps/terminal/test", f), "utf8"));
  const lists = rec("discover-data/helper-lists-2026-11-01.json");
  const rest = rec("token-source/helper-token-2026-11-03.json").rest;
  const rows = new Map(Object.values(lists.lists).flat().map((v) => Object.fromEntries(lists.fields.map((k, i) => [k, v[i]]))).map((r) => [r.token, r]));
  return (r) => {
    const u = new URL(r.request().url());
    const row = u.origin === "https://ct-api.unrealized.trade" && u.pathname === "/v1/market/token" && u.searchParams.get("chain") === "solana" ? rows.get(u.searchParams.get("token")) : undefined;
    if (!row) return route(r);
    return r.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify({ ...rest, row: { ...row, as_of_ms: Date.now() } }) });
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
    const shell = await routeFor(build);
    const rec = await collect({ shots: opt("--shots", undefined), route: build ? withListedTokens(shell) : shell, source, harness: build !== null });
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
