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
// the browser's temporary profile, deleted on close. The answer keeps hosts, methods, counts and statuses only;
// a refused answer is named by its method and, for an eth_call, the contract it asks and its 4-byte selector (callName),
// never the call's arguments. A not-yet answer (the kit's evmNotYetWords: a provider a block behind, whatever its HTTP
// status) is no refusal when the same call is answered later in the walk (askAt asked it again): a lag line; one never
// answered is BAD (card evm-lag-answer-read-again, release 187's sign run 44912189713: robinhood.drpc.org HTTP 400 code 27
// "Unknown state" to ArbGasInfo's getL1BaseFeeEstimate). Asked again is the same call sent to any provider of its chain
// after the not-yet answer came back (card evm-lag-answered-on-another-seat, release 204's sign run 45518167089: the
// wallet's pair walked a seat onto rpc-robinhood.globalstake.io, its not-yet tree views were read again 2 s on at a new
// anchor on the pair's seats, by then another member); the round's other seat, sent before it came back, never counts.
// A throttle (an HTTP 429, a JSON-RPC error of code 429 or -32005) names its rate on its BAD line: the calls the page sent
// its host in the second before it and the posts then in flight (rateOf; card base-blastapi-paced-under-its-limit,
// release 206's sign run 45649477281: one base-mainnet.public.blastapi.io 429 in the page's 35 posts to it, with no rate
// to read it by, where blastapi took 60 calls a second from the Mac, none refused).
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
import { evmIsOutOfGas, evmNotYetWords } from "../../packages/kit/src/index.ts";
import { mainnetVenues } from "./mainnet-venues.mjs";

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

/** The answer from a request log: each entry { url, method, status, failed, load, calls: [{ method, params }], seq?,
 *  end? }, the calls a post's JSON-RPC body asked, the page load it was sent in (1 the sign-up's) and its order (`seq`
 *  when it was sent and `end` when its answer came back, on one counter: read() sets both). Only posts that ask an eth_
 *  method count; `loads` is the walk's page loads; `byLoad` each chain's eth_getLogs a load, from the first. */
export function summarize(requests, loads, extra = {}) {
  const posts = {};
  const methods = {};
  const logs = { index: 0, scan: 0, other: 0 };
  const refused = {};
  const byLoad = {};
  // card evm-lag-answer-read-again: each provider's call answered not yet, and how many of them were answered later
  const lag = {};
  // the not-yet answers still waiting, by chain and call (card evm-lag-answered-on-another-seat): an ordered one is
  // answered by the call sent to any provider of its chain after it came back; one with no order (an old recording's
  // entry), or of no named chain, only by its own provider later in the log
  const waiting = {};
  // card base-blastapi-paced-under-its-limit: each throttle's rate by its refusal's key, read from the posts' times
  // (`sentMs`, `backMs`) sent to its host before it, and those posts by host
  const rates = {};
  const sentTo = {};
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
    const bads = refusalsOf(r);
    for (const bad of bads) refused[`${host} ${bad}`] = (refused[`${host} ${bad}`] ?? 0) + 1;
    if (Number.isFinite(r.sentMs)) {
      const mine = (sentTo[host] ??= []);
      if (bads.length > 0 && throttled(r)) {
        const rate = rateOf(r, mine);
        for (const bad of bads) (rates[`${host} ${bad}`] ??= []).push(rate);
      }
      mine.push(r);
    }
    const answered = !r.failed && Number.isInteger(r.status) && r.status >= 200 && r.status < 300;
    const ordered = Number.isInteger(r.seq) && Number.isInteger(r.end);
    const chain = chainOf(r.url);
    for (const [c, e] of callErrors(r)) {
      const k = `${host} ${callName(c)}`;
      const w = chain === "other" ? k : `${chain} ${callName(c)}`;
      if (e?.lag && (answered || lagOnly(r))) {
        lag[k] ??= { asked: 0, answered: 0 };
        lag[k].asked++;
        (waiting[w] ??= []).push({ k, host, end: ordered ? r.end : null });
      } else if (e === undefined && answered) {
        // the oldest not-yet answer this post comes after
        const q = waiting[w] ?? [];
        const i = q.findIndex((x) => (x.end !== null && ordered ? r.seq > x.end : x.host === host));
        if (i >= 0) lag[q.splice(i, 1)[0].k].answered++;
      }
    }
  }
  return { ...extra, loads, posts, methods, logs, refused, byLoad, ...(Object.keys(lag).length > 0 ? { lag } : {}), ...(Object.keys(rates).length > 0 ? { rates } : {}) };
}

