#!/usr/bin/env node
// Live check of card app-no-blank-pages: no link or tab opens an empty page. Signed out (a fresh browser, as every
// first visit is), headless Chromium opens APP_HOST at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1),
// finds the terminal's frame inside SIGN_HOST's shell (card app-in-shell) and reads:
//   - the visible header is signed out (S1.1, its Sign in), so every read below is of the signed-out app;
//   - every link the visible shell draws (the phone header and tab bar; the desktop top bar and footer), each tapped
//     from a fresh load of "/": the main it opens has text on screen, outside the Verify panel; a link to a page whose
//     own card has not shipped (WAITING) is named with that card, never passed silently;
//   - no link to Orders (its screen is paused: it leaves the nav until it ships, as Copy trade did);
//   - Account (the phone's tab) and Portfolio, signed out: the main draws Sign in, and a tap on it opens the sign-in
//     sheet (S2.1);
//   - /verify opened at its own address, and from the footer's pill: the Verify panel over the Trenches page (the
//     token page drawn behind it, with text), never over an empty page.
// A screenshot of the signed-out "/" (its header) and of /verify opened directly is kept at both widths, and one of
// every link's page.
// After: app
//   node scripts/live-checks/app-no-blank-pages.mjs [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST as it is served, signed out
//   node scripts/live-checks/app-no-blank-pages.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
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

const KEY = "app-no-blank-pages";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://ct-app.unrealized.trade";
export const SIGN_HOST = "https://confidential.unrealized.trade";
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, links: ".phh a[href], .tabbar a[href]" },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, links: ".tb a[href], .ft a[href]" },
];
/** Links to a page another card fills, by that card: named in every run, not judged blank until it ships. */
export const WAITING = { "/terms": "app-legal-pages", "/privacy": "app-legal-pages" };
/** Routes that, signed out, draw Sign in in place of the page. */
export const SIGN_IN = ["/profile", "/portfolio"];
export const NOT_LINKED = ["/orders"];
/** Each path's route id, as its main carries it (apps/terminal/src/routes/routes.ts). */
export const ROUTE_OF = { "/": "token", "/discover": "discover", "/portfolio": "portfolio", "/orders": "orders", "/profile": "profile", "/verify": "verify", "/privacy": "privacy", "/terms": "terms" };
const READY_MS = 15_000;
const CONTENT_MS = 10_000;

// ------------------------------------------------------------------------------------------------ the verdict
const desc = (m) => (m ? `${m.path ?? "?"}: main ${m.route ?? "none"}, ${m.text} char(s) of text${m.panel ? ", the Verify panel" : ""}${m.token ? `, the token page (${m.token})` : ""}${m.signedOut ? ", Sign in" : ""}` : "no main read");

export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (every width)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : `not inside SIGN_HOST's shell (${r.top ?? "no frame"})`}`);
    say(r.header === "S1.1", `${n}: the header is ${r.header === "S1.1" ? "signed out (S1.1)" : `${r.header ?? "not drawn"}, not signed out (S1.1)`}`);
    const links = r.links ?? [];
    say(links.length > 0, `${n}: ${links.length} link(s): ${links.map((l) => l.href).join(" ") || "none"}`);
    const linked = NOT_LINKED.filter((p) => links.some((l) => l.href === p));
    say(linked.length === 0, `${n}: ${linked.length ? `links to ${linked.join(", ")}, a page that is not built` : `no link to ${NOT_LINKED.join(", ")}`}`);
    for (const l of links) {
      const m = l.main;
      const wait = WAITING[l.href];
      if (wait) {
        say(true, `${n} ${l.href}: waiting on card ${wait}: ${m && m.text > 0 ? "has content" : "blank"} (${desc(m)})`);
        continue;
      }
      const bad = [];
      if (!m) bad.push("no main");
      else if (m.path !== l.href) bad.push(`the tap left the address at ${m.path}`);
      else if (m.route !== ROUTE_OF[l.href]) bad.push(`drew ${m.route}, not ${ROUTE_OF[l.href] ?? "a known route"}`);
      else {
        if (!(m.text > 0)) bad.push("an empty page");
        if (l.href === "/verify" && !(m.panel && m.token && m.text > 0)) bad.push("the Verify panel not over the Trenches page");
        if (SIGN_IN.includes(l.href) && !m.signedOut) bad.push("no Sign in");
        if (SIGN_IN.includes(l.href) && m.signedOut && l.sheet !== "S2.1") bad.push(`its Sign in opens ${l.sheet ?? "nothing"}, not the sign-in sheet (S2.1)`);
      }
      say(bad.length === 0, `${n} ${l.href}: ${bad.length ? `${bad.join("; ")} (${desc(m)})` : desc(m)}${SIGN_IN.includes(l.href) && l.sheet ? `; Sign in opens ${l.sheet}` : ""}`);
    }
    // Account is the phone's tab: it must be there to be judged
    if (n === "phone") say(links.some((l) => l.href === "/profile"), `${n}: the Account tab (/profile) ${links.some((l) => l.href === "/profile") ? "is drawn" : "is not drawn"}`);
    const d = r.direct;
    say(!!d && d.path === "/verify" && d.panel && d.token && d.text > 0, `${n} /verify opened directly: ${d ? desc(d) : "not read"}${d && !(d.path === "/verify" && d.panel && d.token && d.text > 0) ? ": not the Verify panel over the Trenches page" : ""}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
