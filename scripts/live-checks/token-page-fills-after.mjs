#!/usr/bin/env node
// Live check of card token-page-fills-after (M384): a token page whose first answer is the helper's row named on chain
// (src "chain": the symbol and name read from the mint, every Jupiter field null, helper card helper-page-jup-429) with
// `filling: true` (Jupiter's row still coming) draws the name at once and the price loading, reads again 5 s later,
// draws the price from that answer and then stops reading. A mint Jupiter does not list (src "chain", `filling: false`)
// draws the dash, no skeleton, and is still read again. The deployed terminal (APP_HOST's bytes and headers as served)
// is framed by the stand-in shell (app-in-shell.mjs) at /token/solana/<mint>. The check answers the page's token reads
// itself, so it judges the app whatever the helper holds for the mint at that moment (a cold page's chain row needs a
// mint nobody opened): the recorded answer (apps/terminal/test/token-source/helper-token-2026-11-03.json) cut to its
// chain-named row, and that answer whole. Every other helper read (the chart's, the logo) goes to the live helper.
// At 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1):
//   - fill: the first read answers the chain row with filling true, every later one the full answer with filling
//     false. Want the symbol with the price's skeleton and data-filling true; the second token read 4.5 to 7.5 s after
//     the first; then the price drawn and data-filling false; no third read in the QUIET_MS after.
//   - unlisted: every read answers the chain row with filling false. Want the symbol, the price drawn as the dash,
//     data-filling false, and a second read 4.5 to 7.5 s after the first (the page still follows a chain row).
//   No page error in the terminal's frame; a screenshot of each state is kept.
// The helper side, read live (Origin APP_HOST): the top of the helper's Solana Trending column (its row Jupiter's) read
// as a Solana token page answers 200 with filling false (a read named on chain, its search late, is read again 6 s later, up to
// HELPER_TRIES times). Run after the helper's deploy: the helper deploys first, then the app.
// After: app
//   node scripts/live-checks/token-page-fills-after.mjs [--helper <url>] [--shots <dir>] [--record <file>]
//     the deployed APP_HOST, framed by the stand-in shell; the helper at HELPER_HOST (or --helper)
//   node scripts/live-checks/token-page-fills-after.mjs --harness [--build <dir>] [--helper <url>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";
import { pageError } from "./console-errors.mjs";
import { named } from "./record-names.mjs";

const KEY = "token-page-fills-after";
export const APP_HOST = "https://ct-app.unrealized.trade";
const HELPER_HOST = "https://ct-api.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** The page's re-read (source.ts FILL_MS) and the window its second read must land in. */
export const FILL_MS = 5_000;
export const GAP = [4_500, 7_500];
/** After the price is drawn, how long no further token read may come. */
export const QUIET_MS = 7_000;
const READY_MS = 20_000;
/** The signed-out account the stand-in shell sends (app-hop-sync-lock.mjs's): the trade box drawn signed out. */
const SIGNED_OUT = { release: "harness-shell", api: 1, signed_in: false, code_saved: false, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };

