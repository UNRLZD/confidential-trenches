#!/usr/bin/env node
// Live check of card deposit-quote-no-liquidity on SIGN_HOST (https://confidential.unrealized.trade): a deposit quote
// 1Click answers 400 "No liquidity available" (no solver quoted that size at that second: 25 USDC from Solana into NEAR
// USDC on 10 Nov 07:04-07:43Z, through the deployed helper) is asked again by the page, the same request, and the answer
// that follows is checked and shown as one answer is. The run, with the served page and the real helper:
//   - SIGN_HOST as a top-level page frames APP_HOST, which Playwright answers with a probe page (no request reaches the
//     real APP_HOST); once the shell's ready arrives the probe posts the kit's hello and asks deposit.dry for 25 USDC
//     from Solana, the sheet's own read as the amount is typed;
//   - the first PLANTED of the page's quote requests to the helper's 1Click proxy are answered here with 1Click's own
//     no-liquidity answer (400, the body the deployed helper passed on 2026-11-10T19:06:57Z); every later one goes to the
//     real helper, which answers it from 1Click.
// PASS when the page answered deposit.dry with the quote lines after asking the same request PLANTED + 1 times, each
// re-ask at least the page's pause after the answer before it (wallet/src/deposit/quote.ts NO_LIQUIDITY_PAUSES_MS, 500
// then 1000 ms, 10% under for the clock), all inside 14 s (the page's read deadline). FAIL on a page that answers after
// one ask (a page before this card answered not_available there), on re-asks of another request, too soon or too many,
// and on anything but the lines. INCONCLUSIVE (exit 3) when the real helper's own answer to the last ask was 1Click's
// no-liquidity 400 again, or 1Click's own slowness (503 with cause timeout, 5xx or send): 1Click's, not the page's.
// The quote is dry: nothing is signed, nothing of anyone's is named, no money moves; the run reaches the helper once.
// After: sign
//   node scripts/live-checks/deposit-quote-no-liquidity.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/deposit-quote-no-liquidity.mjs --local [<build dir>] [--record <file>]
//     SIGN_HOST answered from a build dir as packages/signpage/scripts/deploy.mjs builds it (index.html and public/),
//     with no dir the build of the tree this file is in (scripts/signpage-built.mjs); the helper is the real one
//   node scripts/live-checks/deposit-quote-no-liquidity.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> deposit-quote-no-liquidity",
// each failure a "BAD ..." line.
import "../net-window.mjs";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { DEPOSIT_DRY_PLACEHOLDER, ONECLICK_USDC_ASSETS, SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";
import { signBuilt } from "../signpage-built.mjs";
import { named } from "./record-names.mjs";

const KEY = "deposit-quote-no-liquidity";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://ct-app.unrealized.trade";
export const SIGN_URL = "https://confidential.unrealized.trade/";
export const QUOTE_URL = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
export const SOL_USDC = ONECLICK_USDC_ASSETS[1];
/** What the run asks: 25 USDC from Solana, the size 1Click had no liquidity for. */
export const ASKED = Object.freeze({ origin_asset: SOL_USDC, amount: "25" });
export const ASKED_UNITS = "25000000";
/** How many of the page's quote requests this run answers with 1Click's no-liquidity 400: the page's two re-asks' worth. */
export const PLANTED = 2;
/** The page's pauses before each re-ask (wallet/src/deposit/quote.ts NO_LIQUIDITY_PAUSES_MS), read here as data. */
export const PAUSES_MS = Object.freeze([500, 1_000]);
/** The page's read deadline (packages/signpage/src/deposit-wire.ts DEPOSIT_READ_DEADLINE_MS). */
export const DEADLINE_MS = 14_000;
/** 1Click's no-liquidity answer as the deployed helper passed it on 2026-11-10T19:06:57Z (a dry quote of NEAR USDC into a
 *  meme no solver quotes; the card's 25 USDC reads gave the same status and message). */
export const NO_LIQUIDITY_BODY = '{"message":"No liquidity available","correlationId":"2357c43d-9fdf-4c05-9732-edaa447fcb6a","timestamp":"2026-11-10T19:06:57.250Z","path":"/v0/quote"}';
const NO_LIQUIDITY = /^No liquidity available\b/;
/** The helper's 503 causes that are 1Click's own (apps/helper/src/proxy/proxy.ts Cause), as deposit-sheet-oneclick-budget reads them. */
const VENDOR_CAUSES = Object.freeze(["timeout", "5xx", "send"]);
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });
const READY_MS = 5_000;
const ANSWER_MS = 20_000;
const MESSAGE_MAX = 120;
const DEC = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const show = (v) => JSON.stringify(v)?.slice(0, 200);

