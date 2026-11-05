#!/usr/bin/env node
// The token page's shots and checks (card app-token-page; AS-02, app.md:1356; card app-no-test-token), taken from the
// built app at its route, not a test page: apps/terminal built with its own vite config and opened at /
// (src/screens/token/source.ts: the top of the helper's Trending column, then its token read), with HELPER_HOST
// answered per state from the fixtures (fixtures.ts, every age shifted to the run's clock), at 390 x 844 (dpr 2, touch),
// 1440 x 900 and 1280 x 800 (dpr 1). The terminal runs only inside SIGN_HOST's shell (a top-level visit moves there,
// src/shell/in-shell.ts), so the run answers the hosts' real names from local files as app-in-shell.mjs --harness and
// the BAR-10 run do: APP_HOST the build under its _headers, SIGN_HOST the stand-in shell, signed in; every read is of
// the terminal's frame inside the shell, and each shot is the whole window. Per shot: the token route drew the page in
// its state, no horizontal scroll, no text under 11 px in the page, the design's tiles (Liquidity reads In curve on the
// curve token, a Tax tile), on desktop the strip clear of the trade column with no tile cut, on the phone the back, star
// and share row, the page's data-token is the helper's top Trending token (an `?fx=` in the address bar picks
// nothing), Retry reads the lists again, and on the phone the bottom bar sits above the tab bar and the last tile
// scrolls clear of it and the tile row scrolls sideways inside itself with every tile in reach (the page never does). Requests to any other host are
// refused and listed. Draft words drawn are listed.
//   node apps/terminal/test/token-page/run.mjs [--shots <dir>] [--only <id,id>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { rowFaults } from "../../../../scripts/live-checks/app-launchpad-badges.mjs";
import { FIXTURE_NOW_MS, TOKENS } from "./fixtures.ts";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HELPER = "https://api.confidential.unrealized.trade";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const onlyAt = args.indexOf("--only");
const ONLY = onlyAt >= 0 ? new Set(args[onlyAt + 1].split(",")) : null;

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  // the chart's desktop at the fit's narrower width (card app-token-chart)
  { name: "1280", viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
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
  // the chart (card app-token-chart): GeckoTerminal's bars by default (the label shows), our own (no label), none, a
  // failed read, and a read that never ends (the skeleton)
  { id: "chart-chain", top: "pool", state: "ready", curve: false, candles: "chain" },
  { id: "chart-empty", top: "pool", state: "ready", curve: false, candles: "empty" },
  { id: "chart-error", top: "pool", state: "ready", curve: false, candles: 503 },
  { id: "chart-loading", top: "pool", state: "ready", curve: false, candles: "hang" },
  // the chart is live (card app-chart-live): the helper's own bars (own_from_s), read again every LIVE_MS; a planted
  // trade moves the last bar within one tick, with no reload; and the same live reads answered 503 keep the bars drawn
  { id: "chart-live", top: "pool", state: "ready", curve: false, candles: "live" },
  { id: "chart-live-503", top: "pool", state: "ready", curve: false, candles: "live503" },
];
/** The page's live read interval (src/screens/token/candles.ts LIVE_MS). */
const LIVE_MS = 1_000;

// The fake helper's chart clock: the run's own, or for the planted run (TOKEN_PAGE_CLOCK_EDGE_MS=<ms>, card
// chart-test-clock-pin) set at each state's first chart read to that many ms before the next 15-minute bar opens, so the
// state's later reads land past the boundary:
//   TOKEN_PAGE_CLOCK_EDGE_MS=2000 node apps/terminal/test/token-page/run.mjs --only chart-live-503,chart-live
const EDGE_MS = Number(process.env.TOKEN_PAGE_CLOCK_EDGE_MS ?? 0);
const BOUNDARY_MS = 900_000;
let skewMs = 0;
const chartNow = () => Date.now() + skewMs;
/** The bars' end, read off the chart clock once, at the run's first chart read: every later read, in any state and past
 *  any bar's boundary, answers the same bars (a clock read per answer gave a new last bar once a run crossed a 15-minute
 *  boundary, and chart-live and chart-live-503 failed with no fault in the page). */
