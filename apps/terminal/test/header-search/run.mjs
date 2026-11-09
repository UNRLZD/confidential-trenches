#!/usr/bin/env node
// The top bar's search (card app-header-search-chain), from the built app at / inside the stand-in shell (as
// test/token-rail/run.mjs): APP_HOST the build under its _headers, SIGN_HOST the stand-in shell, HELPER_HOST answered
// from the recorded lists (test/discover-data) and one planted Base row (a copy of a listed row on chain "base", so the
// chain filter has two chains with data to switch between), served as the helper serves it, in Base's own lists
// (chain=base; card app-chains-evm: the terminal reads each chain's lists, and a chain's answer holds only its rows), and, for a listed mint or the one planted unlisted mint, a
// token read of its row (any other id answers 404, as the helper does). At 1920, 1440 and 1024 x 900 (the field and the
// chain chip), 900 x 900 (the top bar's search button) and 390 x 844 (dpr 2, touch: the phone's search button):
//   - the field (or the button's sheet) opens on the Trending column; a symbol typed key by key finds its token first,
//     with no lists read and no token read while typing (search on the device), and Enter (the phone: a tap) opens its
//     token's page with the search closed;
//   - a pasted listed address finds its row with no token read; a pasted unlisted mint is read once (the token read,
//     source.ts loadToken) and its row opens its page; a pasted unknown mint finds No results;
//   - the chain filter offers All and the chains with data (Solana, Base); Base keeps only the Base row of a symbol both
//     chains hold, Solana only the Solana one, All both;
//   - no horizontal scroll, no layout shift from the first paint (CLS 0), no page error, signed in and out;
//   - the account side (card app-header-first-paint-auth): the stored sign-in hint (signin/hint.ts) seeded as the state
//     each view lands in, the hint read back as that state, and signed out R5's room before Sign in (12 layout px after
//     the chip, 20 after the narrow bar's button, 4 after the phone's); two views with a wrong hint (out but signed in,
//     in but signed out) land in the right state with the hint corrected (signed out inside the kept box, CLS 0), and
//     their next load has R5's room and CLS 0; two views signed in with no hint (app storage cleared while the signing
//     page kept its own), desktop and phone, land signed in (the box grows once) with the hint written, and their next
//     load has CLS 0.
//   node apps/terminal/test/header-search/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { APP_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { columnRows } from "../../src/screens/discover/model.ts";

