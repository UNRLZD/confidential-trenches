#!/usr/bin/env node
// Live check of card kit-deposit-assets-dry on SIGN_HOST (https://confidential.unrealized.trade). What it holds:
// an app can ask the signing page which assets it takes for a deposit (request kind deposit.assets, params {}) and what
// a deposit of an amount would cost (deposit.dry, params { origin_asset, amount }), before it has any account, and the
// page answers both from 1Click alone, with nothing of the user's in the request:
//   - deposit.assets answers exactly the three USDC assets of the kit's ONECLICK_USDC_ASSETS (near, sol, base): each in
//     1Click's own /v0/tokens as USDC with the same decimals and the chain the answer names (1Click says "sol" for
//     solana), max_usd "1000", and a min that is a decimal of at least 1 USDC (the vault's MIN_DEPOSIT) and under 1.1
//     (the 1 USDC plus 1Click's withdraw fee, a few tenths of a percent), and under max_usd;
//   - deposit.dry for 25 USDC from Solana answers amount_out_usd, min_amount_out_usd, fee_usd and time_estimate_s with
//     min_amount_out_usd <= amount_out_usd <= 25, fee_usd exactly 25 - amount_out_usd (decimal arithmetic, no float),
//     amount_out_usd within 50 bps of what 1Click answers the same dry quote with no key (this check posts the request
//     body the page sent, deadline renewed, to 1Click directly: both paths take 1Click's 1 bp between two USDC assets,
//     card oneclick-partner-fee-live, so the gap is price drift), and time_estimate_s within a factor of 2 of that quote's timeEstimate (two paths, two
//     estimates; an exact match would fail on a busy second);
//   - every request the page sends to the helper's 1Click proxy is a POST /v0/tokens (the helper takes every proxy call
//     as a POST and asks 1Click with GET, apps/helper/src/server.ts) or a POST /v0/quote with dry: true
//     whose recipient and refundTo are the fixed public placeholder PLACEHOLDER, and at least one dry quote is sent for
//     deposit.dry: nothing of the user's reaches 1Click for a question anyone may ask;
//   - SIGN_HOST's /app.js is the one its index.html pins (its sha384), as kit-frame-version checks.
// The run: SIGN_HOST as a top-level page, as it is opened, frames APP_HOST, which Playwright answers with a probe page
// (no request reaches the real APP_HOST); once the shell's ready arrives the probe posts the kit's hello, asks
// deposit.assets, and on its answer asks deposit.dry, and the run records both answers and every request the page sends
// to the helper's 1Click proxy (url, method, body, and which of the two asks it followed). The helper is the real one in
// every mode. A page before this card answers both kinds not_allowed.
//   node scripts/live-checks/kit-deposit-assets-dry.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/kit-deposit-assets-dry.mjs --local <build dir> [--record <file>]
//     the same run with Playwright answering SIGN_HOST from a build dir under its own _headers (the helper and 1Click
//     are still reached). A build dir is made as packages/signpage/scripts/deploy.mjs build() makes it, minus the
//     prover's setup files this run does not load: in the tree to check (its public/app.js and index.html committed,
//     as build-app.mjs wrote them; `node packages/signpage/scripts/build-app.mjs --check` holds that),
//       D=$(mktemp -d) && cp packages/signpage/index.html "$D/" && cp -R packages/signpage/public/. "$D/"
//     then, from any tree holding this file:
//       node scripts/live-checks/kit-deposit-assets-dry.mjs --local "$D" --record <file>
//     --local with no dir builds the same from the tree this file is in.
//   node scripts/live-checks/kit-deposit-assets-dry.mjs --answer <file>     judge a recorded answer, no network
// --record writes the answer: everything judge() reads, so the test can replay it. PASS exit 0, FAIL exit 1, error
// exit 2; the last line is "PASS kit-deposit-assets-dry" or "FAIL kit-deposit-assets-dry", each failure a "BAD ..." line.
import "../net-window.mjs";
import { cpSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";
import { named } from "./record-names.mjs";

const KEY = "kit-deposit-assets-dry";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://ct-app.unrealized.trade";
export const SIGN_URL = "https://confidential.unrealized.trade/";
export const HELPER_1CLICK = "https://ct-api.unrealized.trade/v1/proxy/oneclick";
export const ONECLICK = "https://1click.chaindefuser.com";
/** The fixed public id the page names as recipient and refundTo: never anything of the user's. */
export const PLACEHOLDER = "4b742e2fa54135408f95d6be00483527709b33281f3d1836ae3e83371caae5c0";
export const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** The kit's ONECLICK_USDC_ASSETS (packages/kit/src/checks/oneclick.ts), each with the chain the answer names. */
export const ASSETS = { [NEAR_USDC]: "near", [SOL_USDC]: "solana", [BASE_USDC]: "base" };
/** What 1Click calls each chain the answer names. */
export const ONECLICK_CHAIN = { near: "near", solana: "sol", base: "base" };
export const CODES = ["below_min", "above_max", "not_available", "busy", "down", "quote_check_failed", "not_allowed"];
export const READY_MS = 5_000;
/** deposit.assets reads /v0/tokens and quotes three assets through the helper; deposit.dry quotes one. */
export const ASSETS_MS = 30_000;
export const DRY_MS = 20_000;
const SETTLE_MS = 1_500;
/** What the dry run asks: 25 USDC from Solana. */
export const ASKED = { origin_asset: SOL_USDC, amount: "25" };
const ASKED_UNITS = "25000000";

// ------------------------------------------------------------------------------------------------ decimals
const DEC = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;
const SCALE = 18;
/** A decimal string as a BigInt of 1e-18 units, or null when it is not a plain decimal (no sign, no exponent). */
export function dec(s) {
  if (typeof s !== "string" || !DEC.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return BigInt(i + f.padEnd(SCALE, "0"));
}
const ONE = 10n ** BigInt(SCALE);
const show = (v) => JSON.stringify(v);

// ------------------------------------------------------------------------------------------------ the verdict
/** The verdict on an answer (what collect() returns): { ok, lines }, each line a "BAD ..." failure. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.appJs?.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.ready !== true) bad("the shell's ready did not arrive in the APP_HOST frame");

  const signOrigin = (() => {
    try {
      return new URL(a.signUrl).origin;
    } catch {
      return null;
    }
  })();
  const answerTo = (id) => (a?.log ?? []).filter((m) => m.fromParent && m.origin === signOrigin && id && m.data?.id === id).map((m) => m.data);
  const answered = (kind, id) => {
    const got = answerTo(id);
    if (got.length !== 1) {
      bad(`${kind}: ${got.length} answer(s) to its id, want 1`);
      return null;
    }
    const r = got[0];
    if (r.ok !== true) {
      const code = r.error?.code;
      bad(`${kind} answered ${r.ok === false ? `refused ${show(code)}` : "neither ok nor refused"}, want ok`);
      if (r.ok === false && !CODES.includes(code)) bad(`${kind} refused with ${show(code)}, not one of the card's codes`);
      return null;
    }
    return r.result ?? {};
  };

  // ---- deposit.assets
  const result = answered("deposit.assets", a?.ids?.assets);
  if (result) {
    const list = Array.isArray(result.assets) ? result.assets : null;
    const tokens = a?.oneclick?.tokens ?? [];
    if (!list) bad("deposit.assets: no assets list");
    else {
      const seen = list.map((x) => x?.origin_asset);
      for (const id of Object.keys(ASSETS)) if (!seen.includes(id)) bad(`deposit.assets does not list ${id}`);
      for (const id of seen) if (!Object.hasOwn(ASSETS, id)) bad(`deposit.assets lists ${show(id)}, not one of the kit's three USDC assets`);
      if (new Set(seen).size !== seen.length) bad("deposit.assets lists an asset twice");
      for (const x of list) {
        const id = x?.origin_asset;
        const label = `deposit.assets ${typeof id === "string" ? id : show(id)}`;
        if (!Object.hasOwn(ASSETS, id)) continue;
        if (x.chain !== ASSETS[id]) bad(`${label}: chain ${show(x.chain)}, want ${show(ASSETS[id])}`);
        if (x.symbol !== "USDC") bad(`${label}: symbol ${show(x.symbol)}, want "USDC"`);
        const t = tokens.find((k) => k?.assetId === id);
        if (!t) bad(`${label}: not in 1Click's /v0/tokens`);
        else {
          if (t.symbol !== "USDC") bad(`${label}: 1Click's symbol is ${show(t.symbol)}, want "USDC"`);
          if (x.decimals !== t.decimals) bad(`${label}: decimals ${show(x.decimals)}, 1Click's ${show(t.decimals)}`);
          if (t.blockchain !== ONECLICK_CHAIN[x.chain]) bad(`${label}: 1Click's blockchain ${show(t.blockchain)}, not ${show(ONECLICK_CHAIN[x.chain])} for chain ${show(x.chain)}`);
        }
        if (x.max_usd !== "1000") bad(`${label}: max_usd ${show(x.max_usd)}, want "1000"`);
        const min = dec(x.min);
        const max = dec(x.max_usd);
        if (min === null) bad(`${label}: min ${show(x.min)} is not a decimal`);
        else {
          if (min < ONE) bad(`${label}: min ${x.min} is below 1 USDC, the vault's MIN_DEPOSIT`);
          if (min >= (ONE * 11n) / 10n) bad(`${label}: min ${x.min} is not under 1.1 (1 USDC plus a few tenths of a percent)`);
          if (max !== null && min >= max) bad(`${label}: min ${x.min} is not under max_usd ${x.max_usd}`);
        }
      }
    }
  }

  // ---- deposit.dry
  const dry = answered("deposit.dry", a?.ids?.dry);
  if (dry) {
    const out = dec(dry.amount_out_usd);
    const floor = dec(dry.min_amount_out_usd);
    const fee = dec(dry.fee_usd);
    const asked = dec(a?.asked?.amount);
    if (out === null) bad(`deposit.dry: amount_out_usd ${show(dry.amount_out_usd)} is not a decimal`);
    if (floor === null) bad(`deposit.dry: min_amount_out_usd ${show(dry.min_amount_out_usd)} is not a decimal`);
    if (fee === null) bad(`deposit.dry: fee_usd ${show(dry.fee_usd)} is not a decimal`);
    if (asked === null) bad("deposit.dry: the run recorded no amount asked");
    if (out !== null && floor !== null && floor > out) bad(`deposit.dry: min_amount_out_usd ${dry.min_amount_out_usd} is above amount_out_usd ${dry.amount_out_usd}`);
    if (out !== null && asked !== null && out > asked) bad(`deposit.dry: amount_out_usd ${dry.amount_out_usd} is above the ${a.asked.amount} asked`);
    if (out !== null && fee !== null && asked !== null && asked - out !== fee) bad(`deposit.dry: fee_usd ${dry.fee_usd} is not ${a.asked.amount} - amount_out_usd ${dry.amount_out_usd}`);
    if (!Number.isInteger(dry.time_estimate_s) || dry.time_estimate_s < 0) bad(`deposit.dry: time_estimate_s ${show(dry.time_estimate_s)} is not a whole number of seconds`);
    const direct = a?.oneclick?.quote;
    // 1Click answers a quote 201 (wallet.md D52; read 6 Nov 14:37Z), 200 too
    const q = direct?.status === 200 || direct?.status === 201 ? direct.body?.quote : null;
    if (!q) bad(`deposit.dry: no keyless 1Click dry quote to compare with${direct ? ` (HTTP ${show(direct.status)})` : ""}`);
    else {
      const units = typeof q.amountOut === "string" && /^[0-9]+$/.test(q.amountOut) ? BigInt(q.amountOut) * 10n ** BigInt(SCALE - 6) : null;
      if (units === null) bad(`deposit.dry: the keyless 1Click quote has amountOut ${show(q.amountOut)}`);
      else if (out !== null) {
        const diff = out > units ? out - units : units - out;
        if (diff * 10_000n > 50n * units) bad(`deposit.dry: amount_out_usd ${dry.amount_out_usd} is more than 50 bps from the keyless 1Click quote's amountOut ${q.amountOut} (6 decimals)`);
      }
      const t = dry.time_estimate_s;
      if (Number.isInteger(t) && Number.isInteger(q.timeEstimate) && !(t * 2 >= q.timeEstimate && t <= q.timeEstimate * 2))
        bad(`deposit.dry: time_estimate_s ${t} is not within a factor of 2 of the keyless 1Click quote's timeEstimate ${q.timeEstimate}`);
    }
  }

  // ---- what the page sent to the helper's 1Click proxy
  const sent = a?.helper ?? [];
  for (const r of sent) {
    const what = `${r?.method} ${r?.url}`;
    if (r?.method === "POST" && r.url === `${HELPER_1CLICK}/v0/tokens`) continue;
    if (r?.method === "POST" && r.url === `${HELPER_1CLICK}/v0/quote`) {
      const b = r.body;
      if (b === null || typeof b !== "object") bad(`the page sent ${what} with no readable body`);
      else {
        if (b.dry !== true) bad(`the page sent ${what} with dry ${show(b.dry)}, a quote that is not dry`);
        if (b.recipient !== PLACEHOLDER) bad(`the page sent ${what} naming recipient ${show(b.recipient)}, not the placeholder`);
        if (b.refundTo !== PLACEHOLDER) bad(`the page sent ${what} naming refundTo ${show(b.refundTo)}, not the placeholder`);
      }
      continue;
    }
    bad(`the page sent ${what}, neither POST /v0/tokens nor POST /v0/quote`);
  }
  const dryQuotes = sent.filter((r) => r?.phase === "dry" && r.method === "POST" && r.url === `${HELPER_1CLICK}/v0/quote` && r.body?.dry === true);
  if (dryQuotes.length === 0) bad("no dry quote request was sent for deposit.dry");
  else if (!dryQuotes.some((r) => r.body.originAsset === SOL_USDC && r.body.amount === ASKED_UNITS)) bad("none of the dry quote requests for deposit.dry is for 25 USDC from Solana");

  return { ok: lines.length === 0, lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** The headers SIGN_HOST's _headers sets on every path: its one /* rule (the deploy gate refuses any other shape). */
export function headersOf(text) {
  const h = {};
  let all = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      all = line.trim() === "/*";
      continue;
    }
    const kv = /^\s+([^:\s]+):\s*(.*)$/.exec(line);
    if (all && kv) h[kv[1].toLowerCase()] = kv[2];
  }
  return h;
}

