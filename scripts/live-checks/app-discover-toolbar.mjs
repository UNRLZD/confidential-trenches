#!/usr/bin/env node
// Live check of card app-discover-toolbar: Discover can be narrowed like the design, on the helper's live lists.
// Headless Chromium opens APP_HOST/discover inside SIGN_HOST's shell at 1440 x 900 and 390 x 844 (dpr 2, touch), waits
// for rows, then works each control and reads what is drawn in one read per state (a 12 s refresh between reads changes
// the rows, never the rule each read is judged by):
//   desktop: the toolbar draws All, Fewer flags, MC ≥ $10K, Launchpad and the Quick buy field, a search button on each
//     column, and no No creator dumps chip (creator_sold_bps is not served); Fewer flags leaves no drawn row with a Top 10
//     or dev pill at its line; MC ≥ $10K leaves no drawn row whose MC reads under $10K; a launchpad picked in the menu
//     leaves only rows with that launchpad's badge; New's search leaves only rows whose symbol or name holds the text;
//     the Quick buy amount set to 40 reads 40 after a reload;
//   phone: the chips All, Fewer flags and Launchpad, Pause that turns to Resume and holds the list, the Quick buy dock
//     with its amount; Fewer flags leaves no drawn row whose dev reads at its line.
// A state with no row to judge (nothing flagged, nothing under $10K) is still judged on what it drew, and is named.
// After: app
//   node scripts/live-checks/app-discover-toolbar.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute,
// signed out), the helper still answered live; --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WIDTHS } from "./app-shell.mjs";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "app-discover-toolbar";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
const READY_MS = 30_000;
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1 });
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };

// ------------------------------------------------------------------------------------------------ the verdict
/** "$4.20K" -> 4200; "—" -> null. */
export function usd(text) {
  const m = /^\$([\d,.]+)([KMBT]?)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  return Number(m[1].replace(/,/g, "")) * { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2]];
}

/** The check on one recorded run: { verdict, ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const d = rec.desktop, p = rec.phone;
  say(!!d && d.rows > 0, `desktop: Discover drew ${d?.rows ?? 0} row(s)`);
  if (d && d.rows > 0) {
    const want = ["All", "Fewer flags", "MC ≥ $10K", "Launchpad", "Quick buy"];
    const missing = want.filter((w) => !d.controls.includes(w));
    say(missing.length === 0, `desktop: the toolbar draws ${want.join(", ")}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    say(!d.controls.includes("No creator dumps"), "desktop: no No creator dumps chip (its field is not served)");
    say(d.searchButtons === 4, `desktop: ${d.searchButtons} column search button(s) of 4`);
    if (d.fewer) {
      const hot = d.fewer.rows.filter((r) => r.levels.some((l) => l !== "none"));
      say(d.fewer.pressed && hot.length === 0, `desktop Fewer flags: pressed ${d.fewer.pressed}, ${d.fewer.rows.length} row(s) drawn, ${hot.length} with a Top 10 or dev pill at its line${hot.length ? ` (${hot.slice(0, 3).map((r) => r.symbol).join(", ")})` : ""}`);
      if (d.flaggedBefore === 0) lines.push("note desktop: no drawn row was flagged before Fewer flags");
    } else say(false, "desktop: Fewer flags not worked");
    if (d.mc) {
      const low = d.mc.rows.filter((r) => r.mc !== null && r.mc < 10_000);
      say(d.mc.pressed && low.length === 0, `desktop MC ≥ $10K: pressed ${d.mc.pressed}, ${d.mc.rows.length} row(s) drawn, ${low.length} under $10K${low.length ? ` (${low.slice(0, 3).map((r) => `${r.symbol} ${r.mc}`).join(", ")})` : ""}`);
    } else say(false, "desktop: MC ≥ $10K not worked");
    if (d.pad) {
      const other = d.pad.rows.filter((r) => r.pad !== d.pad.picked);
      say(d.pad.entries > 0 && d.pad.rows.length > 0 && other.length === 0, `desktop Launchpad: ${d.pad.entries} launchpad(s) in the menu, picked ${d.pad.picked}: ${d.pad.rows.length} row(s) drawn, ${other.length} of another launchpad`);
    } else say(false, "desktop: the launchpad menu not worked");
    if (d.search) {
      const t = d.search.q.toLowerCase();
      const miss = d.search.rows.filter((r) => !`${r.symbol} ${r.name}`.toLowerCase().includes(t));
      say(d.search.rows.length > 0 && miss.length === 0, `desktop search "${d.search.q}" in New: ${d.search.rows.length} row(s) drawn, ${miss.length} without it`);
    } else say(false, "desktop: the column search not worked");
    say(d.amountAfterReload === "40", `desktop Quick buy: the amount after a reload reads ${JSON.stringify(d.amountAfterReload)} (40 set)`);
    say(d.errors.length === 0, `desktop: ${d.errors.length} page error(s)${d.errors.length ? `: ${d.errors.join("; ")}` : ""}`);
  }
  say(!!p && p.rows > 0, `phone: Discover drew ${p?.rows ?? 0} row(s)`);
  if (p && p.rows > 0) {
    const want = ["All", "Fewer flags", "Launchpad"];
    const missing = want.filter((w) => !p.chips.includes(w));
    say(missing.length === 0, `phone: the chips ${want.join(", ")}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    say(p.pause === "Pause" && p.resume === "Resume" && p.held, `phone Pause: reads ${JSON.stringify(p.pause)}, then ${JSON.stringify(p.resume)}, the list held ${p.held}`);
    say(/^\$\d/.test(p.dock ?? ""), `phone: the Quick buy dock reads ${JSON.stringify(p.dock)}`);
    if (p.fewer) {
      const hot = p.fewer.rows.filter((r) => r.level !== "none");
      say(hot.length === 0, `phone Fewer flags: ${p.fewer.rows.length} row(s) drawn, ${hot.length} with dev at its line`);
    } else say(false, "phone: Fewer flags not worked");
    say(p.errors.length === 0, `phone: ${p.errors.length} page error(s)${p.errors.length ? `: ${p.errors.join("; ")}` : ""}`);
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { verdict, ok: verdict === "PASS", lines };
}

// ------------------------------------------------------------------------------------------------ the live read
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function terminalFrame(page) {
  const until = Date.now() + 8_000;
  for (;;) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f || Date.now() > until) return f ?? page.mainFrame();
    await page.waitForTimeout(100);
  }
}

// runs in the frame: the drawn rows of the visible layout, each with what the toolbar's rules read
const ROWS = (col) => {
  const vis = (e) => e.getClientRects().length > 0;
  const scope = col ? `.dsc-grid .dsc-col[data-col="${col}"]` : "";
  return [...document.querySelectorAll(`${scope} [role="listitem"][data-token]`)].filter(vis).map((r) => ({
    symbol: r.querySelector(".dsc-sym")?.textContent ?? "",
    name: r.querySelector(".dsc-name")?.textContent ?? "",
    levels: [...r.querySelectorAll('.dsc-mp[data-pill="top10"], .dsc-mp[data-pill="creatorHolds"]')].map((e) => e.getAttribute("data-level")),
    level: r.querySelector(".dsc-pdev")?.getAttribute("data-level") ?? null,
    mcText: (r.querySelector(".dsc-mc")?.childNodes[1]?.textContent ?? r.querySelector(".dsc-pmeta > span:nth-child(2)")?.textContent ?? "").trim(),
    pad: r.querySelector(".tok-pb")?.getAttribute("data-pad") ?? null,
  }));
};
const withMc = (rows) => rows.map(({ mcText, ...r }) => ({ ...r, mc: usd(mcText) }));

async function waitRows(page, f) {
  const until = Date.now() + READY_MS;
  let n = 0;
  while (Date.now() < until && !(n = (await f.evaluate(ROWS, null).catch(() => [])).length)) await page.waitForTimeout(250);
  return n;
}

async function open(browser, w, harness) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await ctx.route("**/*", (r) => (originOf(r.request().url()) === HELPER_HOST ? r.continue() : harness(r)));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
  return { ctx, page, errors, f: await terminalFrame(page) };
}

