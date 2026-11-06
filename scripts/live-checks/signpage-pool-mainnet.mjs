#!/usr/bin/env node
// Live check of card signpage-pool-mainnet: SIGN_HOST's mainnet build runs the same pool flow and proof queue as the
// testnet build (packages/signpage/src/pool-testnet.ts, which main.ts now builds on every build), and only the pin
// tables and the RPCs differ. Mainnet pins no pool yet, so the deployed page must refuse every pool kind and read
// nothing for it. It reads what SIGN_HOST serves:
//   1. SIGN_HOST's /app.js is the one its index.html pins, and it has the sha384 of this checkout's signing page bundle
//      (packages/signpage/public/app.js), so the deployed page is this release's;
//   2. that bundle carries the flow and the queue (QUEUE below: the deposit and sell locks, the proof queue's own
//      refusal and the helper's pool routes), and none of the testnet build's pins or providers (signpage-pool-flow's
//      TESTNET_ONLY);
//   3. SIGN_HOST's served connect-src names the mainnet pair the queue reads (provider A and the helper's keyed route,
//      packages/signpage/src/trade.ts);
//   4. in a fresh browser, SIGN_HOST opened top-level frames APP_HOST, which Playwright answers with a probe page; on
//      the shell's ready the probe asks pool.sell (a mainnet USDC sell), pool.deposit, pool.buy and pool.withdraw on
//      Solana. Each is refused not_allowed, and the page sends no request to the pair, the other Solana RPC its CSP
//      allows (api.mainnet-beta.solana.com) or the helper's pool routes. A pinned pool
//      reads the sold token's mint on the pair before anything else (src/pool-kinds.ts), seed or not, so a refusal with
//      no read is the missing pin's.
// Not read here, and why: a real mainnet note's deposit, proof, buy, sell and withdraw on the deployed page wait for
// SOL_POOLS.mainnet (card pool-sol-deploy-mainnet) and the funded run of card pool-sol-mainnet-run; until then the
// pinned mainnet build is proven by packages/signpage/test/main-mainnet-pools.test.ts (a planted pin, test only).
//   node scripts/live-checks/signpage-pool-mainnet.mjs [--record <file>]
//   node scripts/live-checks/signpage-pool-mainnet.mjs --local [<dir>] [--record <file>]
//     --local: no network; Playwright answers SIGN_HOST from a build dir under its own _headers (default: this
//     checkout's packages/signpage as deploy.mjs builds it), and the pair and the helper with 503
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";
import { TESTNET_ONLY } from "./signpage-pool-flow.mjs";
import { headersOf } from "./signpage-postmessage.mjs";

const KEY = "signpage-pool-mainnet";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_URL = "https://sign.confidential.unrealized.trade/";
export const APP_HOST = "https://confidential.unrealized.trade";
const HELPER_HOST = "https://api.confidential.unrealized.trade";
/** The page's mainnet Solana pair (packages/signpage/src/trade.ts SOLANA_PROVIDER_A and TRADE_HELPER's route). */
export const PAGE_PAIR = ["https://solana-rpc.publicnode.com", `${HELPER_HOST}/v1/rpc/solana`];
/** What only the pool flow and its queue carry, written out here: src/pool-deposit.ts POOL_DEPOSIT_LOCK, src/pool-sell.ts
 *  POOL_SELL_LOCK, wallet/src/pool/queue.ts's closed refusal, and the helper routes the flow calls. */
export const QUEUE = ["ct-pool/deposit", "ct-pool/sell", "the proof queue is closed", "/v1/pool/fee?cluster=", "/v1/pool/solana/send"];
/** The other Solana RPC SIGN_HOST's connect-src allows (the trade path's): a pool read sent there is one too. */
const SOLANA_OTHER = "https://api.mainnet-beta.solana.com";
/** Requests a pinned pool's kinds make: the pair (the helper's route reads the sell Ws' holdings too), any other Solana
 *  RPC the page may reach, and the helper's pool routes. */
