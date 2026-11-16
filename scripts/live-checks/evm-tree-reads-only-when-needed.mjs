#!/usr/bin/env node
// Live check of card evm-tree-reads-only-when-needed: a fresh account that holds nothing sends no Uniswap v4 pool index
// read (the PoolManager's Initialize logs, the kit's checks/evm/pool-index.ts) on Base or Robinhood, meets no 429 and no
// failed answer from any EVM RPC, and sends at most LOGS_PER_LOAD eth_getLogs a page load. Release 157 (15 Nov
// 21:29-21:34Z): a fresh account's PLANNED deposit notes (the page names an address in every pool's scope at a sign-in)
// counted as money, so each load synced both chains' pool index, 1,946 Base eth_getLogs in 264 s, and
// base-rpc.publicnode.com answered 429 on 11 of 13 screens.
// Headless Chromium (scripts/browsers.mjs, sandbox on) opens SIGN_HOST top-level with a CDP virtual authenticator (PRF),
// signs up with a throwaway passkey (Create passkey, as wallet-passkey-prf does), then loads a fixed walk of screens
// (WALK), each watched WATCH_MS, typing 5 in each token's buy box, and counts every JSON-RPC post whose body asks an eth_
// method, with each chain's eth_getLogs by page load (byLoad, printed). An answer counts as refused only as a provider
// refuses it (refusalsOf): never the page's own cancel. It never presses Buy, Sell, Withdraw or Confirm: the account is new and holds nothing, and the seed stays in
// the browser's temporary profile, deleted on close. The answer keeps hosts, methods, counts and statuses only.
//   --sign-dir <dir>: SIGN_HOST's files answered from a local build (packages/signpage/scripts/build-app.mjs --out),
//   every other request live: how the good answer was recorded before the deploy. Its headers are not the host's.
// After: sign
// Bundle: out a browser and a fresh account on the live hosts
//   node scripts/live-checks/evm-tree-reads-only-when-needed.mjs [--record <file>] [--answer <file>] [--sign-dir <dir>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "evm-tree-reads-only-when-needed";
export const SIGN = "https://confidential.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** The PoolManager's Initialize(bytes32,address,address,uint24,int24,address,uint160,int24) topic: the pool index's and
 *  the quote scan's one event (kit checks/evm/pool-index.ts INITIALIZE). */
export const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
/** The screens loaded after the sign-up, in order: Discover, a token of each chain with 5 typed in its buy box (mihao,
 *  routes.ts OPEN_TOKEN; DEGEN; MOW, the walk of 15 Nov 21:29Z), then the portfolio with its Deposit and Withdraw sheets. */
export const WALK = Object.freeze([
  { name: "discover", path: "/discover" },
  { name: "solana", path: "/token/solana/4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump", type: true },
  { name: "base", path: "/token/base/0x4ed4e862860bed51a9570b96d89af5e1b0efefed", type: true },
  { name: "robinhood", path: "/token/robinhood/0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa", type: true },
  { name: "portfolio", path: "/portfolio", sheets: ["deposit", "withdraw"] },
]);
const WATCH_MS = 20_000;
/** The most eth_getLogs one page load of a fresh account sends: one round of a pool's tree sync from its deploy block,
 *  the load's restore walk of each pool (src/pool-restore.ts resume), whose Base round read 117 (publicnode 74,
 *  bloXroute 41, Pocket 1, the helper's keyed route 1; 26.9 s from block 54,325,671, 16 Nov 21:4xZ), Robinhood's a few;
 *  the rest of the bound is margin for a lag retry. [design: one cold round a chain a load, never two] */
export const LOGS_PER_LOAD = 150;
/** The chain an EVM RPC post reads: the helper's route by its path, else the provider's host. */
export function chainOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const route = /^\/v1\/rpc\/([a-z-]+)/.exec(u.pathname);
  if (route) return route[1];
  return /robinhood/.test(u.host) ? "robinhood" : /(^|[.-])base([.-]|$)/.test(u.host) ? "base" : "other";
}

const lower = (s) => (typeof s === "string" ? s.toLowerCase() : s);
/** A getLogs filter's kind: the pool index's (the PoolManager's Initialize alone, no other topic), a quote scan's
 *  (Initialize and a currency), or any other log read (the pools' own events). */
