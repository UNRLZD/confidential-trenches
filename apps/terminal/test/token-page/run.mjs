#!/usr/bin/env node
// The token page's shots and checks (card app-token-page; AS-02, app.md:1356; card app-no-test-token), taken from the
// built app at its route, not a test page: apps/terminal built with its own vite config and opened at /
// (src/screens/token/source.ts: the top of the helper's Trending column, then its token read), with HELPER_HOST
// answered per state from the fixtures (fixtures.ts, every age shifted to the run's clock), at 390 x 844 (dpr 2, touch)
// and 1440 x 900 (dpr 1). The terminal runs only inside SIGN_HOST's shell (a top-level visit moves there,
// src/shell/in-shell.ts), so the run answers the hosts' real names from local files as app-in-shell.mjs --harness and
// the BAR-10 run do: APP_HOST the build under its _headers, SIGN_HOST the stand-in shell, signed in; every read is of
// the terminal's frame inside the shell, and each shot is the whole window. Per shot: the token route drew the page in
// its state, no horizontal scroll, no text under 11 px in the page, the curve bar only on the curve token and the dash
// in the field elsewhere, the page's data-token is the helper's top Trending token (an `?fx=` in the address bar picks
// nothing), Retry reads the lists again, and on the phone the bottom bar sits above the tab bar and the last tile
// scrolls clear of it and the curve tile is on screen without a sideways scroll. Requests to any other host are
// refused and listed. Draft words drawn are listed.
//   node apps/terminal/test/token-page/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { FIXTURE_NOW_MS, TOKENS } from "./fixtures.ts";

const HELPER = "https://api.confidential.unrealized.trade";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// id, the helper's top Trending token (a TOKENS key) or how it answers, the page's state; `query` is put in the address bar
const STATES = [
  { id: "S7.2-curve", top: "curve", state: "ready", curve: true },
  { id: "S7.2-pool", top: "pool", state: "ready", curve: false },
  { id: "S7.2-listed", top: "listed", state: "ready", curve: false },
  { id: "S7.3-edges", top: "edges", state: "ready", curve: false },
  { id: "fx-picks-nothing", top: "pool", query: "?fx=curve", state: "ready", curve: false },
  { id: "S7.1-loading", lists: "hang", state: "loading" },
  { id: "empty", lists: "empty", state: "empty" },
  { id: "error", lists: 503, state: "error" },
  { id: "error-token", top: "curve", token: 503, state: "error" },
];

/** A fixture as the helper sends it now: its age kept, read at the run's clock; the route reads Solana only, so the
 *  edges token (a NEAR id, the longest text) is answered as a Solana row. */
function live(key) {
  const shift = Math.floor((Date.now() - FIXTURE_NOW_MS) / 1000);
  const r = TOKENS[key];
  return { ...r, chain: "solana", created_s: typeof r.created_s === "number" ? r.created_s + shift : r.created_s, as_of_ms: Date.now() };
}

/** HELPER_HOST for one state: the lists (the top token alone in Trending, with an hour's volume so the column keeps it)
 *  and the token read. Returns null for any other helper path (refused). `calls` counts the lists reads. */
function helperAnswer(s, url, calls) {
  const json = (status, body) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });
  if (url.pathname === "/v1/market/lists") {
    calls.lists++;
    if (s.lists === "hang") return "hang";
    if (typeof s.lists === "number") return json(s.lists, { error: "unavailable" });
    const top = s.lists === "empty" ? [] : [{ ...live(s.top), vol_1h_usd: live(s.top).vol_1h_usd ?? "1000" }];
    return json(200, { chain: "solana", as_of_ms: Date.now(), lists: { new: [], trending: top, trending_5m: [], trending_1h: top, graduating: [] } });
  }
  if (url.pathname === "/v1/market/token") {
    if (typeof s.token === "number") return json(s.token, { error: "unavailable" });
    const row = live(s.top);
    if (url.searchParams.get("token") !== row.token) return json(404, { error: "unknown token" });
    return json(200, { row, decimals: 6, pool: null, risk: {}, route: "ok" });
  }
  return null;
}

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-token-page-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const fails = [];
const drafts = new Map();
const refused = new Set();
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

