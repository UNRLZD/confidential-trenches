#!/usr/bin/env node
// Live check of card solana-buy-reaches-raydium-and-meteora: the deployed helper carries the signing page's pool scans,
// so a coin whose SOL pools are Meteora DLMM pairs, Raydium CPMM pools or Raydium AMM v4 pools has its pools found.
// POST /v1/rpc/solana with each kit scan for one coin and wSOL, the coin on either side as the page sends it, must answer
// 200 with lists of addresses that together hold that coin's SOL pools read on two mainnet RPCs (14-15 Nov):
//   - DLMM, solanaDlmmPairScan: NEARKAT (6UtY9iTZ…), its pairs B8BH6ZKr… and J3wZVx37…;
//   - CPMM, solanaCpmmPoolScan: HIGH (7ymF66Z6…), its pool CqvMZmWD… (wSOL its token 0);
//   - AMM v4, solanaAmmV4PoolScan: CzLSuj… (a pump.fun coin graduated to AMM v4), its pool 9Tb2ohu5… (wSOL its coin side).
// Each scan with one mint alone (a sweep of every pool of the coin) must be refused by the helper (method_not_allowed),
// before any call. A helper that refuses a scan, or whose upstream answers it with an error (the page then finds no pool
// and the coin stays unbought), fails. Every answer is read through provider-answer.mjs's rpcAnswer: a helper that
// answers nothing usable (a 429, a 5xx with no JSON-RPC answer, no answer in the window) is a no-answer, read again
// once, and makes the run INCONCLUSIVE, never a PASS.
// Its recorded runs are solana-buy-reaches-raydium-and-meteora.answers.json, replayed by its .test.mjs.
// After: helper
//   node scripts/live-checks/solana-buy-reaches-raydium-and-meteora.mjs [--base <helper url>] [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. Reads only: no key, no transaction.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { SOLANA_SOL_MINT, solanaAmmV4PoolScan, solanaCpmmPoolScan, solanaDlmmPairScan } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer } from "./provider-answer.mjs";

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

/** A scan of every pool of a program reads for seconds: the window one read of the helper gets. */
const READ_MS = 20_000;

/** Per venue, three reads ({ method, params }): the kit's scan with the coin first and with wSOL first, and the first with
 *  the wSOL filter dropped (one mint alone). */
export function requests() {
  const out = {};
  for (const [k, v] of Object.entries(VENUES)) {
    const scan = v.scan(v.mint, SOLANA_SOL_MINT);
    const [program, cfg] = scan;
    const wide = [program, { ...cfg, filters: cfg.filters.slice(0, 2) }];
    const q = (params) => ({ method: "getProgramAccounts", params });
    out[k] = { scan: q(scan), flip: q(v.scan(SOLANA_SOL_MINT, v.mint)), wide: q(wide) };
  }
  return out;
}

const isAnswer = (a) => a !== null && typeof a === "object" && ("result" in a || "error" in a || typeof a.noAnswer === "string");
const said = (e) => JSON.stringify(e).slice(0, 120);

/** The verdict on one run's answers ({ [venue]: { scan, flip, wide } }, each as rpcAnswer gives it: { result }, { error }
 *  or { noAnswer }): { verdict: PASS | FAIL | ERROR | INCONCLUSIVE, lines }. A FAIL anywhere is the verdict; else a
 *  no-answer anywhere makes it INCONCLUSIVE. */
export function judge(run) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok  " : "FAIL"} ${s}`);
  const none = [];
  for (const [k, v] of Object.entries(VENUES)) {
    const w = run?.[k]?.wide;
    const both = [run?.[k]?.scan, run?.[k]?.flip];
    if (!isAnswer(w) || both.some((s) => !isAnswer(s))) return { verdict: "ERROR", lines: [`no answer recorded to one of the ${v.name} requests`] };
    const all = [];
    let read = true;
    for (const [s, order] of [[both[0], "the coin first"], [both[1], "wSOL first"]]) {
      if (s.noAnswer !== undefined) {
        none.push(`the kit's ${v.name} scan for ${v.coin}, ${order}: ${s.noAnswer}`);
        read = false;
        continue;
      }
      const value = s.result?.value;
      const keys = Array.isArray(value) ? value.map((e) => e?.pubkey) : null;
      say(keys !== null, `the kit's ${v.name} scan for ${v.coin}, ${order}, answers a list${s.error !== undefined ? ` (error ${said(s.error)})` : keys === null ? " (a result with no list)" : ""}`);
      if (keys === null) continue;
      say(keys.every((x) => typeof x === "string" && B58.test(x)), `every ${v.name} entry, ${order}, is an address (${keys.length} entries)`);
      all.push(...keys);
    }
    if (read) for (const p of v.pools) say(all.includes(p), `it names ${v.coin}'s SOL pool ${p}`);
    if (w.noAnswer !== undefined) none.push(`the ${v.name} scan with one mint alone: ${w.noAnswer}`);
    else say(w.error?.code === "method_not_allowed", `the ${v.name} scan with one mint alone is refused by the helper, method_not_allowed (${w.error !== undefined ? `error ${said(w.error)}` : "it answered a result"})`);
  }
  for (const n of none) lines.push(`NO   ${n}`);
  const verdict = lines.some((l) => l.startsWith("FAIL")) ? "FAIL" : none.length ? "INCONCLUSIVE" : "PASS";
  return { verdict, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const base = (opt("--base") ?? BASE).replace(/\/$/, "");
  const q = requests();
  let run;
  try {
    run = { base, at: new Date().toISOString() };
    const read = (r) => rpcAnswer(`${base}/v1/rpc/solana`, r.method, r.params, { timeoutMs: READ_MS });
    for (const [k, r] of Object.entries(q)) run[k] = { scan: await read(r.scan), flip: await read(r.flip), wide: await read(r.wide) };
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(EXIT.ERROR);
  }
  if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 2) + "\n");
  const r = judge(run);
  for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
  console.log(`live-check ${KEY}: ${r.verdict}`);
  process.exit(EXIT[r.verdict]);
}