function logKind(filter) {
  const t = Array.isArray(filter?.topics) ? filter.topics : [];
  const t0 = Array.isArray(t[0]) ? t[0].map(lower) : [lower(t[0])];
  if (!t0.includes(INITIALIZE)) return "other";
  return t.slice(1).some((x) => x !== null && x !== undefined) ? "scan" : "index";
}

/** The answer from a request log: each entry { url, method, status, failed, load, calls: [{ method, params }] }, the
 *  calls a post's JSON-RPC body asked and the page load it was sent in (1 the sign-up's). Only posts that ask an eth_
 *  method count; `loads` is the walk's page loads; `byLoad` each chain's eth_getLogs a load, from the first. */
export function summarize(requests, loads, extra = {}) {
  const posts = {};
  const methods = {};
  const logs = { index: 0, scan: 0, other: 0 };
  const refused = {};
  const byLoad = {};
  for (const r of requests) {
    const calls = (r.calls ?? []).filter((c) => typeof c?.method === "string" && c.method.startsWith("eth_"));
    if (r.method !== "POST" || calls.length === 0) continue;
    let host;
    try {
      host = new URL(r.url).host;
    } catch {
      continue;
    }
    posts[host] = (posts[host] ?? 0) + 1;
    for (const c of calls) {
      methods[c.method] = (methods[c.method] ?? 0) + 1;
      if (c.method === "eth_getLogs") {
        logs[logKind(c.params?.[0])]++;
        const ch = chainOf(r.url);
        const at = Number.isInteger(r.load) && r.load >= 1 && r.load <= loads ? r.load : loads;
        byLoad[ch] ??= Array(loads).fill(0);
        byLoad[ch][at - 1]++;
      }
    }
    for (const bad of refusalsOf(r)) refused[`${host} ${bad}`] = (refused[`${host} ${bad}`] ?? 0) + 1;
  }
  return { ...extra, loads, posts, methods, logs, refused, byLoad };
}

/** A page's own cancel of a request (a navigation between loads, or its AbortController): never a provider's refusal. */
const PAGE_CANCEL = "net::ERR_ABORTED";
/** A JSON-RPC error that names a block range (the helper's keyed route: HTTP 200, code -32602 "eth_getLogs range too
 *  wide, maximum block range: 10000", read 15 Nov 23:2xZ): a provider's page cap, which the pool sync's pager probes
 *  for by design (evm.ts readLogs, capSpanOf) and pages under, never a refusal of the read. */
const RANGE_CAP = /block range|range (is )?too (wide|large|big)|max(imum)? range|blocks? range|range limit|range exceed/i;

/** Each provider refusal one request log entry holds: a failure of the network (any but the page's own cancel), an HTTP
 *  4xx or 5xx answer, or a JSON-RPC error that is no range cap (`errors`: each one's { code, cap }). */
export function refusalsOf(r) {
  const out = [];
  if (r.failed && r.failed !== PAGE_CANCEL) out.push(`failed ${r.failed}`);
  if (Number.isInteger(r.status) && r.status >= 400) out.push(String(r.status));
  for (const e of Array.isArray(r.errors) ? r.errors : []) if (!e?.cap) out.push(`rpc error ${Number.isInteger(e?.code) ? e.code : "?"}`);
  return out;
}

/** A JSON-RPC answer's errors, shaped to their code and whether they name a block range (no message is kept). */
export function errorsOf(text) {
  try {
    const j = JSON.parse(text ?? "");
    return (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x === "object" && x.error && typeof x.error === "object").map((x) => ({ code: Number.isInteger(x.error.code) ? x.error.code : null, cap: RANGE_CAP.test(String(x.error.message ?? "")) }));
  } catch {
    return [];
  }
}

/** The verdict on an answer { loads, posts, methods, logs: { index, scan, other }, refused }. */
export function judge(a) {
  const lines = [];
  if (!a || typeof a !== "object" || !Number.isInteger(a.loads) || a.loads < 1 || !a.logs || typeof a.logs !== "object") return { ok: false, lines: ["BAD the walk was not read"] };
  if (a.logs.index > 0) lines.push(`BAD the page read the pool index ${a.logs.index} times (the PoolManager's Initialize logs) for an account that holds nothing`);
  for (const [k, n] of Object.entries(a.refused ?? {})) lines.push(`BAD ${k}: ${n} EVM RPC answers refused`);
  const all = a.methods?.eth_getLogs ?? a.logs.index + a.logs.scan + a.logs.other;
  if (all > LOGS_PER_LOAD * a.loads) lines.push(`BAD ${all} eth_getLogs in ${a.loads} loads, over ${LOGS_PER_LOAD} a load`);
  return { ok: lines.length === 0, lines };
}