/** packages/signpage as deploy.mjs build() makes it, minus the prover's setup files: index.html and public/ copied. */
function build() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-dep-assets-dry-"));
  copyFileSync(path.join(REPO, "packages/signpage/index.html"), path.join(out, "index.html"));
  cpSync(path.join(REPO, "packages/signpage/public"), out, { recursive: true });
  return out;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/** Answers every request to SIGN_HOST from the build in `dir`, under its own _headers, as Pages serves it. */
function serveDir(dir) {
  const h = headersOf(readFileSync(path.join(dir, "_headers"), "utf8"));
  return (r) => {
    const p = new URL(r.request().url()).pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || p === "/_headers") return r.fulfill({ status: 404, headers: h, body: "" });
    return r.fulfill({ status: 200, headers: { ...h, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }, body: readFileSync(file) });
  };
}

// The APP_HOST frame inside SIGN_HOST's shell: records every message it receives; __ask(kind, params) posts the kit's
// hello (once) and then the request, and returns the request's id.
const appProbeHtml = (signOrigin) => `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
addEventListener("message", (e) => window.__log.push({ t: performance.now(), origin: e.origin, fromParent: e.source === parent, data: e.data }));
window.__ask = (kind, params) => {
  if (!window.__hello) {
    window.__hello = true;
    parent.postMessage(${JSON.stringify({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION })}, ${JSON.stringify(signOrigin)}); // the kit's hello first, as the kit's client sends it (card kit-frame-version): an app that names none is kit-v1.4
  }
  const m = kind === "assets" ? { v: 1, id: crypto.randomUUID(), type: "deposit.assets" } : { v: 1, id: crypto.randomUUID(), type: "deposit.dry", ...params };
  parent.postMessage(m, ${JSON.stringify(signOrigin)});
  return m.id;
};
</script></body>`;

