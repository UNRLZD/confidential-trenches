#!/usr/bin/env node
// Live check of card app-faults-seen-on-124: the deposit sheet's asset list (deposit.assets) is asked at most once a
// minute per device. Each ask is the token list and a probe quote per asset on SIGN_HOST (four of a device's five 1Click
// calls a minute on the helper, apps/helper/src/proxy/proxy.ts DEPOSIT_SHEET_CALLS); release 124 asked it on every page
// load, so the second load inside a minute met 429 on /v1/proxy/oneclick/v0/tokens (live runs 43309898493 and
// 43309913191). Headless Chromium, 1440 x 900, one tab: ten page loads of SIGN_HOST, each on one of the app's routes,
// inside a minute. On each load it waits for the terminal's frame to read READY (<html data-signpage="ready">) and then
// for the page's asks to settle, and records the deposit.assets requests the frame sent the shell (heard at SIGN_HOST's
// top window) and the status of every answer on the helper's 1Click paths. Want: deposit.assets asked once in all
// (the first load's warm read, so a sheet still opens on a list), no 429 on any 1Click path, every load READY, all
// inside 60 s. A run stops at the first 429: that is the verdict, and no more of the helper's share is spent.
// After: app
//   node scripts/live-checks/app-faults-seen-on-124.mjs [--shots <dir>] [--record <file>]
//     the deployed SIGN_HOST and APP_HOST and the helper as served, as a signed-out visitor
//   node scripts/live-checks/app-faults-seen-on-124.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name inside the stand-in shell, which answers
//     deposit.assets itself (no 1Click path is read), the helper's other reads recorded
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
import { named } from "./record-names.mjs";

const KEY = "app-faults-seen-on-124";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The helper's 1Click paths (apps/helper/src/proxy/vendors.ts oneclick). */
const ONECLICK = "/v1/proxy/oneclick/";
export const LOADS = 10;
/** The routes the loads walk, in turn: the pages the 429s were printed on, and Discover. */
export const ROUTES = ["/discover", "/profile", "/orders", "/terms", "/portfolio"];
export const WINDOW_MS = 60_000;
const READY_MS = 20_000;
/** After READY, the time a warm read has to be sent: the shell's mount asks in its first effect, well inside it. */
const SETTLE_MS = 1_500;
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const NEAR = { origin_asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", chain: "near", symbol: "USDC", decimals: 6, min: "1.05", max_usd: "1000" };

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const loads = rec.loads ?? [];
  const busy = loads.flatMap((l, i) => (l.oneclick ?? []).filter((a) => a.status === 429).map((a) => `load ${i + 1} ${a.path}`));
  say(busy.length === 0, busy.length ? `429 on the helper's 1Click paths: ${busy.join("; ")}` : `no 429 on the helper's 1Click paths (${loads.reduce((n, l) => n + (l.oneclick ?? []).length, 0)} answers)`);
  say(loads.length === LOADS || busy.length > 0, `${loads.length} load(s) of ${LOADS}`);
  const notReady = loads.map((l, i) => (l.ready === true ? null : i + 1)).filter((x) => x !== null);
  say(loads.length > 0 && notReady.length === 0, notReady.length ? `load(s) ${notReady.join(", ")} never read READY` : `every load read READY`);
  const span = loads.length ? loads.at(-1).atMs - loads[0].atMs : null;
  say(span !== null && span < WINDOW_MS, `the loads span ${span === null ? "nothing" : `${Math.round(span / 1000)} s`}, want under ${WINDOW_MS / 1000} s`);
  const asks = loads.map((l) => l.assets ?? 0);
  const total = asks.reduce((a, b) => a + b, 0);
  say(total === 1 && asks[0] === 1, `deposit.assets asked ${total} time(s) over the loads (${asks.join(", ")}), want once, by the first load`);
  say(typeof rec.shot === "string", `screenshot ${rec.shot ?? "none"}`);
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

// in every document before its scripts: SIGN_HOST's top window counts the kinds the frame sends it
const LISTEN = (sign) => {
  if (location.origin !== sign || window.top !== window) return;
  addEventListener("message", (e) => e.data && typeof e.data.type === "string" && (window.__ctKinds ??= []).push(e.data.type), true);
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

export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source, harness = false }) {
  mkdirSync(shots, { recursive: true });
  const browser = await (harness ? launchHarnessBrowser : launchBrowser)("chromium");
  const rec = { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), loads: [], shot: null };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
    if (route) await ctx.route("**/*", route);
    await ctx.addInitScript(LISTEN, SIGN_HOST);
    const page = await ctx.newPage();
    let load = null;
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (load && u.origin === HELPER_HOST && u.pathname.startsWith(ONECLICK)) load.oneclick.push({ path: u.pathname, status: r.status() });
    });
    for (let i = 0; i < LOADS; i++) {
      load = { route: ROUTES[i % ROUTES.length], atMs: Date.now(), ready: false, assets: 0, oneclick: [] };
      rec.loads.push(load);
      await page.goto(`${SIGN_HOST}${load.route}`, { waitUntil: "load" });
      const f = await terminal(page);
      if (f) load.ready = await f.waitForSelector('html[data-signpage="ready"]', { state: "attached", timeout: READY_MS }).then(() => true, () => false);
      await page.waitForTimeout(SETTLE_MS);
      load.assets = await page.evaluate(() => (window.__ctKinds ?? []).filter((k) => k === "deposit.assets").length);
      if (load.oneclick.some((a) => a.status === 429)) break;
    }
    // an answer is counted to the load open when it lands (a first load's probe quotes may land in the second)
    rec.shot = `${KEY}-1440.png`;
    await page.screenshot({ path: path.join(shots, rec.shot) });
    await ctx.close();
    return { ...rec, shots };
  } finally {
    await browser.close();
  }
}

/** The stand-in shell signed out, answering deposit.assets as the real page does; APP_HOST from `build`. With no build:
 *  nothing routed, every host as served. */
export async function routeFor(build = null) {
  if (!build) return null;
  return harnessRoute(build, "signed", { state: SIGNED_OUT, answers: { "deposit.assets": { assets: [NEAR] } } });
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${SIGN_HOST} and ${APP_HOST}, the helper as served, signed out`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed out`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route: await routeFor(build), source, harness: build !== null });
    const file = opt("--record", null);
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
