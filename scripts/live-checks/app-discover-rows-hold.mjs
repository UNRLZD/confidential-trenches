#!/usr/bin/env node
// Live check of card app-discover-rows-hold: Discover's drawn rows hold still when a refresh reorders its lists.
// Headless Chromium opens APP_HOST/discover at 390 x 844 (dpr 2, touch: the New tab) and 1440 x 900 (dpr 1: all four
// columns), finds the terminal's frame inside SIGN_HOST's shell and waits for rows. Then for HOLD_MS it lets Discover's
// 12 s refresh run (three reads) and reads every second which token each drawn slot shows, so it knows when a refresh
// reordered a list (a slot drawn before now shows another token: a new token on top, or a rank change). Every layout
// shift in the terminal's frame is read with its sources, each marked when it lies inside a row's own content.
// Verdict per width: rows drew; the hold ran; after the rows drew no row, no row's link and no element outside the rows
// moved (a FAIL names each and its rects); text, and content inside a slot laid out for the slot's new token (its name
// after a shorter symbol, its pills after another age), is the update and is not counted; no page error. A width whose
// lists never reordered in the hold proves nothing either way: with no BAD line it is INCONCLUSIVE (exit 3), never a PASS.
// The bundle cannot show this change (a row's React key is not in the built code's text), so the check reads the page.
// After: app
//   node scripts/live-checks/app-discover-rows-hold.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
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

const KEY = "app-discover-rows-hold";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const HOLD_MS = 40_000;
const SAMPLE_MS = 1000;
const READY_MS = 30_000;
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };

// ------------------------------------------------------------------------------------------------ the verdict
const moving = (e) => e.sources.filter((s) => !s.cell && !s.text.startsWith("#text")).map((s) => s.text);

/** The check on one recorded run: { verdict, ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const loads = rec.loads ?? [];
  say(loads.length === WIDTHS.length, `${loads.length} load(s) of ${WIDTHS.length} (both widths)`);
  for (const l of loads) {
    say(l.rows > 0, `${l.width}: Discover drew ${l.rows} row(s)`);
    if (!(l.rows > 0)) continue;
    say(l.heldMs >= HOLD_MS, `${l.width}: held ${Math.round(l.heldMs / 1000)} s (${HOLD_MS / 1000} s asked), ${l.samples} read(s) of the drawn slots`);
    // after the rows drew, a shift with any element source; text re-aligned in its cell is not a moved box
    const moved = l.shifts.filter((e) => moving(e).length > 0);
    say(moved.length === 0, `${l.width}: ${moved.length} shift(s) moved an element${moved.length ? ` [${moved.map((e) => `+${e.at}ms: ${moving(e).join(" | ")}`).join("; ")}]` : ""}`);
    say(l.errors.length === 0, `${l.width}: ${l.errors.length} page error(s)${l.errors.length ? `: ${l.errors.join("; ")}` : ""}`);
    if (l.reorders > 0) lines.push(`ok  ${l.width}: a refresh reordered a drawn list ${l.reorders} time(s) in the hold`);
    else {
      quiet = true;
      lines.push(`INCONCLUSIVE ${l.width}: no refresh reordered a drawn list in the hold, so nothing was moved to hold still`);
    }
  }
  const bad = lines.length === 0 || lines.some((l) => l.startsWith("BAD"));
  const verdict = bad ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS";
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

// runs in the page before its own code: every layout shift, each source named and marked `cell` when it lies inside a
// row's own content (inside a [role=listitem], not the item itself and not its link)
const INIT = () => {
  window.__drh = [];
  try {
    new PerformanceObserver((list) => {
      const rect = (r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      const name = (n) => (n ? `${n.nodeName.toLowerCase()}${typeof n.className === "string" && n.className ? `.${n.className.trim().split(/\s+/).join(".")}` : ""}` : "(removed)");
      const cell = (n) => {
        const el = n?.nodeType === 1 ? n : n?.parentElement;
        const item = el?.closest('[role="listitem"]');
        return !!item && el !== item && el.parentElement !== item;
      };
      for (const e of list.getEntries()) window.__drh.push({ at: Math.round(e.startTime), value: e.value, input: e.hadRecentInput, sources: e.sources.map((x) => ({ text: `${name(x.node)} ${rect(x.previousRect)} -> ${rect(x.currentRect)}`, cell: cell(x.node) })) });
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
};

// runs in the frame: each drawn list's tokens, slot by slot (the page holds both layouts; one is display: none)
const SLOTS = () =>
  [...document.querySelectorAll('.dsc-rows[data-state="S5.2"]')].filter((c) => c.getClientRects().length).map((c) => [...c.querySelectorAll('[role="listitem"]')].map((r) => r.getAttribute("data-token")));

/** How many drawn slots show another token than they did: a reorder when above zero. */
export const changedSlots = (a, b) => a.reduce((n, list, i) => n + list.filter((t, j) => b[i]?.[j] !== undefined && b[i][j] !== t).length, 0);

async function watch(browser, w, harness, shots) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await ctx.route("**/*", (r) => (originOf(r.request().url()) === HELPER_HOST ? r.continue() : harness(r)));
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const load = { width: w.name, rows: 0, heldMs: 0, samples: 0, reorders: 0, shifts: [], errors };
  try {
    await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
    const f = await terminalFrame(page);
    const until = Date.now() + READY_MS;
    let slots = [];
    while (Date.now() < until && !(slots = await f.evaluate(SLOTS).catch(() => [])).some((l) => l.length)) await page.waitForTimeout(250);
    load.rows = slots.reduce((n, l) => n + l.length, 0);
    if (!load.rows) return load;
    // shifts count from here: the first paint is app-shell's and BAR-10's to judge
    const t0 = await f.evaluate(() => performance.now());
    const start = Date.now();
    while (Date.now() - start < HOLD_MS) {
      await page.waitForTimeout(SAMPLE_MS);
      const now = await f.evaluate(SLOTS).catch(() => null);
      if (!now) continue;
      load.samples++;
      if (changedSlots(slots, now) > 0) load.reorders++;
      slots = now;
    }
    load.heldMs = Date.now() - start;
    load.shifts = (await f.evaluate(() => window.__drh ?? [])).filter((e) => e.at >= t0 && !e.input);
    await page.screenshot({ path: path.join(shots, `${w.name}-discover.png`) });
    return load;
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
  const rec = { source: build ? `harness: the build ${named(build)} at APP_HOST's name in the stand-in shell, HELPER_HOST live` : "live", at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const w of WIDTHS) rec.loads.push(await watch(browser, w, harness, shots));
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
