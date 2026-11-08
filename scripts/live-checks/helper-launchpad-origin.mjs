#!/usr/bin/env node
// Live check of card helper-launchpad-origin: every Solana token's launchpad tag on Discover's lists is what the chain
// says made it (apps/helper/src/data/solana/origin.ts). It reads GET /v1/market/lists?chain=solana at HELPER_HOST with
// Origin APP_HOST and passes only when:
//   - the answer is 200 JSON with the five lists and `unsettled`: a list of listed tokens, each of their rows untagged,
//     at most half the listed tokens;
//   - every tag is one the terminal's pad table draws (apps/terminal/src/screens/market/pads.ts);
//   - the launch, re-read here: for up to SAMPLE tagged rows (one per pad first) and SAMPLE untagged settled rows,
//     Jupiter's own word on the token (its keyless search, for the config a DBC pool or a LaunchLab platform names) and
//     the launch read on a public RPC (origin.ts readOrigins, the helper's one function, on this check's own reads)
//     name the same pad as the row, or none for an untagged row. A row the read does not settle is said, not failed; a
//     sample with tagged rows and none of them re-read is a FAIL.
// The Base and Robinhood tags are judged by market-data-evm the same way.
// After: helper
//   node scripts/live-checks/helper-launchpad-origin.mjs [--base <url>] [--rpc <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read (the lists cut to each row's token,
//   symbol, launchpad and curve; Jupiter's answer; every account read).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { PADS } from "../../apps/terminal/src/screens/market/pads.ts";
import { hintsOf, readOrigins } from "../../apps/helper/src/data/solana/origin.ts";

const KEY = "helper-launchpad-origin";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const RPC = "https://api.mainnet-beta.solana.com";
export const JUP = "https://lite-api.jup.ag/tokens/v2/search?query=";
export const PATH = "/v1/market/lists?chain=solana";
export const LISTS = ["new", "trending", "trending_5m", "trending_1h", "graduating"];
export const SAMPLE = 8;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** Up to SAMPLE tagged rows, one per pad first, and SAMPLE untagged rows whose launch the helper has read. */
export function sample(lists, unsettled = []) {
  const seen = new Set();
  const all = LISTS.flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : [])).filter((r) => r && B58.test(r.token) && !seen.has(r.token) && seen.add(r.token));
  const open = new Set(Array.isArray(unsettled) ? unsettled : []);
  const tagged = all.filter((r) => typeof r.launchpad === "string");
  const pads = new Set();
  const first = tagged.filter((r) => !pads.has(r.launchpad) && pads.add(r.launchpad));
  const pick = [...first, ...tagged.filter((r) => !first.includes(r))].slice(0, SAMPLE);
  return [...pick, ...all.filter((r) => r.launchpad === null && !open.has(r.token)).slice(0, SAMPLE)];
}

