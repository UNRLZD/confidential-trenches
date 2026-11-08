#!/usr/bin/env node
// Live check of card deposit-sheet-oneclick-budget on HELPER_HOST: one deposit sheet open fits what the helper gives one
// client of 1Click, so no other client's load can refuse it (apps/helper/src/proxy/proxy.ts DEPOSIT_SHEET_CALLS and
// PROXY_BUDGETS.oneclick). From one address, with Origin SIGN_HOST, as the signing page sends them, it passes only when:
//   - sheet: the sheet's five calls in one 10 s window (the helper's share window, limits.ts LIMIT_WINDOW_MS), as
//     packages/signpage/src/rules/deposit-dry.ts sends them: POST /v0/tokens, then three dry quotes at once (10 USDC
//     of each release asset), then one dry quote (25 USDC from Solana), each to the public placeholder: every one
//     answers 200 or 201;
//   - share: in the next window, five POST /v0/tokens at once: every one 200. A list read inside its cache reaches no
//     vendor and is never lent past the share (limits.ts takeEach shareOnly), so this reads the share itself: at a
//     share under five the third answers 429 even with the helper idle.
// Each refusal is named with its status, the cause in the helper's Server-Timing (cause;desc=...) and its Retry-After.
// A 503 whose cause is 1Click's own (VENDOR_CAUSES: it sent nothing in the helper's 8 s, failed twice, or was never
// reached) is not the helper's budget: with no other refusal the run is INCONCLUSIVE (exit 3, said on its own line, as
// solana-jupiter-build's), never PASS (review LOW 6 of 429d0a63: 1Click's 02:07-02:31Z slowdown read as a FAIL of ours).
// The quotes are dry: nothing is signed, nothing of anyone's is named, no money moves.
//   node scripts/live-checks/deposit-sheet-oneclick-budget.mjs [--base <helper url>] [--record <file>]
//   node scripts/live-checks/deposit-sheet-oneclick-budget.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> deposit-sheet-oneclick-budget".
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPOSIT_DRY_PLACEHOLDER, ONECLICK_USDC_ASSETS } from "../../packages/kit/src/index.ts";

const KEY = "deposit-sheet-oneclick-budget";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const TOKENS = "/v1/proxy/oneclick/v0/tokens";
export const QUOTE = "/v1/proxy/oneclick/v0/quote";
/** One sheet open's 1Click calls (proxy.ts DEPOSIT_SHEET_CALLS). */
export const SHEET_CALLS = 5;
/** The helper's share window (limits.ts LIMIT_WINDOW_MS), fixed on the epoch. */
export const WINDOW_MS = 10_000;
/** Past a window's start, so a clock a second off the helper's still lands the burst in one window. */
const INTO_WINDOW_MS = 1_000;
const SOL_USDC = ONECLICK_USDC_ASSETS[1];

/** The dry quote the signing page asks (deposit-dry.ts depositDryRequest): into NEAR USDC, the vault's, to the placeholder. */
export function dryBody(origin, amount, now = Date.now()) {
  return {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: origin, depositType: "ORIGIN_CHAIN",
    destinationAsset: ONECLICK_USDC_ASSETS[0], amount, refundTo: DEPOSIT_DRY_PLACEHOLDER, refundType: "INTENTS",
    recipient: DEPOSIT_DRY_PLACEHOLDER, recipientType: "DESTINATION_CHAIN", deadline: new Date(now + 30 * 60_000).toISOString(),
  };
}

/** The helper's 503 causes that are 1Click's own (apps/helper/src/proxy/proxy.ts Cause): timeout, 5xx, send. Every
 *  other refusal (429 share, 503 budget or held, 1Click's 429 to our count, our key, an answer) is the helper's. */
export const VENDOR_CAUSES = Object.freeze(["timeout", "5xx", "send"]);
/** A verdict's exit code: PASS 0, FAIL 1, INCONCLUSIVE 3 (an error exits 2). */
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });
const causeOf = (timing) => /cause;desc="([a-z0-9]+)"/.exec(timing ?? "")?.[1] ?? null;

