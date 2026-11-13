#!/usr/bin/env node
// SIGN_HOST's restore timed in a real browser at the production walk gap (card restore-shows-the-balance-in-seconds):
// the wallet way's "I already have one" with the published all-zero test vector typed (packages/wallet/test/vectors/a8.json),
// on the signing page's mainnet build and the terminal's build, both served by the terminal's harness on the shipped
// names (startHarness realNames), so /walk-worker.js, _headers (CSP worker-src 'self', trusted-types walk-worker) and
// the bundle are the shipped ones. The restore's walk gap is the build's own RESTORE_GAP (10,000), never changed here.
//
// Every read the restore makes is answered here through context.route, before any name lookup, each answer RTT_MS
// (150 ms) after its call, as test/restore-speed.test.ts does in node:
//   - Solana (provider A, the helper's /v1/rpc/solana and the mark lister /v1/rpc/solana-marks): the pinned pool's mark
//     and page accounts byte for byte for the test seed's 8 notes (test/restore-speed-pool.ts, shared with the node
//     test), and SOL/USD's Pyth account in its 134-byte PriceUpdateV2 shape at 150 USD, so the app draws the balance;
//   - Base and Robinhood: the pinned pools empty (no log, views 0 but SCOPE), a head EVM_SPAN blocks past each pin that
//     moves with the clock, and each chain's Chainlink ETH/USD at 3,000 USD;
//   - NEAR: the mainnet vault empty (its views as the vault writes them, every list empty).
// A request nobody answers here (a host or method this run does not model) is refused, logged with its host and method,
// and fails the run. No real host is reached: the harness maps the shipped names to its own server and every other name
// fails as not found.
//
// It times two events from the Continue tap, each read in the APP_HOST frame:
//   (a) the balance shown: the restore sheet's balance (apps/terminal/src/screens/signin/SigninSheet.tsx, data-balance)
//       first not $0.00, drawn from the Solana notes' balance SIGN_HOST puts in its state (src/pools.ts); the state's own
//       first Solana balance is printed beside it;
//   (b) the restore done: the sheet's data-restore first leaving "scanning" (done, nothing or offline), from the restore
//       op's stage at the walk's end (src/pool-restore.ts end(stage), written to the op by its follower); the op's stage
//       as the state carries it is printed beside it.
// Workers are counted as the page's CDP auto-attach (Target.setAutoAttach) reports their targets, and from the request
// log (/walk-worker.js requests and their statuses). With --cpu N above 1 the page is slowed by
// Emulation.setCPUThrottlingRate, and the same rate is asked of every Worker target on its own session before it runs
// (each line prints what Chrome answered; Chrome 157 refuses it: "Operation is only supported for pages, not workers").
// A calibration (a fixed loop in a Worker on the harness's plain host, no rate, the page's rate alone, the page's and
// the Worker target's) prints whether either rate reaches a Worker: when none does, a Workers run at N x has its page
// slowed and its Workers at the machine's own speed.
//
//   node packages/signpage/scripts/restore-speed-browser.mjs [--modes workers,page] [--cpu 1,4] [--others]
//     [--record <file>] [--evm-span <blocks>] [--timeout <s>]
//   modes: workers (the shipped page), page (/walk-worker.js answered 404: every lane walks on the page)
//   --others also runs Firefox and WebKit once each at 1x, Workers on, when the launcher can start them
// Prints seconds only. Records hold states, counts and times only: never the words, a key or a seed.
// PASS exit 0 (every run timed both events with nothing unanswered), FAIL exit 1, error exit 2.
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import { attachRecorders, buildSignpage, defaultSites, HOSTS, REAL, startHarness, TERMINAL } from "../../../apps/terminal/test/harness/harness.mjs";
import { headersFor } from "../../../apps/terminal/test/harness/server.mjs";
import { parseHeadersFile } from "../../../apps/terminal/scripts/check-deploy.ts";
import { launchHarnessBrowser } from "../../../scripts/harness-sockets.mjs";
import { browserLabel } from "../../../scripts/browsers.mjs";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { POOL_USD_FEEDS } from "../../kit/src/price/pool-usd.ts";
import { VAULT_CONSTANTS } from "../../kit/src/vault/shapes.ts";
import { entropyToWords } from "../../wallet/src/derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES } from "../../wallet/src/notes/restore.ts";
import { EVM_CHAIN_IDS, EVM_POOLS, evmPoolScopeOf } from "../../wallet/src/pool/evm.ts";
import { vaultScope } from "../src/withdraw/checks.ts";
import { RTT_MS, SLOT, solanaAccount, solanaAnswer } from "../test/restore-speed-pool.ts";

