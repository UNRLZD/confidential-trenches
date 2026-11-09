#!/usr/bin/env node
// The terminal's BAR-10 run (card app-discover-bar10; BAR-10, app.md:1105): app-shell's own rules (scripts/live-checks/
// app-shell.mjs collect() and judge(), the same code the deployed check runs) on the built app, before a merge. The app
// is built with its own vite config and served on 127.0.0.1 under its shipped _headers (the CSP and Integrity-Policy)
// with the app's history fallback. Every routed path (routes.ts) is opened at 390 x 844 (phone, dpr 2, touch) and
// 1440 x 900 (desktop, dpr 1) and judged by app-shell: no text under 11 px, on the phone no tap target under 44 px
// (a ::before or ::after hit box counts), no horizontal scroll, no CSP violation, no console error, CLS, integrity.
// The terminal runs only inside SIGN_HOST's shell (a top-level visit moves there), so the run answers the hosts' real
// names from local files as app-in-shell.mjs --harness does: APP_HOST the build under its _headers, SIGN_HOST the
// stand-in shell, signed in; every read is of the terminal's frame inside the shell. Discover reads its lists from
// HELPER_HOST, which answers APP_HOST's origin only, so the run answers that one read with a snapshot of the screen's
// fixtures (the recorded Solana read, with its edge rows): every row kind Discover draws is on screen; the token route's
// read of the top Trending token is answered with that token's row of the same answer. A screen that
// breaks BAR-10 fails here, not after a deploy.
// The shell's rules are read twice: with every answer at once, and with the answers late (LATE), so the lists and the
// signing page's state land while the run clicks through the shell. A screen that moves when an answer is slow (card
// app-shell-cls-zero: CI's "CLS 0.0010 inside the shell" on 1 Nov, the phone tabs and the header) then fails every
// run, not only on a slow runner.
//   node apps/terminal/test/bar10/run.mjs [--shots <dir>] [--record <file>] [--outage footer|solana|base|robinhood]
//     PASS exit 0, FAIL exit 1
// --record writes the answers-at-once read to <file> for app-shell.test.mjs to replay through judge().
// --outage makes a real RPC outage in the browser's own requests (app-shell.mjs withOutage, card
// app-shell-rpc-outage-judge) so the recorded read holds the failed loads and the rows the page draws for them.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { collect, INIT, judge, MEASURE, WIDTHS, withOutage } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { edgy, solana } from "../discover-screens/snapshots.ts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : undefined;
const recordAt = args.indexOf("--record");
const RECORD = recordAt >= 0 ? path.resolve(args[recordAt + 1]) : undefined;
const outageAt = args.indexOf("--outage");
const OUTAGE = outageAt >= 0 ? args[outageAt + 1] : undefined;

const LISTS_URL = "https://ct-api.unrealized.trade/v1/market/lists?chain=solana";
const isTokenRead = (u) => u.origin === "https://ct-api.unrealized.trade" && u.pathname === "/v1/market/token";
const isCandleRead = (u) => u.origin === "https://ct-api.unrealized.trade" && u.pathname === "/v1/market/candles";
const isTradesRead = (u) => u.origin === "https://ct-api.unrealized.trade" && u.pathname === "/v1/market/trades";

/** The helper's answer: every list of the fixtures, edge rows after the recorded ones; New also holds the rows on a
 *  curve, as the live one does, so the percent pills are on its first screen. */
const answer = (() => {
  const L = {};
  for (const k of ["new", "trending_5m", "trending_1h", "graduating"]) L[k] = [...(solana.lists[k] ?? []), ...(edgy.lists[k] ?? [])];
  L.new = [...(solana.lists.graduating ?? []), ...L.new];
  return { chain: "solana", as_of_ms: solana.as_of_ms, lists: { new: L.new, trending: L.trending_1h, trending_5m: L.trending_5m, trending_1h: L.trending_1h, graduating: L.graduating } };
})();

/** The late pass: the helper's lists 200 ms after the ask (after /discover's first paint, before the next click 400 ms
 *  on); every message from the shell held until 2,600 ms after the terminal's load (the click-through starts 2,000 ms
 *  after it), so the signing page's ready and state land mid-way through it, at any runner speed. */
