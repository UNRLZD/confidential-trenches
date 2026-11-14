#!/usr/bin/env node
// The welcome's shots and checks (shell/Welcome.tsx; owner ask 14 Nov ~06:00Z): the fixture page (fixtures.tsx) built
// with vite and served on 127.0.0.1, at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1). Per slide: its number on
// data-welcome, app-shell's BAR-10 rules (MEASURE: no text under 11 px, no phone tap box under 44 px, no horizontal
// scroll, no CSP violation), the box the same size on every slide (nothing moves between them), the box inside the
// screen, and no external request. Then the moves: Next and the right arrow go on, Back and the left arrow go back, a
// swipe goes either way, and Skip, the close, Esc, the scrim and Start trading each close it and write ct-welcome "1";
// drawn as the app draws it (?f=auto), it opens with no mark and stays shut once marked. Slides 2 to 4 draw their art on
// a canvas (shell/loop/loop.ts): each must light at least LIT pixels, and with motion allowed it must move.
//   node apps/terminal/test/welcome/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-welcome-"));
  await build({ root: HERE, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const LIT = 1500;
// the canvas's lit pixels (alpha over 40), 0 when it is not there; given a minimum, false until it is reached
const LIGHT = (min) => {
  const c = document.querySelector(".wlc-cv");
  let n = 0;
  if (c?.width) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 40) n++;
  }
  return min === undefined || n >= min ? n : false;
};
const FRAME = () => {
  const c = document.querySelector(".wlc-cv");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let k = 3; k < d.length; k += 4) h = (h * 31 + d[k]) | 0;
  return h;
};
const fails = [];
const check = (ok, what) => ok || fails.push(what);
let BASE = "";
async function open(browser, w, f = "force", mark = null) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  if (mark !== null) await ctx.addInitScript((m) => localStorage.setItem("ct-welcome", m), mark);
  const page = await ctx.newPage();
  const external = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}`);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external };
}
const slide = (page) => page.locator(".wlc").getAttribute("data-welcome").catch(() => null);
const box = (page) => page.locator(".wlc-box").evaluate((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); });
const mark = (page) => page.evaluate(() => localStorage.getItem("ct-welcome"));
const shut = async (page) => (await page.locator(".wlc").count()) === 0;

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchHarnessBrowser("chromium");
try {
  for (const w of WIDTHS) {
    const tag = (s) => `slide ${s} @${w.name}`;
    const { ctx, page, external } = await open(browser, w);
    await page.waitForSelector(".wlc");
    let first = null;
    for (let s = 1; s <= 4; s++) {
      check((await slide(page)) === String(s), `${tag(s)}: data-welcome ${await slide(page)}`);
      const drawn = await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).then(() => true, () => false);
      check(drawn, `${tag(s)}: an image did not load: ${await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src).join(", "))}`);
      if (s > 1) {
        const lit = await page.waitForFunction(LIGHT, LIT, { timeout: 8000 }).then((h) => h.jsonValue(), () => page.evaluate(LIGHT));
        check(lit >= LIT, `${tag(s)}: the art lit ${lit} px, want ${LIT} or more`);
      }
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, `${tag(s)}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag(s)}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag(s)}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag(s)}: CSP violations ${JSON.stringify(m.violations)}`);
      const b = await box(page);
      first ??= b;
      check(b.every((v, i) => Math.abs(v - first[i]) <= 1), `${tag(s)}: box ${b} moved from ${first}`);
      check(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= w.viewport.width + 1 && b[1] + b[3] <= w.viewport.height + 1, `${tag(s)}: box ${b} outside the screen`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `welcome-${s}-${w.name}.png`) });
      if (s < 4) await page.locator('[data-control="welcome-next"]').click();
    }
    // back and forth
    await page.locator('[data-control="welcome-back"]').click();
    check((await slide(page)) === "3", `Back @${w.name}: slide ${await slide(page)}`);
    await page.keyboard.press("ArrowLeft");
    check((await slide(page)) === "2", `ArrowLeft @${w.name}: slide ${await slide(page)}`);
    await page.keyboard.press("ArrowRight");
    check((await slide(page)) === "3", `ArrowRight @${w.name}: slide ${await slide(page)}`);
    const [x, y, bw, bh] = await box(page);
    const swipe = async (from, to) => {
      await page.mouse.move(x + from, y + bh / 2);
      await page.mouse.down();
      await page.mouse.move(x + to, y + bh / 2, { steps: 4 });
      await page.mouse.up();
    };
    await swipe(bw * 0.7, bw * 0.2);
    check((await slide(page)) === "4", `swipe left @${w.name}: slide ${await slide(page)}`);
    await swipe(bw * 0.2, bw * 0.7);
    check((await slide(page)) === "3", `swipe right @${w.name}: slide ${await slide(page)}`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    check((await slide(page)) === "4", `no slide past the last @${w.name}: slide ${await slide(page)}`);
    const href = await page.locator('[data-control="welcome-feedback"]').getAttribute("href");
    check(href === "https://github.com/UNRLZD/confidential-trenches/issues", `feedback link @${w.name}: ${href}`);
    check(external.length === 0, `external requests @${w.name}: ${external.join(", ")}`);
    await page.locator('[data-control="welcome-start"]').click();
    check(await shut(page), `Start trading @${w.name}: still open`);
    check((await mark(page)) === "1", `Start trading @${w.name}: mark ${await mark(page)}`);
    await ctx.close();
    // every other way to close it
    for (const [how, act] of [
      ["Skip", (p) => p.locator('[data-control="welcome-skip"]').click()],
      ["the close", (p) => p.locator('[data-control="welcome-close"]').click()],
      ["Esc", (p) => p.keyboard.press("Escape")],
      ["the scrim", (p) => p.locator(".wlc-scrim").click({ position: { x: 5, y: 5 } })],
    ]) {
      const o = await open(browser, w);
      await o.page.waitForSelector(".wlc");
      await act(o.page);
      check(await shut(o.page), `${how} @${w.name}: still open`);
      check((await mark(o.page)) === "1", `${how} @${w.name}: mark ${await mark(o.page)}`);
      await o.ctx.close();
    }
    // as the app draws it: open with no mark, shut once marked
    const fresh = await open(browser, w, "auto");
    check(await fresh.page.locator(".wlc").waitFor({ timeout: 3000 }).then(() => true, () => false), `auto, no mark @${w.name}: not drawn`);
    await fresh.ctx.close();
    // with motion allowed, slide 2's loop moves
    const moving = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "no-preference" });
    await moving.addInitScript(INIT);
    const mp = await moving.newPage();
    await mp.goto(`${BASE}/?f=force`);
    await mp.locator('[data-control="welcome-next"]').click();
    await mp.waitForFunction(LIGHT, LIT, { timeout: 8000 }).catch(() => {});
    const f0 = await mp.evaluate(FRAME);
    await mp.waitForTimeout(400);
    const f1 = await mp.evaluate(FRAME);
    check(f0 !== f1, `slide 2 @${w.name}: the loop did not move in 400 ms`);
    await moving.close();
    const back = await open(browser, w, "auto", "1");
    await back.page.waitForTimeout(300);
    check(await shut(back.page), `auto, marked @${w.name}: drawn again`);
    await back.ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (fails.length) {
  for (const f of fails) console.log(`BAD ${f}`);
  console.log(`FAIL ${fails.length} fault(s)`);
  process.exit(1);
}
console.log(`PASS welcome: 4 slides x 390/1440, BAR-10 per slide, the box still across slides, every move and every close${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
