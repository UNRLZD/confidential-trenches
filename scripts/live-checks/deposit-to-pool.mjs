#!/usr/bin/env node
// Live check of card deposit-to-pool (v2 A3) and card deposit-to-pool-pools: the deposit sheet's To row names where the
// money goes, the NEAR vault (the cash home) and the Solana, Base and Robinhood pools, and the sheet puts money only where
// the kit can land it. The vault takes deposit.quote; a pool takes money once the signing page's pool.address answers its
// chain (kit-v1.7: the pool's one-time address with no asset, the checked quote to it with the asset and amount, then the
// pool_deposit op's stages under that request's id). The stand-in answers Solana's pool.address and refuses Base's and
// Robinhood's, standing for a page whose network pins only Solana's pool (no EVM follow yet, card pool-deposit-follow-evm),
// so Solana must take a deposit through every pool stage and Base and Robinhood must ask nothing and show no address.
// Its Solana quote is for NEAR, which the real page does not price into a pool (it prices USDC): a stand-in for the
// sheet's draw, not the page's pricing; moving it to USDC on Base waits for a recording (review P3, heavy queue held). APP_HOST's terminal is framed by the
// stand-in shell of app-deposit-mount.mjs (routeFor: one signed-in account, backup saved, nothing in the vault, the
// deposit reads answered as the real page answers them after its 1Click reads), which posts the deposit's stages under
// the quote's request id as the real page does; no check can sign a real account in or send a real deposit. Headless
// Chromium opens /portfolio at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1), dark and light, and
// reads, in each:
//   - Portfolio's total before ($0.00); the header's Deposit opens the one deposit sheet;
//   - the To row: NEAR, Solana, Base, Robinhood in that order, each tile its chain's own mark (the terminal's
//     market/pads.ts logo for that chain, loaded), the NEAR vault picked, the vault and Solana drawn fundable;
//   - Base and Robinhood picked: the sheet draws pool-off, Get address is off, and nothing is asked (no deposit.dry, no
//     deposit.quote, no pool.address);
//   - the NEAR vault picked back: typing 15 sends one deposit.dry, Get address sends deposit.quote with the asset and 15
//     only, and the quote's own address draws (S4.13);
//   - every stage the kit's follower sends draws its own state, posted in turn on that one deposit: waiting, in transit,
//     into the vault, failed, short, refunded, the refund move, held, halted, expired, then done. This is a draw check of
//     each stage, not a real deposit's path. Deposited (S4.16) only at done, and the header's balance moves only with
//     the done state, whose vault_balance the stand-in sets to the credited 73.18 as the real page does once the note
//     reads on two RPCs;
//   - Done closes the sheet, and Portfolio's total reads $73.18;
//   - the sheet opened again, Solana picked: the form with Get address on, no deposit.dry; typing 15 and Get address
//     sends pool.address with Solana, the asset and 15 only, and the pool quote's own address draws (S4.13); every pool
//     stage draws its own state, posted in turn on that one pool_deposit op (waiting, in transit, failed, short,
//     refunded, the refund move, expired, then in the pool); Ready only at in_pool, with what state.pools holds ready
//     for Solana, which the stand-in sets in that same state as the real page does once the notes read on two RPCs;
//   - Done closes the sheet, and Portfolio's Solana row reads that balance and ready (absent before).
// A screenshot of the To row, a pool picked, the addresses and the deposited states is kept per width and scheme.
// After: app
//   node scripts/live-checks/deposit-to-pool.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served), framed by the stand-in shell
//   node scripts/live-checks/deposit-to-pool.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { ADDRESS, AMOUNT, APP_HOST, CREDITED, NEAR, routeFor, SCHEMES, WIDTHS } from "./app-deposit-mount.mjs";
import { SIGN_HOST } from "./app-in-shell.mjs";

const KEY = "deposit-to-pool";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const READY_MS = 15_000;
/** The To row as the kit names its places: the vault's chain, then POOL_CHAINS; only the vault is fundable today. */
export const DESTS = ["near", "solana", "base", "robinhood"];
export const DEST_NAMES = ["NEAR", "Solana", "Base", "Robinhood"];
export const FUNDABLE = ["yes", "yes", "no", "no"];
/** The pools pool.address refuses (Not available) and the one it answers. */
export const CLOSED = ["base", "robinhood"];
export const OPEN = "solana";
/** The stand-in's pool.address answers (kit messages.ts PoolAddress): Solana's U_X, base58 of 32 bytes, its pool's
 *  asset, and the checked quote to it (min out in SOL); Base and Robinhood refused not_allowed. */
