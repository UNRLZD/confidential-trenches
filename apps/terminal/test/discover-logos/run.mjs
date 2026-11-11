#!/usr/bin/env node
// Discover's token logos and launchpad rings on mainnet rows (card discover-matches-the-main-app): page.tsx draws the
// helper's lists as served on 11 Nov 15:20Z (lists-2026-11-11.json: Solana, Base and Robinhood, the rows that pass the
// release word scan, ten pads and rows with no launchpad; page.tsx adds a New row for each ring-table pad New lacks),
// built with vite and served on 127.0.0.1.
// The helper's logo route is answered here: an image for every token, a 404 with no body for one (the helper's "no
// logo"). Checks, at 1440 x 900, 1024 x 768 and 390 x 844 (dpr 2, touch):
//   rings: every drawn row's ring is its launchpad's colour (pads.ts padRing), a row with no known pad keeps a stage
//     colour, the rows draw at least three pad colours, and every pad of the ring table is drawn in its own;
//   logos as served (icon false on every row): no logo request is made and every avatar draws its initials;
//   ?logos=1 (icon true on every row but one): every row in view draws its own loaded logo (naturalWidth > 0, shown),
//     the icon-false row asks for none and draws initials, the 404 row draws initials and no broken image, and no
//     avatar changes size when its logo arrives; a scrolled column loads the rows it brings into view; on the phone,
//     mid-scroll, no row shows from the Quick buy dock's top edge down to the tab bar;
//   1024: the four columns sit side by side in one row, as the main app's do from 1024 px.
//   node apps/terminal/test/discover-logos/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";
import { PAD_RING, padRing } from "../../src/screens/market/pads.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "1024", viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const LOGO = /^https:\/\/ct-api\.unrealized\.trade\/v1\/logo\/([a-z]+)\/([^/?#]+)$/;
// any real PNG stands in for a token's logo; the helper's answer is an image, which is all the screen reads
const PNG = readFileSync(path.join(HERE, "../../src/screens/market/logos/robinhood.png"));
// the token whose logo the stand-in helper has not (404, no body): the second row the page draws
const MISSING_AT = 1;
const STAGE = new Set(["var(--blue)", "var(--border-strong)", "var(--text-1)", "#bcbcbc", "#808080"]);

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-discover-logos-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    let body;
    try {
      body = readFileSync(file);
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

// runs in the page: each drawn row in view, with its ring, its pad, its avatar and its logo
const READ = (scope) => {
  const inView = (e) => {
    const b = e.getBoundingClientRect();
    return b.width > 0 && b.bottom > 0 && b.top < innerHeight;
  };
  return [...document.querySelectorAll(`${scope} [role="listitem"][data-token]`)].filter(inView).map((r) => {
    const av = r.querySelector(".tok-av");
    const img = av?.querySelector("img.tok-logo");
    const b = av?.getBoundingClientRect();
    return {
      token: r.getAttribute("data-token"),
      symbol: r.querySelector(".dsc-sym")?.textContent ?? "",
      ring: r.querySelector("svg[data-ring]")?.getAttribute("data-ring") ?? null,
      pad: r.querySelector(".tok-pb")?.getAttribute("data-pad") ?? null,
      av: b ? `${Math.round(b.width)}x${Math.round(b.height)}` : null,
      initials: (av?.firstChild?.nodeType === 3 ? av.firstChild.textContent : "") ?? "",
      img: img ? { loaded: img.getAttribute("data-loaded") === "true" && img.complete && img.naturalWidth > 0, shown: getComputedStyle(img).opacity === "1" } : null,
    };
  });
};
const scopeOf = (w) => (w === "390" ? ".dsc-phone" : ".dsc-grid");

async function open(browser, w, query, missing) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const asked = [];
  await ctx.route(LOGO, (route) => {
    const m = LOGO.exec(route.request().url());
    const token = decodeURIComponent(m[2]);
    asked.push(token);
    return token === missing.token ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ status: 200, contentType: "image/png", body: PNG, headers: { "cache-control": "public, max-age=86400" } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/${query}`);
  await page.waitForSelector(`${scopeOf(w.name)} [role="listitem"][data-token]`);
  return { ctx, page, asked, errors };
}

async function settle(page, scope) {
  // every logo in view has answered (loaded or failed): no image still waiting
  await page.waitForFunction((s) => [...document.querySelectorAll(`${s} img.tok-logo`)].every((i) => i.complete), scope, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(150);
}

let BASE;
const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchHarnessBrowser("chromium");
try {
  for (const w of WIDTHS) {
    const scope = scopeOf(w.name);
    const missing = { token: null };
    // as served: icon false on every row
    {
      const { ctx, page, asked, errors } = await open(browser, w, "", missing);
      await settle(page, scope);
      const rows = await page.evaluate(READ, scope);
      check(rows.length >= 3, `${w.name} as served: only ${rows.length} rows in view`);
      check(asked.length === 0, `${w.name} as served: ${asked.length} logo requests with icon false on every row`);
      check(rows.every((r) => r.img === null && r.initials.length > 0), `${w.name} as served: a row with no initials or with an image`);
      const colours = new Set();
      for (const r of rows) {
        const want = padRing(r.pad);
        if (want) {
          check(r.ring === want, `${w.name} ${r.symbol}: ring ${r.ring}, its pad ${r.pad}'s is ${want}`);
          colours.add(r.ring);
        } else check(STAGE.has(r.ring), `${w.name} ${r.symbol}: no known pad, ring ${r.ring} is not a stage colour`);
      }
      // every row drawn in the list, in view or not: at least three pad colours
      const drawn = await page.evaluate((s) => [...document.querySelectorAll(`${s} [role="listitem"][data-token] svg[data-ring]`)].map((e) => e.getAttribute("data-ring")), scope);
      const pads = new Set(drawn.filter((c) => !STAGE.has(c)));
      check(pads.size >= 3, `${w.name}: ${pads.size} pad ring colours drawn (${[...pads].join(", ")}), under 3`);
      // every pad of the ring table is drawn somewhere in the list, each in its own colour
      const byPad = await page.evaluate((s) => [...document.querySelectorAll(`${s} [role="listitem"][data-token]`)].map((r) => [r.querySelector(".tok-pb")?.getAttribute("data-pad") ?? null, r.querySelector("svg[data-ring]")?.getAttribute("data-ring") ?? null]), scope);
      for (const pad of Object.keys(PAD_RING)) check(byPad.some(([p, c]) => p === pad && c === padRing(pad)), `${w.name}: no row of ${pad} drawn in its ring colour`);
      if (w.name !== "390") check(colours.size >= 2, `${w.name}: ${colours.size} pad ring colours in view`);
      if (w.name === "1024") {
        const cols = await page.evaluate(() => [...document.querySelectorAll(".dsc-grid .dsc-col")].map((c) => c.getBoundingClientRect()).map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) })));
        check(cols.length === 4 && new Set(cols.map((c) => c.y)).size === 1 && new Set(cols.map((c) => c.x)).size === 4, `1024: the columns are not four in one row: ${JSON.stringify(cols)}`);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `served-${w.name}.png`) });
      check(errors.length === 0, `${w.name} as served: page errors ${errors.join(" | ")}`);
      await ctx.close();
    }
    // ?logos=1: icon true on every row but the first; the second's logo answers 404
    {
      const first = await (async () => {
        const { ctx, page } = await open(browser, w, "?logos=1", missing);
        const tokens = await page.evaluate((s) => [...document.querySelectorAll(`${s} [role="listitem"][data-token]`)].map((r) => r.getAttribute("data-token")), scope);
        const none = await page.evaluate(() => window.__noLogo);
        await ctx.close();
        return { none, missing: tokens.find((t) => t !== none) };
      })();
      missing.token = first.missing;
      const { ctx, page, asked, errors } = await open(browser, w, "?logos=1", missing);
      const before = await page.evaluate(READ, scope);
      await settle(page, scope);
      const rows = await page.evaluate(READ, scope);
      check(!asked.includes(first.none), `${w.name}: a logo was asked for the row with icon false`);
      for (const r of rows) {
        const was = before.find((b) => b.token === r.token);
        if (was) check(was.av === r.av, `${w.name} ${r.symbol}: the avatar went ${was.av} -> ${r.av} when its logo arrived`);
        if (r.token === first.none) check(r.img === null && r.initials.length > 0, `${w.name} ${r.symbol} (icon false): ${JSON.stringify(r.img)}, initials "${r.initials}"`);
        else if (r.token === missing.token) check(r.img === null && r.initials.length > 0, `${w.name} ${r.symbol} (404): ${JSON.stringify(r.img)}, initials "${r.initials}"`);
        else check(r.img?.loaded === true && r.img?.shown === true, `${w.name} ${r.symbol}: logo ${JSON.stringify(r.img)}`);
      }
      check(rows.some((r) => r.token === missing.token), `${w.name}: the 404 row is not in view`);
      // phone, mid-scroll: no row shows from the Quick buy dock's top edge down to the tab bar's (the dock sits on a band)
      if (w.name === "390") {
        await page.evaluate(() => window.scrollTo(0, 700));
        await page.waitForTimeout(200);
        const seen = await page.evaluate(() => {
          const dock = document.querySelector('[data-testid="m-dock-bar"]')?.getBoundingClientRect();
          const tabs = document.querySelector(".tabbar")?.getBoundingClientRect();
          if (!dock || !tabs) return ["no dock or tab bar"];
          const out = [];
          for (let y = Math.ceil(dock.top); y < tabs.top; y += 2)
            for (const x of [2, 8, innerWidth / 2, innerWidth - 8, innerWidth - 2])
              if (document.elementFromPoint(x, y)?.closest('[role="listitem"]')) out.push(`${x},${y}`);
          return out;
        });
        check(seen.length === 0, `390 mid-scroll: a row shows between the dock's top and the tab bar at ${seen.slice(0, 6).join(" ")}${seen.length > 6 ? ` and ${seen.length - 6} more` : ""}`);
      }
      // off-screen rows load as they come into view
      if (w.name !== "390") {
        await page.evaluate(() => document.querySelector('.dsc-grid .dsc-col[data-col="new"] .dsc-rows')?.scrollTo(0, 1e6));
      } else await page.evaluate(() => window.scrollTo(0, 1e6));
      await page.waitForTimeout(300);
      await settle(page, scope);
      const later = (await page.evaluate(READ, scope)).filter((r) => r.token !== first.none && r.token !== missing.token);
      check(later.length > 0 && later.every((r) => r.img?.loaded === true), `${w.name} scrolled: a row in view with no loaded logo: ${later.filter((r) => !r.img?.loaded).map((r) => r.symbol).join(",")}`);
      if (SHOTS) {
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          document.querySelector('.dsc-grid .dsc-col[data-col="new"] .dsc-rows')?.scrollTo(0, 0);
        });
        await settle(page, scope);
        await page.screenshot({ path: path.join(SHOTS, `logos-${w.name}.png`) });
      }
      check(errors.length === 0, `${w.name} logos: page errors ${errors.join(" | ")}`);
      console.log(`${w.name}: ${rows.length} rows in view, ${asked.length} logo requests`);
      await ctx.close();
    }
  }
} finally {
  console.log(browserLabel(browser));
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
for (const f of fails) console.log(`FAIL ${f}`);
console.log(fails.length ? `discover-logos: FAIL (${fails.length})` : "discover-logos: PASS");
process.exit(fails.length ? 1 : 0);
