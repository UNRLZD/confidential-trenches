#!/usr/bin/env node
// Live check of card discover-matches-the-main-app: Discover draws each token's own logo and its launchpad's ring
// colour, in the main app's four-column layout from 1024 px. Headless Chromium opens APP_HOST/discover inside SIGN_HOST's
// shell at 1440 x 900, 1024 x 768 and 390 x 844 (dpr 2, touch), signed out, waits for rows and reads every drawn row:
// its chain, its token id, its launchpad badge's pad id, its ring colour, whether it draws initials, and its logo: the
// logo route's status and content type as the page received them and whether the image is drawn. The same run reads the
// helper's lists (HELPER_HOST /v1/market/lists, each chain) for each token's `icon` flag and the pads they hold. Only these
// are recorded: never a name, a symbol or any other text a token carries. Judged:
//   - every row whose launchpad the terminal's table knows (apps/terminal/src/screens/market/pads.ts padRing) draws that
//     pad's ring colour; a row with no known pad a stage colour; the rows drawn at 1440 hold at least three pad colours
//     whenever the lists hold three pads with a colour;
//   - a row in view the helper serves `icon: true` for: its logo route answered 200 with a PNG, JPEG, WebP or GIF and the
//     logo is drawn; a row served `icon: false` asks for no logo; every row without a drawn logo draws its initials; no
//     row draws a broken image;
//   - at 1024 the four columns sit in one row.
// While the helper serves no logo (icon false on every row) the logo part is named and passes on the initials.
// After: app
//   node scripts/live-checks/discover-matches-the-main-app.mjs [--build <dir>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --build serves that terminal build at APP_HOST's name inside the stand-in shell (app-in-shell.mjs harnessRoute,
// signed out), the helper still answered live; --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { padRing } from "../../apps/terminal/src/screens/market/pads.ts";
import { launchBrowser } from "../browsers.mjs";
import { named } from "./record-names.mjs";

