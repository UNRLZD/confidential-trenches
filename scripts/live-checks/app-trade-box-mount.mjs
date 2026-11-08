#!/usr/bin/env node
// Live check of card app-trade-box-mount: the token page has its trade box and safety grid, signed out as designed.
// Headless Chrome opens APP_HOST at 1440 x 900 (desktop) and 390 x 844 (phone, dpr 2, touch), a fresh browser, so signed
// out, finds the frame that draws the token route (APP_HOST runs inside SIGN_HOST's shell) and reads:
//   - 1440: the box is in the right column, to the right of the chart and inside the window; it reads `Bal —`, the exit
//     plan block off with its line, the main button `Sign in to trade` (enabled), its state S8.1; the safety grid sits
//     under the Route & fees line with twelve cells, each label and value what the page's own token read (GET
//     /v1/market/token, 200, the row and `risk` of the token the page draws) holds, worked out here from the answer's
//     numbers; the button opens the sign-in sheet (S2.1);
//   - 390: the page behind holds no box; the bar's Buy opens the trade sheet with the same box and grid in it, inside the
//     window, and its button opens the sign-in sheet over it.
// A screenshot of every load and step is kept.
// After: app
//   node scripts/live-checks/app-trade-box-mount.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell, signed out (app-in-shell.mjs harnessRoute
// "tap"), the helper still answered live; --record writes what the run read, so the check's test can replay it through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { count, usd } from "../../apps/terminal/src/screens/discover/format.ts";
import { named } from "./record-names.mjs";

const KEY = "app-trade-box-mount";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const LOADS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const READ_MS = 25_000;
/** The twelve cells, in the design's order (R5 token.js U.riskGrid at design-lock-r5), with their labels. */
export const CELLS = [
  ["top10", "Top 10 %"], ["dev", "Dev %"], ["snipers", "Snipers %"], ["holders", "Holders"], ["liq", "Liq"], ["age", "Age"],
  ["insiders", "Insiders"], ["tax", "Tax"], ["mintAuth", "Mint auth"], ["freezeAuth", "Freeze auth"], ["lp", "LP"], ["honeypot", "Honeypot"],
];