const POOL_READ = (u) => u.startsWith(PAGE_PAIR[0]) || u.startsWith(PAGE_PAIR[1]) || u.startsWith(SOLANA_OTHER) || u.startsWith(`${HELPER_HOST}/v1/pool/`);
/** Mainnet USDC: the sold token, an address of the chain, so a pinned pool would read its mint. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const ASKS = [
  { type: "pool.sell", chain: "solana", token: USDC_MINT, amount: "1", slippage_bps: 100 },
  { type: "pool.deposit", chain: "solana", amount: "0.02" },
  { type: "pool.buy", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "0.001", slippage_bps: 100 },
  { type: "pool.withdraw", chain: "solana", return_key: "portfolio" },
];
const READY_MS = 10_000;
const ANSWER_MS = 10_000;
const SETTLE_MS = 1_500;
const TREE_BUNDLE = path.join(REPO, "packages/signpage/public/app.js");
const sha384 = (b) => `sha384-${createHash("sha384").update(b).digest("base64")}`;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const b = rec.bundle ?? {};
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(rec.index ?? "")?.[1];
  say(b.status === 200 && pin === b.sha384, `SIGN_HOST's index.html pins the /app.js it serves: ${pin ?? "no pin"}${pin === b.sha384 ? "" : `, served ${b.sha384 ?? `HTTP ${b.status ?? "none"}`}`}`);
  say(b.status === 200 && typeof rec.treeBundle === "string" && b.sha384 === rec.treeBundle,
    `SIGN_HOST's /app.js is this release's (this checkout's bundle): ${b.sha384 === rec.treeBundle ? b.sha384 : `served ${b.sha384 ?? "none"}, the checkout's ${rec.treeBundle}`}`);
  const missing = QUEUE.filter((m) => !(b.queue ?? []).includes(m));
  say(b.status === 200 && missing.length === 0, `the served bundle carries the pool flow and its proof queue: ${missing.length ? `missing ${missing.map((m) => JSON.stringify(m)).join(", ")}` : "all of them"}`);
  say(b.status === 200 && Array.isArray(b.testnet) && b.testnet.length === 0, `the served bundle carries no testnet pin or provider: ${Array.isArray(b.testnet) ? (b.testnet.length ? b.testnet.join(", ") : "none") : "not read"}`);
  const src = (/(?:^|;)\s*connect-src\s+([^;]*)/.exec(rec.csp ?? "")?.[1] ?? "").split(/\s+/);
  const reach = PAGE_PAIR.map((u) => new URL(u).origin).filter((o) => !src.includes(o));
  say(src.length > 1 && reach.length === 0, `SIGN_HOST's connect-src names the queue's mainnet pair: ${reach.length ? `not ${reach.join(", ")}` : PAGE_PAIR.map((u) => new URL(u).origin).join(" and ")}`);
  const p = rec.probe ?? {};
  say(p.ready === true, `SIGN_HOST's shell framed the probe and posted ready: ${p.ready === true ? "yes" : "no"}`);
  for (const ask of ASKS) {
    const a = (p.answers ?? {})[ask.type];
    const code = a?.ok === false ? a.error?.code : a?.ok === true ? "ok" : "none";
    say(code === "not_allowed", `${ask.type} on Solana with no mainnet pin: ${code}, want not_allowed`);
  }
  const reads = Array.isArray(p.poolReads) ? p.poolReads : null;
  say(reads !== null && reads.length === 0, `no request to the pair, ${new URL(SOLANA_OTHER).host} or the helper's pool routes for them: ${reads === null ? "not recorded" : reads.length ? reads.join(", ") : "none"}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** packages/signpage built as its deploy builds it (deploy.mjs build(): index.html and public/ copied). */
function build() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-pool-mainnet-sign-"));
  copyFileSync(path.join(REPO, "packages/signpage/index.html"), path.join(out, "index.html"));
  cpSync(path.join(REPO, "packages/signpage/public"), out, { recursive: true });
  return out;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
function serveDir(dir) {
  const h = headersOf(readFileSync(path.join(dir, "_headers"), "utf8"));
  return (r) => {
    const p = new URL(r.request().url()).pathname;
    let file = path.join(dir, p === "/" ? "index.html" : p);
    // a path with no file is the index, as SIGN_HOST answers it (Pages with no 404.html), /_headers included
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || p === "/_headers") file = path.join(dir, "index.html");
    return r.fulfill({ status: 200, headers: { ...h, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }, body: readFileSync(file) });
  };
}

