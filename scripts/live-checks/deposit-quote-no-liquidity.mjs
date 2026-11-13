#!/usr/bin/env node
// Live check of card deposit-quote-no-liquidity on SIGN_HOST (https://confidential.unrealized.trade): the deposit sheet's
// display read (deposit.dry) asks 1Click's no-liquidity 400 again as every quote path does, and stays inside the one
// ask's window. Since a704c14fb (card helper-says-why-a-vendor-refused) every quote path asks a 1Click 400 that is not
// about the request again through wallet/src/deposit/quote.ts askDepositQuoteAgain, the display reads too
// (signpage/src/rules/deposit-dry.ts): a sheet that asked its assets once showed Not available for minutes of 1Click
// 400s. That overrules this check's first ruling (the display read asked once). The rule's numbers are read from
// quote.ts itself (QUOTE_RULE), never copied here: the first ask and one re-ask per NO_LIQUIDITY_PAUSES_MS entry at
// most, every one inside DEPOSIT_QUOTE_TIMEOUT_MS from the first send. The committed asks (deposit.quote, pool.address,
// the refund move) need a signed-in seed and a live quote, which this run never has; their re-ask is held by the package
// tests (packages/wallet/test/deposit-quote.test.ts, packages/signpage/test/rules-deposit-quote.test.ts,
// pool-deposit-address.test.ts, refund-move.test.ts). The run, with the served page:
//   - SIGN_HOST as a top-level page frames APP_HOST, which Playwright answers with a probe page (no request reaches the
//     real APP_HOST); once the shell's ready arrives the probe posts the kit's hello and asks deposit.dry for 25 USDC
//     from Solana, the sheet's own read as the amount is typed;
//   - every quote request the page sends to the helper's 1Click proxy is answered here with 1Click's own no-liquidity
//     answer (400, the body the deployed helper passed on 2026-11-10T19:06:57Z): no request reaches the helper.
// PASS when the page sent the dry 25 USDC request to the public placeholder at least once and at most QUOTE_RULE.maxAsks
// times (the first and its re-asks), each the same request, each sent inside QUOTE_RULE.windowMs from the first send,
// and answered not_available inside that window. FAIL on one ask more, an ask after the window, a changed request, a
// request that reached the helper, another code or anything but a refusal, or no answer.
// The quote is dry and answered here: nothing is signed, nothing of anyone's is named, nothing reaches the helper.
// After: sign
//   node scripts/live-checks/deposit-quote-no-liquidity.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/deposit-quote-no-liquidity.mjs --local [<build dir>] [--record <file>]
//     SIGN_HOST answered from a build dir as packages/signpage/scripts/deploy.mjs builds it (index.html and public/),
//     with no dir the build of the tree this file is in (scripts/signpage-built.mjs)
//   node scripts/live-checks/deposit-quote-no-liquidity.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2; the last line is "<verdict> deposit-quote-no-liquidity", each failure a "BAD ..." line.
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
/** What the run asks: 25 USDC from Solana, the size 1Click had no liquidity for on 10 Nov 07:04-07:43Z. */
export const ASKED = Object.freeze({ origin_asset: SOL_USDC, amount: "25" });
export const ASKED_UNITS = "25000000";
/** The page's quote rule as wallet/src/deposit/quote.ts writes it: its one ask's window (DEPOSIT_QUOTE_TIMEOUT_MS) and
 *  the asks at most (the first, and one per NO_LIQUIDITY_PAUSES_MS pause). Throws when a literal is not in its shape, so
 *  a reshaped rule is an error (exit 2), never a pass on a stale number. */
