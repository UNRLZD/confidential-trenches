#!/usr/bin/env node
// Every Discover row opens its token's own page (card app-token-route), from the built app inside the stand-in shell
// (as test/token-page/run.mjs): APP_HOST the build under its _headers, SIGN_HOST the stand-in shell that frames APP_HOST
// at its own path and keeps the app's path in its address (the real shell's appSrc and nav), HELPER_HOST answered from
// the recorded lists (test/discover-data) and, for any listed mint, a token read of that list row; any other mint 404s.
// At 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), dark and light colour schemes:
//   - a click on a row of Discover (the phone: the tab's list; the desktop: a click at the row's far edge, so the whole
//     row is the target) draws that token's page: data-token is its mint, the symbol and the id on the page are the
//     row's own, the top window's address is SIGN_HOST/token/solana/<mint> and the terminal's frame is at APP_HOST's;
//   - the row is a real link (an anchor at /token/solana/<mint>) and a Control-click and a middle-click open it in a new
//     tab, which lands on the shell at that path and draws the token, while the first tab stays on Discover;
//   - a deep link (SIGN_HOST and APP_HOST at /token/solana/<mint>) draws the token inside the shell, and so does a reload;
//   - an unknown id and a chain the terminal does not draw draw the page's not-found state ("No token"), a bad chain
//     with no read of the helper; a token read that fails draws the error state;
//   - hover fills the desktop row and a keyboard focus draws the 2 px blue ring; no page error, no CSP violation.
//   node apps/terminal/test/token-route/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";

const HELPER = "https://api.confidential.unrealized.trade";
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const SCHEMES = ["dark", "light"];

const recorded = JSON.parse(readFileSync(path.join(APP, "test/discover-data/helper-lists-2026-11-01.json"), "utf8"));
const tokenRest = JSON.parse(readFileSync(path.join(APP, "test/token-source/helper-token-2026-11-03.json"), "utf8")).rest;
const unzip = (v) => Object.fromEntries(recorded.fields.map((k, i) => [k, v[i]]));
/** Every listed row by mint: a token read for it answers that row, as the helper answers a listed token. */
const ROWS = new Map(Object.values(recorded.lists).flat().map(unzip).map((r) => [r.token, r]));

const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

/** HELPER_HOST's token read: a listed mint answers its row, `broken` mints answer 503, any other 404. `reads` records them. */
function tokenAnswer(u, reads, broken) {
  const json = (status, body) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });
  const id = u.searchParams.get("token");
  reads.push(`${u.searchParams.get("chain")}/${id}`);
  if (broken.has(id)) return json(503, { error: "unavailable" });
  const row = u.searchParams.get("chain") === "solana" ? ROWS.get(id) : undefined;
  return row ? json(200, { ...tokenRest, row: { ...row, as_of_ms: Date.now() } }) : json(404, { error: { code: "not_found" } });
}

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-token-route-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const dir = await build();
const route = await harnessRoute(dir, "signed");
const browser = await launchBrowser("chromium");

async function context(w, scheme, reads, broken, errors) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin === HELPER && u.pathname === "/v1/market/token") return r.fulfill(tokenAnswer(u, reads, broken));
    return route(r);
  });
  await ctx.addInitScript(() => {
    window.__ctViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  ctx.on("page", (p) => p.on("pageerror", (e) => errors.push(String(e))));
  return ctx;
}

const appFrame = async (page, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    const f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
};

/** The page's state in the terminal's frame, the token it draws, and what the visible symbol and id read. */
async function readToken(f) {
  return f.evaluate(() => {
    const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const page = document.querySelector("[data-token-page]");
    const sym = [...document.querySelectorAll(".tkp-sym")].find(vis);
    const ca = [...document.querySelectorAll(".tkp-ca")].find(vis);
    return { state: page?.getAttribute("data-token-page") ?? null, token: page?.getAttribute("data-token") ?? null, route: document.querySelector("main")?.getAttribute("data-route") ?? null, symbol: sym?.textContent ?? null, id: ca?.textContent ?? null, text: page?.textContent?.trim() ?? "", violations: window.__ctViolations ?? [] };
  });
}

const settle = async (page, f, state, ms = 8_000) => f.waitForSelector(`main[data-route="token"] [data-token-page="${state}"]`, { timeout: ms }).then(() => true, () => false);
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));

