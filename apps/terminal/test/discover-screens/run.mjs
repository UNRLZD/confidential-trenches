#!/usr/bin/env node
// Discover's shots and checks (card app-discover-solana; AS-02, app.md:1370-1375), after the sign-in screens' harness
// (test/signin-screens/run.mjs): the fixture page (page.tsx) built with vite and served on 127.0.0.1, every state at
// 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), dark and light colour schemes (the terminal is dark only). Per shot:
// the state's marker is on screen, no horizontal scroll, no request off the page's host, no row wider than its column,
// hostile token text drawn as text, and the draft words drawn are listed. At 1440 each column shows 9 full rows (S5.7).
// Behaviour: the phone tabs switch the one list; Retry on S5.5 asks the caller to read again; a refresh that puts a new
// token on top of every column (page.tsx __reorder) draws it first and moves no drawn row: each row's element keeps its
// box, and no row, row link or element outside the rows shifts, in all four columns at 1440 and on each of the four
// tabs at 390 (card app-discover-rows-hold; a slot's content re-laid out for its new token is the update, on a NOTE line).
//   node apps/terminal/test/discover-screens/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
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
  // card app-list-age: lists from a read 2 h old draw their age in the bar, and the rows as ever
  { id: "S5.2-old", f: "old", expect: () => '[data-testid="list-age"]' },
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
const notes = [];
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

// the reordered read's new top token (page.tsx TOP_TOKEN)
const TOP_TOKEN = "TopNewRow1111111111111111111111111111111111";

/** Opens the rows fixture (on `tab` at 390), lets the refresh draw the reordered read, and checks no drawn row moved. */
async function reorderCheck(browser, w, tab) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.addInitScript(() => {
    window.__shifts = [];
    try {
      new PerformanceObserver((l) => {
        const r = (b) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
        // a source inside a row's own content (not the row, not its link) is that slot's new token laid out: a cell
        const cell = (n) => {
          const el = n?.nodeType === 1 ? n : n?.parentElement;
          const item = el?.closest('[role="listitem"]');
          return !!item && el !== item && el.parentElement !== item;
        };
        for (const e of l.getEntries()) for (const x of e.sources ?? []) window.__shifts.push({ cell: cell(x.node), text: `${x.node?.nodeName?.toLowerCase() ?? "?"}${x.node?.className ? `.${String(x.node.className).split(" ")[0]}` : ""} ${r(x.previousRect)} -> ${r(x.currentRect)}` });
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?f=rows`);
  await page.waitForSelector(`${box(w.name)} [data-state="S5.2"] [role="listitem"]`);
  if (tab) await page.locator(`.dsc-tab[data-tab="${tab}"]`).click();
  // past the browser's 500 ms input window, so a shift after the refresh is never discounted as following the tap
  await page.waitForTimeout(700);
  const rowsSel = `${box(w.name)} [role="listitem"]`;
  const before = await page.evaluate((sel) => {
    window.__shifts = [];
    return [...document.querySelectorAll(sel)].map((e, i) => {
      e.__slot = i;
      const b = e.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height];
    });
  }, rowsSel);
  await page.evaluate(() => window.__reorder());
  await page.waitForTimeout(400);
  const after = await page.evaluate((sel) => ({
    kept: [...document.querySelectorAll(sel)].filter((e) => e.__slot !== undefined).map((e) => [e.__slot, (({ x, y, width, height }) => [x, y, width, height])(e.getBoundingClientRect())]),
    firsts: [...document.querySelectorAll(`${sel.split(" ")[0]} .dsc-rows`)].filter((c) => c.getClientRects().length).map((c) => c.querySelector('[role="listitem"]')?.getAttribute("data-token") ?? null),
    shifts: window.__shifts,
  }), rowsSel);
  const tag = `@${w.name}${tab ? ` tab ${tab}` : ""} refresh`;
  const want = w.name === "390" ? 1 : 4;
  check(after.firsts.length === want && after.firsts.every((t) => t === TOP_TOKEN), `${tag}: the new top token drawn first in ${after.firsts.filter((t) => t === TOP_TOKEN).length} of ${want} list(s) (${JSON.stringify(after.firsts)})`);
  const moved = after.kept.filter(([i, b]) => b.some((x, j) => Math.abs(x - before[i][j]) > 0.5));
  check(before.length > 0 && after.kept.length === before.length && moved.length === 0, `${tag}: the refresh moved drawn rows: ${after.kept.length}/${before.length} kept, ${moved.length} moved (${moved.slice(0, 3).map(([i, b]) => `row ${i} y ${before[i][1].toFixed(1)} -> ${b[1].toFixed(1)}`).join(", ")})`);
  // no row, no row's link and nothing outside the rows moved; content inside a slot that now holds another token (its
  // name after a shorter symbol, its pills after another age) is the update, named on a NOTE line
  const els = after.shifts.filter((x) => !x.cell && !x.text.startsWith("#text"));
  check(els.length === 0, `${tag}: the refresh shifted ${els.length} element(s): ${els.slice(0, 5).map((x) => x.text).join(" | ")}`);
  const cells = [...new Set(after.shifts.filter((x) => x.cell).map((x) => x.text.split(" ")[0]))];
  if (cells.length) notes.push(`${tag}: the slots' new content re-laid out in its cells: ${cells.join(", ")}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `refresh-${w.name}${tab ? `-${tab}` : ""}.png`) });
  await ctx.close();
}

let BASE = "";
const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser("chromium");
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
        // the list's age: "Updated 2h ago" on the 2 h old read, nothing on a fresh one (card app-list-age)
        const ages = await page.$$eval('[data-testid="list-age"]', (els) => els.filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()));
        const wantAge = s.f === "old" ? ["Updated 2h ago"] : [];
        check(JSON.stringify(ages) === JSON.stringify(wantAge), `${tag}: list age ${JSON.stringify(ages)}, want ${JSON.stringify(wantAge)}`);
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
    // behaviour: a refresh that reorders every list moves no drawn row (all four columns; each tab on the phone)
    for (const tab of w.name === "390" ? ["new", "trending", "hot", "graduating"] : [null]) await reorderCheck(browser, w, tab);
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

for (const x of notes) console.log(`NOTE ${x}`);
for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} of ${n} shots and the behaviour checks`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${SHOTS_LIST.length} states, 390/1440, dark/light) and the behaviour checks${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
