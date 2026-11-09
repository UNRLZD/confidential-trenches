#!/usr/bin/env node
// The deposit sheet's shots and checks (card app-deposit-sheet; AE-09 and AE-02's screen side, app.md:1343, :1350;
// AS-03, app.md:1369; BAR-05, BAR-10, BAR-11, BAR-12): the fixture page (fixtures.tsx) built with vite and served on
// 127.0.0.1, every S4 state and branch D at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), the page clock fixed by
// Playwright at the fixtures' NOW. Per state: its own state id and no other, app-shell's BAR-10 rules (MEASURE: no text
// under 11 px, no phone tap box under 44 px, no horizontal scroll), the address only in the address states and only
// the checked quote's, no external request. Then: BAR-05 and AS-03, the sheet's box and its action's box equal in S4.3,
// S4.13, S4.15 and S4.16 within 1 px and within 2 px of R5's (app.md:1100); BAR-11, the counter's box constant and no
// layout shift over 120 s of page clock; and the calls: Get address sends deposit.quote with the asset and amount only,
// Withdraw on a held deposit sends withdraw.open with the held id only (no address from the app, W:684), Backup sends
// backup.open with the typed amount in the return view, Copy copies the checked quote's address. Card deposit-to-pool:
// the To row in every form state, the NEAR vault and the three pools in that order, each tile its chain's own mark
// (market/pads.ts logos) loaded; each pool picked draws pool-off with Get address off and asks no quote; the vault
// picked back draws the quote again and Get address sends deposit.quote; Recent's header is whole or not drawn. Card
// deposit-to-pool-pools: the Solana pool, which pool.address answers (Base and Robinhood refuse), draws the form with no
// dry quote and Get address on; its Get address sends pool.address with the chain, asset and amount only (never a vault
// quote), and every pool_deposit stage draws its own state, the done screen (pool-in) only at in_pool with Ready and
// Pending from state.pools; another chain's answer draws no address.
//   node apps/terminal/test/deposit-sheet/run.mjs [--shots <dir>]     PASS exit 0, FAIL exit 1
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

const NOW = Date.parse("2026-11-01T18:00:00Z");
const ADDRESS = "8b0c4e2f61a94d7cb35e0f1a7d29c6e48f5a3b1d07e9c2a64f8d1b5e3a7c9f20";
const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
// R5's boxes, probe P-C (app.md:1100): [x, y, w, h]
const R5 = {
  "390": { sheet: [0, 101.3, 390, 742.7], action: [16, 768, 358, 56] },
  "1440": { sheet: [1110, 0, 330, 900], action: [1123, 849, 305, 39] },
};

// fixture, whether the shot taps Get address first, the state it must show, and the To tile it picks first (none: the vault)
const STATES = [
  ["loading", false, "S4.1"],
  ["quoting", false, "S4.2"],
  ["quote", false, "S4.3"],
  ["below-min", false, "S4.4"],
  ["above-max", false, "S4.5"],
  ["not-available", false, "S4.6"],
  ["busy", false, "S4.7"],
  ["paused", false, "S4.8"],
  ["quote-refused", true, "quote-refused"],
  ["backup-first", false, "S4.19"],
  ["address", true, "S4.13"],
  ["waiting", true, "S4.14"],
  ["processing", true, "S4.15"],
  ["into-vault", true, "S4.15"],
  ["failed", true, "S4.15"],
  ["short", true, "S4.18"],
  ["deposited", true, "S4.16"],
  ["refunded", true, "S4.17"],
  ["refund-move", true, "refund-move"],
  ["refund-done", true, "S4.16"],
  ["held", true, "held"],
  ["moved", true, "moved"],
  ["held-halted", true, "held-halted"],
  ["held-not-caught-up", true, "held-not-caught-up"],
  ["held-vault-blocked", true, "held-vault-blocked"],
  ["expired", true, "S4.20"],
  ["pools-closed", false, "pool-off", "solana"],
  ["quote", false, "pool-off", "base"],
  ["quote", false, "pool-off", "robinhood"],
  // card deposit-to-pool-pools: the Solana pool, which pool.address answers, through its pool_deposit op's stages
  ["pool-quote", false, "S4.3", "solana"],
  ["backup-first", false, "S4.19", "solana"],
  ["pool-refused", true, "S4.6", "solana"],
  ["pool-other-chain", true, "quote-refused", "solana"],
  ["pool-address", true, "S4.13", "solana"],
  ["pool-waiting", true, "S4.14", "solana"],
  ["pool-processing", true, "S4.15", "solana"],
  ["pool-failed", true, "S4.15", "solana"],
  ["pool-short", true, "S4.18", "solana"],
  ["pool-refunded", true, "S4.17", "solana"],
  ["pool-refund-move", true, "refund-move", "solana"],
  ["pool-in", true, "pool-in", "solana"],
  ["pool-in-proving", true, "pool-in", "solana"],
  ["pool-expired", true, "S4.20", "solana"],
];
const DESTS = ["near", "solana", "base", "robinhood"];
const DEST_NAMES = ["NEAR", "Solana", "Base", "Robinhood"];
// the states with the To row: the form's and pool-off
const FORM_STATES = new Set(["S4.1", "S4.2", "S4.3", "S4.4", "S4.5", "S4.6", "S4.7", "S4.8", "quote-refused", "S4.19", "pool-off"]);
const ADDRESS_STATES = new Set(["S4.13", "S4.14", "S4.15", "S4.18"]);

