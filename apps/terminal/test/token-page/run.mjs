#!/usr/bin/env node
// The token page's shots and checks (card app-token-page; AS-02, app.md:1356), taken from the built app at its route,
// not a test page: apps/terminal built with its own vite config and served on 127.0.0.1 with the app's history
// fallback, each fixture state opened at `/?fx=<name>` (src/screens/token/source.ts) at 390 x 844 (dpr 2, touch) and
// 1440 x 900 (dpr 1). Per shot: the token route drew the page in its state, no horizontal scroll, no text under 11 px
// in the page, the curve bar only on the curve token and the dash in the field elsewhere, and on the phone the bottom
// bar sits above the tab bar and the last tile scrolls clear of it and the curve tile is on screen without a sideways scroll. Requests off the page's host (the shell's hidden
// SIGN_HOST frame) are refused and listed. Draft words drawn are listed.
//   node apps/terminal/test/token-page/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// id, the URL's fx (none: the default), the page's state
const STATES = [
  { id: "S7.2-curve", fx: null, state: "ready", curve: true },
  { id: "S7.2-pool", fx: "pool", state: "ready", curve: false },
  { id: "S7.2-listed", fx: "listed", state: "ready", curve: false },
  { id: "S7.3-edges", fx: "edges", state: "ready", curve: false },
  { id: "S7.1-loading", fx: "loading", state: "loading" },
  { id: "empty", fx: "empty", state: "empty" },
  { id: "error", fx: "error", state: "error" },
];

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-token-page-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    // the app's history fallback: a path with no file extension is the app
    const file = path.join(dir, path.extname(p) ? p : "index.html");
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const fails = [];
const drafts = new Map();
const refused = new Set();
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

let BASE = "";
async function openAt(browser, w, fx) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.route((u) => !u.href.startsWith(BASE) && !u.href.startsWith("data:"), (r) => {
    refused.add(new URL(r.request().url()).origin);
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/${fx ? `?fx=${fx}` : ""}`);
  await page.waitForSelector('main[data-route="token"] [data-token-page]', { timeout: 10_000 }).catch(() => {});
  return { ctx, page, errors };
}

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import("playwright");
const browser = await chromium.launch();
let n = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.name === "390";
    for (const s of STATES) {
      n++;
      const tag = `${s.id} @${w.name}`;
      const { ctx, page, errors } = await openAt(browser, w, s.fx);
      const sel = `main[data-route="token"] [data-token-page="${s.state}"]`;
      const drawn = await page.locator(sel).first().isVisible().catch(() => false);
      check(drawn, `${tag}: ${sel} not drawn at the route`);
      check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(scroll <= 0, `${tag}: horizontal scroll ${scroll}px`);
      const small = await page.$$eval(".tkp *", (els) => els.filter((e) => e.getClientRects().length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())).map((e) => [e.textContent.trim().slice(0, 20), parseFloat(getComputedStyle(e).fontSize)]).filter(([, px]) => px < 10.95));
      check(small.length === 0, `${tag}: text under 11 px: ${JSON.stringify(small)}`);
      if (drawn && s.state === "ready") {
        const box = phone ? ".tkp-phone" : ".tkp-desk";
        const bars = await page.locator(`${box} [data-testid="curve-bar"]`).count();
        check(bars === (s.curve ? 1 : 0), `${tag}: ${bars} curve bars`);
        const field = (await page.locator(`${box} [data-k="curve"] .tkp-val`).textContent())?.trim();
        check(s.curve ? /^\d+%$/.test(field ?? "") : field === "—", `${tag}: the curve field reads ${field}`);
        if (phone) {
          const g = await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const r = (q) => document.querySelector(q)?.getBoundingClientRect();
            const tiles = [...document.querySelectorAll(".tkp-mtile")].map((e) => e.getBoundingClientRect().bottom);
            return { bar: r(".tkp-bottom"), tab: r(".tabbar"), lastTile: Math.max(...tiles), curveRight: r('.tkp-phone [data-k="curve"]')?.right ?? Infinity, vw: window.innerWidth };
          });
          check(g.bar && g.tab && g.bar.bottom <= g.tab.top + 0.5, `${tag}: the bottom bar overlaps the tab bar`);
          check(g.curveRight <= g.vw, `${tag}: the curve tile is off screen (right ${g.curveRight} > ${g.vw})`);
          check(g.bar && g.lastTile <= g.bar.top, `${tag}: the last tile ends under the bottom bar (${g.lastTile} > ${g.bar?.top})`);
          await page.evaluate(() => window.scrollTo(0, 0));
        }
      } else {
        check((await page.locator(".tkp-bottom").count()) === 0, `${tag}: the bottom bar shows with no token`);
      }
      if (drawn && s.state === "error") {
        await page.locator(".tkp-retry").click();
        check(await page.locator(sel).isVisible(), `${tag}: Retry lost the page`);
      }
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(s.id);
      }
      const label = await page.$eval("[data-token-page]", (e) => e.getAttribute("aria-label")).catch(() => null);
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
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy: ${d} (${[...ids].join(", ")})`);
if (refused.size) console.log(`refused off-host requests (the shell's): ${[...refused].join(" ")}`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} states`);
  process.exit(1);
}
console.log(`PASS ${n} states (${STATES.length} at 390 and 1440) from the built app at the token route${SHOTS ? `; shots in ${SHOTS}` : ""}`);