const SHIPPED_GAP = 10_000;
const WORKER_PATH = "/walk-worker.js";
export const CONTINUE = '#signin[data-signin="words"] button[data-action="next"]';
export const STEP_MS = 60_000;
const secs = (ms) => (ms === null || ms === undefined ? "-" : (ms / 1000).toFixed(2));

// ------------------------------------------------------------------------------------------------ the chains' answers
class Unmodelled extends Error {}
/** A JSON-RPC error answer, as the provider gives it. */
class RpcError extends Error {
  constructor(error) {
    super(error.message);
    this.error = error;
  }
}

/** SOL/USD's Pyth account (kit pool-usd.ts PYTH_LEN): 150 USD at expo -8, published in this 10-second step, so both
 *  providers give the same bytes. */
function pythBytes(nowMs) {
  const f = POOL_USD_FEEDS.solana;
  const d = new Uint8Array(134);
  d.set([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd], 0);
  d.set(base58.decode(f.account), 8);
  d[40] = 1; // Full
  d.set(Uint8Array.from(f.feedId.slice(2).match(/../g), (h) => parseInt(h, 16)), 41);
  const v = new DataView(d.buffer);
  const pub = BigInt(Math.floor(nowMs / 10_000) * 10);
  v.setBigInt64(73, 15_000_000_000n, true);
  v.setBigUint64(81, 1_000_000n, true);
  v.setInt32(89, -8, true);
  v.setBigInt64(93, pub, true);
  v.setBigInt64(101, pub - 1n, true);
  v.setBigInt64(109, 15_000_000_000n, true);
  v.setBigUint64(117, 1_000_000n, true);
  v.setBigUint64(125, BigInt(SLOT - 1), true);
  return d;
}

function solana(method, params) {
  const pyth = POOL_USD_FEEDS.solana;
  if (method === "getMultipleAccounts") {
    const r = solanaAnswer(method, params);
    return { ...r, value: r.value.map((x, i) => (params[0][i] === pyth.account ? solanaAccount(pythBytes(Date.now()), pyth.owner) : x)) };
  }
  if (method === "getProgramAccounts") return solanaAnswer(method, params);
  if (method === "getAccountInfo") return { context: { slot: SLOT }, value: params[0] === pyth.account ? solanaAccount(pythBytes(Date.now()), pyth.owner) : null };
  if (method === "getSlot") return SLOT;
  // a slot's time: the clock in 10-second steps, so both providers give one answer
  if (method === "getBlockTime") return Math.floor(Date.now() / 10_000) * 10;
  if (method === "getBalance") return { context: { slot: SLOT }, value: 0 };
  if (method === "getSignaturesForAddress") return [];
  throw new Unmodelled(method);
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const q = (n) => `0x${BigInt(n).toString(16)}`;
const w64 = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, "0");
const sel = (s) => `0x${hex(keccak_256(new TextEncoder().encode(s)).subarray(0, 4))}`;
const POOL_VIEWS = ["SCOPE()", "currentRoot()", "currentTreeSize()", "currentLabelRoot()", "currentLabelTreeSize()"].map(sel);

/** An EVM chain: its pinned pool empty, its head `span` blocks past the pin at the run's start and one block each 2 s
 *  after, each block's time on the clock; Chainlink ETH/USD at 3,000 USD updated at the head's time. */
