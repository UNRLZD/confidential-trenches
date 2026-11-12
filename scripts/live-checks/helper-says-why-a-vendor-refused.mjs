#!/usr/bin/env node
// Live check of card helper-says-why-a-vendor-refused on HELPER_HOST (https://ct-api.unrealized.trade): a refusal the
// helper's 1Click proxy answers says why and whose it is. Live runs 43276439006 and 43289730843 (12 Nov 18:07Z and 19:25Z)
// had every 1Click quote answered 400 and nothing on record said why. Two dry quotes through POST
// /v1/proxy/oneclick/v0/quote, as the signing page asks them (no cookie, the kit's public placeholder as recipient and
// refundTo, Solana USDC into NEAR USDC), and one more straight to 1Click only when the helper refuses:
//   - short: 1 base unit, a size 1Click refuses for its amount. It passes only when the helper answers 400 with 1Click's
//     message in its body and refusal;desc="vendor" in its Server-Timing (apps/helper/src/proxy/proxy.ts handle): a
//     device tells 1Click's refusal from the helper's own, and its message decides whether the page asks again
//     (packages/wallet/src/deposit/quote.ts askAgainFor). A helper before this card names no refusal: FAIL;
//   - quote: 10 USDC, a size 1Click quotes. It passes on 200 or 201. When the helper answers it 400, the same body (its
//     deadline renewed) goes to 1Click keyless (the twin): 1Click refusing it too, or failing, is 1Click's own trouble:
//     INCONCLUSIVE (exit 3), the message on its line; 1Click quoting it keyless while the helper's path refused it is
//     the helper's path (its key, its proxy): FAIL with both answers.
// A 503 whose cause is 1Click's own (timeout, 5xx, send: the helper's Server-Timing cause) is 1Click's: INCONCLUSIVE.
// The quotes are dry: nothing is signed, nothing of anyone's is named, no money moves. At most three requests.
// After: helper
//   node scripts/live-checks/helper-says-why-a-vendor-refused.mjs [--base <helper url>] [--record <file>]
//   node scripts/live-checks/helper-says-why-a-vendor-refused.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> helper-says-why-a-vendor-refused".
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPOSIT_DRY_PLACEHOLDER, ONECLICK_USDC_ASSETS } from "../../packages/kit/src/index.ts";
import { saidOf, saidPart } from "./vendor-said.mjs";

const KEY = "helper-says-why-a-vendor-refused";
export const BASE = "https://ct-api.unrealized.trade";
export const QUOTE = "/v1/proxy/oneclick/v0/quote";
/** 1Click's own quote endpoint, keyless, for the twin (apps/helper/src/proxy/vendors.ts oneclick base). */
export const ONECLICK_QUOTE = "https://1click.chaindefuser.com/v0/quote";
export const SHORT_AMOUNT = "1";
export const QUOTE_AMOUNT = "10000000";
/** The helper's 503 causes that are 1Click's own (proxy.ts Cause). */
export const VENDOR_CAUSES = Object.freeze(["timeout", "5xx", "send"]);
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });
const TIMEOUT_MS = 30_000;

/** The dry quote the signing page asks for `amount` of Solana USDC (signpage rules/deposit-dry.ts depositDryRequest). */
export function dryBody(amount, now = Date.now()) {
  return {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ONECLICK_USDC_ASSETS[1], depositType: "ORIGIN_CHAIN",
    destinationAsset: ONECLICK_USDC_ASSETS[0], amount, refundTo: DEPOSIT_DRY_PLACEHOLDER, refundType: "INTENTS",
    recipient: DEPOSIT_DRY_PLACEHOLDER, recipientType: "DESTINATION_CHAIN", deadline: new Date(now + 30 * 60_000).toISOString(),
  };
}

const entry = (timing, name) => new RegExp(`(?:^|,)\\s*${name};desc="([a-z0-9]+)"`).exec(timing ?? "")?.[1] ?? null;
const twoxx = (s) => s === 200 || s === 201;

