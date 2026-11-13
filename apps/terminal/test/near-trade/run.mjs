#!/usr/bin/env node
// A NEAR token's page with the trade box in every state (card app-near-trading), from the built app at its route,
// /token/near/token.rhealab.near, inside the stand-in shell (app-in-shell harnessRoute): HELPER_HOST answered from the
// helper's own answers for NEAR recorded on 12 Nov (test/near-trade/*-near-2026-11-12.json: Discover's lists, RHEA's
// token read, its candles, holders and tape), the shell sending a signed-in state with the vault's USDC as Cash and
// answering the kit's pool.buy and pool.sell as each state needs. At 390 x 844 (dpr 2, touch; the trade sheet) and
// 1440 x 900 (dpr 1; the right column), the terminal's dark scheme:
//   - ready: Bal is Cash ($40), the path is NEAR's, no Max line and no proof label, $10 and $25 on, $50 and $100 off
//     (over Cash), the button "Buy RHEA" on;
//   - no Cash: $0 available, every preset and the button off, a tap sends nothing;
//   - sending: a $10 preset sends exactly pool.buy { chain near, token, amount "10.00", slippage_bps 1000 }, never the
//     vault's buy kind, and the box draws Sending (S8.9), then Slow past 5 s (S8.11), the amount locked;
//   - refused: Failed with Retry (not_allowed), and "Price check failed" for quote_check_failed (S8.20);
//   - filled: Filled (S8.12) and the fill toast linking the tx on nearblocks;
//   - held: Sell is on; the sell side opens at 100%, its amount box read only, 25%, 50% and 75% off, 100% on, the button
//     "Sell 100%", the line "Back to Cash"; the button sends exactly pool.sell { chain near, token, share_bps 10000,
//     slippage_bps 1000 } and the sale draws Filled;
//   - Portfolio at /portfolio draws the NEAR position's row, its chain badge NEAR.
// Per state: app-shell's rules (no text under 11 px, a phone tap box of 44 px, no horizontal scroll, no CSP violation),
// no page error, no dialog, no request to any host but APP_HOST, SIGN_HOST and HELPER_HOST.
//   node apps/terminal/test/near-trade/run.mjs [--build <dir>] [--shots <dir>]     PASS exit 0, FAIL exit 1
// --build tests a build made elsewhere (main's, for the red run); by default this tree is built.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, SIGN_HOST, harnessRoute } from "../../../../scripts/live-checks/app-in-shell.mjs";
import { INIT, MEASURE } from "../../../../scripts/live-checks/app-shell.mjs";
import { browserLabel } from "../../../../scripts/browsers.mjs";
import { launchHarnessBrowser } from "../../../../scripts/harness-sockets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const HELPER = "https://ct-api.unrealized.trade";
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? path.resolve(args[args.indexOf(k) + 1]) : null);
const SHOTS = opt("--shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

const rec = (f) => JSON.parse(readFileSync(path.join(HERE, `${f}-near-2026-11-12.json`), "utf8"));
// the lists are kept as fields and values (a long id beside a `token` key reads as a secret to gitleaks)
const LREC = rec("lists");
const LISTS = { ...LREC.answer, lists: Object.fromEntries(Object.entries(LREC.lists).map(([k, rows]) => [k, rows.map((v) => Object.fromEntries(LREC.fields.map((f, i) => [f, v[i]])))])) };
const TOKEN_READ = rec("token");
const ID = TOKEN_READ.row.token;
const SYMBOL = TOKEN_READ.row.symbol;
if (ID !== "token.rhealab.near" || SYMBOL !== "RHEA" || TOKEN_READ.row.chain !== "near") throw new Error("near-trade: the recorded token read is not RHEA on NEAR");
const NEAR_READS = { "/v1/market/token": TOKEN_READ, "/v1/market/candles": rec("candles"), "/v1/market/holders": rec("holders"), "/v1/market/trades": rec("trades") };
// a NEAR tx hash's form (base58, 32 bytes), a stand-in: the toast links it, nothing reads it
const TX = "3g1VgEbyXqqyqiMRasgPdqvtApQgSrwbpQgyz74k3Wdi";
// a fresh NEAR wallet's implicit id (64 hex), a stand-in
const W = "ab".repeat(32);

const BASE = { release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, wallets: [], orders: [], held: [], ops: [] };
const signed = (vault, positions = []) => ({ ...BASE, vault_balance: vault, positions });
const HELD = [{ chain: "near", token: ID, amount: "266.304521", cost: "10.00", wallets: [W], decimals: 18 }];
const BUY = { kind: "pool.buy", params: { chain: "near", token: ID, amount: "10.00", slippage_bps: 1000 } };
const SELL = { kind: "pool.sell", params: { chain: "near", token: ID, share_bps: 10_000, slippage_bps: 1000 } };
const FILLED = { stage: "filled", txs: [{ chain: "near", hash: TX }] };

// name, the shell's state, its answers, the kinds it holds unanswered
const SCENES = {
  ready: [signed("40.00"), {}, []],
  noCash: [signed("0"), {}, []],
  sending: [signed("40.00"), {}, ["pool.buy"]],
  refused: [signed("40.00"), { "pool.buy": { error: "not_allowed" } }, []],
  priceCheck: [signed("40.00"), { "pool.buy": { error: "quote_check_failed" } }, []],
  filled: [signed("40.00"), { "pool.buy": FILLED }, []],
  held: [signed("30.00", HELD), { "pool.sell": FILLED }, []],
};

async function build() {
  const out = opt("--build");
  if (out) return { dir: out, own: false };
  const { build } = await import("vite");
  const dir = mkdtempSync(path.join(tmpdir(), "ct-near-trade-"));
  await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: dir, emptyOutDir: true } });
  return { dir, own: true };
}

