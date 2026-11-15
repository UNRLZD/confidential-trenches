#!/usr/bin/env node
// Live check of card evm-token-page-opens-any-coin: a Base or Robinhood coin opens its page, holders, chart and tape on
// the helper whether or not Discover's lists served it (apps/helper/src/data/evm/named.ts, token.ts rowOf, server.ts
// evmKnown). It reads at HELPER_HOST, with Origin APP_HOST, two coins no list carried when the card was made: Robinhood
// MOW (0x0b7c...94fa, the chain's busiest by 24 h volume at 15:45Z on 15 Nov) and Base DEGEN (0x4ed4...efed):
//   GET /v1/market/token?chain=<chain>&token=<coin>      200, the page in its frozen fields, row.token the coin
//   GET /v1/market/holders?chain=<chain>&token=<coin>    200, the holders fields
//   GET /v1/market/candles?chain=<chain>&token=<coin>&tf=1m&limit=50   200 with a list of bars
//   GET /v1/market/trades?chain=<chain>&token=<coin>&limit=20          200 with a list of trades
// and two addresses that are no coin, which must still answer 404 not_found: Base's 0x...0001 (DexScreener names no pair
// for it, read 20:20Z) and a malformed address. Before the card the helper answered every one of the coins' reads 404
// (live 20:10Z). A first open of a chart or a tape may answer 200 `filling` while its read goes on: it is read again,
// up to REREADS times, FILL_WAIT_MS apart, and passes on 200 either way. Whether the lists hold the coin at the read is
// printed, not judged (a coin that trends again is still a coin).
// After: helper
// Serial: evm-keyed 190 (its chart and tape reads draw the keyed Base and Robinhood providers)
//   node scripts/live-checks/evm-token-page-opens-any-coin.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { ROW_FIELDS as TERMINAL_FIELDS } from "../../apps/terminal/src/screens/discover/fields.ts";

