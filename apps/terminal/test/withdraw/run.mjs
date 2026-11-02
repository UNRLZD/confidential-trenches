#!/usr/bin/env node
// The withdraw progress's shots and checks (card app-withdraw-entry; A1.7, app.md:1440; S12.11, S12.12, S12.14, S12.15
// and the kit's `stopped`): the fixture page (fixtures.tsx) built with vite and served on 127.0.0.1, every state at
// 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), the page clock paused by Playwright at NOW. Per state: its own state id and no
// other, app-shell's BAR-10 rules (MEASURE: no text under 11 px, no phone tap box under 44 px, no horizontal scroll), no
// external request (the tx link opens only when tapped), and no field the app could take an address or amount in
// (W:924-925). An old finished withdrawal draws nothing. Then: BAR-05 and AS-03, the sheet's box in every state and the
// action's in the end states within 2 px of R5's (the deposit sheet's, test/deposit-sheet/run.mjs); BAR-11, S12.12's
// counter ticks in place over 120 s of page clock with no layout shift; and the taps: Done and the close drop the
// withdrawal, Deposit drops it and asks for the deposit sheet, and a stopped withdrawal's Withdraw sends withdraw.open
// with no param (the address is typed on SIGN_HOST's form), off while the signing page is not READY.
//   node apps/terminal/test/withdraw/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = Date.parse("2026-11-02T03:00:00Z");
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// R5's boxes, probe P-C (app.md:1100), the deposit sheet's: [x, y, w, h]
const R5 = {
  "390": { sheet: [0, 101.3, 390, 742.7], action: [16, 768, 358, 56] },
  "1440": { sheet: [1110, 0, 330, 900], action: [1123, 849, 305, 39] },
};
// fixture, the state it must show (null: nothing drawn), the seconds the page clock runs before the shot
const STATES = [
  ["sending", "S12.11", 0],
  ["submitted", "S12.11", 0],
  ["processing", "S12.12", 4],
  ["reload", "S12.12", 4],
  ["sent", "S12.14", 0],
  ["sent-kit-only", "S12.14", 0],
  ["refunded", "S12.15", 0],
  ["stopped", "stopped", 0],
  ["stopped-down", "stopped", 0],
  ["old", null, 0],
];
const SOLSCAN = "https://solscan.io/tx/5xYq2kPZbE7rN4cT8wLm1vDh3sFj6gUa9oRiKeXtBnWpQz2cM7yHd4LfVs8JaGu1";
const NEARBLOCKS = "https://nearblocks.io/txns/9QxkTn3d2bYpW8LhF4cVzR7mKe1sJ6uA5gN0oPiHqXyD";
const LINK = { "S12.14": SOLSCAN, "S12.15": NEARBLOCKS };

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-withdraw-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const fails = [];
const drafts = new Map();
const check = (ok, what) => ok || fails.push(what);
const rect = (page, sel) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

