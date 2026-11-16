#!/usr/bin/env node
// Live check of card near-dcl-route: NEAR coins that trade only on Rhea DCL are back on HELPER_HOST's lists, and the
// device quotes them. The device's NEAR quote reads Rhea classic's simple pools (the kit's rheaQuote) and Rhea DCL's
// pools (the kit's dclQuote, DCL's own quote view), joining a coin to USDC directly or through wNEAR; the helper's lists
// offer a coin only with such a route of at least LIQ_MIN_USD (apps/helper/src/data/near/lists.ts routesOf and routed).
// Before the card the lists counted classic routes only, so the 30 of 57 coins the engine listed on DCL alone
// (hoodl-95275b.launchpad.justhoot.near among them) were off the lists.
// It reads, with Origin APP_HOST, GET /v1/market/lists?chain=near; then, on two public NEAR RPCs of different operators
// at one final block (the lower of their two final heights), each page's bytes equal on both: Rhea classic's pools
// (get_number_of_pools, get_pools) and DCL's (get_metadata pool_count, list_pools), and values each listed coin's
// deepest route; then the kit's dclQuote of a 1 USDC buy of the first coin listed whose only route is DCL.
//   PASS: the lists answer 200; every coin listed has a route of at least LIQ_MIN_USD; at least one listed coin has one
//         only once DCL is counted; and the device's DCL quote of it pays more than 0.
//   FAIL: a coin listed with no such route (named), no DCL-only coin listed, the device's DCL quote of it refused or 0,
//         or the lists not answered.
//   INCONCLUSIVE: the two RPCs' pages differ or a read fails (no state to judge on), the quote's providers fail or
//         disagree after QUOTE_TRIES asks, or the lists hold no NEAR coin.
// Records hold public values only: the coins, the block, each coin's route in USD, the quote's pools and amount.
// After: helper
//   node scripts/live-checks/near-dcl-route.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { VALUE_SCALE } from "../../apps/helper/src/data/candles.ts";
import { DCL, DCL_PAGE, LIQ_MIN_USD, mainsOf, PAGE, parseDclPools, parsePools, REF, routed, routesOf, usdText, WNEAR } from "../../apps/helper/src/data/near/lists.ts";
import { dclQuote } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "near-dcl-route";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Two public NEAR RPCs of different operators (the kit's NEAR_RPC_URLS: FastNEAR and dRPC), the kit's mainnet pair. */
export const RPCS = Object.freeze(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The quote's size: 1 USDC. */
export const QUOTE_IN = 1_000_000n;
const POOLS_MAX = 50_000;
const TIMEOUT_MS = 30_000;
const FEES = [100, 400, 2000, 10000];
/** The quote's refusals that are a provider's, not DCL's: no state to judge on. */
const PROVIDER_CODES = ["rpc", "disagree", "lag"];
const QUOTE_TRIES = 3;
const QUOTE_GAP_MS = 3_000;

const LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];

/** The NEAR coins of a lists answer, each once, in list order (moved from near-listed-coin-quotes.mjs, which re-exports it). */
export function coinsOf(answer) {
  const out = [];
  for (const l of LISTS) for (const r of answer?.lists?.[l] ?? []) if (r?.chain === "near" && typeof r.token === "string" && !out.includes(r.token)) out.push(r.token);
  return out;
}

async function rpc(fetchFn, url, method, params) {
  const a = await rpcAnswer(url, method, params, { fetchFn });
  if (a.noAnswer !== undefined) throw new Error(a.noAnswer);
  if (a.error !== undefined || a.result?.error !== undefined) throw new Error(`${new URL(url).host}: ${JSON.stringify(a.error ?? a.result.error).slice(0, 160)}`);
  return a.result;
}
/** One view at `height` on every RPC: the value, refused unless every RPC gave the same bytes at the same block. */
async function viewBoth(fetchFn, height, contract, method, args) {
  const params = { request_type: "call_function", block_id: height, account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") };
  const got = await Promise.all(RPCS.map((u) => rpc(fetchFn, u, "query", params)));
  const bytes = got.map((g) => Buffer.from(g.result ?? []));
  if (got.some((g) => g.block_height !== height || g.block_hash !== got[0].block_hash) || bytes.some((b) => !b.equals(bytes[0]))) throw Object.assign(new Error(`${contract} ${method}: the RPCs' answers differ at ${height}`), { differ: true });
  return { hash: got[0].block_hash, value: JSON.parse(bytes[0].toString("utf8")), sha: createHash("sha256").update(bytes[0]).digest("hex").slice(0, 16) };
}

/** Both exchanges' pools at one final block on both RPCs, and every token's route: classic only, and classic or DCL. */
export async function readRoutes(fetchFn = fetch) {
  const finals = await Promise.all(RPCS.map((u) => rpc(fetchFn, u, "block", { finality: "final" })));
  const height = Math.min(...finals.map((b) => b.header.height));
  const n = await viewBoth(fetchFn, height, REF, "get_number_of_pools", {});
  if (!Number.isSafeInteger(n.value) || n.value < 1 || n.value > POOLS_MAX) throw new Error(`get_number_of_pools: ${n.value}`);
  const pools = [];
  const pages = [];
  for (let from = 0; from < n.value; from += PAGE) {
    const p = await viewBoth(fetchFn, height, REF, "get_pools", { from_index: from, limit: PAGE });
    const rows = parsePools(p.value, from);
    if (rows === null) throw new Error(`get_pools from ${from}: not a page`);
    pools.push(...rows);
    pages.push(p.sha);
  }
  const m = await viewBoth(fetchFn, height, DCL, "get_metadata", {});
  const dn = Number(m.value?.pool_count);
  if (!Number.isSafeInteger(dn) || dn < 1 || dn > POOLS_MAX) throw new Error(`DCL pool_count: ${m.value?.pool_count}`);
  const dcl = [];
  for (let from = 0; from < dn; from += DCL_PAGE) {
    const p = await viewBoth(fetchFn, height, DCL, "list_pools", { from_index: from, limit: DCL_PAGE });
    const rows = parseDclPools(p.value);
    if (rows === null) throw new Error(`list_pools from ${from}: not a page`);
    dcl.push(...rows);
    pages.push(p.sha);
  }
  const { nearUsd } = mainsOf(pools);
  return { block: { height, hash: n.hash, pools: n.value, dcl_pools: dn, pages, near_usd: nearUsd === null ? null : usdText(nearUsd) }, classic: routesOf(pools, nearUsd), all: routesOf(pools, nearUsd, dcl), dcl };
}

/** The device's DCL quote of a 1 USDC buy of `token`, on the kit's pair (FastNEAR and dRPC), over its DCL pools. */
export async function quoteDcl(token, dcl, fetchFn = fetch) {
  const ids = [...dcl.filter((p) => p.tokens.includes(token) && (p.tokens.includes(WNEAR) || p.tokens.includes(USDC))), ...dcl.filter((p) => p.tokens.includes(USDC) && p.tokens.includes(WNEAR))]
    .map((p) => p.id)
    .filter((id) => FEES.includes(Number(id.split("|")[2])))
    .slice(0, 8);
  const rpcs = RPCS.map((url) => ({ name: url, query: (params) => rpc(fetchFn, url, "query", params).then((result) => ({ result })) }));
  // a provider's refusal (its rate limit after the page reads, a lag) is asked again, up to QUOTE_TRIES, QUOTE_GAP_MS apart
  let last = null;
  for (let i = 0; i < QUOTE_TRIES; i++) {
    if (i > 0) await new Promise((ok) => setTimeout(ok, QUOTE_GAP_MS));
    try {
      const q = await dclQuote({ network: "mainnet", rpcs, side: "buy", token, amountIn: QUOTE_IN, pools: ids });
      return { token, pools: ids, path: [...q.poolIds], height: q.height, venue_out: String(q.venueOut), amount_out: String(q.amountOut), refused: null, code: null };
    } catch (e) {
      last = { token, pools: ids, path: null, height: null, venue_out: null, amount_out: null, refused: String(e?.message ?? e).slice(0, 200), code: typeof e?.code === "string" ? e.code : null };
      if (!PROVIDER_CODES.includes(last.code)) break;
    }
  }
  return last;
}

/** One run: the lists, both exchanges' pools on both RPCs at one block, each listed coin's route, and one DCL quote. */
export async function read(base = BASE, fetchFn = fetch) {
  const rec = { base, at: new Date().toISOString(), rpcs: [...RPCS], lists: null, coins: [], block: null, routes: {}, dcl_only: [], quote: null, error: null };
  const res = await fetchFn(`${base}/v1/market/lists?chain=near`, { headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => ({ ok: false, status: null, e }));
  rec.lists = { status: res.status ?? null };
  if (!res.ok) return rec;
  rec.coins = coinsOf(await res.json().catch(() => null));
  if (rec.coins.length === 0) return rec;
  try {
    const r = await readRoutes(fetchFn);
    rec.block = r.block;
    for (const c of rec.coins) rec.routes[c] = r.all.has(c) ? usdText(r.all.get(c)) : null;
    // a coin that routes (at least LIQ_MIN_USD) only once DCL is counted
    rec.dcl_only = rec.coins.filter((c) => routed({ routes: r.all }, c) && !routed({ routes: r.classic }, c));
    if (rec.dcl_only.length > 0) rec.quote = await quoteDcl(rec.dcl_only[0], r.dcl, fetchFn);
  } catch (e) {
    rec.error = { differ: e?.differ === true, message: String(e?.message ?? e).slice(0, 200) };
  }
  return rec;
}

/** The verdict on one run (read's record): { ok, quiet, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const floor = Number(usdText(LIQ_MIN_USD * 10n ** BigInt(VALUE_SCALE)));
  if (run?.lists?.status !== 200) say(false, `the lists answered ${JSON.stringify(run?.lists?.status ?? null)}, not 200`);
  else if ((run.coins ?? []).length === 0) (quiet = true), lines.push("no-answer the lists hold no NEAR coin");
  else if (run.error || run.block === null) (quiet = true), lines.push(`no-answer the pools not read on both RPCs: ${run.error?.message ?? "no block"}`);
  else {
    say(true, `${run.coins.length} NEAR coins listed; Rhea classic's ${run.block.pools} and DCL's ${run.block.dcl_pools} pools read on ${run.rpcs.length} RPCs at block ${run.block.height}, every page equal`);
    for (const c of run.coins) {
      const v = run.routes?.[c];
      if (!(typeof v === "string" && Number(v) >= floor)) say(false, v === null || v === undefined ? `${c} listed with no Rhea classic or DCL pool with wNEAR or USDC: a NEAR buy quotes none` : `${c} listed with a route of $${v}, under $${floor}`);
    }
    const only = (run.dcl_only ?? []).filter((c) => run.coins.includes(c));
    if (only.length === 0) say(false, "no coin listed whose only route is Rhea DCL: the DCL coins are still off the lists");
    else {
      say(true, `${only.length} coins listed on Rhea DCL alone, ${only[0]} first`);
      const q = run.quote;
      const out = q?.token === only[0] && typeof q.venue_out === "string" && /^\d+$/.test(q.venue_out) ? BigInt(q.venue_out) : 0n;
      if (out > 0n) say(true, `the device's DCL quote of 1 USDC of ${q.token} pays ${q.venue_out} through ${q.path.join(" then ")}`);
      else if (PROVIDER_CODES.includes(q?.code)) (quiet = true), lines.push(`no-answer the device's DCL quote of ${only[0]}: the providers did not answer as one: ${q.refused}`);
      else say(false, `the device's DCL quote of 1 USDC of ${only[0]} ${q?.refused ? `was refused: ${q.refused}` : "paid nothing"}`);
    }
  }
  const bad = lines.some((l) => l.startsWith("BAD"));
  return { ok: !bad && !quiet, quiet, verdict: verdictOf(bad, quiet), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${run.base})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e?.message ?? e).split("\n")[0]}`);
    process.exit(EXIT.ERROR);
  }
}
