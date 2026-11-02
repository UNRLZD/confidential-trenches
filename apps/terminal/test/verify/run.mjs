#!/usr/bin/env node
// The Verify panel's shots and checks (card app-verify-panel; 09-design-brief S18; app.md A3.3): the fixture page
// (fixtures.tsx) built with vite and served on 127.0.0.1, every state at 390 x 844 (dpr 2, touch) and 1440 x 900
// (dpr 1). Per state: its rows' colours and no other, the opened row's checks with the planted one's colour, app-shell's
// BAR-10 rules (MEASURE: no text under 11 px, no phone tap box under 44 px, no horizontal scroll), no external
// request, and no claim word on screen. Then a tap on a row opens its checks and a second tap closes them.
//   node apps/terminal/test/verify/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
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

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// fixture, S18 state, panel state, code row, funds row, { check: status } of the opened row
const STATES = [
  ["loading", "S18.1", "loading", "loading", "loading", {}],
  ["read", "S18.2", "read", "ok", "ok", {}],
  ["code-open", "S18.15", "read", "ok", "ok", { keys: "ok", code: "ok" }],
  ["funds-open", "S18.16", "read", "ok", "ok", { asset: "ok", registration: "ok", tokenCode: "ok", balance: "ok" }],
  ["unverified", "S18.3", "read", "ok", "warn", { asset: "ok", registration: "ok", tokenCode: "ok", balance: "warn" }],
  ["disagree", "S18.4", "disagree", "warn", "warn", { keys: "warn", code: "ok" }],
  ["short", "S18.8", "read", "ok", "danger", { asset: "ok", registration: "ok", tokenCode: "ok", balance: "danger" }],
  ["release", "S18.9", "read", "danger", "ok", { keys: "ok", code: "danger" }],
  ["key", "CH-091", "read", "danger", "ok", { keys: "danger", code: "ok" }],
  ["unregistered", "CH-120", "read", "ok", "danger", { asset: "ok", registration: "danger", tokenCode: "ok", balance: "ok" }],
];
const CLAIM = /\b(verified|safe|secure|backed|guarantee|trustless|all there|matches|proven|solvent)\b/i;

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-verify-"));
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

let BASE = "";
async function open(browser, w, f) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const external = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}`);
  await page.waitForSelector(".vfy[data-state]");
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
    for (const [f, sid, state, code, funds, checks] of STATES) {
      const tag = `${f} (${sid}) @${w.name}`;
      const { ctx, page, external } = await open(browser, w, f);
      const got = await page.locator(".vfy").evaluate((e) => [e.dataset.state, e.dataset.code, e.dataset.funds]);
      check(JSON.stringify(got) === JSON.stringify([state, code, funds]), `${tag}: panel ${got}, want ${[state, code, funds]}`);
      const shown = Object.fromEntries(await page.$$eval("[data-check]", (els) => els.map((e) => [e.dataset.check, e.dataset.status])));
      check(JSON.stringify(shown) === JSON.stringify(checks), `${tag}: checks ${JSON.stringify(shown)}, want ${JSON.stringify(checks)}`);
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      const body = await page.locator(".vfy").innerText();
      check(!CLAIM.test(body), `${tag}: a claim word on screen: ${body.match(CLAIM)?.[0]}`);
      if (state !== "loading") check(body.includes("275,831,776") && body.includes("https://test.rpc.fastnear.com, https://near-testnet.drpc.org"), `${tag}: the block and the RPCs read`);
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(sid);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${sid}-${f}-${w.name}.png`) });
      await ctx.close();
    }

    // a tap opens a row's checks in place and a second tap closes them
    {
      const { ctx, page } = await open(browser, w, "read");
      const row = page.locator('[data-control="verify-funds"]');
      await row.click();
      const opened = [await row.getAttribute("aria-expanded"), await page.locator('[data-row="funds"] [data-check]').count()];
      await row.click();
      const closed = [await row.getAttribute("aria-expanded"), await page.locator("[data-check]").count()];
      check(JSON.stringify(opened) === '["true",4]' && JSON.stringify(closed) === '["false",0]', `@${w.name}: funds row tap ${opened} then ${closed}`);
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
  console.log(`FAIL ${fails.length} checks over ${n} shots and the row taps`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${STATES.length} states x 390/1440), BAR-10 per shot, no claim word, the row taps${SHOTS ? `; shots in ${SHOTS}` : ""}`);