const KEY = "discover-matches-the-main-app";
export const APP_HOST = "https://ct-app.unrealized.trade";
export const HELPER_HOST = "https://ct-api.unrealized.trade";
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1 });
const CHAINS = ["solana", "base", "robinhood"];
const READY_MS = 30_000;
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
const IMAGE = /^image\/(png|jpeg|webp|gif)\b/;
const LOGO = /^https:\/\/ct-api\.unrealized\.trade\/v1\/logo\/[a-z]+\/([^/?#]+)$/;
const STAGE = new Set(["var(--blue)", "var(--border-strong)", "var(--text-1)", "#bcbcbc", "#808080"]);
const WIDTHS = [
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "1024", viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

/** The verdict on one recorded run. */
export function judge(rec) {
  const lines = [];
  const bad = (t) => lines.push(`BAD ${t}`);
  const ok = (t) => lines.push(`OK ${t}`);
  const icons = rec.icons ?? {};
  const served = Object.values(icons).filter(Boolean).length;
  if (!rec.widths?.length) bad("no width was read");
  for (const w of rec.widths ?? []) {
    if (w.errors?.length) bad(`${w.name}: page errors ${w.errors.join(" | ")}`);
    if (!w.rows?.length) {
      bad(`${w.name}: no row drawn`);
      continue;
    }
    let ringBad = 0, logoBad = 0, broken = 0;
    for (const r of w.rows) {
      const want = padRing(r.pad);
      if (want ? r.ring !== want : !STAGE.has(r.ring)) {
        ringBad++;
        if (ringBad <= 3) bad(`${w.name} ${r.chain}:${r.id}: ring ${r.ring}, want ${want ?? "a stage colour"} (pad ${r.pad})`);
      }
      if (r.broken) broken++;
      const icon = icons[r.id];
      // served icon true: in view, its logo route answered 200 with an image and the logo is drawn
      if (icon === true && r.inView && !(r.logo?.status === 200 && IMAGE.test(r.logo?.type ?? "") && r.logo?.drawn === true)) {
        logoBad++;
        if (logoBad <= 3) bad(`${w.name} ${r.chain}:${r.id}: served icon true, logo ${JSON.stringify(r.logo)}`);
      }
      // served icon false: no logo asked for or drawn
      if (icon === false && r.logo !== null) {
        logoBad++;
        if (logoBad <= 3) bad(`${w.name} ${r.chain}:${r.id}: served icon false, yet a logo ${JSON.stringify(r.logo)}`);
      }
      if (!r.logo?.drawn && !r.initials) bad(`${w.name} ${r.chain}:${r.id}: no logo and no initials`);
    }
    if (broken) bad(`${w.name}: ${broken} broken images`);
    if (ringBad) bad(`${w.name}: ${ringBad} of ${w.rows.length} rings off their launchpad's colour`);
    else ok(`${w.name}: ${w.rows.length} rows, every ring its launchpad's colour or a stage colour`);
    if (!logoBad) ok(`${w.name}: logos as served (${served} tokens served with a logo)`);
    if (w.name === "1440") {
      const pads = new Set(w.rows.map((r) => padRing(r.pad)).filter(Boolean));
      const listed = new Set((rec.pads ?? []).map(padRing).filter(Boolean));
      const colours = new Set(w.rows.map((r) => r.ring).filter((c) => !STAGE.has(c)));
      if (listed.size >= 3 && colours.size < 3) bad(`1440: ${colours.size} pad ring colours drawn while the lists hold ${listed.size} pads with a colour`);
      else ok(`1440: ${colours.size} pad ring colours drawn (${pads.size} pads)`);
    }
    if (w.name === "1024") {
      const c = w.cols ?? [];
      if (c.length === 4 && new Set(c.map((x) => x.y)).size === 1 && new Set(c.map((x) => x.x)).size === 4) ok("1024: four columns in one row");
      else bad(`1024: columns ${JSON.stringify(c)}, not four in one row`);
    }
  }
  return { verdict: lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS", lines };
}

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
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

// runs in the frame: every drawn row of the visible layout, only what the verdict reads (no name or symbol is recorded)
const ROWS = (scope) => {
  const vis = (e) => e.getClientRects().length > 0;
  return [...document.querySelectorAll(`${scope} [role="listitem"][data-token]`)].filter(vis).map((r) => {
    const av = r.querySelector(".tok-av");
    const img = av?.querySelector("img.tok-logo");
    const b = r.getBoundingClientRect();
    return {
      id: r.getAttribute("data-token"),
      chain: r.querySelector(".tok-cb")?.getAttribute("data-chain") ?? null,
      pad: r.querySelector(".tok-pb")?.getAttribute("data-pad") ?? null,
      ring: r.querySelector("svg[data-ring]")?.getAttribute("data-ring") ?? null,
      inView: b.bottom > 0 && b.top < innerHeight,
      initials: av?.firstChild?.nodeType === 3 && av.firstChild.textContent !== "",
      drawn: img ? img.getAttribute("data-loaded") === "true" && img.naturalWidth > 0 : null,
      broken: [...r.querySelectorAll("img")].some((i) => i.complete && i.naturalWidth === 0 && getComputedStyle(i).opacity !== "0"),
    };
  });
};

async function readWidth(browser, w, harness, shots) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark" });
  if (harness) await ctx.route("**/*", (r) => (originOf(r.request().url()) === HELPER_HOST ? r.continue() : harness(r)));
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    // each logo route's answer: its status and content type, by token
    const answers = new Map();
    page.on("response", (res) => {
      const m = LOGO.exec(res.url());
      if (m) answers.set(decodeURIComponent(m[1]), { status: res.status(), type: res.headers()["content-type"] ?? null });
    });
    await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
    const f = await terminalFrame(page);
    const scope = w.name === "390" ? ".dsc-phone" : ".dsc-grid";
    const until = Date.now() + READY_MS;
    while (Date.now() < until && !(await f.evaluate(ROWS, scope).catch(() => [])).length) await page.waitForTimeout(250);
    // the logos in view answer (loaded or failed)
    await f.waitForFunction((s) => [...document.querySelectorAll(`${s} img.tok-logo`)].every((i) => i.complete || i.getBoundingClientRect().top > innerHeight), scope, { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const rows = (await f.evaluate(ROWS, scope)).map(({ drawn, ...r }) => ({ ...r, logo: drawn === null && !answers.has(r.id) ? null : { ...(answers.get(r.id) ?? { status: null, type: null }), drawn: drawn === true } }));
    const cols = w.name === "1024" ? await f.evaluate(() => [...document.querySelectorAll(".dsc-grid .dsc-col")].map((c) => c.getBoundingClientRect()).map((b) => ({ x: Math.round(b.x), y: Math.round(b.y) }))) : undefined;
    await page.screenshot({ path: path.join(shots, `discover-${w.name}.png`) });
    return { name: w.name, rows, ...(cols && { cols }), errors };
  } finally {
    await ctx.close();
  }
}

async function readIcons() {
  const icons = {};
  const pads = new Set();
  for (const c of CHAINS) {
    const r = await fetch(`${HELPER_HOST}/v1/market/lists?chain=${c}`, { signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200) throw new Error(`lists ${c}: ${r.status}`);
    const b = await r.json();
    for (const rows of Object.values(b.lists ?? {}))
      for (const row of rows) {
        icons[row.token] = row.icon === true; // keyed by the token's id
        if (row.launchpad) pads.add(row.launchpad);
      }
  }
  return { icons, pads: [...pads].sort() };
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
    rec.widths = [];
    for (const w of WIDTHS) rec.widths.push(await readWidth(browser, w, harness, shots));
    Object.assign(rec, await readIcons());
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