const HELPER = "https://ct-api.unrealized.trade";
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const desk = (width) => ({ name: String(width), viewport: { width, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
const phone = { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, mode: "phone" };
// each width signed in and signed out, the sign-in hint (card app-header-first-paint-auth, src/screens/signin/hint.ts)
// stored as the state it lands in; then two views whose stored hint is wrong, and two signed in with none stored
const BASE_VIEWS = [{ ...desk(1920), mode: "field" }, { ...desk(1440), mode: "field" }, { ...desk(1024), mode: "field" }, { ...desk(900), mode: "button" }, phone];
const VIEWS = [
  ...BASE_VIEWS.flatMap((v) => [
    { ...v, kind: "signed", hint: "in" },
    { ...v, kind: "tap", hint: "out" },
  ]),
  { ...desk(1440), mode: "field", kind: "signed", hint: "out", stale: true },
  { ...phone, kind: "tap", hint: "in", stale: true },
  { ...desk(1440), mode: "field", kind: "signed", hint: null, stale: true },
  { ...phone, kind: "signed", hint: null, stale: true },
];
const HINT_KEY = "ct-signin-hint";
// R5's room before the account side, layout px (proto.css): the chip sits in .tbr at its 12 px gap; the narrow bar's
// button is the bar's own child (gap 20); the phone's 44 px button has a -6 px right margin in the header's 10 px gap
const GAP = { field: 12, button: 20, phone: 4 };

const recorded = JSON.parse(readFileSync(path.join(APP, "test/discover-data/helper-lists-2026-11-01.json"), "utf8"));
const tokenRest = JSON.parse(readFileSync(path.join(APP, "test/token-source/helper-token-2026-11-03.json"), "utf8")).rest;
const unzip = (v) => Object.fromEntries(recorded.fields.map((k, i) => [k, v[i]]));
const lists = Object.fromEntries(Object.entries(recorded.lists).map(([k, rows]) => [k, rows.map(unzip)]));
const TRENDING = columnRows({ lists }, "trending");
// the target a symbol finds: a Trending row (not the page's own, the top one) whose symbol no other row starts with
const SOL_ROWS = Object.values(lists).flat();
const TARGET = TRENDING.slice(1).find((r) => SOL_ROWS.filter((x) => x.symbol.toLowerCase().startsWith(r.symbol.toLowerCase())).every((x) => x.token === r.token));
if (!TARGET) throw new Error("no Trending row with a symbol of its own in the recording");
// planted: the same symbol on Base (a copy of another listed row), so both chains hold it
const BOTH = TRENDING.find((r) => r.token !== TARGET.token && r.token !== TRENDING[0].token) ?? TRENDING[0];
const BASE_ROW = { ...BOTH, chain: "base", token: "0x07b3d902783c3c12b077508c3b5c00113d1291d0", launchpad: null };
const SNAP = { chain: recorded.chain, as_of_ms: recorded.as_of_ms, lists };
const BASE_SNAP = { chain: "base", as_of_ms: recorded.as_of_ms, lists: { new: [BASE_ROW], trending: [], trending_5m: [], trending_1h: [], graduating: [] } };
const ROWS = new Map(SOL_ROWS.map((r) => [r.token, r]));
// planted: a mint the lists do not hold, answered by the token read; and one the helper does not know (404)
const UNLISTED = { ...TRENDING[0], token: "So11111111111111111111111111111111111111112", symbol: "WSOL", name: "Wrapped SOL" };
const UNKNOWN = "11111111111111111111111111111111";
const LISTED = TRENDING[3] ?? TRENDING[1];

const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-header-search-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const json = (status, body) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });

async function open(browser, route, v, reads) {
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.deviceScaleFactor, isMobile: v.isMobile, hasTouch: v.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin === HELPER && u.pathname === "/v1/market/lists") {
      reads.lists++;
      const chain = u.searchParams.get("chain");
      const snap = chain === "solana" ? SNAP : chain === "base" ? BASE_SNAP : null;
      return r.fulfill(snap ? json(200, { ...snap, as_of_ms: Date.now() }) : json(404, { error: { code: "not_found" } }));
    }
    if (u.origin === HELPER && u.pathname === "/v1/market/token") {
      const id = u.searchParams.get("token");
      reads.token.push(id);
      const row = u.searchParams.get("chain") !== "solana" ? undefined : id === UNLISTED.token ? UNLISTED : ROWS.get(id);
      return r.fulfill(row ? json(200, { ...tokenRest, row: { ...row, as_of_ms: Date.now() } }) : json(404, { error: { code: "not_found" } }));
    }
    return route(r);
  });
  // the stored sign-in hint, in the terminal's own frame (APP_HOST's storage), before any of its script runs
  await ctx.addInitScript(
    ({ key, hint, app }) => {
      if (location.origin === app && !sessionStorage.getItem("__hinted")) {
        sessionStorage.setItem("__hinted", "1");
        if (hint === null) localStorage.removeItem(key);
        else localStorage.setItem(key, hint);
      }
    },
    { key: HINT_KEY, hint: v.hint, app: APP_HOST },
  );
  await ctx.addInitScript(() => {
    window.__cls = 0;
    window.__long = 0;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          if (!e.hadRecentInput) {
            window.__cls += e.value;
            (window.__shifts ??= []).push({ at: location.pathname, v: e.value, src: (e.sources ?? []).map((x) => (x.node?.className ? `${x.node.nodeName}.${String(x.node.className).split(" ")[0]}` : x.node?.nodeName ?? "?")).join(" ") });
          }
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration);
      }).observe({ type: "longtask" });
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
  if (!f) throw new Error(`@${v.name}: no APP_HOST frame inside the shell`);
  return { ctx, page, f, errors };
}

