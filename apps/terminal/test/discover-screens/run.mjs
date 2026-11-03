#!/usr/bin/env node
// Discover's shots and checks (card app-discover-solana; AS-02, app.md:1370-1375), after the sign-in screens' harness
// (test/signin-screens/run.mjs): the fixture page (page.tsx) built with vite and served on 127.0.0.1, every state at
// 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), dark and light colour schemes (the terminal is dark only). Per shot:
// the state's marker is on screen, no horizontal scroll, no request off the page's host, no row wider than its column,
// hostile token text drawn as text, and the draft words drawn are listed. At 1440 each column shows 9 full rows (S5.7).
// Behaviour: the phone tabs switch the one list; Retry on S5.5 asks the caller to read again.
//   node apps/terminal/test/discover-screens/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ, rowFaults } from "../../../../scripts/live-checks/app-launchpad-badges.mjs";
import { edgy, solana } from "./snapshots.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const SCHEMES = ["dark", "light"];
const box = (w) => (w === "390" ? ".dsc-phone" : ".dsc-grid");

// id, fixture, the phone tab to open, the marker that must show
const SHOTS_LIST = [
  { id: "S5.2-rows", f: "rows", expect: (w) => `${box(w)} [data-state="S5.2"] [role="listitem"]` },
  { id: "S5.2-trending-tab", f: "rows", tab: "trending", only: "390", expect: () => '.dsc-tab[data-tab="trending"][aria-selected="true"]' },
  { id: "S5.2-hot-tab", f: "rows", tab: "hot", only: "390", expect: () => '.dsc-tab[data-tab="hot"][aria-selected="true"]' },
  { id: "S5.2-graduating-tab", f: "rows", tab: "graduating", only: "390", expect: () => '.dsc-tab[data-tab="graduating"][aria-selected="true"]' },
  { id: "S5.2-edge-values", f: "edges", expect: (w) => `${box(w)} [data-state="S5.2"] [role="listitem"]` },
  { id: "S5.1-loading", f: "loading", expect: (w) => `${box(w)} [data-state="S5.1"]` },
  { id: "S5.3-empty", f: "empty", expect: (w) => `${box(w)} [data-state="S5.3"]` },
  { id: "S5.5-offline", f: "error", expect: (w) => `${box(w)} [data-state="S5.5"] .dsc-retry` },
];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-discover-screens-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
/** Each fixture row's launchpad and chain, as the lists serve them (card app-launchpad-chain-badges). */
const SERVED = new Map([solana, edgy].flatMap((s) => Object.values(s.lists).flat()).map((r) => [r.token, { launchpad: r.launchpad, chain: r.chain }]));
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
const drafts = new Map();
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

async function openAt(browser, w, scheme, f) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const external = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}`);
  await page.waitForSelector(".dsc");
  return { ctx, page, external };
}

let BASE = "";
const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import("playwright");
const browser = await chromium.launch();
let n = 0;
try {
  for (const w of WIDTHS) {
    for (const scheme of SCHEMES) {
      for (const s of SHOTS_LIST) {
        if (s.only && s.only !== w.name) continue;
        n++;
        const { ctx, page, external } = await openAt(browser, w, scheme, s.f);
        const tag = `${s.id} @${w.name} ${scheme}`;
        if (s.tab) await page.locator(`.dsc-tab[data-tab="${s.tab}"]`).click();
        const shown = await page.locator(s.expect(w.name)).first().isVisible().catch(() => false);
        check(shown, `${tag}: ${s.expect(w.name)} not visible`);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(scroll <= 0, `${tag}: horizontal scroll ${scroll}px`);
        check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
        const wide = await page.$$eval(`${box(w.name)} [role="listitem"]`, (els) => els.filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map((e) => e.getAttribute("data-token")));
        check(wide.length === 0, `${tag}: rows wider than their column: ${wide.join(" ")}`);
        check((await page.locator(".dsc img:not(.tok-pb img):not(.tok-cb img)").count()) === 0, `${tag}: token text drew an element`);
        // every row: its launchpad's logo badge (none for null or an unknown id), its chain's mark, no raw id, not cut
        if (s.f === "rows" || s.f === "edges") {
          await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))));
          const rows = await page.evaluate(READ, { scope: box(w.name), column: s.tab ?? "new" });
          // the planted unknown id is meant to have no table row: that fault alone is expected on its row
          const faulty = rows.map((r) => ({ t: r.addr, bad: rowFaults({ ...r, served: SERVED.get(r.addr) ?? null }).filter((m) => !(r.addr.startsWith("NewPad") && m === 'launchpad "some-new-pad" has no row in the table')) })).filter((x) => x.bad.length);
          check(rows.length > 0 && faulty.length === 0, `${tag}: badges: ${rows.length} rows, ${faulty.slice(0, 3).map((x) => `${x.t.slice(0, 8)} ${x.bad.join("; ")}`).join(" | ")}`);
          if (s.f === "edges") {
            const unknown = rows.find((r) => r.addr.startsWith("NewPad"));
            check(!!unknown && unknown.pad === null && unknown.chain?.id === "solana" && !unknown.texts.includes("some-new-pad"), `${tag}: the unknown id's row drew ${JSON.stringify(unknown)}`);
          }
        }
        if (s.f === "rows" && w.name === "1440" && !s.tab) {
          const full = await page.$$eval(".dsc-grid .dsc-rows", (cols) => cols.map((c) => { const b = c.getBoundingClientRect().bottom; return [...c.querySelectorAll('[role="listitem"]')].filter((r) => r.getBoundingClientRect().bottom <= b + 0.5).length; }));
          check(full.length === 4 && full.every((x) => x >= 9), `${tag}: full rows per column ${full.join(",")} (S5.7 wants 9)`);
        }
        for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
          if (!drafts.has(d)) drafts.set(d, new Set());
          drafts.get(d).add(s.id);
        }
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${s.id}-${w.name}-${scheme}.png`) });
        await ctx.close();
      }
    }
    // behaviour: Retry on S5.5 asks the caller to read again, once per tap
    {
      const { ctx, page } = await openAt(browser, w, "dark", "error");
      await page.locator(`${box(w.name)} .dsc-retry`).first().click();
      const calls = await page.evaluate(() => window.__calls);
      check(calls.length === 1 && calls[0].kind === "retry", `@${w.name}: Retry posted ${JSON.stringify(calls)}`);
      await ctx.close();
    }
    // behaviour: the phone tabs hold one list at a time, each its column's rows
    if (w.name === "390") {
      const { ctx, page } = await openAt(browser, w, "dark", "rows");
      for (const t of ["new", "trending", "hot", "graduating"]) {
        await page.locator(`.dsc-tab[data-tab="${t}"]`).click();
        const tabCount = await page.locator(`.dsc-tab[data-tab="${t}"] .dsc-count`).textContent();
        const rows = await page.locator('.dsc-phone [role="listitem"]').count();
        const colRows = await page.locator(`.dsc-grid .dsc-col[data-col="${t}"] [role="listitem"]`).count();
        check(String(rows) === tabCount && rows === colRows && rows > 0, `@390 tab ${t}: ${rows} rows, tab says ${tabCount}, column has ${colRows}`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} of ${n} shots and the behaviour checks`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${SHOTS_LIST.length} states, 390/1440, dark/light) and the behaviour checks${SHOTS ? `; shots in ${SHOTS}` : ""}`);