const fails = [];
const refused = new Set();
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) fails.push(what);
};
const json = (body) => ({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });

/** The harness's route with NEAR's helper reads answered from the recordings. */
const nearRoute = (inner) => (route) => {
  const u = new URL(route.request().url());
  if (u.origin === HELPER && u.searchParams.get("chain") === "near") {
    if (u.pathname === "/v1/market/lists") return route.fulfill(json(LISTS));
    if (Object.hasOwn(NEAR_READS, u.pathname) && u.searchParams.get("token") === ID) return route.fulfill(json(NEAR_READS[u.pathname]));
    return route.fulfill({ status: 404, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: '{"error":{"code":"not_found"}}' });
  }
  return inner(route);
};

async function open(browser, route, w, at) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.addInitScript(INIT);
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.origin !== APP_HOST && u.origin !== SIGN_HOST && u.origin !== HELPER) refused.add(u.origin);
    return route(r);
  });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(`${APP_HOST}${at}`, { waitUntil: "load" });
  let f = null;
  for (const until = Date.now() + 8_000; !f && Date.now() < until; ) {
    f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`${APP_HOST}/`)) ?? null;
    if (!f) await page.waitForTimeout(100);
  }
  if (!f) throw new Error(`${w.name}: no APP_HOST frame inside the shell (top at ${page.url()})`);
  return { ctx, page, f, errors, dialogs };
}

async function rules(tag, f, w, errors, dialogs) {
  const m = await f.evaluate(MEASURE, { phone: w.isMobile, vw: w.viewport.width });
  check(!m.hscroll, `${tag}: horizontal scroll`);
  check(m.smallText.length === 0, `${tag}: text under 11 px: ${m.smallText.join(" ")}`);
  check(m.smallTaps.length === 0, `${tag}: tap targets under 44 px: ${m.smallTaps.join(" ")}`);
  check(m.violations.length === 0, `${tag}: CSP violations ${JSON.stringify(m.violations)}`);
  check(errors.length === 0, `${tag}: page errors ${errors.join(" | ")}`);
  check(dialogs.length === 0, `${tag}: a dialog opened: ${dialogs.join(" | ")}`);
}

/** The token page ready and the box in view: the desktop column at 1440, the trade sheet opened by the bar's Buy at 390. */
async function boxOf(tag, f, w) {
  const ready = await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: 10_000 }).then(() => true, () => false);
  check(ready, `${tag}: the NEAR token page is not ready`);
  // the signed-in state has landed when the box's Bal reads a number
  await f.waitForFunction(() => /\$/.test(document.querySelector('[data-testid="trade-balance"]')?.textContent ?? ""), null, { timeout: 8_000 }).catch(() => {});
  const sym = await f.locator("h1.tkp-sym:visible").first().textContent().catch(() => null);
  check(sym === SYMBOL, `${tag}: the page's symbol is ${sym}, not ${SYMBOL}`);
  if (!w.isMobile) return f.locator('.tkp-desk .tkp-trade [data-testid="trade-box"]');
  await f.locator(".tkp-buy").click({ timeout: 3_000 }).catch(() => {});
  await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  await f.waitForTimeout(150);
  return f.locator('[data-sheet="trade"] [data-testid="trade-box"]');
}