// The APP_HOST frame inside SIGN_HOST's shell: on the shell's ready, asks each pool kind and logs every answer.
const appProbeHtml = (signOrigin) => `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
addEventListener("message", (e) => {
  window.__log.push({ fromParent: e.source === parent, data: e.data });
  if (e.source !== parent || e.data?.type !== "ready" || window.__ids) return;
  window.__ids = {};
  parent.postMessage(${JSON.stringify({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION })}, ${JSON.stringify(signOrigin)}); // the kit's hello first, as the kit's client sends it (card kit-frame-version): an app that names none is kit-v1.4
  for (const a of ${JSON.stringify(ASKS)}) {
    const m = { v: 1, id: crypto.randomUUID(), ...a };
    window.__ids[a.type] = m.id;
    parent.postMessage(m, ${JSON.stringify(signOrigin)});
  }
});
</script></body>`;

async function probe(browser, { signUrl, dir }) {
  const signOrigin = new URL(signUrl).origin;
  const ctx = await browser.newContext();
  await ctx.route((u) => u.origin === APP_HOST, (r) => r.fulfill({ status: 200, contentType: "text/html", body: appProbeHtml(signOrigin) }));
  if (dir) {
    await ctx.route((u) => u.origin === signOrigin, serveDir(dir));
    // no network: the pair and the helper answer 503 here
    for (const o of new Set([...PAGE_PAIR.map((u) => new URL(u).origin), SOLANA_OTHER, HELPER_HOST])) await ctx.route((u) => u.origin === o, (r) => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  }
  const all = [];
  ctx.on("request", (req) => all.push(req.url()));
  const page = await ctx.newPage();
  await page.goto(signUrl, { waitUntil: "load" });
  const app = () => page.frames().find((f) => f.url().startsWith(`${APP_HOST}/`));
  const read = async (prev) => (app() ? await app().evaluate(() => ({ log: window.__log, ids: window.__ids ?? null })).catch(() => prev) : prev);
  let out = { log: [], ids: null };
  const until = Date.now() + READY_MS + ANSWER_MS;
  const answered = (o) => o.ids && Object.values(o.ids).every((id) => o.log.some((m) => m.fromParent && m.data?.id === id));
  for (; Date.now() < until && !answered(out); await page.waitForTimeout(100)) out = await read(out);
  await page.waitForTimeout(SETTLE_MS);
  out = await read(out);
  await ctx.close();
  const answers = {};
  for (const [type, id] of Object.entries(out.ids ?? {})) {
    const m = out.log.find((x) => x.fromParent && x.data?.id === id)?.data;
    if (m) answers[type] = { ok: m.ok, ...(m.ok ? { result: m.result } : { error: m.error }) };
  }
  return { ready: out.log.some((m) => m.fromParent && m.data?.type === "ready"), answers, poolReads: all.filter(POOL_READ) };
}

export async function collect({ browser, signUrl = SIGN_URL, dir = null, source }) {
  const at = new Date().toISOString();
  const treeBundle = sha384(readFileSync(TREE_BUNDLE));
  let index;
  let csp;
  let bytes;
  let status;
  if (dir) {
    index = readFileSync(path.join(dir, "index.html"), "utf8");
    csp = headersOf(readFileSync(path.join(dir, "_headers"), "utf8"))["content-security-policy"] ?? null;
    bytes = readFileSync(path.join(dir, "app.js"));
    status = 200;
  } else {
    const r = await fetch(signUrl, { signal: AbortSignal.timeout(15_000) });
    index = await r.text();
    csp = r.headers.get("content-security-policy");
    const js = await fetch(new URL("/app.js", signUrl), { signal: AbortSignal.timeout(15_000) });
    status = js.status;
    bytes = new Uint8Array(await js.arrayBuffer());
  }
  const text = new TextDecoder().decode(bytes);
  const bundle = { status, sha384: sha384(bytes), queue: QUEUE.filter((m) => text.includes(m)), testnet: TESTNET_ONLY.filter((s) => text.includes(s)) };
  const p = await probe(browser, { signUrl, dir });
  return { check: KEY, at, source, browser: browser.version(), treeBundle, index, csp, bundle, probe: p };
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const local = args.includes("--local");
  const given = local && opt("--local") && !opt("--local").startsWith("--") ? path.resolve(opt("--local")) : null;
  const dir = local ? (given ?? build()) : null;
  const browser = await launchBrowser("chromium");
  let rec;
  try {
    rec = await collect({ browser, dir, source: local ? `local, SIGN_HOST answered from ${given ?? "this checkout's packages/signpage build"}` : `live ${SIGN_URL}` });
  } finally {
    await browser.close();
    if (local && !given) rmSync(dir, { recursive: true, force: true });
  }
  if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`CARD ${KEY} / live: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.at})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
