#!/usr/bin/env node
// Live check of card app-no-test-token: opening the app shows a real token, never a test one. Headless Chromium opens
// APP_HOST/ at 1440 x 900 (desktop) and 390 x 844 (phone, dpr 2, touch), and APP_HOST/?fx=curve at 1440 (the old
// fixture switch in the address bar), finds the frame that draws the token route (APP_HOST runs inside SIGN_HOST's
// shell), waits for it to leave its loading state and reads:
//   - the served JS: every script APP_HOST answered the frame holds no fixture id or name ("fixture", any case: the old
//     GlowFixtureCurve ids, the fixture source tag);
//   - the page: main[data-route="token"] draws the page ready, and its data-token is the top of the Trending column
//     (Discover's own order, columnRows in apps/terminal/src/screens/discover/model.ts) of the lists answer the page
//     itself read at HELPER_HOST (GET /v1/market/lists?chain=solana, 200);
//   - the token read: the page read GET /v1/market/token for that same mint, 200, and its row is that mint.
// A screenshot of every load is kept.
//   node scripts/live-checks/app-no-test-token.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute), the
// helper still answered live; --record writes what the run read, so the check's test can replay it through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { columnRows } from "../../apps/terminal/src/screens/discover/model.ts";
import { launchBrowser } from "../browsers.mjs";