const KEY = "evm-token-page-opens-any-coin";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const COINS = [
  { chain: "robinhood", address: "0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa", symbol: "MOW" },
  { chain: "base", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", symbol: "DEGEN" },
];
export const NOT_COINS = [
  { chain: "base", address: "0x0000000000000000000000000000000000000001" },
  { chain: "robinhood", address: "0x12" },
];
export const REREADS = 3;
export const FILL_WAIT_MS = 5_000;
export const READS = {
  lists: (c) => `/v1/market/lists?chain=${c}`,
  token: (c, t) => `/v1/market/token?chain=${c}&token=${t}`,
  holders: (c, t) => `/v1/market/holders?chain=${c}&token=${t}`,
  candles: (c, t) => `/v1/market/candles?chain=${c}&token=${t}&tf=1m&limit=50`,
  trades: (c, t) => `/v1/market/trades?chain=${c}&token=${t}&limit=20`,
};
export const ROW = [...TERMINAL_FIELDS];
export const PAGE = ["row", "decimals", "pool", "risk", "route", "filling", "links"];
export const HOLDERS = ["holders", "total", "top_bps", "src", "as_of_ms"];
const SHA = /^[0-9a-f]{40}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (o, keys) => isObj(o) && JSON.stringify(Object.keys(o)) === JSON.stringify(keys);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const none = { status: 0, headers: {}, body: "" };

/** The first thing wrong with one read's body of `kind` for `coin`, or null. */
export function fault(kind, coin, b) {
  if (kind === "token") {
    if (!same(b, PAGE)) return `page fields ${show(isObj(b) ? Object.keys(b) : b)}`;
    if (!same(b.row, ROW)) return "row: not the terminal's Row fields";
    if (b.row.chain !== coin.chain || b.row.token !== coin.address) return `row names ${show(b.row.chain)} ${show(b.row.token)}`;
    for (const f of ["symbol", "name", "src"]) if (typeof b.row[f] !== "string" || b.row[f] === "") return `row.${f} ${show(b.row[f])}`;
    return null;
  }
  if (kind === "holders") return same(b, HOLDERS) ? null : `holders fields ${show(isObj(b) ? Object.keys(b) : b)}`;
  if (kind === "candles") return isObj(b) && Array.isArray(b.candles) ? null : "no candles list";
  return isObj(b) && Array.isArray(b.trades) ? null : "no trades list";
}

/** The check of one run: { base, readAt, coins: { <chain>: { lists, token, holders, candles: [reads], trades: [reads] } },
 *  not: [{ chain, address, read }] }, each read { at, ms, status, headers, body }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const coin of COINS) {
    const c = run.coins?.[coin.chain] ?? {};
    const listed = c.lists?.status === 200 && Object.values(parse(c.lists.body)?.lists ?? {}).some((rows) => Array.isArray(rows) && rows.some((r) => r?.token === coin.address));
    lines.push(`--  ${coin.chain} ${coin.symbol}: ${c.lists?.status === 200 ? (listed ? "on the lists at the read" : "on no list at the read") : `lists answered ${c.lists?.status ?? "nothing"}`}`);
    for (const kind of ["token", "holders", "candles", "trades"]) {
      const reads = Array.isArray(c[kind]) ? c[kind] : [c[kind] ?? none];
      const r = reads[reads.length - 1] ?? none;
      const h = r.headers ?? {};
      const b = parse(r.body);
      const f = r.status === 200 ? fault(kind, coin, b) : `answers ${r.status} ${r.body.slice(0, 80)}`;
      say(r.status === 200 && f === null, `${coin.chain} ${coin.symbol} ${kind}: GET ${READS[kind](coin.chain, coin.address)} answers ${r.status}${f === null ? "" : `: ${f}`}${reads.length > 1 ? ` (read ${reads.length} times)` : ""}`);
      say(SHA.test(h["x-helper-commit"] ?? ""), `${coin.chain} ${kind} X-Helper-Commit: ${show(h["x-helper-commit"])}`);
      say(h["access-control-allow-origin"] === APP, `${coin.chain} ${kind} Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
      if (r.status === 200 && f === null) {
        if (kind === "token") lines.push(`--  ${coin.chain} page: ${b.row.symbol}, src ${b.row.src}, launchpad ${show(b.row.launchpad)}, price ${show(b.row.price_usd)}, liq ${show(b.row.liq_usd)}, ${r.ms} ms`);
        if (kind === "candles") lines.push(`--  ${coin.chain} chart: ${b.candles.length} bars, src ${show(b.src)}${b.filling ? ", filling" : ""}, ${r.ms} ms`);
        if (kind === "trades") lines.push(`--  ${coin.chain} tape: ${b.trades.length} trades, src ${show(b.src)}${b.filling ? ", filling" : ""}, ${r.ms} ms`);
      }
    }
  }
  for (const n of NOT_COINS) {
    const x = (run.not ?? []).find((y) => y.chain === n.chain && y.address === n.address)?.read ?? none;
    const b = parse(x.body);
    say(x.status === 404 && b?.error?.code === "not_found", `${n.chain} ${n.address} (no coin): GET ${READS.token(n.chain, n.address)} answers ${x.status} ${x.body.slice(0, 60)}`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

async function get(base, path, fetchFn) {
  const at = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { at, ms: Math.round(performance.now() - t0), status: r.status, headers, body };
}

/** A chart or tape read, read again while it answers 200 filling, up to REREADS times `wait` apart. */
async function filled(base, path, fetchFn, wait) {
  const reads = [await get(base, path, fetchFn)];
  while (reads.length <= REREADS && reads.at(-1).status === 200 && parse(reads.at(-1).body)?.filling === true) {
    await wait(FILL_WAIT_MS);
    reads.push(await get(base, path, fetchFn));
  }
  return reads;
}

export async function read(base = BASE, fetchFn = fetch, wait = (ms) => new Promise((ok) => setTimeout(ok, ms))) {
  const readAt = new Date().toISOString();
  const coins = {};
  for (const coin of COINS) {
    const c = (coins[coin.chain] = { lists: await get(base, READS.lists(coin.chain), fetchFn) });
    c.token = await get(base, READS.token(coin.chain, coin.address), fetchFn);
    c.holders = await get(base, READS.holders(coin.chain, coin.address), fetchFn);
    c.candles = await filled(base, READS.candles(coin.chain, coin.address), fetchFn, wait);
    c.trades = await filled(base, READS.trades(coin.chain, coin.address), fetchFn, wait);
  }
  const not = [];
  for (const n of NOT_COINS) not.push({ ...n, read: await get(base, READS.token(n.chain, n.address), fetchFn) });
  return { base, readAt, coins, not };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