/** A provider's throttle: an HTTP 429, or a JSON-RPC error of code 429 or -32005 (limit exceeded). */
const throttled = (r) => r.status === 429 || (Array.isArray(r.errors) && r.errors.some((e) => e?.code === 429 || e?.code === -32005));
/** A throttled post's rate, read from `before`, the posts sent to its host ahead of it: the calls sent there in the second
 *  before it, its own included, and the posts then in flight, its own included (evm-buy-and-sell-on-mainnet's s429At). */
function rateOf(r, before) {
  const n = (x) => (Array.isArray(x.calls) ? x.calls.length : 0);
  const fly = before.filter((x) => !Number.isFinite(x.backMs) || x.backMs > r.sentMs);
  const second = before.filter((x) => x.sentMs > r.sentMs - 1_000).reduce((a, x) => a + n(x), 0) + n(r);
  return `${second} calls in 1 s, ${fly.length + 1} posts (${fly.reduce((a, x) => a + n(x), 0) + n(r)} calls) in flight`;
}

/** A page's own cancel of a request (a navigation between loads, or its AbortController): never a provider's refusal. */
const PAGE_CANCEL = "net::ERR_ABORTED";
/** A JSON-RPC error that names a block range (the helper's keyed route: HTTP 200, code -32602 "eth_getLogs range too
 *  wide, maximum block range: 10000", read 15 Nov 23:2xZ): a provider's page cap, which the pool sync's pager probes
 *  for by design (evm.ts readLogs, capSpanOf) and pages under, never a refusal of the read. */
const RANGE_CAP = /block range|range (is )?too (wide|large|big)|max(imum)? range|blocks? range|range limit|range exceed/i;

/** The pool's own buySwap((address,bytes,uint256,address),address,uint256): the buy quote's swap-gas fit read (the kit's
 *  evmBuySwapFitCall, checks/evm/quote.ts fitRead), an eth_call to a pinned pool from the pool. */
export const BUY_SWAP = "0x25faf2a3";
/** The pools the fit read asks: each mainnet's pinned pool (the kit's venue table, mainnets alone). */
export const FIT_POOLS = Object.freeze(new Set(Object.values(mainnetVenues()).flatMap((v) => (typeof v?.pool === "string" ? [v.pool.toLowerCase()] : []))));
/** Whether a call is the fit read: its revert or its run out of gas is its answer, "the route's swap does not run as
 *  the pool runs it" (the kit reads it so: quote.ts answerOf, code 3 or an out-of-gas error is a revert, the route does
 *  not fit), never a provider's refusal. Release 175: the coin page's warm asked the buy tap's v3 tier of a coin with no
 *  v3 pool (Robinhood 0x0b7c6c13…, the v3 factory 0x1f7d7550…'s getPool(WETH, coin, fee) the zero address at every
 *  tier on Robinhood's own and publicnode, 18 Nov 13:1xZ), whose buySwap reverts with no data: the adapter's
 *  SwapRouter02 exactInput (0xcaf681a6…, b858183f) calls a pool with no code (dRPC's debug_traceCall of the recorded
 *  call, any gas). */
export const isFitRead = (c) => c?.method === "eth_call" && c.sel === BUY_SWAP && FIT_POOLS.has(c.to);