let endS = null;

/** CANDLE_COUNT bars of a 15m walk ending at the run's one end time, around `p` (a price string), as the helper's answer. */
const CANDLE_COUNT = 160;
function candles(p, tf) {
  const step = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[tf];
  const base = Number(p) > 0 ? Number(p) : 0.0000273;
  endS ??= Math.floor(chartNow() / 1000);
  const end = Math.floor(endS / step) * step;
  const out = [];
  let c = base;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const o = c;
    c = base * (1 + 0.25 * Math.sin(i / 9) + 0.08 * Math.sin(i * 1.7));
    const hi = Math.max(o, c) * 1.02;
    const lo = Math.min(o, c) * 0.98;
    const f = (x) => x.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    out.push([end - (CANDLE_COUNT - 1 - i) * step, f(o), f(hi), f(lo), f(c), String(200 + ((i * 37) % 23) * 90)]);
  }
  return out;
}

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
  if (url.pathname === "/v1/market/candles") {
    if (EDGE_MS && !calls.edged) {
      calls.edged = true;
      const t = Date.now();
      skewMs = Math.ceil((t + EDGE_MS) / BOUNDARY_MS) * BOUNDARY_MS - EDGE_MS - t;
    }
    if (s.candles === "hang") return "hang";
    if (typeof s.candles === "number") return json(s.candles, { error: "unavailable" });
    const row = live(s.top);
    if (url.searchParams.get("token") !== row.token) return json(404, { error: { code: "not_found" } });
    const tf = url.searchParams.get("tf");
    const own = s.candles === "live" || s.candles === "live503";
    const src = s.candles === "chain" || own ? "chain" : "geckoterminal";
    let bars = s.candles === "empty" ? [] : candles(row.price_usd, tf);
    if (own && url.searchParams.get("limit") !== "500") {
      // a live read: the newest bars, the last one moved by the planted trade once there is one
      calls.live++;
      if (s.candles === "live503") return json(503, { error: { code: "upstream" } });
      bars = bars.slice(-Number(url.searchParams.get("limit")));
      if (calls.plant !== null) {
        const [t, o, h, l] = bars.at(-1);
        bars[bars.length - 1] = [t, o, String(Math.max(Number(h), Number(calls.plant))), l, calls.plant, "999999"];
      }
    }
    const a = json(200, { tf, candles: bars, src, ...(own && bars.length ? { own_from_s: bars[0][0] } : {}), as_of_ms: Date.now() });
    a.headers["x-helper-source"] = src;
    a.headers["access-control-expose-headers"] = "X-Helper-Source";
    return a;
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
/** The plot's size per width over the same token's ready states: one size, whatever the chart's state (CLS 0). */
const plots = new Map();
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
  const consoles = [];
  page.on("console", (m) => m.type() === "error" && consoles.push(`${m.text()} (${m.location()?.url?.split("?")[0] ?? ""})`));
  await page.goto(`${APP_HOST}/${s.query ?? ""}`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`${w.name} ${s.id}: no APP_HOST frame inside the shell (top at ${page.url()})`);
  await f.waitForSelector(`main[data-route="token"] [data-token-page="${s.state}"]`, { timeout: 10_000 }).catch(() => {});
  return { ctx, page, f, errors, consoles };
}