const ready = (f, token) => f.waitForSelector(`main[data-route="token"] [data-token-page="ready"]${token ? `[data-token="${token}"]` : ""}`, { timeout: 10_000 }).then(() => true, () => false);

/** The search as drawn now: its results' state, rows and head, the chip, the sheet, the page. */
const read = (f) =>
  f.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const res = [...document.querySelectorAll(".srch-res")].find(vis) ?? null;
    return {
      field: vis(document.querySelector('.tb [data-testid="search"]')),
      button: vis(document.querySelector('[data-testid="search-button"]')),
      phoneButton: vis(document.querySelector('[data-testid="search-button-phone"]')),
      chip: vis(document.querySelector('[data-testid="chain-chip"]')) ? document.querySelector('[data-testid="chain-chip"]').getAttribute("data-pick") : null,
      sheet: vis(document.querySelector('[data-testid="search-sheet"]')),
      focused: document.activeElement?.getAttribute("data-testid") ?? null,
      state: res?.getAttribute("data-state") ?? null,
      head: res?.querySelector(".srch-head")?.textContent ?? null,
      msg: res?.querySelector(".srch-msg")?.textContent ?? null,
      rows: res ? [...res.querySelectorAll(".srr[data-token]")].map((e) => ({ token: e.getAttribute("data-token"), chain: e.getAttribute("data-chain"), href: e.getAttribute("href"), on: e.getAttribute("aria-selected") })) : [],
      chips: [...document.querySelectorAll('[data-testid="chain-chips"] .srch-cchip')].map((b) => `${b.getAttribute("data-chain")}:${b.getAttribute("aria-pressed")}`),
      menu: [...document.querySelectorAll('[data-testid="chain-menu"] .srch-mrow')].map((b) => `${b.getAttribute("data-chain")}:${b.textContent}`),
      header: [...document.querySelectorAll(".tb [data-header], .phh [data-header]")].filter(vis).map((e) => e.getAttribute("data-header"))[0] ?? null,
      hint: (() => {
        try {
          return localStorage.getItem("ct-signin-hint");
        } catch {
          return "unreadable";
        }
      })(),
      // the room between the last search control and Sign in, in layout px (signed out)
      gap: (() => {
        const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fit-zoom")) || 1;
        const before = [document.querySelector('.tb [data-testid="chain-chip"]'), document.querySelector('.tb [data-testid="search-button"]'), document.querySelector('[data-testid="search-button-phone"]')].find(vis);
        const signin = [document.querySelector('.tb .btn-signin'), document.querySelector('.phh [data-header="S1.1"]')].find(vis);
        return before && signin ? (signin.getBoundingClientRect().left - before.getBoundingClientRect().right) / z : null;
      })(),
      scroll: document.documentElement.scrollWidth - window.innerWidth,
      cls: window.__cls ?? null,
      shifts: window.__shifts ?? [],
      long: window.__long ?? 0,
      token: document.querySelector("[data-token-page]")?.getAttribute("data-token") ?? null,
      path: location.pathname,
    };
  });