const shapeCalls = (body) => {
  try {
    const j = JSON.parse(body ?? "");
    return (Array.isArray(j) ? j : [j]).filter((c) => c && typeof c.method === "string").map((c) => ({ method: c.method, params: c.method === "eth_getLogs" ? [{ topics: c.params?.[0]?.topics ?? [] }] : [] }));
  } catch {
    return [];
  }
};

/** SIGN_HOST answered from `dir` where it holds the file (a path with no file and no extension: its index.html, as the
 *  host serves the page); any other request of SIGN_HOST goes live. */
async function routeSign(ctx, dir) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".zkey": "application/octet-stream" };
  await ctx.route(`${SIGN}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    let file = path.join(dir, p);
    if (!file.startsWith(dir)) return route.abort();
    if (p.endsWith("/") || path.extname(p) === "") file = path.join(dir, "index.html");
    let body;
    try {
      body = readFileSync(file);
    } catch {
      return route.continue();
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body });
  });
}

export async function read({ signDir = null } = {}) {
  const { launchBrowser, browserLabel } = await import("../browsers.mjs");
  const browser = await launchBrowser("chromium");
  const requests = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // the page load each request is sent in: 1 for the sign-up's, then each screen of the walk
    let loads = 1;
    if (signDir) await routeSign(ctx, path.resolve(signDir));
    const open = new Map();
    ctx.on("request", (req) => {
      if (req.method() !== "POST") return;
      const r = { url: req.url(), method: "POST", load: loads, calls: shapeCalls(req.postData()) };
      if (r.calls.length === 0) return;
      open.set(req, r);
      requests.push(r);
    });
    const done = async (req, failed) => {
      const r = open.get(req);
      if (!r) return;
      open.delete(req);
      if (failed) r.failed = req.failure()?.errorText ?? "failed";
      const res = await req.response().catch(() => null);
      if (res) {
        r.status = res.status();
        const errors = errorsOf(await res.text().catch(() => ""));
        if (errors.length > 0) r.errors = errors;
      }
    };
    ctx.on("requestfinished", (q) => void done(q, false));
    ctx.on("requestfailed", (q) => void done(q, true));
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const app = () => page.frames().find((f) => f.url().startsWith(APP));
    const t0 = Date.now();
    // sign up: the terminal's Sign in, then Use passkey opens SIGN_HOST's layer, whose Create passkey makes the account
    await page.goto(`${SIGN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((a) => [...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(a)), APP, { timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const create = page.locator('[data-action="create"]');
    if (!(await create.isVisible().catch(() => false))) {
      const f = app();
      const skip = f?.getByRole("button", { name: /^skip$/i }).first();
      if (skip && (await skip.isVisible().catch(() => false))) await skip.click({ timeout: 5_000 }).catch(() => {});
      await f.getByRole("button", { name: /^sign in$/i }).first().click({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await f.getByRole("button", { name: /use passkey/i }).first().click({ timeout: 10_000 });
    }
    await create.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800); // past the activation guard (500 ms)
    await create.click();
    await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-in", null, { timeout: 30_000 });
    await page.waitForTimeout(WATCH_MS);
    for (const s of WALK) {
      loads++;
      await page.goto(`${SIGN}${s.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(3_000);
      const f = app();
      if (s.type && f) {
        const input = f.locator("input.trb-input").first();
        if (await input.click({ timeout: 10_000 }).then(() => true, () => false)) await page.keyboard.type("5");
      }
      await page.waitForTimeout(WATCH_MS);
      for (const sheet of s.sheets ?? []) {
        await app()?.getByRole("button", { name: new RegExp(`^${sheet}$`, "i") }).first().click({ timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(WATCH_MS / 2);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(1_500);
      }
    }
    // the last answers in flight
    await page.waitForTimeout(2_000);
    return summarize(requests, loads, { at: new Date().toISOString(), browser: browserLabel(browser), signDir: signDir ? "local build" : null, ms: Date.now() - t0 });
  } finally {
    await browser.close();
  }
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read({ signDir: arg("--sign-dir") ?? null });
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    console.log(`loads ${answer?.loads}, eth_getLogs ${JSON.stringify(answer?.logs)} by load ${JSON.stringify(answer?.byLoad)}, posts ${JSON.stringify(answer?.posts)}`);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