let n = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.name === "390";
    for (const scheme of SCHEMES) {
      const tag = `@${w.name} ${scheme}`;
      const reads = [];
      const errors = [];
      const broken = new Set();
      const ctx = await context(w, scheme, reads, broken, errors);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(String(e)));
      n++;

      // ---- Discover: the rows are links
      await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
      let f = await appFrame(page);
      check(!!f, `${tag}: no terminal frame in the shell`);
      if (!f) { await ctx.close(); continue; }
      const list = phone ? ".dsc-phone" : ".dsc-grid";
      await f.waitForSelector(`${list} [role="listitem"] a`, { timeout: 10_000 }).catch(() => {});
      const rows = await f.$$eval(`${list} [role="listitem"]`, (els) => els.filter((e) => e.getClientRects().length).map((e) => ({ token: e.getAttribute("data-token"), href: e.querySelector("a")?.getAttribute("href") ?? null, tag: e.querySelector("a")?.tagName ?? null, sym: e.querySelector(".dsc-sym")?.textContent ?? null })));
      check(rows.length >= 3, `${tag}: ${rows.length} rows drawn (the recorded New column holds 5)`);
      const bad = rows.filter((r) => r.tag !== "A" || r.href !== `/token/solana/${r.token}`);
      check(bad.length === 0, `${tag}: rows that are not a link to /token/solana/<mint>: ${bad.map((r) => `${r.token} ${r.href}`).slice(0, 3).join(" ")}`);
      const nested = await f.$$eval(`${list} [role="listitem"] a`, (as) => as.filter((a) => a.querySelector("a, button, input")).length);
      check(nested === 0, `${tag}: ${nested} rows hold another control inside the link`);
      // the badges (card app-launchpad-chain-badges) sit inside the link: a chain badge on every row, and the link holds every badge its row draws
      const outside = await f.$$eval(`${list} [role="listitem"]`, (els) => els.filter((e) => e.getClientRects().length).filter((e) => e.querySelectorAll(".tok-pb, .tok-cb").length !== (e.querySelector("a")?.querySelectorAll(".tok-pb, .tok-cb").length ?? -1) || e.querySelectorAll(".tok-cb").length !== 1).map((e) => e.getAttribute("data-token")));
      check(outside.length === 0, `${tag}: rows whose badges are not all inside the link (or with no chain badge): ${outside.slice(0, 3).join(" ")}`);

      // hover (desktop) and keyboard focus
      if (!phone) {
        const first = f.locator(`${list} [role="listitem"] a`).first();
        const bg0 = await first.evaluate((e) => getComputedStyle(e).backgroundColor);
        await first.hover();
        await page.waitForTimeout(250);
        const bg1 = await first.evaluate((e) => getComputedStyle(e).backgroundColor);
        check(bg1 !== bg0 && bg1 === "rgb(20, 20, 20)", `${tag}: hover ${bg0} -> ${bg1}, want rgb(20, 20, 20)`);
        const cs = await first.evaluate((e) => ({ color: getComputedStyle(e).color, deco: getComputedStyle(e).textDecorationLine }));
        check(cs.deco === "none", `${tag}: the link is underlined (${cs.deco})`);
        await shot(page, `discover-hover-${w.name}-${scheme}`);
        await page.mouse.move(5, 5);
      }
      await f.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
      const firstA = f.locator(`${list} [role="listitem"] a`).first();
      await firstA.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const ring = await firstA.evaluate((e) => (e === document.activeElement ? { style: getComputedStyle(e).outlineStyle, width: getComputedStyle(e).outlineWidth, color: getComputedStyle(e).outlineColor, off: getComputedStyle(e).outlineOffset } : null));
      // 2 px in layout px; the desktop draws layout px at --fit-zoom (shell/fit.ts) and the engine snaps an outline to whole
      // device pixels, so at 1440 (zoom 0.75, dpr 1) it reads 1 device px = 1.3333 px: the width is 1 or 2 device px, the offset its negative
      const zoom = await f.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fit-zoom")) || 1);
      const dev = ring ? (parseFloat(ring.width) * zoom * w.deviceScaleFactor) : 0;
      check(ring?.style === "solid" && Math.abs(dev - Math.round(dev)) < 0.02 && Math.round(dev) >= 1 && Math.round(dev) <= 2 * w.deviceScaleFactor && ring.color === "rgb(91, 140, 255)" && Math.abs(parseFloat(ring.off) + parseFloat(ring.width)) < 0.02, `${tag}: the focused row's ring ${JSON.stringify(ring)} at zoom ${zoom}: want a solid blue ring of whole device pixels, drawn inside`);
      await shot(page, `discover-focus-${w.name}-${scheme}`);

      // ---- a click on a row draws that token's page
      const pickIdx = [1, 4];
      for (const [k, idx] of pickIdx.entries()) {
        // the desktop's second pick is in another column (hot), so a row of every column opens; the phone has one list
        const sel = phone || k === 0 ? `${list} [role="listitem"]` : `${list} .dsc-col[data-col="hot"] [role="listitem"]`;
        const row = f.locator(sel).nth(k === 0 ? idx : 0);
        const mint = await row.getAttribute("data-token");
        const sym = await row.locator(".dsc-sym").textContent();
        const box = await row.boundingBox();
        reads.length = 0;
        if (phone) await page.touchscreen.tap(box.x + box.width - 6, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2);
        const ok = await settle(page, f, "ready");
        const t = ok ? await readToken(f) : null;
        check(ok, `${tag} click ${k + 1}: no ready token page after the click on ${sym} ${mint}`);
        if (t) {
          check(t.token === mint, `${tag} click ${k + 1}: data-token ${t.token}, the row's ${mint}`);
          check(t.symbol === sym, `${tag} click ${k + 1}: page symbol ${t.symbol}, the row's ${sym}`);
          check(t.id === mint, `${tag} click ${k + 1}: page id ${t.id}, the row's ${mint}`);
          check(reads.length === 1 && reads[0] === `solana/${mint}`, `${tag} click ${k + 1}: token reads ${JSON.stringify(reads)}`);
        }
        await page.waitForTimeout(150);
        check(page.url() === `${SIGN_HOST}/token/solana/${mint}`, `${tag} click ${k + 1}: the top window's address is ${page.url()}`);
        check(f.url() === `${APP_HOST}/token/solana/${mint}`, `${tag} click ${k + 1}: the terminal is at ${f.url()}`);
        if (k === 0) await shot(page, `token-after-click-${w.name}-${scheme}`);
        // back to Discover through the tab bar / top bar, for the next pick
        await f.locator(phone ? '.tabbar a[href="/discover"]' : '.tb .nav a[href="/discover"]').click();
        await f.waitForSelector(`${list} [role="listitem"] a`, { timeout: 10_000 });
      }

      // ---- Control-click and middle-click open a new tab at the shell, the first stays on Discover (desktop and phone rows)
      if (!phone) {
        const row = f.locator(`${list} [role="listitem"]`).nth(2);
        const mint = await row.getAttribute("data-token");
        for (const how of ["control", "middle"]) {
          const popup = ctx.waitForEvent("page", { timeout: 8_000 }).catch(() => null);
          if (how === "control") await row.locator("a").click({ modifiers: ["ControlOrMeta"], position: { x: 40, y: 20 } });
          else await row.locator("a").click({ button: "middle", position: { x: 40, y: 20 } });
          const np = await popup;
          check(!!np, `${tag} ${how}-click: no new tab`);
          if (np) {
            const nf = await appFrame(np);
            check(!!nf, `${tag} ${how}-click: the new tab has no terminal frame (top at ${np.url()})`);
            if (nf) {
              check(await settle(np, nf, "ready"), `${tag} ${how}-click: the new tab drew no token`);
              const t = await readToken(nf);
              check(t.token === mint, `${tag} ${how}-click: the new tab's token ${t.token}, the row's ${mint}`);
              check(np.url() === `${SIGN_HOST}/token/solana/${mint}`, `${tag} ${how}-click: the new tab's address ${np.url()}`);
            }
            await np.close();
          }
          check(page.url() === `${SIGN_HOST}/discover`, `${tag} ${how}-click: the first tab moved to ${page.url()}`);
        }
      }
      await ctx.close();
    }

    // ---- deep links, not found, error: dark only (the page has one scheme)
    {
      const tag = `@${w.name}`;
      const reads = [];
      const errors = [];
      const broken = new Set(["BrokenMint1111111111111111111111111111111111"]);
      const ctx = await context(w, "dark", reads, broken, errors);
      const mint = [...ROWS.keys()][3];
      const sym = ROWS.get(mint).symbol;

      const open = async (url, state, name) => {
        n++;
        reads.length = 0;
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(url, { waitUntil: "load" });
        const f = await appFrame(page);
        const ok = f ? await settle(page, f, state) : false;
        check(ok, `${tag} ${name}: no [data-token-page=${state}] (frame ${f ? f.url() : "none"})`);
        return { page, f, t: ok ? await readToken(f) : null };
      };

      // a deep link on SIGN_HOST (the shell frames APP_HOST at its path) and on APP_HOST (the top-level move keeps it)
      for (const [name, url] of [["deep link on SIGN_HOST", `${SIGN_HOST}/token/solana/${mint}`], ["deep link on APP_HOST", `${APP_HOST}/token/solana/${mint}`]]) {
        const { page, f, t } = await open(url, "ready", name);
        if (t) {
          check(t.token === mint && t.id === mint && t.symbol === sym, `${tag} ${name}: drew ${t.symbol} ${t.id}, the mint is ${sym} ${mint}`);
          check(page.url() === `${SIGN_HOST}/token/solana/${mint}`, `${tag} ${name}: the top window's address ${page.url()}`);
          check(f.url() === `${APP_HOST}/token/solana/${mint}`, `${tag} ${name}: the terminal's frame at ${f.url()}`);
          check(reads.length === 1 && reads[0] === `solana/${mint}`, `${tag} ${name}: token reads ${JSON.stringify(reads)}`);
          check(t.violations.length === 0, `${tag} ${name}: CSP ${t.violations.join("; ")}`);
          const ready = await f.evaluate(() => document.documentElement.dataset.signpage);
          check(ready === "ready", `${tag} ${name}: signing page ${ready}`);
          if (name.endsWith("SIGN_HOST")) {
            await shot(page, `deep-link-${w.name}`);
            await page.reload({ waitUntil: "load" });
            const g = await appFrame(page);
            const again = g && (await settle(page, g, "ready")) ? await readToken(g) : null;
            check(again?.token === mint && page.url() === `${SIGN_HOST}/token/solana/${mint}`, `${tag} reload at the deep link: ${again?.token} at ${page.url()}`);
          }
        }
        await page.close();
      }

      // an unknown id, and a chain the terminal does not draw: the not-found state; the bad chain reads nothing
      {
        const { page, t } = await open(`${SIGN_HOST}/token/solana/NoSuchMint1111111111111111111111111111111`, "empty", "unknown id");
        if (t) {
          check(t.text === "No token", `${tag} unknown id: reads "${t.text}"`);
          check(reads.length === 1, `${tag} unknown id: token reads ${JSON.stringify(reads)}`);
          check((await page.frames().find((x) => x !== page.mainFrame()).locator(".tkp-retry").count()) === 0, `${tag} unknown id: Retry shown`);
        }
        await shot(page, `not-found-${w.name}`);
        await page.close();
      }
      {
        const { page, t } = await open(`${SIGN_HOST}/token/dogecoin/${mint}`, "empty", "bad chain");
        if (t) {
          check(t.text === "No token", `${tag} bad chain: reads "${t.text}"`);
          check(reads.length === 0, `${tag} bad chain: token reads ${JSON.stringify(reads)}, want none`);
        }
        await page.close();
      }
      // a known chain the helper has no token for (it answers 404): the same state
      {
        const { page } = await open(`${SIGN_HOST}/token/base/0x0000000000000000000000000000000000000001`, "empty", "base, unknown");
        await page.close();
      }
      // a failed read: the error state with Retry, never another token; Retry reads again
      {
        const { page, f, t } = await open(`${SIGN_HOST}/token/solana/BrokenMint1111111111111111111111111111111111`, "error", "failed read");
        if (t) {
          check(t.token === null && t.text.includes("Offline"), `${tag} failed read: ${JSON.stringify({ token: t.token, text: t.text })}`);
          reads.length = 0;
          broken.clear();
          await f.locator(".tkp-retry").click();
          check(await settle(page, f, "empty"), `${tag} failed read: Retry did not read again`);
          check(reads.length === 1, `${tag} failed read: Retry read ${JSON.stringify(reads)}`);
        }
        await page.close();
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
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} runs`);
  process.exit(1);
}
console.log(`PASS ${n} runs (390 and 1440; dark and light for the row clicks, new tabs, hover and focus; deep links, not found, error) from the built app inside the stand-in shell${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