export const QUOTE_SOURCE = path.join(REPO, "packages/wallet/src/deposit/quote.ts");
export function parseQuoteRule(text) {
  const num = (x) => Number(x.replaceAll("_", ""));
  const w = /^export const DEPOSIT_QUOTE_TIMEOUT_MS = ([0-9][0-9_]*);$/m.exec(String(text));
  const p = /^export const NO_LIQUIDITY_PAUSES_MS: readonly number\[\] = Object\.freeze\(\[([0-9_,\s]*)\]\);$/m.exec(String(text));
  if (!w) throw new Error("DEPOSIT_QUOTE_TIMEOUT_MS not found in its literal shape");
  if (!p) throw new Error("NO_LIQUIDITY_PAUSES_MS not found in its literal shape");
  const pauses = p[1].split(",").map((x) => x.trim()).filter(Boolean).map(num);
  if (!(num(w[1]) > 0) || pauses.length === 0 || !pauses.every((x) => x > 0)) throw new Error("the quote rule's literals are not positive numbers");
  return Object.freeze({ windowMs: num(w[1]), maxAsks: 1 + pauses.length });
}
export const QUOTE_RULE = parseQuoteRule(readFileSync(QUOTE_SOURCE, "utf8"));
/** The one ask's window (wallet/src/deposit/quote.ts DEPOSIT_QUOTE_TIMEOUT_MS). */
export const WINDOW_MS = QUOTE_RULE.windowMs;
/** 1Click's no-liquidity answer as the deployed helper passed it on 2026-11-10T19:06:57Z (a dry quote of NEAR USDC into a
 *  meme no solver quotes; the card's 25 USDC reads gave the same status and message). */
export const NO_LIQUIDITY_BODY = '{"message":"No liquidity available","correlationId":"2357c43d-9fdf-4c05-9732-edaa447fcb6a","timestamp":"2026-11-10T19:06:57.250Z","path":"/v0/quote"}';
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1 });
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
  if (quotes.length > QUOTE_RULE.maxAsks) bad(`the page asked the display quote ${quotes.length} times on 1Click's no-liquidity answer, want ${QUOTE_RULE.maxAsks} at most (the first and its re-asks)`);
  if (quotes.some((q) => q.planted !== true)) bad("a quote request reached the helper: this run answers every one");
  const first = quotes[0]?.body;
  if (first !== undefined) {
    if (first?.dry !== true || first.originAsset !== SOL_USDC || first.amount !== ASKED_UNITS) bad(`the quote request is not the dry 25 USDC from Solana asked: ${show(first)}`);
    if (first?.recipient !== DEPOSIT_DRY_PLACEHOLDER || first?.refundTo !== DEPOSIT_DRY_PLACEHOLDER) bad("the quote request names someone other than the public placeholder");
  }
  // a re-ask is the same request as it is (askDepositQuoteAgain), sent inside the one ask's window from the first send
  quotes.slice(1).forEach((q, i) => {
    if (JSON.stringify(q.body) !== JSON.stringify(first)) bad(`ask ${i + 2} is not the first ask's request: ${show(q.body)}`);
  });
  const late = quotes.filter((q) => !(typeof q.t === "number" && q.t - quotes[0].t >= 0 && q.t - quotes[0].t <= WINDOW_MS));
  if (late.length) bad(`${late.length} ask(s) sent outside the one ask's ${WINDOW_MS} ms from the first send (${late.map((q) => (typeof q.t === "number" ? `${q.t - quotes[0].t} ms` : "no time")).join(", ")})`);
  if (answer === undefined) bad("the page sent no answer to deposit.dry");
  else if (!(answer.ok === false && answer.error?.code === "not_available" && Object.keys(answer).sort().join() === "error,id,ok,v"))
    bad(`deposit.dry answered ${show(answer.ok === false ? answer.error : answer)}, want not_available on 1Click's no-liquidity answer`);
  if (quotes.length > 0 && answer !== undefined && typeof a.answeredT === "number" && a.answeredT - quotes[0].t > WINDOW_MS) bad(`the answer came ${Math.round(a.answeredT - quotes[0].t)} ms after the ask, past the one ask's ${WINDOW_MS} ms`);
  const verdict = lines.length > 0 ? "FAIL" : "PASS";
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

/** One run: the page's quote requests (time, body, the planted answer and its time), the probe's log and the answer's time. */
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
    // every ask: 1Click's no-liquidity answer, here; nothing reaches the helper
    await r.fulfill({ status: 400, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": signOrigin, vary: "Origin" }, body: NO_LIQUIDITY_BODY });
    Object.assign(q, { status: 400, message: messageOf(NO_LIQUIDITY_BODY), planted: true, answeredT: Date.now() });
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
