#!/usr/bin/env node
// Discover and the token page on Base and Robinhood (card app-chains-evm), from the built app inside the stand-in shell
// (as test/token-route/run.mjs): HELPER_HOST answered from recorded live answers, each chain's lists from its own
// recording (test/discover-data for Solana, test/chains-evm for Base and Robinhood), and the token, candles and holders
// reads of the top of Base's and Robinhood's Trending lists from theirs. At 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr
// 1), the terminal's dark scheme:
//   - Discover on All draws rows of all three chains, each row a link to /token/<its chain>/<id> with one chain badge,
//     the badge its row's chain;
//   - the shell's one chain filter (the top bar's chain chip at 1440, the search sheet's chips at 390) offers Base and
//     Robinhood, and each pick leaves Discover drawing only that chain's rows;
//   - /token/base/<id> and /token/robinhood/<id> draw the page ready, its data-token and symbol the recorded row's, its
//     avatar's chain badge that chain;
//   - (card app-chains-evm-rail) at 1440 those pages' left rail lists every chain's rows on All, Trending in Discover's
//     order, and only the page's chain's rows once the filter picks it; at both widths / draws the top of every chain's
//     Trending column on All, and the top of Base's once the filter picks Base, its chain badge Base;
//   - no page error, no CSP violation.
//   node apps/terminal/test/chains-evm/run.mjs [--build <dir>] [--shots <dir>]     PASS exit 0, FAIL exit 1
// --build tests a build made elsewhere (main's, for the red run); by default this tree is built.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";
import { APP_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { columnRows } from "../../src/screens/discover/model.ts";

const HELPER = "https://ct-api.unrealized.trade";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? path.resolve(args[args.indexOf(k) + 1]) : null);
const SHOTS = opt("--shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const EVM = ["base", "robinhood"];

const read = (f) => JSON.parse(readFileSync(path.join(APP, "test", f), "utf8"));
const unzip = (fields, values) => Object.fromEntries(fields.map((k, i) => [k, values[i]]));
const listsOf = (rec) => ({ chain: rec.chain, as_of_ms: rec.as_of_ms, lists: Object.fromEntries(Object.entries(rec.lists).map(([k, rows]) => [k, rows.map((v) => unzip(rec.fields, v))])) });
const LISTS = { solana: listsOf(read("discover-data/helper-lists-2026-11-01.json")), base: listsOf(read("chains-evm/lists-base-2026-11-09.json")), robinhood: listsOf(read("chains-evm/lists-robinhood-2026-11-09.json")) };
const TOKENS = Object.fromEntries(
  EVM.map((c) => {
    const t = read(`chains-evm/token-${c}-2026-11-09.json`);
    const row = unzip(t.fields, t.row);
    return [c, { id: row.token, answer: { ...t.rest, row }, candles: read(`chains-evm/candles-${c}-2026-11-09.json`).body, holders: read(`chains-evm/holders-${c}-2026-11-09.json`).body }];
  }),
);

/** Discover's Trending order of a snapshot's rows, as the rail and / take it. */
const trendingOf = (snaps) => columnRows({ chain: "all", as_of_ms: 0, lists: Object.fromEntries(["new", "trending", "trending_5m", "trending_1h", "graduating"].map((k) => [k, snaps.flatMap((x) => x.lists[k] ?? [])])) }, "trending");
/** / on All: the top of every chain's Trending column; on Base: Base's top. */
const TOP_ALL = trendingOf(Object.values(LISTS))[0];
const TOP_BASE = trendingOf([LISTS.base])[0];

const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
};
const json = (status, body) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });

/** HELPER_HOST from the recordings: every chain's lists, and the Base and Robinhood token's reads; the rest the harness's. */
function helperAnswer(u) {
  const chain = u.searchParams.get("chain");
  if (u.pathname === "/v1/market/lists") return LISTS[chain] ? json(200, LISTS[chain]) : json(404, { error: { code: "not_found" } });
  const t = TOKENS[chain];
  if (!t) return null;
  // a token of that chain's recorded lists other than the recorded one (the top / draws on a pick) answers the recorded
  // reads, its row named as that token
  const id = u.searchParams.get("token");
  const listed = id === t.id ? t.answer.row : Object.values(LISTS[chain].lists).flat().find((r) => r.token === id);
  if (!listed) return json(404, { error: { code: "not_found" } });
  if (u.pathname === "/v1/market/token") return json(200, { ...t.answer, row: { ...t.answer.row, token: id, symbol: listed.symbol, name: listed.name } });
  if (u.pathname === "/v1/market/candles") return json(200, t.candles);
  if (u.pathname === "/v1/market/holders") return json(200, t.holders);
  return null;
}

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-chains-evm-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const dir = opt("--build") ?? (await build());
const route = await harnessRoute(dir, "signed");
const browser = await launchHarnessBrowser("chromium");

const appFrame = async (page, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    const f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
};
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));

