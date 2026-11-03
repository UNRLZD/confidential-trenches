#!/usr/bin/env node
// The token page's shots and checks (card app-token-page; AS-02, app.md:1356), taken from the built app at its route,
// not a test page: apps/terminal built with its own vite config, each fixture state opened at `/?fx=<name>`
// (src/screens/token/source.ts) at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1). The terminal runs only inside
// SIGN_HOST's shell (a top-level visit moves there, src/shell/in-shell.ts), so the run answers the hosts' real names from
// local files as app-in-shell.mjs --harness and the BAR-10 run do: APP_HOST the build under its _headers, SIGN_HOST the
// stand-in shell, signed in; every read is of the terminal's frame inside the shell, and each shot is the whole window.
// Per shot: the token route drew the page in its state, no horizontal scroll, no text under 11 px in the page, the
// curve bar only on the curve token and the dash in the field elsewhere, and on the phone the bottom bar sits above the
// tab bar and the last tile scrolls clear of it and the curve tile is on screen without a sideways scroll. Requests to
// any other host are refused and listed. Draft words drawn are listed.
//   node apps/terminal/test/token-page/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { rowFaults } from "../../../../scripts/live-checks/app-launchpad-badges.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

// id, the URL's fx (none: the default), the page's state; a ready state's fixture launchpad and chain (fixtures.ts),
// whose badges sit at the avatar's corners (card app-launchpad-chain-badges)
const STATES = [
  { id: "S7.2-curve", fx: null, state: "ready", curve: true, served: { launchpad: "pump.fun", chain: "solana" } },
  { id: "S7.2-pool", fx: "pool", state: "ready", curve: false, served: { launchpad: "pump.fun", chain: "solana" } },
  { id: "S7.2-listed", fx: "listed", state: "ready", curve: false, served: { launchpad: null, chain: "solana" } },
  { id: "S7.3-edges", fx: "edges", state: "ready", curve: false, served: { launchpad: "pons", chain: "near" } },
  { id: "S7.1-loading", fx: "loading", state: "loading" },
  { id: "empty", fx: "empty", state: "empty" },
  { id: "error", fx: "error", state: "error" },
];

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-token-page-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

const fails = [];
const drafts = new Map();
const refused = new Set();
const check = (ok, what) => {
  if (!ok) fails.push(what);
};

