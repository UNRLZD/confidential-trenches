#!/usr/bin/env node
// Live check of card evm-token-page-off-the-5-call-window: a Base or Robinhood token page, holders included, answers for
// many users at once, its holder count from CoinGecko's keyed on-chain info and never from GeckoTerminal's keyless window
// (5 calls in 75 s for the whole helper, the charts'; apps/helper/src/data/evm/token.ts). For each chain it reads the
// helper's own lists at HELPER_HOST and takes up to PER_CHAIN distinct tokens (trending_1h, then new, then the rest),
// then reads every token's page and holders at once, with Origin APP_HOST:
//   GET /v1/market/token?chain=<chain>&token=<address>
//   GET /v1/market/holders?chain=<chain>&token=<address>
// It passes only when the lists answer 200 with a row, every page and holders read answers 200 (a 429 or a 503 is a
// FAIL), every holders answer's src is "coingecko" or "none" and every page's risk.holders src "coingecko", "goplus" or
// "none" (never "geckoterminal": the keyless window read for the count), and each chain has at least one holders
// answer with a count from "coingecko" (the keyed source serves; a key that serves none, or no key set, is a FAIL).
// The helper's live run starts every helper check at once (about 40), so this check's reads meet theirs.
// After: helper
//   node scripts/live-checks/evm-token-page-off-the-5-call-window.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "evm-token-page-off-the-5-call-window";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const CHAINS = ["base", "robinhood"];
/** Tokens read a chain [design: 5 a chain, 20 reads at once beside the run's other checks: a crowd of pages, well inside
 *  the 120 requests a 10 s one address may make (apps/helper/src/server.ts API_RATE_MAX), so the check never measures
 *  its own throttle; listed tokens, so no read draws DexScreener's per-caller share]. */
export const PER_CHAIN = 5;
export const READS = {
  lists: (c) => `/v1/market/lists?chain=${c}`,
  token: (c, t) => `/v1/market/token?chain=${c}&token=${t}`,
  holders: (c, t) => `/v1/market/holders?chain=${c}&token=${t}`,
};
export const HOLDERS_SRC = ["coingecko", "none"];
export const RISK_SRC = ["coingecko", "goplus", "none"];
const ADDR = /^0x[0-9a-f]{40}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** Up to PER_CHAIN distinct token addresses from one chain's lists answer: trending_1h, then new, then any other list. */
export function picks(snapshot) {
  const lists = snapshot?.lists ?? {};
  const order = ["trending_1h", "new", ...Object.keys(lists).filter((k) => k !== "trending_1h" && k !== "new").sort()];
  const out = [];
  for (const k of order)
    for (const r of Array.isArray(lists[k]) ? lists[k] : [])
      if (typeof r?.token === "string" && ADDR.test(r.token) && !out.includes(r.token) && out.length < PER_CHAIN) out.push(r.token);
  return out;
}

/** The check of one run: { base, readAt, chains: { <chain>: { lists, tokens: { <address>: { token, holders } } } } },
 *  each a read { at, ms, status, headers, body }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const chain of CHAINS) {
    const c = run.chains?.[chain] ?? {};
    const lists = c.lists ?? { status: 0, body: "" };
    const want = lists.status === 200 ? picks(parse(lists.body)) : [];
    say(want.length > 0, `${chain}: GET ${READS.lists(chain)} answers ${lists.status}, ${want.length} tokens to read`);
    let counted = 0;
    for (const t of want) {
      const r = c.tokens?.[t] ?? {};
      const page = r.token ?? { status: 0, body: "" };
      const holders = r.holders ?? { status: 0, body: "" };
      say(page.status === 200, `${chain} ${t}: page ${page.status} in ${show(page.ms)} ms`);
      say(holders.status === 200, `${chain} ${t}: holders ${holders.status} in ${show(holders.ms)} ms`);
      const p = page.status === 200 ? parse(page.body) : undefined;
      if (p !== undefined) say(RISK_SRC.includes(p?.risk?.holders?.src), `${chain} ${t}: page risk.holders src ${show(p?.risk?.holders?.src)}, one of ${RISK_SRC.join(", ")}`);
      const h = holders.status === 200 ? parse(holders.body) : undefined;
      if (h === undefined) continue;
      say(HOLDERS_SRC.includes(h?.src), `${chain} ${t}: holders src ${show(h?.src)}, one of ${HOLDERS_SRC.join(", ")}`);
      if (h?.src === "coingecko" && Number.isSafeInteger(h.total) && h.total >= 0) counted++;
    }
    say(counted > 0, `${chain}: ${counted} of ${want.length} holders answers carry a count from CoinGecko's keyed info`);
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

export async function read(base = BASE, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const chains = {};
  for (const chain of CHAINS) chains[chain] = { lists: await get(base, READS.lists(chain), fetchFn), tokens: {} };
  // every chain's every token, page and holders, at once
  await Promise.all(
    CHAINS.flatMap((chain) => {
      const c = chains[chain];
      const want = c.lists.status === 200 ? picks(parse(c.lists.body)) : [];
      return want.map(async (t) => {
        const [token, holders] = await Promise.all([get(base, READS.token(chain, t), fetchFn), get(base, READS.holders(chain, t), fetchFn)]);
        c.tokens[t] = { token, holders };
      });
    }),
  );
  return { base, readAt, chains };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
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