// ------------------------------------------------------------------------------------------------ the verdict
const share = (b) => (Number.isInteger(b) && b >= 0 && b <= 10_000 ? b : null);
/** A share in basis points as the design draws a percent (R5 P.pctS): 22.98% is 23%, 5.1% is 5.1%, a trace <0.1%. */
const pct = (b) => {
  const v = b / 100;
  return v >= 99.95 ? "100%" : v < 0.05 && v > 0 ? "<0.1%" : `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;
};
const LINE = { top10: 30, dev: 10, snipers: 10, insiders: 10 };
const level = (k, b) => (b / 100 >= LINE[k] * 1.5 ? "bad" : b / 100 >= LINE[k] ? "warn" : "plain");

/** What the grid must draw for one token read ({ row, risk }, the values the read holds): label, value, whether the cell
 *  draws the cross, and its verdict colour (null: not checked; the first three cells draw a plain verdict as good). */
export function expectedCells(read) {
  const { row, risk } = read;
  const pc = (k, b) => {
    const s = share(b);
    return s === null ? { value: "—", tone: "unknown" } : { value: pct(s), tone: level(k, s) };
  };
  const top = pc("top10", row.top10_bps);
  const fee = risk.tax;
  const buy = share(fee?.buy_bps);
  const sell = share(fee?.sell_bps);
  const taxBps = buy === null || sell === null ? null : Math.max(buy, sell);
  const auth = (v) => (typeof v === "boolean" ? { value: "", cross: v, tone: v ? "bad" : "plain" } : { value: "—", tone: "unknown" });
  const onCurve = row.launchpad != null && Number.isInteger(row.curve_bps) && row.curve_bps >= 0 && row.curve_bps < 10_000;
  const hp = risk.honeypot;
  const by = Object.fromEntries([
    ["top10", { ...top, cross: share(row.top10_bps) !== null && row.top10_bps / 100 >= LINE.top10 }],
    ["dev", pc("dev", row.dev_bps)],
    ["snipers", pc("snipers", row.snipers_bps)],
    ["holders", { value: count(row.holders), tone: count(row.holders) === "—" ? "unknown" : "plain" }],
    ["liq", { value: usd(row.liq_usd), tone: usd(row.liq_usd) === "—" ? "unknown" : "plain" }],
    ["age", { value: row.created_s == null ? "—" : /^\d+[smhd]$/, tone: row.created_s == null ? "unknown" : "plain" }],
    ["insiders", pc("insiders", risk.insiders_bps)],
    ["tax", taxBps === null ? { value: "—", tone: "unknown" } : { value: taxBps === 0 ? "0%" : pct(taxBps), tone: taxBps === 0 ? "plain" : "warn" }],
    ["mintAuth", auth(row.mint_auth)],
    ["freezeAuth", auth(row.freeze_auth)],
    ["lp", risk.lp?.class === "curve" && onCurve ? { value: "Curve", tone: "plain" } : { value: "—", tone: "unknown" }],
    ["honeypot", typeof hp === "boolean" ? { value: "", cross: hp, tone: hp ? "bad" : "plain" } : { value: "—", tone: "unknown" }],
  ]);
  return CELLS.map(([id, label], i) => ({ id, label, ...by[id], cross: by[id].cross ?? false, tone: i < 3 && by[id].tone === "plain" ? "good" : by[id].tone }));
}

/** The faults of one box and its grid as the page drew them (m) against the token read (read): [] when none. */
export function boxFaults(m, read) {
  const bad = [];
  if (!m?.box) return ["no trade box on the page"];
  const b = m.box;
  if (b.state !== "S8.1") bad.push(`the box's state is ${b.state ?? "none"}, not S8.1`);
  if (b.balance !== "Bal —") bad.push(`the balance reads ${JSON.stringify(b.balance)}, not "Bal —"`);
  if (/available/i.test(b.text ?? "")) bad.push('the box says "available"');
  if (b.exit?.text !== "Exit plan Sells automatically once this buy fills") bad.push(`the exit plan block reads ${JSON.stringify(b.exit?.text)}`);
  if (b.exit?.pressed !== "false" || b.exit?.on !== "false") bad.push("the exit plan is not off");
  if (b.cta?.text !== "Sign in to trade") bad.push(`the main button reads ${JSON.stringify(b.cta?.text)}, not "Sign in to trade"`);
  else if (b.cta.disabled) bad.push("the main button is disabled");
  if (!(b.gridTop >= b.lineBottom - 0.5)) bad.push(`the grid is not under the Route & fees line (grid top ${b.gridTop}, line bottom ${b.lineBottom})`);
  const want = read ? expectedCells(read) : null;
  const got = b.cells ?? [];
  if (got.length !== CELLS.length) bad.push(`${got.length} grid cells, not ${CELLS.length}`);
  else if (want) {
    for (const [i, w] of want.entries()) {
      const g = got[i];
      const same = g.id === w.id && g.label === w.label && (w.value instanceof RegExp ? w.value.test(g.value) : g.value === w.value) && g.cross === w.cross && g.tone === w.tone;
      if (!same) bad.push(`cell ${i} (${w.label}) is ${JSON.stringify([g.id, g.label, g.value, g.cross, g.tone])}, the token read's is ${JSON.stringify([w.id, w.label, String(w.value), w.cross, w.tone])}`);
    }
  }
  return bad;
}