const tryStep = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

async function desktop(browser, w, harness, shots) {
  const { ctx, page, errors, f } = await open(browser, w, harness);
  const out = { rows: 0, controls: [], searchButtons: 0, flaggedBefore: 0, fewer: null, mc: null, pad: null, search: null, amountAfterReload: null, errors };
  try {
    out.rows = await waitRows(page, f);
    if (!out.rows) return out;
    out.controls = await f.evaluate(() => [...document.querySelectorAll(".dsc-bar button, .dsc-bar label")].filter((e) => e.getClientRects().length).map((e) => (e.querySelector(".dsc-qblabel") ?? e).textContent.replace(/\d+$/, "").trim()));
    out.searchButtons = await f.locator('[data-testid^="col-search-"]:visible').count();
    out.flaggedBefore = (await f.evaluate(ROWS, null)).filter((r) => r.levels.some((l) => l !== "none")).length;
    const T = 3000;
    out.fewer = await tryStep(async () => {
      await f.locator('[data-testid="presets"] [data-preset="fewer_flags"]').click({ timeout: T });
      const r = { pressed: (await f.locator('[data-testid="presets"] [data-preset="fewer_flags"]').getAttribute("aria-pressed")) === "true", rows: (await f.evaluate(ROWS, null)).map(({ symbol, levels }) => ({ symbol, levels })) };
      await page.screenshot({ path: path.join(shots, "desktop-fewer-flags.png") });
      await f.locator('[data-testid="presets"] [data-preset="all"]').click({ timeout: T });
      return r;
    });
    out.mc = await tryStep(async () => {
      await f.locator('[data-testid="chip-minMc"]').click({ timeout: T });
      const r = { pressed: (await f.locator('[data-testid="chip-minMc"]').getAttribute("aria-pressed")) === "true", rows: withMc(await f.evaluate(ROWS, null)).map(({ symbol, mc }) => ({ symbol, mc })) };
      await f.locator('[data-testid="chip-minMc"]').click({ timeout: T });
      return r;
    });
    out.pad = await tryStep(async () => {
      await f.locator('[data-testid="chip-launchpad"]').click({ timeout: T });
      const entries = await f.locator('[data-testid="launchpad-menu"] [data-pad]').count();
      const key = await f.locator('[data-testid="launchpad-menu"] [data-pad]').first().getAttribute("data-pad", { timeout: T });
      await f.locator('[data-testid="launchpad-menu"] [data-pad]').first().click({ timeout: T });
      await page.screenshot({ path: path.join(shots, "desktop-launchpad.png") });
      await page.keyboard.press("Escape");
      const r = { entries, picked: key.slice(key.indexOf(":") + 1), rows: (await f.evaluate(ROWS, null)).map(({ symbol, pad }) => ({ symbol, pad })) };
      await f.locator('[data-testid="chip-launchpad"]').click({ timeout: T });
      await f.locator('[data-testid="launchpad-clear"]').click({ timeout: T });
      await page.keyboard.press("Escape");
      return r;
    });
    out.search = await tryStep(async () => {
      const first = (await f.evaluate(ROWS, "new"))[0];
      const q = first.symbol.slice(0, 2);
      await f.locator('[data-testid="col-search-new"]').click({ timeout: T });
      await f.locator('.dsc-col[data-col="new"] input').fill(q, { timeout: T });
      const r = { q, rows: (await f.evaluate(ROWS, "new")).map(({ symbol, name }) => ({ symbol, name })) };
      await page.screenshot({ path: path.join(shots, "desktop-search.png") });
      await f.locator('.dsc-col[data-col="new"] input').press("Escape");
      return r;
    });
    out.amountAfterReload = await tryStep(async () => {
      await f.locator('[data-testid="discover-qb-amount"]').fill("40", { timeout: T });
      await page.reload({ waitUntil: "load" });
      const g = await terminalFrame(page);
      await waitRows(page, g);
      return g.locator('[data-testid="discover-qb-amount"]').inputValue({ timeout: T });
    });
    await page.screenshot({ path: path.join(shots, "desktop-discover.png") });
    return out;
  } finally {
    await ctx.close();
  }
}