export function evmChain(chain, span, start) {
  const pin = EVM_POOLS[chain];
  const id = EVM_CHAIN_IDS[chain];
  const scope = evmPoolScopeOf(pin.pool.toLowerCase(), id);
  const head0 = pin.fromBlock + BigInt(span);
  const startS = BigInt(Math.floor(start / 1000));
  const head = () => head0 + BigInt(Math.floor((Date.now() - start) / 2000));
  const hashOf = (n) => `0x${hex(keccak_256(new TextEncoder().encode(`${chain} ${n}`)))}`;
  const timeOf = (n) => startS + (n - head0) * 2n;
  const block = (n) => (n > head() || n < 0n ? null : { number: q(n), hash: hashOf(n), parentHash: hashOf(n - 1n), timestamp: q(timeOf(n)), baseFeePerGas: q(1_000_000n), transactions: [] });
  const at = (tag) => (tag === "latest" || tag === "pending" ? head() : tag === "finalized" || tag === "safe" ? head() - 10n : tag === "earliest" ? 0n : BigInt(tag));
  const feed = POOL_USD_FEEDS[chain];
  return (method, params) => {
    switch (method) {
      case "eth_chainId": return q(id);
      case "eth_blockNumber": return q(head());
      case "eth_getBlockByNumber": return block(at(params[0]));
      case "eth_getLogs": return [];
      case "eth_call": {
        const { to, data } = params[0];
        const s = String(data).slice(0, 10).toLowerCase();
        if (String(to).toLowerCase() === pin.pool.toLowerCase() && POOL_VIEWS.includes(s)) return `0x${w64(s === POOL_VIEWS[0] ? scope : 0n)}`;
        if (String(to).toLowerCase() === feed.proxy.toLowerCase()) {
          if (s === "0x313ce567") return `0x${w64(8n)}`;
          if (s === "0xfeaf968c") {
            const t = timeOf(head());
            return `0x${[7n, 300_000_000_000n, t, t, 7n].map(w64).join("")}`;
          }
        }
        throw new Unmodelled(`eth_call ${s}`);
      }
      default: throw new Unmodelled(method);
    }
  };
}

/** The mainnet NEAR vault, empty: its views as contracts/vault writes them, at one final block. */
export function nearVault() {
  const net = NEAR_NETWORKS.mainnet;
  const H = 190_000_000;
  const hashAt = (h) => base58.encode(keccak_256(new TextEncoder().encode(`near ${h}`)));
  const tree = { size: 0, depth: 0, root: "0" };
  const config = { version: "blindfill-vault 0.1.0", asset: net.usdc, scope: String(vaultScope("mainnet")), max_tree_depth: 32, min_deposit: "1000000", max_relay_fee_bps: 5000, page_max: VAULT_CONSTANTS.PAGE_MAX };
  return (method, params) => {
    if (method === "query" && params.request_type === "call_function" && params.account_id === net.vault) {
      const at = params.finality !== undefined ? H : Number(params.block_id);
      const m = params.method_name;
      const view = m === "config" ? config : m === "state_tree" || m === "label_tree" ? tree : ["deposits", "spends", "leaves", "labels"].includes(m) ? [] : undefined;
      if (view === undefined) throw new Unmodelled(`query ${m}`);
      return { block_hash: hashAt(at), block_height: at, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] };
    }
    // an account: intents.near and every named account exist (step 5's pass opens on intents.near's view_account); an
    // implicit id (64 hex) was never used, UNKNOWN_ACCOUNT as the providers answer it
    if (method === "query" && params.request_type === "view_account") {
      const at = params.finality !== undefined ? H : Number(params.block_id);
      if (/^[0-9a-f]{64}$/.test(String(params.account_id))) throw new RpcError({ name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { block_height: at, block_hash: hashAt(at) } }, code: -32000, message: "Server error" });
      return { amount: "1000000000000000000000000", locked: "0", code_hash: base58.encode(keccak_256(new TextEncoder().encode(String(params.account_id)))), storage_usage: 1000, storage_paid_at: 0, block_height: at, block_hash: hashAt(at) };
    }
    if (method === "block") {
      const h = params.finality !== undefined ? H : Number(params.block_id ?? H);
      return { author: "node.near", header: { height: h, hash: hashAt(h), prev_hash: hashAt(h - 1), timestamp: (BigInt(Date.now()) * 1_000_000n).toString(), timestamp_nanosec: (BigInt(Date.now()) * 1_000_000n).toString() }, chunks: [] };
    }
    throw new Unmodelled(method === "query" ? `query ${params.request_type} ${params.method_name ?? ""}`.trim() : method);
  };
}