const LATE = { helperMs: 200, shellMs: 2_600 };

/** Runs in every frame before its own code; in the terminal's frame it holds each "message" event (the shell's ready
 *  and answers) until `ms` after the frame's load, then hands them on in order. */
const HOLD_SHELL = ({ app, ms }) => {
  if (location.origin !== app) return;
  const held = [];
  let open = false;
  const wrapped = new WeakMap();
  const add = window.addEventListener;
  const remove = window.removeEventListener;
  window.addEventListener = function (type, fn, opts) {
    if (type !== "message" || typeof fn !== "function") return add.call(this, type, fn, opts);
    if (!wrapped.has(fn)) wrapped.set(fn, (e) => (open ? fn.call(window, e) : held.push(() => fn.call(window, e))));
    return add.call(this, type, wrapped.get(fn), opts);
  };
  window.removeEventListener = function (type, fn, opts) {
    return remove.call(this, type, (type === "message" && wrapped.get(fn)) || fn, opts);
  };
  add.call(window, "load", () =>
    setTimeout(() => {
      open = true;
      for (const deliver of held.splice(0)) deliver();
    }, ms),
  );
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-bar10-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

/** Discover's other states (Offline with Retry, No tokens), which the shell run does not reach: the same rules on
 *  /discover with the helper refusing, and with it answering no rows. */
async function states(browser, route, prepare) {
  const bad = [];
  for (const [name, reply] of [["offline", { status: 503, contentType: "application/json", body: "{}" }], ["no tokens", { status: 200, contentType: "application/json", body: JSON.stringify({ ...answer, lists: { new: [], trending: [], trending_5m: [], trending_1h: [], graduating: [] } }) }]]) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      await ctx.route("**/*", route);
      await ctx.addInitScript(INIT);
      await prepare(ctx);
      await ctx.route(LISTS_URL, (r) => r.fulfill({ ...reply, headers: { "access-control-allow-origin": APP_HOST } }));
      const page = await ctx.newPage();
      await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
      // the terminal's frame inside the shell
      let f = null;
      for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
        f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
        if (!f) await page.waitForTimeout(100);
      }
      if (!f) throw new Error(`${w.name} /discover, ${name}: no APP_HOST frame inside the shell (top at ${page.url()})`);
      await f.waitForSelector(`.dsc [data-state="${name === "offline" ? "S5.5" : "S5.3"}"]`, { state: "attached", timeout: 15_000 });
      await f.evaluate(() => document.fonts.ready);
      const m = await f.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      const found = [m.hscroll && "horizontal scroll", m.smallText.length && `text under 11 px: ${m.smallText.join(", ")}`, m.smallTaps.length && `tap under 44 px: ${m.smallTaps.join(", ")}`].filter(Boolean);
      console.log(`${found.length ? "BAD" : "ok "} ${w.name} /discover, ${name}: ${found.join("; ") || "no horizontal scroll, no text under 11 px, no tap under 44 px"}`);
      if (found.length) bad.push(`${w.name} ${name}`);
      await ctx.close();
    }
  }
  return bad.length === 0;
}