// in the terminal's frame: what the routed main shows, outside the Verify panel
const READ_MAIN = () => {
  const main = document.querySelector("main[data-route]");
  if (!main) return null;
  const outside = [...main.children].filter((c) => !c.matches(".vfy"));
  const text = outside.map((c) => (c.innerText ?? "").trim()).join("").length;
  const token = outside.find((c) => c.matches("[data-token-page]"))?.dataset.tokenPage ?? null;
  return { path: location.pathname, route: main.dataset.route, text, panel: !!main.querySelector(".vfy"), token, signedOut: !!main.querySelector("[data-signed-out] button") };
};
// the header the width shows: the desktop bar's or the phone header's state
const READ_HEADER = () => {
  const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const h = [...document.querySelectorAll(".tb [data-header], .phh [data-header]")].find(vis);
  return h?.dataset.header ?? null;
};

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/** The terminal's frame inside the shell, once READY; null when there is none. */
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

/** The main at `href`, once it has text outside the panel (or the wait ends), and for /verify once the panel is drawn. */
async function settle(f, href) {
  const verify = href === "/verify";
  await f
    .waitForFunction(
      ({ href, route, verify }) => {
        if (location.pathname !== href) return false;
        const main = document.querySelector("main[data-route]");
        if (!main || main.dataset.route !== route) return false;
        const outside = [...main.children].filter((c) => !c.matches(".vfy"));
        const text = outside.map((c) => (c.innerText ?? "").trim()).join("").length;
        return text > 0 && (!verify || !!main.querySelector(".vfy"));
      },
      { href, route: ROUTE_OF[href] ?? ROUTE_OF["/"], verify },
      { timeout: CONTENT_MS },
    )
    .catch(() => {});
  return f.evaluate(READ_MAIN);
}

async function open(ctx, url) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  const f = await terminal(page);
  return { page, f };
}

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  const run = { width: w.name, framed: false, top: null, header: null, links: [], direct: null };
  try {
    if (route) await ctx.route("**/*", route);
    // "/": the signed-out header and the links the width draws
    const home = await open(ctx, `${APP_HOST}/`);
    run.top = home.page.url();
    run.framed = home.f !== null && originOf(run.top) === SIGN_HOST;
    if (!home.f) return run;
    await settle(home.f, "/");
    run.header = await home.f.evaluate(READ_HEADER);
    await home.page.screenshot({ path: path.join(shots, `${w.name}-header-signed-out.png`) });
    const hrefs = await home.f.$$eval(w.links, (as) => [...new Set(as.filter((a) => a.getClientRects().length > 0 && getComputedStyle(a).visibility !== "hidden").map((a) => a.getAttribute("href")))]);
    await home.page.close();
    // each link tapped from a fresh "/"
    for (const href of hrefs) {
      const { page, f } = await open(ctx, `${APP_HOST}/`);
      const link = { href, main: null, sheet: null };
      run.links.push(link);
      if (!f) {
        await page.close();
        continue;
      }
      await settle(f, "/");
      const sel = w.links.split(",").map((s) => `${s.trim().replace("[href]", "")}[href="${href}"]`).join(", ");
      await f.locator(sel).filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
      link.main = await settle(f, href);
      await page.screenshot({ path: path.join(shots, `${w.name}-link${href === "/" ? "-home" : href.replaceAll("/", "-")}.png`) });
      if (SIGN_IN.includes(href) && link.main?.signedOut) {
        await f.click("main [data-signed-out] button", { timeout: 2_000 }).catch(() => {});
        link.sheet = await f.waitForSelector("[data-sheet='signin']", { timeout: 3_000 }).then((e) => e.getAttribute("data-state"), () => null);
      }
      await page.close();
    }
    // /verify at its own address
    const d = await open(ctx, `${APP_HOST}/verify`);
    if (d.f) {
      run.direct = await settle(d.f, "/verify");
      await d.page.screenshot({ path: path.join(shots, `${w.name}-verify-direct.png`) });
    }
    await d.page.close();
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