/** Which chain a request reads, by its URL: the helper's /v1/rpc/{chain} routes, else the provider's host. */
function chainOfUrl(u) {
  if (u.hostname === REAL.api) {
    const m = /^\/v1\/rpc\/(solana|solana-marks|base|robinhood)$/.exec(u.pathname);
    return m ? (m[1] === "solana-marks" ? "solana" : m[1]) : null;
  }
  const h = u.hostname;
  if (/(^|\.)solana|helius|jito/.test(h)) return "solana";
  if (/(^|[.-])near(\.|-)|fastnear/.test(h)) return "near";
  if (/robinhood/.test(h)) return "robinhood";
  if (/(^|\.)base[.-]/.test(h)) return "base";
  return null;
}

// ------------------------------------------------------------------------------------------------ the browser side
// In every document before its scripts: the Continue tap and the cores on SIGN_HOST's top page; in the APP_HOST frame
// the restore sheet's state and whether its balance is past $0.00, and the state messages' Solana balance and restore
// stage. Each reported with an epoch time; no amount, word or key leaves the page.
const PROBE = ({ sign, app, button }) => {
  const now = () => performance.timeOrigin + performance.now();
  const report = (e) => {
    try {
      /** @type {any} */ (window).__rs(e);
    } catch {}
  };
  if (location.hostname === sign && window.top === window) {
    report({ kind: "cores", n: navigator.hardwareConcurrency ?? null });
    addEventListener("click", (e) => e.target instanceof Element && e.target.closest(button) && report({ kind: "tap", t: now() }), true);
  }
  if (location.hostname === app && window.top !== window) {
    let sheet = null;
    let shown = false;
    let drawn = false;
    let stage = null;
    const look = () => {
      const r = document.querySelector(".sgn-restore");
      const k = r?.getAttribute("data-restore") ?? null;
      if (k !== sheet) {
        sheet = k;
        report({ kind: "sheet", state: k, t: now() });
      }
      const b = r?.querySelector("[data-balance]")?.getAttribute("data-balance") ?? "";
      if (!shown && /[1-9]/.test(b)) {
        shown = true;
        report({ kind: "shown", t: now() });
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-restore", "data-balance"] });
    addEventListener(
      "message",
      (e) => {
        const s = e.data?.state ?? e.data?.result;
        if (!s || typeof s !== "object") return;
        if (!drawn && Array.isArray(s.pools) && s.pools.some((p) => p?.chain === "solana" && /[1-9]/.test(String(p.balance)))) {
          drawn = true;
          report({ kind: "drawn", t: now() });
        }
        const op = Array.isArray(s.ops) ? s.ops.filter((o) => o?.kind === "restore").at(-1) : undefined;
        if (op && op.stage !== stage) {
          stage = op.stage;
          report({ kind: "stage", stage, t: now() });
        }
      },
      true,
    );
  }
};

// ------------------------------------------------------------------------------------------------ one run
/** The context's routes: the sites (served by the harness, or here from their folders with their _headers for an engine
 *  the harness cannot map), /walk-worker.js 404 in page mode, every chain read answered RTT_MS late, the rest refused. */
export async function route(context, { mode, sites, evm, near, out }) {
  const log = (k, key) => (out[k][key] = (out[k][key] ?? 0) + 1);
  await context.route(
    () => true,
    async (r) => {
      const req = r.request();
      let u;
      try {
        u = new URL(req.url());
      } catch {
        return r.fallback();
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return r.fallback();
      if (u.hostname === REAL.sign && u.pathname === WORKER_PATH) out.workerAsks += 1;
      if (mode === "page" && u.hostname === REAL.sign && u.pathname === WORKER_PATH) return r.fulfill({ status: 404, contentType: "text/plain", body: "not found\n" });
      const site = sites?.[u.hostname];
      if (site) {
        // served here (Firefox, WebKit): the site's file under its own _headers, its index for a path with no file
        let file = path.join(site.root, decodeURIComponent(u.pathname));
        if (!file.startsWith(site.root) || !existsSync(file) || path.basename(file) === "_headers" || !/\.[a-z0-9]+$/i.test(file)) file = path.join(site.root, "index.html");
        const headers = Object.fromEntries(headersFor(site.rules, u.pathname));
        const ext = path.extname(file);
        headers["content-type"] = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" }[ext] ?? "application/octet-stream";
        return r.fulfill({ status: 200, headers, body: readFileSync(file) });
      }
      if (u.hostname.endsWith(".ct.test") || u.hostname.endsWith(".other.test") || u.hostname === REAL.sign || u.hostname === REAL.app) return r.fallback();
      const chain = chainOfUrl(u);
      // the terminal's own helper reads (its market lists), none of the restore's: the harness answers them as it does
      // in every terminal harness run (421, no such harness host), counted apart
      if (chain === null && u.hostname === REAL.api) {
        log("app", `${req.method()} ${u.pathname}`);
        return sites === null ? r.fallback() : r.fulfill({ status: 421, contentType: "text/plain", body: "no such harness host\n" });
      }
      const origin = req.headers().origin ?? "*";
      const cors = { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", vary: "origin" };
      if (chain && req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
      let body = null;
      try {
        body = chain && req.method() === "POST" ? JSON.parse(req.postData() ?? "") : null;
      } catch {}
      if (body === null) {
        out.unanswered.push({ host: u.hostname, method: req.method(), path: u.pathname, t: Date.now() });
        return r.abort("blockedbyclient");
      }
      const model = chain === "solana" ? solana : chain === "near" ? near : evm[chain];
      const one = (b) => {
        const k = `${chain} ${b.method}`;
        try {
          const result = model(b.method, b.params ?? []);
          log("answers", k);
          return { jsonrpc: "2.0", id: b.id, result };
        } catch (e) {
          if (e instanceof RpcError) {
            log("answers", `${k} (error)`);
            return { jsonrpc: "2.0", id: b.id, error: e.error };
          }
          const what = e instanceof Unmodelled ? e.message : `${b.method} (${String(e?.message ?? e).slice(0, 60)})`;
          out.unanswered.push({ host: u.hostname, method: `${req.method()} ${chain} ${what}`, path: u.pathname, t: Date.now() });
          return { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: `not modelled: ${what}` } };
        }
      };
      const answer = Array.isArray(body) ? body.map(one) : one(body);
      await new Promise((ok) => setTimeout(ok, RTT_MS));
      return r.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(answer) }).catch(() => {});
    },
  );
}

/** CDP: the page slowed `cpu` times, and every Worker target of it too, on its own session before it runs. */
async function slowWorkers(context, page, cpu, out) {
  const cdp = await context.newCDPSession(page);
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  let n = 0;
  const waits = new Map();
  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const m = JSON.parse(message);
    waits.get(m.id)?.(m);
  });
  const to = (sessionId, method, params = {}) =>
    new Promise((ok) => {
      const id = ++n;
      waits.set(id, ok);
      cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch((e) => ok({ error: { message: String(e.message) } }));
    });
  cdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type === "worker") {
      const w = { path: (() => { try { return new URL(targetInfo.url).pathname; } catch { return "?"; } })(), rate: null };
      out.workers.push(w);
      if (cpu > 1) {
        const r = await to(sessionId, "Emulation.setCPUThrottlingRate", { rate: cpu });
        w.rate = r.error ? `refused: ${r.error.message}` : cpu;
      }
    }
    if (waitingForDebugger) await to(sessionId, "Runtime.runIfWaitingForDebugger");
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  return cdp;
}

