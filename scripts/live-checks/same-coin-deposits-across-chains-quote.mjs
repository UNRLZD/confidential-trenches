#!/usr/bin/env node
// Live check of card same-coin-deposits-across-chains-quote on SIGN_HOST (https://confidential.unrealized.trade) and on
// 1Click through HELPER_HOST's proxy, moving no money: a deposit of one coin from its other chains is quoted at the fee
// 1Click charges and the device's check holds it to. What it holds, and only that:
//   - SIGN_HOST's served /app.js is the one index.html pins (its sha384), and it carries each of the kit's same-coin
//     routes (packages/kit/src/checks/oneclick.ts ONECLICK_SAME_COIN_ROUTES) as its own frozen [origin, destination]
//     pair (`routes`), so the device that checks a deposit's quote is the one that pins those fees;
//   - through the helper's proxy (its partner key, never printed), a DRY quote of each listed route and of three
//     same-coin neighbours the kit holds at 20 (Robinhood ETH into Base ETH, Base ETH into Robinhood ETH, Ethereum ETH
//     into Robinhood ETH; read 2026-11-14 06:58-07:02Z at fee 20), each public and "advanced" (confidential): the answer
//     names exactly one fee entry, its mode's collector and the fee the kit's rule gives the route (oneClickFeeBps on the
//     partner path, the path deposit quotes are checked on); and a public answer passes the kit's whole check
//     (checkOneClickQuote: 1Click's signature, the echo, the fee entry, the device's floors at one price for both ends,
//     the same coin). A dry quote makes no deposit address. 1Click's 400 "No liquidity available" says nothing of the
//     kit or the helper: with no BAD line the run is INCONCLUSIVE (exit 3, run again by scripts/ci/live-rerun.mjs).
// A kit that pins a fee for a same-coin route other than 1Click charges fails here, on either side: a route 1Click
// moves to 20 (every such deposit would be refused quote_check_failed) and a neighbour 1Click moves to 1.
// After: sign
//   node scripts/live-checks/same-coin-deposits-across-chains-quote.mjs [--record <file>]
//   node scripts/live-checks/same-coin-deposits-across-chains-quote.mjs --answer <file>     judge a record, no network
// --record writes what the run read with 1Click's signature left out of each body (an "ed25519:" signature has a NEAR
// secret key's shape, which the secret scan refuses); the test signs each recorded answer again with a key it pins.
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "live-check
// same-coin-deposits-across-chains-quote: PASS", "...: FAIL" or "...: INCONCLUSIVE", each failure a "BAD ..." line.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPOSIT_DRY_PLACEHOLDER, ONECLICK_SAME_COIN_ROUTES, checkOneClickQuote, oneClickFeeBps } from "../../packages/kit/src/index.ts";

const KEY = "same-coin-deposits-across-chains-quote";
export const SIGN = "https://confidential.unrealized.trade";
export const HELPER_QUOTE = "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote";
/** 1Click's fee collector per mode: public, and on Confidential Intents rails ("advanced"), read 2026-11-14 03:37Z and
 *  06:58-07:02Z (card move-one-confidential-swap pins the second in the kit). */
export const COLLECTOR = Object.freeze({ public: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", advanced: "2238fd089f1c92b206c218cd16b8676cb98964e0d50f8ab729c6396a81e07805" });
export const MODES = Object.freeze(["public", "advanced"]);
const ETH = { eth: "nep141:eth.omft.near", base: "nep141:base.omft.near", hood: "nep141:hood.omft.near" };
/** Each coin's decimals on 1Click (GET /v0/tokens, read 2026-11-14T06:56Z) and about 10 USD of it. */
const COIN = Object.freeze({
  [ETH.eth]: { decimals: 18, amount: "4000000000000000" }, [ETH.base]: { decimals: 18, amount: "4000000000000000" },
  [ETH.hood]: { decimals: 18, amount: "4000000000000000" }, "nep141:arb.omft.near": { decimals: 18, amount: "4000000000000000" },
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near": { decimals: 6, amount: "10000000" },
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near": { decimals: 6, amount: "10000000" },
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { decimals: 6, amount: "10000000" },
});
/** The routes read: the kit's listed ones, then the neighbours it holds at 20. */
export const NEIGHBOURS = Object.freeze([[ETH.hood, ETH.base], [ETH.base, ETH.hood], [ETH.eth, ETH.hood]]);
export const ROUTES = Object.freeze([...ONECLICK_SAME_COIN_ROUTES.map(([o, d]) => [o, d]), ...NEIGHBOURS]);
/** A recipient of the destination's kind nobody holds (a dry quote pays nothing). */
const toOf = (dest) => (dest.startsWith("nep141:17208628") ? DEPOSIT_DRY_PLACEHOLDER : "0x000000000000000000000000000000000000beef");
const TIMEOUT_MS = 15_000;
const ANSWER_MAX = 65_536;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const q = "[`\"']";
/** A route's mark in a minified bundle: its own frozen pair literal, any quotes and spacing. */
export const routeMark = ([o, d]) => new RegExp(`Object\\.freeze\\(\\s*\\[\\s*${q}${esc(o)}${q}\\s*,\\s*${q}${esc(d)}${q}\\s*\\]\\s*\\)`);
export const routeName = ([o, d]) => `${o} > ${d}`;

/** What the check keeps of SIGN_HOST's reads: the pinned script's integrity, the served script's and the routes in it. */
export function facts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index ?? "")?.[1] ?? null, sha384: sha384(js),
    routes: ONECLICK_SAME_COIN_ROUTES.filter((r) => routeMark(r).test(js)).map(routeName) };
}