// `page` is the top window (SIGN_HOST's shell, for the shot); `f` is the terminal's frame inside it, where every read is.
async function openAt(browser, route, w, s, calls) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin === HELPER) {
      const a = helperAnswer(s, u, calls);
      if (a === "hang") return new Promise(() => {});
      if (a) return r.fulfill(a);
    }
    if (u.origin !== APP_HOST && u.origin !== SIGN_HOST) refused.add(`${u.origin}${u.origin === HELPER ? u.pathname : ""}`);
    return route(r);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP_HOST}/${s.query ?? ""}`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`${w.name} ${s.id}: no APP_HOST frame inside the shell (top at ${page.url()})`);
  await f.waitForSelector(`main[data-route="token"] [data-token-page="${s.state}"]`, { timeout: 10_000 }).catch(() => {});
  return { ctx, page, f, errors };
}

const dir = await build();
const route = await harnessRoute(dir, "signed");
const { chromium } = await import("playwright");
const browser = await chromium.launch();
let n = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.name === "390";
    for (const s of STATES) {
      n++;
      const tag = `${s.id} @${w.name}`;
      const calls = { lists: 0 };
      const { ctx, page, f, errors } = await openAt(browser, route, w, s, calls);
      const sel = `main[data-route="token"] [data-token-page="${s.state}"]`;
      const drawn = await f.locator(sel).first().isVisible().catch(() => false);
      check(drawn, `${tag}: ${sel} not drawn at the route`);
      check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
      const scroll = await f.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(scroll <= 0, `${tag}: horizontal scroll ${scroll}px`);
      const small = await f.$$eval(".tkp *", (els) => els.filter((e) => e.getClientRects().length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())).map((e) => [e.textContent.trim().slice(0, 20), parseFloat(getComputedStyle(e).fontSize)]).filter(([, px]) => px < 10.95));
      check(small.length === 0, `${tag}: text under 11 px: ${JSON.stringify(small)}`);
      if (drawn && s.state === "ready") {
        const shown = await f.$eval("[data-token-page]", (e) => e.getAttribute("data-token"));
        check(shown === TOKENS[s.top].token, `${tag}: data-token ${shown}, the helper's top is ${TOKENS[s.top].token}`);
        const box = phone ? ".tkp-phone" : ".tkp-desk";
        const bars = await f.locator(`${box} [data-testid="curve-bar"]`).count();
        check(bars === (s.curve ? 1 : 0), `${tag}: ${bars} curve bars`);
        const field = (await f.locator(`${box} [data-k="curve"] .tkp-val`).textContent())?.trim();
        check(s.curve ? /^\d+%$/.test(field ?? "") : field === "—", `${tag}: the curve field reads ${field}`);
        if (phone) {
          const g = await f.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const r = (q) => document.querySelector(q)?.getBoundingClientRect();
            const tiles = [...document.querySelectorAll(".tkp-mtile")].map((e) => e.getBoundingClientRect().bottom);
            return { bar: r(".tkp-bottom"), tab: r(".tabbar"), lastTile: Math.max(...tiles), curveRight: r('.tkp-phone [data-k="curve"]')?.right ?? Infinity, vw: window.innerWidth };
          });
          check(g.bar && g.tab && g.bar.bottom <= g.tab.top + 0.5, `${tag}: the bottom bar overlaps the tab bar`);
          check(g.curveRight <= g.vw, `${tag}: the curve tile is off screen (right ${g.curveRight} > ${g.vw})`);
          check(g.bar && g.lastTile <= g.bar.top, `${tag}: the last tile ends under the bottom bar (${g.lastTile} > ${g.bar?.top})`);
          await f.evaluate(() => window.scrollTo(0, 0));
        }
      } else {
        check((await f.locator(".tkp-bottom").count()) === 0, `${tag}: the bottom bar shows with no token`);
      }
      if (drawn && s.state === "error") {
        const before = calls.lists;
        await f.locator(".tkp-retry").click();
        const back = await f.locator(sel).waitFor({ timeout: 5_000 }).then(() => true, () => false);
        check(back, `${tag}: Retry lost the page`);
        check(calls.lists === before + 1, `${tag}: Retry read the lists ${calls.lists - before} times, not once`);
      }
      for (const d of await f.$$eval("[data-draft-copy]", (els) => els.map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(s.id);
      }
      const label = await f.$eval("[data-token-page]", (e) => e.getAttribute("aria-label")).catch(() => null);
      if (label) {
        if (!drafts.has(label)) drafts.set(label, new Set());
        drafts.get(label).add(`${s.id} (accessible name)`);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${s.id}-${w.name}.png`) });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy: ${d} (${[...ids].join(", ")})`);
if (refused.size) console.log(`refused off-host requests (the shell's): ${[...refused].join(" ")}`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} states`);
  process.exit(1);
}
console.log(`PASS ${n} states (${STATES.length} at 390 and 1440) from the built app at the token route inside the stand-in shell${SHOTS ? `; shots in ${SHOTS}` : ""}`);
