#!/usr/bin/env node
// Live check of card market-token-reads: Portfolio's held tokens have a symbol, a name and a USD price on Solana, Base
// and Robinhood, read in one request a chain, and an hourly history, within the 1 s quote bar. For each chain it reads
// the helper's own lists at HELPER_HOST and takes one token from them (the first row of trending_1h, then new); on Base
// it adds USDC (0x8335...2913), a real token the lists do not carry, which the token page answers 404 for. With Origin
// APP_HOST it reads, as the kit's readHeldMarket and readHeldHistory do (packages/kit/src/market/held.ts):
//   GET /v1/market/held?chain=<chain>&token=<t>[&token=<t2>]   (the tokens sorted, as the kit sends them)
//   GET /v1/market/candles?chain=<chain>&token=<t>&tf=1h&limit=500
//   GET /v1/market/held?chain=near&token=usdc.near            (NEAR holds no traded token: 404)
// It passes only when each held read answers 200 JSON within SPEED_MS with X-Helper-Commit a full sha and
// Access-Control-Allow-Origin echoing APP_HOST, its body exactly {tokens, as_of_ms} with one entry {token, symbol, name,
// price_usd, src} per asked token in the asked order, each naming a symbol and a plain decimal price, and the kit's own
// read of that answer names every token; each listed token's candles read answers 200 with hourly bars the kit takes (at
// least one; the off-list token's is reported only: the helper reads an EVM token's swaps only once its lists carried
// it, so the value line holds that token at its present price); and NEAR answers 404. Display data only: nothing it reads feeds a signature.
// Each candles read is read as the token page reads it (candles-read.mjs): a 429 again at its Retry-After, for at most
// one 75 s span in the run; a 429 still standing after it, or a 200 with no bars, is BAD as any other answer.
// After: helper
//   node scripts/live-checks/market-token-reads.mjs [--base <url>] [--record <file>] [--speed <n>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read; --speed times n more held reads a chain.
import "../net-window.mjs";
import { candlesReader, waitsText } from "./candles-read.mjs";
import { writeFileSync } from "node:fs";
import { readHeldHistory, readHeldMarket } from "../../packages/kit/src/index.ts";