const dir = await build();
const route = await harnessRoute(dir, "signed");
const browser = await launchBrowser("chromium");
let n = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.name === "390";
    for (const s of STATES) {
      if (ONLY && !ONLY.has(s.id)) continue;
      n++;
      const tag = `${s.id} @${w.name}`;
      const calls = { lists: 0, live: 0, plant: null, edged: false };
      const { ctx, page, f, errors, consoles } = await openAt(browser, route, w, s, calls);
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
        // the design's tiles (design-lock-r5 token.js U.header, token-390.html): Liquidity reads In curve on the curve
        // token, and a Tax tile at both widths
        const liq = (await f.locator(`${box} [data-k="liq"] .tkp-lbl`).textContent())?.trim();
        check(liq === (s.curve ? "In curve" : "Liquidity"), `${tag}: the liquidity tile reads ${liq}`);
        check((await f.locator(`${box} [data-k="tax"]`).count()) === 1, `${tag}: no Tax tile`);
        if (!phone) {
          // the strip ends before the trade column and no tile is cut (seen 3 Nov: "Bon…" under the trade column)
          const st = await f.evaluate(() => {
            const strip = document.querySelector(".tkp-desk .tkp-strip")?.getBoundingClientRect();
            const trade = document.querySelector(".tkp-desk .tkp-trade")?.getBoundingClientRect();
            const cut = [...document.querySelectorAll(".tkp-desk .tkp-strip > *, .tkp-desk .tkp-strip .tkp-val, .tkp-desk .tkp-strip .tkp-lbl")].filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent.trim());
            return { right: strip?.right ?? Infinity, tradeLeft: trade?.left ?? -Infinity, cut };
          });
          check(st.right <= st.tradeLeft, `${tag}: the strip runs under the trade column (right ${st.right} > ${st.tradeLeft})`);
          check(st.cut.length === 0, `${tag}: strip tiles cut: ${JSON.stringify(st.cut)}`);
        } else {
          // the design's phone row: back, star, share
          const nav = await f.$$eval(".tkp-nav button", (bs) => bs.map((b) => b.getAttribute("aria-label")));
          check(nav.length === 3 && nav[0] === "Back" && /watchlist$/.test(nav[1] ?? "") && nav[2] === "Share", `${tag}: the phone row reads ${JSON.stringify(nav)}`);
        }
        // the origin badges: the fixture's pad (or none) bottom-right, its chain top-right, loaded, named, not cut
        const drawnRow = await f.evaluate(async (box) => {
          await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
          const root = document.querySelector(box);
          const av = root?.querySelector(".tok-avw");
          if (!av) return null;
          // cut: outside the nearest box that clips its content, or the viewport
          let c = null;
          for (let p = av.parentElement; p && !c; p = p.parentElement) if (getComputedStyle(p).overflow !== "visible") c = p.getBoundingClientRect();
          c ??= { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
          const g = (sel, at) => {
            const e = av.querySelector(sel);
            if (!e) return null;
            const i = e.querySelector("img");
            const r = e.getBoundingClientRect();
            return { id: e.getAttribute(at), title: e.getAttribute("title"), loaded: !!i && i.complete && i.naturalWidth > 0, out: r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5 || r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.width < 9.5 };
          };
          const pad = g(".tok-pb", "data-pad");
          const chain = g(".tok-cb", "data-chain");
          const clipped = [pad?.out && "launchpad badge cut by its box", chain?.out && "chain badge cut by its box"].filter(Boolean);
          const texts = [...root.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.getClientRects().length && !e.closest(".tok-av")).map((e) => e.textContent.trim()).filter(Boolean);
          const strip = (b) => (b ? { id: b.id, title: b.title, loaded: b.loaded } : null);
          return { pad: strip(pad), chain: strip(chain), texts, clipped };
        }, box);
        check(drawnRow !== null, `${tag}: no avatar with badges`);
        if (drawnRow) {
          // the launchpad and chain of the row the helper answered (live(): the route reads Solana only)
          const row = live(s.top);
          const faults = rowFaults({ ...drawnRow, served: { launchpad: row.launchpad, chain: row.chain } });
          check(faults.length === 0, `${tag}: badges: ${faults.join("; ")}`);
        }
        // the chart: its state, every fixture bar drawn, CoinGecko's label only over GeckoTerminal's bars, and the plot
        // the same size in every state (CLS 0)
        const want = s.candles === undefined || s.candles === "chain" || s.candles === "live" || s.candles === "live503" ? "ready" : s.candles === "empty" ? "empty" : s.candles === "hang" ? "loading" : "error";
        await f.waitForSelector(`${box} [data-chart="${want}"]`, { timeout: 8_000 }).catch(() => {});
        const ch = await f.evaluate((box) => {
          const c = document.querySelector(`${box} [data-chart]`);
          const plot = c?.querySelector(".tkp-plot")?.getBoundingClientRect();
          return { state: c?.getAttribute("data-chart"), bars: c?.querySelector("[data-testid=chart-canvas]")?.getAttribute("data-bars") ?? null, vendor: !!c?.querySelector("[data-testid=chart-vendor]"), canvases: c?.querySelectorAll("canvas").length ?? 0, h: plot?.height ?? 0, w: plot?.width ?? 0 };
        }, box);
        check(ch.state === want, `${tag}: the chart reads ${ch.state}, want ${want}`);
        if (want === "ready") {
          check(ch.bars === String(CANDLE_COUNT), `${tag}: the chart drew ${ch.bars} bars, want ${CANDLE_COUNT}`);
          check(ch.canvases > 0, `${tag}: no canvas in the chart`);
        }
        check(ch.vendor === (want === "ready" && !["chain", "live", "live503"].includes(s.candles)), `${tag}: CoinGecko's label ${ch.vendor ? "shown" : "not shown"}`);
        if (s.candles === "live" || s.candles === "live503") {
          const read = () => f.evaluate((box) => {
            const c = document.querySelector(`${box} [data-testid=chart-canvas]`);
            return { bars: c?.getAttribute("data-bars"), last: c?.getAttribute("data-last") ?? "", close: document.querySelector(`${box} [data-k="lgC"] [data-dir]`)?.textContent ?? "" };
          }, box);
          const before = await read();
          if (s.candles === "live") {
            // a planted trade: the last bar's close 5% up; the chart's own last bar must show it within one tick
            const [, c0] = before.last.split(":");
            calls.plant = (Number(c0) * 1.05).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
            const t0 = Date.now();
            let after = before;
            while (Date.now() - t0 < 3 * LIVE_MS && !after.last.endsWith(`:${Number(calls.plant)}`)) {
              await f.waitForTimeout(50);
              after = await read();
            }
            const ms = Date.now() - t0;
            check(after.last.endsWith(`:${Number(calls.plant)}`) && ms <= LIVE_MS + 1_000, `${tag}: the planted trade (close ${calls.plant}) reached the last bar in ${ms} ms (${after.last}), want within one tick (${LIVE_MS} ms and the read)`);
            check(after.bars === before.bars && after.last.split(":")[0] === before.last.split(":")[0], `${tag}: the live read redrew the chart: ${before.bars} bars at ${before.last} -> ${after.bars} at ${after.last}`);
            check(after.close !== before.close, `${tag}: the legend's close stayed ${before.close}`);
            console.log(`${tag}: planted close ${calls.plant} drawn on the last bar in ${ms} ms; legend close ${before.close} -> ${after.close}; ${calls.live} live reads`);
          } else {
            await f.waitForTimeout(4 * LIVE_MS);
            const after = await read();
            check(after.last === before.last && after.bars === before.bars, `${tag}: a 503 moved the bars: ${before.last} -> ${after.last}`);
            // reads at 1 s, then 2 s and 4 s later (the wait doubles): 2 in the first 4 s
            check(calls.live >= 1 && calls.live <= 3, `${tag}: ${calls.live} live reads in ${4 * LIVE_MS} ms of 503s`);
            console.log(`${tag}: ${calls.live} live reads answered 503 in ${4 * LIVE_MS} ms; bars kept at ${after.last}`);
          }
          check(errors.length === 0, `${tag}: page errors after the live reads: ${errors.join(" | ")}`);
          // the page itself logs nothing; Chrome writes its own line for every response that is not a 2xx, which no page
          // code can stop (the card's hand-back names the helper change that would): held to one per failed live read
          const net = consoles.filter((c) => /^Failed to load resource: the server responded with a status of 503 .*\(https:\/\/api\.confidential\.unrealized\.trade\/v1\/market\/candles\)$/.test(c));
          const own = consoles.filter((c) => !net.includes(c));
          check(own.length === 0, `${tag}: console errors: ${own.join(" | ")}`);
          check(net.length === (s.candles === "live503" ? calls.live : 0), `${tag}: ${net.length} browser network lines for ${calls.live} live reads`);
          if (net.length) console.log(`${tag}: the browser's own network line, once per 503 live read: ${net.length}`);
        }
        check(ch.h >= (phone ? 299 : 300) && ch.w > 300, `${tag}: the plot is ${Math.round(ch.w)}x${Math.round(ch.h)}`);
        if (s.top === "pool") plots.set(w.name, [...(plots.get(w.name) ?? []), `${s.id}:${Math.round(ch.w)}x${Math.round(ch.h)}`]);
        if (phone) {
          const g = await f.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const r = (q) => document.querySelector(q)?.getBoundingClientRect();
            const tiles = [...document.querySelectorAll(".tkp-mtile")].map((e) => e.getBoundingClientRect().bottom);
            return { bar: r(".tkp-bottom"), tab: r(".tabbar"), lastTile: Math.max(...tiles), row: (() => {
              // R5 .mtiles: the tile row is its own sideways scroller inside the page; every tile is reachable in it
              const row = document.querySelector(".tkp-mtiles");
              const box = row.getBoundingClientRect();
              const ox = getComputedStyle(row).overflowX;
              // the tiles sit in order: the first in the row's box at the start, the last in it at the end of the scroll
              const first = row.querySelector(".tkp-mtile:first-child").getBoundingClientRect().left;
              row.scrollLeft = row.scrollWidth;
              const last = row.querySelector(".tkp-mtile:last-child").getBoundingClientRect().right;
              const scrolled = row.scrollLeft;
              row.scrollLeft = 0;
              return { left: box.left, right: box.right, ox, first, last, scrolled };
            })(), vw: window.innerWidth };
          });
          check(g.bar && g.tab && g.bar.bottom <= g.tab.top + 0.5, `${tag}: the bottom bar overlaps the tab bar`);
          check(g.row.left >= 0 && g.row.right <= g.vw + 0.5 && ["auto", "scroll"].includes(g.row.ox), `${tag}: the tile row is not its own scroller (${JSON.stringify(g.row)})`);
          check(g.row.first >= g.row.left - 0.5 && g.row.last <= g.row.right + 0.5, `${tag}: tiles out of reach in the row: ${JSON.stringify(g.row)}`);
          check(g.bar && g.lastTile <= g.bar.top, `${tag}: the last tile ends under the bottom bar (${g.lastTile} > ${g.bar?.top})`);
          await f.evaluate(() => window.scrollTo(0, 0));
        }
      } else {
        check((await f.locator(".tkp-bottom").count()) === 0, `${tag}: the bottom bar shows with no token`);
      }
      if (drawn && s.state === "error") {
        if (phone) {
          // BAR-10 (app.md:1108), measured as app-shell.mjs measures it: the box, or an absolute ::before/::after hit box
          const tap = await f.$eval(".tkp-retry", (b) => {
            const r = b.getBoundingClientRect();
            let w = r.width;
            let h = r.height;
            for (const ps of ["::before", "::after"]) {
              const cs = getComputedStyle(b, ps);
              if (cs.content && cs.content !== "none" && cs.position === "absolute") {
                w = Math.max(w, parseFloat(cs.width) || 0);
                h = Math.max(h, parseFloat(cs.height) || 0);
              }
            }
            return { w, h };
          });
          check(tap.w >= 43.5 && tap.h >= 43.5, `${tag}: the Retry tap target is ${Math.round(tap.w)}x${Math.round(tap.h)}, under 44 x 44`);
        }
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

for (const [wn, sizes] of plots) {
  const one = new Set(sizes.map((x) => x.split(":")[1]));
  check(one.size === 1, `@${wn}: the plot changes size with the chart's state: ${sizes.join(" ")}`);
}
for (const [d, ids] of [...drafts].sort()) console.log(`draft copy: ${d} (${[...ids].join(", ")})`);
if (refused.size) console.log(`refused off-host requests (the shell's): ${[...refused].join(" ")}`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} states`);
  process.exit(1);
}
console.log(`PASS ${n} states (${STATES.length} at 390, 1440 and 1280) from the built app at the token route inside the stand-in shell${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
