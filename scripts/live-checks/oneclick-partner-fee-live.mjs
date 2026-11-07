#!/usr/bin/env node
// Live check of card oneclick-partner-fee-live on HELPER_HOST (https://ct-api.unrealized.trade): a quote the
// helper fetches from 1Click with its key carries the fee entry the device's check accepts on the partner path, the
// path deposit.quote checks on (packages/signpage/src/rules/deposit-quote.ts). 1Click's fee follows the route
// (docs.near-intents.org resources/fees.md, read 2026-11-06T15:18Z: 1 bp between stablecoins, 20 bps otherwise), so the
// check asks three quotes through POST /v1/proxy/oneclick/v0/quote, as the device asks (no cookie, its own body):
//   - live: 25 USDC from Solana into NEAR USDC with dry: false, the deposit's own live quote, to the kit's public
//     DEPOSIT_DRY_PLACEHOLDER as recipient and refundTo (what deposit.dry names), held to the same whole check as usdc
//     below plus a live answer's rules (a signed deposit address, no memo, the signed deadline the requested one + 72 h).
//     A live quote moves nothing until someone sends to its address, so it is safe after every deploy; if 1Click charged
//     a keyed live quote another fee than a dry one, it shows here;
//   - usdc: the same 25 USDC as a dry quote, to the same placeholder. It passes only when the
//     kit's whole check, checkOneClickQuote(request, answer, { path: "partner", pricing: "usdc", intoVault: true }),
//     passes on the answer at the time it was read: 1Click's signature, the echo of the request, the fee entry
//     (exactly [{ recipient: 1Click's collector, fee: the kit's fee for the route }]), freshness,
//     amounts and the device's own floors;
//   - pair: 10 wNEAR into NEAR USDC, another pair, the same check with NEAR's two price reads set to $0.01 and USDC's
//     to $1 (a floor of about $0.10 on what 1Click prices near $19, so the price floor does not refuse it: this check
//     holds the fee entry, not the price, which the device reads on its own).
// A kit that pins another fee for a route than 1Click charges a keyed partner fails here ("app-fees").
//   node scripts/live-checks/oneclick-partner-fee-live.mjs [--base <url>] [--record <file>]
//   node scripts/live-checks/oneclick-partner-fee-live.mjs --answer <file>     judge a recorded answer, no network
// --record writes what the run read (the requests, each answer's status and body, the time), so the test can replay it,
// with 1Click's signature left out of each body: an "ed25519:" signature has a NEAR secret key's shape, which the secret
// scan refuses (.gitleaks.toml), and the test signs each recorded answer again with a throwaway key it pins itself.
// PASS exit 0, FAIL exit 1, error exit 2; the last line is "live-check oneclick-partner-fee-live: PASS" or "...: FAIL",
// each failure a "BAD ..." line.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { DEPOSIT_DRY_PLACEHOLDER, checkOneClickQuote } from "../../packages/kit/src/index.ts";

const KEY = "oneclick-partner-fee-live";
export const BASE = "https://ct-api.unrealized.trade";
export const PATH = "/v1/proxy/oneclick/v0/quote";
export const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
export const WNEAR = "nep141:wrap.near";
/** The kit's public placeholder implicit id as recipient and refundTo: no quote here names anyone's account. */
export const PLACEHOLDER = DEPOSIT_DRY_PLACEHOLDER;
const TIMEOUT_MS = 15_000;
const ANSWER_MAX = 65_536;

/** The three quotes: each request (deadline set at read time) and the device's check options for it. */
export const ROUTES = {
  live: { dry: false, originAsset: SOL_USDC, amount: "25000000", opts: { pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: true } },
  usdc: { dry: true, originAsset: SOL_USDC, amount: "25000000", opts: { pricing: "usdc", decimalsIn: 6, decimalsOut: 6, intoVault: true } },
  pair: { dry: true, originAsset: WNEAR, amount: "10000000000000000000000000",
    opts: { pricing: { in: ["0.01", "0.01"], out: ["1", "1"] }, decimalsIn: 24, decimalsOut: 6, intoVault: false } },
};

export function quoteRequest(route, now) {
  const r = ROUTES[route];
  return {
    dry: r.dry, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: r.originAsset, depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_USDC, amount: r.amount, refundTo: PLACEHOLDER, refundType: "INTENTS", recipient: PLACEHOLDER,
    recipientType: "DESTINATION_CHAIN", deadline: new Date(now + 30 * 60_000).toISOString(),
  };
}

/** Reads the three quotes through `base`; returns the record judge() reads. */
export async function read(base = BASE, fetchFn = fetch, now = Date.now) {
  const answers = {};
  for (const route of Object.keys(ROUTES)) {
    const request = quoteRequest(route, now());
    const t0 = performance.now();
    const res = await fetchFn(`${base}${PATH}`, {
      method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
      headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    answers[route] = { request, status: res.status, body: text.length > ANSWER_MAX ? null : text, bytes: text.length,
      at: now(), ms: Math.round(performance.now() - t0) };
  }
  return { base, answers };
}

const show = (v) => JSON.stringify(v)?.slice(0, 160);

/** The record as --record writes it: each JSON body without its signature (the test signs the replay itself). */
export function unsigned(rec) {
  const r = structuredClone(rec);
  for (const a of Object.values(r.answers ?? {})) {
    if (typeof a.body !== "string") continue;
    try {
      const b = JSON.parse(a.body);
      if (b && typeof b === "object" && "signature" in b) { delete b.signature; a.body = JSON.stringify(b); }
    } catch { /* not JSON: kept as read */ }
  }
  return r;
}

/** The verdict on a record: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  let ok = true;
  const bad = (m) => { ok = false; lines.push(`BAD ${m}`); };
  for (const route of Object.keys(ROUTES)) {
    const a = rec?.answers?.[route];
    if (!a) { bad(`${route}: no answer recorded`); continue; }
    if (a.status !== 200 && a.status !== 201) { bad(`${route}: HTTP ${a.status}, want 1Click's 200 or 201`); continue; }
    if (a.body === null) { bad(`${route}: an answer over ${ANSWER_MAX} B`); continue; }
    let body;
    try { body = JSON.parse(a.body); } catch { bad(`${route}: the answer is not JSON`); continue; }
    const got = body?.quoteRequest?.appFees;
    try {
      checkOneClickQuote(a.request, body, { path: "partner", ...ROUTES[route].opts, now: a.at });
      lines.push(`ok  ${route}: the device's partner-path check passes; appFees ${show(got)}`);
    } catch (e) {
      bad(`${route}: the device's partner-path check refuses it: ${e?.message ?? e}`);
    }
  }
  return { ok, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const rec = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(unsigned(rec), null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    for (const [route, a] of Object.entries(rec.answers ?? {})) if (a.ms !== undefined) console.log(`    ${route}: ${a.ms} ms`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${rec.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