// `page` is the top window (SIGN_HOST's shell, for the shot); `f` is the terminal's frame inside it, where every read is.
async function openAt(browser, route, w, fx) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.route("**/*", (r) => {
    const origin = new URL(r.request().url()).origin;
    if (origin !== APP_HOST && origin !== SIGN_HOST) refused.add(origin);
    return route(r);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP_HOST}/${fx ? `?fx=${fx}` : ""}`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`${w.name} ?fx=${fx}: no APP_HOST frame inside the shell (top at ${page.url()})`);
  await f.waitForSelector('main[data-route="token"] [data-token-page]', { timeout: 10_000 }).catch(() => {});
  return { ctx, page, f, errors };
}

const dir = await build();
const route = await harnessRoute(dir, "signed");
const { chromium } = await import("playwright");
const browser = await chromium.launch();
let n = 0;
try {
  for (const w of WIDTHS) {
    const phone = w.name === "390";
    for (const s of STATES) {
      n++;
      const tag = `${s.id} @${w.name}`;
      const { ctx, page, f, errors } = await openAt(browser, route, w, s.fx);
      const sel = `main[data-route="token"] [data-token-page="${s.state}"]`;
      const drawn = await f.locator(sel).first().isVisible().catch(() => false);
      check(drawn, `${tag}: ${sel} not drawn at the route`);
      check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
      const scroll = await f.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(scroll <= 0, `${tag}: horizontal scroll ${scroll}px`);
      const small = await f.$$eval(".tkp *", (els) => els.filter((e) => e.getClientRects().length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())).map((e) => [e.textContent.trim().slice(0, 20), parseFloat(getComputedStyle(e).fontSize)]).filter(([, px]) => px < 10.95));
      check(small.length === 0, `${tag}: text under 11 px: ${JSON.stringify(small)}`);
      if (drawn && s.state === "ready") {
        const box = phone ? ".tkp-phone" : ".tkp-desk";
        const bars = await f.locator(`${box} [data-testid="curve-bar"]`).count();
        check(bars === (s.curve ? 1 : 0), `${tag}: ${bars} curve bars`);
        const field = (await f.locator(`${box} [data-k="curve"] .tkp-val`).textContent())?.trim();
        check(s.curve ? /^\d+%$/.test(field ?? "") : field === "—", `${tag}: the curve field reads ${field}`);
        // the origin badges: the fixture's pad (or none) bottom-right, its chain top-right, loaded, named, not cut
        const drawnRow = await f.evaluate(async (box) => {
          await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
          const root = document.querySelector(box);
          const av = root?.querySelector(".tok-avw");
          if (!av) return null;
          // cut: outside the nearest box that clips its content, or the viewport
          let c = null;
          for (let p = av.parentElement; p && !c; p = p.parentElement) if (getComputedStyle(p).overflow !== "visible") c = p.getBoundingClientRect();
          c ??= { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
          const g = (sel, at) => {
            const e = av.querySelector(sel);
            if (!e) return null;
            const i = e.querySelector("img");
            const r = e.getBoundingClientRect();
            return { id: e.getAttribute(at), title: e.getAttribute("title"), loaded: !!i && i.complete && i.naturalWidth > 0, out: r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5 || r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.width < 9.5 };
          };
          const pad = g(".tok-pb", "data-pad");
          const chain = g(".tok-cb", "data-chain");
          const clipped = [pad?.out && "launchpad badge cut by its box", chain?.out && "chain badge cut by its box"].filter(Boolean);
          const texts = [...root.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.getClientRects().length).map((e) => e.textContent.trim()).filter(Boolean);
          const strip = (b) => (b ? { id: b.id, title: b.title, loaded: b.loaded } : null);
          return { pad: strip(pad), chain: strip(chain), texts, clipped };
        }, box);
        check(drawnRow !== null, `${tag}: no avatar with badges`);
        if (drawnRow) {
          const faults = rowFaults({ ...drawnRow, served: s.served });
          check(faults.length === 0, `${tag}: badges: ${faults.join("; ")}`);
        }
        if (phone) {
          const g = await f.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const r = (q) => document.querySelector(q)?.getBoundingClientRect();
            const tiles = [...document.querySelectorAll(".tkp-mtile")].map((e) => e.getBoundingClientRect().bottom);
            return { bar: r(".tkp-bottom"), tab: r(".tabbar"), lastTile: Math.max(...tiles), curveRight: r('.tkp-phone [data-k="curve"]')?.right ?? Infinity, vw: window.innerWidth };
          });
          check(g.bar && g.tab && g.bar.bottom <= g.tab.top + 0.5, `${tag}: the bottom bar overlaps the tab bar`);
          check(g.curveRight <= g.vw, `${tag}: the curve tile is off screen (right ${g.curveRight} > ${g.vw})`);
          check(g.bar && g.lastTile <= g.bar.top, `${tag}: the last tile ends under the bottom bar (${g.lastTile} > ${g.bar?.top})`);
          await f.evaluate(() => window.scrollTo(0, 0));
        }
      } else {
        check((await f.locator(".tkp-bottom").count()) === 0, `${tag}: the bottom bar shows with no token`);
      }
      if (drawn && s.state === "error") {
        await f.locator(".tkp-retry").click();
        check(await f.locator(sel).isVisible(), `${tag}: Retry lost the page`);
      }
      for (const d of await f.$$eval("[data-draft-copy]", (els) => els.map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(s.id);
      }
      const label = await f.$eval("[data-token-page]", (e) => e.getAttribute("aria-label")).catch(() => null);
      if (label) {
        if (!drafts.has(label)) drafts.set(label, new Set());
        drafts.get(label).add(`${s.id} (accessible name)`);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${s.id}-${w.name}.png`) });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy: ${d} (${[...ids].join(", ")})`);
if (refused.size) console.log(`refused off-host requests (the shell's): ${[...refused].join(" ")}`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} states`);
  process.exit(1);
}
console.log(`PASS ${n} states (${STATES.length} at 390 and 1440) from the built app at the token route inside the stand-in shell${SHOTS ? `; shots in ${SHOTS}` : ""}`);
