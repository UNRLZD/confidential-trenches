#!/usr/bin/env node
// Every orders place says Coming soon (card app-orders-coming-soon; owner 10 Nov, owner-decisions row "Order of the
// returned feature groups": "on the UI we say coming soon"). Each place, at 390 x 844 (dpr 2, touch) and 1440 x 900:
//   buy-limit, buy-tpsl     the buy ticket's Limit and TP/SL tabs (test/trade-box's fixture page): the tab opens and
//                           draws `Coming soon` in the box's place;
//   buy-exit                the buy ticket's exit plan block: `Coming soon` where its switch was, nothing to focus;
//   sell-limit, sell-tpsl   the sell ticket's Limit and TP/SL tabs (test/sell-positions' fixture page);
//   token-orders            the token page's My orders tab (test/trade-box's ?page=1, the TokenPage), in R5's place;
//   portfolio-exit          Portfolio's TP/SL cell of each position with no exit plan (1440; the phone has no table);
//   portfolio-sheet-exit    the phone's position sheet, its Exit plan row (390): no button, `Coming soon`;
//   orders                  the Orders route, /orders of the built app inside the stand-in shell (app-in-shell.mjs
//                           harnessRoute), signed in and signed out, and on the phone reached from Portfolio's Orders tab.
// Per place: the words read `Coming soon` exactly, in the app's empty-state colour; no enabled, focusable order
// control in the place (only the tabs and the side switch may take focus there); no horizontal scroll; and no orders
// request leaves the page: a fake fetch (and XMLHttpRequest, sendBeacon and WebSocket) installed before the app's own
// code records every address the page asks, none may name an order, and no kit request the stubs record names one.
//   node apps/terminal/test/orders-soon/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TERMINAL = path.resolve(HERE, "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : mkdtempSync(path.join(tmpdir(), "ct-orders-soon-shots-"));
mkdirSync(SHOTS, { recursive: true });

export const SOON = "Coming soon";
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** An address or a kit request that names an order. */
const ORDER = /order/i;

/** The fake fetch, before any of the page's code: every address the page asks for is recorded, then asked as before. */
const FAKE_FETCH = () => {
  const asked = (window.__asked = []);
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return real(input, init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    asked.push(String(u));
    return open.call(this, m, u, ...rest);
  };
  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) navigator.sendBeacon = (u, d) => (asked.push(String(u)), beacon(u, d));
  const WS = window.WebSocket;
  window.WebSocket = new Proxy(WS, { construct: (T, a) => (asked.push(String(a[0])), new T(...a)) });
};