const READ = JSON.parse(readFileSync(path.join(REPO, "apps/terminal/test/token-source/helper-token-2026-11-03.json"), "utf8"));
const ROW = Object.fromEntries(READ.fields.map((f, i) => [f, READ.row[i]]));
export const MINT = ROW.token;
export const SYMBOL = ROW.symbol;
/** The full answer, and the same cut to the helper's chain-named row (token.ts chainRow on helper-page-jup-429). */
const FILLED = { ...READ.rest, row: ROW, filling: false };
const CHAIN_ROW = { ...Object.fromEntries(READ.fields.map((f) => [f, null])), chain: "solana", token: MINT, symbol: ROW.symbol, name: ROW.name, icon: false, src: "chain", as_of_ms: ROW.as_of_ms };
/** The answers per case: the n-th token read (from 1) gets ANSWERS[case](n). */
const ANSWERS = {
  fill: (n) => (n === 1 ? { ...READ.rest, row: CHAIN_ROW, filling: true } : FILLED),
  unlisted: () => ({ ...READ.rest, row: CHAIN_ROW, filling: false }),
};
export const CASES = Object.keys(ANSWERS);
export const HELPER_TRIES = 3;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const have = new Set(runs.map((r) => r.width));
  say(WIDTHS.every((w) => have.has(w.name)), `${runs.length} run(s) of ${WIDTHS.length} (phone and desktop)`);
  for (const r of runs.filter((r) => (r.case ?? "fill") === "fill")) {
    const n = r.width;
    const f = r.first ?? {};
    const a = r.after ?? {};
    const at = r.readsAt ?? [];
    say(r.framed === true && f.ready === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}, ${f.ready ? "the page drew its first answer" : "the page drew no answer"}`);
    say(f.symbol === SYMBOL && f.filling === "true" && f.priceLoading === true, `${n}: first answer (chain row): symbol ${JSON.stringify(f.symbol)}, data-filling ${f.filling ?? "absent"}, price ${f.priceLoading ? "loading" : JSON.stringify(f.price)}; want ${SYMBOL}, true, loading`);
    const gap = at.length >= 2 ? at[1] - at[0] : null;
    say(gap !== null && gap >= GAP[0] && gap <= GAP[1], `${n}: second token read ${gap === null ? "never made" : `${gap} ms after the first`}; want ${GAP[0]} to ${GAP[1]} ms`);
    say(a.filling === "false" && a.priceLoading === false && /^\$[0-9]/.test(a.price ?? ""), `${n}: after it: data-filling ${a.filling ?? "absent"}, price ${a.priceLoading ? "loading" : JSON.stringify(a.price)}; want false and a price`);
    say(at.length === 2, `${n}: ${at.length} token read(s) by ${QUIET_MS} ms after the fill; want 2 (reading stopped)`);
    say((r.errors ?? []).length === 0, `${n}: ${(r.errors ?? []).length ? `page errors: ${r.errors.join(" | ")}` : "no page error"}`);
    say(Boolean(r.shots?.loading && r.shots?.filled), `${n}: ${r.shots?.loading && r.shots?.filled ? "both screenshots kept" : "a screenshot missing"}`);
  }
  const un = rec.unlisted ?? [];
  say(WIDTHS.every((w) => un.some((r) => r.width === w.name)), `unlisted: ${un.length} run(s) of ${WIDTHS.length} (phone and desktop)`);
  for (const r of un) {
    const n = `unlisted ${r.width}`;
    const f = r.first ?? {};
    const at = r.readsAt ?? [];
    const gap = at.length >= 2 ? at[1] - at[0] : null;
    say(r.framed === true && f.ready === true && f.symbol === SYMBOL, `${n}: ${r.framed ? "framed" : "not framed"}, ${f.ready ? `symbol ${JSON.stringify(f.symbol)}` : "no answer drawn"}; want ${SYMBOL}`);
    say(f.filling === "false" && f.priceLoading === false && f.price === "\u2014", `${n}: data-filling ${f.filling ?? "absent"}, price ${f.priceLoading ? "loading" : JSON.stringify(f.price)}; want false and the dash`);
    say(gap !== null && gap >= GAP[0] && gap <= GAP[1], `${n}: second token read ${gap === null ? "never made" : `${gap} ms after the first`}; want ${GAP[0]} to ${GAP[1]} ms (a chain row is still followed)`);
    say((r.errors ?? []).length === 0 && Boolean(r.shots?.unlisted), `${n}: ${(r.errors ?? []).length ? `page errors: ${r.errors.join(" | ")}` : "no page error"}, ${r.shots?.unlisted ? "screenshot kept" : "no screenshot"}`);
  }
  const h = rec.helper ?? {};
  const last = (h.reads ?? []).at(-1) ?? {};
  say(last.status === 200 && last.src !== "chain" && typeof last.src === "string" && last.filling === false, `helper: the page of the top Trending token (<mint>) ${last.status === undefined ? "not read" : `answered ${last.status}, row src ${JSON.stringify(last.src)}, filling ${JSON.stringify(last.filling)}`} after ${(h.reads ?? []).length} read(s); want 200, a Jupiter row, filling false`);
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

/** The page's state in the layout drawn at this width: its symbol, data-filling and the price slot. */
const stateOf = (f, phone) =>
  f.evaluate((phone) => {
    const sec = document.querySelector("section.tkp");
    const lay = document.querySelector(phone ? ".tkp-phone" : ".tkp-desk");
    const sym = lay?.querySelector("h1.tkp-sym");
    const p = lay?.querySelector(phone ? ".tkp-pricerow .tkp-price" : '.tkp-tile[data-k="price"] .tkp-val');
    return { ready: sec?.getAttribute("data-token-page") === "ready", filling: sec?.getAttribute("data-filling") ?? null, symbol: sym?.textContent ?? null, priceLoading: p ? p.classList.contains("tkp-sk") : null, price: p && !p.classList.contains("tkp-sk") ? p.textContent : null };
  }, phone);

async function runOne(browser, w, shots, shellRoute, kase = "fill") {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: "dark", reducedMotion: "reduce" });
  const reads = [];
  const run = { case: kase, width: w.name, framed: false, first: null, after: null, readsAt: [], errors: [], shots: {} };
  try {
    await ctx.route("**/*", (x) => {
      const u = new URL(x.request().url());
      if (u.origin === HELPER_HOST && u.pathname === "/v1/market/token" && u.searchParams.get("token") === MINT) {
        reads.push(Date.now());
        const body = ANSWERS[kase](reads.length);
        return x.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": APP_HOST }, body: JSON.stringify(body) });
      }
      if (u.origin === HELPER_HOST) return x.continue();
      return shellRoute(x);
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => run.errors.push(pageError(e)));
    await page.goto(`${APP_HOST}/token/solana/${MINT}`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector('section.tkp[data-token-page="ready"]', { timeout: READY_MS }).catch(() => {});
    run.first = await stateOf(f, w.isMobile);
    if (kase === "unlisted") {
      run.shots.unlisted = `${w.name}-unlisted.png`;
      await page.screenshot({ path: path.join(shots, run.shots.unlisted) });
      await page.waitForTimeout(GAP[1] + 500);
      run.readsAt = reads.map((t) => t - reads[0]);
      return run;
    }
    run.shots.loading = `${w.name}-loading.png`;
    await page.screenshot({ path: path.join(shots, run.shots.loading) });
    const t0 = reads[0] ?? Date.now();
    await f.waitForSelector('section.tkp[data-filling="false"]', { timeout: Math.max(1, t0 + GAP[1] + 2_000 - Date.now()) }).catch(() => {});
    // the price drawn once the fill landed
    await page.waitForTimeout(300);
    run.after = await stateOf(f, w.isMobile);
    run.shots.filled = `${w.name}-filled.png`;
    await page.screenshot({ path: path.join(shots, run.shots.filled) });
    await page.waitForTimeout(QUIET_MS);
    run.readsAt = reads.map((t) => t - reads[0]);
    return run;
  } finally {
    await ctx.close();
  }
}

/** Both widths in Chromium. `route` answers SIGN_HOST (the stand-in) and APP_HOST (see routeFor). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source, helper = HELPER_HOST }) {
  mkdirSync(shots, { recursive: true });
  const h = await readHelper(helper);
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    const unlisted = [];
    for (const w of WIDTHS) runs.push(await runOne(browser, w, shots, route));
    for (const w of WIDTHS) unlisted.push(await runOne(browser, w, shots, route, "unlisted"));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs, unlisted, helper: h };
  } finally {
    await browser.close();
  }
}

/** The helper side: the top of its Trending column read as a token page, again 6 s later while it is named on chain. */
export async function readHelper(base, fetchFn = fetch) {
  const headers = { origin: APP_HOST, "cache-control": "no-cache" };
  const out = { base: base === HELPER_HOST ? "HELPER_HOST" : "local", reads: [] };
  try {
    const lists = await (await fetchFn(`${base}/v1/market/lists?chain=solana`, { headers, signal: AbortSignal.timeout(15_000) })).json();
    const top = (lists?.lists?.trending ?? [])[0];
    if (typeof top?.token !== "string") return { ...out, error: "no Trending row" };
    for (let i = 0; i < HELPER_TRIES; i++) {
      if (i > 0) await new Promise((ok) => setTimeout(ok, 6_000));
      const r = await fetchFn(`${base}/v1/market/token?chain=solana&token=${encodeURIComponent(top.token)}`, { headers, signal: AbortSignal.timeout(15_000) });
      const b = r.status === 200 ? await r.json() : null;
      out.reads.push({ status: r.status, src: b?.row?.src ?? null, filling: b === null ? null : "filling" in b ? b.filling : "absent" });
      if (r.status === 200 && b?.row?.src !== "chain") break;
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  }
  return out;
}

/** The stand-in shell signed out; APP_HOST from `build`, or with no build the deployed APP_HOST as served. */
export async function routeFor(build) {
  const r = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: SIGNED_OUT });
  if (build) return r;
  return (x) => (originOf(x.request().url()) === APP_HOST ? x.continue() : r(x));
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell, the token reads answered by the check`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      source = `harness, terminal build ${named(build)}, the stand-in shell, the token reads answered by the check`;
    }
    const shots = opt("--shots", undefined);
    const rec = await collect({ shots: shots && path.resolve(shots), route: await routeFor(build), source, helper: opt("--helper", HELPER_HOST) });
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