/** The verdict on an answer { base, sheet: [call], share: [call] }, each call { what, status, cause, retryAfter }:
 *  { verdict, ok, lines }. */
export function judge(a) {
  const lines = [];
  const vendor = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const ours = (c) => !(c.status === 503 && VENDOR_CAUSES.includes(c.cause));
  const named = (c) => `${c.what} answered ${c.status}${c.cause ? ` (cause ${c.cause})` : ""}${c.retryAfter ? `, Retry-After ${c.retryAfter}` : ""}`;
  const sheet = Array.isArray(a?.sheet) ? a.sheet : [];
  const share = Array.isArray(a?.share) ? a.share : [];
  if (sheet.length !== SHEET_CALLS) bad(`sheet: ${sheet.length} calls recorded, want ${SHEET_CALLS}`);
  if (share.length !== SHEET_CALLS) bad(`share: ${share.length} calls recorded, want ${SHEET_CALLS}`);
  const refuse = (part, c, want) => (ours(c) ? bad(`${part}: ${named(c)}, want ${want}`) : vendor.push(`${part}: ${named(c)}: 1Click's own, not the helper's budget`));
  for (const c of sheet) if (!(c.status === 200 || (c.what.startsWith("quote") && c.status === 201))) refuse("sheet", c, c.what.startsWith("quote") ? "200 or 201" : "200");
  for (const c of share) if (c.status !== 200) refuse("share", c, "200");
  const verdict = lines.length > 0 ? "FAIL" : vendor.length > 0 ? "INCONCLUSIVE" : "PASS";
  if (verdict === "INCONCLUSIVE") lines.push(...vendor.map((l) => `INCONCLUSIVE ${l}`));
  return { verdict, ok: verdict === "PASS", lines };
}

async function call(base, what, path, body, fetchFn) {
  const t0 = performance.now();
  try {
    const r = await fetchFn(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: SIGN, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    await r.arrayBuffer();
    const timing = r.headers.get("server-timing");
    return { what, status: r.status, ms: Math.round(performance.now() - t0), cause: causeOf(timing), retryAfter: r.headers.get("retry-after") };
  } catch (e) {
    return { what, status: `threw ${e?.name ?? "error"}`, ms: Math.round(performance.now() - t0), cause: null, retryAfter: null };
  }
}

/** Waits for the next share window to be INTO_WINDOW_MS old. */
const nextWindow = (now = Date.now()) => new Promise((ok) => setTimeout(ok, Math.ceil((now + 1) / WINDOW_MS) * WINDOW_MS + INTO_WINDOW_MS - now));

export async function read(base = BASE, fetchFn = fetch, wait = nextWindow) {
  base = base.replace(/\/$/, "");
  await wait();
  const sheet = [await call(base, "tokens", TOKENS, undefined, fetchFn)];
  sheet.push(...(await Promise.all(ONECLICK_USDC_ASSETS.map((id, i) => call(base, `quote ${i + 1} (10 USDC, ${id.slice(0, 24)})`, QUOTE, dryBody(id, "10000000"), fetchFn)))));
  sheet.push(await call(base, "quote 4 (25 USDC from Solana)", QUOTE, dryBody(SOL_USDC, "25000000"), fetchFn));
  await wait();
  const share = await Promise.all(Array.from({ length: SHEET_CALLS }, (_, i) => call(base, `tokens ${i + 1} of ${SHEET_CALLS}`, TOKENS, undefined, fetchFn)));
  return { base, at: new Date().toISOString(), sheet, share };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const answer = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : await read(opt("--base") ?? BASE);
  if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
  for (const c of [...(answer.sheet ?? []), ...(answer.share ?? [])]) console.log(`  ${c.what}: ${c.status} in ${c.ms} ms${c.cause ? `, cause ${c.cause}` : ""}`);
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