async function build(root, react = true) {
  const { build } = await import("vite");
  const plugins = react ? [(await import("@vitejs/plugin-react")).default()] : undefined;
  const out = mkdtempSync(path.join(tmpdir(), "ct-orders-soon-"));
  await build({ root, logLevel: "error", ...(plugins ? { plugins } : {}), build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const fails = [];
const passes = [];
const check = (ok, what) => (ok ? passes.push(what) : fails.push(what));

/** What a place reads: its words and colour, the focusable controls in it that are not tabs or the side switch. */
const READ_PLACE = ([place, scope]) => {
  const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const soon = [...document.querySelectorAll(`[data-testid="orders-soon"][data-place="${place}"]`)].filter(vis);
  const root = scope ? [...document.querySelectorAll(scope)].find(vis) : soon[0];
  const focusable = root
    ? [...root.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')]
        .filter((e) => vis(e) && !e.disabled && e.tabIndex >= 0)
        .filter((e) => !(e.getAttribute("role") === "tab" || e.classList.contains("trb-side")))
        .map((e) => `${e.tagName.toLowerCase()}${e.dataset.testid ? `[${e.dataset.testid}]` : ""}${e.dataset.control ? `[${e.dataset.control}]` : ""}: ${(e.textContent ?? "").trim().slice(0, 30)}`)
    : null;
  return {
    texts: soon.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()),
    color: soon[0] ? getComputedStyle(soon[0]).color : null,
    font: soon[0] ? parseFloat(getComputedStyle(soon[0]).fontSize) : null,
    focusable,
    scroll: document.scrollingElement.scrollWidth - innerWidth,
    asked: window.__asked ?? [],
    calls: (window.__calls ?? []).map((c) => JSON.stringify(c)),
  };
};

/** The Orders route's `Coming soon` against the page's screen, the part of main.screen in the window (card
 *  app-faults-seen-on-124: at 1440 it sat in the top third of an empty page, held there by a 60vh box). */
const CENTRE = () => {
  const box = (e) => e?.getBoundingClientRect() ?? null;
  const s = box(document.querySelector('main[data-route="orders"]'));
  const e = box([...document.querySelectorAll('main[data-route="orders"] [data-testid="orders-soon"]')].find((x) => x.getClientRects().length > 0));
  if (!s || !e) return null;
  const [top, bottom] = [Math.max(0, s.top), Math.min(innerHeight, s.bottom)];
  return { dx: Math.round(e.left + e.width / 2 - (s.left + s.width / 2)), dy: Math.round(e.top + e.height / 2 - (top + bottom) / 2) };
};
/** Centred in the screen, within 2 px across and 8 px down (the footer's and the phone bar's rounding). */
const centred = (tag, c) => check(c !== null && Math.abs(c.dx) <= 2 && Math.abs(c.dy) <= 8, `${tag}: Coming soon ${c ? `${c.dx} px across and ${c.dy} px down from the screen's centre` : "not drawn"}, want centred`);

/** The checks on one place's read. `count` is how many of the place the width draws. */
function judge(tag, r, { count = 1 } = {}) {
  check(r.texts.length === count && r.texts.every((t) => t === SOON), `${tag}: reads ${JSON.stringify(r.texts)}, want ${count} x ${JSON.stringify(SOON)}`);
  check(r.font !== null && r.font >= 11, `${tag}: the words at ${r.font} px, at least 11`);
  check(r.focusable !== null && r.focusable.length === 0, `${tag}: ${r.focusable === null ? "no place drawn" : r.focusable.length ? `focusable order controls: ${r.focusable.join("; ")}` : "no focusable order control"}`);
  check(r.scroll <= 0, `${tag}: ${r.scroll > 0 ? `${r.scroll} px of horizontal scroll` : "no horizontal scroll"}`);
  const orders = [...r.asked, ...r.calls].filter((u) => ORDER.test(u));
  check(orders.length === 0, `${tag}: ${orders.length ? `orders requests: ${orders.join(", ")}` : `no orders request (${r.asked.length} asked, ${r.calls.length} kit calls)`}`);
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const browser = await launchHarnessBrowser("chromium");
const dirs = [];
const servers = [];
try {
  const fx = {};
  for (const name of ["trade-box", "sell-positions", "portfolio"]) {
    const dir = await build(path.join(TERMINAL, "test", name));
    dirs.push(dir);
    const s = await serve(dir);
    servers.push(s);
    fx[name] = `http://127.0.0.1:${s.address().port}`;
  }
  const app = await build(TERMINAL, false);
  dirs.push(app);

  const page0 = async (w, url, route = null) => {
    const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
    await ctx.addInitScript(FAKE_FETCH);
    // the fixture pages answer from their own server only: any other address is refused, never sent to the network
    await ctx.route("**/*", route ?? ((r) => (r.request().url().startsWith("http://127.0.0.1:") ? r.continue() : r.abort())));
    const page = await ctx.newPage();
    const external = [];
    // the page's own address (a document: /orders is the route under test) is not a request the app makes
    page.on("request", (q) => q.resourceType() !== "document" && ORDER.test(q.url()) && external.push(q.url()));
    await page.goto(url);
    return { ctx, page, external };
  };
  const done = async (tag, p, r) => {
    check(p.external.length === 0, `${tag}: ${p.external.length ? `the browser sent orders requests: ${p.external.join(", ")}` : "the browser sent no orders request"}`);
    await p.ctx.close();
    return r;
  };

  for (const w of WIDTHS) {
    // the buy ticket: Limit and TP/SL, then the exit plan block on Market
    for (const tab of ["limit", "tpsl"]) {
      const p = await page0(w, `${fx["trade-box"]}/?f=ready`);
      await p.page.waitForSelector('[data-testid="trade-box"]');
      await p.page.click(`[data-testid="trade-box"] [data-tab="${tab}"]`, { timeout: 3_000 }).catch(() => {});
      const r = await p.page.evaluate(READ_PLACE, [`buy-${tab}`, '[data-testid="trade-box"]']);
      judge(`${w.name} buy-${tab}`, r);
      const cta = await p.page.locator('[data-testid="trade-box"] [data-testid="trade-cta"]').count();
      check(r.texts.length > 0 && cta === 0, `${w.name} buy-${tab}: ${cta ? "the main button is drawn under the tab" : "no main button under the tab"}`);
      await shot(p.page, `${w.name}-buy-${tab}`);
      await done(`${w.name} buy-${tab}`, p);
    }
    {
      const p = await page0(w, `${fx["trade-box"]}/?f=ready`);
      await p.page.waitForSelector('[data-testid="trade-box"]');
      judge(`${w.name} buy-exit`, await p.page.evaluate(READ_PLACE, ["buy-exit", '[data-testid="trade-exit"]']));
      await shot(p.page, `${w.name}-buy-exit`);
      await done(`${w.name} buy-exit`, p);
    }
    // the sell ticket
    for (const tab of ["limit", "tpsl"]) {
      const p = await page0(w, `${fx["sell-positions"]}/?f=up`);
      await p.page.waitForSelector('[data-testid="sell-box"]');
      await p.page.click(`[data-testid="sell-box"] [data-tab="${tab}"]`, { timeout: 3_000 }).catch(() => {});
      const r = await p.page.evaluate(READ_PLACE, [`sell-${tab}`, '[data-testid="sell-box"]']);
      judge(`${w.name} sell-${tab}`, r);
      const cta = await p.page.locator('[data-testid="sell-box"] [data-testid="sell-cta"]').count();
      check(r.texts.length > 0 && cta === 0, `${w.name} sell-${tab}: ${cta ? "the main button is drawn under the tab" : "no main button under the tab"}`);
      await shot(p.page, `${w.name}-sell-${tab}`);
      await done(`${w.name} sell-${tab}`, p);
    }
    // the token page's My orders tab, in the form the width shows
    {
      const p = await page0(w, `${fx["trade-box"]}/?page=1`);
      const lp = `${w.isMobile ? ".tkp-phone" : ".tkp-desk"} [data-testid="lower-panel"]`;
      await p.page.waitForSelector(lp, { timeout: 8_000 }).catch(() => {});
      const tabs = await p.page.$$eval(`${lp} [data-testid^="lower-tab-"]`, (els) => els.map((e) => e.textContent.trim().replace(/\(?[\d.,]+[KMB]?\)?$/, "")));
      const want = w.isMobile ? ["Trades", "Holders", "My orders"] : ["Holders", "Trades", "My orders"];
      check(JSON.stringify(tabs) === JSON.stringify(want), `${w.name} token-orders: the tabs read ${JSON.stringify(tabs)}, want ${JSON.stringify(want)}`);
      await p.page.click(`${lp} [data-testid="lower-tab-orders"]`, { timeout: 3_000 }).catch(() => {});
      judge(`${w.name} token-orders`, await p.page.evaluate(READ_PLACE, ["token-orders", lp]));
      // the phone's bottom bar sits 68 px up, over the shell's tab bar (token.css .tkp-bottom), and the shell's own 68 px
      // under the page (shell.css .shell) keeps the page's foot clear of it: this fixture page has no shell, so the shot
      // adds that room and scrolls to the end
      if (w.isMobile) {
        await p.page.addStyleTag({ content: "body { padding-bottom: 68px; }" });
        await p.page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      } else await p.page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), `${lp} [data-testid="orders-soon"]`);
      await shot(p.page, `${w.name}-token-orders`);
      await done(`${w.name} token-orders`, p);
    }
  }

  // Portfolio: the desktop's TP/SL cells (five R5 positions have no exit plan), then the phone's sheet on one of them
  {
    const w = WIDTHS[1];
    const p = await page0(w, `${fx.portfolio}/?f=rows`);
    await p.page.waitForSelector(".pfd tr[data-pos]", { timeout: 8_000 }).catch(() => {});
    judge("1440 portfolio-exit", await p.page.evaluate(READ_PLACE, ["portfolio-exit", '.pfd td:has([data-place="portfolio-exit"])']), { count: 5 });
    const add = await p.page.locator('[data-control="exit"]').count();
    check(add === 0, `1440 portfolio-exit: ${add ? `${add} Add exit plan buttons drawn` : "no Add exit plan button"}`);
    await shot(p.page, "1440-portfolio-exit");
    await done("1440 portfolio-exit", p);
  }
  {
    const w = WIDTHS[0];
    const p = await page0(w, `${fx.portfolio}/?f=rows`);
    await p.page.locator(".pfm .mpr", { hasText: "BLACKDRAGON" }).first().click({ timeout: 5_000 }).catch(() => {});
    await p.page.waitForSelector('[data-sheet="position"]', { timeout: 3_000 }).catch(() => {});
    const r = await p.page.evaluate(READ_PLACE, ["portfolio-sheet-exit", '[data-sheet="position"] [data-control="sheet-exit"]']);
    judge("390 portfolio-sheet-exit", r);
    const row = await p.page.$eval('[data-sheet="position"] [data-control="sheet-exit"]', (e) => ({ tag: e.tagName, tab: e.tabIndex })).catch(() => null);
    check(row !== null && row.tag !== "BUTTON" && row.tab < 0, `390 portfolio-sheet-exit: the Exit plan row is ${row ? `a ${row.tag} at tabIndex ${row.tab}` : "missing"} (no button, no focus)`);
    await shot(p.page, "390-portfolio-sheet-exit");
    await done("390 portfolio-sheet-exit", p);
  }

  // the Orders route in the built app, inside the stand-in shell: signed in and signed out, and from Portfolio's Orders tab
  const terminal = async (page) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(APP_HOST));
      if (f) {
        await f.waitForSelector("html[data-signpage]:not([data-signpage='connecting'])", { timeout: Math.max(1, until - Date.now()) }).catch(() => {});
        return f;
      }
      await page.waitForTimeout(100);
    }
    return null;
  };
  for (const kind of ["signed", "tap"]) {
    const route = await harnessRoute(app, kind);
    for (const w of WIDTHS) {
      const tag = `${w.name} orders (${kind === "tap" ? "signed out" : "signed in"})`;
      const p = await page0(w, `${APP_HOST}/orders`, route);
      const f = await terminal(p.page);
      if (!f) {
        check(false, `${tag}: no terminal frame`);
        await done(tag, p);
        continue;
      }
      await f.waitForSelector('main[data-route="orders"] [data-testid="orders-soon"]', { timeout: 8_000 }).catch(() => {});
      judge(tag, await f.evaluate(READ_PLACE, ["orders", 'main[data-route="orders"]']));
      centred(tag, await f.evaluate(CENTRE));
      await shot(p.page, `${w.name}-orders-${kind === "tap" ? "signed-out" : "signed-in"}`);
      await done(tag, p);
    }
  }
  {
    const w = WIDTHS[0];
    const tag = "390 orders from Portfolio's Orders tab";
    const p = await page0(w, `${APP_HOST}/portfolio`, await harnessRoute(app, "signed"));
    const f = await terminal(p.page);
    if (f) {
      await f.locator('[data-control="seg-orders"]').filter({ visible: true }).first().click({ timeout: 8_000 }).catch(() => {});
      await f.waitForSelector('main[data-route="orders"] [data-testid="orders-soon"]', { timeout: 8_000 }).catch(() => {});
      judge(tag, await f.evaluate(READ_PLACE, ["orders", 'main[data-route="orders"]']));
      centred(tag, await f.evaluate(CENTRE));
      await shot(p.page, "390-orders-from-portfolio");
    } else check(false, `${tag}: no terminal frame`);
    await done(tag, p);
  }
} finally {
  await browser.close();
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

for (const l of passes) console.log(`ok  ${l}`);
for (const l of fails) console.log(`BAD ${l}`);
console.log(`screenshots: ${SHOTS}`);
console.log(fails.length ? `FAIL ${fails.length} of ${passes.length + fails.length} checks (BAD lines above)` : `PASS ${passes.length} checks: every orders place says ${SOON}, nothing there can be focused or sends an orders request, at 390 and 1440 on ${browserLabel(browser)}`);
process.exit(fails.length ? 1 : 0);