/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(loads.length === LOADS.length, `${loads.length} loads of ${LOADS.length} (desktop, phone)`);
  for (const [i, l] of loads.entries()) {
    const phone = LOADS[i]?.isMobile === true;
    const vw = LOADS[i]?.viewport.width ?? 0;
    const tag = `${l.width} /`;
    const bad = [];
    if (l.route !== "token") bad.push(`drew ${l.route ?? "nothing"}`);
    if (l.state !== "ready") bad.push(`state ${l.state ?? "none"}, not ready`);
    const t = l.token;
    if (!t) bad.push("the page read no token answer");
    else {
      if (t.status !== 200) bad.push(`token read status ${t.status}`);
      if (t.rowMint !== l.shown) bad.push(`the token read's row is ${t.rowMint ?? "none"}, the page draws ${l.shown ?? "none"}`);
      if (!t.read) bad.push("the token read held no row");
    }
    const read = t?.read ?? null;
    if (!phone) {
      const m = l.page;
      for (const f of boxFaults(m, read)) bad.push(f);
      const b = m?.box;
      if (b) {
        if (!b.inColumn) bad.push("the box is not inside the page's right column");
        if (!(b.left >= m.chartRight - 0.5)) bad.push(`the box (left ${b.left}) is not to the right of the chart (right ${m.chartRight})`);
        if (!(b.left >= 0 && b.right <= vw + 0.5)) bad.push(`the box is outside the window (${b.left} to ${b.right} of ${vw})`);
      }
      if (!l.signin?.opened) bad.push("the Sign in to trade button did not open the sign-in sheet");
      else if (l.signin.state !== "S2.1") bad.push(`the sign-in sheet's state is ${l.signin.state}`);
    } else {
      if (l.page?.box) bad.push("the page behind the sheet already draws a box");
      if (!l.page?.bar) bad.push("no bottom bar");
      const s = l.sheet;
      if (!s?.open) bad.push("the Buy button did not open the trade sheet");
      else {
        if (s.name !== `Buy ${l.symbol}`) bad.push(`the sheet's name is ${JSON.stringify(s.name)}, not "Buy ${l.symbol}"`);
        for (const f of boxFaults(s, read)) bad.push(`sheet: ${f}`);
        if (!(s.left >= 0 && s.right <= vw + 0.5 && s.bottom <= (LOADS[i]?.viewport.height ?? 0) + 0.5)) bad.push(`the sheet is outside the window (${s.left} to ${s.right}, bottom ${s.bottom})`);
        if (!l.signin?.opened) bad.push("the Sign in to trade button in the sheet did not open the sign-in sheet");
        else if (!l.signin.above) bad.push("the sign-in sheet is not above the trade sheet");
      }
    }
    if (!l.shot) bad.push("no screenshot");
    say(bad.length === 0, `${tag}${l.width}: ${bad.length ? bad.join("; ") : `${l.symbol}: ${phone ? "the bar's Buy opens the sheet with" : "the right column holds"} the box signed out (Bal —, exit plan off, Sign in to trade, state S8.1) and the 12-cell grid matches its token read (200), the button opens the sign-in sheet`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
/** Runs in the terminal's frame: what the page draws, in the desktop column ("desk"), on the phone page ("phone") or in
 *  the trade sheet ("sheet"). */
const MEASURE = (mode) => {
  const sheet = mode === "sheet";
  const root = document.querySelector('main[data-route="token"]');
  const p = root?.querySelector("[data-token-page]");
  const vis = (q) => [...(root?.querySelectorAll(q) ?? [])].find((e) => e.getClientRects().length);
  const scope = sheet ? document.querySelector('[data-sheet="trade"]') : mode === "phone" ? root?.querySelector(".tkp-phone") : root?.querySelector(".tkp-desk .tkp-trade");
  const el = scope?.querySelector('[data-testid="trade-box"]');
  const out = { route: root?.dataset.route ?? null, state: p?.getAttribute("data-token-page") ?? null, shown: p?.getAttribute("data-token") ?? null, symbol: vis("h1.tkp-sym")?.textContent ?? null, bar: !!vis(".tkp-bottom"), box: null };
  const r = (e) => e?.getBoundingClientRect();
  out.chartRight = r(root?.querySelector(".tkp-desk .tkp-chart"))?.right ?? null;
  if (sheet) {
    const d = document.querySelector('[data-sheet="trade"] [role="dialog"]');
    const sb = r(d);
    Object.assign(out, { open: !!d, name: d?.getAttribute("aria-label") ?? null, left: sb?.left ?? null, right: sb?.right ?? null, bottom: sb?.bottom ?? null });
  }
  if (el) {
    const t = (q) => el.querySelector(q)?.textContent?.trim() ?? null;
    const exit = el.querySelector('[data-testid="trade-exit"]');
    const cta = el.querySelector('[data-testid="trade-cta"]');
    const bb = r(el);
    out.box = {
      state: el.getAttribute("data-state"),
      text: el.innerText,
      balance: t('[data-testid="trade-balance"]'),
      exit: { text: exit?.innerText.replace(/\s+/g, " ").trim() ?? null, pressed: exit?.querySelector("button")?.getAttribute("aria-pressed") ?? null, on: exit?.getAttribute("data-on") ?? null },
      cta: { text: cta?.innerText.trim() ?? null, disabled: !!cta?.disabled },
      left: bb.left,
      right: bb.right,
      inColumn: !!el.closest(".tkp-trade") && bb.left >= (r(el.closest(".tkp-trade"))?.left ?? 0) - 0.5 && bb.right <= (r(el.closest(".tkp-trade"))?.right ?? 0) + 0.5,
      lineBottom: r(el.querySelector(".trb-line"))?.bottom ?? null,
      gridTop: r(el.querySelector('[data-testid="safety-grid"]'))?.top ?? null,
      cells: [...el.querySelectorAll('[data-testid="safety-grid"] .rg-cell')].map((c) => ({
        id: c.getAttribute("data-cell"),
        label: c.querySelector(".rg-label")?.textContent ?? null,
        value: c.querySelector(".rg-value")?.textContent ?? null,
        cross: !!c.querySelector('svg path[d^="M4.3 4.3"]'),
        tone: c.getAttribute("data-tone"),
      })),
    };
  }
  return out;
};

async function appFrame(page) {
  for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
    for (const f of page.frames()) if (await f.evaluate(() => !!document.querySelector('main[data-route="token"] [data-token-page="ready"]')).catch(() => false)) return f;
  }
  return null;
}

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "tap");
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, signed out, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const [i, w] of LOADS.entries()) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
      // the harness answers APP_HOST's own files and the shell; the helper is the live one
      if (harness) await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === HELPER_HOST ? r.continue() : harness(r)));
      const page = await ctx.newPage();
      let token = null;
      page.on("response", (r) => {
        if (r.url().startsWith(`${HELPER_HOST}/v1/market/token?`) && !token) token = r;
      });
      await page.goto(`${APP_HOST}/`, { waitUntil: "load" });
      const f = await appFrame(page);
      const load = { width: w.name, opened: `${APP_HOST}/`, frame: f ? f.url() : null, route: null, state: null, shown: null, symbol: null, page: null, token: null, shot: null };
      if (f) {
        // the shell's signed-out state has landed when the box's button reads Sign in to trade
        await f.waitForFunction(() => document.querySelector('[data-testid="trade-cta"]')?.textContent?.trim() === "Sign in to trade", null, { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(400);
        load.page = await f.evaluate(MEASURE, w.isMobile ? "phone" : "desk");
        Object.assign(load, { route: load.page.route, state: load.page.state, shown: load.page.shown, symbol: load.page.symbol });
        // the record keeps the file's name only: the folder is the recorder's own, printed once at the end
        load.shot = `${i}-${w.name}.png`;
        await page.screenshot({ path: path.join(shots, load.shot) });
        const sheetUp = () => f.locator('[data-sheet="signin"]').waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
        if (!w.isMobile) {
          await f.locator('.tkp-desk [data-testid="trade-cta"]').click({ timeout: 5_000 }).catch(() => {});
          const opened = await sheetUp();
          load.signin = { opened, state: opened ? await f.locator('[data-sheet="signin"]').getAttribute("data-state") : null };
          await page.screenshot({ path: path.join(shots, `${i}-${w.name}-signin.png`) });
        } else {
          await f.locator(".tkp-buy").click({ timeout: 5_000 }).catch(() => {});
          await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(300);
          load.sheet = await f.evaluate(MEASURE, "sheet");
          await page.screenshot({ path: path.join(shots, `${i}-${w.name}-sheet.png`) });
          await f.locator('[data-sheet="trade"] [data-testid="trade-cta"]').click({ timeout: 5_000 }).catch(() => {});
          const opened = await sheetUp();
          const above = opened ? await f.evaluate(() => { const b = document.querySelector(".sgn-box")?.getBoundingClientRect(); return b ? document.elementFromPoint(b.x + b.width / 2, b.y + 40)?.closest(".sgn") !== null : false; }) : false;
          load.signin = { opened, state: opened ? await f.locator('[data-sheet="signin"]').getAttribute("data-state") : null, above };
          await page.screenshot({ path: path.join(shots, `${i}-${w.name}-signin.png`) });
        }
      } else {
        load.shot = `${i}-${w.name}.png`;
        await page.screenshot({ path: path.join(shots, load.shot) });
      }
      const tb = token ? await token.json().catch(() => null) : null;
      const row = tb?.row ?? null;
      const rk = (k) => tb?.risk?.[k]?.v;
      load.token = token
        ? {
            // the read's URL kept as its path (gitleaks reads a long id after `token=` as a secret)
            url: token.url().split("?")[0],
            status: token.status(),
            rowMint: row?.token ?? null,
            // the values the grid draws, as the answer holds them
            read: row
              ? { row: { top10_bps: row.top10_bps ?? null, dev_bps: row.dev_bps ?? null, snipers_bps: row.snipers_bps ?? null, holders: row.holders ?? null, liq_usd: row.liq_usd ?? null, created_s: row.created_s ?? null, mint_auth: row.mint_auth ?? null, freeze_auth: row.freeze_auth ?? null, launchpad: row.launchpad ?? null, curve_bps: row.curve_bps ?? null }, risk: { insiders_bps: rk("insiders_bps") ?? null, tax: rk("tax") ?? null, lp: rk("lp") ?? null, honeypot: rk("honeypot") ?? null } }
              : null,
          }
        : null;
      rec.loads.push(load);
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
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