/** A call's name in a refusal: its JSON-RPC method and, for an eth_call, the contract it asks and the 4-byte selector
 *  (`eth_call 0x<to>:0x<selector>`). Never the call's arguments: an address of the account sits there. */
export function callName(c) {
  if (!c || typeof c.method !== "string") return "?";
  return c.method === "eth_call" && c.to ? `eth_call ${c.to}:${c.sel ?? "?"}` : c.method;
}

/** Each call of a request log entry with its JSON-RPC error, or undefined where it has none: an error matched by its id,
 *  or the only call's. */
function callErrors(r) {
  const calls = Array.isArray(r.calls) ? r.calls : [];
  const errs = Array.isArray(r.errors) ? r.errors : [];
  return calls.map((c) => [c, errs.find((e) => (e?.id !== undefined ? c.id === e.id : calls.length === 1))]);
}
/** A 4xx whose body is not-yet answers alone, one for each call (the kit reads it as those answers and asks again). */
const lagOnly = (r) => !r.failed && Number.isInteger(r.status) && r.status >= 400 && r.status < 500 && r.status !== 429 && Array.isArray(r.errors) && r.errors.length > 0 && r.errors.every((e) => e?.lag) && callErrors(r).every(([, e]) => e !== undefined);

/** Each provider refusal one request log entry holds: a failure of the network (any but the page's own cancel), an HTTP
 *  4xx or 5xx answer, or a JSON-RPC error that is no range cap (`errors`: each one's { code, cap, id }). A failure or an
 *  HTTP refusal names every call of the post; a JSON-RPC error names the call its id answers. A not-yet answer (`lag`),
 *  under a 2xx or as a 4xx of them alone (lagOnly), is no refusal here: summarize counts it, and judge holds it BAD
 *  until the same call is answered. */
export function refusalsOf(r) {
  const out = [];
  const calls = Array.isArray(r.calls) ? r.calls : [];
  const all = calls.length > 0 ? ` [${calls.map(callName).join(", ")}]` : "";
  const lagged = lagOnly(r);
  const ok2xx = !r.failed && Number.isInteger(r.status) && r.status >= 200 && r.status < 300;
  if (r.failed && r.failed !== PAGE_CANCEL) out.push(`failed ${r.failed}${all}`);
  if (Number.isInteger(r.status) && r.status >= 400 && !lagged) out.push(`${r.status}${all}`);
  for (const e of Array.isArray(r.errors) ? r.errors : []) {
    if (e?.cap) continue;
    if (e?.lag && (ok2xx || lagged)) continue;
    const c = (e?.id !== undefined ? calls.find((x) => x.id === e.id) : undefined) ?? (calls.length === 1 ? calls[0] : undefined);
    // the fit read's revert or out of gas: its answer
    if ((e?.rev || e?.oog) && isFitRead(c)) continue;
    out.push(`rpc error ${Number.isInteger(e?.code) ? e.code : "?"}${c ? ` ${callName(c)}` : all}`);
  }
  return out;
}

/** A JSON-RPC answer's errors, shaped to their code, the id they answer, whether they name a block range (`cap`), are a
 *  revert (`rev`: code 3 or a message naming one, the kit's reading), an out-of-gas error (`oog`, the kit's
 *  evmIsOutOfGas) or a not-yet answer (`lag`, the kit's evmNotYetWords, never a revert); no message and no revert data
 *  is kept. */
export function errorsOf(text) {
  try {
    const j = JSON.parse(text ?? "");
    return (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x === "object" && x.error && typeof x.error === "object").map((x) => {
      const m = String(x.error.message ?? "");
      const rev = x.error.code === 3 || /revert/i.test(m);
      const oog = evmIsOutOfGas(m);
      const lag = !rev && evmNotYetWords(m);
      return { code: Number.isInteger(x.error.code) ? x.error.code : null, cap: RANGE_CAP.test(m), ...(rev ? { rev: true } : {}), ...(oog ? { oog: true } : {}), ...(lag ? { lag: true } : {}), ...(typeof x.id === "number" || typeof x.id === "string" ? { id: x.id } : {}) };
    });
  } catch {
    return [];
  }
}