// ------------------------------------------------------------------------------------------------ the verdict
/** The verdict on a run (what collect() returns): { verdict, ok, lines }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  if (a?.ready !== true) bad("the shell's ready did not arrive in the APP_HOST frame");
  const quotes = Array.isArray(a?.quotes) ? a.quotes : [];
  const answer = (Array.isArray(a?.log) ? a.log : []).find((m) => m?.fromParent && m.data?.id === a?.id)?.data;
  if (a?.ready === true && quotes.length === 0) bad("the page sent no quote request for deposit.dry");
  const first = quotes[0]?.body;
  if (first !== undefined) {
    if (first?.dry !== true || first.originAsset !== SOL_USDC || first.amount !== ASKED_UNITS) bad(`the first quote request is not the dry 25 USDC from Solana asked: ${show(first)}`);
    if (first?.recipient !== DEPOSIT_DRY_PLACEHOLDER || first?.refundTo !== DEPOSIT_DRY_PLACEHOLDER) bad("the first quote request names someone other than the public placeholder");
  }
  quotes.slice(1).forEach((q, i) => {
    if (JSON.stringify(q.body) !== JSON.stringify(first)) bad(`re-ask ${i + 1} is not the same request: ${show(q.body)}`);
  });
  for (let i = 1; i < quotes.length; i++) {
    const gap = quotes[i].t - (quotes[i - 1].answeredT ?? quotes[i - 1].t);
    const want = PAUSES_MS[i - 1];
    if (want === undefined) bad(`the page asked ${quotes.length} times, more than ${PAUSES_MS.length + 1}`);
    else if (!(gap >= want * 0.9)) bad(`re-ask ${i} went ${Math.round(gap)} ms after the answer before it, under the page's ${want} ms pause`);
  }
  const real = quotes[PLANTED];
  const vendor = real !== undefined && ((real.status === 400 && typeof real.message === "string" && NO_LIQUIDITY.test(real.message)) || (real.status === 503 && VENDOR_CAUSES.includes(real.cause)));
  if (answer === undefined) bad("the page sent no answer to deposit.dry");
  else if (answer.ok === true) {
    const r = answer.result ?? {};
    for (const k of ["amount_out_usd", "min_amount_out_usd", "fee_usd"]) if (typeof r[k] !== "string" || !DEC.test(r[k])) bad(`deposit.dry: ${k} ${show(r[k])} is not a decimal`);
    if (typeof r.amount_out_usd === "string" && DEC.test(r.amount_out_usd) && Number(r.amount_out_usd) > 25) bad(`deposit.dry: amount_out_usd ${r.amount_out_usd} is above the 25 asked`);
    if (quotes.length !== PLANTED + 1) bad(`the page answered the lines after ${quotes.length} quote requests, want ${PLANTED + 1}: ${PLANTED} planted no-liquidity answers, then the real one`);
    if (real !== undefined && real.status !== 200 && real.status !== 201) bad(`the page showed lines from a ${show(real.status)} answer`);
  } else if (!vendor) {
    bad(`deposit.dry answered ${show(answer.error ?? answer)} after ${quotes.length} quote request${quotes.length === 1 ? "" : "s"}, want the quote lines after ${PLANTED + 1}`);
  }
  if (quotes.length > 0 && answer !== undefined && typeof a.answeredT === "number" && a.answeredT - quotes[0].t > DEADLINE_MS) bad(`the answer came ${Math.round(a.answeredT - quotes[0].t)} ms after the first ask, past the page's ${DEADLINE_MS} ms`);
  const failed = lines.length > 0;
  if (!failed && answer?.ok !== true && vendor) lines.push(`INCONCLUSIVE the real ask answered ${real.status}${real.message ? ` ${real.message}` : ""}${real.cause ? ` (cause ${real.cause})` : ""}: 1Click's own, not the page's`);
  const verdict = failed ? "FAIL" : answer?.ok === true ? "PASS" : "INCONCLUSIVE";
  return { verdict, ok: verdict === "PASS", lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** The headers SIGN_HOST's _headers sets on every path: its one /* rule. */
function headersOf(text) {
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
/** packages/signpage as deploy.mjs build() makes it, minus the prover's setup files: index.html and public/ copied. */
function build() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-dqnl-"));
  copyFileSync(path.join(signBuilt(), "index.html"), path.join(out, "index.html"));
  cpSync(path.join(REPO, "packages/signpage/public"), out, { recursive: true });
  return out;
}

const probeHtml = (signOrigin) => `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
addEventListener("message", (e) => window.__log.push({ t: performance.timeOrigin + performance.now(), fromParent: e.source === parent, data: e.data }));
window.__ask = (params) => {
  parent.postMessage(${JSON.stringify({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION })}, ${JSON.stringify(signOrigin)});
  const m = { v: 1, id: crypto.randomUUID(), type: "deposit.dry", ...params };
  parent.postMessage(m, ${JSON.stringify(signOrigin)});
  return m.id;
};
</script></body>`;