export function quoteRequest([origin, dest], mode, now) {
  return {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, ...(mode === "advanced" ? { confidentiality: "advanced" } : {}),
    originAsset: origin, depositType: "ORIGIN_CHAIN", destinationAsset: dest, amount: COIN[origin].amount, refundTo: DEPOSIT_DRY_PLACEHOLDER,
    refundType: "INTENTS", recipient: toOf(dest), recipientType: "DESTINATION_CHAIN", deadline: new Date(now + 30 * 60_000).toISOString(),
  };
}

/** Reads SIGN_HOST and every route's dry quote in both modes; returns the record judge() reads. */
export async function read(fetchFn = fetch, now = Date.now, pause = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) throw new Error(`${SIGN}${p}: HTTP ${r.status}`);
    return r.text();
  };
  const sign = facts(await get("/"), await get("/app.js"));
  const quotes = [];
  for (const route of ROUTES) for (const mode of MODES) {
    const request = quoteRequest(route, mode, now());
    let res;
    // the helper's 1Click share per caller: a 429 waits out its 10 s window, three times at most
    for (let k = 0; k < 4; k++) {
      res = await fetchFn(HELPER_QUOTE, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
        headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status !== 429 || k === 3) break;
      await res.text();
      await pause(11_000);
    }
    const text = await res.text();
    quotes.push({ route: routeName(route), mode, request, status: res.status, body: text.length > ANSWER_MAX ? null : text, at: now() });
    await pause(1_500);
  }
  return { sign, quotes };
}

/** The record as --record writes it: each JSON body without its signature (the test signs the replay itself). */
export function unsigned(rec) {
  const r = structuredClone(rec);
  for (const a of r.quotes ?? []) {
    if (typeof a.body !== "string") continue;
    try {
      const b = JSON.parse(a.body);
      if (b && typeof b === "object" && "signature" in b) { delete b.signature; a.body = JSON.stringify(b); }
    } catch { /* not JSON: kept as read */ }
  }
  return r;
}

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });
const NO_LIQUIDITY = /^No liquidity available\b/;
const show = (v) => JSON.stringify(v)?.slice(0, 160);

/** The verdict on a record { sign: facts, quotes: [...] }: { verdict, ok, lines }; ok only on PASS. */
export function judge(rec) {
  const lines = [];
  const vendor = [];
  let ok = true;
  const bad = (m) => { ok = false; lines.push(`BAD ${m}`); };
  const s = rec?.sign;
  if (!s?.pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (s.pin !== s.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const carried = Array.isArray(s?.routes) ? s.routes : [];
  const missing = ONECLICK_SAME_COIN_ROUTES.map(routeName).filter((r) => !carried.includes(r));
  if (missing.length) bad(`SIGN_HOST's /app.js lacks the kit's same-coin route${missing.length > 1 ? "s" : ""} ${missing.join(", ")}: its device refuses that deposit's quote (quote_check_failed)`);
  else lines.push(`ok  SIGN_HOST's /app.js carries all ${carried.length} same-coin routes, frozen`);
  const quotes = Array.isArray(rec?.quotes) ? rec.quotes : [];
  for (const route of ROUTES) for (const mode of MODES) {
    const name = `${routeName(route)} ${mode}`;
    const a = quotes.find((x) => x?.route === routeName(route) && x?.mode === mode);
    if (!a) { bad(`${name}: no quote read`); continue; }
    let body = null;
    try { body = typeof a.body === "string" ? JSON.parse(a.body) : null; } catch { /* judged below */ }
    if (a.status === 400 && NO_LIQUIDITY.test(body?.message ?? "")) { vendor.push(`INCONCLUSIVE ${name}: 1Click answered 400 No liquidity available: its solvers, not the kit`); continue; }
    if (a.status !== 200 && a.status !== 201) { bad(`${name}: HTTP ${a.status}, want 1Click's 200 or 201`); continue; }
    if (!body) { bad(`${name}: the answer is not JSON or over ${ANSWER_MAX} B`); continue; }
    // the request judged is the one the check builds for the route, never the record's own: a record cannot ask another route
    const [o, d] = route;
    if (a.request?.originAsset !== o || a.request?.destinationAsset !== d || (mode === "advanced") !== (a.request?.confidentiality === "advanced")) { bad(`${name}: the recorded request is not this route's`); continue; }
    const fee = oneClickFeeBps("partner", o, d);
    const fees = body?.quoteRequest?.appFees;
    const e = Array.isArray(fees) && fees.length === 1 ? fees[0] : null;
    if (!e || e.recipient !== COLLECTOR[mode] || e.fee !== fee) { bad(`${name}: appFees ${show(fees)}, the kit's rule wants [{ ${mode} collector, fee ${fee} }]`); continue; }
    if (mode === "public") {
      try {
        checkOneClickQuote(a.request, body, { path: "partner", pricing: { in: ["1", "1"], out: ["1", "1"] }, decimalsIn: COIN[o].decimals, decimalsOut: COIN[d].decimals, intoVault: false, now: a.at });
      } catch (err) { bad(`${name}: the device's whole check refuses it: ${err?.message ?? err}`); continue; }
    }
    lines.push(`ok  ${name}: fee ${fee}${mode === "public" ? ", the whole check passes" : ", the kit's rule"}`);
  }
  const verdict = !ok ? "FAIL" : vendor.length > 0 ? "INCONCLUSIVE" : "PASS";
  if (verdict === "INCONCLUSIVE") lines.push(...vendor);
  return { verdict, ok: verdict === "PASS", lines };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const rec = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : await read();
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(unsigned(rec), null, 1)}\n`);
    const { verdict, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