export const U_SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const POOL_ANSWERS = { solana: { address: U_SOL, asset: "SOL", quote: { deposit_address: ADDRESS, origin_asset: NEAR.origin_asset, amount_in: AMOUNT, min_amount_out: "0.4", time_estimate_s: 37 } } };
/** state.pools once the notes read on two RPCs: 0.41 SOL, 0.4 of it ready to buy (base units as Portfolio's row keeps them). */
export const SOL_POOL = { chain: "solana", asset: "SOL", balance: "0.41", ready: "0.4" };
export const SOL_ROW = { balance: "410000000", ready: "400000000" };
/** The pool stages posted in turn (since_ms 12 s back on each stage the kit allows it), and the state each draws. */
export const POOL_STAGES = [
  [{ stage: "waiting" }, "S4.14"],
  [{ stage: "in_transit" }, "S4.15"],
  [{ stage: "failed" }, "S4.15"],
  [{ stage: "short" }, "S4.18"],
  [{ stage: "refunded" }, "S4.17"],
  [{ stage: "refund_move", refunded: true }, "refund-move"],
  [{ stage: "expired" }, "S4.20"],
  [{ stage: "in_pool" }, "pool-in"],
];
/** The stages posted in turn (each with since_ms 12 s back, the facts the kit allows on each), and the state each draws. */
export const STAGES = [
  [{ stage: "waiting" }, "S4.14"],
  [{ stage: "in_transit" }, "S4.15"],
  [{ stage: "into_vault" }, "S4.15"],
  [{ stage: "failed" }, "S4.15"],
  [{ stage: "short" }, "S4.18"],
  // `refunded: true` belongs to the legs after the refund (messages.ts DEPOSIT_REFUNDED_STAGES), never to "refunded"
  // itself: the kit's client drops an op that carries it there
  [{ stage: "refunded", held_id: "u1" }, "S4.17"],
  [{ stage: "refund_move", refunded: true, held_id: "u1" }, "refund-move"],
  [{ stage: "held", held_id: "u1" }, "held"],
  [{ stage: "halted", hold: "halted", held_id: "u1" }, "held-halted"],
  [{ stage: "expired" }, "S4.20"],
  [{ stage: "done", amount_usd: CREDITED }, "S4.16"],
];
const USD_CREDITED = `$${CREDITED}`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => SCHEMES.map((s) => `${w.name} ${s}`));
  const have = new Set(runs.map((r) => `${r.width} ${r.scheme}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (every width, dark and light)`);
  for (const r of runs) {
    const n = `${r.width} ${r.scheme}`;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    say(r.totalBefore === "$0.00", `${n}: Portfolio's total before reads ${r.totalBefore ?? "nothing"}, want $0.00`);
    say(r.opened === 1, `${n}: the header's Deposit ${r.opened === 1 ? "opens the deposit sheet" : r.opened ? `opens ${r.opened} deposit sheets` : "opens nothing"}`);
    if (r.opened !== 1) continue;
    const t = r.tiles ?? [];
    say(same(t.map((x) => x.dest), DESTS) && same(t.map((x) => x.name), DEST_NAMES), `${n}: the To row reads ${JSON.stringify(t.map((x) => x.name ?? x.dest))}, want ${JSON.stringify(DEST_NAMES)}`);
    const marks = t.filter((x) => !(x.loaded === true && typeof x.img === "string" && new RegExp(`/${x.dest}[-.][^/]*\\.(svg|png)$`).test(x.img)));
    say(t.length === DESTS.length && marks.length === 0, `${n}: ${t.length === 0 ? "no tile draws a mark" : marks.length ? `the tile(s) ${marks.map((x) => `${x.dest} (${x.img || "no mark"}${x.loaded ? "" : ", not loaded"})`).join(", ")} draw another chain's mark or none` : "each tile draws its own chain's mark"}`);
    say(same(t.map((x) => x.on), ["true", "false", "false", "false"]), `${n}: the To row opens on ${t.filter((x) => x.on === "true").map((x) => x.dest).join(", ") || "nothing"}, want the NEAR vault`);
    say(same(t.map((x) => x.fundable), FUNDABLE), `${n}: fundable tiles ${JSON.stringify(t.map((x) => x.fundable))}, want the vault and ${OPEN} (the pools pool.address answers)`);
    for (const p of CLOSED) {
      const x = r.pools?.[p] ?? {};
      say(x.state === "pool-off" && x.getOff === true && x.pressed === p, `${n}: ${p} picked draws ${x.state ?? "nothing"}, Get address ${x.getOff === true ? "off" : x.getOff === false ? "ON" : "unread"}, pressed ${x.pressed ?? "none"}`);
      say(Array.isArray(x.asked) && x.asked.length === 0, `${n}: ${p} picked asks ${Array.isArray(x.asked) ? (x.asked.length ? x.asked.join(", ") : "nothing") : "unread"}`);
    }
    const dry = r.dry ?? [];
    say(dry.length === 1 && same(dry[0], { origin_asset: NEAR.origin_asset, amount: AMOUNT }), `${n}: the vault picked back, typing ${AMOUNT} sends ${dry.length} deposit.dry ${JSON.stringify(dry)}, want one with ${NEAR.origin_asset} and ${AMOUNT} only`);
    say(r.quoteState === "S4.3", `${n}: the vault's quote draws ${r.quoteState ?? "no state"}`);
    say(same(r.quote, { origin_asset: NEAR.origin_asset, amount: AMOUNT }), `${n}: Get address sends deposit.quote ${r.quote ? JSON.stringify(r.quote) : "nothing"}${r.tapError ? ` (the tap: ${r.tapError})` : ""}`);
    say(r.addressState === "S4.13" && r.address === ADDRESS, `${n}: the address state ${r.addressState ?? "none"} draws ${r.address === ADDRESS ? "the quote's own address" : (r.address ?? "no address")}`);
    const ws = STAGES.map(([, s]) => s);
    say(same(r.stages, ws), `${n}: the follower's stages draw ${JSON.stringify(r.stages ?? [])}, want ${JSON.stringify(ws)}`);
    const early = (r.balances ?? []).slice(0, -1).filter((b) => b !== "$0.00");
    say(r.balances?.length === STAGES.length && early.length === 0 && r.balances.at(-1) === USD_CREDITED, `${n}: the sheet's balance per stage ${JSON.stringify(r.balances ?? [])}, want $0.00 until done, then ${USD_CREDITED}`);
    say(r.credited === CREDITED, `${n}: Deposited draws ${r.credited ?? "no amount"}, credited ${CREDITED}`);
    say(r.closed === true, `${n}: Done ${r.closed ? "closes the sheet" : "leaves the sheet open"}`);
    say(r.totalAfter === USD_CREDITED, `${n}: Portfolio's total after reads ${r.totalAfter ?? "nothing"}, want ${USD_CREDITED}`);
    // card deposit-to-pool-pools: Solana's pool through its stages
    const o = r.open ?? {};
    say(o.opened === 1, `${n}: the sheet ${o.opened === 1 ? "opens again" : "does not open again"}`);
    say(o.state === "S4.3" && o.getOn === true && o.pressed === OPEN, `${n}: ${OPEN} picked draws ${o.state ?? "nothing"}, Get address ${o.getOn === true ? "on" : o.getOn === false ? "OFF" : "unread"}, pressed ${o.pressed ?? "none"}`);
    const wantAsk = { chain: OPEN, origin_asset: NEAR.origin_asset, amount: AMOUNT };
    say(same(o.asked, [wantAsk]), `${n}: ${OPEN}'s Get address sends ${JSON.stringify(o.asked ?? null)}, want one pool.address ${JSON.stringify(wantAsk)} and no vault quote`);
    say(o.addressState === "S4.13" && o.address === ADDRESS, `${n}: ${OPEN}'s address state ${o.addressState ?? "none"} draws ${o.address === ADDRESS ? "the pool quote's own address" : (o.address ?? "no address")}`);
    const ps = POOL_STAGES.map(([, s]) => s);
    say(same(o.stages, ps), `${n}: ${OPEN}'s pool stages draw ${JSON.stringify(o.stages ?? [])}, want ${JSON.stringify(ps)}`);
    const readies = o.readies ?? [];
    say(readies.length === POOL_STAGES.length && readies.slice(0, -1).every((x) => x === null) && readies.at(-1) === SOL_POOL.ready, `${n}: Ready per pool stage ${JSON.stringify(readies)}, want none until in_pool, then ${SOL_POOL.ready}`);
    say(o.rowBefore === null, `${n}: Portfolio's ${OPEN} row before ${o.rowBefore === null ? "absent" : JSON.stringify(o.rowBefore)}`);
    say(o.closed === true, `${n}: ${OPEN}'s Done ${o.closed ? "closes the sheet" : "leaves the sheet open"}`);
    say(same(o.rowAfter, SOL_ROW), `${n}: Portfolio's ${OPEN} row after reads ${JSON.stringify(o.rowAfter ?? null)}, want ${JSON.stringify(SOL_ROW)}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function terminal(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

const asked = (page) => page.evaluate(() => window.__ctShellAsked ?? []);
const fieldsOf = ({ v: _v, id: _id, type: _t, ...fields }) => fields;
const SHEET = "[data-sheet='deposit']";
const sheetState = (f) => f.locator(SHEET).first().getAttribute("data-state", { timeout: 2_000 }).catch(() => null);
const waitState = (f, s) => f.waitForSelector(`${SHEET}[data-state='${s}']`, { timeout: 5_000 }).catch(() => null);
const total = (f) => f.locator(".tot").filter({ visible: true }).first().textContent({ timeout: 5_000 }).then((t) => t?.trim() ?? null, () => null);
const why = (e) => String(e?.message ?? e).split("\n")[0];

/** A press as each width makes it: a finger's tap at the element's centre on the phone (app-deposit-mount.mjs: Playwright's
 *  click refused the phone tap at dpr 2 on Linux Chrome), a click on the desktop. Null, or why it did not go. */
async function press(page, loc, touch) {
  const l = loc.filter({ visible: true }).first();
  if (!touch) return l.click({ timeout: 3_000 }).then(() => null, why);
  const b = await l.boundingBox({ timeout: 3_000 }).catch(() => null);
  return b ? page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2).then(() => null, why) : "no box";
}

/** Portfolio's pool row for `chain` (portfolio/Portfolio.tsx PoolRows: base units), or null when none is drawn. */
const poolRow = (f, chain) =>
  f.locator(`[data-pool='${chain}']`).filter({ visible: true }).first().evaluate((e) => ({ balance: e.getAttribute("data-balance"), ready: e.getAttribute("data-ready") }), null, { timeout: 1_000 }).catch(() => null);

/**
 * pool.address in the stand-in shell (app-in-shell.mjs answers only the kinds it is given, the same answer for any
 * params): run in SIGN_HOST's top page before its shell, it answers each pool.address from the app's frame as the real
 * page does, per chain (POOL_ANSWERS; a chain not named refused not_allowed), keeps the request in __ctShellAsked as the
 * shell keeps every request, and stops the shell's own answer. __ctPoolPush(facts, pools) posts a state event with that
 * request's one pool_deposit op, and state.pools when given, as the real page posts a pool deposit's stages.
 */
function poolShell({ app, sign, answers }) {
  if (location.origin !== sign) return;
  let req = null;
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.origin !== app || !d || d.type !== "pool.address" || typeof d.id !== "string") return;
    e.stopImmediatePropagation();
    (window.__ctShellSeen ??= []).push(d.type);
    (window.__ctShellAsked ??= []).push(d);
    const a = Object.hasOwn(answers, d.chain) ? answers[d.chain] : null;
    let msg = { v: 1, id: d.id, ok: false, error: { code: "not_allowed" } };
    if (a && d.amount === undefined) msg = { v: 1, id: d.id, ok: true, result: { chain: d.chain, address: a.address, asset: a.asset } };
    else if (a) {
      req = { id: d.id, chain: d.chain };
      msg = { v: 1, id: d.id, ok: true, result: { chain: d.chain, address: a.address, asset: a.asset, quote: { ...a.quote, deadline: new Date(Date.now() + 72 * 3600000).toISOString() } } };
    }
    e.source.postMessage(msg, app);
  }, true);
  window.__ctPoolPush = (facts, pools) => {
    // the shell's STATE: a top-level binding of its classic script
    // eslint-disable-next-line no-undef
    const st = STATE;
    st.ops = [{ id: req?.id, kind: "pool_deposit", chain: req?.chain, txs: [], ...facts }];
    if (pools) st.pools = pools;
    document.querySelector("iframe").contentWindow.postMessage({ v: 1, type: "state", state: st }, app);
  };
}

async function runOne(browser, w, scheme, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  const run = { width: w.name, scheme, framed: false, opened: 0 };
  const shot = (page, name) => page.screenshot({ path: path.join(shots, `${w.name}-${scheme}-${name}.png`) });
  try {
    await ctx.route("**/*", route);
    await ctx.addInitScript(poolShell, { app: APP_HOST, sign: SIGN_HOST, answers: POOL_ANSWERS });
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/portfolio`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector(".tb [data-action='deposit']:not([disabled]), .phh [data-action='deposit']:not([disabled])", { timeout: READY_MS }).catch(() => {});
    run.totalBefore = await total(f);
    await f.locator("[data-action='deposit']").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
    await f.waitForSelector(SHEET, { timeout: 3_000 }).catch(() => {});
    run.opened = await f.locator(SHEET).filter({ visible: true }).count();
    if (run.opened !== 1) return run;

    // the To row, once the assets answered (the amount field on)
    await f.waitForSelector(`${SHEET} [data-field='amount']:not([disabled])`, { timeout: 5_000 }).catch(() => {});
    await f.waitForFunction(() => [...document.querySelectorAll(".dtiles img")].every((i) => i.complete), null, { timeout: 5_000 }).catch(() => {});
    // the pools' pool.address answers, asked as the sheet opens (no asset: nothing quoted)
    await f.waitForSelector(`${SHEET} .dtiles [data-dest='${OPEN}'][data-fundable='yes']`, { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    run.tiles = await f.$$eval(`${SHEET} .dtiles button`, (els) => els.map((e) => { const i = e.querySelector("img"); return { dest: e.getAttribute("data-dest"), name: e.querySelector(".nm")?.textContent ?? null, on: e.getAttribute("aria-pressed"), fundable: e.getAttribute("data-fundable"), img: i ? new URL(i.getAttribute("src") ?? "", location.href).pathname : null, loaded: !!i && i.complete && i.naturalWidth > 0 }; })).catch(() => []);
    await shot(page, "to-row");

    // each pool pool.address refuses, picked: pool-off, Get address off, nothing asked
    run.pools = {};
    for (const p of CLOSED) {
      const n0 = (await asked(page)).length;
      const err = await press(page, f.locator(`${SHEET} .dtiles [data-dest='${p}']`), w.hasTouch);
      await waitState(f, "pool-off");
      await page.waitForTimeout(500); // past the dry quote's 300 ms pause: anything the pick would ask is asked by now
      const get = f.locator(`${SHEET} [data-control='deposit-get']`).first();
      run.pools[p] = {
        state: await sheetState(f),
        getOff: await get.isDisabled({ timeout: 1_000 }).catch(() => null),
        pressed: await f.locator(`${SHEET} .dtiles [aria-pressed='true']`).first().getAttribute("data-dest", { timeout: 1_000 }).catch(() => null),
        asked: (await asked(page)).slice(n0).map((m) => m.type).filter((t) => t !== "state"),
        ...(err ? { error: err } : {}),
      };
      if (p === CLOSED[0]) await shot(page, "pool-off");
    }

    // the vault picked back: the dry quote, Get address, the address
    run.tapError = await press(page, f.locator(`${SHEET} .dtiles [data-dest='near']`), w.hasTouch);
    await f.waitForSelector(`${SHEET}[data-dest='near'] [data-field='amount']:not([disabled])`, { timeout: 5_000 }).catch(() => {});
    await f.locator("[data-field='amount']").filter({ visible: true }).first().pressSequentially(AMOUNT, { delay: 60, timeout: 3_000 }).catch(() => {});
    await f.waitForSelector(`${SHEET}[data-state='S4.3'] .dget .v .num`, { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(600);
    run.dry = (await asked(page)).filter((m) => m.type === "deposit.dry").map(fieldsOf);
    run.quoteState = await sheetState(f);
    run.tapError = (await press(page, f.locator(`${SHEET} [data-control='deposit-get']`), w.hasTouch)) ?? run.tapError;
    await waitState(f, "S4.13");
    run.quote = (await asked(page)).filter((m) => m.type === "deposit.quote").map(fieldsOf)[0] ?? null;
    run.addressState = await sheetState(f);
    run.address = await f.locator(`${SHEET} [data-address]`).first().getAttribute("data-address", { timeout: 1_000 }).catch(() => null);
    await shot(page, "address");

    // the follower's stages, in turn; done carries the vault's new balance in the same state, as the real page sends it
    run.stages = [];
    run.balances = [];
    for (const [facts, want] of STAGES) {
      await page.evaluate(({ x, credited }) => {
        // the stand-in shell's STATE (app-in-shell.mjs shellJs): a top-level binding of its classic script
        // eslint-disable-next-line no-undef
        if (x.stage === "done") STATE.vault_balance = credited;
        window.__ctShellPush({ ...x, ...(x.stage === "expired" ? {} : { since_ms: Date.now() - 12_000 }) });
      }, { x: facts, credited: CREDITED });
      await waitState(f, want);
      run.stages.push(await sheetState(f));
      run.balances.push(await f.locator(`${SHEET} .dhd .bal`).first().textContent({ timeout: 1_000 }).then((t) => t?.trim() ?? null, () => null));
    }
    run.credited = await f.locator(`${SHEET} [data-amount]`).first().getAttribute("data-amount", { timeout: 1_000 }).catch(() => null);
    await shot(page, "deposited");
    await f.locator("[data-control='deposit-done']").filter({ visible: true }).first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
    run.closed = (await f.locator(SHEET).count()) === 0;
    run.totalAfter = await total(f);
    await shot(page, "portfolio-after");

    // the sheet again, Solana's pool: the form, Get address, the pool quote's address, the pool stages, Ready, Portfolio
    const o = (run.open = {});
    o.rowBefore = await poolRow(f, OPEN);
    await f.locator("[data-action='deposit']").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
    await f.waitForSelector(SHEET, { timeout: 3_000 }).catch(() => {});
    o.opened = await f.locator(SHEET).filter({ visible: true }).count();
    if (o.opened !== 1) return run;
    await f.waitForSelector(`${SHEET} .dtiles [data-dest='${OPEN}'][data-fundable='yes']`, { timeout: 5_000 }).catch(() => {});
    const n0 = (await asked(page)).length;
    o.tapError = await press(page, f.locator(`${SHEET} .dtiles [data-dest='${OPEN}']`), w.hasTouch);
    await f.waitForSelector(`${SHEET}[data-dest='${OPEN}'] [data-field='amount']:not([disabled])`, { timeout: 5_000 }).catch(() => {});
    await f.locator("[data-field='amount']").filter({ visible: true }).first().pressSequentially(AMOUNT, { delay: 60, timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(600);
    o.state = await sheetState(f);
    o.pressed = await f.locator(`${SHEET} .dtiles [aria-pressed='true']`).first().getAttribute("data-dest", { timeout: 1_000 }).catch(() => null);
    o.getOn = await f.locator(`${SHEET} [data-control='deposit-get']`).first().isEnabled({ timeout: 1_000 }).catch(() => null);
    await shot(page, "pool-form");
    o.tapError = (await press(page, f.locator(`${SHEET} [data-control='deposit-get']`), w.hasTouch)) ?? o.tapError;
    await waitState(f, "S4.13");
    // every quote the pool flow asked: pool.address with an amount, and any vault quote (none wanted)
    o.asked = (await asked(page)).slice(n0).filter((m) => m.type === "deposit.dry" || m.type === "deposit.quote" || (m.type === "pool.address" && m.amount !== undefined)).map((m) => (m.type === "pool.address" ? fieldsOf(m) : { type: m.type }));
    o.addressState = await sheetState(f);
    o.address = await f.locator(`${SHEET} [data-address]`).first().getAttribute("data-address", { timeout: 1_000 }).catch(() => null);
    await shot(page, "pool-address");
    o.stages = [];
    o.readies = [];
    for (const [facts, want] of POOL_STAGES) {
      await page.evaluate(({ x, pool }) => window.__ctPoolPush({ ...x, ...(x.stage === "expired" ? {} : { since_ms: Date.now() - 12_000 }) }, x.stage === "in_pool" ? [pool] : undefined), { x: facts, pool: SOL_POOL });
      await waitState(f, want);
      o.stages.push(await sheetState(f));
      o.readies.push(await f.locator(`${SHEET} [data-ready]`).first().getAttribute("data-ready", { timeout: 300 }).catch(() => null));
    }
    await shot(page, "pool-in");
    await f.locator("[data-control='deposit-done']").filter({ visible: true }).first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
    o.closed = (await f.locator(SHEET).count()) === 0;
    await f.waitForSelector(`[data-pool='${OPEN}']`, { timeout: 3_000 }).catch(() => {});
    o.rowAfter = await poolRow(f, OPEN);
    await shot(page, "portfolio-pool");
    return run;
  } finally {
    await ctx.close();
  }
}

/** Every width and scheme in Chromium. `route` answers the hosts' names (app-deposit-mount.mjs routeFor). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source }) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) for (const s of SCHEMES) runs.push(await runOne(browser, w, s, shots, route));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell signed in`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : build}, the stand-in shell signed in`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route: await routeFor(build), source });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
