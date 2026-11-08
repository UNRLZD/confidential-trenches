#!/usr/bin/env node
// The token page's left rail (card app-token-rail), from the built app at / inside the stand-in shell (as
// test/token-page/run.mjs): APP_HOST the build under its _headers, SIGN_HOST the stand-in shell, HELPER_HOST answered
// from the recorded lists (test/discover-data, as app-in-shell.mjs's harness) and, for any listed mint, a token read of
// that list row (as test/token-route/run.mjs). Signed in and signed out, at 1600, 1440, 1280, 1180 and 1179 x 900:
//   - the width mode, read off the desktop grid's first track and the rail's own box: the full rail (340 layout px) from
//     1500 css px, the slim rail (78: the rings and the expand button) from 1180, no rail under it (and no lists read
//     for it: the page's one read of / is the only one);
//   - the full rail's Trending and New chips (Trending pressed), its rows the Trending column as Discover orders it, each
//     a link to /token/solana/<mint>, the page's own token marked (aria-current);
//   - the header's strip whole in every mode (no tile cut, clear of the trade column and the rail: the design's one-row
//     rule), no horizontal scroll, no text under 11 px, no layout shift from the first paint (CLS 0), no page error;
//   - opening / reads the lists once (the rail and the top-token read share the read in flight);
//   - a click on another rail row opens that token's page (its data-token, the frame at /token/solana/<mint>) with the
//     rail still drawn and no second lists read; New shows the New column and its row opens its token; on the slim rail
//     the expand button draws the full rail over the chart with the main column unmoved, and its row opens its token;
//   - a refresh that lands a new token on top of Trending (signed out, full at 1600 and slim at 1440) shows it in the
//     first row and moves no row already drawn: each row's element keeps its box, no value is cut, and no element shifts
//     (text re-aligned inside its own right-aligned cell is named on a NOTE line).
//   node apps/terminal/test/token-rail/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { APP_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { REFRESH_MS } from "../../src/screens/discover/data.ts";
import { columnRows } from "../../src/screens/discover/model.ts";

const HELPER = "https://ct-api.unrealized.trade";
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// mode: the rail's first grid track in layout px (null: no rail)
const WIDTHS = [
  { name: "1600", width: 1600, mode: "full", track: 340 },
  { name: "1440", width: 1440, mode: "slim", track: 78 },
  { name: "1280", width: 1280, mode: "slim", track: 78 },
  { name: "1180", width: 1180, mode: "slim", track: 78 },
  { name: "1179", width: 1179, mode: "hidden", track: null },
];
const KINDS = [
  { name: "in", kind: "signed" },
  { name: "out", kind: "tap" },
];

const recorded = JSON.parse(readFileSync(path.join(APP, "test/discover-data/helper-lists-2026-11-01.json"), "utf8"));
const tokenRest = JSON.parse(readFileSync(path.join(APP, "test/token-source/helper-token-2026-11-03.json"), "utf8")).rest;
const unzip = (v) => Object.fromEntries(recorded.fields.map((k, i) => [k, v[i]]));
const SNAP = { chain: recorded.chain, as_of_ms: recorded.as_of_ms, lists: Object.fromEntries(Object.entries(recorded.lists).map(([k, rows]) => [k, rows.map(unzip)])) };
const ROWS = new Map(Object.values(SNAP.lists).flat().map((r) => [r.token, r]));
const TRENDING = columnRows(SNAP, "trending").map((r) => r.token);
const NEW = columnRows(SNAP, "new").map((r) => r.token);
// the lists a later read answers: a new token with the most 1h volume (a decimal string, as the helper sends it), so it
// lands on top of Trending
const NEW_TOP = "RaiLTop1111111111111111111111111111111111111";
const TOPPED = (() => {
  const first = SNAP.lists.trending_1h[0];
  const top = { ...first, token: NEW_TOP, symbol: "TOP", vol_1h_usd: String(10 * Math.ceil(Math.max(...SNAP.lists.trending_1h.map((r) => Number(r.vol_1h_usd) || 0)))) };
  return { ...SNAP, lists: { ...SNAP.lists, trending_1h: [top, ...SNAP.lists.trending_1h] } };
})();