/** The check of one read: the helper's answer and the launches re-read for its sample (a Map, absent: not settled). */
export function judge(r, origins) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(r.status === 200, `GET ${PATH} answers ${r.status}`);
  let s;
  try {
    s = JSON.parse(r.body);
  } catch {
    s = undefined;
  }
  const lists = s && typeof s === "object" && s.lists && typeof s.lists === "object" ? s.lists : {};
  say(JSON.stringify(Object.keys(lists)) === JSON.stringify(LISTS), `lists: ${show(Object.keys(lists))}`);
  const rows = LISTS.flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : [])).filter((x) => x && typeof x.token === "string");
  const listed = new Map(rows.map((x) => [x.token, x]));
  say(listed.size > 0, `rows: ${listed.size} tokens listed`);
  const drawn = rows.filter((x) => x.launchpad !== null && !Object.hasOwn(PADS, x.launchpad));
  say(drawn.length === 0, `every tag is one the app's pad table draws${drawn.length ? `: ${drawn.length} not, first ${show(drawn[0].symbol)} ${show(drawn[0].launchpad)}` : ""}`);
  const open = s?.unsettled;
  const openOk = Array.isArray(open) && open.every((t) => typeof t === "string" && listed.has(t) && listed.get(t).launchpad === null) && new Set(open).size === open.length;
  say(openOk && open.length * 2 <= listed.size, `unsettled: ${Array.isArray(open) ? `${open.length} of ${listed.size} listed tokens, each listed and untagged, at most half` : show(open)}`);
  let tagged = 0;
  let taggedRead = 0;
  for (const row of sample(lists, openOk ? open : [])) {
    const o = origins.get(row.token);
    if (typeof row.launchpad === "string") tagged++;
    if (o === undefined) {
      lines.push(`--  ${row.symbol} ${row.token}: launch not settled by this read (an RPC or Jupiter read failed)`);
      continue;
    }
    if (typeof row.launchpad === "string") taggedRead++;
    say((o?.pad ?? null) === row.launchpad, `${row.symbol} ${row.token}: tagged ${show(row.launchpad)}, the launch read on chain names ${show(o?.pad ?? null)}`);
  }
  say(tagged === 0 || taggedRead > 0, `tagged rows re-read on chain: ${taggedRead} of ${tagged} sampled`);
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${PATH}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  return { base, readAt, status: r.status, body: await r.text() };
}

/** The launches of the sampled rows, re-read here: Jupiter's search for its word, then the accounts on `rpc`. `log`
 *  gets Jupiter's answer and every account read. */
export async function reread(rows, fetchFn = fetch, rpc = RPC, log = { jupiter: null, accounts: {} }) {
  if (rows.length === 0) return new Map();
  let hints = new Map();
  try {
    const j = await fetchFn(`${JUP}${rows.map((r) => r.token).join(",")}`, { headers: { accept: "application/json" } });
    const body = await j.json();
    log.jupiter = Array.isArray(body) ? body.map((x) => ({ id: x?.id, launchpad: x?.launchpad, partnerConfig: x?.partnerConfig, graduatedPool: x?.graduatedPool })) : body;
    hints = hintsOf(log.jupiter);
  } catch {
    return new Map();
  }
  const get = async (keys) => {
    const out = [];
    for (let i = 0; i < keys.length; i += 100) {
      const part = keys.slice(i, i + 100);
      try {
        const r = await fetchFn(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [part, { encoding: "base64", commitment: "confirmed" }] }) });
        const v = (await r.json())?.result?.value;
        if (!Array.isArray(v) || v.length !== part.length) return undefined;
        part.forEach((k, n) => (log.accounts[k] = v[n]));
        out.push(...v);
      } catch {
        return undefined;
      }
    }
    return out;
  };
  return readOrigins(get, rows.map((r) => ({ mint: r.token, hint: hints.get(r.token) })));
}

/** The lists cut to what the judge reads, so a record stays small. */
export function cut(body) {
  try {
    const s = JSON.parse(body);
    for (const k of LISTS) if (Array.isArray(s.lists?.[k])) s.lists[k] = s.lists[k].map((r) => ({ token: r?.token, symbol: r?.symbol, launchpad: r?.launchpad, curve_bps: r?.curve_bps }));
    return JSON.stringify(s);
  } catch {
    return body;
  }
}

export async function check(base = BASE, fetchFn = fetch, rpc = RPC) {
  const answer = await read(base, fetchFn);
  let s = {};
  try {
    s = JSON.parse(answer.body) ?? {};
  } catch {
    s = {};
  }
  const log = { jupiter: null, accounts: {} };
  const origins = await reread(sample(s.lists ?? {}, s.unsettled), fetchFn, rpc, log);
  return { answer: { ...answer, body: cut(answer.body) }, log, ...judge(answer, origins) };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const r = await check(base, fetch, opt("--rpc", RPC));
    for (const l of r.lines) console.log(l);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ answer: r.answer, jupiter: r.log.jupiter, accounts: r.log.accounts })}\n`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"} (${base})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
