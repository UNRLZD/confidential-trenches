#!/usr/bin/env node
// Live check of card signpage-sent-end-known: a buy the box shows as sent, whose signing page posted no end after it (a
// run that threw after answering sent, or ended sent with its landing unknown), ends on screen from the op the page
// records under the request's id in state.ops (apps/terminal/src/screens/trade/model.ts endFromOps, TradeBox's read of
// state.ops; the page's half is card signpage-sent-end-recorded). APP_HOST's terminal is framed by the stand-in shell
// (app-in-shell.mjs harnessRoute) signed in, with a Base pool of one ready 0.001 ETH note priced now, on the recorded
// mainnet Base coin (apps/terminal/test/chains-evm); the shell answers pool.buy.dry as the page answers a tap's own ask,
// answers pool.buy sent and posts no progress, and LATE_END_MS later records the buy's op filled with a Base tx in its
// state's ops and sends the state. At 390 x 844 (phone, dpr 2, touch; the trade sheet the bar's Buy opens) and 1440 x 900
// (desktop; the right column): $2 typed, Buy. Want one pool.buy on Base, the box Landing (no end) before the op, then
// Filled with the fill toast linking the tx on basescan. A screenshot of each state is kept. Signs nothing and moves
// nothing: the shell stands in for SIGN_HOST.
// On SIGN_HOST (--host sign, after a sign deploy): the seam this card stands on. The page sends a buy or sell op in
// state.ops only when its stage is in the kit's trade stages (packages/kit/src/signpage/schema.ts TRADE, the op schemas'
// buy and sell rows; an op of another stage is left out, never sent), so every stage the app ends a sent trade on
// (model.ts OP_ENDS, read from this commit's source) must be in that list in the served /app.js, the one index.html
// pins. A sign deploy that renames or drops one leaves the app's box at Landing for that end: this run FAILs.
// After: app
// After: sign --host sign
// Bundle: read sign
//   node scripts/live-checks/signpage-sent-end-known.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served, the helper live but the coin's recorded reads), framed by
//     the stand-in shell
//   node scripts/live-checks/signpage-sent-end-known.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name, the helper's reads recorded
//   node scripts/live-checks/signpage-sent-end-known.mjs --host sign [--record <file>]
//     the deployed SIGN_HOST's index.html and /app.js, read signed out
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { WIDTHS } from "./app-hop-sync-lock.mjs";
import { harnessRoute, LATE_END_MS, SIGN_HOST } from "./app-in-shell.mjs";
import { named } from "./record-names.mjs";

const KEY = "signpage-sent-end-known";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const READY_MS = 15_000;
/** After the op went out, the most the box may take to draw Filled: a rendering or two. */
export const FILL_MS = 1_000;
/** The buy's Base transaction the late end names: a stand-in of a tx hash's form, linked, never read. */
export const TX = { chain: "base", hash: `0x${"5e".repeat(32)}` };
export const TX_URL = `https://basescan.org/tx/${TX.hash}`;