const fails = [];
const notes = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-token-rail-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const json = (status, body) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });

async function open(browser, route, w, reads) {
  const ctx = await browser.newContext({ viewport: { width: w.width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin === HELPER && u.pathname === "/v1/market/lists") {
      reads.lists++;
      return r.fulfill(json(200, { ...(reads.topped ? TOPPED : SNAP), as_of_ms: Date.now() }));
    }
    if (u.origin === HELPER && u.pathname === "/v1/market/token") {
      const row = u.searchParams.get("chain") === "solana" ? ROWS.get(u.searchParams.get("token")) : undefined;
      return r.fulfill(row ? json(200, { ...tokenRest, row: { ...row, as_of_ms: Date.now() } }) : json(404, { error: { code: "not_found" } }));
    }
    return route(r);
  });
  // every frame's layout shifts from its first paint (the terminal's frame is the one read)
  await ctx.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__cls += e.value;
          // what moved, for the failure line: the element's tag and class, its box before and after
          const r = (b) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
          for (const x of e.sources ?? []) (window.__clsSrc ??= []).push(`${x.node?.nodeName?.toLowerCase() ?? "?"}${x.node?.className ? `.${String(x.node.className).split(" ")[0]}` : ""} ${r(x.previousRect)} -> ${r(x.currentRect)}`);
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`@${w.name}: no APP_HOST frame inside the shell`);
  return { ctx, page, f, errors };
}

const ready = (f, token) => f.waitForSelector(`main[data-route="token"] [data-token-page="ready"]${token ? `[data-token="${token}"]` : ""}`, { timeout: 10_000 }).then(() => true, () => false);