/** Discover's drawn rows in the frame: each row's link and its chain badges. */
const rowsOf = (f, list) =>
  f.$$eval(`${list} [role="listitem"]`, (els) =>
    els.filter((e) => e.getClientRects().length).map((e) => ({ token: e.getAttribute("data-token"), href: e.querySelector("a")?.getAttribute("href") ?? null, badges: [...e.querySelectorAll(".tok-cb")].map((b) => b.getAttribute("data-chain")) })),
  );
const chainOfHref = (h) => /^\/token\/([a-z]+)\//.exec(h ?? "")?.[1] ?? null;

/** The rail's rows in the frame once its lists are drawn: each row's token, link and whether it is the page's own. */
const railOf = async (f) => {
  await f.waitForSelector('[data-testid="token-rail"][data-state="ready"] [role="listitem"]', { timeout: 10_000 }).catch(() => {});
  await f.waitForTimeout(200);
  return f.$$eval('[data-testid="token-rail"] [role="listitem"]', (els) => els.map((e) => ({ token: e.getAttribute("data-token"), href: e.querySelector("a")?.getAttribute("href") ?? null, current: e.querySelector("a")?.getAttribute("aria-current") === "page" })));
};

/** Pick one chain on the shell's chain filter: the top bar's chain chip at 1440, the search sheet's chips at 390. */
async function pick(f, page, phone, c) {
  if (phone) {
    await f.click('[data-testid="search-button-phone"]');
    const chip = f.locator(`[data-testid="chain-chips"] [data-chain="${c}"]`);
    const has = await chip.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    check(has, `@390: the search sheet's chain chips offer no ${c}`);
    if (has) await chip.click();
    await f.click(".srch-back");
  } else {
    await f.click('[data-testid="chain-chip"]');
    const item = f.locator(`[data-testid="chain-menu"] [data-chain="${c}"]`);
    const has = await item.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    check(has, `@1440: the chain chip's menu offers no ${c}`);
    if (has) await item.click();
    else await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(300);
}

let loads = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.name === "390";
    const tag = `@${w.name}`;
    const errors = [];
    const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
    await ctx.route("**/*", (r) => {
      const u = new URL(r.request().url());
      const a = u.origin === HELPER ? helperAnswer(u) : null;
      return a ? r.fulfill(a) : route(r);
    });
    await ctx.addInitScript(() => {
      window.__ctViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));

    // ---- Discover on All: every chain's rows
    await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
    loads++;
    const f = await appFrame(page);
    check(!!f, `${tag}: no terminal frame in the shell`);
    if (!f) continue;
    const list = phone ? ".dsc-phone" : ".dsc-grid";
    await f.waitForSelector(`${list} [role="listitem"] a`, { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(400);
    let rows = await rowsOf(f, list);
    const seen = new Set(rows.map((r) => chainOfHref(r.href)));
    for (const c of ["solana", ...EVM]) check(seen.has(c), `${tag} All: no ${c} row drawn (chains drawn: ${[...seen].join(", ") || "none"})`);
    const off = rows.filter((r) => r.href !== `/token/${chainOfHref(r.href)}/${r.token}` || r.badges.length !== 1 || r.badges[0] !== chainOfHref(r.href));
    check(off.length === 0, `${tag} All: rows whose link or chain badge is not their own chain's: ${off.slice(0, 3).map((r) => `${r.href} [${r.badges.join(",")}]`).join(" ")}`);
    await shot(page, `discover-all-${w.name}`);

    // ---- the chain filter: each EVM chain alone
    for (const c of EVM) {
      if (phone) {
        await f.click('[data-testid="search-button-phone"]');
        const chip = f.locator(`[data-testid="chain-chips"] [data-chain="${c}"]`);
        const has = await chip.waitFor({ timeout: 5_000 }).then(() => true, () => false);
        check(has, `${tag}: the search sheet's chain chips offer no ${c}`);
        if (has) await chip.click();
        await f.click(".srch-back");
      } else {
        await f.click('[data-testid="chain-chip"]');
        const item = f.locator(`[data-testid="chain-menu"] [data-chain="${c}"]`);
        const has = await item.waitFor({ timeout: 5_000 }).then(() => true, () => false);
        check(has, `${tag}: the chain chip's menu offers no ${c}`);
        if (has) await item.click();
        else await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(300);
      rows = await rowsOf(f, list);
      const other = rows.filter((r) => chainOfHref(r.href) !== c);
      check(rows.length > 0, `${tag} ${c}: Discover draws no rows`);
      check(other.length === 0, `${tag} ${c}: ${other.length} rows of another chain drawn: ${other.slice(0, 3).map((r) => r.href).join(" ")}`);
      await shot(page, `discover-${c}-${w.name}`);
    }

    // ---- the token page of each EVM chain's top Trending token
    for (const c of EVM) {
      const t = TOKENS[c];
      await page.goto(`${APP_HOST}/token/${c}/${t.id}`, { waitUntil: "load" });
      loads++;
      const g = await appFrame(page);
      const ready = g ? await g.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: 10_000 }).then(() => true, () => false) : false;
      check(ready, `${tag} /token/${c}: the page is not ready`);
      if (!g || !ready) continue;
      await page.waitForTimeout(600);
      const m = await g.evaluate(() => {
        const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
        const p = document.querySelector("[data-token-page]");
        const sym = [...document.querySelectorAll(".tkp-sym")].find(vis);
        // the token's own avatar badges (the head, the phone's bar), not the rail's rows (rail.ts, every chain's lists)
        const badges = [...document.querySelectorAll("main [data-token-page] .tok-cb")].filter((b) => vis(b) && !b.closest(".tkr-row")).map((b) => b.getAttribute("data-chain"));
        return { token: p?.getAttribute("data-token") ?? null, symbol: sym?.textContent ?? null, badges, violations: window.__ctViolations ?? [] };
      });
      check(m.token === t.id, `${tag} /token/${c}: data-token ${m.token}, not ${t.id}`);
      check(m.symbol === t.answer.row.symbol, `${tag} /token/${c}: symbol ${m.symbol}, not ${t.answer.row.symbol}`);
      check(m.badges.length > 0 && m.badges.every((b) => b === c), `${tag} /token/${c}: the page's chain badges [${m.badges.join(",")}], not ${c}`);
      check(m.violations.length === 0, `${tag} /token/${c}: CSP violation ${m.violations.join("; ")}`);
      await shot(page, `token-${c}-${w.name}`);
      if (!phone) {
        // ---- the rail on All, then on the page's chain
        let r = await railOf(g);
        const drawn = new Set(r.map((x) => chainOfHref(x.href)));
        check(drawn.size > 1 && drawn.has(c), `${tag} /token/${c} rail on All: chains drawn [${[...drawn].join(",")}], not every chain's`);
        const want = trendingOf(Object.values(LISTS)).map((x) => x.token);
        check(r.length > 0 && r.every((x, i) => x.token === want[i]), `${tag} /token/${c} rail on All: not Discover's Trending order (${r.slice(0, 3).map((x) => x.href).join(" ")})`);
        check(r.every((x) => x.href === `/token/${chainOfHref(x.href)}/${x.token}`), `${tag} /token/${c} rail on All: a row's link is not its own token's`);
        await pick(g, page, false, c);
        r = await railOf(g);
        const other = r.filter((x) => chainOfHref(x.href) !== c);
        check(r.length > 0 && other.length === 0, `${tag} /token/${c} rail on ${c}: ${r.length} rows, ${other.length} of another chain (${other.slice(0, 3).map((x) => x.href).join(" ")})`);
        check(r.some((x) => x.current) === r.some((x) => x.token === t.id), `${tag} /token/${c} rail on ${c}: the page's own token not marked`);
        await shot(page, `token-${c}-rail-${c}-${w.name}`);
      }
    }

    // ---- / on All, then on Base
    await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
    loads++;
    const h = await appFrame(page);
    const topOf = async () => {
      const ok = h ? await h.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: 10_000 }).then(() => true, () => false) : false;
      await page.waitForTimeout(400);
      return ok ? h.evaluate(() => ({ token: document.querySelector("[data-token-page]")?.getAttribute("data-token") ?? null, badges: [...document.querySelectorAll("main [data-token-page] .tok-cb")].filter((b) => b.getClientRects().length && !b.closest(".tkr-row")).map((b) => b.getAttribute("data-chain")) })) : null;
    };
    let top = await topOf();
    check(top?.token === TOP_ALL.token, `${tag} / on All: data-token ${top?.token ?? "none"}, not every chain's top Trending ${TOP_ALL.chain}/${TOP_ALL.token}`);
    await shot(page, `top-all-${w.name}`);
    if (h) {
      await pick(h, page, phone, "base");
      await h.waitForFunction((id) => document.querySelector('[data-token-page="ready"]')?.getAttribute("data-token") === id, TOP_BASE.token, { timeout: 10_000 }).catch(() => {});
      top = await topOf();
      check(top?.token === TOP_BASE.token, `${tag} / on Base: data-token ${top?.token ?? "none"}, not Base's top Trending ${TOP_BASE.token}`);
      check(!!top && top.badges.length > 0 && top.badges.every((b) => b === "base"), `${tag} / on Base: the page's chain badges [${top?.badges.join(",") ?? ""}], not base`);
      await shot(page, `top-base-${w.name}`);
    }
    check(errors.length === 0, `${tag}: page error ${errors.slice(0, 2).join("; ")}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

for (const x of fails) console.log(`FAIL ${x}`);
console.log(`chains-evm: ${loads} loads at 390 and 1440 (${browserLabel(browser)}); Discover on All, Base and Robinhood, /token/base and /token/robinhood with their rail on All and on their chain, / on All and on Base`);
console.log(fails.length ? `FAIL (${fails.length})` : "PASS");
process.exit(fails.length ? 1 : 0);