const KEY = "app-no-test-token";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const LISTS_URL = `${HELPER_HOST}/v1/market/lists?chain=solana`;
export const TOKEN_URL = (mint) => `${HELPER_HOST}/v1/market/token?chain=solana&token=${encodeURIComponent(mint)}`;
export const FIXTURE = /fixture/i;
export const LOADS = [
  { name: "desktop", path: "/", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", path: "/", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", path: "/?fx=curve", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READ_MS = 25_000;

// ------------------------------------------------------------------------------------------------ the verdict
/** The top of the Trending column of the recorded rows (the list columnRows reads: trending_1h, else trending). */
export function topOf(rows) {
  const r = rows.map((x) => ({ ...x, token: x.mint }));
  return columnRows({ chain: "solana", as_of_ms: 0, lists: { new: [], trending: r, trending_1h: r } }, "trending")[0]?.token ?? null;
}

/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(loads.length === LOADS.length, `${loads.length} loads of ${LOADS.length} (/ at both widths, /?fx=curve)`);
  for (const l of loads) {
    const tag = `${l.width} ${l.path}`;
    const js = l.scripts ?? [];
    const hits = js.reduce((n, s) => n + s.hits, 0);
    const jsBad = [];
    if (js.length === 0) jsBad.push("no script read");
    for (const s of js) if (s.status !== 200) jsBad.push(`${s.url} answered ${s.status}`);
    if (hits) jsBad.push(`${hits} fixture hit(s): ${js.filter((s) => s.hits).map((s) => `${s.url} ${s.hits} (${s.samples.join(" | ")})`).join("; ")}`);
    say(jsBad.length === 0, `${tag}: the served JS (${js.length} script(s), ${js.reduce((n, s) => n + s.bytes, 0)} bytes) ${jsBad.length ? jsBad.join("; ") : "holds no fixture id or name"}`);

    const top = l.lists?.trending ? topOf(l.lists.trending) : null;
    const bad = [];
    if (l.route !== "token") bad.push(`drew ${l.route ?? "nothing"}`);
    else if (l.state !== "ready") bad.push(`state ${l.state ?? "none"}, not ready`);
    if (!l.lists) bad.push("the page read no lists answer");
    else {
      if (l.lists.url !== LISTS_URL) bad.push(`lists read at ${l.lists.url}`);
      if (l.lists.status !== 200) bad.push(`lists status ${l.lists.status}`);
      if (!top) bad.push("the lists' Trending column is empty");
    }
    if (typeof l.shown === "string" && FIXTURE.test(l.shown)) bad.push(`data-token ${l.shown} is a fixture`);
    if (top && l.shown !== top) bad.push(`data-token ${l.shown ?? "none"}, the lists' top Trending token is ${top}`);
    if (!l.token) bad.push("the page read no token answer");
    else if (top) {
      const at = `${l.token.url}?chain=${l.token.chain}&token=${encodeURIComponent(l.token.mint)}`;
      if (at !== TOKEN_URL(top) || l.token.params !== 2) bad.push(`token read at ${at} (${l.token.params} params), not ${TOKEN_URL(top)}`);
      if (l.token.status !== 200) bad.push(`token status ${l.token.status}`);
      if (l.token.rowMint !== top) bad.push(`token row ${l.token.rowMint ?? "none"}`);
    }
    if (!l.shot) bad.push("no screenshot");
    say(bad.length === 0, `${tag}: ${bad.length ? bad.join("; ") : `ready, data-token ${l.shown} (${l.symbol}) = the top of Trending in the lists it read (200), its token read 200 for that mint`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
const MEASURE = () => {
  const root = document.querySelector('main[data-route="token"]');
  const p = root?.querySelector("[data-token-page]");
  const vis = [...(root?.querySelectorAll("h1.tkp-sym") ?? [])].find((e) => e.getClientRects().length);
  return { route: root?.dataset.route ?? null, state: p?.getAttribute("data-token-page") ?? null, shown: p?.getAttribute("data-token") ?? null, symbol: vis?.textContent ?? null };
};

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed");
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${build} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const [i, w] of LOADS.entries()) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
      if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
      const page = await ctx.newPage();
      const scripts = [];
      let lists = null;
      let token = null;
      page.on("response", (r) => {
        const u = r.url();
        if (u === LISTS_URL && !lists) lists = r;
        if (u.startsWith(`${HELPER_HOST}/v1/market/token?`) && !token) token = r;
        if (r.request().resourceType() === "script" && new URL(u).origin === APP_HOST) scripts.push(r);
      });
      await page.goto(`${APP_HOST}${w.path}`, { waitUntil: "load" });
      let app = null;
      let m = null;
      for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
        for (const f of page.frames()) {
          const x = await f.evaluate(MEASURE).catch(() => null);
          if (x?.route) {
            app = f;
            m = x;
            break;
          }
        }
        if (m && m.state && m.state !== "loading") break;
      }
      await page.waitForTimeout(500);
      if (app) m = await app.evaluate(MEASURE).catch(() => m);
      const shot = path.join(shots, `${i}-${w.name}-${w.path === "/" ? "root" : "fx"}.png`);
      await page.screenshot({ path: shot });
      const js = [];
      for (const s of scripts) {
        const text = await s.text().catch(() => "");
        const samples = [...text.matchAll(/.{0,24}fixture.{0,24}/gi)].map((x) => x[0]);
        js.push({ url: s.url(), status: s.status(), bytes: text.length, hits: samples.length, samples: samples.slice(0, 6) });
      }
      const lb = lists ? await lists.json().catch(() => null) : null;
      const rows = lb?.lists?.trending_1h ?? lb?.lists?.trending ?? null;
      const tb = token ? await token.json().catch(() => null) : null;
      rec.loads.push({
        width: w.name,
        path: w.path,
        framed: app ? app !== page.mainFrame() : null,
        route: m?.route ?? null,
        state: m?.state ?? null,
        shown: m?.shown ?? null,
        symbol: m?.symbol ?? null,
        scripts: js,
        // the rows the Trending column orders, kept to the fields its order reads (the id as `mint`: gitleaks reads a long
      // id beside a token key as a secret)
        lists: lists ? { url: lists.url(), status: lists.status(), as_of_ms: lb?.as_of_ms ?? null, trending: Array.isArray(rows) ? rows.map((r) => ({ mint: r?.token, symbol: r?.symbol, vol_1h_usd: r?.vol_1h_usd ?? null })) : null } : null,
        // the read's URL kept as its path, chain and mint (gitleaks reads a long id after `token=` as a secret)
        token: token ? { url: token.url().split("?")[0], chain: new URL(token.url()).searchParams.get("chain"), mint: new URL(token.url()).searchParams.get("token"), params: [...new URL(token.url()).searchParams].length, status: token.status(), rowMint: tb?.row?.token ?? null, symbol: tb?.row?.symbol ?? null } : null,
        shot,
      });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