/** A fixed loop in a Worker on the harness's plain host, timed by the Worker: at no rate, the page's rate alone, and the
 *  page's and the Worker target's. */
async function calibrate(browser, cpu) {
  const res = {};
  for (const how of ["none", "page", "both"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    if (how !== "none") await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const sink = { workers: [] };
    if (how === "both") await slowWorkers(context, page, cpu, sink);
    await page.goto(`https://${HOSTS.sibling}/`);
    res[how] = await page.evaluate(
      () =>
        new Promise((ok) => {
          const src = "let x=0;const t=performance.now();for(let i=0;i<4e8;i++)x=(x*31+i)|0;postMessage([performance.now()-t,x]);";
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
          const t = performance.now();
          w.onmessage = (e) => ok({ inWorker: e.data[0], wall: performance.now() - t });
        }),
    );
    await context.close();
  }
  return res;
}

async function oneRun(browser, { engine, mode, cpu, sites, evmSpan, timeoutS }) {
  const start = Date.now();
  const out = { engine, mode, cpu, answers: {}, app: {}, unanswered: [], workers: [], workerAsks: 0, events: [], error: null };
  const evm = { base: evmChain("base", evmSpan, start), robinhood: evmChain("robinhood", evmSpan, start) };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const rec = await attachRecorders(context);
  await context.exposeBinding("__rs", (_src, e) => out.events.push(e));
  await context.addInitScript(PROBE, { sign: REAL.sign, app: REAL.app, button: CONTINUE });
  await route(context, { mode, sites, evm, near: nearVault(), out });
  const page = await context.newPage();
  const workerEvents = [];
  page.on("worker", (w) => workerEvents.push(new URL(w.url()).pathname));
  if (engine === "chromium") await slowWorkers(context, page, cpu, out);
  const top = (sel) => page.locator(sel).first();
  const app = page.frameLocator("iframe#app");
  const vis = (sel) => app.locator(`${sel} >> visible=true`).first();
  try {
    await page.goto(`https://${REAL.app}/discover`, { waitUntil: "commit" });
    await page.waitForURL((x) => x.hostname === REAL.sign, { timeout: STEP_MS });
    await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: STEP_MS });
    await vis('[data-header="S1.1"] button, button[data-header="S1.1"]').click({ timeout: STEP_MS });
    await vis('.sgn-opt[data-way="wallet"]').click({ timeout: STEP_MS });
    await top('#screen:not([hidden]) #signin[data-signin="choose"] button[data-action="have-one"]').click({ timeout: STEP_MS });
    await top('#signin[data-signin="existing"] button[data-action="recovery"]').click({ timeout: STEP_MS });
    // the published all-zero vector (a8.json's entropy), typed and never printed
    await top('#signin[data-signin="words"] textarea[data-input="words"]').fill(entropyToWords(new Uint8Array(16)), { timeout: STEP_MS });
    await top(CONTINUE).click({ timeout: STEP_MS });
    const ends = (e) => e.kind === "sheet" && ["done", "nothing", "offline"].includes(e.state);
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline && !(out.events.some((e) => e.kind === "shown") && out.events.some(ends))) await page.waitForTimeout(250);
  } catch (e) {
    out.error = String(e.message).split("\n")[0];
  }
  const tap = out.events.find((e) => e.kind === "tap")?.t ?? null;
  const at = (f) => {
    const e = out.events.find(f);
    return e && tap !== null ? e.t - tap : null;
  };
  out.cores = out.events.find((e) => e.kind === "cores")?.n ?? null;
  out.tapped = tap !== null;
  out.shownMs = at((e) => e.kind === "shown");
  out.drawnMs = at((e) => e.kind === "drawn");
  const end = out.events.find((e) => e.kind === "sheet" && ["done", "nothing", "offline"].includes(e.state));
  out.doneMs = end && tap !== null ? end.t - tap : null;
  out.sheetEnd = end?.state ?? null;
  const stageEnd = out.events.find((e) => e.kind === "stage" && (e.stage === "done" || e.stage === "stalled"));
  out.stageMs = stageEnd && tap !== null ? stageEnd.t - tap : null;
  out.stage = stageEnd?.stage ?? null;
  // a request refused after the restore's end (step 5's id reads, which the timed wait does not include) is logged apart:
  // it cannot move either event; one refused before the end fails the run
  const endAt = end && tap !== null ? end.t : Infinity;
  out.unansweredAfter = out.unanswered.filter((x) => x.t > endAt).map(({ t, ...x }) => ({ ...x, afterS: Number(secs(t - endAt)) }));
  out.unanswered = out.unanswered.filter((x) => x.t <= endAt).map(({ t, ...x }) => ({ ...x, atS: tap === null ? null : Number(secs(t - tap)) }));
  const asks = rec.requests.filter((x) => x.host === REAL.sign && new URL(x.url).pathname === WORKER_PATH);
  out.workerRequests = asks.length;
  out.workerStatuses = [...new Set(asks.map((x) => x.status ?? x.failure ?? "none"))];
  out.workerEvents = workerEvents.filter((p) => p === WORKER_PATH).length;
  out.walkWorkers = out.workers.filter((w) => w.path === WORKER_PATH).length;
  out.workerRates = [...new Set(out.workers.filter((w) => w.path === WORKER_PATH).map((w) => w.rate))];
  delete out.events;
  await context.close().catch(() => {});
  return out;
}