const KEY = "market-token-reads";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["solana", "base", "robinhood"];
/** Base's USDC: a real token Discover's lists do not carry (its token page answers 404). */
export const OFF_LIST = { base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
/** The quote bar: a held token's price read answers within it. */
export const SPEED_MS = 1000;
export const ENTRY = ["token", "symbol", "name", "price_usd", "src"];
const SHA = /^[0-9a-f]{40}$/;
const PRICE = /^\d{1,30}(\.\d{1,40})?$/;
export const READS = {
  lists: (c) => `/v1/market/lists?chain=${c}`,
  held: (c, tokens) => `/v1/market/held?${new URLSearchParams([["chain", c], ...[...tokens].sort().map((t) => ["token", t])])}`,
  candles: (c, t) => `/v1/market/candles?${new URLSearchParams({ chain: c, token: t, tf: "1h", limit: "500" })}`,
  near: () => "/v1/market/held?chain=near&token=usdc.near",
};
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** The tokens the check reads on `chain` from its lists answer: the first row of trending_1h, then new, and the chain's
 *  off-list token; empty when the lists hold none. */
export function pick(chain, snapshot) {
  const row = ["trending_1h", "new"].flatMap((k) => (Array.isArray(snapshot?.lists?.[k]) ? snapshot.lists[k] : [])).find((r) => isObj(r) && typeof r.token === "string" && r.token !== "");
  if (!row) return [];
  return OFF_LIST[chain] && OFF_LIST[chain] !== row.token ? [row.token, OFF_LIST[chain]] : [row.token];
}

/** The first thing wrong with a held body for `asked` (sorted), or null. */
export function heldFault(asked, b) {
  if (!isObj(b) || JSON.stringify(Object.keys(b)) !== JSON.stringify(["tokens", "as_of_ms"])) return `body keys ${show(isObj(b) ? Object.keys(b) : b)}`;
  if (!Number.isSafeInteger(b.as_of_ms)) return `as_of_ms ${show(b.as_of_ms)}`;
  if (!Array.isArray(b.tokens) || b.tokens.length !== asked.length) return `tokens: ${Array.isArray(b.tokens) ? b.tokens.length : "not a list"}, asked ${asked.length}`;
  for (let i = 0; i < asked.length; i++) {
    const e = b.tokens[i];
    if (!isObj(e) || JSON.stringify(Object.keys(e)) !== JSON.stringify(ENTRY)) return `entry ${i} keys ${show(isObj(e) ? Object.keys(e) : e)}`;
    if (e.token !== asked[i]) return `entry ${i} names ${show(e.token)}, asked ${asked[i]}`;
    if (typeof e.symbol !== "string" || e.symbol === "" || e.symbol.length > 32) return `${asked[i]}: symbol ${show(e.symbol)}`;
    if (typeof e.price_usd !== "string" || !PRICE.test(e.price_usd)) return `${asked[i]}: price_usd ${show(e.price_usd)}`;
  }
  return null;
}

/** A fetch that answers one recorded read, so the kit's own parse judges what the helper sent. */
const answering = (r) => async () => new Response(r.body, { status: r.status, headers: r.headers });

/** The check of one run: { base, readAt, chains: { <chain>: { lists, held, candles: {<token>: read} } }, near }, each read
 *  { at, ms, status, headers, body }. */
export async function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const chain of CHAINS) {
    const c = run.chains?.[chain] ?? {};
    const lists = c.lists ?? { status: 0, headers: {}, body: "" };
    const asked = lists.status === 200 ? pick(chain, parse(lists.body)).sort() : [];
    say(asked.length > 0, `${chain}: GET ${READS.lists(chain)} answers ${lists.status}${asked.length ? `, reads ${asked.join(", ")}` : ", no token to read"}`);
    if (asked.length === 0) continue;
    const r = c.held ?? { status: 0, ms: Infinity, headers: {}, body: "" };
    const h = r.headers ?? {};
    say(r.status === 200, `${chain}: GET ${READS.held(chain, asked)} answers ${r.status}`);
    say(r.status === 200 && r.ms <= SPEED_MS, `${chain}: the held read answered in ${r.ms} ms, within ${SPEED_MS} ms`);
    say(/^application\/json/i.test(h["content-type"] ?? ""), `${chain} held Content-Type: ${show(h["content-type"])}`);
    say(SHA.test(h["x-helper-commit"] ?? ""), `${chain} held X-Helper-Commit: ${show(h["x-helper-commit"])}`);
    say(h["access-control-allow-origin"] === APP, `${chain} held Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
    const b = parse(r.body);
    const f = r.status === 200 ? heldFault(asked, b) : "not a 200";
    say(f === null, `${chain} held: one entry a token, in order, each with a symbol and a price${f === null ? "" : `: ${f}`}`);
    const kit = await readHeldMarket(run.base, asked.map((token) => ({ chain, token })), answering(r));
    const named = kit.filter((m) => m.symbol !== null && m.price_usd !== null);
    say(named.length === asked.length, `${chain}: the kit's read names ${named.length} of ${asked.length}${named.length ? ` (${named.map((m) => `${m.symbol} $${m.price_usd}`).join(", ")})` : ""}`);
    for (const t of asked) {
      const k = c.candles?.[t] ?? { status: 0, headers: {}, body: "" };
      const bars = k.status === 200 ? await readHeldHistory(run.base, { chain, token: t }, answering(k)) : [];
      const line = `${chain}: GET ${READS.candles(chain, t)} answers ${k.status}${waitsText(k)}, the kit takes ${bars.length} hourly bars`;
      // an EVM token the lists do not carry has no history from the helper (its swap reads open only listed tokens):
      // the value line holds it at its present price, so its candles are reported, not required
      if (t === OFF_LIST[chain]) lines.push(`--  ${line} (off the lists: not required)`);
      else say(bars.length > 0, line);
    }
  }
  const n = run.near ?? { status: 0 };
  say(n.status === 404, `near: GET ${READS.near()} answers ${n.status}`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

async function get(base, path, fetchFn) {
  const at = new Date().toISOString();
  const t0 = performance.now();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const body = await r.text();
  return { at, ms: Math.round(performance.now() - t0), status: r.status, headers, body };
}

/** `reader`: the run's candles reader (candles-read.mjs): a 429 is read again at its Retry-After, as the page reads it. */
export async function read(base = BASE, fetchFn = fetch, reader = candlesReader()) {
  const readAt = new Date().toISOString();
  const chains = {};
  for (const chain of CHAINS) {
    const lists = await get(base, READS.lists(chain), fetchFn);
    const asked = lists.status === 200 ? pick(chain, parse(lists.body)).sort() : [];
    chains[chain] = { lists };
    if (asked.length === 0) continue;
    chains[chain].held = await get(base, READS.held(chain, asked), fetchFn);
    chains[chain].candles = {};
    for (const t of asked) chains[chain].candles[t] = await reader.read(() => get(base, READS.candles(chain, t), fetchFn));
  }
  return { base, readAt, chains, near: await get(base, READS.near(), fetchFn) };
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = await judge(run);
    for (const l of lines) console.log(l);
    const n = Number(opt("--speed", "0"));
    if (n > 0)
      for (const chain of CHAINS) {
        const asked = pick(chain, parse(run.chains[chain]?.lists?.body ?? "")).sort();
        if (asked.length === 0) continue;
        const ms = [];
        for (let i = 0; i < n; i++) ms.push((await get(base, READS.held(chain, asked), fetch)).ms);
        console.log(`speed: ${chain} ${n} held reads, p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms`);
      }
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