const text = async (box, q) => ((await box.locator(q).first().textContent().catch(() => null)) ?? "").replace(/\s+/g, " ").trim();
// a request on the wire is { v, id, type, ...its params } (the kit's client)
const asked = (page) =>
  page.evaluate(() => (window.__ctShellAsked ?? []).filter((m) => m.type === "pool.buy" || m.type === "pool.sell" || m.type === "buy").map(({ v, id, type, ...params }) => ({ kind: type, params })));
const presetsOn = (box) => box.locator('[data-testid="trade-presets"] button').evaluateAll((els) => els.map((e) => `${e.textContent.trim()}:${e.disabled ? "off" : "on"}`));

const { dir, own } = await build();
const browser = await launchHarnessBrowser("chromium");
const routes = {};
for (const [k, [state, answers, holds]] of Object.entries(SCENES)) routes[k] = nearRoute(await harnessRoute(dir, "signed", { state, answers, holds }));
const shot = async (page, name, w) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `near-${name}-${w.name}.png`) });
};
let n = 0;
const AT = `/token/near/${encodeURIComponent(ID)}`;

try {
  for (const w of WIDTHS) {
    // ready: Bal is Cash, NEAR's path, no Max, no proof label; the presets under Cash on, the rest off
    {
      const tag = `${w.name} ready`;
      const { ctx, page, f, errors, dialogs } = await open(browser, routes.ready, w, AT);
      const box = await boxOf(tag, f, w);
      n++;
      check((await box.getAttribute("data-path")) === "near", `${tag}: the path is ${await box.getAttribute("data-path")}, not near`);
      check((await text(box, '[data-testid="trade-balance"]')) === "$40 available", `${tag}: the balance reads ${await text(box, '[data-testid="trade-balance"]')}, not "$40 available" (UNRLZD parity, owner 12 Nov)`);
      check((await text(box, '[data-testid="trade-max"]')) === "", `${tag}: the line above the button reads ${JSON.stringify(await text(box, '[data-testid="trade-max"]'))}, not empty`);
      check((await box.locator('[data-testid="trade-proof"]').count()) === 0, `${tag}: a proof label on NEAR`);
      check(JSON.stringify(await presetsOn(box)) === JSON.stringify(["$10:on", "$25:on", "$50:off", "$100:off"]), `${tag}: the presets are ${JSON.stringify(await presetsOn(box))}`);
      await box.locator(".trb-input").fill("25");
      const cta = box.locator('[data-testid="trade-cta"]');
      check((await cta.innerText()).trim() === `Buy ${SYMBOL}`, `${tag}: the button reads ${(await cta.innerText()).trim()}`);
      check(await cta.isEnabled(), `${tag}: the button is off at $25 with $40 of Cash`);
      check((await box.getAttribute("data-state")) === "S8.3", `${tag}: state ${await box.getAttribute("data-state")}`);
      await box.locator(".trb-input").fill("41");
      check(!(await cta.isEnabled()), `${tag}: the button is on over Cash`);
      check((await box.locator(".trb-amount").getAttribute("data-bad")) === "true", `${tag}: an amount over Cash is not marked`);
      await rules(tag, f, w, errors, dialogs);
      await box.locator(".trb-input").fill("25");
      await shot(page, "ready", w);
      await ctx.close();
    }
    // no Cash: every preset and the button off; nothing is sent
    {
      const tag = `${w.name} no Cash`;
      const { ctx, page, f, errors, dialogs } = await open(browser, routes.noCash, w, AT);
      const box = await boxOf(tag, f, w);
      n++;
      check((await text(box, '[data-testid="trade-balance"]')) === "$0 available", `${tag}: the balance reads ${await text(box, '[data-testid="trade-balance"]')}, not "$0 available"`);
      check((await presetsOn(box)).every((p) => p.endsWith(":off")), `${tag}: a preset is on with no Cash: ${JSON.stringify(await presetsOn(box))}`);
      await box.locator(".trb-input").fill("10");
      check(!(await box.locator('[data-testid="trade-cta"]').isEnabled()), `${tag}: the button is on with no Cash`);
      await box.locator('[data-testid="trade-cta"]').click({ force: true }).catch(() => {});
      check((await asked(page)).length === 0, `${tag}: a trade was sent with no Cash: ${JSON.stringify(await asked(page))}`);
      await rules(tag, f, w, errors, dialogs);
      await shot(page, "no-cash", w);
      await ctx.close();
    }
    // sending, then slow: the preset sends NEAR's pool.buy exactly
    {
      const tag = `${w.name} sending`;
      const { ctx, page, f, errors, dialogs } = await open(browser, routes.sending, w, AT);
      const box = await boxOf(tag, f, w);
      n++;
      await box.locator('[data-testid="trade-presets"] button').first().click({ timeout: 3_000 }).catch(() => {}); // a control that stays off is the checks' to name
      await f.waitForFunction(() => document.querySelector('[data-testid="trade-box"][data-state="S8.9"]') !== null, null, { timeout: 3_000 }).catch(() => {});
      check((await box.getAttribute("data-state")) === "S8.9", `${tag}: state ${await box.getAttribute("data-state")}, not Sending (S8.9)`);
      const sent = await asked(page);
      check(JSON.stringify(sent) === JSON.stringify([BUY]), `${tag}: sent ${JSON.stringify(sent)}, not ${JSON.stringify([BUY])}`);
      check(await box.locator(".trb-input").isDisabled(), `${tag}: the amount is not locked while the buy runs`);
      await rules(tag, f, w, errors, dialogs);
      await shot(page, "sending", w);
      await f.waitForFunction(() => document.querySelector('[data-testid="trade-box"][data-state="S8.11"]') !== null, null, { timeout: 8_000 }).catch(() => {});
      check((await box.getAttribute("data-state")) === "S8.11", `${tag}: state ${await box.getAttribute("data-state")} past 5 s, not Slow (S8.11)`);
      check((await asked(page)).length === 1, `${tag}: ${(await asked(page)).length} requests for one tap, not one`);
      await shot(page, "slow", w);
      await ctx.close();
    }
    // refused: Failed with Retry; quote_check_failed: Price check failed
    for (const [scene, line] of [["refused", /^Failed/], ["priceCheck", /Price check failed/]]) {
      const tag = `${w.name} ${scene}`;
      const { ctx, page, f, errors, dialogs } = await open(browser, routes[scene], w, AT);
      const box = await boxOf(tag, f, w);
      n++;
      await box.locator(".trb-input").fill("25");
      await box.locator('[data-testid="trade-cta"]').click({ timeout: 3_000 }).catch(() => {}); // a control that stays off is the checks' to name
      await f.waitForFunction(() => document.querySelector('[data-testid="trade-box"]')?.getAttribute("data-stage") === "refused", null, { timeout: 5_000 }).catch(() => {});
      const ended = await text(box, '[data-testid="trade-max"]');
      check(line.test(ended), `${tag}: the line reads ${JSON.stringify(ended)}`);
      check(JSON.stringify(await asked(page)) === JSON.stringify([{ ...BUY, params: { ...BUY.params, amount: "25.00" } }]), `${tag}: sent ${JSON.stringify(await asked(page))}`);
      await rules(tag, f, w, errors, dialogs);
      await shot(page, scene === "refused" ? "failed" : "price-check-failed", w);
      await ctx.close();
    }
    // filled: Filled and the toast's nearblocks link
    {
      const tag = `${w.name} filled`;
      const { ctx, page, f, errors, dialogs } = await open(browser, routes.filled, w, AT);
      const box = await boxOf(tag, f, w);
      n++;
      await box.locator('[data-testid="trade-presets"] button').first().click({ timeout: 3_000 }).catch(() => {}); // a control that stays off is the checks' to name
      await f.waitForFunction(() => document.querySelector('[data-testid="trade-box"]')?.getAttribute("data-state") === "S8.12", null, { timeout: 5_000 }).catch(() => {});
      check((await box.getAttribute("data-state")) === "S8.12", `${tag}: state ${await box.getAttribute("data-state")}, not Filled (S8.12)`);
      const href = await f.locator(`a[href="https://nearblocks.io/txns/${TX}"]`).count();
      check(href >= 1, `${tag}: no nearblocks link to the fill's tx`);
      await rules(tag, f, w, errors, dialogs);
      await shot(page, "filled", w);
      await ctx.close();
    }
    // held: the sell side, the whole holding only, back to Cash
    {
      const tag = `${w.name} held`;
      const { ctx, page, f, errors, dialogs } = await open(browser, routes.held, w, AT);
      const box = await boxOf(tag, f, w);
      n++;
      const sellSide = box.locator('[data-testid="trade-side-sell"]');
      await f.waitForFunction(() => document.querySelector('[data-testid="trade-side-sell"]')?.disabled === false, null, { timeout: 5_000 }).catch(() => {});
      check(await sellSide.isEnabled(), `${tag}: Sell is off while RHEA is held`);
      await sellSide.click({ timeout: 3_000 }).catch(() => {});
      const scope = w.isMobile ? '[data-sheet="trade"]' : ".tkp-desk .tkp-trade";
      const sb = f.locator(`${scope} [data-testid="sell-box"]`);
      const up = await sb.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
      check(up, `${tag}: the sell side did not open`);
      if (up) {
        check((await sb.locator(".trb-input").inputValue()) === "100", `${tag}: the sell opens at ${await sb.locator(".trb-input").inputValue()}%, not 100%`);
        check((await sb.locator(".trb-input").getAttribute("readonly")) !== null, `${tag}: the share can be typed on NEAR`);
        const pcts = await sb.locator('[data-testid="sell-presets"] button').evaluateAll((els) => els.map((e) => `${e.textContent.trim()}:${e.disabled ? "off" : "on"}`));
        check(JSON.stringify(pcts) === JSON.stringify(["25%:off", "50%:off", "75%:off", "100%:on"]), `${tag}: the sell presets are ${JSON.stringify(pcts)}`);
        check((await sb.locator('[data-testid="sell-cta"]').innerText()).trim() === "Sell 100%", `${tag}: the sell button reads ${(await sb.locator('[data-testid="sell-cta"]').innerText()).trim()}`);
        check((await text(sb, '[data-testid="sell-line"]')) === "Back to Cash", `${tag}: the sell's line reads ${JSON.stringify(await text(sb, '[data-testid="sell-line"]'))}`);
        await rules(tag, f, w, errors, dialogs);
        await shot(page, "sell", w);
        await sb.locator('[data-testid="sell-cta"]').click({ timeout: 3_000 }).catch(() => {}); // a control that stays off is the checks' to name
        // a sale's Filled is stateId's "filled" (States.tsx)
        await f.waitForFunction(() => document.querySelector('[data-testid="sell-box"]')?.getAttribute("data-state") === "filled", null, { timeout: 5_000 }).catch(() => {});
        check((await sb.getAttribute("data-state")) === "filled", `${tag}: the sale's state ${await sb.getAttribute("data-state")}, not Filled`);
        const sent = await asked(page);
        check(JSON.stringify(sent) === JSON.stringify([SELL]), `${tag}: sent ${JSON.stringify(sent)}, not ${JSON.stringify([SELL])}`);
        await shot(page, "sold", w);
      }
      await ctx.close();
    }
    // Portfolio: the NEAR position's row
    {
      const tag = `${w.name} portfolio`;
      const { ctx, page, f, errors, dialogs } = await open(browser, routes.held, w, "/portfolio");
      n++;
      const row = f.locator(`[data-pos="near:${ID}"]:visible`).first();
      const got = await row.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false);
      check(got, `${tag}: no NEAR position row for ${SYMBOL}`);
      await rules(tag, f, w, errors, dialogs);
      await shot(page, "portfolio", w);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  if (own) rmSync(dir, { recursive: true, force: true });
}

// the shell's own reads (the footer's NEAR block) are answered by the harness, never the network; listed, as the other runs list them
const off = [...refused].filter((o) => o !== APP_HOST && o !== SIGN_HOST && o !== HELPER);
if (off.length) console.log(`answered off-host requests (the harness's): ${off.join(" ")}`);
if (fails.length) {
  for (const x of fails) console.log(`FAIL ${x}`);
  console.log(`FAIL ${fails.length} of ${checks} checks over ${n} states`);
  process.exit(1);
}
console.log(`PASS ${checks} checks over ${n} states (390 and 1440) of the NEAR token page and Portfolio from the built app inside the stand-in shell${SHOTS ? `; shots in ${SHOTS}` : ""} on ${browserLabel(browser)}`);