async function phone(browser, w, harness, shots) {
  const { ctx, page, errors, f } = await open(browser, w, harness);
  const out = { rows: 0, chips: [], pause: null, resume: null, held: false, dock: null, fewer: null, errors };
  try {
    out.rows = await waitRows(page, f);
    if (!out.rows) return out;
    out.chips = await f.evaluate(() => [...document.querySelectorAll('[data-testid="m-discover-filters"] button')].filter((e) => e.getClientRects().length).map((e) => e.textContent.replace(/\d+$/, "").trim()));
    out.dock = await tryStep(() => f.locator('[data-testid="m-dock-amount"]').textContent({ timeout: 3000 }));
    const T = 3000;
    await tryStep(async () => {
      out.pause = (await f.locator('[data-testid="m-pause"]').textContent({ timeout: T })).trim();
      const before = (await f.evaluate(ROWS, null)).map((r) => r.symbol).join(",");
      await f.locator('[data-testid="m-pause"]').click({ timeout: T });
      out.resume = (await f.locator('[data-testid="m-pause"]').textContent({ timeout: T })).trim();
      // past one 12 s refresh: the held list draws the same rows
      await page.waitForTimeout(13_000);
      out.held = (await f.evaluate(ROWS, null)).map((r) => r.symbol).join(",") === before;
      await page.screenshot({ path: path.join(shots, "phone-paused.png") });
      await f.locator('[data-testid="m-pause"]').click({ timeout: T });
    });
    out.fewer = await tryStep(async () => {
      await f.locator('[data-testid="m-presets"] [data-preset="fewer_flags"]').click({ timeout: T });
      const r = { rows: (await f.evaluate(ROWS, null)).map(({ symbol, level }) => ({ symbol, level })) };
      await page.screenshot({ path: path.join(shots, "phone-fewer-flags.png") });
      return r;
    });
    return out;
  } finally {
    await ctx.close();
  }
}

export async function collect({ build = null, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`) } = {}) {
  mkdirSync(shots, { recursive: true });
  let harness = null;
  if (build) {
    const { harnessRoute } = await import("./app-in-shell.mjs");
    harness = await harnessRoute(path.resolve(build), "signed", { state: SIGNED_OUT });
  }
  const browser = await launchBrowser("chromium");
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version() };
  try {
    const W = Object.fromEntries(WIDTHS.map((w) => [w.name, w]));
    rec.desktop = await desktop(browser, W.desktop, harness, shots);
    rec.phone = await phone(browser, W.phone, harness, shots);
  } finally {
    await browser.close();
  }
  return { rec, shots };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : d;
  };
  const { rec, shots } = await collect({ build: opt("--build", null), shots: opt("--shots", undefined) });
  const record = opt("--record", null);
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`CARD ${KEY} / ${rec.source}: ${r.verdict} (Chrome ${rec.browser}, shots ${shots})`);
  process.exit(EXIT[r.verdict]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