const messageOf = (text) => {
  try {
    const m = JSON.parse(text)?.message;
    return typeof m === "string" ? m.slice(0, MESSAGE_MAX) : undefined;
  } catch {
    return undefined;
  }
};
const causeOf = (timing) => /cause;desc="([a-z0-9]+)"/.exec(timing ?? "")?.[1] ?? undefined;

/** One run: the page's quote requests (time, body, the answer's status and time), the probe's log and the answer's time. */
export async function collect({ browser, signUrl = SIGN_URL, dir, source }) {
  const signOrigin = new URL(signUrl).origin;
  const ctx = await browser.newContext();
  await ctx.route((u) => u.origin === APP_HOST, (r) => r.fulfill({ status: 200, contentType: "text/html", body: probeHtml(signOrigin) }));
  if (dir) await ctx.route((u) => u.origin === signOrigin, serveDir(dir));
  const quotes = [];
  await ctx.route(QUOTE_URL, async (r) => {
    const req = r.request();
    if (req.method() !== "POST") return r.continue();
    let body = null;
    try {
      body = JSON.parse(req.postData() ?? "null");
    } catch {}
    const q = { t: Date.now(), body };
    quotes.push(q);
    if (quotes.length <= PLANTED) {
      await r.fulfill({ status: 400, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": signOrigin, vary: "Origin" }, body: NO_LIQUIDITY_BODY });
      Object.assign(q, { status: 400, message: messageOf(NO_LIQUIDITY_BODY), planted: true, answeredT: Date.now() });
      return;
    }
    // the real helper: its status, its 400's message and its cause, never the body (1Click's signature is never recorded)
    const res = await r.fetch();
    const text = await res.text();
    Object.assign(q, { status: res.status(), answeredT: Date.now(), ...(res.status() === 400 ? { message: messageOf(text) } : {}), ...(causeOf(res.headers()["server-timing"]) ? { cause: causeOf(res.headers()["server-timing"]) } : {}) });
    await r.fulfill({ response: res, body: text });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(signUrl, { waitUntil: "load" });
  const app = () => page.frames().find((f) => f.url().startsWith(`${APP_HOST}/`));
  let log = [];
  const read = async () => {
    const f = app();
    log = f ? await f.evaluate(() => window.__log).catch(() => log) : log;
    return log;
  };
  const waitFor = async (ms, done) => {
    for (const until = Date.now() + ms; Date.now() < until; await page.waitForTimeout(50)) if (done(await read())) return true;
    return false;
  };
  const ready = await waitFor(READY_MS, (l) => l.some((m) => m.fromParent && m.data?.type === "ready"));
  let id = null;
  let answeredT = null;
  if (ready) {
    id = await app().evaluate((p) => window.__ask(p), ASKED);
    await waitFor(ANSWER_MS, (l) => l.some((m) => m.fromParent && m.data?.id === id));
    answeredT = log.find((m) => m.fromParent && m.data?.id === id)?.t ?? null;
  }
  await ctx.close();
  return { source, at: new Date().toISOString(), browser: browser.version(), signUrl, ready, id, log: log.filter((m) => m.fromParent && (m.data?.id === id || m.data?.type === "ready")), quotes, answeredT, errors };
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let answer;
  if (opt("--answer")) answer = JSON.parse(readFileSync(opt("--answer"), "utf8"));
  else {
    const local = args.includes("--local");
    const given = local && opt("--local") && !opt("--local").startsWith("--") ? path.resolve(opt("--local")) : null;
    const dir = local ? (given ?? build()) : null;
    const browser = await launchBrowser("chromium");
    try {
      answer = await collect({ browser, signUrl: local ? SIGN_URL : (opt("--url") ?? SIGN_URL), dir, source: local ? `local, SIGN_HOST answered from ${given ? named(given) : "packages/signpage's build (index.html and public/ copied)"}` : "live" });
    } finally {
      await browser.close();
      if (local && !given) rmSync(dir, { recursive: true, force: true });
    }
  }
  if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
  for (const q of answer.quotes ?? []) console.log(`  ask: ${q.status}${q.planted ? " (planted)" : ""}${q.message ? ` ${q.message}` : ""}`);
  const v = judge(answer);
  for (const l of v.lines) console.log(l);
  console.log(`${v.verdict} ${KEY}`);
  process.exit(EXIT[v.verdict]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERROR ${KEY}: ${e?.stack ?? e}`);
    process.exit(2);
  });
}