/** The page's side of the run: the shell's ready, both answers, the requests to the helper's 1Click proxy, the pin. */
async function pageRun(browser, { signUrl, dir }) {
  const signOrigin = new URL(signUrl).origin;
  const ctx = await browser.newContext();
  await ctx.route((u) => u.origin === APP_HOST, (r) => r.fulfill({ status: 200, contentType: "text/html", body: appProbeHtml(signOrigin) }));
  if (dir) await ctx.route((u) => u.origin === signOrigin, serveDir(dir));
  const helper = [];
  let phase = "assets";
  let index = null;
  let appJs = null;
  ctx.on("response", async (res) => {
    try {
      if (res.url() === new URL("/", signUrl).href && res.request().resourceType() === "document") index = await res.text();
      else if (res.url() === new URL("/app.js", signUrl).href && res.request().resourceType() === "script")
        appJs = { status: res.status(), sha384: `sha384-${createHash("sha384").update(await res.body()).digest("base64")}` };
    } catch {}
  });
  ctx.on("request", (req) => {
    if (!req.url().startsWith(`${HELPER_1CLICK}/`) && req.url() !== HELPER_1CLICK) return;
    let body = null;
    try {
      body = JSON.parse(req.postData() ?? "null");
    } catch {}
    helper.push({ phase, url: req.url(), method: req.method(), body });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(signUrl, { waitUntil: "load" });
  const app = () => page.frames().find((f) => f.url().startsWith(`${APP_HOST}/`));
  const read = async (prev) => {
    const f = app();
    return f ? await f.evaluate(() => window.__log).catch(() => prev) : prev;
  };
  let log = [];
  const waitFor = async (ms, done) => {
    for (const until = Date.now() + ms; Date.now() < until; await page.waitForTimeout(100)) {
      log = await read(log);
      if (done(log)) return true;
    }
    return false;
  };
  const ready = await waitFor(READY_MS, (l) => l.some((m) => m.fromParent && m.data?.type === "ready"));
  const ids = { assets: null, dry: null };
  if (ready) {
    ids.assets = await app().evaluate(() => window.__ask("assets"));
    await waitFor(ASSETS_MS, (l) => l.some((m) => m.data?.id === ids.assets));
    phase = "dry";
    ids.dry = await app().evaluate((p) => window.__ask("dry", p), ASKED);
    await waitFor(DRY_MS, (l) => l.some((m) => m.data?.id === ids.dry));
    await page.waitForTimeout(SETTLE_MS);
    log = await read(log);
  }
  await ctx.close();
  return { signUrl, ready, ids, asked: ASKED, log, helper, index, appJs, errors };
}

/** 1Click read directly, with no key: /v0/tokens (the USDC rows) and the dry quote the page sent, deadline renewed.
 *  A request that fails to connect is tried again, up to three times (a dry quote changes nothing). */
async function readOneClick(helper, fetchFn0 = fetch) {
  const fetchFn = async (url, init) => {
    for (let i = 1; ; i++) {
      try {
        return await fetchFn0(url, init);
      } catch (e) {
        if (i >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  };
  const t = await fetchFn(`${ONECLICK}/v0/tokens`, { redirect: "error" });
  if (t.status !== 200) throw new Error(`${ONECLICK}/v0/tokens: HTTP ${t.status}`);
  const all = await t.json();
  if (!Array.isArray(all)) throw new Error(`${ONECLICK}/v0/tokens: not a list`);
  const tokens = all.filter((x) => x?.symbol === "USDC" || Object.hasOwn(ASSETS, x?.assetId)).map((x) => ({ assetId: x.assetId, symbol: x.symbol, decimals: x.decimals, blockchain: x.blockchain }));
  const sent = helper.find((r) => r.phase === "dry" && r.method === "POST" && r.url === `${HELPER_1CLICK}/v0/quote` && r.body?.dry === true && r.body.originAsset === SOL_USDC && r.body.amount === ASKED_UNITS);
  let quote = null;
  let quoteRequest = null;
  if (sent) {
    quoteRequest = { ...sent.body, deadline: new Date(Date.now() + 30 * 60_000).toISOString() };
    const q = await fetchFn(`${ONECLICK}/v0/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(quoteRequest), redirect: "error" });
    const body = await q.json().catch(() => null);
    // 1Click's signature is never judged, and an "ed25519:" string is what the secret scan refuses: never recorded
    if (body && typeof body === "object") delete body.signature;
    quote = { status: q.status, body };
  }
  return { tokens, quoteRequest, quote };
}

export async function collect({ browser, signUrl = SIGN_URL, dir, source, fetchFn = fetch }) {
  const run = await pageRun(browser, { signUrl, dir });
  const oneclick = await readOneClick(run.helper, fetchFn);
  return { source, at: new Date().toISOString(), browser: browser.version(), ...run, oneclick };
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const record = opt("--record");
  let answer;
  if (opt("--answer")) answer = JSON.parse(readFileSync(opt("--answer"), "utf8"));
  else {
    const local = args.includes("--local");
    const given = local && opt("--local") && !opt("--local").startsWith("--") ? path.resolve(opt("--local")) : null;
    const dir = local ? (given ?? build()) : null;
    const browser = await launchBrowser("chromium");
    try {
      answer = local
        ? await collect({ browser, signUrl: SIGN_URL, dir, source: `local, SIGN_HOST answered from ${given ? named(given) : "packages/signpage's build (index.html and public/ copied)"}` })
        : await collect({ browser, signUrl: opt("--url") ?? SIGN_URL, source: "live" });
    } finally {
      await browser.close();
      if (local && !given) rmSync(dir, { recursive: true, force: true });
    }
  }
  if (record) writeFileSync(record, `${JSON.stringify(answer, null, 1)}\n`);
  const v = judge(answer);
  for (const l of v.lines) console.log(l);
  console.log(`${v.ok ? "PASS" : "FAIL"} ${KEY}`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERROR ${KEY}: ${e?.stack ?? e}`);
    process.exit(2);
  });
}