async function build() {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = mkdtempSync(path.join(tmpdir(), "ct-deposit-sheet-"));
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
      const body = readFileSync(file); // read before the headers go: a missing file is a 404, never a second write
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
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
async function open(browser, w, f, { tap = false, clock = "fixed", dest = null } = {}) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  if (clock === "fixed") await page.clock.setFixedTime(NOW);
  else await page.clock.install({ time: NOW });
  const external = [];
  page.on("request", (r) => !r.url().startsWith(BASE) && !r.url().startsWith("data:") && external.push(r.url()));
  await page.goto(`${BASE}/?f=${f}`);
  await page.waitForSelector(".dep[data-state]");
  // the calls from the pick on (the vault, picked first, asks its dry quote for the fixture's amount as the sheet opens)
  if (dest) await page.evaluate(() => (window.__picked = window.__calls.length));
  if (dest) await page.locator(`[data-dest="${dest}"]`).click();
  if (tap) {
    await page.waitForSelector('.dep[data-state="S4.3"]');
    await page.locator('[data-control="deposit-get"]').click();
  }
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, external };
}

const dir = await build();
const server = await serve(dir);
BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser("chromium");
try {
  for (const w of WIDTHS) {
    const boxes = {};
    for (const [f, tap, want, dest = null] of STATES) {
      const tag = `${f}${dest ? ` to ${dest}` : ""} @${w.name}`;
      const { ctx, page, external } = await open(browser, w, f, { tap, dest });
      const shown = await page.locator(`.dep[data-state="${want}"]`).waitFor({ timeout: 5000 }).then(() => true, () => false);
      const got = await page.locator(".dep").getAttribute("data-state");
      check(shown, `${tag}: state ${got}, want ${want}`);
      const m = await page.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
      check(!m.hscroll, `${tag}: horizontal scroll`);
      check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(", ")}`);
      check(m.smallTaps.length === 0, `${tag}: tap under 44 px: ${m.smallTaps.join(", ")}`);
      check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
      check(external.length === 0, `${tag}: external requests ${external.join(" ")}`);
      // the address: only in the address states, and only the checked quote's (W:667, CH-028)
      const addrs = await page.$$eval("[data-address]", (els) => els.map((e) => e.getAttribute("data-address")));
      if (ADDRESS_STATES.has(want)) check(addrs.length === 1 && addrs[0] === ADDRESS, `${tag}: address ${JSON.stringify(addrs)}`);
      else check(addrs.length === 0, `${tag}: an address outside the address states`);
      const body = await page.locator(".dep").innerText();
      if (!ADDRESS_STATES.has(want)) check(!body.replace(/\s/g, "").includes(ADDRESS.slice(0, 8)), `${tag}: address text drawn`);
      // Recent's header whole or not drawn: under the To row the phone's form leaves Recent less room than its header,
      // and a header cut by Recent's own clip box (overflow hidden, so no BAR-10 rule sees it) read "Recent" in half
      const cut = await page.$$eval(".drecent", (els) => els.flatMap((r) => {
        const hd = r.querySelector(".hd");
        if (!hd || !hd.getClientRects().length) return [];
        const a = r.getBoundingClientRect(), b = hd.getBoundingClientRect();
        return b.top < a.bottom - 0.5 && b.bottom > a.bottom + 0.5 ? [`${b.bottom.toFixed(1)} past ${a.bottom.toFixed(1)}`] : [];
      }));
      check(cut.length === 0, `${tag}: Recent's header cut: ${cut.join(", ")}`);
      // BAR-12: the done screen only at the kit's done
      // a pool's done screen (pool-in) only at the kit's in_pool, with what its pool holds ready to buy
      check(["S4.16", "pool-in"].includes(want) === ((await page.locator(".ddone").count()) === 1), `${tag}: done screen ${want}`);
      if (want === "pool-in") {
        const ready = await page.locator("[data-ready]").first().getAttribute("data-ready");
        check(ready === (f === "pool-in" ? "0.4" : "none"), `${tag}: Ready ${ready}`);
        const pend = await page.locator("[data-pending]").first().getAttribute("data-pending").catch(() => null);
        check(pend === (f === "pool-in" ? "0.01" : "0.41"), `${tag}: Pending ${pend}`);
      }
      if (["S4.3", "S4.13", "S4.15", "S4.16", "pool-in"].includes(want) && !boxes[want]) boxes[want] = { sheet: await rect(page, ".dep-box"), action: await rect(page, ".dfoot .dbtn") };
      for (const d of await page.$$eval("[data-draft-copy]", (els) => els.filter((e) => e.getClientRects().length).map((e) => e.getAttribute("data-draft-copy")))) {
        if (!drafts.has(d)) drafts.set(d, new Set());
        drafts.get(d).add(want);
      }
      // the To row: in the form states only, the vault and the three pools in order, each its own chain's mark loaded,
      // the picked tile pressed; a pool picked asks no quote and keeps Get address off
      const tiles = await page.$$eval(".dtiles button", (els) => els.map((e) => ({ dest: e.getAttribute("data-dest"), name: e.querySelector(".nm")?.textContent, on: e.getAttribute("aria-pressed"), img: e.querySelector("img")?.getAttribute("src") ?? "", loaded: (e.querySelector("img")?.naturalWidth ?? 0) > 0 })));
      if (FORM_STATES.has(want)) {
        check(JSON.stringify(tiles.map((t) => t.dest)) === JSON.stringify(DESTS) && JSON.stringify(tiles.map((t) => t.name)) === JSON.stringify(DEST_NAMES), `${tag}: To tiles ${JSON.stringify(tiles.map((t) => [t.dest, t.name]))}`);
        check(tiles.every((t) => t.loaded && new RegExp(`/${t.dest}[-.]`).test(t.img)), `${tag}: To marks ${JSON.stringify(tiles.map((t) => [t.img, t.loaded]))}`);
        check(tiles.filter((t) => t.on === "true").map((t) => t.dest).join() === (dest ?? "near"), `${tag}: To picked ${JSON.stringify(tiles.map((t) => t.on))}`);
      } else check(tiles.length === 0, `${tag}: To row outside the form states`);
      if (dest) {
        // a pool never asks the vault's quotes; its own quote is pool.address for the chain picked, with the asset and
        // amount only; pool-off keeps Get address off; the address states draw the pool's checked quote's address
        const calls = await page.evaluate(() => window.__calls.slice(window.__picked));
        check(!calls.some((c) => c.kind === "deposit.quote" || c.kind === "dry"), `${tag}: a pool picked sent ${JSON.stringify(calls.filter((c) => c.kind === "deposit.quote" || c.kind === "dry"))}`);
        const quoted = calls.filter((c) => c.kind === "pool.address" && c.params.amount !== undefined);
        check(tap ? quoted.length === 1 && JSON.stringify(quoted[0].params) === JSON.stringify({ chain: dest, origin_asset: "nep141:wrap.near", amount: "15" }) : quoted.length === 0, `${tag}: pool.address quotes ${JSON.stringify(quoted)}`);
        if (want === "pool-off") check(await page.locator('[data-control="deposit-get"]').isDisabled(), `${tag}: Get address on for a pool pool.address refuses`);
        if (want === "S4.3") check(await page.locator('[data-control="deposit-get"]').isEnabled(), `${tag}: Get address off for a pool pool.address answers`);
        if (FORM_STATES.has(want)) check(JSON.stringify(tiles.map((t) => t.dest)) === JSON.stringify(DESTS) && (await page.$$eval(".dtiles button", (els) => els.map((e) => e.getAttribute("data-fundable")))).join() === (f === "pools-closed" || f === "backup-first" ? "yes,no,no,no" : "yes,yes,no,no"), `${tag}: fundable tiles`);
        check((await page.locator(".dep").getAttribute("data-dest")) === dest, `${tag}: data-dest`);
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${want}-${f}${dest ? `-${dest}` : ""}-${w.name}.png`) });
      await ctx.close();
    }

    // BAR-05 and AS-03: one sheet box and one action box through the flow, and R5's
    for (const k of ["S4.13", "S4.15", "S4.16", "pool-in"]) {
      check(boxes[k] && near(boxes[k].sheet, boxes["S4.3"].sheet, 1), `@${w.name}: BAR-05 sheet ${k} ${boxes[k]?.sheet} vs S4.3 ${boxes["S4.3"]?.sheet}`);
      check(boxes[k] && near(boxes[k].action, boxes["S4.3"].action, 1), `@${w.name}: BAR-05 action ${k} ${boxes[k]?.action} vs S4.3 ${boxes["S4.3"]?.action}`);
    }
    check(near(boxes["S4.3"].sheet, R5[w.name].sheet, 2), `@${w.name}: AS-03 sheet ${boxes["S4.3"].sheet} vs R5 ${R5[w.name].sheet}`);
    check(near(boxes["S4.3"].action, R5[w.name].action, 2), `@${w.name}: AS-03 action ${boxes["S4.3"].action} vs R5 ${R5[w.name].action}`);
    console.log(`@${w.name} sheet ${boxes["S4.3"].sheet.map((v) => v.toFixed(1))} action ${boxes["S4.3"].action.map((v) => v.toFixed(1))}`);

    // BAR-11: the counter ticks in place over 120 s of page clock
    {
      const { ctx, page } = await open(browser, w, "processing", { tap: true, clock: "run" });
      await page.waitForSelector('.dep[data-state="S4.15"]');
      const b0 = await rect(page, ".dstat");
      const c0 = Number(await page.locator(".dstat").getAttribute("data-counter"));
      const shifts0 = await page.evaluate(() => window.__ct.shifts.reduce((a, b) => a + b, 0));
      await page.clock.runFor(120_000);
      const b1 = await rect(page, ".dstat");
      const c1 = Number(await page.locator(".dstat").getAttribute("data-counter"));
      const shifts1 = await page.evaluate(() => window.__ct.shifts.reduce((a, b) => a + b, 0));
      check(c1 - c0 >= 119 && near(b0, b1, 0.5) && shifts1 === shifts0, `@${w.name}: BAR-11 counter ${c0}->${c1}, box ${b0} -> ${b1}, shift ${shifts1 - shifts0}`);
      await ctx.close();
    }

    // the calls
    {
      const { ctx, page } = await open(browser, w, "address", { tap: true });
      await page.waitForSelector('.dep[data-state="S4.13"]');
      await page.locator('[data-control="deposit-copy"]').click();
      const calls = await page.evaluate(() => window.__calls.filter((c) => c.kind !== "dry"));
      const q = calls.find((c) => c.kind === "deposit.quote");
      check(q && JSON.stringify(Object.keys(q.params).sort()) === '["amount","origin_asset"]' && q.params.amount === "15", `@${w.name}: deposit.quote ${JSON.stringify(q)}`);
      check(calls.some((c) => c.kind === "copy" && c.text === ADDRESS), `@${w.name}: Copy ${JSON.stringify(calls)}`);
      await ctx.close();
    }
    // a pool picked asks nothing more, even a new amount; the vault picked back quotes and gets the address
    {
      const { ctx, page } = await open(browser, w, "quote");
      await page.waitForSelector('.dep[data-state="S4.3"]');
      await page.locator('[data-dest="base"]').click();
      await page.waitForSelector('.dep[data-state="pool-off"]');
      const n0 = (await page.evaluate(() => window.__calls)).length;
      await page.clock.runFor(1_000).catch(() => {});
      await page.locator('[data-control="deposit-get"]').click({ force: true, timeout: 1_000 }).catch(() => {});
      const after = (await page.evaluate(() => window.__calls)).slice(n0);
      check(after.length === 0, `@${w.name}: pool-off asked ${JSON.stringify(after)}`);
      await page.locator('[data-dest="near"]').click();
      await page.waitForSelector('.dep[data-state="S4.3"]', { timeout: 5_000 }).catch(() => {});
      await page.locator('[data-control="deposit-get"]').click({ timeout: 3_000 }).catch(() => {});
      await page.waitForSelector('.dep[data-state="S4.13"]', { timeout: 5_000 }).catch(() => {});
      const q = (await page.evaluate(() => window.__calls)).filter((c) => c.kind === "deposit.quote");
      check(q.length === 1 && q[0].params.amount === "15" && (await page.locator(".dep").getAttribute("data-state")) === "S4.13", `@${w.name}: the vault picked back: ${JSON.stringify(q)}`);
      await ctx.close();
    }
    {
      // card deposit-to-pool-pools: the vault's refused quote stays the vault's; Solana picked after it starts unasked
      const { ctx, page } = await open(browser, w, "quote-refused", { tap: true });
      await page.waitForSelector('.dep[data-state="quote-refused"]', { timeout: 5_000 }).catch(() => {});
      await page.locator('[data-dest="solana"]').click();
      await page.waitForSelector('.dep[data-state="S4.3"]', { timeout: 5_000 }).catch(() => {});
      check((await page.locator(".dep").getAttribute("data-state")) === "S4.3", `@${w.name}: Solana after the vault's refusal draws ${await page.locator(".dep").getAttribute("data-state")}`);
      await ctx.close();
    }
    {
      // card held-move-forgotten-tx: a moved-out deposit draws Moved, no Held mark and no withdraw
      const { ctx, page } = await open(browser, w, "moved", { tap: true });
      check((await page.locator('[data-control="deposit-held-withdraw"]').count()) === 0, `@${w.name} moved: a withdraw drawn`);
      check(!(await page.locator(".dep").innerText()).includes("Held"), `@${w.name} moved: Held drawn`);
      await ctx.close();
    }
    for (const f of ["held", "held-halted", "held-not-caught-up", "held-vault-blocked"]) {
      const { ctx, page } = await open(browser, w, f, { tap: true });
      await page.locator('[data-control="deposit-held-withdraw"]').click();
      const c = (await page.evaluate(() => window.__calls)).find((x) => x.kind === "withdraw.open");
      check(c && JSON.stringify(c.params) === '{"from_id":"u1"}' && c.view.sheet === "deposit", `@${w.name} ${f}: withdraw.open ${JSON.stringify(c)}`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open(browser, w, "backup-first");
      await page.locator('[data-control="deposit-backup"]').click();
      const c = (await page.evaluate(() => window.__calls)).find((x) => x.kind === "backup.open");
      check(c && JSON.stringify(c.params) === "{}" && c.view.fields.amount === "15" && c.view.route === "discover", `@${w.name}: backup.open ${JSON.stringify(c)}`);
      check((await page.locator('[data-control="deposit-get"]').count()) === 0, `@${w.name}: Get address drawn before the backup`);
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
  console.log(`FAIL ${fails.length} checks over ${n} shots, BAR-05, BAR-11 and the calls`);
  process.exit(1);
}
console.log(`PASS ${n} shots (${STATES.length} states x 390/1440), BAR-10 per shot, BAR-05/AS-03, BAR-11 and the calls${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
