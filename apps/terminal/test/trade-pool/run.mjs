#!/usr/bin/env node
// The trade box and the sell box on a chain's pool (card trade-box-pool; plan v2 A2), their shots and checks: the trade
// box's fixture page (test/trade-box, ?pool=) and the sell box's (test/sell-positions, ?pool=sol), each a kit stub,
// built with vite and served on 127.0.0.1, every state at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), under a dark
// and a light colour scheme (the terminal is dark only: the light run proves it stays dark), the page clock paused.
// The pools are stand-ins recorded from real runs (test/trade-box/fixtures.tsx): the devnet Solana pool's 0.01 SOL note
// and the Base Sepolia pool's 0.001 ETH chunks. Per state: app-shell's BAR-10 rules (MEASURE), no external request, no
// dialog. Then:
//   - a proof ready on Solana: Bal and Max are the pool's balance and one tap's most in USD ($0.93, $0.16), the line
//     reads "Proof ready", every preset is off (all over one tap), and the button sends pool.buy with the USD in SOL,
//     rounded down (0.001720236), never the vault's buy; it fills on the kit's stage in under 2 s (Filled 1.1s);
//   - over one tap ($0.17) and a proof still making: the button is off and a tap sends nothing; the amount field is
//     marked wrong over one tap, never while the proof is making;
//   - Base: a whole chunk's USD ($3.50) sends pool.buy for 0.001 ETH; any other amount ($3.00) sends nothing;
//   - the presets row: Solana and the vault keep the four; on Base it is one button, the row's width, holding the chunk's
//     USD ($3.50), whose tap fills 3.50 and sends that pool.buy; with no proof ready yet its value is unknown: "—", off;
//   - no pool: the vault's buy as before (data-path vault, no proof label);
//   - the sell on a pool chain sends pool.sell for the same units the vault's sell would, and its line reads
//     "Back to Cash"; with no pool the vault's sell goes as before.
//   node apps/terminal/test/trade-pool/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel, launchBrowser } from "../../../../scripts/browsers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const SHOTS = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const NOW = Date.parse("2026-11-04T06:00:00Z");
// the fixtures' mint and EVM token (shapes only), kept apart from a `token:` key (gitleaks reads a long id beside that word)
const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const EVM = "0x00000000000000000000000000000000000f1fe7";
// the sell box's 50% of the fixture's 1234567.891234 units (test/sell-positions/run.mjs HALF): a 5,000 bps share on
// pool.sell (card pool-sell-share-across-wallets), whole base units at the token's 6 decimals on the vault's sell
// (signpage trade.ts UNITS)
const HALF_UNITS = "617283945617";
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const SCHEMES = ["dark", "light"];
// the buy states: name, query, the path, the proof label, Bal, the line above the button, whether the button is on, the
// request one tap sends (null: none)
const BUYS = [
  ["sol-ready", "pool=sol-ready&amt=0.16", "pool", "ready", "Bal $0.93", "Proof ready Max $0.16", true, { kind: "pool.buy", params: { chain: "solana", token: MINT, amount: "0.001720236", slippage_bps: 1000 } }],
  ["sol-over", "pool=sol-ready&amt=0.17", "pool", "ready", "Bal $0.93", "Proof ready Max $0.16", false, null],
  ["sol-making", "pool=sol-making&amt=0.16", "pool", "making", "Bal $0.93", "Making proof", false, null],
  ["base-chunk", "pool=base-ready&amt=3.50", "pool", "ready", "Bal $10.50", "Proof ready Max $3.50", true, { kind: "pool.buy", params: { chain: "base", token: EVM, amount: "0.001", slippage_bps: 1000 } }],
  ["base-other", "pool=base-ready&amt=3", "pool", "ready", "Bal $10.50", "Proof ready Max $3.50", false, null],
  ["base-making", "pool=base-making&amt=3.50", "pool", "making", "Bal $10.50", "Making proof", false, null],
  ["vault", "amt=25", "vault", null, "Bal $73.18", "Max $100", true, { kind: "buy", params: { chain: "solana", token: MINT, side: "buy", amount: "25.00", slippage_bps: 1000 } }],
];
// the amount field marked wrong: over one tap, or not a whole chunk on Base; never while a proof is still making (the
// amount is not what is wrong) or on an amount the pool can take
const BAD = { "sol-ready": "false", "sol-over": "true", "sol-making": "false", "base-chunk": "false", "base-other": "true", "base-making": "false", vault: "false" };
// the presets row as data-preset:disabled:text per button: the four on Solana (all over one tap's most on the pool, $100
// over the vault's max); on Base the chunk's one button, "—" and off while no proof is ready
const FOUR_OFF = "10.00:true:$10 25.00:true:$25 50.00:true:$50 100.00:true:$100";
const PRESET_ROW = {
  "sol-ready": FOUR_OFF,
  "sol-over": FOUR_OFF,
  "sol-making": FOUR_OFF,
  "base-chunk": "3.50:false:$3.50",
  "base-other": "3.50:false:$3.50",
  "base-making": ":true:—",
  vault: "10.00:false:$10 25.00:false:$25 50.00:false:$50 100.00:true:$100",
};
const BASE_ASK = { kind: "pool.buy", params: { chain: "base", token: EVM, amount: "0.001", slippage_bps: 1000 } };
const SELLS = [
  ["sell-pool", "f=up&pool=sol", "Back to Cash", { kind: "pool.sell", params: { chain: "solana", token: MINT, share_bps: 5000, slippage_bps: 1000 } }],
  ["sell-vault", "f=up", "", { kind: "buy", params: { chain: "solana", token: MINT, side: "sell", amount: HALF_UNITS, slippage_bps: 1000 } }],
];