function line(o, label) {
  const ok = o.error === null && o.shownMs !== null && o.doneMs !== null && o.unanswered.length === 0;
  const w = o.engine === "chromium" ? `${o.walkWorkers} walk Worker targets (CDP auto-attach)${o.cpu > 1 ? `, the rate on each: ${o.workerRates.map((x) => (typeof x === "number" ? `${x}x` : x)).join("; ") || "-"}` : ""}` : `${o.workerEvents} walk Workers (Playwright's worker events)`;
  const n = Object.values(o.answers).reduce((s, x) => s + x, 0);
  return {
    ok,
    text:
      `${ok ? "ok " : "BAD"} ${label}, ${o.mode === "workers" ? "Workers" : "page (/walk-worker.js 404)"}, CPU ${o.cpu}x: ` +
      `balance shown ${secs(o.shownMs)} s (in the state ${secs(o.drawnMs)} s), restore done ${secs(o.doneMs)} s (${o.sheetEnd ?? "not ended"}; op ${o.stage ?? "-"} at ${secs(o.stageMs)} s); ` +
      `${w}, ${o.workerRequests} /walk-worker.js requests (${o.workerStatuses.join(", ") || "none"}); hardwareConcurrency ${o.cores ?? "-"}; ` +
      `${n} reads answered ${RTT_MS / 1000} s late, ${Object.values(o.app).reduce((s, x) => s + x, 0)} app helper reads answered 421 by the harness, ${o.unanswered.length} unanswered before the restore's end, ${o.unansweredAfter.length} refused after it (step 5)${o.error ? `; error: ${o.error}` : ""}`,
  };
}

