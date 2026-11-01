#!/usr/bin/env node
// The terminal's BAR-10 run (card app-discover-bar10; BAR-10, app.md:1105): app-shell's own rules (scripts/live-checks/
// app-shell.mjs collect() and judge(), the same code the deployed check runs) on the built app, before a merge. The app
// is built with its own vite config and served on 127.0.0.1 under its shipped _headers (the CSP and Integrity-Policy)
// with the app's history fallback. Every routed path (routes.ts) is opened at 390 x 844 (phone, dpr 2, touch) and
// 1440 x 900 (desktop, dpr 1) and judged by app-shell: no text under 11 px, on the phone no tap target under 44 px
// (a ::before or ::after hit box counts), no horizontal scroll, no CSP violation, no console error, CLS, integrity.
// Discover reads its lists from HELPER_HOST, which answers APP_HOST's origin only, so the run answers that one read with
// a snapshot of the screen's fixtures (the recorded Solana read, with its edge rows): every row kind Discover draws is
// on screen. SIGN_HOST's frame is answered with an empty page. A screen that breaks BAR-10 fails here, not after a
// deploy.
//   node apps/terminal/test/bar10/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect, INIT, judge, MEASURE, WIDTHS } from "../../../../scripts/live-checks/app-shell.mjs";
import { edgy, solana } from "../discover-screens/snapshots.ts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : undefined;

const LISTS_URL = "https://api.confidential.unrealized.trade/v1/market/lists?chain=solana";
const SIGN_HOST = "https://sign.confidential.unrealized.trade/";

/** The helper's answer: every list of the fixtures, edge rows after the recorded ones; New also holds the rows on a
 *  curve, as the live one does, so the percent pills are on its first screen. */
const answer = (() => {
  const L = {};
  for (const k of ["new", "trending_5m", "trending_1h", "graduating"]) L[k] = [...(solana.lists[k] ?? []), ...(edgy.lists[k] ?? [])];
  L.new = [...(solana.lists.graduating ?? []), ...L.new];
  return { chain: "solana", as_of_ms: solana.as_of_ms, lists: { new: L.new, trending: L.trending_1h, trending_5m: L.trending_5m, trending_1h: L.trending_1h, graduating: L.graduating } };
})();

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-bar10-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

/** _headers' one rule: the headers every path gets. */
function headersOf(dir) {
  const h = {};
  for (const line of readFileSync(path.join(dir, "_headers"), "utf8").split("\n")) {
    const m = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (m) h[m[1].toLowerCase()] = m[2];
  }
  return h;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
function serve(dir) {
  const headers = headersOf(dir);
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    // the app's history fallback: a path with no file extension is the app
    const file = path.join(dir, path.extname(p) ? p : "index.html");
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { ...headers, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/** Discover's other states (Offline with Retry, No tokens), which the shell run does not reach: the same rules on
 *  /discover with the helper refusing, and with it answering no rows. */
async function states(browser, base, prepare) {
  const bad = [];
  for (const [name, reply] of [["offline", { status: 503, contentType: "application/json", body: "{}" }], ["no tokens", { status: 200, contentType: "application/json", body: JSON.stringify({ ...answer, lists: { new: [], trending: [], trending_5m: [], trending_1h: [], graduating: [] } }) }]]) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      await ctx.addInitScript(INIT);
      await prepare(ctx);
      await ctx.route(LISTS_URL, (r) => r.fulfill({ ...reply, headers: { "access-control-allow-origin": base } }));
      const page = await ctx.newPage();
      await page.goto(`${base}/discover`, { waitUntil: "load" });
      await page.waitForSelector(`.dsc [data-state="${name === "offline" ? "S5.5" : "S5.3"}"]`, { state: "attached", timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      const found = [m.hscroll && "horizontal scroll", m.smallText.length && `text under 11 px: ${m.smallText.join(", ")}`, m.smallTaps.length && `tap under 44 px: ${m.smallTaps.join(", ")}`].filter(Boolean);
      console.log(`${found.length ? "BAD" : "ok "} ${w.name} /discover, ${name}: ${found.join("; ") || "no horizontal scroll, no text under 11 px, no tap under 44 px"}`);
      if (found.length) bad.push(`${w.name} ${name}`);
      await ctx.close();
    }
  }
  return bad.length === 0;
}

const dir = await build();
const server = await serve(dir);
const base = `http://127.0.0.1:${server.address().port}`;
let code = 1;
try {
  const prepare = async (ctx) => {
    await ctx.route(LISTS_URL, (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": base }, body: JSON.stringify(answer) }));
    await ctx.route(`${SIGN_HOST}**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>sign</title>" }));
  };
  const rec = await collect({ url: base, shots: SHOTS, prepare });
  const { ok, lines } = judge(rec);
  for (const l of lines) console.log(l);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const okStates = await states(browser, base, prepare).finally(() => browser.close());
  console.log(`${ok && okStates ? "PASS" : "FAIL"} BAR-10 and the shell's rules on ${rec.loads.length} loads (every routed path, 390 and 1440) and Discover's offline and empty states${SHOTS ? `; shots in ${SHOTS}` : ""}`);
  code = ok && okStates ? 0 : 1;
} catch (e) {
  console.error(`ERROR ${e?.stack ?? e}`);
  code = 2;
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
