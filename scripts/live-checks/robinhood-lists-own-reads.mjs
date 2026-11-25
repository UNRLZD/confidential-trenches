#!/usr/bin/env node
// Live check of card robinhood-lists-own-reads: Discover's Robinhood Trending 5m and 1h come from the helper's own reads
// of the chain's swaps (its swap index, counted by apps/helper/src/data/evm/trend.ts) and DexScreener's pairs of the
// busiest pools, never from GeckoTerminal's trending lists (apps/helper/src/data/evm/lists.ts own). One read of
// /v1/market/lists?chain=robinhood, then for each of trending_5m and trending_1h:
//   - at least MIN_ROWS rows, at most OWN_ROWS;
//   - every row's src is "dexscreener" (a GeckoTerminal row says "geckoterminal": the list was read from it);
//   - no row is the chain's own quote (WETH, USDG or native ETH: WETH/USDG is no coin's trend);
//   - each token once, and each row's liquidity at least LIQ_MIN_USD;
//   - the rows by the window's volume (vol_5m_usd, vol_1h_usd), the busiest first;
//   - each row read within STALE_MS of the answer's Date.
// New stays GeckoTerminal's in this card and is not judged.
// After: helper
//   node scripts/live-checks/robinhood-lists-own-reads.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "robinhood-lists-own-reads";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const LISTS = ["trending_5m", "trending_1h"];
export const VOLUME = { trending_5m: "vol_5m_usd", trending_1h: "vol_1h_usd" };
/** apps/helper/src/data/evm/lists.ts OWN_ROWS, STALE_MS; near/lists.ts LIQ_MIN_USD. */
export const OWN_ROWS = 20;
export const STALE_MS = 300_000;
export const LIQ_MIN_USD = 1_000;
/** A list this short is no list [design: the recorded busiest 40 pools made 16 coins' rows, 2026-11-25 07:37Z]. */
export const MIN_ROWS = 5;
/** Robinhood's WETH, USDG and native ETH (apps/helper/src/data/evm/swaps.ts ROBINHOOD_VENUES, ZERO). */
export const QUOTES = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "0x0000000000000000000000000000000000000000"]);

/** The answer: its status, Date and body. */
export async function read(base = BASE, fetchFn = fetch) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/market/lists?chain=robinhood`, { headers: { origin: APP } });
  return { status: r.status, date: r.headers.get("date"), body: await r.text() };
}

/** { ok, lines }: each list judged as the header says. */
export function judge(a) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  if (a.status !== 200) return { ok: false, lines: [`BAD /v1/market/lists?chain=robinhood answered ${a.status}`] };
  let s;
  try {
    s = JSON.parse(a.body);
  } catch {
    return { ok: false, lines: ["BAD the answer is not JSON"] };
  }
  const at = Date.parse(a.date ?? "");
  if (!Number.isFinite(at)) bad(`no Date on the answer (${JSON.stringify(a.date)})`);
  for (const k of LISTS) {
    const rows = Array.isArray(s?.lists?.[k]) ? s.lists[k] : null;
    if (rows === null) {
      bad(`${k}: no list`);
      continue;
    }
    const before = lines.length;
    if (rows.length < MIN_ROWS || rows.length > OWN_ROWS) bad(`${k}: ${rows.length} rows, not ${MIN_ROWS} to ${OWN_ROWS}`);
    const seen = new Set();
    rows.forEach((x, i) => {
      const name = `${k} ${x?.symbol} ${x?.token}`;
      if (x?.src !== "dexscreener") bad(`${name}: src ${JSON.stringify(x?.src)}, not our own trending (GeckoTerminal's list)`);
      if (QUOTES.has(String(x?.token).toLowerCase())) bad(`${name}: the chain's own quote is no coin's row`);
      if (seen.has(x?.token)) bad(`${name}: listed twice`);
      seen.add(x?.token);
      if (!(Number(x?.liq_usd) >= LIQ_MIN_USD)) bad(`${name}: liquidity ${x?.liq_usd} under ${LIQ_MIN_USD} USD`);
      if (i > 0 && !(Number(rows[i - 1]?.[VOLUME[k]]) >= Number(x?.[VOLUME[k]]))) bad(`${name}: ${VOLUME[k]} ${x?.[VOLUME[k]]} above the row before (${rows[i - 1]?.[VOLUME[k]]})`);
      if (Number.isFinite(at) && !(at - Number(x?.as_of_ms) <= STALE_MS)) bad(`${name}: read ${at - Number(x?.as_of_ms)} ms before the answer, past ${STALE_MS}`);
    });
    if (lines.length === before) lines.push(`GOOD ${k}: ${rows.length} rows from our own swaps, by ${VOLUME[k]}: ${rows.slice(0, 5).map((x) => x.symbol).join(", ")}`);
  }
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

async function main() {
  const args = process.argv.slice(2);
  const at = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
  const base = at("--base") ?? BASE;
  const a = await read(base);
  if (at("--record") !== undefined) writeFileSync(at("--record"), JSON.stringify({ recorded_at: new Date().toISOString(), base, answer: a }, null, 1));
  const { ok, lines } = judge(a);
  for (const l of lines) console.log(l);
  console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${base})`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(`live-check ${KEY}: error ${e?.message ?? e}`);
    process.exit(2);
  });