async function build(root) {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-trade-pool-"));
  await build({ root, logLevel: "error", plugins: [react()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0 } });
  return out;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
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
const drafts = new Map();
let checks = 0;
const check = (ok, what) => (checks++, ok || fails.push(what));
const norm = (s) => s.replace(/\s+/g, " ").trim();
/** Polls (real time, up to 3 s) until the read equals what the row wants, then returns what it saw. */
async function settle(read, want) {
  const end = Date.now() + 3_000;
  let got = await read();
  while (got !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    got = await read();
  }
  return got;
}

async function open(browser, base, w, scheme, query, ready) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.clock.install({ time: NOW - 1000 });
  await page.clock.pauseAt(NOW);
  const external = [];
  const dialogs = [];
  page.on("request", (r) => !r.url().startsWith(base) && !r.url().startsWith("data:") && external.push(r.url()));
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  await page.goto(`${base}/?${query}`);
  await page.waitForSelector(ready);
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external, dialogs };
}

async function common(page, w, tag, external, dialogs) {
  const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
  check(!m.hscroll, `${tag}: horizontal scroll`);
  check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
  check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
  check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
  check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
  check(dialogs.length === 0 && (await page.locator('[role="dialog"], dialog').count()) === 0, `${tag}: a dialog ${dialogs.join(" ")}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = (bg.match(/\d+/g) ?? [255, 255, 255]).map(Number);
  check(r + g + b < 120, `${tag}: the page turned light (${bg})`);
  for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
    if (!drafts.has(d)) drafts.set(d, new Set());
    drafts.get(d).add(tag.split(" ")[0]);
  }
}

const boxDir = await build(path.join(HERE, "../trade-box"));
const sellDir = await build(path.join(HERE, "../sell-positions"));
const boxServer = await serve(boxDir);
const sellServer = await serve(sellDir);
const BOX = `http://127.0.0.1:${boxServer.address().port}`;
const SELL = `http://127.0.0.1:${sellServer.address().port}`;
const browser = await launchBrowser("chromium");
let shots = 0;
try {
  for (const w of WIDTHS) {
    for (const scheme of SCHEMES) {
      for (const [name, query, pathWant, proof, bal, line, on, ask] of BUYS) {
        const tag = `${name} @${w.name} ${scheme}`;
        const { ctx, page, external, dialogs } = await open(browser, BOX, w, scheme, query, '[data-testid="trade-box"]');
        const box = page.locator('[data-testid="trade-box"]');
        const cta = page.locator('[data-testid="trade-cta"]');
        check((await box.getAttribute("data-path")) === pathWant, `${tag}: path ${await box.getAttribute("data-path")}, want ${pathWant}`);
        const proofEl = page.locator('[data-testid="trade-proof"]');
        check((proof === null ? (await proofEl.count()) === 0 : (await proofEl.getAttribute("data-proof")) === proof), `${tag}: proof label ${(await proofEl.count()) ? await proofEl.getAttribute("data-proof") : "none"}, want ${proof ?? "none"}`);
        const gotBal = norm(await page.locator('[data-testid="trade-balance"]').innerText());
        check(gotBal === bal, `${tag}: balance "${gotBal}", want "${bal}"`);
        const gotLine = await settle(async () => norm(await page.locator('[data-testid="trade-max"]').innerText()), line);
        check(gotLine === line, `${tag}: the line above the button "${gotLine}", want "${line}"`);
        const marked = await page.locator(".trb-amount").getAttribute("data-bad");
        check(marked === BAD[name], `${tag}: the amount field marked wrong ${marked}, want ${BAD[name]}`);
        check((await cta.isDisabled()) === !on, `${tag}: the button is ${(await cta.isDisabled()) ? "off" : "on"}, want ${on ? "on" : "off"}`);
        const presets = await page.$$eval('[data-testid="trade-presets"] [data-preset]', (bs) => bs.map((b) => `${b.getAttribute("data-preset")}:${b.disabled}:${b.textContent.trim()}`).join(" "));
        check(presets === PRESET_ROW[name], `${tag}: presets ${presets}, want ${PRESET_ROW[name]}`);
        // Base's one button fills the row, never a quarter of it
        if (name.startsWith("base")) {
          const [row, btn] = await page.$$eval('[data-testid="trade-presets"], [data-testid="trade-presets"] [data-preset]', (els) => els.map((e) => e.getBoundingClientRect().width));
          check(Math.abs(row - btn) < 1, `${tag}: the chunk button is ${btn}px of a ${row}px row`);
        }
        await common(page, w, tag, external, dialogs);
        if (SHOTS) (await page.screenshot({ path: path.join(SHOTS, `${name}-${w.name}-${scheme}.png`) }), shots++);
        // one tap: the ask the box's own checks passed, or nothing
        await cta.click({ force: true });
        await page.clock.runFor(100);
        const calls = await page.evaluate(() => window.__calls);
        if (ask) {
          check(calls.length === 1 && JSON.stringify({ kind: calls[0].kind, params: calls[0].params }) === JSON.stringify(ask), `${tag}: sent ${JSON.stringify(calls)}, want ${JSON.stringify(ask)}`);
          // tap to filled under 2 s once a proof is ready: the kit's filled stage at 1.1 s ends the box at Filled 1.1s
          await page.clock.runFor(1_100);
          const filled = await settle(async () => norm(await cta.innerText()), "Filled 1.1s Final");
          check(filled === "Filled 1.1s Final", `${tag}: after the tap "${filled}", want "Filled 1.1s Final"`);
          if (SHOTS && name === "sol-ready") (await page.screenshot({ path: path.join(SHOTS, `${name}-filled-${w.name}-${scheme}.png`) }), shots++);
        } else check(calls.length === 0, `${tag}: a tap on an off button sent ${JSON.stringify(calls)}`);
        // the chunk button: a tap fills the amount with the chunk's USD and buys it, as a preset does; off, it does nothing
        if (name === "base-other" || name === "base-making") {
          await page.locator('[data-testid="trade-presets"] [data-preset]').first().click({ force: true });
          await page.clock.runFor(100);
          const after = await page.evaluate(() => window.__calls);
          const typed = await page.locator(".trb-input").inputValue();
          if (name === "base-other") {
            check(typed === "3.50", `${tag}: the chunk button filled "${typed}", want "3.50"`);
            check(after.length === 1 && JSON.stringify({ kind: after[0].kind, params: after[0].params }) === JSON.stringify(BASE_ASK), `${tag}: the chunk button sent ${JSON.stringify(after)}, want ${JSON.stringify(BASE_ASK)}`);
            if (SHOTS) (await page.screenshot({ path: path.join(SHOTS, `base-chunk-tap-${w.name}-${scheme}.png`) }), shots++);
          } else check(after.length === 0 && typed === "3.50", `${tag}: the off chunk button sent ${JSON.stringify(after)} and left "${typed}"`);
        }
        await ctx.close();
      }
      for (const [name, query, toPool, ask] of SELLS) {
        const tag = `${name} @${w.name} ${scheme}`;
        const { ctx, page, external, dialogs } = await open(browser, SELL, w, scheme, query, '[data-testid="sell-box"]');
        const lineEl = page.locator('[data-testid="sell-to-pool"]');
        const got = (await lineEl.count()) ? norm(await lineEl.innerText()) : "";
        check(got === toPool, `${tag}: the sell's line "${got}", want "${toPool}"`);
        await common(page, w, tag, external, dialogs);
        if (SHOTS) (await page.screenshot({ path: path.join(SHOTS, `${name}-${w.name}-${scheme}.png`) }), shots++);
        await page.locator('[data-testid="sell-cta"]').click();
        await page.clock.runFor(100);
        const calls = await page.evaluate(() => window.__calls);
        check(calls.length === 1 && JSON.stringify({ kind: calls[0].kind, params: calls[0].params }) === JSON.stringify(ask), `${tag}: sent ${JSON.stringify(calls)}, want ${JSON.stringify(ask)}`);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  boxServer.close();
  sellServer.close();
  rmSync(boxDir, { recursive: true, force: true });
  rmSync(sellDir, { recursive: true, force: true });
}

for (const [d, ids] of [...drafts].sort()) console.log(`draft copy on screen: ${d} (${[...ids].join(", ")})`);
const n = (BUYS.length + SELLS.length) * WIDTHS.length * SCHEMES.length;
if (fails.length) {
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`FAIL ${fails.length} of ${checks} checks over ${n} states`);
  process.exit(1);
}
console.log(`PASS ${checks} checks over ${n} states (the pool buy, over one tap, a proof making, a Base chunk and not, Base's chunk button, the vault's buy; the pool and vault sell) at 390 and 1440, dark and light${SHOTS ? `; ${shots} shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