const dir = await build();
const browser = await launchBrowser("chromium");
let n = 0;
try {
  for (const v of VIEWS) {
    n++;
    const tag = `@${v.name} ${v.kind === "signed" ? "in" : "out"}${v.stale ? (v.hint ? ` (stale hint ${v.hint})` : " (no hint)") : ""}`;
    const shot = (name) => (SHOTS ? v.page.screenshot({ path: path.join(SHOTS, `search-${v.name}-${v.kind === "signed" ? "in" : "out"}${v.stale ? (v.hint ? "-stale" : "-nohint") : ""}-${name}.png`) }) : null);
    const reads = { lists: 0, token: [] };
    const route = await harnessRoute(dir, v.kind);
    const { ctx, page, f, errors } = await open(browser, route, v, reads);
    v.page = page;
    check(await ready(f, TRENDING[0].token), `${tag}: / did not draw the top Trending token`);
    await f.waitForSelector('.tb [data-header="S1.1"], .tb [data-header="S1.3"], .tb [data-header="S1.4"], .phh [data-header="S1.1"], .phh [data-header="S1.3"], .phh [data-header="S1.4"]', { state: "attached", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const p0 = await read(f);
    check(p0.field === (v.mode === "field") && p0.button === (v.mode === "button") && p0.phoneButton === (v.mode === "phone"), `${tag}: field ${p0.field}, button ${p0.button}, phone button ${p0.phoneButton}; want the ${v.mode}`);
    check((p0.chip !== null) === (v.mode === "field"), `${tag}: the chain chip drawn ${p0.chip !== null}`);
    if (v.mode === "field") check(p0.chip === "all", `${tag}: the chain chip starts at ${p0.chip}, want all`);
    check(p0.scroll <= 0, `${tag}: horizontal scroll ${p0.scroll}px`);
    // the account side: its landed state, the hint corrected to it, and signed out R5's room before Sign in
    const want = v.kind === "signed" ? "in" : "out";
    check(want === "out" ? p0.header === "S1.1" : p0.header === "S1.3" || p0.header === "S1.4", `${tag}: the account side landed as ${p0.header}, want signed ${want}`);
    check(p0.hint === want, `${tag}: the stored hint reads ${p0.hint} after the state landed, want ${want}`);
    // a stale "in" hint that lands signed out keeps its reserved box for that load (Sign in inside it, nothing moves)
    if (want === "out" && !(v.stale && v.hint === "in")) check(p0.gap !== null && Math.abs(p0.gap - GAP[v.mode]) < 0.75, `${tag}: ${p0.gap === null ? "no" : p0.gap.toFixed(1)} layout px before Sign in, want R5's ${GAP[v.mode]}`);
    if (v.stale) {
      // a wrong hint ends in the right state with the hint corrected (above); a stale "out", or no hint (read as out),
      // that lands signed in grows the box once (counted, not checked); the next load reads the corrected hint: R5's
      // room and CLS 0
      if (v.hint === "in") check(p0.cls === 0, `${tag}: layout shift ${p0.cls}, want 0 (Sign in lands inside the kept box): ${JSON.stringify(p0.shifts)}`);
      await shot("closed");
      await page.reload({ waitUntil: "load" });
      let g = null;
      for (const until = Date.now() + 8_000; !g && Date.now() < until; ) {
        g = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
        if (!g) await page.waitForTimeout(100);
      }
      check(g && (await ready(g, null)), `${tag}: the next load drew no token page`);
      if (g) {
        await g.waitForSelector('.tb [data-header="S1.1"], .tb [data-header="S1.3"], .tb [data-header="S1.4"], .phh [data-header="S1.1"], .phh [data-header="S1.3"], .phh [data-header="S1.4"]', { state: "attached", timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(300);
        const q = await read(g);
        check(want === "out" ? q.header === "S1.1" : q.header === "S1.3" || q.header === "S1.4", `${tag}: the next load landed as ${q.header}`);
        check(q.hint === want, `${tag}: the next load's hint reads ${q.hint}, want ${want}`);
        if (want === "out") check(q.gap !== null && Math.abs(q.gap - GAP[v.mode]) < 0.75, `${tag}: the next load has ${q.gap === null ? "no" : q.gap.toFixed(1)} layout px before Sign in, want R5's ${GAP[v.mode]}`);
        check(q.cls === 0, `${tag}: the next load's layout shift ${q.cls}, want 0: ${JSON.stringify(q.shifts)}`);
        await shot("next-load");
      }
      check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
      await ctx.close();
      continue;
    }
    await shot("closed");

    // open the search
    const input = v.mode === "field" ? f.locator('.tb [data-testid="search-input"]') : f.locator('[data-testid="search-sheet"] [data-testid="search-input"]');
    if (v.mode === "field") await input.click();
    else await f.locator(v.mode === "phone" ? '[data-testid="search-button-phone"]' : '[data-testid="search-button"]').click();
    await f.waitForSelector('.srch-res[data-state="rows"]', { timeout: 10_000 }).catch(() => {});
    const p1 = await read(f);
    if (v.mode !== "field") {
      check(p1.sheet, `${tag}: the search button opened no sheet`);
      check(p1.focused === "search-input", `${tag}: the sheet's field not focused (${p1.focused})`);
      check(JSON.stringify(p1.chips) === JSON.stringify(["all:true", "solana:false", "base:false"]), `${tag}: the sheet's chain chips ${JSON.stringify(p1.chips)}`);
    }
    check(p1.head === "Trending" && JSON.stringify(p1.rows.map((r) => r.token)) === JSON.stringify(TRENDING.slice(0, 10).map((r) => r.token)), `${tag}: opened on ${p1.head} ${p1.rows.length} rows, want the Trending column`);
    check(p1.scroll <= 0, `${tag}: horizontal scroll ${p1.scroll}px with the search open`);
    await shot("open");

    // a symbol typed key by key: no read per key, the token first, Enter (or a tap) opens it
    const before = { lists: reads.lists, token: reads.token.length };
    await input.pressSequentially(TARGET.symbol.toLowerCase(), { delay: 40 });
    await page.waitForTimeout(400);
    const p2 = await read(f);
    check(reads.lists === before.lists && reads.token.length === before.token, `${tag}: typing read the lists ${reads.lists - before.lists} and the token ${reads.token.length - before.token} times, want none`);
    check(p2.rows[0]?.token === TARGET.token && p2.rows[0]?.on === "true" && p2.rows[0]?.href === `/token/solana/${TARGET.token}`, `${tag}: typing ${TARGET.symbol} found ${JSON.stringify(p2.rows.slice(0, 2))}, want ${TARGET.token} first and marked`);
    check(p2.long < 500, `${tag}: a ${p2.long} ms task while typing`);
    await shot("typed");
    if (v.mode === "phone") await f.locator(`.srch-res .srr[data-token="${TARGET.token}"]`).tap();
    else await input.press("Enter");
    check(await ready(f, TARGET.token), `${tag}: picking ${TARGET.symbol} did not open its page`);
    const p3 = await read(f);
    check(p3.path === `/token/solana/${TARGET.token}` && p3.state === null && !p3.sheet, `${tag}: after the pick: ${p3.path}, results ${p3.state}, sheet ${p3.sheet}`);
    await shot("picked");

    // reopen for the pastes and the chain filter
    const reopen = async () => {
      if (v.mode === "field") await input.click();
      else await f.locator(v.mode === "phone" ? '[data-testid="search-button-phone"]' : '[data-testid="search-button"]').click();
      await f.waitForSelector(".srch-res", { timeout: 5_000 });
    };
    await reopen();
    check((await input.inputValue()) === "", `${tag}: the field kept its query after the pick`);
    // a listed address: its row, no token read
    let t0 = reads.token.length;
    await input.fill(LISTED.token);
    await page.waitForTimeout(500);
    const p4 = await read(f);
    check(p4.rows.length === 1 && p4.rows[0].token === LISTED.token && reads.token.length === t0, `${tag}: a listed address found ${JSON.stringify(p4.rows.map((r) => r.token))} with ${reads.token.length - t0} token reads, want its row and none`);
    // an unknown mint: No results, after one read
    t0 = reads.token.length;
    await input.fill(UNKNOWN);
    await f.waitForSelector('.srch-res[data-state="none"]', { timeout: 5_000 }).catch(() => {});
    const p5 = await read(f);
    check(p5.state === "none" && p5.msg === "No results" && reads.token.slice(t0).join() === UNKNOWN, `${tag}: an unknown mint: ${p5.state} ${p5.msg}, reads ${JSON.stringify(reads.token.slice(t0))}`);
    // an unlisted mint: read once, its row opens its page
    t0 = reads.token.length;
    await input.fill(UNLISTED.token);
    await f.waitForSelector(`.srch-res .srr[data-token="${UNLISTED.token}"]`, { timeout: 5_000 }).catch(() => {});
    const p6 = await read(f);
    check(p6.rows.length === 1 && p6.rows[0].token === UNLISTED.token && reads.token.slice(t0).join() === UNLISTED.token, `${tag}: a pasted unlisted mint: rows ${JSON.stringify(p6.rows.map((r) => r.token))}, reads ${JSON.stringify(reads.token.slice(t0))}`);
    await shot("pasted");
    const row = f.locator(`.srch-res .srr[data-token="${UNLISTED.token}"]`);
    if (v.mode === "phone") await row.tap();
    else await row.click();
    check(await ready(f, UNLISTED.token), `${tag}: the pasted mint's row did not open its page`);

    // the chain filter: All, Solana, Base; a symbol both chains hold
    await reopen();
    await input.fill(BOTH.symbol);
    await page.waitForTimeout(300);
    const chains = async () => (await read(f)).rows.filter((r) => r.token === BOTH.token || r.token === BASE_ROW.token).map((r) => r.chain).sort().join(",");
    check((await chains()) === "base,solana", `${tag}: All finds ${await chains()} for ${BOTH.symbol}, want base,solana`);
    const choose = async (c) => {
      if (v.mode === "field") {
        await f.locator('[data-testid="chain-chip"]').click();
        await f.waitForSelector('[data-testid="chain-menu"]');
        const m = (await read(f)).menu;
        check(JSON.stringify(m) === JSON.stringify(["all:All", "solana:Solana", "base:Base"]), `${tag}: the chain menu ${JSON.stringify(m)}`);
        if (c === "base" && SHOTS) await shot("chains");
        await f.locator(`[data-testid="chain-menu"] .srch-mrow[data-chain="${c}"]`).click();
        await input.click();
      } else {
        await f.locator(`[data-testid="chain-chips"] .srch-cchip[data-chain="${c}"]`).click();
      }
      await page.waitForTimeout(300);
    };
    await choose("base");
    check((await chains()) === "base", `${tag}: Base finds ${await chains()}, want base`);
    if (v.mode === "field") check((await read(f)).chip === "base", `${tag}: the chip reads ${(await read(f)).chip} after Base`);
    await shot("base");
    await choose("solana");
    check((await chains()) === "solana", `${tag}: Solana finds ${await chains()}, want solana`);
    await choose("all");
    check((await chains()) === "base,solana", `${tag}: All again finds ${await chains()}`);
    const pz = await read(f);
    check(pz.scroll <= 0, `${tag}: horizontal scroll ${pz.scroll}px at the end`);
    check(pz.cls === 0, `${tag}: layout shift ${pz.cls} from the first paint, want 0: ${JSON.stringify(pz.shifts)}`);
    check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
    await ctx.close();
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
console.log(`PASS ${n} views (1920, 1440, 1024: the field; 900: the button; 390: the phone button; each signed in and out with its stored hint, then two views with a wrong hint and two signed in with none) from the built app inside the stand-in shell: typed ${TARGET.symbol} found and opened, a listed and an unlisted address, an unknown mint, chains All, Solana and Base, R5's room before Sign in, the hint corrected${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