/** The rail, the grid and the strip as drawn now. */
const readPage = (f) =>
  f.evaluate(() => {
    const desk = document.querySelector(".tkp-desk");
    const rail = document.querySelector('.tkp-desk [data-testid="token-rail"]');
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const R = (e) => e?.getBoundingClientRect() ?? null;
    const strip = R(document.querySelector(".tkp-desk .tkp-strip"));
    const ident = R(document.querySelector(".tkp-desk .tkp-ident"));
    const main = R(document.querySelector(".tkp-desk .tkp-main"));
    const trade = R(document.querySelector(".tkp-desk .tkp-trade"));
    const railR = vis(rail) ? R(rail) : null;
    const cut = [...document.querySelectorAll(".tkp-desk .tkp-strip > *, .tkp-desk .tkp-strip .tkp-val, .tkp-desk .tkp-strip .tkp-lbl, .tkp-desk .tkp-strip .tkp-mcval")].filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent.trim());
    const small = [...document.querySelectorAll(".tkp-desk *")].filter((e) => e.getClientRects().length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())).map((e) => [e.textContent.trim().slice(0, 20), parseFloat(getComputedStyle(e).fontSize)]).filter(([, px]) => px < 10.95);
    const rows = vis(rail) ? [...rail.querySelectorAll('[role="listitem"]')].map((e) => ({ token: e.getAttribute("data-token"), href: e.querySelector("a")?.getAttribute("href") ?? null, current: e.querySelector("a")?.getAttribute("aria-current") ?? null, sym: vis(e.querySelector(".tkr-s")) ? e.querySelector(".tkr-s").textContent : null })) : [];
    const chips = vis(rail) ? [...rail.querySelectorAll(".tkr-chip")].filter(vis).map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`) : [];
    return {
      tracks: desk ? getComputedStyle(desk).gridTemplateColumns : null,
      railW: vis(rail) ? rail.offsetWidth : null,
      railState: rail?.getAttribute("data-state") ?? null,
      open: rail?.getAttribute("data-open") ?? null,
      expand: vis(rail?.querySelector('[data-testid="rail-expand"]')),
      rows,
      chips,
      cut,
      small,
      stripRight: strip?.right ?? null,
      stripLeft: strip?.left ?? null,
      identRight: ident?.right ?? null,
      mainLeft: main?.left ?? null,
      mainRight: main?.right ?? null,
      tradeLeft: trade?.left ?? null,
      railRight: railR?.right ?? null,
      scroll: document.documentElement.scrollWidth - window.innerWidth,
      cls: window.__cls ?? null,
      token: document.querySelector("[data-token-page]")?.getAttribute("data-token") ?? null,
      path: location.pathname,
    };
  });

const dir = await build();
const browser = await launchBrowser("chromium");
let n = 0;
try {
  for (const k of KINDS) {
    const route = await harnessRoute(dir, k.kind);
    for (const w of WIDTHS) {
      n++;
      const tag = `@${w.name} ${k.name}`;
      const reads = { lists: 0 };
      const { ctx, page, f, errors } = await open(browser, route, w, reads);
      const top = TRENDING[0];
      check(await ready(f, top), `${tag}: / did not draw the top Trending token ${top}`);
      if (w.mode !== "hidden") await f.waitForSelector('[data-testid="token-rail"][data-state="ready"]', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(400);
      const p = await readPage(f);
      const first = p.tracks ? parseFloat(p.tracks.split(" ")[0]) : NaN;
      const tracks = p.tracks ? p.tracks.split(" ").length : 0;
      // the mode
      if (w.mode === "hidden") {
        check(p.railW === null && tracks === 2, `${tag}: a rail under 1180 (rail ${p.railW}, tracks ${p.tracks})`);
        check(reads.lists === 1, `${tag}: ${reads.lists} lists reads with no rail drawn, not the page's one`);
      } else {
        check(tracks === 3 && Math.abs(first - w.track) < 0.5, `${tag}: the rail's track is ${p.tracks}, want ${w.track}px first`);
        check(p.railW !== null && Math.abs(p.railW - w.track) <= 1, `${tag}: the rail is ${p.railW} wide, want ${w.track}`);
        check(p.railState === "ready", `${tag}: the rail's state ${p.railState}`);
        check(reads.lists === 1, `${tag}: opening / read the lists ${reads.lists} times, not once (the rail and the top token share it)`);
        check(JSON.stringify(p.rows.map((r) => r.token)) === JSON.stringify(TRENDING), `${tag}: the rail's rows ${p.rows.length} are not the Trending column's ${TRENDING.length} in Discover's order`);
        const bad = p.rows.filter((r) => r.href !== `/token/solana/${r.token}`);
        check(bad.length === 0, `${tag}: rows not linked to their token: ${bad.slice(0, 3).map((r) => `${r.token} ${r.href}`).join(" ")}`);
        const cur = p.rows.filter((r) => r.current === "page").map((r) => r.token);
        check(cur.length === 1 && cur[0] === top, `${tag}: the marked row(s) ${JSON.stringify(cur)}, want the page's ${top}`);
        if (w.mode === "full") {
          check(JSON.stringify(p.chips) === JSON.stringify(["Trending:true", "New:false"]), `${tag}: chips ${JSON.stringify(p.chips)}`);
          check(!p.expand, `${tag}: the expand button drawn on the full rail`);
          check(p.rows.every((r) => r.sym), `${tag}: a full row with no symbol drawn`);
        } else {
          check(p.chips.length === 0 && p.expand, `${tag}: slim rail: chips ${JSON.stringify(p.chips)}, expand ${p.expand}`);
          check(p.rows.every((r) => r.sym === null), `${tag}: the slim rail draws row text`);
        }
        check(p.railRight !== null && p.stripLeft !== null && p.railRight <= p.mainLeft + 0.5, `${tag}: the rail runs into the main column (${p.railRight} > ${p.mainLeft})`);
      }
      // the strip: one row, whole, clear of the trade column (and the rail)
      check(p.cut.length === 0, `${tag}: strip tiles cut: ${JSON.stringify(p.cut)}`);
      check(p.stripRight !== null && p.stripRight <= p.tradeLeft + 0.5 && p.stripRight <= p.mainRight + 0.5, `${tag}: the strip runs past the main column (${p.stripRight} > ${p.mainRight}, trade at ${p.tradeLeft})`);
      check(p.stripLeft !== null && p.stripLeft >= p.mainLeft - 0.5 && p.identRight <= p.stripLeft + 0.5, `${tag}: the strip overlaps the identity or leaves the main column (strip ${p.stripLeft}, ident ${p.identRight}, main ${p.mainLeft})`);
      check(p.scroll <= 0, `${tag}: horizontal scroll ${p.scroll}px`);
      check(p.small.length === 0, `${tag}: text under 11 px: ${JSON.stringify(p.small.slice(0, 4))}`);
      check(p.cls === 0, `${tag}: layout shift ${p.cls} from the first paint, want 0`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rail-${w.name}-${k.name}.png`) });

      // the clicks (signed in: the rail is the same signed out)
      if (k.name === "in" && w.mode === "full") {
        const next = TRENDING[1];
        await f.locator(`[data-testid="token-rail"] [data-token="${next}"] a`).click();
        const hop = await f.waitForSelector(`[data-token-page][data-token="${next}"]`, { timeout: 10_000 }).then(() => true, () => false);
        const at = await readPage(f);
        check(hop && at.path === `/token/solana/${next}`, `${tag}: a rail click on ${next} drew ${at.token} at ${at.path}`);
        check(at.railState === "ready" && at.rows.length === TRENDING.length, `${tag}: the rail after the hop: ${at.railState}, ${at.rows.length} rows (kept, not read again)`);
        check(await ready(f, next), `${tag}: ${next}'s page not ready after the click`);
        const after = await readPage(f);
        const cur = after.rows.filter((r) => r.current === "page").map((r) => r.token);
        check(cur.length === 1 && cur[0] === next, `${tag}: after the hop the marked row(s) ${JSON.stringify(cur)}, want ${next}`);
        check(reads.lists === 1, `${tag}: the hop read the lists again (${reads.lists} reads)`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rail-${w.name}-click.png`) });
        await f.locator('[data-testid="token-rail"] .tkr-chip[data-list="new"]').click();
        const nw = await readPage(f);
        check(JSON.stringify(nw.rows.map((r) => r.token)) === JSON.stringify(NEW) && JSON.stringify(nw.chips) === JSON.stringify(["Trending:false", "New:true"]), `${tag}: New shows ${nw.rows.length} rows (want the New column's ${NEW.length}), chips ${JSON.stringify(nw.chips)}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rail-${w.name}-new.png`) });
        const pick = NEW.find((t) => t !== next);
        await f.locator(`[data-testid="token-rail"] [data-token="${pick}"] a`).click();
        check(await ready(f, pick), `${tag}: a New row click did not open ${pick}`);
      }
      if (k.name === "in" && w.mode === "slim" && w.name === "1440") {
        const before = await readPage(f);
        await f.locator('[data-testid="rail-expand"]').click();
        await page.waitForTimeout(200);
        const ex = await readPage(f);
        check(ex.open === "true" && Math.abs(ex.railW - 340) <= 1, `${tag}: expand drew the rail ${ex.railW} wide (open ${ex.open}), want 340`);
        check(ex.mainLeft === before.mainLeft && ex.tracks === before.tracks, `${tag}: expanding moved the page (main ${before.mainLeft} -> ${ex.mainLeft}, tracks ${before.tracks} -> ${ex.tracks})`);
        check(JSON.stringify(ex.chips) === JSON.stringify(["Trending:true", "New:false"]) && ex.rows.every((r) => r.sym), `${tag}: the expanded rail: chips ${JSON.stringify(ex.chips)}, rows with text ${ex.rows.filter((r) => r.sym).length}/${ex.rows.length}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rail-${w.name}-expanded.png`) });
        const next = TRENDING[2];
        await f.locator(`[data-testid="token-rail"] [data-token="${next}"] a`).click();
        check(await ready(f, next), `${tag}: an expanded rail row did not open ${next}`);
        const after = await readPage(f);
        check(after.open === "false" && after.railW !== null && Math.abs(after.railW - 78) <= 1, `${tag}: after the hop the rail is ${after.railW} wide (open ${after.open}), want slim`);
      }
      // a refresh lands a token on top: it is drawn in the first row, and no drawn row moves
      if (k.name === "out" && (w.name === "1600" || w.name === "1440")) {
        const rowsSel = '.tkp-desk [data-testid="token-rail"] [role="listitem"]';
        const before = await f.evaluate((sel) => [...document.querySelectorAll(sel)].map((e, i) => {
          e.__slot = i;
          const b = e.getBoundingClientRect();
          return [b.x, b.y, b.width, b.height];
        }), rowsSel);
        reads.topped = true;
        const landed = await f.waitForSelector(`${rowsSel}:first-child[data-token="${NEW_TOP}"]`, { timeout: REFRESH_MS + 5_000 }).then(() => true, () => false);
        await page.waitForTimeout(400);
        const after = await f.evaluate((sel) => {
          const els = [...document.querySelectorAll(sel)];
          const box = (e) => {
            const b = e.getBoundingClientRect();
            return [b.x, b.y, b.width, b.height];
          };
          return { n: els.length, kept: els.filter((e) => e.__slot !== undefined).map((e) => [e.__slot, box(e)]), cls: window.__cls ?? null, src: window.__clsSrc ?? [], cut: [...document.querySelectorAll('.tkp-desk [data-testid="token-rail"] .tkr-mc, .tkp-desk [data-testid="token-rail"] .tkr-c')].filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent) };
        }, rowsSel);
        check(landed && after.n === TRENDING.length + 1, `${tag}: a refresh with a new top token: first row ${landed ? NEW_TOP : "not it"}, ${after.n} rows (want ${TRENDING.length + 1})`);
        const moved = after.kept.filter(([i, b]) => b.some((x, j) => Math.abs(x - before[i][j]) > 0.5));
        check(after.kept.length === before.length && moved.length === 0, `${tag}: the refresh moved drawn rows: ${after.kept.length}/${before.length} kept, ${moved.length} moved (${moved.slice(0, 3).map(([i, b]) => `row ${i} y ${before[i][1].toFixed(1)} -> ${b[1].toFixed(1)}`).join(", ")})`);
        check(after.cut.length === 0, `${tag}: rail values cut by the right column's width: ${JSON.stringify(after.cut.slice(0, 4))}`);
        // no element moved: a shift's sources may only be text re-aligned inside its own fixed cell (R5 right-aligns the MC
        // and change lines, so a value of another length starts elsewhere in its cell; Chrome counts that text)
        const boxes = after.src.filter((x) => !x.startsWith("#text"));
        check(boxes.length === 0, `${tag}: the refresh shifted ${boxes.length} element(s): ${boxes.slice(0, 6).join(" | ")}`);
        if (after.cls) notes.push(`${tag}: text re-aligned in its cell after the refresh, layout shift ${after.cls.toExponential(1)}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `rail-${w.name}-refresh.png`) });
      }
      check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

if (fails.length) {
  for (const x of fails) console.log(`FAIL ${x}`);
  console.log(`FAIL ${fails.length} checks over ${n} views`);
  process.exit(1);
}
for (const x of notes) console.log(`NOTE ${x}`);
console.log(`PASS ${n} views (1600, 1440, 1280, 1180, 1179; signed in and out) from the built app at / inside the stand-in shell, Trending ${TRENDING.length} and New ${NEW.length} rows${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