// ------------------------------------------------------------------------------------------------ the launches
const siteTable = (sites) =>
  Object.fromEntries(
    Object.entries(sites).map(([host, s]) => {
      const hf = path.join(s.root, "_headers");
      return [host, { root: path.resolve(s.root), rules: existsSync(hf) ? parseHeadersFile(readFileSync(hf, "utf8")).rules : [] }];
    }),
  );

/** Whether `engine`'s Worker script requests reach context.route: a Worker started on a name nothing resolves
 *  (probe.ct.test, served here), so a request the route misses reaches no host at all. */
async function workerRouted(browser) {
  const context = await browser.newContext();
  let seen = false;
  await context.route("https://probe.ct.test/**", (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === "/w.js") {
      seen = true;
      return r.fulfill({ status: 200, contentType: "text/javascript", body: "postMessage('up');" });
    }
    return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>probe</title>" });
  });
  const page = await context.newPage();
  await page.goto("https://probe.ct.test/");
  const ran = await page.evaluate(() => new Promise((ok) => {
    const w = new Worker("/w.js", { type: "module" });
    w.onmessage = () => ok(true);
    w.onerror = () => ok(false);
    setTimeout(() => ok(false), 10_000);
  }));
  await context.close();
  return { seen, ran };
}

async function main() {
  const opt = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const modes = opt("--modes", "workers,page").split(",");
  const cpus = opt("--cpu", "1,4").split(",").map(Number);
  const others = process.argv.includes("--others");
  const evmSpan = Number(opt("--evm-span", "1000"));
  const timeoutS = Number(opt("--timeout", "1800"));
  if (modes.some((m) => !["workers", "page"].includes(m)) || cpus.some((c) => !(c >= 1)) || !(evmSpan >= 1) || !(timeoutS > 0)) {
    console.error("usage: restore-speed-browser.mjs [--modes workers,page] [--cpu 1,4] [--others] [--record <file>] [--evm-span <blocks>] [--timeout <s>]");
    return 2;
  }
  if (RESTORE_GAP !== SHIPPED_GAP) throw new Error(`RESTORE_GAP is ${RESTORE_GAP}, not the shipped ${SHIPPED_GAP}`);
  console.log(`restore-speed-browser: walk gap ${RESTORE_GAP} (RESTORE_GAP, the build's own), ${RESTORE_LANES} lanes a pool, every read ${RTT_MS / 1000} s late, EVM heads ${evmSpan} blocks past their pins`);
  const recs = [];
  let ok = true;
  const h = await startHarness({ realNames: true });
  try {
    const label = browserLabel(h.browser);
    if (cpus.some((c) => c > 1)) {
      for (const c of cpus.filter((x) => x > 1)) {
        const cal = await calibrate(h.browser, c);
        recs.push({ calibration: c, ...cal });
        console.log(`calibration ${label}, a fixed loop in a Worker: no rate ${secs(cal.none.inWorker)} s; the page at ${c}x alone ${secs(cal.page.inWorker)} s; the page and the Worker target at ${c}x ${secs(cal.both.inWorker)} s`);
      }
    }
    for (const mode of modes)
      for (const cpu of cpus) {
        const o = await oneRun(h.browser, { engine: "chromium", mode, cpu, sites: null, evmSpan, timeoutS });
        recs.push(o);
        const l = line(o, label);
        ok &&= l.ok;
        console.log(l.text);
        for (const x of o.unanswered.slice(0, 20)) console.log(`  unanswered: ${x.method} ${x.host}${x.path}`);
        for (const x of o.unansweredAfter.slice(0, 20)) console.log(`  refused after the end: ${x.method} ${x.host}${x.path}`);
      }
  } finally {
    await h.close();
  }
  if (others) {
    const signRoot = buildSignpage();
    try {
      const sites = defaultSites(signRoot);
      const table = siteTable({ [REAL.sign]: sites[HOSTS.sign], [REAL.app]: { root: path.join(TERMINAL, "dist") } });
      for (const engine of ["firefox", "webkit"]) {
        let browser;
        try {
          browser = await launchHarnessBrowser(engine, { headless: true }, { hosts: [], refuseHttp: true });
        } catch (e) {
          console.log(`skip ${engine}: the launcher cannot start it here (${String(e.message).split("\n").filter((x) => x.trim()).slice(0, 6).join(" | ").slice(0, 600)})`);
          recs.push({ engine, skipped: String(e.message).split("\n")[0] });
          continue;
        }
        try {
          const label = browserLabel(browser);
          const probe = await workerRouted(browser);
          if (!probe.seen) {
            console.log(`skip ${label}: its Worker script requests do not reach context.route (a Worker ${probe.ran ? "ran" : "did not run"}), so a run on the shipped names could reach the real host`);
            recs.push({ engine, skipped: "worker requests not routed", probe });
            continue;
          }
          const o = await oneRun(browser, { engine, mode: "workers", cpu: 1, sites: table, evmSpan, timeoutS });
          recs.push(o);
          const l = line(o, label);
          ok &&= l.ok;
          console.log(l.text);
          for (const x of o.unanswered.slice(0, 20)) console.log(`  unanswered: ${x.method} ${x.host}${x.path}`);
        for (const x of o.unansweredAfter.slice(0, 20)) console.log(`  refused after the end: ${x.method} ${x.host}${x.path}`);
        } finally {
          await browser.close();
        }
      }
    } finally {
      rmSync(signRoot, { recursive: true, force: true });
    }
  }
  const file = opt("--record", null);
  if (file) writeFileSync(file, `${JSON.stringify(recs, null, 2)}\n`);
  console.log(`${ok ? "PASS" : "FAIL"} restore-speed-browser`);
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`ERROR restore-speed-browser: ${e?.stack ?? e}`);
      process.exit(2);
    },
  );
}
