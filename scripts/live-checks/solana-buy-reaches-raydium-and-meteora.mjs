#!/usr/bin/env node
// Live check of card solana-buy-reaches-raydium-and-meteora: the deployed helper carries the signing page's pool scans,
// so a coin whose SOL pools are Meteora DLMM pairs, Raydium CPMM pools or Raydium AMM v4 pools has its pools found.
// POST /v1/rpc/solana with each kit scan for one coin and wSOL, the coin on either side as the page sends it, must answer
// 200 with lists of addresses that together hold that coin's SOL pools read on two mainnet RPCs (14-15 Nov):
//   - DLMM, solanaDlmmPairScan: NEARKAT (6UtY9iTZ…), its pairs B8BH6ZKr… and J3wZVx37…;
//   - CPMM, solanaCpmmPoolScan: HIGH (7ymF66Z6…), its pool CqvMZmWD… (wSOL its token 0);
//   - AMM v4, solanaAmmV4PoolScan: CzLSuj… (a pump.fun coin graduated to AMM v4), its pool 9Tb2ohu5… (wSOL its coin side).
// Each scan with one mint alone (a sweep of every pool of the coin) must be refused 400, before any call. A helper that
// refuses a scan, or whose upstream cannot answer it (the page then finds no pool and the coin stays unbought), fails.
// Its recorded runs are solana-buy-reaches-raydium-and-meteora.answers.json, replayed by its .test.mjs.
// After: helper
//   node scripts/live-checks/solana-buy-reaches-raydium-and-meteora.mjs [--base <helper url>] [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2 (no answer). Reads only: no key, no transaction.
import { writeFileSync } from "node:fs";
import { SOLANA_SOL_MINT, solanaAmmV4PoolScan, solanaCpmmPoolScan, solanaDlmmPairScan } from "../../packages/kit/src/index.ts";

const KEY = "solana-buy-reaches-raydium-and-meteora";
export const NEARKAT = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
export const NEARKAT_PAIRS = ["B8BH6ZKr64agqNWG51CQWUKrLZZw5L31u2K6hubsZfyf", "J3wZVx37wfEpGNjBHiJyuGZf948jsFe3toCiMkD4D1oz"];
/** Each venue's scan, its coin and the SOL pools the scan must name. */
export const VENUES = Object.freeze({
  dlmm: { name: "DLMM pair", coin: "NEARKAT", mint: NEARKAT, pools: NEARKAT_PAIRS, scan: solanaDlmmPairScan },
  cpmm: { name: "Raydium CPMM pool", coin: "HIGH", mint: "7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh", pools: ["CqvMZmWDvEufa5rzkubidyR4zMDqDPoLjAtsW6wGsPMu"], scan: solanaCpmmPoolScan },
  ammV4: { name: "Raydium AMM v4 pool", coin: "CzLSuj", mint: "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump", pools: ["9Tb2ohu5P16BpBarqd3N27WnkF51Ukfs8Z1GzzLDxVZW"], scan: solanaAmmV4PoolScan },
});
const BASE = "https://ct-api.unrealized.trade";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Per venue, three requests: the kit's scan with the coin first and with wSOL first, and the first with the wSOL filter
 *  dropped (one mint alone). */
export function requests() {
  const out = {};
  let id = 0;
  for (const [k, v] of Object.entries(VENUES)) {
    const scan = v.scan(v.mint, SOLANA_SOL_MINT);
    const [program, cfg] = scan;
    const wide = [program, { ...cfg, filters: cfg.filters.slice(0, 2) }];
    const q = (params) => ({ jsonrpc: "2.0", id: ++id, method: "getProgramAccounts", params });
    out[k] = { scan: q(scan), flip: q(v.scan(SOLANA_SOL_MINT, v.mint)), wide: q(wide) };
  }
  return out;
}

/** The verdict on one run's answers ({ [venue]: { scan, flip, wide } }, each { status, json }): { verdict: PASS | FAIL | ERROR, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok  " : "FAIL"} ${s}`);
  for (const [k, v] of Object.entries(VENUES)) {
    const w = run?.[k]?.wide;
    const both = [run?.[k]?.scan, run?.[k]?.flip];
    if (!w || typeof w.status !== "number" || both.some((s) => !s || typeof s.status !== "number")) return { verdict: "ERROR", lines: [`no answer to one of the ${v.name} requests`] };
    const all = [];
    for (const [s, order] of [[both[0], "the coin first"], [both[1], "wSOL first"]]) {
      const value = s.json?.result?.value;
      const keys = Array.isArray(value) ? value.map((e) => e?.pubkey) : null;
      say(s.status === 200 && keys !== null, `the kit's ${v.name} scan for ${v.coin}, ${order}, answers 200 with a list (status ${s.status}${s.json?.error ? `, error ${JSON.stringify(s.json.error).slice(0, 120)}` : ""})`);
      if (keys === null) continue;
      say(keys.every((x) => typeof x === "string" && B58.test(x)), `every ${v.name} entry, ${order}, is an address (${keys.length} entries)`);
      all.push(...keys);
    }
    for (const p of v.pools) say(all.includes(p), `it names ${v.coin}'s SOL pool ${p}`);
    say(w.status === 400, `the ${v.name} scan with one mint alone is refused 400 (status ${w.status})`);
  }
  return { verdict: lines.every((l) => l.startsWith("ok")) ? "PASS" : "FAIL", lines };
}

async function post(base, body) {
  const r = await fetch(`${base}/v1/rpc/solana`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const base = (opt("--base") ?? BASE).replace(/\/$/, "");
  const q = requests();
  let run;
  try {
    run = { base, at: new Date().toISOString() };
    for (const [k, r] of Object.entries(q)) run[k] = { scan: await post(base, r.scan), flip: await post(base, r.flip), wide: await post(base, r.wide) };
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(2);
  }
  if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 2) + "\n");
  const r = judge(run);
  for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
  console.log(`live-check ${KEY}: ${r.verdict}`);
  process.exit(r.verdict === "PASS" ? 0 : r.verdict === "FAIL" ? 1 : 2);
}
