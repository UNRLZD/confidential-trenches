#!/usr/bin/env node
// Live check of card near-listed-coin-quotes: every NEAR coin HELPER_HOST's lists offer is one a NEAR buy quotes. The
// device's quote (the kit's rheaQuote) reads Rhea classic's simple pools only, joining the coin to USDC directly or
// through wNEAR, so a coin the lists offer must hold such a pool of at least LIQ_MIN_USD (apps/helper/src/data/near/lists.ts
// routesOf and routed, the rule the helper's lists keep). Before the card the lists offered the engine's every coin, 30
// of 57 on Rhea DCL only, and a buy quote of hoodl-95275b.launchpad.justhoot.near answered no You receive.
// It reads, with Origin APP_HOST, GET /v1/market/lists?chain=near; then Rhea classic's pools (v2.ref-finance.near
// get_number_of_pools and get_pools in pages of PAGE) on two public NEAR RPCs of different operators at one final block
// (the lower of their two final heights), each page's bytes equal on both; and values each listed coin's deepest route.
//   PASS: the lists answer 200 with at least one NEAR coin, and every coin listed has a route of at least LIQ_MIN_USD.
//   FAIL: a coin listed with no such route (named, with its route's value), or the lists not answered.
//   INCONCLUSIVE: the two RPCs' pages differ or a read fails (no state to judge on), or the lists hold no NEAR coin.
// Records hold public values only: the coins, the block, each coin's route in USD.
// After: helper
//   node scripts/live-checks/near-listed-coin-quotes.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { VALUE_SCALE } from "../../apps/helper/src/data/candles.ts";
import { LIQ_MIN_USD, mainsOf, PAGE as HELPER_PAGE, parsePools, routesOf, usdText } from "../../apps/helper/src/data/near/lists.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "near-listed-coin-quotes";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
/** Two public NEAR RPCs of different operators (the kit's NEAR_RPC_URLS: FastNEAR and dRPC). */
export const RPCS = Object.freeze(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
export const REF = "v2.ref-finance.near";
/** Pools a get_pools page holds: the helper's own page (lists.ts PAGE, which parsePools bounds). */
export const PAGE = HELPER_PAGE;
const POOLS_MAX = 50_000;
const TIMEOUT_MS = 30_000;
const LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];

/** One read through the shared reader (provider-answer.mjs rpcAnswer); a no-answer or an error ends the read (no state). */
async function rpc(fetchFn, url, method, params) {
  const a = await rpcAnswer(url, method, params, { fetchFn });
  if (a.noAnswer !== undefined) throw new Error(a.noAnswer);
  if (a.error !== undefined || a.result?.error !== undefined) throw new Error(`${new URL(url).host}: ${JSON.stringify(a.error ?? a.result.error).slice(0, 160)}`);
  return a.result;
}
/** One view at `height` on every RPC: the bytes, refused unless every RPC gave the same ones at the same block. */
async function viewBoth(fetchFn, height, method, args) {
  const params = { request_type: "call_function", block_id: height, account_id: REF, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") };
  const got = await Promise.all(RPCS.map((u) => rpc(fetchFn, u, "query", params)));
  const bytes = got.map((g) => Buffer.from(g.result ?? []));
  if (got.some((g) => g.block_height !== height || g.block_hash !== got[0].block_hash) || bytes.some((b) => !b.equals(bytes[0]))) throw Object.assign(new Error(`${method}: the RPCs' answers differ at ${height}`), { differ: true });
  return { hash: got[0].block_hash, value: JSON.parse(bytes[0].toString("utf8")), sha: createHash("sha256").update(bytes[0]).digest("hex").slice(0, 16) };
}

/** The NEAR coins of a lists answer, each once, in list order. */
export function coinsOf(answer) {
  const out = [];
  for (const l of LISTS) for (const r of answer?.lists?.[l] ?? []) if (r?.chain === "near" && typeof r.token === "string" && !out.includes(r.token)) out.push(r.token);
  return out;
}

/** One run: the lists, then Rhea's pools on both RPCs at one block, and each listed coin's route. */
export async function read(base = BASE, fetchFn = fetch) {
  const rec = { base, at: new Date().toISOString(), rpcs: [...RPCS], lists: null, coins: [], block: null, routes: {}, error: null };
  const res = await fetchFn(`${base}/v1/market/lists?chain=near`, { headers: { origin: APP }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => ({ ok: false, status: null, e }));
  rec.lists = { status: res.status ?? null };
  if (!res.ok) return rec;
  rec.coins = coinsOf(await res.json().catch(() => null));
  if (rec.coins.length === 0) return rec;
  try {
    const finals = await Promise.all(RPCS.map((u) => rpc(fetchFn, u, "block", { finality: "final" })));
    const height = Math.min(...finals.map((b) => b.header.height));
    const n = await viewBoth(fetchFn, height, "get_number_of_pools", {});
    if (!Number.isSafeInteger(n.value) || n.value < 1 || n.value > POOLS_MAX) throw new Error(`get_number_of_pools: ${n.value}`);
    const pools = [];
    const pages = [];
    for (let from = 0; from < n.value; from += PAGE) {
      const p = await viewBoth(fetchFn, height, "get_pools", { from_index: from, limit: PAGE });
      const rows = parsePools(p.value, from);
      if (rows === null || p.value.length > PAGE) throw new Error(`get_pools from ${from}: not a page`);
      pools.push(...rows);
      pages.push(p.sha);
    }
    const { nearUsd } = mainsOf(pools);
    const routes = routesOf(pools, nearUsd);
    rec.block = { height, hash: n.hash, pools: n.value, pages, near_usd: nearUsd === null ? null : usdText(nearUsd) };
    for (const c of rec.coins) rec.routes[c] = routes.has(c) ? usdText(routes.get(c)) : null;
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
  else if (run.error || run.block === null) (quiet = true), lines.push(`no-answer Rhea's pools not read on both RPCs: ${run.error?.message ?? "no block"}`);
  else {
    say(true, `${run.coins.length} NEAR coins listed; Rhea classic's ${run.block.pools} pools read on ${run.rpcs.length} RPCs at block ${run.block.height}, every page equal; NEAR $${run.block.near_usd}`);
    for (const c of run.coins) {
      const v = run.routes?.[c];
      const ok = typeof v === "string" && Number(v) >= floor;
      if (!ok) say(false, v === null || v === undefined ? `${c} listed with no Rhea classic pool with wNEAR or USDC: a NEAR buy quotes none` : `${c} listed with a route of $${v}, under $${floor}`);
    }
    if (!lines.some((l) => l.startsWith("BAD"))) say(true, `every listed coin has a route of at least $${floor}`);
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