let BASE = "";
async function open(browser, w, f, run = 0) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW - 1000 });
  await page.clock.pauseAt(NOW);
  const external = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}`);
  await page.waitForSelector(".shell");
  if (run) await page.clock.runFor(run * 1000);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external };
}

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  for (const w of WIDTHS) {
    const boxes = {};
    for (const [f, want, run] of STATES) {
      const tag = `${f} @${w.name}`;
      const { ctx, page, external } = await open(browser, w, f, run);
      if (want === null) {
        // the old one: give the page its second state, then nothing may be drawn
        await page.clock.runFor(1000);
        check((await page.locator(".wdr").count()) === 0, `${tag}: an old finished withdrawal drawn`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `none-${f}-${w.name}.png`) });
        await ctx.close();
        continue;
      }
      const shown = await page.locator(`.wdr[data-state="${want}"]`).waitFor({ timeout: 5000 }).then(() => true, () => false);
      const got = await page.locator(".wdr").getAttribute("data-state").catch(() => null);
      check(shown, `${tag}: state ${got}, want ${want}`);
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      // no field: the address and the amount are typed on SIGN_HOST's form only (W:924-925)
      check((await page.locator(".wdr input, .wdr textarea, .wdr select, .wdr [contenteditable]").count()) === 0, `${tag}: a field in the app`);
      // the tx link: only in the end states, on the last tx's explorer, opened only by a tap
      const links = await page.$$eval(".wdr a", (as) => as.map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
      if (LINK[want]) check(links.length === 1 && links[0].href === LINK[want] && links[0].target === "_blank" && links[0].rel.includes("noreferrer"), `${tag}: tx link ${JSON.stringify(links)}`);
      else check(links.length === 0, `${tag}: a link outside the end states ${JSON.stringify(links)}`);
      // the end screen's check only at the kit's sent (as deposit's BAR-12)
      check((want === "S12.14") === ((await page.locator('.wdr svg[data-ring="24"] path').count()) === 1), `${tag}: the check mark in ${want}`);
      if (want === "S12.12") check((await page.locator(".wdr [data-counter]").getAttribute("data-counter")) === String(run), `${tag}: counter, want ${run}`);
      const action = await page.locator(".wdr .dfoot .dbtn").count();
      check(action === (["S12.14", "S12.15", "stopped"].includes(want) ? 1 : 0), `${tag}: ${action} actions`);
      if (!boxes[want]) boxes[want] = { sheet: await rect(page, ".dep-box"), action: action ? await rect(page, ".dfoot .dbtn") : null };
      if (f === "stopped-down") check(await page.locator('[data-control="withdraw-again"]').isDisabled(), `${tag}: Withdraw on while the signing page is down`);
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(want);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${want}-${f}-${w.name}.png`) });
      await ctx.close();
    }

    // BAR-05 and AS-03: one sheet box in every state, one action box in the end states, and R5's
    for (const k of ["S12.11", "S12.12", "S12.14", "S12.15", "stopped"]) check(boxes[k] && near(boxes[k].sheet, R5[w.name].sheet, 2), `@${w.name}: BAR-05 sheet ${k} ${boxes[k]?.sheet} vs R5 ${R5[w.name].sheet}`);
    for (const k of ["S12.14", "S12.15", "stopped"]) check(boxes[k]?.action && near(boxes[k].action, R5[w.name].action, 2), `@${w.name}: BAR-05 action ${k} ${boxes[k]?.action} vs R5 ${R5[w.name].action}`);
    console.log(`@${w.name} sheet ${boxes["S12.14"].sheet.map((v) => v.toFixed(1))} action ${boxes["S12.14"].action.map((v) => v.toFixed(1))}`);

    // BAR-11: the counter ticks in place over 120 s of page clock
    {
      const { ctx, page } = await open(browser, w, "processing");
      await page.waitForSelector('.wdr[data-state="S12.12"]');
      const b0 = await rect(page, ".wcnt");
      const c0 = Number(await page.locator("[data-counter]").getAttribute("data-counter"));
      const s0 = await page.evaluate(() => window.__ct.shifts.reduce((a, b) => a + b, 0));
      await page.clock.runFor(120_000);
      const b1 = await rect(page, ".wcnt");
      const c1 = Number(await page.locator("[data-counter]").getAttribute("data-counter"));
      const s1 = await page.evaluate(() => window.__ct.shifts.reduce((a, b) => a + b, 0));
      check(c1 - c0 >= 119 && near(b0, b1, 0.5) && s1 === s0, `@${w.name}: BAR-11 counter ${c0}->${c1}, box ${b0} -> ${b1}, shift ${s1 - s0}`);
      await ctx.close();
    }

    // the taps
    for (const [f, sel] of [["sent", '[data-control="withdraw-done"]'], ["refunded", '[data-control="withdraw-done"]'], ["processing", ".dep-x"]]) {
      const { ctx, page } = await open(browser, w, f);
      await page.waitForSelector(".wdr");
      await page.locator(sel).click();
      check((await page.locator(".wdr").count()) === 0, `@${w.name} ${f}: ${sel} did not drop the withdrawal`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, w, "sent");
      await page.locator('[data-control="withdraw-deposit"]').click();
      const calls = await page.evaluate(() => window.__calls);
      check(calls.some((c) => c.kind === "deposit") && (await page.locator(".wdr").count()) === 0, `@${w.name}: Deposit ${JSON.stringify(calls)}`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, w, "stopped");
      await page.locator('[data-control="withdraw-again"]').click();
      const c = (await page.evaluate(() => window.__calls)).find((x) => x.kind === "withdraw.open");
      check(c && JSON.stringify(c.params) === "{}" && c.view.sheet === "withdraw" && c.view.control === "withdraw-again" && JSON.stringify(c.view.fields) === "{}", `@${w.name}: withdraw.open ${JSON.stringify(c)}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
const n = STATES.length * WIDTHS.length;
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} checks over ${n} shots, BAR-05, BAR-11 and the taps`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${STATES.length} fixtures x 390/1440), BAR-10 per shot, BAR-05/AS-03, BAR-11 and the taps${SHOTS ? `; shots in ${SHOTS}` : ""}`);