/** The verdict on an answer { base, short: call, quote: call, twin?: call }, each call { status, message, refusal, cause }:
 *  { verdict, ok, lines }. */
export function judge(a) {
  const lines = [];
  const vendor = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const theirs = (part, c) => c?.status === 503 && VENDOR_CAUSES.includes(c.cause) && (vendor.push(`INCONCLUSIVE ${part}: the helper answered 503 (cause ${c.cause})${saidPart(c.message)}: 1Click's own`), true);
  const s = a?.short;
  if (!s) bad("short: no answer recorded");
  else if (!theirs("short", s)) {
    if (s.status !== 400) bad(`short: the helper answered ${s.status}${saidPart(s.message)}, want 1Click's 400 for the amount`);
    else {
      if (s.refusal !== "vendor") bad(`short: the helper's 400 names ${s.refusal === null ? "no refusal" : `refusal ${JSON.stringify(s.refusal)}`} in its Server-Timing, want refusal;desc="vendor"`);
      if (typeof s.message !== "string" || s.message === "") bad("short: the helper's 400 carries no message of 1Click's");
    }
  }
  const q = a?.quote;
  if (!q) bad("quote: no answer recorded");
  else if (!twoxx(q.status) && !theirs("quote", q)) {
    const t = a?.twin;
    if (q.status !== 400) bad(`quote: the helper answered ${q.status}${saidPart(q.message)}${q.cause ? ` (cause ${q.cause})` : ""}, want 200 or 201`);
    else if (!t) bad(`quote: the helper answered 400${saidPart(q.message)} and no keyless quote was read`);
    else if (twoxx(t.status)) bad(`quote: the helper answered 400${saidPart(q.message)} where 1Click quotes the same request keyless (${t.status}): the helper's path refused it`);
    else vendor.push(`INCONCLUSIVE quote: the helper answered 400${saidPart(q.message)} and 1Click keyless ${t.status}${saidPart(t.message)}: 1Click's own`);
  }
  const verdict = lines.length > 0 ? "FAIL" : vendor.length > 0 ? "INCONCLUSIVE" : "PASS";
  if (verdict === "INCONCLUSIVE") lines.push(...vendor);
  return { verdict, ok: verdict === "PASS", lines };
}

/** One POST of `body`: its status (or how it threw), the vendor's message on a refusal, and the helper's Server-Timing
 *  refusal and cause. Never the body of a 2xx. */
async function call(url, body, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(url, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await r.text();
    const timing = r.headers.get("server-timing");
    return { status: r.status, ms: Math.round(performance.now() - t0), message: twoxx(r.status) ? null : saidOf(text), refusal: entry(timing, "refusal"), cause: entry(timing, "cause") };
  } catch (e) {
    return { status: `threw ${e?.name ?? "error"}`, ms: Math.round(performance.now() - t0), message: null, refusal: null, cause: null };
  }
}

export async function read(base = BASE, fetchFn = fetch, now = Date.now, direct = ONECLICK_QUOTE) {
  base = base.replace(/\/$/, "");
  const short = await call(`${base}${QUOTE}`, dryBody(SHORT_AMOUNT, now()), fetchFn);
  const quote = await call(`${base}${QUOTE}`, dryBody(QUOTE_AMOUNT, now()), fetchFn);
  const twin = quote.status === 400 ? await call(direct, dryBody(QUOTE_AMOUNT, now()), fetchFn) : undefined;
  return { base, at: new Date(now()).toISOString(), short, quote, ...(twin ? { twin } : {}) };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const answer = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : await read(opt("--base") ?? BASE);
  if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
  for (const k of ["short", "quote", "twin"]) {
    const c = answer[k];
    if (c) console.log(`  ${k}: ${c.status} in ${c.ms} ms${c.refusal ? `, refusal ${c.refusal}` : ""}${c.cause ? `, cause ${c.cause}` : ""}${saidPart(c.message)}`);
  }
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