/** The verdict on an answer { loads, posts, methods, logs: { index, scan, other }, refused }. */
export function judge(a) {
  const lines = [];
  if (!a || typeof a !== "object" || !Number.isInteger(a.loads) || a.loads < 1 || !a.logs || typeof a.logs !== "object") return { ok: false, lines: ["BAD the walk was not read"] };
  if (a.logs.index > 0) lines.push(`BAD the page read the pool index ${a.logs.index} times (the PoolManager's Initialize logs) for an account that holds nothing`);
  for (const [k, n] of Object.entries(a.refused ?? {})) {
    const rate = Array.isArray(a.rates?.[k]) && a.rates[k].length > 0 ? ` (${a.rates[k].join("; ")})` : "";
    lines.push(`BAD ${k}: ${n} EVM RPC answers refused${rate}`);
  }
  // card evm-lag-answer-read-again: a not-yet answer asked again and answered is a lag line; one never answered is BAD
  for (const [k, l] of Object.entries(a.lag ?? {})) {
    const asked = Number.isInteger(l?.asked) ? l.asked : 0;
    const answered = Number.isInteger(l?.answered) ? l.answered : 0;
    if (asked > answered) lines.push(`BAD ${k}: ${asked - answered} of ${asked} not-yet answers never answered again`);
    else lines.push(`lag ${k}: ${asked} not-yet answer(s), each asked again and answered`);
  }
  const all = a.methods?.eth_getLogs ?? a.logs.index + a.logs.scan + a.logs.other;
  if (all > LOGS_PER_LOAD * a.loads) lines.push(`BAD ${all} eth_getLogs in ${a.loads} loads, over ${LOGS_PER_LOAD} a load`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** What a call keeps beside its method: its JSON-RPC id (to match an error to it) and, for an eth_call, the contract it
 *  asks and the 4-byte selector of its data. */
export function callOf(c) {
  const out = {};
  if (typeof c?.id === "number" || typeof c?.id === "string") out.id = c.id;
  if (c?.method === "eth_call") {
    const tx = c.params?.[0] ?? {};
    if (typeof tx.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(tx.to)) out.to = tx.to.toLowerCase();
    const data = typeof tx.data === "string" ? tx.data : typeof tx.input === "string" ? tx.input : "";
    if (/^0x[0-9a-fA-F]{8}/.test(data)) out.sel = data.slice(0, 10).toLowerCase();
  }
  return out;
}

const shapeCalls = (body) => {
  try {
    const j = JSON.parse(body ?? "");
    return (Array.isArray(j) ? j : [j]).filter((c) => c && typeof c.method === "string").map((c) => ({ method: c.method, params: c.method === "eth_getLogs" ? [{ topics: c.params?.[0]?.topics ?? [] }] : [], ...callOf(c) }));
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
    // each post's order, sent and back, on one counter (summarize: a not-yet answer is asked again by a post sent after it),
    // and its times in ms from the walk's start (summarize: a throttle's rate)
    let clock = 0;
    const start = performance.now();
    ctx.on("request", (req) => {
      if (req.method() !== "POST") return;
      const r = { url: req.url(), method: "POST", load: loads, calls: shapeCalls(req.postData()) };
      if (r.calls.length === 0) return;
      r.seq = ++clock;
      r.sentMs = Math.round(performance.now() - start);
      open.set(req, r);
      requests.push(r);
    });
    const done = async (req, failed) => {
      const r = open.get(req);
      if (!r) return;
      open.delete(req);
      r.end = ++clock;
      r.backMs = Math.round(performance.now() - start);
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
