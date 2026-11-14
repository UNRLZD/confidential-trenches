#!/usr/bin/env node
// The app's Withdraw form end to end on fixtures (card withdraw-in-app-to-any-chain): fixtures.tsx built with vite and
// served on 127.0.0.1, at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1). Opened as Portfolio's Robinhood pool row opens
// it, the one withdraw form:
//   - the places row names every place with money (NEAR, Solana, Base, Robinhood) with Robinhood picked; To names every
//     chain the pool pays out on (NEAR, Solana, Base, Robinhood) with Robinhood picked; both rows the deposit's tiles;
//   - To Solana, an amount, and Robinhood's own kind of address (0x): the address field's red edge, Withdraw off;
//   - a Solana address: Withdraw on; its tap asks the shell for exactly pool.withdraw {chain robinhood, to, amount,
//     dest solana}, the message test/e2e/signing-sheet/run.mjs posts to reach SIGN_HOST's Confirm (poolwithdrawdest);
//   - From NEAR (Cash): To is NEAR alone (the kit's withdraw.open takes no dest), and Solana's address is refused there;
//   - every step: app-shell's BAR-10 rules (MEASURE: no text under 11 px, no phone tap box under 44 px, no horizontal
//     scroll), no external request, and the form whole inside the sheet's body, above its foot.
//   node apps/terminal/test/withdraw-form/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
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
const SOL_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_TO = "0x52908400098527886E0F7030069857D2E4169EE7";
const ALL = "near solana base robinhood";

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-withdraw-form-"));
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

const fails = [];
const passes = [];
const check = (ok, what) => (ok ? passes.push(what) : fails.push(what));

/** The form as drawn: its rows' tiles and picks, its fields' edges, Withdraw, and whether it sits inside the body. */
const read = (page) =>
  page.evaluate(() => {
    const f = document.querySelector('[data-sheet="deposit"][data-mode="withdraw"] [data-form="withdraw"]');
    if (!f) return null;
    const on = (sel) => [...f.querySelectorAll(sel)].filter((b) => b.classList.contains("on")).map((b) => b.dataset.from ?? b.dataset.to);
    const all = (sel, k) => [...f.querySelectorAll(sel)].map((b) => b.dataset[k]).join(" ");
    const body = document.querySelector(".dep .dbody").getBoundingClientRect();
    const foot = document.querySelector(".dep .dfoot").getBoundingClientRect();
    const addr = f.querySelector(".waddr").getBoundingClientRect();
    const go = document.querySelector('[data-control="withdraw-go"]');
    return {
      from: all("[data-from]", "from"),
      fromOn: on("[data-from]"),
      to: all("[data-to]", "to"),
      toOn: on("[data-to]"),
      labels: [...f.querySelectorAll(".lb")].map((l) => l.textContent),
      dest: f.dataset.dest,
      ready: f.dataset.ready,
      addressBad: f.querySelector(".waddr").classList.contains("bad"),
      go: go ? !go.disabled : null,
      inside: addr.bottom <= body.bottom + 0.5 && addr.bottom <= foot.top + 0.5 && f.getBoundingClientRect().right <= body.right + 0.5,
    };
  });

const dir = await build();
const server = await serve(dir);
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchHarnessBrowser("chromium");
try {
  for (const w of WIDTHS) {
    const tag = (s) => `${s} @${w.name}`;
    const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    const external = [];
    page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
    await page.goto(`${BASE}/?from=robinhood`);
    await page.waitForSelector('[data-form="withdraw"]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const bar = async (step) => {
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, tag(`${step}: no horizontal scroll`));
      check(m.smallText.length === 0, tag(`${step}: no text under 11 px ${m.smallText.join(", ")}`));
      check(m.smallTaps.length === 0, tag(`${step}: no tap under 44 px ${m.smallTaps.join(", ")}`));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${step}-${w.name}.png`) });
    };
    const tap = (sel) => (w.hasTouch ? page.locator(sel).tap() : page.locator(sel).click());

    // opened from the Robinhood pool row: From and To, each its place picked
    let r = await read(page);
    check(r?.from === ALL && r.fromOn.join() === "robinhood", tag(`From: every place with money, Robinhood picked (${r?.from} / ${r?.fromOn})`));
    check(r?.to === ALL && r.toOn.join() === "robinhood", tag(`To: every chain the pool pays out on, Robinhood picked (${r?.to} / ${r?.toOn})`));
    check(r?.labels.join("|") === "To|Amount|Address", tag(`the labels ${r?.labels.join("|")}`));
    check(r?.inside === true, tag("the form inside the sheet's body, above its foot"));
    await bar("open");

    // To Solana, an amount, the pool's own kind of address: refused on Solana
    await tap('[data-form="withdraw"] [data-to="solana"]');
    await page.locator('[data-field="withdraw-amount"]').fill("0.001");
    await page.locator('[data-field="withdraw-address"]').fill(EVM_TO);
    r = await read(page);
    check(r?.dest === "solana" && r.toOn.join() === "solana" && r.addressBad && r.go === false, tag(`To Solana with an 0x address: refused, Withdraw off (${JSON.stringify(r)})`));
    await bar("wrong-address");

    // a Solana address: Withdraw on, and its tap asks for the Robinhood pool's withdraw to Solana
    await page.locator('[data-field="withdraw-address"]').fill(SOL_TO);
    r = await read(page);
    check(r?.ready === "yes" && r.go === true && !r.addressBad && r.inside, tag(`To Solana with a Solana address: Withdraw on (${JSON.stringify(r)})`));
    await bar("ready");
    await tap('[data-control="withdraw-go"]');
    await page.waitForFunction(() => window.__calls.some((c) => c.kind === "close"), null, { timeout: 5000 }).catch(() => {});
    const calls = await page.evaluate(() => window.__calls.filter((c) => c.kind !== "close").map((c) => ({ kind: c.kind, params: c.params })));
    const want = [{ kind: "pool.withdraw", params: { chain: "robinhood", to: SOL_TO, amount: "0.001", dest: "solana" } }];
    check(JSON.stringify(calls) === JSON.stringify(want), tag(`the tap asks ${JSON.stringify(calls)}, want ${JSON.stringify(want)}`));

    // From NEAR (Cash): To is NEAR alone; a Solana address is refused there
    await page.reload();
    await page.waitForSelector('[data-form="withdraw"]');
    await page.waitForTimeout(300);
    await tap('[data-form="withdraw"] [data-from="near"]');
    await page.locator('[data-field="withdraw-amount"]').fill("1");
    await page.locator('[data-field="withdraw-address"]').fill(SOL_TO);
    r = await read(page);
    check(r?.to === "near" && r.dest === "near" && r.addressBad && r.go === false, tag(`From NEAR: To NEAR alone, a Solana address refused (${JSON.stringify(r)})`));
    await bar("cash");
    check(external.length === 0, tag(`no external request ${external.join(" ")}`));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
for (const l of passes) console.log(`ok   ${l}`);
for (const l of fails) console.log(`FAIL ${l}`);
console.log(`${fails.length ? "FAIL" : "PASS"} withdraw-form on ${browserLabel(browser)}${SHOTS ? `; shots in ${SHOTS}` : ""}`);
process.exit(fails.length ? 1 : 0);