// the recorded mainnet Base coin (apps/terminal/test/chains-evm, 9 Nov)
const read = (f) => JSON.parse(readFileSync(path.join(REPO, "apps/terminal/test", f), "utf8"));
const COIN = (() => {
  const t = read("chains-evm/token-base-2026-11-09.json");
  const row = Object.fromEntries(t.fields.map((k, i) => [k, t.row[i]]));
  return { id: row.token, symbol: row.symbol, reads: { "/v1/market/token": { ...t.rest, row }, "/v1/market/candles": read("chains-evm/candles-base-2026-11-09.json").body, "/v1/market/holders": read("chains-evm/holders-base-2026-11-09.json").body } };
})();
// signed in, a Base pool of one ready 0.001 ETH note at $3,500.12345678 priced now, and the page's dry for the tap's own
// ask on it (test/trade-reads-after-buy's Base scene)
const ETH_PRICE = () => ({ price: "350012345678", expo: -8, published_s: Math.floor(Date.now() / 1000), read_ms: Date.now() });
const STATE = () => ({ release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "40.00", wallets: [], positions: [], orders: [], held: [], ops: [], pools: [{ chain: "base", asset: "ETH", balance: "0.001", ready: "0.001", tap_max: "0.001", price: ETH_PRICE() }] });
const ANSWERS = { "pool.buy.dry": { tap_max: "0.001", cost: "0.000021", out: "10600" }, "pool.buy": { stage: "sent", txs: [] } };
/** As the signing page records it: no progress after sent, the buy's op under its id ended filled with its tx. */
export const LATE = { "pool.buy": [{ stage: "filled", txs: [TX], op: true }] };

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const have = new Set(runs.map((r) => r.width));
  say(WIDTHS.every((w) => have.has(w.name)), `${runs.length} run(s) of ${WIDTHS.length} (390 and 1440)`);
  for (const r of runs) {
    const n = r.width;
    say(r.framed === true && r.ready === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}, ${r.ready ? `the Base coin's page ready (${r.symbol})` : "the coin's page not ready"}`);
    say(r.buyOn === true, `${n}: Buy ${r.buyOn ? "on" : "off"} with $2 typed, want on`);
    say(r.buys === 1 && r.chain === "base", `${n}: ${r.buys ?? 0} pool.buy sent${r.chain ? ` on ${r.chain}` : ""}, want 1 on base`);
    const landing = r.before?.stage === null && typeof r.before.cta === "string" && /^(Landing|Slow)\b/.test(r.before.cta);
    say(landing && r.before.lateOut === false, `${n}: ${r.before?.lateOut ? "read after the op went out" : "before the op"}, the box reads "${r.before?.cta ?? "nothing"}"${r.before?.stage ? ` (ended ${r.before.stage})` : ""}, want Landing with no end`);
    say(r.late === true, `${n}: the shell ${r.late ? "recorded" : "never recorded"} the buy's op`);
    const filled = typeof r.after?.cta === "string" && /^Filled\b/.test(r.after.cta) && r.after.stage === null;
    say(filled, `${n}: after it the box reads "${r.after?.cta ?? "nothing"}"${r.after?.stage ? ` (ended ${r.after.stage})` : ""}, want Filled`);
    say(r.after?.toast === true && r.after.href === TX_URL, `${n}: ${r.after?.toast ? `the fill toast links ${r.after.href ?? "nothing"}` : "no fill toast"}, want ${TX_URL}`);
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

/** The box's end and its button's words, and the fill toast with its link. */
const boxRead = (box, f) =>
  Promise.all([box.getAttribute("data-stage").catch(() => null), box.locator('[data-testid="trade-cta"]').textContent().catch(() => null), f.locator('[data-testid="fill-toast"]:visible').first()]).then(async ([stage, cta, toast]) => {
    const shown = (await toast.count()) > 0;
    const href = shown ? await toast.locator("a[href]").first().getAttribute("href").catch(() => null) : null;
    return { stage, cta: cta === null ? null : cta.replace(/\s+/g, " ").trim(), toast: shown, href };
  });

async function runOne(browser, w, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const run = { width: w.name, framed: false, ready: false, symbol: null, buyOn: null, buys: null, chain: null, before: null, late: null, after: null, shots: [] };
  const shot = async (page, tag) => {
    const name = `${w.name}-${tag}.png`;
    await page.screenshot({ path: path.join(shots, name) });
    run.shots.push(name);
  };
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/token/base/${encodeURIComponent(COIN.id)}`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    run.ready = await f.waitForSelector('main[data-route="token"] [data-token-page="ready"]', { timeout: READY_MS }).then(() => true, () => false);
    run.symbol = COIN.symbol;
    if (!run.ready) return run;
    // the signed-in state has landed and the pool is priced when the box's balance reads a number
    await f.waitForFunction(() => /\$\d/.test(document.querySelector('[data-testid="trade-balance"]')?.textContent ?? ""), null, { timeout: 8_000 }).catch(() => {});
    if (w.isMobile) {
      await f.locator(".tkp-buy").click({ timeout: 3_000 }).catch(() => {});
      await f.locator('[data-sheet="trade"]').waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    }
    const box = f.locator(w.isMobile ? '[data-sheet="trade"] [data-testid="trade-box"]' : '.tkp-desk .tkp-trade [data-testid="trade-box"]');
    await box.locator(".trb-input").fill("2");
    const cta = box.locator('[data-testid="trade-cta"]');
    // the box's dry reads settle and answer
    await f.waitForFunction((el) => el && !el.disabled, await cta.elementHandle(), { timeout: 5_000 }).catch(() => {});
    run.buyOn = await cta.isEnabled().catch(() => false);
    await shot(page, "typed");
    if (!run.buyOn) return run;
    await cta.click({ timeout: 3_000 });
    await page.waitForFunction(() => (window.__ctShellAsked ?? []).some((q) => q.type === "pool.buy"), null, { timeout: 5_000 }).catch(() => {});
    const buys = await page.evaluate(() => (window.__ctShellAsked ?? []).filter((q) => q.type === "pool.buy").map((q) => q.chain ?? null));
    run.buys = buys.length;
    run.chain = buys[0] ?? null;
    // the answer drawn (Landing), the op not yet out (LATE_END_MS after the answer)
    await f.waitForFunction((el) => /^\s*(Landing|Slow)/.test(el?.querySelector('[data-testid="trade-cta"]')?.textContent ?? ""), await box.elementHandle(), { timeout: LATE_END_MS - 200 }).catch(() => {});
    run.before = { ...(await boxRead(box, f)), lateOut: (await page.evaluate(() => window.__ctShellLate ?? 0)) > 0 };
    await shot(page, "landing");
    run.late = await page.waitForFunction(() => window.__ctShellLate === 1, null, { timeout: LATE_END_MS * 3 }).then(() => true, () => false);
    await f.waitForFunction((el) => /^\s*Filled/.test(el?.querySelector('[data-testid="trade-cta"]')?.textContent ?? ""), await box.elementHandle(), { timeout: FILL_MS }).catch(() => {});
    await f.locator('[data-testid="fill-toast"]:visible').first().waitFor({ timeout: FILL_MS }).catch(() => {});
    run.after = await boxRead(box, f);
    await shot(page, "filled");
    return run;
  } finally {
    await ctx.close();
  }
}

/** Both widths in Chromium. `route` answers the hosts' names (see routeFor); `harness`: a local build, its sockets
 *  routed by the harness (harness-sockets.mjs). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source, harness = false }) {
  mkdirSync(shots, { recursive: true });
  const browser = await (harness ? launchHarnessBrowser : launchBrowser)("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

const json = (body, status = 200) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });

/** The stand-in shell signed in with the Base pool, its buy answered sent, then its op recorded filled; the coin's reads recorded; APP_HOST
 *  from `build`, or with no build the deployed APP_HOST and helper as served. */
export async function routeFor(build) {
  const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: STATE(), answers: ANSWERS, late: LATE });
  return (x) => {
    const u = new URL(x.request().url());
    // the Base coin's own reads, from its recording; another Base coin is one the helper does not know
    if (u.origin === HELPER_HOST && u.searchParams.get("chain") === "base" && u.pathname !== "/v1/market/lists") {
      const hit = u.searchParams.get("token") === COIN.id ? COIN.reads[u.pathname] : undefined;
      return x.fulfill(hit ? json(hit) : json({ error: { code: "not_found" } }, 404));
    }
    if (!build && (u.origin === APP_HOST || u.origin === HELPER_HOST)) return x.continue();
    return shell(x);
  };
}

// ------------------------------------------------------------------------------------------------ SIGN_HOST
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const ID = "[\\w$]+";

/** The stages the app ends a sent trade on: model.ts OP_ENDS, read from this commit's source. */
export function opEnds(src = readFileSync(path.join(REPO, "apps/terminal/src/screens/trade/model.ts"), "utf8")) {
  const m = /const OP_ENDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(src);
  return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null;
}

/** The kit's trade stages in a built /app.js: the list the buy and sell op schemas both name (schema.ts `buy: op(lit("buy"),
 *  TRADE, ...)`, minified `buy:F(L(`buy`),T,{code:`), read where it is defined; null when either row or the list is not
 *  there. */
export function tradeStages(js) {
  const row = (k) => new RegExp(`${k}:${ID}\\(${ID}\\(\`${k}\`\\),(${ID}),\\{code:`).exec(js)?.[1] ?? null;
  const t = row("buy");
  if (t === null || row("sell") !== t) return null;
  const list = new RegExp(`(?:^|[^\\w$])${t.replace(/\$/g, "\\$")}=\\[((?:\`[a-z_]+\`,?)+)\\]`).exec(js)?.[1];
  return list ? [...list.matchAll(/`([a-z_]+)`/g)].map((x) => x[1]) : null;
}

/** What the sign run keeps: the index, the served bundle's sha384, its trade stages, and the app's ends. */
export function signFacts(index, js, ends = opEnds()) {
  return { index, sha384: sha384(js), stages: tradeStages(js), ends };
}

/** The verdict on a sign run's facts { index, sha384, stages, ends }. */
export function judgeSign(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (!Array.isArray(a?.ends) || a.ends.length === 0) bad("the app's ends (model.ts OP_ENDS) not read");
  if (!Array.isArray(a?.stages)) bad("the served /app.js holds no trade stage list the buy and sell op schemas both name");
  else for (const e of Array.isArray(a?.ends) ? a.ends : []) if (!a.stages.includes(e)) bad(`${e}: the app ends a sent trade on it, but the page's op schema leaves an op of that stage out, so the box never sees that end`);
  if (lines.length === 0) lines.push(`ok  every end the app reads from an op (${a.ends.join(", ")}) is a stage the page's buy and sell ops may carry`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** SIGN_HOST's index.html and /app.js, through `f` (the network, or a build: scripts/ci/bundle-checks.mjs). */
export async function readSign(f = fetch) {
  const get = async (p) => {
    const r = await f(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  return signFacts(index, await get("/app.js"));
}

/** The sign run on a build (scripts/ci/bundle-checks.mjs "Bundle: read sign"). */
export const bundle = async (f) => judgeSign(await readSign(f));

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    if (opt("--host", "app") === "sign") {
      const facts = await readSign();
      const file = opt("--record", null);
      if (file) writeFileSync(file, `${JSON.stringify(facts, null, 1)}\n`);
      const { ok, lines } = judgeSign(facts);
      for (const l of lines) console.log(l);
      console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${SIGN}, signed out)`);
      process.exit(ok ? 0 : 1);
    }
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell signed in, its Base buy answered sent, its op recorded filled`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell signed in, its Base buy answered sent, its op recorded filled`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route: await routeFor(build), source, harness: build !== null });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
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