const dir = await build();
let code = 1;
try {
  const harness = await harnessRoute(dir, "signed");
  const route = OUTAGE ? withOutage(harness, OUTAGE) : harness;
  // the bytes served for a script are the build's own file at its path
  const fetchFn = async (u) => new Response(readFileSync(path.join(dir, decodeURIComponent(new URL(u).pathname))));
  // `late`: the answers come late (LATE); a page closed meanwhile drops its answer, which is no fault of the screen
  const answering = (late) => async (ctx) => {
    // the sign-in hint (card app-header-first-paint-auth, src/screens/signin/hint.ts) as a signed-in session leaves it:
    // written "in" in APP_HOST's storage when the snapshot first held signed in, so each load is a signed-in reload
    await ctx.addInitScript(({ app }) => {
      if (location.origin === app) localStorage.setItem("ct-signin-hint", "in");
    }, { app: APP_HOST });
    if (late) await ctx.addInitScript(HOLD_SHELL, { app: APP_HOST, ms: LATE.shellMs });
    await ctx.route(LISTS_URL, async (r) => {
      if (late) await wait(LATE.helperMs);
      await r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": APP_HOST }, body: JSON.stringify(answer) }).catch(() => {});
    });
    // the token route (/) reads the top of these lists' Trending column: answered as the helper answers a listed token,
    // its page row being Discover's own row (apps/helper/src/data/solana/token.ts), so / draws it with no failed load
    await ctx.route(isTokenRead, async (r) => {
      if (late) await wait(LATE.helperMs);
      const u = new URL(r.request().url());
      const row = Object.values(answer.lists).flat().find((x) => x.token === u.searchParams.get("token"));
      const body = row && u.searchParams.get("chain") === "solana" ? { row, decimals: 6, pool: null, risk: {}, route: "ok" } : { error: "unknown token" };
      await r.fulfill({ status: row ? 200 : 404, contentType: "application/json", headers: { "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) }).catch(() => {});
    });
    // and its chart's candles (card app-token-chart): 60 bars of the requested timeframe around the row's price, our own
    // source, so the token page's chart draws with no failed load too
    await ctx.route(isCandleRead, async (r) => {
      if (late) await wait(LATE.helperMs);
      const u = new URL(r.request().url());
      const tf = u.searchParams.get("tf");
      const step = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[tf] ?? 900;
      const row = Object.values(answer.lists).flat().find((x) => x.token === u.searchParams.get("token"));
      const p = Number(row?.price_usd) > 0 ? Number(row.price_usd) : 0.001;
      const end = Math.floor(Date.now() / 1000 / step) * step;
      const f = (x) => x.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
      const candles = Array.from({ length: 60 }, (_, i) => {
        const o = p * (1 + 0.1 * Math.sin(i / 5));
        const c = p * (1 + 0.1 * Math.sin((i + 1) / 5));
        return [end - (59 - i) * step, f(o), f(Math.max(o, c) * 1.01), f(Math.min(o, c) * 0.99), f(c), String(100 + i * 10)];
      });
      await r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": APP_HOST, "access-control-expose-headers": "X-Helper-Source", "x-helper-source": "chain" }, body: JSON.stringify({ tf, candles, src: "chain", as_of_ms: Date.now() }) }).catch(() => {});
    });
    // and its tape (card app-chart-controls, the chart's trade marks): a token whose book holds no trades yet, so the
    // chart draws no marks and the page makes no failed load
    await ctx.route(isTradesRead, async (r) => {
      if (late) await wait(LATE.helperMs);
      await r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": APP_HOST }, body: JSON.stringify({ trades: [], src: "chain", as_of_ms: Date.now() }) }).catch(() => {});
    });
  };
  const prepare = answering(false);
  let ok = true;
  let loads = 0;
  for (const late of [false, true]) {
    const rec = await collect({ url: APP_HOST, shots: SHOTS && (late ? path.join(SHOTS, "late") : SHOTS), fetchFn, route, prepare: answering(late), source: `bar10, the build inside the stand-in shell, answers ${late ? "late" : "at once"}${OUTAGE ? `, ${OUTAGE} RPC answering 503` : ""}` });
    const j = judge(rec);
    // the answers-at-once read, as app-shell.mjs --record writes it: the shell check's recorded good answer
    if (RECORD && !late) writeFileSync(RECORD, `${JSON.stringify(rec, null, 1)}\n`);
    console.log(`-- answers ${late ? `late (the lists ${LATE.helperMs} ms, the shell ${LATE.shellMs} ms after the terminal's load)` : "at once"}`);
    for (const l of j.lines) console.log(l);
    ok &&= j.ok;
    loads += rec.loads.length;
  }
  const browser = await launchBrowser("chromium");
  const okStates = await states(browser, route, prepare).finally(() => browser.close());
  console.log(`${ok && okStates ? "PASS" : "FAIL"} BAR-10 and the shell's rules on ${loads} loads (every routed path, 390 and 1440, answers at once and late) and Discover's offline and empty states${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
  code = ok && okStates ? 0 : 1;
} catch (e) {
  console.error(`ERROR ${e?.stack ?? e}`);
  code = 2;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
